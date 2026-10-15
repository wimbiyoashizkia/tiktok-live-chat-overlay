const $ = sel => document.querySelector(sel);

let commentCount = 0;
let giftCount = 0;
let lastTopViewers = [];
let lastTopLikers = [];
let lastChatTime = 0;

/* Duration timer */
let durationInterval = null;
let connectedAt = 0;

/* Window state */
let userIdle = false;

/* Activity slots */
const ACTIVITY_DURATION = 3500;
const activityTimers = new Map();

/* Limits */
const MAX_CHAT_ENTRIES = 50;
const MAX_GIFT_ENTRIES = 30;
const TRIM_THRESHOLD = 10;

/* Render batching */
let chatBatch = [];
let chatFrame = null;
let giftBatch = [];
let giftFrame = null;
let scrollPending = false;

const MEDALS = ['🥇', '🥈', '🥉'];

/* Helpers */
const numberFormatter = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 1
});

const compactFormatter = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 1
});

const formatNumber = value => {
  const n = value || 0;
  return (n >= 10000 ? compactFormatter : numberFormatter).format(n);
};

function createAvatar(data) {
  if (data.avatar) {
    return Object.assign(document.createElement('img'), {
      className: 'avatar',
      src: data.avatar,
      loading: 'lazy',
      decoding: 'async',
      alt: ''
    });
  }

  return Object.assign(document.createElement('div'), {
    className: 'avatar',
    textContent: (data.nickname || data.username || '?')[0].toUpperCase()
  });
}

/* Batched scroll — runs once per frame */
function scheduleScroll(feed) {
  if (scrollPending) return;
  scrollPending = true;

  requestAnimationFrame(() => {
    scrollPending = false;
    feed.scrollTop = feed.scrollHeight;
  });
}

/* Batched trim — only when far over limit */
function trimFeed(feed, max) {
  if (feed.children.length <= max + TRIM_THRESHOLD) return;
  const remove = feed.children.length - max;
  for (let i = 0; i < remove; i++) {
    feed.firstElementChild?.remove();
  }
}

/* Reset all session state */
function resetSessionState() {
  if (chatFrame) cancelAnimationFrame(chatFrame);
  if (giftFrame) cancelAnimationFrame(giftFrame);
  chatFrame = null;
  giftFrame = null;

  lastTopViewers = [];
  lastTopLikers = [];
  commentCount = 0;
  giftCount = 0;
  lastChatTime = 0;
  chatBatch = [];
  giftBatch = [];
}

/* Clear both feeds and remove tutorial */
function clearFeeds() {
  $('#feed-gift')?.replaceChildren();
  $('#feed')?.replaceChildren();
}

/* Restore the onboarding empty state */
function restoreEmptyState() {
  const feed = $('#feed');
  if (!feed) return;
  if (feed.querySelector('#empty')) return;

  const empty = document.createElement('div');
  empty.id = 'empty';
  empty.className = 'empty';
  empty.innerHTML = `
    <div class="empty-icon">💬</div>
    <h2 class="empty-title">TikTok Live Chat Overlay</h2>
    <p class="empty-subtitle">Get started in 3 steps</p>
    <ol class="empty-steps">
      <li>
        <span class="step-num">1</span>
        <span class="step-text">Enter a TikTok username or LIVE link</span>
      </li>
      <li>
        <span class="step-num">2</span>
        <span class="step-text">Click <b>Connect</b></span>
      </li>
      <li>
        <span class="step-num">3</span>
        <span class="step-text">Chat and gifts appear here in realtime</span>
      </li>
    </ol>
    <p class="empty-tip">
      <span>⚙</span>
      Customize the overlay in settings
    </p>
  `;

  feed.append(empty);
}

/* Duration timer */
function tickDuration() {
  if (!connectedAt) return;
  const elapsed = Math.floor((Date.now() - connectedAt) / 1000);
  $('#duration').textContent = [
    Math.floor(elapsed / 3600),
    Math.floor((elapsed % 3600) / 60),
    elapsed % 60
  ].map(v => String(v).padStart(2, '0')).join(':');
}

function startDurationTimer() {
  stopDurationTimer();
  if (!connectedAt) return;
  tickDuration();
  durationInterval = setInterval(tickDuration, 1000);
}

