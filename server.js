/******************************************************************
 * WEMOS SERVER — Handles ESP device connections only
 * Authenticates via PHP backend, sends commands, listens for pings
 * Maintains connection with heartbeat + TRY_AGAIN signal
 ******************************************************************/

const http = require("http");
const WebSocket = require("ws");
const express = require("express");
const { URLSearchParams } = require("url");

const PORT = process.env.PORT || 4001;
const WEMOS_AUTH_URL =
  "https://tristechhub.org.rw/projects/ATS/backend/main.php?action=wemos_auth";
const AUTO_TRIGGER_URL =
  "https://tristechhub.org.rw/projects/ATS/backend/main.php?action=is_current_time_in_period";

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/wemos" });

const connectedDevices = new Map(); // deviceName → WebSocket
const heartbeatState = new Map();   // deviceName → missedCount

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// Authenticate device via PHP backend
async function authenticateDevice(headers) {
  const username = headers["x-username"]?.split(",")[0].trim();
  const password = headers["x-password"]?.split(",")[0].trim();
  if (!username || !password) return null;

  const post = new URLSearchParams();
  post.append("action", "wemos_auth"); // ✅ required
  post.append("username", username);
  post.append("password", password);

  try {
    const resp = await fetch(WEMOS_AUTH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: post.toString()
    });

    const raw = await resp.text();
    log(`Auth response: ${raw}`);
    const data = JSON.parse(raw);
    if (!data.success) return null;

    return {
      deviceName: data.data?.device_name || username,
      initialCommand: data.data?.hard_switch_enabled ? "HARD_ON" : "HARD_OFF"
    };
  } catch (err) {
    log("Auth error: " + err.message);
    return null;
  }
}

// Broadcast AUTO_ON to all connected devices
async function checkAutoTrigger() {
  try {
    const resp = await fetch(AUTO_TRIGGER_URL);
    const data = await resp.json();
    if (data.success === true) {
      log("AUTO_ON triggered globally.");
      connectedDevices.forEach(ws => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send("AUTO_ON");
        }
      });
    }
  } catch (err) {
    log("AUTO trigger check failed: " + err.message);
  }
}

// Handle incoming device connection
wss.on("connection", async (ws, req) => {
  const auth = await authenticateDevice(req.headers);
  if (!auth) {
    log("Device rejected: failed auth");
    ws.close(1008, "Unauthorized");
    return;
  }

  const { deviceName, initialCommand } = auth;
  log(`Device connected: ${deviceName}`);

  // Replace old connection
  const old = connectedDevices.get(deviceName);
  if (old && old.readyState === WebSocket.OPEN) {
    old.terminate();
  }
  connectedDevices.set(deviceName, ws);

  ws.send(initialCommand);
  ws.isAlive = true;
  heartbeatState.set(deviceName, 0);

  ws.on("message", msg => {
    log(`Device ${deviceName} → ${msg}`);
  });

  ws.on("pong", () => {
    ws.isAlive = true;
    heartbeatState.set(deviceName, 0);
    log(`Received pong from ${deviceName}`);
  });

  ws.on("close", () => {
    connectedDevices.delete(deviceName);
    heartbeatState.delete(deviceName);
    log(`Device ${deviceName} disconnected.`);
  });
});

// Heartbeat with grace period
setInterval(() => {
  connectedDevices.forEach((ws, deviceName) => {
    if (!ws.isAlive) {
      const missed = heartbeatState.get(deviceName) || 0;
      if (missed >= 2) { // allow 2 misses
        log(`Device ${deviceName} missed 3 heartbeats. Terminating.`);
        ws.terminate();
        connectedDevices.delete(deviceName);
        heartbeatState.delete(deviceName);
      } else {
        log(`Device ${deviceName} missed heartbeat #${missed+1}.`);
        heartbeatState.set(deviceName, missed + 1);
        ws.ping();
      }
    } else {
      ws.isAlive = false;
      ws.ping();
    }
  });
}, 45000); // ping every 45s


// AUTO trigger check every minute
setInterval(checkAutoTrigger, 60000);

app.get("/", (req, res) => {
  res.send("Wemos Server Running — ESP-only WebSocket handler");
});

server.listen(PORT, () => {
  log(`Wemos server listening on port ${PORT}`);
  checkAutoTrigger();
});
