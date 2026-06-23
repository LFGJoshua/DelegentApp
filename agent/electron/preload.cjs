const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('agent', {
  getState: () => ipcRenderer.invoke('get-state'),
  setConfig: (patch) => ipcRenderer.invoke('set-config', patch),
  login: (email, password) => ipcRenderer.invoke('auth-login', { email, password }),
  register: (name, email, password, company) => ipcRenderer.invoke('auth-register', { name, email, password, company }),
  logout: () => ipcRenderer.invoke('auth-logout'),
  forgot: (email) => ipcRenderer.invoke('auth-forgot', { email }),
  fitWindow: (h) => ipcRenderer.invoke('fit-window', h),
  timeDaily: () => ipcRenderer.invoke('time-daily'),
  play: (note) => ipcRenderer.invoke('play', note),
  pause: () => ipcRenderer.invoke('pause'),
  setNote: (note) => ipcRenderer.invoke('set-note', note),
  onStatus: (cb) => ipcRenderer.on('status', (_e, s) => cb(s)),
  onPreview: (cb) => ipcRenderer.on('preview-image', (_e, url) => cb(url)),
})
