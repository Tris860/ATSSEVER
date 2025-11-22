const http = require('http');
const url = require('url');
const WebSocket = require('ws');
const fetch = require('node-fetch');

const PORT = process.env.PORT || 4000;

// PHP backend endpoint
const PHP_BACKEND_URL = 'https://tristechhub.org.rw/projects/ATS/backend/main.php?action=is_current_time_in_period';
const USER_DEVICE_LOOKUP_URL = 'https://tristechhub.org.rw/projects/ATS/backend/main.php?action=get_user_device';

// WebSocket server
const wss = new WebSocket.Server({ noServer: true });

// Maps
const userWebClients = new Map();     // userEmail -> Set(WebSocket)
const userToWemosCache = new Map();   // userEmail -> deviceName

// Normalize headers
function headerFirst(request, name) {
  const v = request.headers[name.toLowerCase()];
  if (!v) return null;
  if (Array.isArray(v)) return (v[0] || '').trim();
  return String(v).split(',')[0].trim();
}

// Cached device lookup
async function getCachedWemosDeviceNameForUser(userEmail) {
  if (!userEmail) return null;
  if (userToWemosCache.has(userEmail)) return userToWemosCache.get(userEmail);

  const postData = new URLSearchParams();
  postData.append('action', 'get_user_device');
  postData.append('email', userEmail);

  try {
    const resp = await fetch(USER_DEVICE_LOOKUP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: postData.toString()
    });
    const raw = await resp.text();
    console.log("RAW PHP RESPONSE (device lookup):", raw);
    let data;
    try { data = JSON.parse(raw); } catch (e) { return null; }
    if (data.success && data.device_name) {
      userToWemosCache.set(userEmail, data.device_name);
      return data.device_name;
    }
    return null;
  } catch (err) {
    console.error('getCachedWemosDeviceNameForUser error:', err.message);
    return null;
  }
}

// Web client management
function addWebClientForUser(email, ws) {
  if (!email) return;
  let set = userWebClients.get(email);
  if (!set) { set = new Set(); userWebClients.set(email, set); }
  set.add(ws);
}
function removeWebClientForUser(email, ws) {
  if (!email) return;
  const set = userWebClients.get(email);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) userWebClients.delete(email);
}

// HTTP server
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('WebSocket server running\n');
});

// Upgrade handler for web clients
server.on('upgrade', (request, socket, head) => {
  const parsed = url.parse(request.url, true);
  const webUserQuery = parsed.query.user || null;

  wss.handleUpgrade(request, socket, head, (ws) => {
    ws.webUsername = webUserQuery;
    ws.isAlive = true;
    console.log(`Webpage client connected. user=${ws.webUsername}`);
  });
});

// WebSocket connection handler
wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  const userEmail = ws.webUsername;
  if (userEmail) addWebClientForUser(userEmail, ws);

  ws.on('message', async (msg) => {
    const text = msg.toString();
    ws.isAlive = true;

    if (!userEmail) {
      try { ws.send('MESSAGE_FAILED:NoUserIdentity'); } catch (e) {}
      return;
    }

    let deviceName = userToWemosCache.get(userEmail);
    if (!deviceName) {
      deviceName = await getCachedWemosDeviceNameForUser(userEmail);
    }
    if (!deviceName) {
      try { ws.send('MESSAGE_FAILED:NoDeviceAssigned'); } catch (e) {}
      return;
    }

    // No Wemos forwarding — just acknowledge
    try { ws.send('MESSAGE_RECEIVED'); } catch (e) {}
  });

  ws.on('close', () => {
    if (userEmail) {
      removeWebClientForUser(userEmail, ws);
      console.log(`Webpage client disconnected. user=${userEmail}`);
    }
  });

  ws.on('error', (err) => console.error('Web client error:', err.message));
});

// Heartbeat
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      const id = ws.webUsername || 'unknown';
      console.log(`Terminating dead socket for '${id}'`);
      try { ws.terminate(); } catch (e) {}
      return;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch (e) {}
  });
}, 30000);

// PHP backend check
async function checkPhpBackend() {
  try {
    const resp = await fetch(PHP_BACKEND_URL);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const raw = await resp.text();
    let data;
    try { data = JSON.parse(raw); } catch (e) {
      console.error("Failed to parse backend response:", raw);
      return;
    }

    if (data.success === true) {
      const messageToWeb = 'TIME_MATCHED: ' + data.message + ": " + data.id;

      userWebClients.forEach((set) => {
        set.forEach(client => {
          if (client.readyState === WebSocket.OPEN) {
            try { client.send(messageToWeb); } catch (e) {}
          }
        });
      });
    } else {
      console.log("PHP backend response indicates failure:", data);
    }
  } catch (err) {
    console.error('checkPhpBackend error:', err.message);
  }
}

// Start server
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on port ${PORT}.`);
  checkPhpBackend();
  setInterval(checkPhpBackend, 60000);
});
