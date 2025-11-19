/******************************************************************
 * ATS CONTROL SERVER — Pure WebSocket + Express
 * Devices (ESP/Wemos) and browsers connect via raw WebSocket
 * Supports reconnection protocol with "TRY_AGAIN" signal
 ******************************************************************/

const http = require("http");
const WebSocket = require("ws");
const express = require("express");
const { URLSearchParams } = require("url");

/* ---------------------------------------------
   CONFIG
--------------------------------------------- */
const PORT = process.env.PORT || 4000;
const WEMOS_AUTH_URL = process.env.WEMOS_AUTH_URL ||
  "https://tristechhub.org.rw/projects/ATS/backend/main.php?action=wemos_auth";
const PHP_BACKEND_URL = process.env.PHP_BACKEND_URL ||
  "https://tristechhub.org.rw/projects/ATS/backend/main.php?action=is_current_time_in_period";

/* ---------------------------------------------
   APP + SERVER
--------------------------------------------- */
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

/* ---------------------------------------------
   STATE STORAGE
--------------------------------------------- */
const authenticatedClients = new Map(); // deviceName → WebSocket

/* ---------------------------------------------
   LOG HELPERS
--------------------------------------------- */
function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

/* ---------------------------------------------
   AUTHENTICATION
--------------------------------------------- */
async function authenticateClient(headers) {
  const usernameRaw = headers["x-username"];
  const passwordRaw = headers["x-password"];

  // Handle comma-separated duplicates
  const username = usernameRaw?.split(",")[0].trim();
  const password = passwordRaw?.split(",")[0].trim();

  log(`Authenticating client username=${username}, password=${password}`);

  if (!username || !password) return null;

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

    const raw = await resp.text();
    log(`Raw auth response: ${raw}`);

    let data = null;
    try {
      data = JSON.parse(raw);
    } catch (err) {
      log("Auth JSON parse error: " + err.message);
      return null;
    }

    if (!data || !data.success) {
      log("Auth failed or missing 'success' flag");
      return null;
    }

    return {
      deviceName: data.data?.device_name || username,
      initialCommand: data.data?.hard_switch_enabled ? "HARD_ON" : "HARD_OFF"
    };
  } catch (err) {
    log("Auth exception: " + err.message);
    return null;
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
      authenticatedClients.forEach(ws => {
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
   WEBSOCKET CONNECTION HANDLER
--------------------------------------------- */
wss.on("connection", async (ws, req) => {
  log(`Incoming WS connection → path=${req.url}, headers=${JSON.stringify(req.headers)}`);

  const auth = await authenticateClient(req.headers);
  if (!auth) {
    log("Client rejected due to failed authentication");
    ws.close(1008, "Unauthorized");
    return;
  }

  const { deviceName, initialCommand } = auth;
  log(`Upgrade successful for device=${deviceName}`);

  // Replace old connection if exists
  const old = authenticatedClients.get(deviceName);
  if (old && old.readyState === WebSocket.OPEN) {
    log(`Terminating old connection for device=${deviceName}`);
    try { old.terminate(); } catch (e) {}
  }
  authenticatedClients.set(deviceName, ws);

  try { ws.send(initialCommand); } catch (e) {}

  ws.isAlive = true;

  ws.on("message", msg => {
    log(`Device ${deviceName} → ${msg}`);
  });

  ws.on("close", (code, reason) => {
    authenticatedClients.delete(deviceName);
    log(`Device '${deviceName}' disconnected. code=${code}, reason=${reason}`);

    // Send TRY_AGAIN signal to prompt reconnection
    try { ws.send("TRY_AGAIN"); } catch (e) {}
  });

  ws.on("pong", () => { ws.isAlive = true; });
  ws.on("ping", () => { log(`Received ping from ${deviceName}`); });
});

/* ---------------------------------------------
   EXPRESS ROUTE
--------------------------------------------- */
app.get("/", (req, res) => {
  res.send("ATS Pure WebSocket Server Running on Render (with TRY_AGAIN reconnection protocol)");
});

/* ---------------------------------------------
   START SERVER + HEARTBEAT
--------------------------------------------- */
server.listen(PORT, () => {
  log(`Server running on port ${PORT}`);
  checkPhpBackend();
  setInterval(checkPhpBackend, 60000);
});

// Heartbeat to keep sockets alive
setInterval(() => {
  authenticatedClients.forEach((ws, deviceName) => {
    if (ws.isAlive === false) {
      log(`Terminating dead client: ${deviceName}`);
      try { ws.send("TRY_AGAIN"); } catch (e) {}
      return ws.terminate();
    }
    ws.isAlive = false;
    try { ws.ping(); } catch (e) {}
  });
}, 30000);
