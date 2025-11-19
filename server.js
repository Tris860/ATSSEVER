/******************************************************************
 *  TRIS TECH HUB — ATS CONTROL SERVER (Render-ready + Debugging)
 *  Hybrid WebSocket (Wemos) + Socket.IO (Web UI)
 ******************************************************************/

const http = require("http");
const WebSocket = require("ws");
const express = require("express");
const { Server } = require("socket.io");
const { URLSearchParams } = require("url");

/* ---------------------------------------------
   CONFIG
--------------------------------------------- */
const PORT = process.env.PORT || 4000;
const WEMOS_AUTH_URL = process.env.WEMOS_AUTH_URL ||
  "https://tristechhub.org.rw/projects/ATS/backend/main.php?action=wemos_auth";
const USER_DEVICE_LOOKUP_URL = process.env.USER_DEVICE_LOOKUP_URL ||
  "https://tristechhub.org.rw/projects/ATS/backend/main.php?action=get_user_device";
const PHP_BACKEND_URL = process.env.PHP_BACKEND_URL ||
  "https://tristechhub.org.rw/projects/ATS/backend/main.php?action=is_current_time_in_period";

/* ---------------------------------------------
   APP + SERVER
--------------------------------------------- */
const app = express();
const server = http.createServer(app);

/* ---------------------------------------------
   WEBSOCKET SERVERS
--------------------------------------------- */
const wss = new WebSocket.Server({ noServer: true });
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });
const webNS = io.of("/web");

/* ---------------------------------------------
   STATE STORAGE
--------------------------------------------- */
const authenticatedWemos = new Map(); // deviceName → WebSocket
const userWebClients = new Map();     // email → Set(Socket)
const userToWemosCache = new Map();   // email → deviceName

/* ---------------------------------------------
   LOG HELPERS
--------------------------------------------- */
function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}
function safeWrite(socket, data) {
  try { socket.write(data); } catch (e) {}
}

/* ---------------------------------------------
   USER → DEVICE CACHE LOOKUP
--------------------------------------------- */
async function getCachedWemosDeviceNameForUser(email) {
  if (!email) return null;
  if (userToWemosCache.has(email)) return userToWemosCache.get(email);

  const post = new URLSearchParams();
  post.append("action", "get_user_device");
  post.append("email", email);

  try {
    const resp = await fetch(USER_DEVICE_LOOKUP_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: post.toString()
    });

    log(`Lookup POST → status=${resp.status}`);
    const data = await resp.json();
    log(`Lookup response JSON: ${JSON.stringify(data)}`);

    if (data.success && data.device_name) {
      userToWemosCache.set(email, data.device_name);
      return data.device_name;
    }
  } catch (err) {
    log("get_user_device error: " + err.message);
  }
  return null;
}

