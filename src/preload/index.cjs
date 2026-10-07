const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlay', {
  /* TikTok */
  connect: username => ipcRenderer.invoke('live:connect', username),
  disconnect: () => ipcRenderer.invoke('live:disconnect'),
  onStatus: fn => ipcRenderer.on('live:status', (_e, data) => fn(data)),
  onChat: fn => ipcRenderer.on('live:chat', (_e, data) => fn(data)),
  onStats: fn => ipcRenderer.on('live:stats', (_e, data) => fn(data)),
  onGift: fn => ipcRenderer.on('live:gift', (_e, data) => fn(data)),
  onActivity: fn => ipcRenderer.on('live:activity', (_e, data) => fn(data)),

  /* Window */
  close: () => ipcRenderer.send('window:close'),
  minimize: () => ipcRenderer.send('window:minimize'),
  alwaysOnTop: enabled => ipcRenderer.send('window:top', enabled),
  onWindowFocus: fn => ipcRenderer.on('window:focus', (_e, focused) => fn(focused))
});
