const {contextBridge: contextBridge, ipcMain: ipcMain, ipcRenderer: ipcRenderer} = require("electron");

contextBridge.exposeInMainWorld("rocketCast", {
  getOverlays: () => ipcRenderer.invoke("get-overlays"),
  listCaptureSources: options => ipcRenderer.invoke("list-capture-sources", options),
  launchOverlay: overlayName => ipcRenderer.invoke("launch-overlay", overlayName),
  openExternalUrl: url => ipcRenderer.invoke("open-external-url", url),
  importOverlayFolder: () => ipcRenderer.invoke("import-overlay-folder"),
  pickMediaStorageFolder: () => ipcRenderer.invoke("pick-media-storage-folder"),
  checkForUpdates: () => ipcRenderer.invoke("check-for-updates"),
  openCustomOverlaysFolder: () => ipcRenderer.invoke("open-custom-overlays-folder"),
  deleteCustomOverlay: overlayPath => ipcRenderer.invoke("delete-custom-overlay", overlayPath),
  listBuilderProjects: () => ipcRenderer.invoke("list-builder-projects"),
  pickBuilderProject: () => ipcRenderer.invoke("pick-builder-project"),
  createBuilderProject: name => ipcRenderer.invoke("create-builder-project", name),
  saveBuilderProject: payload => ipcRenderer.invoke("save-builder-project", payload),
  uploadBuilderImage: payload => ipcRenderer.invoke("upload-builder-image", payload),
  uploadBuilderTransition: payload => ipcRenderer.invoke("upload-builder-transition", payload),
  uploadBuilderFont: payload => ipcRenderer.invoke("upload-builder-font", payload),
  setGlobalKeybinds: keybindMap => ipcRenderer.invoke("set-global-keybinds", keybindMap),
  onGlobalKeybindAction: callback => {
    if ("function" != typeof callback) return () => {};
    const listener = (event, payload) => {
      callback(payload || {});
    };
    return ipcRenderer.on("global-keybind-action", listener), () => {
      ipcRenderer.removeListener("global-keybind-action", listener);
    };
  },
  appVersion: () => ipcRenderer.invoke("get-app-version"),
  checkRlStatsConfig: () => ipcRenderer.invoke("check-rl-stats-config")
});