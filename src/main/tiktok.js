import { TikTokLiveConnection, WebcastEvent, ControlEvent } from 'tiktok-live-connector';

let liveConnection;
let isIntentionalDisconnect = false;
let onStatusChange = () => {};
let onChat = () => {};

export function setStatusCallback(fn) {
  onStatusChange = fn;
}

export function setChatCallback(fn) {
  onChat = fn;
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
