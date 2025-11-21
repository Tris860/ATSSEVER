
import express from "express";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";
import fetch from "node-fetch";

// --------------------
// CONFIG
// --------------------
const PORT = process.env.PORT || 3000;

// Backend URLs
const WEMOS_AUTH_URL =
  "https://tristechhub.org.rw/projects/ATS/backend/main.php"; 
const PHP_BACKEND_URL =
  "https://tristechhub.org.rw/projects/ATS/backend/main.php?action=is_current_time_in_period";

// Heartbeat and fetch intervals
const HEARTBEAT_INTERVAL = 30000; // 30s ping
const FETCH_INTERVAL = 60000;     // 1 min fetch

// Rate limiting
const MAX_CONCURRENT_AUTHS = 5;
let currentAuths = 0;

// --------------------
// EXPRESS + HTTP SERVER
// --------------------
const app = express();
const server = http.createServer(app);

// --------------------
// WEBSOCKET SERVER
// --------------------
const wss = new WebSocketServer({ noServer: true });

// --------------------
// AUTHENTICATE WEMOS
// --------------------
async function authenticateAndUpgradeWemos(request, socket, head, wss) {
  try {
    // ----- Rate-limit check -----
    if (currentAuths >= MAX_CONCURRENT_AUTHS) {
      console.warn("Too many concurrent auths, rejecting connection");
      socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
      socket.destroy();
      return;
    }
    currentAuths++;

    // ----- Extract headers -----
    const urlParams = new URL(request.url, `http://${request.headers.host}`).searchParams;
    const username = urlParams.get("username");
    const password = urlParams.get("password");


    if (!username || !password) {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\nMissing credentials");
      socket.destroy();
      currentAuths--;
      return;
    }

    // ----- Prepare auth payload -----
    const params = new URLSearchParams();
    params.append("action", "wemos_auth");
    params.append("username", username);
    params.append("password", password);

    // ----- Call backend PHP auth -----
    const res = await fetch(WEMOS_AUTH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });

    const rawData = await res.text();
    console.log("Raw PHP response:", rawData);

    let jsonData;
    try {
      jsonData = JSON.parse(rawData);
    } catch (err) {
      console.error("Failed to parse auth JSON:", err.message);
      socket.write("HTTP/1.1 500 Internal Server Error\r\n\r\nInvalid auth response");
      socket.destroy();
      currentAuths--;
      return;
    }

    if (!jsonData.success) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\nAuth failed");
      socket.destroy();
      currentAuths--;
      return;
    }

    // ----- Extract device info -----
    const deviceData = jsonData.data || {};
    const deviceName = deviceData.device_name || "UNKNOWN";
    const hardSwitch = deviceData.hard_switch_enabled || false;
    const initialCommand = hardSwitch ? "HARD_ON" : "HARD_OFF";

    // ----- Upgrade WebSocket -----
    wss.handleUpgrade(request, socket, head, (ws) => {
      ws.isWemos = true;
      ws.wemosName = deviceName;
      ws.isAlive = true;
      ws.initialCommand = initialCommand;

      console.log(`Wemos authenticated: ${deviceName}, initialCommand: ${initialCommand}`);

      wss.emit("connection", ws, request);
    });
  } catch (err) {
    console.error("Auth request failed:", err.message);
    socket.write("HTTP/1.1 500 Internal Server Error\r\n\r\nAuth server error");
    socket.destroy();
  } finally {
    currentAuths--;
  }
}

// --------------------
// HTTP Upgrade Handling
// --------------------
server.on("upgrade", (request, socket, head) => {
  if (request.url === "/wemos") {
    authenticateAndUpgradeWemos(request, socket, head, wss);
  } else {
    socket.destroy();
  }
});

// --------------------
// WebSocket Connection
// --------------------
wss.on("connection", (ws) => {
  console.log("New WebSocket connection:", ws.wemosName || "unknown device");

  // Optionally send initial command
  if (ws.initialCommand) {
    ws.send(ws.initialCommand);
  }

  ws.on("close", () => {
    console.log("Wemos disconnected:", ws.wemosName || "unknown device");
  });

  ws.on("error", (e) => {
    console.error("WS error:", e.message);
  });

  ws.on("pong", () => {
    ws.isAlive = true;
  });
});

// --------------------
// HEARTBEAT
// --------------------
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) {
      console.log("Terminating dead client:", ws.wemosName || "unknown");
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, HEARTBEAT_INTERVAL);

// --------------------
// FETCH BACKEND DATA & BROADCAST
// --------------------
async function fetchAndBroadcast() {
  try {
    const res = await fetch(PHP_BACKEND_URL);
    const data = await res.text();
    console.log("Fetched backend data:", data);

    wss.clients.forEach((ws) => {
      if (ws.readyState === ws.OPEN && ws.isWemos) {
        ws.send(data);
      }
    });
  } catch (err) {
    console.error("Error fetching backend:", err.message);
  }
}

fetchAndBroadcast();
setInterval(fetchAndBroadcast, FETCH_INTERVAL);

// --------------------
// GRACEFUL SHUTDOWN
// --------------------
process.on("SIGTERM", () => {
  console.log("Render shutting down…");

  wss.clients.forEach((ws) => {
    try {
      ws.close(1001, "Server shutting down");
    } catch {}
  });

  server.close(() => {
    console.log("HTTP server closed");
    process.exit(0);
  });
});

// --------------------
// START SERVER
// --------------------
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
