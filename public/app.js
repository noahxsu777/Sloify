const eventFeed = document.getElementById('eventFeed');
const statusText = document.getElementById('statusText');
const queueList = document.getElementById('queueList');

const usernameInput = document.getElementById('username');
const connectBtn = document.getElementById('connectBtn');
const disconnectBtn = document.getElementById('disconnectBtn');

const toggleChat = document.getElementById('toggleChat');
const toggleGift = document.getElementById('toggleGift');
const toggleLike = document.getElementById('toggleLike');
const toggleFollow = document.getElementById('toggleFollow');
const toggleBattle = document.getElementById('toggleBattle');
const readUsername = document.getElementById('readUsername');

const keywordFilter = document.getElementById('keywordFilter');
const giftFilter = document.getElementById('giftFilter');
const topContributorLikes = document.getElementById('topContributorLikes');

const voiceSelect = document.getElementById('voiceSelect');
const speed = document.getElementById('speed');
const volume = document.getElementById('volume');
const speedValue = document.getElementById('speedValue');
const volumeValue = document.getElementById('volumeValue');
const playBtn = document.getElementById('playBtn');
const pauseBtn = document.getElementById('pauseBtn');
const stopBtn = document.getElementById('stopBtn');

const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`);
const MAX_FEED_ITEMS = 300;
const MAX_QUEUE_SIZE = 200;
const MAX_QUEUE_DISPLAY = 25;

const state = {
  queue: [],
  speaking: false,
  paused: false,
  voices: [],
  maxQueueSize: MAX_QUEUE_SIZE,
  userTotalLikes: new Map()
};

function updateRangeLabels() {
  speedValue.textContent = Number(speed.value).toFixed(1);
  volumeValue.textContent = Number(volume.value).toFixed(1);
}

function addFeedItem(type, text) {
  const item = document.createElement('article');
  item.className = 'event-item';
  item.innerHTML = `<div class="event-type">${type}</div><div>${text}</div>`;
  eventFeed.prepend(item);
  while (eventFeed.children.length > MAX_FEED_ITEMS) {
    eventFeed.removeChild(eventFeed.lastChild);
  }
}

function renderQueue() {
  queueList.innerHTML = '';
  state.queue.slice(0, MAX_QUEUE_DISPLAY).forEach((entry) => {
    const li = document.createElement('li');
    li.textContent = `[${entry.eventType}] ${entry.text}`;
    queueList.appendChild(li);
  });
}

function selectedVoice() {
  const idx = Number(voiceSelect.value);
  return Number.isFinite(idx) ? state.voices[idx] : null;
}

function speakNext() {
  if (state.paused || state.speaking || state.queue.length === 0) return;

  const next = state.queue.shift();
  renderQueue();

  const utterance = new SpeechSynthesisUtterance(next.text);
  utterance.rate = Number(speed.value);
  utterance.volume = Number(volume.value);
  const voice = selectedVoice();
  if (voice) utterance.voice = voice;

  state.speaking = true;
  utterance.onend = () => {
    state.speaking = false;
    speakNext();
  };
  utterance.onerror = () => {
    state.speaking = false;
    speakNext();
  };

  speechSynthesis.speak(utterance);
}

function enqueue(entry) {
  if (state.queue.length >= state.maxQueueSize) {
    state.queue.shift();
  }
  state.queue.push(entry);
  renderQueue();
  speakNext();
}

function normalizeList(input) {
  return input
    .split(',')
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
}

function shouldReadEvent(eventType, payload) {
  if (eventType === 'chat' && !toggleChat.checked) return false;
  if (eventType === 'gift' && !toggleGift.checked) return false;
  if (eventType === 'like' && !toggleLike.checked) return false;
  if (eventType === 'follow' && !toggleFollow.checked) return false;
  if (eventType === 'battle' && !toggleBattle.checked) return false;

  const minLikes = Number(topContributorLikes.value) || 0;
  const totalLikes = state.userTotalLikes.get(payload.userId) || 0;
  if (minLikes > 0 && totalLikes < minLikes) return false;

  const keywords = normalizeList(keywordFilter.value);
  if (keywords.length && eventType === 'chat') {
    const text = String(payload.text || '').toLowerCase();
    if (!keywords.some((k) => text.includes(k))) return false;
  }

  const gifts = normalizeList(giftFilter.value);
  if (gifts.length && eventType === 'gift') {
    const giftName = String(payload.giftName || '').toLowerCase();
    if (!gifts.some((g) => giftName.includes(g))) return false;
  }

  return true;
}

function toSpeechText(eventType, payload) {
  const userPrefix = readUsername.checked ? `${payload.username || 'Someone'}: ` : '';
  if (eventType === 'chat') return `${userPrefix}${payload.text || ''}`;
  if (eventType === 'gift') return `${userPrefix}sent ${payload.giftName || 'a gift'} x${payload.repeatCount || 1}`;
  if (eventType === 'like') return `${userPrefix}liked the stream ${payload.likeCount || 1} times`;
  if (eventType === 'follow') return `${userPrefix}followed the streamer`;
  if (eventType === 'battle') return `${userPrefix}battle event: ${payload.battleStatus || 'active'}`;
  return '';
}

function handleIncomingEvent(eventType, payload) {
  if (eventType === 'like') {
    const prev = state.userTotalLikes.get(payload.userId) || 0;
    state.userTotalLikes.set(payload.userId, prev + Number(payload.likeCount || 0));
  }

  let text = '';
  if (eventType === 'chat') text = `${payload.username}: ${payload.text}`;
  if (eventType === 'gift') text = `${payload.username} sent ${payload.giftName} x${payload.repeatCount}`;
  if (eventType === 'like') text = `${payload.username} liked x${payload.likeCount}`;
  if (eventType === 'follow') text = `${payload.username} followed`;
  if (eventType === 'battle') text = `Battle update (${payload.battleStatus})`;

  addFeedItem(eventType, text || JSON.stringify(payload));

  if (!shouldReadEvent(eventType, payload)) return;
  const speech = toSpeechText(eventType, payload);
  if (!speech.trim()) return;
  enqueue({ eventType, text: speech });
}

function loadVoices() {
  state.voices = speechSynthesis.getVoices();
  voiceSelect.innerHTML = '';
  state.voices.forEach((voice, idx) => {
    const opt = document.createElement('option');
    opt.value = String(idx);
    opt.textContent = `${voice.name} (${voice.lang})`;
    voiceSelect.appendChild(opt);
  });
}

async function connect() {
  const username = usernameInput.value.trim().replace(/^@/, '');
  if (!username) return;

  const res = await fetch('/api/connect', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username })
  });
  const data = await res.json();
  if (!res.ok) {
    addFeedItem('error', data.error || 'Failed to connect');
  }
}

async function disconnect() {
  await fetch('/api/disconnect', { method: 'POST' });
}

connectBtn.addEventListener('click', connect);
disconnectBtn.addEventListener('click', disconnect);

playBtn.addEventListener('click', () => {
  state.paused = false;
  if (speechSynthesis.paused) speechSynthesis.resume();
  speakNext();
});

pauseBtn.addEventListener('click', () => {
  state.paused = true;
  if (speechSynthesis.speaking) speechSynthesis.pause();
});

stopBtn.addEventListener('click', () => {
  state.paused = false;
  state.queue = [];
  state.speaking = false;
  speechSynthesis.cancel();
  renderQueue();
});

speed.addEventListener('input', updateRangeLabels);
volume.addEventListener('input', updateRangeLabels);

ws.addEventListener('message', (event) => {
  const data = JSON.parse(event.data);
  if (data.type === 'status') {
    statusText.textContent = `${data.status}${data.username ? ` (@${data.username})` : ''}`;
    addFeedItem('status', statusText.textContent);
    return;
  }
  if (data.type === 'error') {
    addFeedItem('error', data.message);
    return;
  }
  if (data.type === 'event') {
    handleIncomingEvent(data.eventType, data.payload || {});
  }
});

window.speechSynthesis.onvoiceschanged = loadVoices;
updateRangeLabels();
loadVoices();