function stopDurationTimer() {
  if (durationInterval) {
    clearInterval(durationInterval);
    durationInterval = null;
  }
}

/* Flush anything queued while the window was minimized */
function flushPending() {
  if (chatBatch.length) flushChatBatch();
  if (giftBatch.length) flushGiftBatch();
}

/* Window focus — only pauses CSS animations, chat keeps rendering */
window.overlay.onWindowFocus(focused => {
  document.body.classList.toggle('window-blurred', !focused);
});

/* Idle state — only pauses CSS animations */
window.overlay.onIdle(isIdle => {
  if (userIdle === isIdle) return;
  userIdle = isIdle;
  document.body.classList.toggle('window-idle', isIdle);
});

/* Visibility — pause work only while the window is actually hidden */
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    stopDurationTimer();
  } else {
    if (connectedAt) startDurationTimer();
    flushPending();
  }
});

/* Status */
function updateStatus(data) {
  const isConnected = data.state === 'connected';
  const isConnecting = data.state === 'connecting';

  $('#disconnect').hidden = !isConnected;
  $('#connect').disabled = isConnecting;
  $('#connect').textContent = isConnecting ? 'Connecting…' : 'Connect';

  const pill = $('#status-pill');
  if (isConnected) {
    pill.hidden = true;
  } else {
    pill.hidden = false;
    pill.className = `status-pill ${data.state}`;
    pill.querySelector('span').textContent = data.text;
  }

  $('#connect-bar').classList.toggle('collapsed', isConnected);

  /* Toggle main sections visibility */
  document.body.classList.toggle('connected', isConnected);

  /* Show chat header only when connected */
  $('.chat-head').hidden = !isConnected;

  /* Show gift section only when connected */
  $('#gift-section').hidden = !isConnected;

  if (!isConnected) {
    $('#viewers').textContent = '—';
    $('#likes').textContent = '0';

    resetSessionState();
    clearFeeds();
    restoreEmptyState();

    connectedAt = 0;
  }

  stopDurationTimer();

  if (isConnected) {
    connectedAt = data.connectedAt || Date.now();
    if (!document.hidden) {
      startDurationTimer();
    } else {
      tickDuration();
    }
  } else {
    $('#duration').textContent = '00:00:00';
  }
}

window.overlay.onStatus(updateStatus);

/* Ranking popups — shared renderer */
function renderRanking(list, items, { showCount, emptyText }) {
  if (!list) return;

  if (items.length === 0) {
    list.innerHTML = `<div class="top-popup-empty">${emptyText}</div>`;
    return;
  }

  const fragment = document.createDocumentFragment();

  items.forEach((user, index) => {
    const item = document.createElement('div');
    item.className = 'top-popup-item';

    const rank = document.createElement('span');
    rank.className = 'top-popup-rank';
    rank.textContent = MEDALS[index] || String(index + 1);

    const avatar = document.createElement('span');
    avatar.className = 'top-popup-avatar';
    if (user.avatar) {
      avatar.style.backgroundImage = `url("${user.avatar}")`;
    } else {
      avatar.textContent = (user.nickname || user.username || '?')[0].toUpperCase();
    }

    const name = document.createElement('span');
    name.className = 'top-popup-name';
    name.textContent = user.nickname || user.username || 'Viewer';

    const handle = document.createElement('span');
    handle.className = 'top-popup-handle';
    handle.textContent = `@${user.username}`;

    const textCol = document.createElement('div');
    textCol.className = 'top-popup-text';
    textCol.append(name, handle);

    item.append(rank, avatar, textCol);

    if (showCount) {
      const count = document.createElement('span');
      count.className = 'top-popup-count';
      count.textContent = formatNumber(user.likes);
      item.append(count);
    }

    fragment.append(item);
  });

  list.replaceChildren(fragment);
}

function renderTopViewers() {
  renderRanking($('#top-popup-list'), lastTopViewers, {
    showCount: false,
    emptyText: 'No top viewers yet'
  });
}

function renderTopLikers() {
  renderRanking($('#likes-popup-list'), lastTopLikers, {
    showCount: true,
    emptyText: 'No likes yet'
  });
}

