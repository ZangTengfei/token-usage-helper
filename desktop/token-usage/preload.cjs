const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld(
  "clubUsage",
  Object.freeze({
    state: () => ipcRenderer.invoke("usage:state"),
    action: (name, value) => ipcRenderer.invoke("usage:action", name, value),
    navigate: (callback) => {
      const listener = (_event, view) => callback(view);
      ipcRenderer.on("usage:navigate", listener);
      return () => ipcRenderer.removeListener("usage:navigate", listener);
    },
    subscribe: (callback) => {
      const listener = (_event, state) => callback(state);
      ipcRenderer.on("usage:changed", listener);
      return () => ipcRenderer.removeListener("usage:changed", listener);
    },
  }),
);
