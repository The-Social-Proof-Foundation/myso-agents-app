/*
 * Preload (2026-09-17, narrow-window wave): the ONLY bridge between the
 * sandboxed renderer and the main process. contextIsolation + sandbox are
 * on (electron/main.cjs), so this file is the renderer's entire access to
 * Electron — keep it a minimal, explicit API surface.
 *
 *   window.mysoAgents.platform — read-only OS identity for native window-control
 *   gutters (darwin: left traffic lights; win32/linux: right overlay).
 *
 *   window.mysoAgents.expandWindow() — widen the window to the sidebar auto-close
 *   threshold (928px) when the sidebar is opened below it. The main
 *   process clamps: no-op if the window is already wide enough.
 *
 *   window.mysoAgents.onZoom(cb) / window.mysoAgents.getZoom() — the zoom truth (owner
 *   round 7, 2026-10-05): every ⌘±/⌘0 change arrives as "myso-agents:zoom" with
 *   the new factor; getZoom covers the first-paint race. The renderer
 *   publishes it as --myso-agents-zoom so physical-constant lengths (the traffic-
 *   light gutter) can divide by it.
 *
 *   window.mysoAgents.onUpdateStatus(cb) / window.mysoAgents.installUpdate() — the
 *   auto-update channel (Wave C, 2026-10-10): "myso-agents:update-status" pushes
 *   {status:"downloaded", version} once an update is staged; installUpdate
 *   asks main to kill the server and quit-and-install. Browser builds:
 *   both absent, the banner never renders.
 *
 * Channel names are mirrored in electron/main.cjs — keep them in sync.
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("mysoAgents", {
	platform: process.platform,
    myso: {
        connect: () => ipcRenderer.invoke("myso-agents:account:connect"),
        cancel: () => ipcRenderer.invoke("myso-agents:account:cancel"),
        logout: () => ipcRenderer.invoke("myso-agents:account:logout"),
    },
	chatgpt: {
		status: () => ipcRenderer.invoke("myso-agents:chatgpt:control", { op: "status" }),
		login: (id) => ipcRenderer.invoke("myso-agents:chatgpt:control", { op: "login", id }),
		cancel: () => ipcRenderer.invoke("myso-agents:chatgpt:control", { op: "cancel" }),
		select: (id) => ipcRenderer.invoke("myso-agents:chatgpt:control", { op: "select", id }),
		disconnect: (id) => ipcRenderer.invoke("myso-agents:chatgpt:control", { op: "disconnect", id }),
		logout: (id) => ipcRenderer.invoke("myso-agents:chatgpt:control", { op: "logout", id }),
		consent: (enabled) => ipcRenderer.invoke("myso-agents:chatgpt:control", { op: "consent", enabled }),
		onChange: (cb) => {
			const listener = () => cb();
			ipcRenderer.on("myso-agents:chatgpt:changed", listener);
			return () => ipcRenderer.removeListener("myso-agents:chatgpt:changed", listener);
		},
	},
	expandWindow: () => ipcRenderer.send("myso-agents:expand-window"),
	onZoom: (cb) => {
		const listener = (_event, factor) => cb(factor);
		ipcRenderer.on("myso-agents:zoom", listener);
		return () => ipcRenderer.removeListener("myso-agents:zoom", listener);
	},
	getZoom: () => ipcRenderer.invoke("myso-agents:zoom:get"),
	onUpdateStatus: (cb) => {
		const listener = (_event, status) => cb(status);
		ipcRenderer.on("myso-agents:update-status", listener);
		return () => ipcRenderer.removeListener("myso-agents:update-status", listener);
	},
	installUpdate: () => ipcRenderer.send("myso-agents:update-install"),
});
