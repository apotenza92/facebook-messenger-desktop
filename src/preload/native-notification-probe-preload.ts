import { contextBridge, ipcRenderer } from "electron";
import { installHooks } from "./native-notification-probe-hooks";

ipcRenderer.send("native-notification-probe-event", {
  event: "native-preload-started",
  pageTime: Date.now(),
});
try {
  const config = ipcRenderer.sendSync("native-notification-probe-config") as {
    salt: string;
    context: string;
  } | null;
  if (config)
    contextBridge.executeInMainWorld({
      func: installHooks,
      args: [
        config,
        (record: Record<string, unknown>) =>
          ipcRenderer.send("native-notification-probe-event", record),
      ],
    });
} catch {
  ipcRenderer.send("native-notification-probe-event", {
    event: "native-hooks-failed",
    pageTime: Date.now(),
  });
}
