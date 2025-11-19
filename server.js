/******************************************************************
 * ATS CONTROL SERVER — Pure WebSocket + Express
 * Devices (ESP/Wemos) and browsers connect via raw WebSocket
 * Supports reconnection protocol with "TRY_AGAIN" signal
 * Webpage clients mapped to Wemos devices via email
 * Web clients notified of device connection status + AUTO_ON events
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
const USER_DEVICE_LOOKUP_URL =
  "https://tristechhub.org.rw/projects/ATS/backend/main.php?action=get_user_device";

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
const userWebClients = new Map();       // email → Set of WebSocket
const userToWemosCache = new Map();     // email → deviceName

/* ---------------------------------------------
   LOG HELPERS
--------------------------------------------- */
function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

/* ---------------------------------------------
   AUTHENTICATION FOR WEMOS DEVICES
--------------------------------------------- */
async function authenticateClient(headers) {
  const usernameRaw = headers["x-username"];
  const passwordRaw = headers["x-password"];

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
   USER → WEMOS DEVICE LOOKUP
--------------------------------------------- */
async function getCachedWemosDeviceNameForUser(userEmail) {
  if (!userEmail) return null;
  if (userToWemosCache.has(userEmail)) return userToWemosCache.get(userEmail);

  const postData = new URLSearchParams();
  postData.append("action", "get_user_device");
  postData.append("email", userEmail);

  try {
    const resp = await fetch(USER_DEVICE_LOOKUP_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: postData.toString()
    });

    if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
    const ct = resp.headers.get("content-type") || "";
    if (!ct.includes("application/json")) throw new Error("Expected application/json");

    const data = await resp.json();
    if (data.success === true && data.device_name) {
      userToWemosCache.set(userEmail, data.device_name);
      return data.device_name;
    } else {
      return null;
    }
  } catch (err) {
    console.error("getCachedWemosDeviceNameForUser error:", err.message);
    return null;
  }
}

function addWebClientForUser(email, ws) {
  if (!email) return;
  let set = userWebClients.get(email);
  if (!set) {
    set = new Set();
    userWebClients.set(email, set);
  }
  set.add(ws);
}

/* ---------------------------------------------
   Notify web clients about device status
--------------------------------------------- */
function notifyWebClientsOfDeviceStatus(deviceName, status) {
  // Find all emails mapped to this device
  for (const [email, mappedDevice] of userToWemosCache.entries()) {
    if (mappedDevice === deviceName) {
      const clients = userWebClients.get(email);
      if (clients) {
        clients.forEach(ws => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              type: "device_status",
              device: deviceName,
              status: status // "connected" or "disconnected"
            }));
          }
        });
      }
    }
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
      // Notify all Wemos devices
      authenticatedClients.forEach(ws => {
        if (ws.readyState === WebSocket.OPEN) {
          try { ws.send("AUTO_ON"); } catch (e) {}
        }
      });
      // Notify all web clients
      userWebClients.forEach(set => {
        set.forEach(ws => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              type: "auto_trigger",
              message: "AUTO_ON triggered globally"
            }));
          }
        });
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

  if (req.url === "/wemos") {
    // Handle Wemos device
    const auth = await authenticateClient(req.headers);
    if (!auth) {
      log("Client rejected due to failed authentication");
      ws.close(1008, "Unauthorized");
      return;
    }

    const { deviceName, initialCommand } = auth;
    log(`Upgrade successful for device=${deviceName}`);

    const old = authenticatedClients.get(deviceName);
    if (old && old.readyState === WebSocket.OPEN) {
      log(`Terminating old connection for device=${deviceName}`);
      try { old.terminate(); } catch (e) {}
    }
    authenticatedClients.set(deviceName, ws);

    try { ws.send(initialCommand); } catch (e) {}

    ws.isAlive = true;
    notifyWebClientsOfDeviceStatus(deviceName, "connected");

    ws.on("message", msg => {
      log(`Device ${deviceName} → ${msg}`);
    });

    ws.on("close", (code, reason) => {
      authenticatedClients.delete(deviceName);
      log(`Device '${deviceName}' disconnected. code=${code}, reason=${reason}`);
      try { ws.send("TRY_AGAIN"); } catch (e) {}
      notifyWebClientsOfDeviceStatus(deviceName, "disconnected");
    });

    ws.on("pong", () => { ws.isAlive = true; });
    ws.on("ping", () => { log(`Received ping from ${deviceName}`); });
  } else if (req.url === "/webclient") {
    // Handle webpage client
    ws.on("message", async msg => {
      try {
        const parsed = JSON.parse(msg);
        if (parsed.type === "register" && parsed.email) {
          addWebClientForUser(parsed.email, ws);
          log(`Web client registered for email=${parsed.email}`);
        } else if (parsed.type === "command" && parsed.email && parsed.command) {
          const deviceName = await getCachedWemosDeviceNameForUser(parsed.email);
          if (deviceName && authenticatedClients.has(deviceName)) {
            const deviceWs = authenticatedClients.get(deviceName);
            if (deviceWs.readyState === WebSocket.OPEN) {
              deviceWs.send(parsed.command);
              log(`Forwarded command '${parsed.command}' from ${parsed.email} → device=${deviceName}`);
            }
          } else {
            log(`No active device found for email=${parsed.email}`);
          }
        }
      } catch (err) {
                log("Web client message parse error: " + err.message);
      }
    });

    ws.on("close", () => {
      log("Web client disconnected");
      // Remove from userWebClients sets
      for (const [email, set] of userWebClients.entries()) {
        if (set.has(ws)) {
          set.delete(ws);
          if (set.size === 0) {
            userWebClients.delete(email);
          }
        }
      }
    });
  }
});

/* ---------------------------------------------
   EXPRESS ROUTE
--------------------------------------------- */
app.get("/", (req, res) => {
  res.send("ATS Pure WebSocket Server Running on Render (with TRY_AGAIN reconnection + web client mapping + notifications)");
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
      notifyWebClientsOfDeviceStatus(deviceName, "disconnected");
      return ws.terminate();
    }
    ws.isAlive = false;
    try { ws.ping(); } catch (e) {}
  });
}, 30000);
