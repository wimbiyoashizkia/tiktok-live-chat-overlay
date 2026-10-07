import { TikTokLiveConnection, WebcastEvent, ControlEvent } from 'tiktok-live-connector';

let liveConnection;
let isIntentionalDisconnect = false;
let onStatusChange = () => {};
let onChat = () => {};
let onStats = () => {};
let onGift = () => {};
let onActivity = () => {};

let sessionLikes = 0;
let sessionGifts = new Map();
let sessionLikers = new Map();

/* Auto-reconnect state */
let reconnectTimer = null;
let reconnectAttempts = 0;
let lastUsername = '';
let isReconnecting = false;

const RECONNECT_BASE_DELAY = 5000;
const RECONNECT_MAX_DELAY = 60000;
const RECONNECT_MAX_ATTEMPTS = 10;

export function setStatusCallback(fn) {
  onStatusChange = fn;
}

export function setChatCallback(fn) {
  onChat = fn;
}

export function setStatsCallback(fn) {
  onStats = fn;
}

export function setGiftCallback(fn) {
  onGift = fn;
}

export function setActivityCallback(fn) {
  onActivity = fn;
}

function normalizeUser(user = {}) {
  const image = user.profilePicture || user.avatarThumb || user.avatarMedium || user.avatarLarge;
  return {
    username: user.uniqueId || user.displayId || 'viewer',
    nickname: user.nickname || user.uniqueId || 'Viewer',
    avatar: image?.urlList?.[0] || image?.url?.[0] || ''
  };
}

function clearReconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  reconnectAttempts = 0;
  isReconnecting = false;
}

function scheduleReconnect() {
  if (isIntentionalDisconnect) return;
  if (!lastUsername) return;
  if (isReconnecting) return;
  if (reconnectAttempts >= RECONNECT_MAX_ATTEMPTS) {
    onStatusChange({
      state: 'error',
      text: `Reconnect failed after ${RECONNECT_MAX_ATTEMPTS} attempts`
    });
    return;
  }

  isReconnecting = true;
  reconnectAttempts++;

  const delay = Math.min(
    RECONNECT_BASE_DELAY * Math.pow(2, reconnectAttempts - 1),
    RECONNECT_MAX_DELAY
  );

  onStatusChange({
    state: 'connecting',
    text: `Reconnecting… (attempt ${reconnectAttempts})`
  });

  reconnectTimer = setTimeout(async () => {
    isReconnecting = false;
    try {
      await connect(lastUsername, { isReconnect: true });
    } catch {
      /* connect() handles its own errors */
    }
  }, delay);
}

export async function disconnect() {
  isIntentionalDisconnect = true;
  clearReconnect();

  const current = liveConnection;
  liveConnection = undefined;

  /* Clear session data to free memory */
  sessionGifts.clear();
  sessionLikers.clear();
  sessionLikes = 0;

  if (current) {
    try { await current.disconnect(); } catch { /* ignore */ }
  }

  onStatusChange({ state: 'idle', text: 'Disconnected' });
}

