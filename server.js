const path = require('node:path');
const express = require('express');
const http = require('node:http');
const { WebSocket, WebSocketServer } = require('ws');
const { TikTokLiveConnection, WebcastEvent } = require('tiktok-live-connector');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = Number(process.env.PORT || 3000);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let activeConnection = null;
let activeUsername = null;
const recentEventIds = new Map();
const DEDUP_WINDOW_MS = 60_000;

function pruneRecent() {
  const now = Date.now();
  for (const [key, ts] of recentEventIds.entries()) {
    if (now - ts > DEDUP_WINDOW_MS) recentEventIds.delete(key);
  }
}

function buildEventId(type, payload) {
  if (type === 'chat') {
    return `${type}:${payload.messageId || ''}:${payload.userId || ''}:${payload.text || ''}`;
  }
  return `${type}:${payload.messageId || ''}:${payload.userId || ''}:${payload.timestamp || ''}:${payload.text || ''}`;
}

function broadcast(data) {
  const json = JSON.stringify(data);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(json);
  }
}

function handleEvent(type, payload) {
  pruneRecent();
  const id = buildEventId(type, payload);
  if (recentEventIds.has(id)) return;
  recentEventIds.set(id, Date.now());
  broadcast({ type: 'event', eventType: type, payload });
}

function bindConnectionEvents(connection) {
  connection.on(WebcastEvent.CHAT, (data) => {
    handleEvent('chat', {
      timestamp: Date.now(),
      userId: data?.user?.userId,
      username: data?.user?.uniqueId || 'unknown',
      text: data?.comment || '',
      messageId: data?.commentId || data?.msgId || `${data?.user?.userId || ''}:${data?.comment || ''}:${data?.createTime || ''}`,
      raw: { createTime: data?.createTime }
    });
  });

  connection.on(WebcastEvent.GIFT, (data) => {
    handleEvent('gift', {
      timestamp: Date.now(),
      userId: data?.user?.userId,
      username: data?.user?.uniqueId || 'unknown',
      giftId: data?.giftId,
      giftName: data?.giftName || data?.extendedGiftInfo?.name || `Gift #${data?.giftId || 'Unknown'}`,
      repeatCount: data?.repeatCount || 1,
      messageId: data?.msgId || `${data?.user?.userId || ''}:${data?.giftId || ''}:${data?.repeatCount || ''}:${data?.createTime || ''}`
    });
  });

  connection.on(WebcastEvent.LIKE, (data) => {
    handleEvent('like', {
      timestamp: Date.now(),
      userId: data?.user?.userId,
      username: data?.user?.uniqueId || 'unknown',
      likeCount: data?.likeCount || data?.count || 1,
      totalLikeCount: data?.totalLikeCount || 0,
      messageId: data?.msgId || `${data?.user?.userId || ''}:${data?.likeCount || ''}:${data?.createTime || ''}`
    });
  });

  connection.on(WebcastEvent.FOLLOW, (data) => {
    handleEvent('follow', {
      timestamp: Date.now(),
      userId: data?.user?.userId,
      username: data?.user?.uniqueId || 'unknown',
      messageId: data?.msgId || `${data?.user?.userId || ''}:follow:${data?.createTime || ''}`
    });
  });

  connection.on(WebcastEvent.LINK_MIC_BATTLE, (data) => {
    handleEvent('battle', {
      timestamp: Date.now(),
      userId: data?.user?.userId,
      username: data?.user?.uniqueId || 'unknown',
      battleUsers: data?.battleUsers?.length || 0,
      battleStatus: data?.battleStatus || 'active',
      messageId: data?.msgId || `battle:${data?.createTime || Date.now()}`
    });
  });

  connection.on('streamEnd', () => {
    broadcast({ type: 'status', status: 'ended', username: activeUsername });
  });

  connection.on('disconnected', () => {
    broadcast({ type: 'status', status: 'disconnected', username: activeUsername });
  });

  connection.on('error', (err) => {
    broadcast({ type: 'error', message: err?.message || 'Connection error' });
  });
}

async function connectToLive(username) {
  if (activeConnection && activeUsername === username) return;

  if (activeConnection) {
    try {
      await activeConnection.disconnect();
    } catch (_) {
      // no-op
    }
  }

  const connection = new TikTokLiveConnection(username, {
    processInitialData: false,
    enableExtendedGiftInfo: true
  });

  bindConnectionEvents(connection);

  const state = await connection.connect();
  activeConnection = connection;
  activeUsername = username;
  broadcast({
    type: 'status',
    status: 'connected',
    username,
    roomId: state?.roomId
  });
}

app.post('/api/connect', async (req, res) => {
  const username = String(req.body?.username || '').trim().replace(/^@/, '');
  if (!username) return res.status(400).json({ error: 'username is required' });

  try {
    await connectToLive(username);
    return res.json({ ok: true, username });
  } catch (err) {
    return res.status(500).json({ error: err?.message || 'Failed to connect' });
  }
});

app.post('/api/disconnect', async (_req, res) => {
  if (!activeConnection) return res.json({ ok: true });
  try {
    await activeConnection.disconnect();
  } catch (_) {
    // ignore
  }
  activeConnection = null;
  activeUsername = null;
  broadcast({ type: 'status', status: 'disconnected' });
  return res.json({ ok: true });
});

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'status', status: 'ready', username: activeUsername }));
});

server.listen(PORT, () => {
  console.log(`Sloify server running on http://localhost:${PORT}`);
});
