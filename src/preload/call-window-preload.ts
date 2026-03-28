/**
 * Preload script for call windows - backup cleanup for MediaStreams
 * The main tracking is done by call-window-inject.ts (injected into page context)
 * This preload provides fallback cleanup via the exposed __stopAllMediaTracks function
 */
import { ipcRenderer } from "electron";

// Cleanup function - calls the injected script's cleanup if available
function triggerCleanup(reason: string): void {
  console.log(`[Call Window Preload] Cleanup triggered: ${reason}`);

  // Call the cleanup function exposed by the injected script
  if (typeof (window as any).__stopAllMediaTracks === "function") {
    (window as any).__stopAllMediaTracks(reason);
  } else {
    console.log("[Call Window Preload] Injected cleanup not available yet");
  }
}

// Cleanup on window close
window.addEventListener("beforeunload", () => {
  triggerCleanup("window closing");
});

// Cleanup on page hide
window.addEventListener("pagehide", () => {
  triggerCleanup("page hide");
});

window.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || data.type !== "md-call-window-state") {
    return;
  }

  ipcRenderer.send("call-window-state", data.payload || {});
});

console.log("[Call Window Preload] Loaded - backup cleanup enabled");
