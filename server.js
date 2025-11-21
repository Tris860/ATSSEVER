import express from "express";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";
import fetch from "node-fetch";

// ------------------------------
// CONFIG
// ------------------------------
const PHP_BACKEND_URL =
  "https://tristechhub.org.rw/projects/ATS/backend/main.php?action=is_current_time_in_period";

const PORT = process.env.PORT || 3000;  // Render requires PORT env var
const HEARTBEAT_INTERVAL = 30000;       // ping every 30s (Render recommended)
const FETCH_INTERVAL = 60000;           // fetch every 1 minute

// ------------------------------
const app = express();
const server = http.createServer(app);

// ------------------------------
// WebSocket Server
// ------------------------------
const wss = new WebSocketServer({ server });

// Track clients
function heartbeat() {
  this.isAlive = true;
}

wss.on("connection", (ws) => {
  console.log("Wemos connected");

  ws.isAlive = true;
  ws.on("pong", heartbeat);

  ws.on("close", () => {
    console.log("Wemos disconnected");
  });

  ws.on("error", (e) => {
    console.log("Socket error:", e.message);
  });
});

// ------------------------------
// HEARTBEAT: Keep alive for Render
// ------------------------------
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) {
      console.log("Terminating dead client");
      return ws.terminate();
    }

    ws.isAlive = false;
    ws.ping();
  });
}, HEARTBEAT_INTERVAL);

// ------------------------------
// BACKEND FETCHING (every 1 minute)
// ------------------------------
async function fetchAndBroadcast() {
  try {
    const res = await fetch(PHP_BACKEND_URL);
    const data = await res.text();

    console.log("Fetched:", data);

    // Send to all connected Wemos clients
    wss.clients.forEach((ws) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    });
  } catch (err) {
    console.error("Error fetching backend:", err.message);
  }
}

// run at startup and every minute
fetchAndBroadcast();
setInterval(fetchAndBroadcast, FETCH_INTERVAL);

// ------------------------------
// Render Graceful Shutdown
// ------------------------------
process.on("SIGTERM", () => {
  console.log("Render is shutting down…");

  wss.clients.forEach((ws) => {
    try {
      ws.close(1001, "Server shutting down");
    } catch {}
  });

  server.close(() => {
    console.log("HTTP server closed.");
    process.exit(0);
  });
});

// ------------------------------
server.listen(PORT, () => {
  console.log(`WebSocket server running on port ${PORT}`);
});
