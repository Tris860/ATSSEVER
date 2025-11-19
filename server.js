/******************************************************************
 *  TRIS TECH HUB — ATS CONTROL SERVER (Render-ready)
 *  Hybrid WebSocket (Wemos) + Socket.IO (Web UI)
 ******************************************************************/

const http = require("http");
const os = require("os");
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
// Raw WebSocket server for Wemos firmware
const wss = new WebSocket.Server({ noServer: true });

// Socket.IO for browsers
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

/* Namespaces */
const webNS = io.of("/web"); // For browsers

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

    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();

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
   WEB CLIENT MANAGEMENT
--------------------------------------------- */
function addWebClientForUser(email, socket) {
  let set = userWebClients.get(email);
  if (!set) {
    set = new Set();
    userWebClients.set(email, set);
  }
  set.add(socket);
}

function removeWebClientForUser(email, socket) {
  const set = userWebClients.get(email);
  if (!set) return;
  set.delete(socket);
  if (set.size === 0) userWebClients.delete(email);
}

function notifyWebClients(email, message) {
  const set = userWebClients.get(email);
  if (!set) return;
  set.forEach(client => {
    if (client.connected) {
      try { client.emit("server_message", message); } catch (e) {}
    }
  });
}

/* ---------------------------------------------
   RAW WEMOS AUTHENTICATION + UPGRADE
--------------------------------------------- */
async function authenticateAndUpgradeWemos(req, socket, head) {
  const username = req.headers["x-username"];
  const password = req.headers["x-password"];

  log(`Authenticating Wemos username=${username}`);

  if (!username || !password) {
    safeWrite(socket, "HTTP/1.1 400 Bad Request\r\n\r\n");
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

    if (!resp.ok) {
      safeWrite(socket, "HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    const data = await resp.json();
    if (!data.success) {
      safeWrite(socket, "HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      log("Auth failed");
      return;
    }

    const deviceName = data.data?.device_name || username;
    const initialCommand = data.data?.hard_switch_enabled ? "HARD_ON" : "HARD_OFF";

    wss.handleUpgrade(req, socket, head, ws => {
      ws.isWemos = true;
      ws.wemosName = deviceName;
      ws.isAlive = true;

      const old = authenticatedWemos.get(deviceName);
      if (old && old.readyState === WebSocket.OPEN) {
        try { old.terminate(); } catch (e) {}
      }
      authenticatedWemos.set(deviceName, ws);

      log(`Wemos '${deviceName}' connected.`);
      try { ws.send(initialCommand); } catch (e) {}

      ws.on("message", msg => {
        log(`Wemos ${deviceName} → ${msg}`);
        userWebClients.forEach((set, email) => {
          const mapped = userToWemosCache.get(email);
          if (mapped === deviceName) {
            set.forEach(client => {
              try { client.emit("wemos_message", String(msg)); } catch (e) {}
            });
          }
        });
      });

      ws.on("close", () => {
        authenticatedWemos.delete(deviceName);
        log(`Wemos '${deviceName}' disconnected.`);
      });

      wss.emit("connection", ws, req);
    });

  } catch (err) {
    safeWrite(socket, "HTTP/1.1 500 Internal Server Error\r\n\r\n");
    socket.destroy();
  }
}

/* ---------------------------------------------
   GLOBAL AUTO_ON ENGINE
--------------------------------------------- */
async function checkPhpBackend() {
  try {
    const resp = await fetch(PHP_BACKEND_URL);
    if (!resp.ok) return;
    const data = await resp.json();

    if (data.success === true) {
      const messageToWemos = "AUTO_ON";
      log("AUTO_ON triggered globally.");
      authenticatedWemos.forEach(ws => {
        if (ws.readyState === WebSocket.OPEN) {
          try { ws.send(messageToWemos); } catch (e) {}
        }
      });
    }
  } catch (err) {
    log("checkPhpBackend error: " + err.message);
  }
}

/* ---------------------------------------------
   HTTP UPGRADE for Wemos RAW WS
--------------------------------------------- */
server.on("upgrade", (req, socket, head) => {
  const pathname = req.url.split("?")[0];
  if (pathname === "/wemos") {
    authenticateAndUpgradeWemos(req, socket, head);
  } else {
    socket.destroy();
  }
});

/* ---------------------------------------------
   WEB CLIENTS (Socket.IO)
--------------------------------------------- */
webNS.on("connection", async socket => {
  const email = socket.handshake.query.user;
  socket.webUser = email;
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