/* Stats — main process already batches these, so apply directly */
window.overlay.onStats(s => {
  if (!s) return;

  if (Number.isFinite(s.viewers)) {
    $('#viewers').textContent = formatNumber(s.viewers);
  }
  if (s.likes !== undefined && s.likes !== null) {
    $('#likes').textContent = formatNumber(s.likes);
  }
  if (Array.isArray(s.topViewers) && s.topViewers.length > 0) {
    lastTopViewers = s.topViewers;
    if (!$('#top-popup').hidden) renderTopViewers();
  }
  if (Array.isArray(s.topLikers) && s.topLikers.length > 0) {
    lastTopLikers = s.topLikers;
    if (!$('#likes-popup').hidden) renderTopLikers();
  }
});

/* Top viewers popup */
function openTopPopup() {
  renderTopViewers();
  $('#top-popup').hidden = false;
  $('#top-popup-backdrop').hidden = false;
}

function closeTopPopup() {
  $('#top-popup').hidden = true;
  $('#top-popup-backdrop').hidden = true;
}

$('#viewers-btn').addEventListener('click', () => {
  if ($('#top-popup').hidden) {
    openTopPopup();
  } else {
    closeTopPopup();
  }
});

$('#top-popup-close').addEventListener('click', closeTopPopup);
$('#top-popup-backdrop').addEventListener('click', closeTopPopup);

/* Top likes popup */
function openLikesPopup() {
  renderTopLikers();
  $('#likes-popup').hidden = false;
  $('#likes-popup-backdrop').hidden = false;
}

function closeLikesPopup() {
  $('#likes-popup').hidden = true;
  $('#likes-popup-backdrop').hidden = true;
}

$('#likes-btn').addEventListener('click', () => {
  if ($('#likes-popup').hidden) {
    openLikesPopup();
  } else {
    closeLikesPopup();
  }
});

$('#likes-popup-close').addEventListener('click', closeLikesPopup);
$('#likes-popup-backdrop').addEventListener('click', closeLikesPopup);

/* Activity slots */
function showActivity(data) {
  if (!data || !data.nickname || !data.type) return;

  const container = $('#activity-float');
  if (!container) return;

  const type = data.type;

  let slot = container.querySelector(`.activity-toast[data-type="${type}"]`);

  if (activityTimers.has(type)) {
    clearTimeout(activityTimers.get(type));
    activityTimers.delete(type);
  }

  if (!slot) {
    slot = document.createElement('div');
    slot.dataset.type = type;
    slot.className = `activity-toast ${type}`;
    container.append(slot);
  }

  slot.classList.remove('removing');

  const avatar = createAvatar(data);

  const text = document.createElement('span');
  text.className = 'activity-text';

  if (type === 'share')  text.textContent = `${data.nickname} shared the LIVE`;
  if (type === 'repost') text.textContent = `${data.nickname} shared the LIVE`;
  if (type === 'follow') text.textContent = `${data.nickname} followed`;
  if (type === 'join')   text.textContent = `${data.nickname} joined`;

  slot.replaceChildren(avatar, text);

  slot.style.animation = 'none';
  void slot.offsetHeight;
  slot.style.animation = '';

  const timer = setTimeout(() => {
    slot.classList.add('removing');
    setTimeout(() => {
      slot.remove();
      activityTimers.delete(type);
    }, 300);
  }, ACTIVITY_DURATION);

  activityTimers.set(type, timer);
}

window.overlay.onActivity(showActivity);

/* Gift — batched */
function flushGiftBatch() {
  giftFrame = null;
  if (giftBatch.length === 0) return;

  const feed = $('#feed-gift');
  const fragment = document.createDocumentFragment();

  /* Never build more nodes than the feed can keep */
  const items = giftBatch.length > MAX_GIFT_ENTRIES
    ? giftBatch.slice(-MAX_GIFT_ENTRIES)
    : giftBatch;

  for (const data of items) {
    const entry = document.createElement('article');
    entry.className = 'entry gift';

    const body = document.createElement('div');
    body.className = 'body';

    const text = document.createElement('p');
    text.className = 'text';
    const amountText = data.amount > 1 ? ` ×${data.amount}` : '';
    text.textContent = `${data.nickname} sent ${data.giftName}${amountText}`;

    if (data.image) {
      const giftImg = document.createElement('img');
      giftImg.src = data.image;
      giftImg.alt = data.giftName;
      giftImg.loading = 'lazy';
      giftImg.decoding = 'async';
      text.append(giftImg);
    }

    body.append(text);
    entry.append(createAvatar(data), body);
    fragment.append(entry);
  }

  giftBatch = [];
  feed.append(fragment);

  trimFeed(feed, MAX_GIFT_ENTRIES);
  scheduleScroll(feed);

  $('#count-gift').textContent = giftCount;
}

