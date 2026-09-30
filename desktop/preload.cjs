const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('legion', Object.freeze({
  status: () => ipcRenderer.invoke('legion:command', 'status'),
  retry: () => ipcRenderer.invoke('legion:command', 'retry'),
  stop: () => ipcRenderer.invoke('legion:command', 'stop'),
  chooseWorkspace: () => ipcRenderer.invoke('legion:command', 'choose-workspace'),
  configureWorkspace: () => ipcRenderer.invoke('legion:command', 'configure-workspace'),
  configureIdentity: (identity) => ipcRenderer.invoke('legion:command', 'configure-identity', identity),
  onState: (callback) => {
    if (typeof callback !== 'function') return () => {}
    const listener = (_event, state) => callback(state)
    ipcRenderer.on('legion:state', listener)
    return () => ipcRenderer.removeListener('legion:state', listener)
  },
}))
