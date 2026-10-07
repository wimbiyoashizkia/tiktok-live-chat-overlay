import { app, BrowserWindow, ipcMain, screen } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  connect,
  disconnect,
  setStatusCallback,
  setChatCallback,
  setStatsCallback,
  setGiftCallback,
  setActivityCallback
} from './tiktok.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let mainWindow;

/* Disable hardware acceleration — free GPU for games */
app.disableHardwareAcceleration();

/* Lower process priority so games stay responsive */
if (process.platform === 'darwin' || process.platform === 'linux') {
  try {
    process.setPriority(10);
  } catch { /* ignore */ }
}

/* Disable unused Chromium features */
app.commandLine.appendSwitch('disable-features', [
  'HardwareMediaKeyHandling',
  'MediaSessionService',
  'GlobalMediaControls',
  'GlobalMediaControlsCastStartStop',
  'PictureInPicture',
  'AutofillServerCommunication'
].join(','));

app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-default-apps');
app.commandLine.appendSwitch('disable-sync');

const send = (channel, payload) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
};

function createWindow() {
  const workArea = screen.getPrimaryDisplay().workArea;

  mainWindow = new BrowserWindow({
    width: 440,
    height: Math.min(760, workArea.height - 70),
    x: workArea.x + workArea.width - 475,
    y: workArea.y + 35,
    minWidth: 320,
    minHeight: 300,
    transparent: true,
    frame: false,
    resizable: true,
    alwaysOnTop: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: true,
      spellcheck: false,
      webgl: false,
      enableWebSQL: false,
      affinity: 'overlay'
    }
  });

  mainWindow.setAlwaysOnTop(true, 'floating');
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  /* Limit frame rate to 30 FPS — saves GPU */
  mainWindow.webContents.setFrameRate(30);

  /* Notify renderer about window focus/blur */
  mainWindow.on('focus', () => send('window:focus', true));
  mainWindow.on('blur', () => send('window:focus', false));

  /* Enable compression for TikTok CDN requests */
  mainWindow.webContents.session.webRequest.onBeforeSendHeaders(
    { urls: ['*://*.tiktokcdn.com/*', '*://*.tiktokcdn-us.com/*'] },
    (details, callback) => {
      details.requestHeaders['Accept-Encoding'] = 'gzip, deflate, br';
      callback({ requestHeaders: details.requestHeaders });
    }
  );

  /* Bridge TikTok callbacks to renderer */
  setStatusCallback(payload => send('live:status', payload));
  setChatCallback(payload => send('live:chat', payload));
  setStatsCallback(payload => send('live:stats', payload));
  setGiftCallback(payload => send('live:gift', payload));
  setActivityCallback(payload => send('live:activity', payload));
}

/* IPC handlers */
ipcMain.handle('live:connect', (_e, username) => connect(username));
ipcMain.handle('live:disconnect', () => disconnect());

ipcMain.on('window:close', () => mainWindow?.close());
ipcMain.on('window:minimize', () => mainWindow?.minimize());

ipcMain.on('window:top', (_e, enabled) => {
  mainWindow?.setAlwaysOnTop(Boolean(enabled), enabled ? 'floating' : 'normal');
  mainWindow?.setVisibleOnAllWorkspaces(Boolean(enabled), { visibleOnFullScreen: true });
});

/* App lifecycle */
app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  disconnect();
  if (process.platform !== 'darwin') app.quit();
});
