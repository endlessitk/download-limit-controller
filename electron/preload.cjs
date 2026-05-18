const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("netlimiter", {
  invoke(command, payload) {
    return ipcRenderer.invoke("netlimiter:invoke", { command, payload });
  },
});