window.overlay.onGift(data => {
  if (!data.nickname) return;

  giftCount++;
  giftBatch.push(data);

  /* Keep the queue bounded while the window is hidden */
  if (giftBatch.length > MAX_GIFT_ENTRIES) giftBatch.shift();

  if (document.hidden) return;

  if (!giftFrame) {
    giftFrame = requestAnimationFrame(flushGiftBatch);
  }
});

/* Chat — batched */
function flushChatBatch() {
  chatFrame = null;
  if (chatBatch.length === 0) return;

  $('#empty')?.remove();

  const feed = $('#feed');
  const fragment = document.createDocumentFragment();

  /* Never build more nodes than the feed can keep */
  const items = chatBatch.length > MAX_CHAT_ENTRIES
    ? chatBatch.slice(-MAX_CHAT_ENTRIES)
    : chatBatch;

  for (const data of items) {
    const entry = document.createElement('article');
    entry.className = 'entry chat';

    const body = document.createElement('div');
    body.className = 'body';

    const nameRow = document.createElement('div');
    nameRow.className = 'name';

    const nickname = document.createElement('b');
    nickname.textContent = data.nickname;

    const handle = document.createElement('span');
    handle.textContent = `@${data.username}`;

    const text = document.createElement('p');
    text.className = 'text';
    text.textContent = data.comment;

    nameRow.append(nickname, handle);
    body.append(nameRow, text);
    entry.append(createAvatar(data), body);
    fragment.append(entry);
  }

  chatBatch = [];
  feed.append(fragment);

  trimFeed(feed, MAX_CHAT_ENTRIES);
  scheduleScroll(feed);

  $('#count-chat').textContent = commentCount;
}

window.overlay.onChat(data => {
  if (!data.comment) return;

  const now = Date.now();
  if (now - lastChatTime < currentSettings.chatThrottle) return;
  lastChatTime = now;

  commentCount++;
  chatBatch.push(data);

  /* Keep the queue bounded while the window is hidden */
  if (chatBatch.length > MAX_CHAT_ENTRIES) chatBatch.shift();

  if (document.hidden) return;

  if (!chatFrame) {
    chatFrame = requestAnimationFrame(flushChatBatch);
  }
});

/* Connect */
$('#form').addEventListener('submit', async event => {
  event.preventDefault();
  $('#error').textContent = '';

  /* Reset state and clear feeds before connecting */
  resetSessionState();
  clearFeeds();

  try {
    const result = await window.overlay.connect($('#username').value);

    if (!result || !result.ok) {
      const msg = result?.error || 'Unable to connect.';

      const friendly = /offline|not live|isn't live|isn't online/i.test(msg)
        ? 'This account is not currently LIVE or the stream is private.'
        : msg;

      $('#error').textContent = friendly;

      const pill = $('#status-pill');
      pill.hidden = false;
      pill.className = 'status-pill error';
      pill.querySelector('span').textContent = friendly;

      /* Restore tutorial on failure */
      restoreEmptyState();
    }
  } catch (err) {
    console.error('Connect error:', err);
    $('#error').textContent = 'Connection failed. Please try again.';
    restoreEmptyState();
  }
});

/* Window controls */
$('#disconnect').onclick = () => window.overlay.disconnect();
$('#min').onclick = () => window.overlay.minimize();
$('#close').onclick = () => window.overlay.close();

/* Settings */
const DEFAULT_SETTINGS = {
  fontSize: 14,
  opacity: 96,
  alwaysOnTop: true,
  hideAvatars: false,
  showGift: true,
  showActivity: true,
  chatThrottle: 250
};

