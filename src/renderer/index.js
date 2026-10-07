const $ = sel => document.querySelector(sel);

let durationTimer;
let commentCount = 0;
let giftCount = 0;

/* Helpers */
const formatNumber = value => new Intl.NumberFormat('en-US', {
  notation: value >= 10000 ? 'compact' : 'standard',
  maximumFractionDigits: 1
}).format(value || 0);

function createAvatar(data) {
  if (data.avatar) {
    return Object.assign(document.createElement('img'), {
      className: 'avatar',
      src: data.avatar,
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
  }

  clearInterval(durationTimer);

  if (isConnected) {
    const startedAt = data.connectedAt || Date.now();
    const tick = () => {
      const elapsed = Math.floor((Date.now() - startedAt) / 1000);
      $('#duration').textContent = [
        Math.floor(elapsed / 3600),
        Math.floor((elapsed % 3600) / 60),
        elapsed % 60
      ].map(v => String(v).padStart(2, '0')).join(':');
    };
    tick();
    durationTimer = setInterval(tick, 1000);
  } else {
    $('#duration').textContent = '00:00:00';
  }
}

window.overlay.onStatus(updateStatus);

/* Stats */
window.overlay.onStats(data => {
  if (Number.isFinite(data.viewers)) {
    $('#viewers').textContent = formatNumber(data.viewers);
  }
  if (data.likes !== undefined && data.likes !== null) {
    $('#likes').textContent = formatNumber(data.likes);
  }
});

/* Gift */
window.overlay.onGift(data => {
  if (!data.nickname) return;

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
    text.append(giftImg);
  }

  body.append(text);
  entry.append(createAvatar(data), body);

  const feed = $('#feed-gift');
  feed.append(entry);

  /* Keep only the latest 50 gifts */
  while (feed.children.length > 50) feed.firstElementChild.remove();
  feed.scrollTop = feed.scrollHeight;

  giftCount++;
  $('#count-gift').textContent = giftCount;
  $('#gift-section').hidden = false;
  updateTotalCount();
});

/* Connect */
$('#form').addEventListener('submit', async event => {
  event.preventDefault();
  $('#error').textContent = '';

  const result = await window.overlay.connect($('#username').value);

  if (!result.ok) {
    /* Friendly message for common "not live" errors */
    $('#error').textContent = /offline|not live|isn't live/i.test(result.error)
      ? 'This account is not currently LIVE or the stream is private.'
      : result.error;
  }
});

/* Chat */
window.overlay.onChat(data => {
  if (!data.comment) return;

  $('#empty')?.remove();

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

  const feed = $('#feed');
  feed.append(entry);

  /* Keep only the latest 80 entries */
  while (feed.children.length > 80) feed.firstElementChild.remove();
  feed.scrollTop = feed.scrollHeight;

  commentCount++;
  $('#count-chat').textContent = commentCount;
  updateTotalCount();
});

/* Window controls */
$('#disconnect').onclick = () => window.overlay.disconnect();
$('#min').onclick = () => window.overlay.minimize();
$('#close').onclick = () => window.overlay.close();