/* ---------------------------------------------
   RAW WEMOS AUTHENTICATION + UPGRADE
--------------------------------------------- */
async function authenticateAndUpgradeWemos(req, socket, head) {
  log(`Incoming WS upgrade → path=${req.url}, headers=${JSON.stringify(req.headers)}`);

  const username = req.headers["x-username"];
  const password = req.headers["x-password"];
  log(`Authenticating Wemos username=${username}, password=${password}`);

  if (!username || !password) {
    safeWrite(socket, "HTTP/1.1 400 Bad Request\r\n\r\n");
    log("Missing username/password headers");
    socket.destroy();
    return;
  }

  try {
    const post = new URLSearchParams();
    post.append("action", "wemos_auth");
    post.append("username", username);
    post.append("password", password);

    const resp = await fetch(WEMOS_AUTH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: post.toString()
    });

    log(`Auth POST → status=${resp.status}, content-type=${resp.headers.get("content-type")}`);

    const data = await resp.json().catch(err => {
      log("Auth JSON parse error: " + err.message);
      return {};
    });
    log(`Auth response JSON: ${JSON.stringify(data)}`);

    if (!data.success) {
      safeWrite(socket, "HTTP/1.1 401 Unauthorized\r\n\r\n");
      log(`Auth failed for username=${username}`);
      socket.destroy();
      return;
    }

    const deviceName = data.data?.device_name || username;
    const initialCommand = data.data?.hard_switch_enabled ? "HARD_ON" : "HARD_OFF";

    wss.handleUpgrade(req, socket, head, ws => {
      log(`Upgrade successful for device=${deviceName}`);
      ws.isWemos = true;
      ws.wemosName = deviceName;
      ws.isAlive = true;

      const old = authenticatedWemos.get(deviceName);
      if (old && old.readyState === WebSocket.OPEN) {
        log(`Terminating old connection for device=${deviceName}`);
        try { old.terminate(); } catch (e) {}
      }
      authenticatedWemos.set(deviceName, ws);

      try { ws.send(initialCommand); } catch (e) {}

      ws.on("message", msg => {
        log(`Wemos ${deviceName} → ${msg}`);
      });

      ws.on("close", (code, reason) => {
        authenticatedWemos.delete(deviceName);
        log(`Wemos '${deviceName}' disconnected. code=${code}, reason=${reason}`);
      });

      wss.emit("connection", ws, req);
    });

  } catch (err) {
    safeWrite(socket, "HTTP/1.1 500 Internal Server Error\r\n\r\n");
    log("Auth exception: " + err.message);
    socket.destroy();
  }
}

/* ---------------------------------------------
   AUTO_ON ENGINE
--------------------------------------------- */
async function checkPhpBackend() {
  try {
    const resp = await fetch(PHP_BACKEND_URL);
    log(`checkPhpBackend → status=${resp.status}`);
    const data = await resp.json();
    log(`checkPhpBackend JSON: ${JSON.stringify(data)}`);

    if (data.success === true) {
      log("AUTO_ON triggered globally.");
      authenticatedWemos.forEach(ws => {
        if (ws.readyState === WebSocket.OPEN) {
          try { ws.send("AUTO_ON"); } catch (e) {}
        }
      });
    }
  } catch (err) {
    log("checkPhpBackend error: " + err.message);
  }
}

/* ---------------------------------------------
   HTTP UPGRADE
--------------------------------------------- */
server.on("upgrade", (req, socket, head) => {
  const pathname = req.url.split("?")[0];
  log(`HTTP upgrade request → pathname=${pathname}`);
  if (pathname === "/wemos") {
    authenticateAndUpgradeWemos(req, socket, head);
  } else {
    log("Upgrade rejected: invalid path");
    socket.destroy();
  }
});

/* ---------------------------------------------
   WEB CLIENTS (Socket.IO)
--------------------------------------------- */
webNS.on("connection", async socket => {
  const email = socket.handshake.query.user;
  log(`Web client connected: ${email}`);
  if (email) addWebClientForUser(email, socket);

  socket.on("disconnect", () => {
    removeWebClientForUser(email, socket);
    log(`Web client disconnected: ${email}`);
  });
});

/* ---------------------------------------------
   EXPRESS ROUTE
--------------------------------------------- */
app.get("/", (req, res) => {
  res.send("ATS Hybrid WebSocket Server Running on Render");
});

/* ---------------------------------------------
   START SERVER + HEARTBEAT
--------------------------------------------- */
server.listen(PORT, () => {
  log(`Server running on port ${PORT}`);
  checkPhpBackend();
  setInterval(checkPhpBackend, 60000);
});

// Heartbeat to keep Wemos sockets alive
setInterval(() => {
  authenticatedWemos.forEach((ws, deviceName) => {
    if (ws.isAlive === false) {
      log(`Terminating dead Wemos: ${deviceName}`);
      return ws.terminate();
    }
    ws.isAlive = false;
    try { ws.ping(); } catch (e) {}
  });
}, 30000);

wss.on("connection", ws => {
  ws.on("pong", () => { ws.isAlive = true; });
});
