const http = require("http");
const WebSocket = require("ws");
const express = require("express");

const PORT = process.env.PORT || 4001;
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/wemos" });

wss.on("connection", (ws, req) => {
  console.log("Device connected");

  ws.on("message", msg => {
    console.log("Received:", msg);
    ws.send("Echo: " + msg); // simple echo
  });

  ws.on("close", () => {
    console.log("Device disconnected");
  });
});

app.get("/", (req, res) => res.send("Minimal Wemos Server Running"));

server.listen(PORT, () => console.log(`Listening on ${PORT}`));
