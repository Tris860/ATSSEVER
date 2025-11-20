const http = require("http");
const WebSocket = require("ws");
const express = require("express");

const PORT = process.env.PORT || 4001; // Render sets PORT automatically
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/wemos" });

wss.on("connection", (ws) => {
  console.log("Device connected. Waiting for a question...");
  ws.send("Server ready — ask me something!");

  ws.on("message", (msg) => {
    console.log("Received:", msg);
    ws.send("Echo: " + msg);
    console.log("Waiting for next question...");
  });

  ws.on("close", () => {
    console.log("Device disconnected.");
  });
});

app.get("/", (req, res) => res.send("Minimal Wemos Server Running — Render ready"));

server.listen(PORT, () => console.log(`Listening on ${PORT}`));
