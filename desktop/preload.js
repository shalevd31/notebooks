// Hands the page the keys saved in this computer's local config file (never in the repo).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('nbConfig', ipcRenderer.sendSync('nb-config'));
