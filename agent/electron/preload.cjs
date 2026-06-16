const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('agent', {
  getState: () => ipcRenderer.invoke('get-state'),
  setConfig: (patch) => ipcRenderer.invoke('set-config', patch),
  play: (note) => ipcRenderer.invoke('play', note),
  pause: () => ipcRenderer.invoke('pause'),
  setNote: (note) => ipcRenderer.invoke('set-note', note),
  onStatus: (cb) => ipcRenderer.on('status', (_e, s) => cb(s)),
})