export async function connect(usernameInput, options = {}) {
  const { isReconnect = false } = options;

  /* Accept @username */
  const username = String(usernameInput || '').trim()
    .replace(/^https?:\/\/[^/]+\/@/, '')
    .replace(/\/live.*$/, '')
    .replace(/^@/, '');

  if (!username) {
    return { ok: false, error: 'Please enter a TikTok username.' };
  }

  /* Manual connect — reset session */
  if (!isReconnect) {
    clearReconnect();
    await disconnect();
    isIntentionalDisconnect = false;
    sessionLikes = 0;
    sessionGifts = new Map();
    sessionLikers = new Map();
    lastUsername = username;
    reconnectAttempts = 0;
  }

  onStatusChange({
    state: 'connecting',
    text: isReconnect
      ? `Reconnecting to @${username}…`
      : `Connecting to @${username}…`
  });

  const connection = new TikTokLiveConnection(username, {
    processInitialData: false,
    fetchRoomInfoOnConnect: true,
    enableExtendedGiftInfo: false
  });

  liveConnection = connection;

  /* Chat event */
  connection.on(WebcastEvent.CHAT, data => {
    onChat({
      ...normalizeUser(data.user),
      comment: data.comment || data.content || ''
    });
  });

  /* Like event */
  connection.on(WebcastEvent.LIKE, data => {
    const total = data.totalLikeCount
      ?? data.likeCount
      ?? data.total
      ?? null;

    let increment = 1;

    if (total !== null && total > 0) {
      increment = Math.max(1, Number(total) - sessionLikes);
      sessionLikes = Number(total);
    } else {
      increment = Number(data.count || data.likeCount || 1);
      sessionLikes += increment;
    }

    /* Track per-user likes */
    const user = normalizeUser(data.user);
    if (user.username && user.username !== 'viewer') {
      const existing = sessionLikers.get(user.username) || {
        nickname: user.nickname,
        avatar: user.avatar,
        likes: 0
      };
      existing.likes += increment;
      sessionLikers.set(user.username, existing);
    }

    /* Top 5 likers */
    const topLikers = Array.from(sessionLikers.entries())
      .map(([username, info]) => ({
        username,
        nickname: info.nickname,
        avatar: info.avatar,
        likes: info.likes
      }))
      .sort((a, b) => b.likes - a.likes)
      .slice(0, 5);

    onStats({ likes: sessionLikes, topLikers });
  });

  /* Room user — viewers, likes, top viewers */
  connection.on(WebcastEvent.ROOM_USER, data => {
    const viewers = data.viewerCount ?? data.total;

    const totalLikes = data.likeCount
      ?? data.totalLikeCount
      ?? data.stats?.likeCount
      ?? data.roomInfo?.likeCount
      ?? data.room?.likeCount;

    const ranks = data.ranksList ?? data.ranks ?? data.topViewers ?? [];

    const payload = {};

    if (Number.isFinite(Number(viewers))) {
      payload.viewers = Number(viewers);
    }

    if (totalLikes !== undefined && totalLikes !== null) {
      sessionLikes = Number(totalLikes);
      payload.likes = sessionLikes;
    }

    if (Array.isArray(ranks) && ranks.length > 0) {
      payload.topViewers = ranks.slice(0, 10).map(item => normalizeUser(item.user || item));
    }

    if (Object.keys(payload).length > 0) {
      onStats(payload);
    }
  });

  /* Gift event */
  connection.on(WebcastEvent.GIFT, data => {
    const user = normalizeUser(data.user);

    const giftName = data.giftDetails?.giftName
      || data.gift?.name
      || data.giftName
      || 'Gift';

    const image = data.giftDetails?.giftPictureUrl
      || data.gift?.image?.urlList?.[0]
      || data.gift?.icon?.urlList?.[0]
      || data.giftImage
      || '';

    /* Combo tracking per user + gift */
    const key = `${user.username}:${giftName}`;
    const current = sessionGifts.get(key) || { count: 0, image };
    const repeatCount = Number(data.repeatCount || data.comboCount || 1);

    if (data.repeatEnd || repeatCount === 1) {
      const finalCount = current.count + repeatCount;
      sessionGifts.set(key, { count: 0, image });

      onGift({
        ...user,
        giftName,
        amount: finalCount,
        image
      });
    } else {
      current.count = repeatCount;
      sessionGifts.set(key, current);

      onGift({
        ...user,
        giftName,
        amount: repeatCount,
        image,
        isCombo: true
      });
    }
  });

  /* Share event */
  connection.on(WebcastEvent.SHARE, data => {
    onActivity({
      type: 'share',
      ...normalizeUser(data.user)
    });
  });

  /* Follow event */
  connection.on(WebcastEvent.FOLLOW, data => {
    onActivity({
      type: 'follow',
      ...normalizeUser(data.user)
    });
  });

  /* Member join event */
  connection.on(WebcastEvent.MEMBER, data => {
    onActivity({
      type: 'join',
      ...normalizeUser(data.user)
    });
  });

  /* Stream ended */
  connection.on(WebcastEvent.STREAM_END, () => {
    isIntentionalDisconnect = true;
    clearReconnect();
    onStatusChange({ state: 'ended', text: 'The LIVE stream has ended' });
  });

  /* Connection lost */
  connection.on(ControlEvent.DISCONNECTED, () => {
    if (isIntentionalDisconnect) return;
    onStatusChange({ state: 'error', text: 'LIVE connection lost' });
    scheduleReconnect();
  });

  /* Error handler */
  connection.on('error', error => {
    console.error('TikTok connection error:', error);
  });

  try {
    const state = await connection.connect();

    reconnectAttempts = 0;
    isReconnecting = false;

    onStatusChange({
      state: 'connected',
      text: `LIVE @${username}`,
      connectedAt: Date.now()
    });

    return { ok: true, roomId: state.roomId };
  } catch (error) {
    if (liveConnection === connection) liveConnection = undefined;
    const message = error?.message || 'Unable to connect.';

    onStatusChange({ state: 'error', text: message });

    if (!isIntentionalDisconnect && !isReconnect) {
      scheduleReconnect();
    }

    return { ok: false, error: message };
  }
}
