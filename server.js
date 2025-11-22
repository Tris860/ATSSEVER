const express = require('express');
const expressWs = require('express-ws')(express());
//const fetch = require('node-fetch'); // make sure to install this
const app = expressWs.app;

const PORT = process.env.PORT || 3000;  // Render sets PORT automatically
const PHP_BACKEND_URL = process.env.PHP_BACKEND_URL || 'https://tristechhub.org.rw/projects/ATS/backend/main.php?action=is_current_time_in_period';

// Track connected clients
const authenticatedWemos = new Map(); // deviceName -> ws
const userWebClients = new Map();      // username -> Set of ws

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

    // Example: classify client type
    if (message.startsWith('WEMOS:')) {
      const deviceName = message.split(':')[1] || 'unknown';
      authenticatedWemos.set(deviceName, ws);
      console.log(`Registered Wemos device: ${deviceName}`);
    } else if (message.startsWith('USER:')) {
      const username = message.split(':')[1] || 'guest';
      if (!userWebClients.has(username)) {
        userWebClients.set(username, new Set());
      }
      userWebClients.get(username).add(ws);
      console.log(`Registered user client: ${username}`);
    }
  });

  ws.on('close', () => {
    console.log('Client disconnected');
    // Clean up from maps
    authenticatedWemos.forEach((client, name) => {
      if (client === ws) authenticatedWemos.delete(name);
    });
    userWebClients.forEach((set, username) => {
      if (set.has(ws)) set.delete(ws);
    });
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

// Polling function
async function checkPhpBackend() {
  try {
    const resp = await fetch(PHP_BACKEND_URL);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const raw = await resp.text();
    let data;
    try { data = JSON.parse(raw); } catch (e) { return; }

    if (data.success === true) {
      const messageToWemos = 'AUTO_ON';
      const messageToWeb = 'TIME_MATCHED: ' + data.message + ": " + data.id;

      // Notify Wemos devices
      authenticatedWemos.forEach((client, deviceName) => {
        if (client.readyState === client.OPEN) {
          try {
            client.send(messageToWemos);
            console.log(`Sent ${messageToWemos} to ${deviceName}`);
          } catch (e) {}
        }
      });

      // Notify browser clients
      userWebClients.forEach((set) => {
        set.forEach(client => {
          if (client.readyState === client.OPEN) {
            try { client.send(messageToWeb); } catch (e) {}
          }
        });
      });
    }
    else{
      console.log('PHP backend response indicates failure:', data);
      console.log(`[${new Date().toISOString()}] PHP backend response:`, data);

    }
  } catch (err) {
    console.error('checkPhpBackend error:', err.message);
  }
}

// Run polling every 60 seconds
setInterval(checkPhpBackend, 60000);

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
