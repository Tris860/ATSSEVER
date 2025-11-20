const http = require("http");
const WebSocket = require("ws");
const express = require("express");

const PORT = process.env.PORT || 4001;
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/wemos" });

// When a device connects
wss.on("connection", (ws, req) => {
  console.log("Device connected. Waiting for a question...");

  // Send a welcome message so the device knows the server is ready
  ws.send("Server ready — ask me something!");

  ws.on("message", msg => {
    console.log("Received:", msg);
    ws.send("Echo: " + msg); // simple echo back
    console.log("Waiting for next question...");
  });

  ws.on("close", () => {
    console.log("Device disconnected.");
  });
});

app.get("/", (req, res) => res.send("Minimal Wemos Server Running — waiting for questions"));

server.listen(PORT, () => console.log(`Listening on ${PORT} and waiting for questions...`));
