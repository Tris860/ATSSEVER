const express = require('express');
const expressWs = require('express-ws')(express());
const app = expressWs.app;

const PORT = process.env.PORT || 3000;  // Render sets PORT automatically

// HTTP route for health checks (required for Render)
app.get('/', (req, res) => {
  res.send('WebSocket server is running');
});

// WebSocket route
app.ws('/', (ws, req) => {
  console.log('Client connected');

  ws.on('message', (message) => {
    console.log(`Received: ${message}`);
    ws.send(`Echo: ${message}`);  // Echo back
  });

  ws.on('close', () => {
    console.log('Client disconnected');
  });

  // Handle pings for keepalive
  ws.on('pong', () => {
    console.log('Pong received');
  });

  // Send periodic pings to detect dead connections
  const pingInterval = setInterval(() => {
    if (ws.readyState === ws.OPEN) {
      ws.ping();
    }
  }, 30000);  // Every 30 seconds

  ws.on('close', () => clearInterval(pingInterval));
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});