import { TikTokLiveConnection, WebcastEvent, ControlEvent } from 'tiktok-live-connector';

let liveConnection;
let isIntentionalDisconnect = false;
let onStatusChange = () => {};
let onChat = () => {};
let onStats = () => {};

let sessionLikes = 0;

export function setStatusCallback(fn) {
  onStatusChange = fn;
}

export function setChatCallback(fn) {
  onChat = fn;
}

export function setStatsCallback(fn) {
  onStats = fn;
}

function normalizeUser(user = {}) {
  const image = user.profilePicture || user.avatarThumb || user.avatarMedium || user.avatarLarge;
  return {
    username: user.uniqueId || user.displayId || 'viewer',
    nickname: user.nickname || user.uniqueId || 'Viewer',
    avatar: image?.urlList?.[0] || image?.url?.[0] || ''
  };
}

export async function disconnect() {
  isIntentionalDisconnect = true;
  const current = liveConnection;
  liveConnection = undefined;

  if (current) {
    try { await current.disconnect(); } catch { /* ignore */ }
  }

  onStatusChange({ state: 'idle', text: 'Disconnected' });
}

export async function connect(usernameInput) {
  /* Accept @username */
  const username = String(usernameInput || '').trim()
    .replace(/^https?:\/\/[^/]+\/@/, '')
    .replace(/\/live.*$/, '')
    .replace(/^@/, '');

  if (!username) {
    return { ok: false, error: 'Please enter a TikTok username.' };
  }

  await disconnect();
  isIntentionalDisconnect = false;
  sessionLikes = 0;

  onStatusChange({ state: 'connecting', text: `Connecting to @${username}…` });

  const connection = new TikTokLiveConnection(username, {
    processInitialData: true,
    fetchRoomInfoOnConnect: true
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

    if (total !== null && total > 0) {
      sessionLikes = Number(total);
    } else {
      const increment = Number(data.count || data.likeCount || 1);
      sessionLikes += increment;
    }

    onStats({ likes: sessionLikes });
  });

  /* Room user — viewers + likes snapshot */
  connection.on(WebcastEvent.ROOM_USER, data => {
    const viewers = data.viewerCount ?? data.total;

    const totalLikes = data.likeCount
      ?? data.totalLikeCount
      ?? data.stats?.likeCount
      ?? data.roomInfo?.likeCount
      ?? data.room?.likeCount;

    const payload = {};

    if (Number.isFinite(Number(viewers))) {
      payload.viewers = Number(viewers);
    }

    if (totalLikes !== undefined && totalLikes !== null) {
      sessionLikes = Number(totalLikes);
      payload.likes = sessionLikes;
    }

    if (Object.keys(payload).length > 0) {
      onStats(payload);
    }
  });

  /* Stream ended */
  connection.on(WebcastEvent.STREAM_END, () => {
    onStatusChange({ state: 'ended', text: 'The LIVE stream has ended' });
  });

  /* Connection lost */
  connection.on(ControlEvent.DISCONNECTED, () => {
    if (!isIntentionalDisconnect) {
      onStatusChange({ state: 'error', text: 'LIVE connection lost' });
    }
  });

  /* Error handler */
  connection.on('error', error => {
    console.error('TikTok connection error:', error);
  });

  try {
    const state = await connection.connect();
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
    return { ok: false, error: message };
  }
}