function loadSettings() {
  try {
    const raw = localStorage.getItem('overlay.settings');
    if (!raw) return { ...DEFAULT_SETTINGS };
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(settings) {
  localStorage.setItem('overlay.settings', JSON.stringify(settings));
}

function applySettings(settings) {
  document.documentElement.style.setProperty('--size', `${settings.fontSize}px`);
  $('#font').value = settings.fontSize;
  $('#font-value').textContent = `${settings.fontSize}px`;

  document.documentElement.style.setProperty('--opacity', settings.opacity / 100);
  $('#opacity').value = settings.opacity;
  $('#opacity-value').textContent = `${settings.opacity}%`;

  $('#throttle').value = settings.chatThrottle;
  $('#throttle-value').textContent = `${settings.chatThrottle}ms`;

  $('#topmost').checked = settings.alwaysOnTop;
  window.overlay.alwaysOnTop(settings.alwaysOnTop);

  $('#hide-avatars').checked = settings.hideAvatars;
  document.body.classList.toggle('hide-avatars', settings.hideAvatars);

  $('#show-gift').checked = settings.showGift;
  document.body.classList.toggle('hide-gift', !settings.showGift);

  $('#show-activity').checked = settings.showActivity;
  document.body.classList.toggle('hide-activity', !settings.showActivity);
}

let currentSettings = loadSettings();
applySettings(currentSettings);

/* Open / close drawer */
function openDrawer() {
  $('#settings').hidden = false;
  $('#drawer-backdrop').hidden = false;
  document.body.classList.add('drawer-open');
}

function closeDrawer() {
  $('#settings').hidden = true;
  $('#drawer-backdrop').hidden = true;
  document.body.classList.remove('drawer-open');
}

$('#gear').addEventListener('click', openDrawer);
$('#settings-close').addEventListener('click', closeDrawer);
$('#drawer-backdrop').addEventListener('click', closeDrawer);

document.addEventListener('keydown', event => {
  if (event.key === 'Escape') closeDrawer();
});

/* Slider — font size */
$('#font').addEventListener('input', event => {
  const value = Number(event.target.value);
  currentSettings.fontSize = value;
  document.documentElement.style.setProperty('--size', `${value}px`);
  $('#font-value').textContent = `${value}px`;
  saveSettings(currentSettings);
});

/* Slider — opacity */
$('#opacity').addEventListener('input', event => {
  const value = Number(event.target.value);
  currentSettings.opacity = value;
  document.documentElement.style.setProperty('--opacity', value / 100);
  $('#opacity-value').textContent = `${value}%`;
  saveSettings(currentSettings);
});

/* Slider — chat throttle */
$('#throttle').addEventListener('input', event => {
  const value = Number(event.target.value);
  currentSettings.chatThrottle = value;
  $('#throttle-value').textContent = `${value}ms`;
  saveSettings(currentSettings);
});

/* Toggle — always on top */
$('#topmost').addEventListener('change', event => {
  const enabled = event.target.checked;
  currentSettings.alwaysOnTop = enabled;
  window.overlay.alwaysOnTop(enabled);
  saveSettings(currentSettings);
});

/* Toggle — hide avatars */
$('#hide-avatars').addEventListener('change', event => {
  const enabled = event.target.checked;
  currentSettings.hideAvatars = enabled;
  document.body.classList.toggle('hide-avatars', enabled);
  saveSettings(currentSettings);
});

/* Toggle — show gift section */
$('#show-gift').addEventListener('change', event => {
  const enabled = event.target.checked;
  currentSettings.showGift = enabled;
  document.body.classList.toggle('hide-gift', !enabled);
  saveSettings(currentSettings);
});

/* Toggle — show activity toasts */
$('#show-activity').addEventListener('change', event => {
  const enabled = event.target.checked;
  currentSettings.showActivity = enabled;
  document.body.classList.toggle('hide-activity', !enabled);
  saveSettings(currentSettings);
});

/* Reset */
$('#reset-settings').addEventListener('click', () => {
  const confirmed = confirm('Reset all settings to default?');
  if (!confirmed) return;

  currentSettings = { ...DEFAULT_SETTINGS };
  saveSettings(currentSettings);
  applySettings(currentSettings);
});

/* Show version */
window.overlay.getVersion().then(version => {
  const el = $('#version');
  if (el) el.textContent = `v${version}`;
}).catch(() => { /* ignore */ });
