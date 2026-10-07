const $ = sel => document.querySelector(sel);

let commentCount = 0;
let giftCount = 0;
let lastTopViewers = [];
let lastTopLikers = [];
let lastChatTime = 0;

/* Duration timer */
let durationInterval = null;
let connectedAt = 0;

/* Window focus state */
let windowFocused = true;

/* Activity slots */
const ACTIVITY_DURATION = 3500;
const activityTimers = new Map();

/* Limits */
const MAX_CHAT_ENTRIES = 50;
const MAX_GIFT_ENTRIES = 30;
const TRIM_THRESHOLD = 10;

/* Avatar cache */
const avatarCache = new Map();
const AVATAR_CACHE_MAX = 100;

/* Gift image cache */
const giftImageCache = new Set();

/* Stats batching */
let pendingStats = null;
let statsTimer = null;
const STATS_THROTTLE = 500;

/* Render batching */
let chatBatch = [];
let chatFrame = null;
let giftBatch = [];
let giftFrame = null;
let scrollPending = false;

/* Helpers */
const formatNumber = value => new Intl.NumberFormat('en-US', {
  notation: value >= 10000 ? 'compact' : 'standard',
  maximumFractionDigits: 1
}).format(value || 0);

function createAvatar(data) {
  const key = data.username || data.nickname || '';

  if (data.avatar && key) {
    if (avatarCache.has(key)) {
      return Object.assign(document.createElement('img'), {
        className: 'avatar',
        src: avatarCache.get(key),
        loading: 'lazy',
        decoding: 'async',
        alt: ''
      });
    }

    if (avatarCache.size >= AVATAR_CACHE_MAX) {
      const firstKey = avatarCache.keys().next().value;
      avatarCache.delete(firstKey);
    }
    avatarCache.set(key, data.avatar);

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

function updateTotalCount() {
  const total = commentCount + giftCount;
  $('#count').textContent = `${total} item${total === 1 ? '' : 's'}`;
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

/* Window focus */
window.overlay.onWindowFocus(focused => {
  windowFocused = focused;
  document.body.classList.toggle('window-blurred', !focused);

  if (focused && connectedAt) {
    startDurationTimer();
    /* Flush pending chat batch on focus */
    if (chatBatch.length) flushChatBatch();
    if (giftBatch.length) flushGiftBatch();
  } else {
    stopDurationTimer();
  }
});

/* Tab visibility */
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    stopDurationTimer();
  } else if (connectedAt) {
    startDurationTimer();
    if (chatBatch.length) flushChatBatch();
    if (giftBatch.length) flushGiftBatch();
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

  if (!isConnected) {
    $('#viewers').textContent = '—';
    $('#likes').textContent = '0';

    avatarCache.clear();
    giftImageCache.clear();
    lastTopViewers = [];
    lastTopLikers = [];
    commentCount = 0;
    giftCount = 0;
    lastChatTime = 0;
    connectedAt = 0;

    /* Flush pending batches */
    chatBatch = [];
    giftBatch = [];
  }

  stopDurationTimer();

  if (isConnected) {
    connectedAt = data.connectedAt || Date.now();
    if (windowFocused && !document.hidden) {
      startDurationTimer();
    } else {
      tickDuration();
    }
  } else {
    $('#duration').textContent = '00:00:00';
  }
}

window.overlay.onStatus(updateStatus);

/* Stats — batched */
window.overlay.onStats(data => {
  pendingStats = pendingStats ? { ...pendingStats, ...data } : { ...data };

  if (statsTimer) return;

  statsTimer = setTimeout(() => {
    const s = pendingStats;
    pendingStats = null;
    statsTimer = null;

    if (!s) return;

    if (Number.isFinite(s.viewers)) {
      $('#viewers').textContent = formatNumber(s.viewers);
    }
    if (s.likes !== undefined && s.likes !== null) {
      $('#likes').textContent = formatNumber(s.likes);
    }
    if (Array.isArray(s.topViewers) && s.topViewers.length > 0) {
      lastTopViewers = s.topViewers;
      renderTopViewers();
    }
    if (Array.isArray(s.topLikers) && s.topLikers.length > 0) {
      lastTopLikers = s.topLikers;
      renderTopLikers();
    }
  }, STATS_THROTTLE);
});

/* Top viewers */
function renderTopViewers() {
  const list = $('#top-popup-list');
  if (!list) return;

  const medals = ['🥇', '🥈', '🥉'];

  if (lastTopViewers.length === 0) {
    list.innerHTML = '<div class="top-popup-empty">No top viewers yet</div>';
    return;
  }

  const fragment = document.createDocumentFragment();

  lastTopViewers.forEach((viewer, index) => {
    const item = document.createElement('div');
    item.className = 'top-popup-item';

    const rank = document.createElement('span');
    rank.className = 'top-popup-rank';
    rank.textContent = medals[index] || String(index + 1);

    const avatar = document.createElement('span');
    avatar.className = 'top-popup-avatar';
    if (viewer.avatar) {
      avatar.style.backgroundImage = `url("${viewer.avatar}")`;
    } else {
      avatar.textContent = (viewer.nickname || viewer.username || '?')[0].toUpperCase();
    }

    const name = document.createElement('span');
    name.className = 'top-popup-name';
    name.textContent = viewer.nickname || viewer.username || 'Viewer';

    const handle = document.createElement('span');
    handle.className = 'top-popup-handle';
    handle.textContent = `@${viewer.username}`;

    const textCol = document.createElement('div');
    textCol.className = 'top-popup-text';
    textCol.append(name, handle);

    item.append(rank, avatar, textCol);
    fragment.append(item);
  });

  list.replaceChildren(fragment);
}

function openTopPopup() {
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

/* Top likers */
function renderTopLikers() {
  const list = $('#likes-popup-list');
  if (!list) return;

  const medals = ['🥇', '🥈', '🥉'];

  if (lastTopLikers.length === 0) {
    list.innerHTML = '<div class="top-popup-empty">No likes yet</div>';
    return;
  }

  const fragment = document.createDocumentFragment();

  lastTopLikers.forEach((user, index) => {
    const item = document.createElement('div');
    item.className = 'top-popup-item';

    const rank = document.createElement('span');
    rank.className = 'top-popup-rank';
    rank.textContent = medals[index] || String(index + 1);

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

    const count = document.createElement('span');
    count.className = 'top-popup-count';
    count.textContent = formatNumber(user.likes);

    item.append(rank, avatar, textCol, count);
    fragment.append(item);
  });

  list.replaceChildren(fragment);
}

function openLikesPopup() {
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

  for (const data of giftBatch) {
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

      if (!giftImageCache.has(data.image)) {
        giftImageCache.add(data.image);
      }

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

  $('#gift-section').hidden = false;
  $('#count-gift').textContent = giftCount;
  updateTotalCount();
}

window.overlay.onGift(data => {
  if (!data.nickname) return;

  giftCount++;
  giftBatch.push(data);

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

  for (const data of chatBatch) {
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
  updateTotalCount();
}

window.overlay.onChat(data => {
  if (!data.comment) return;

  const now = Date.now();
  if (now - lastChatTime < currentSettings.chatThrottle) return;
  lastChatTime = now;

  commentCount++;
  chatBatch.push(data);

  /* If window is blurred or hidden, don't render — wait for focus */
  if (!windowFocused || document.hidden) return;

  if (!chatFrame) {
    chatFrame = requestAnimationFrame(flushChatBatch);
  }
});

/* Connect */
$('#form').addEventListener('submit', async event => {
  event.preventDefault();
  $('#error').textContent = '';

  const result = await window.overlay.connect($('#username').value);

  if (!result.ok) {
    $('#error').textContent = /offline|not live|isn't live/i.test(result.error)
      ? 'This account is not currently LIVE or the stream is private.'
      : result.error;
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
