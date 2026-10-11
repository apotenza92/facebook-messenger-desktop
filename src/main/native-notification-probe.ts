import { ipcMain, type Session, type WebContents } from "electron";
import { installHooks } from "../preload/native-notification-probe-hooks";

const CONFIG_CHANNEL = "native-notification-probe-config";
const EVENT_CHANNEL = "native-notification-probe-event";
const installed = new WeakMap<WebContents, Promise<void>>();
const EVENTS = new Set([
  "native-hooks-health",
  "metadata-unavailable",
  "push-subscribe-request",
  "push-subscribe-result",
  "push-subscribe-rejected",
  "push-getSubscription-request",
  "push-getSubscription-result",
  "push-getSubscription-rejected",
  "push-permissionState-request",
  "push-permissionState-result",
  "push-permissionState-rejected",
  "native-preload-started",
  "native-hooks-ready",
  "native-hooks-failed",
  "native-constructed",
  "native-construction-failed",
  "native-closed",
  "native-show",
  "native-error",
  "native-click",
  "native-close-event",
  "permission-request",
  "permission-result",
  "service-worker-show",
  "service-worker-show-resolved",
  "service-worker-show-rejected",
  "get-notifications",
  "get-notifications-result",
  "get-notifications-rejected",
  "worker-push",
  "worker-notificationclick",
  "worker-notificationclose",
]);
const NUMBERS = [
  "id",
  "pageTime",
  "titleLength",
  "bodyLength",
  "ageMs",
  "count",
  "timestampDeltaMs",
  "tagLength",
  "actionCount",
];
const FLAGS = [
  "subscriptionPresent",
  "online",
  "tagHasThreadId",
  "silent",
  "renotify",
  "requireInteraction",
  "dataPresent",
  "documentHasFocus",
  "constructorHook",
  "showNotificationHook",
  "getNotificationsHook",
  "closeHook",
];
const OPTION_KEYS = new Set([
  "body",
  "tag",
  "data",
  "icon",
  "badge",
  "image",
  "actions",
  "silent",
  "renotify",
  "requireInteraction",
  "timestamp",
  "lang",
  "dir",
  "vibrate",
]);

// The page/worker is untrusted. Rebuild the record from an allowlist instead
// of accepting arbitrary strings or object keys through the logging bridge.
export function sanitizeNativeProbeEvent(
  raw: unknown,
): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.event !== "string" || !EVENTS.has(value.event)) return null;
  const out: Record<string, unknown> = { event: value.event };
  if (
    [
      "AbortError",
      "NotAllowedError",
      "NotSupportedError",
      "InvalidStateError",
      "TypeError",
      "SecurityError",
      "UnknownError",
      "other",
    ].includes(String(value.errorKind))
  )
    out.errorKind = value.errorKind;
  for (const key of NUMBERS) {
    if (typeof value[key] === "number" && Number.isFinite(value[key]))
      out[key] = value[key];
  }
  for (const key of FLAGS) {
    if (typeof value[key] === "boolean") out[key] = value[key];
  }
  if (
    typeof value.tagHash === "string" &&
    /^[a-z0-9]{1,16}$/.test(value.tagHash)
  )
    out.tagHash = value.tagHash;
  if (
    typeof value.threadHash === "string" &&
    /^[a-z0-9]{1,16}$/.test(value.threadHash)
  )
    out.threadHash = value.threadHash;
  if (["default", "granted", "denied"].includes(String(value.permission)))
    out.permission = value.permission;
  if (["visible", "hidden"].includes(String(value.visibility)))
    out.visibility = value.visibility;
  if (["none", "data", "fbcdn", "other"].includes(String(value.iconKind)))
    out.iconKind = value.iconKind;
  if (Array.isArray(value.optionKeys))
    out.optionKeys = value.optionKeys
      .filter((k) => typeof k === "string" && OPTION_KEYS.has(k))
      .slice(0, 16);
  if (Array.isArray(value.dataThreadPaths))
    out.dataThreadPaths = value.dataThreadPaths
      .filter(
        (p) =>
          typeof p === "string" &&
          /^\$(?:\.(?:url|href|threadId|thread_id|conversationId|conversation_id|id|data|payload|notification)|\[\d\]){0,5}$/.test(
            p,
          ),
      )
      .slice(0, 20);
  if (Array.isArray(value.dataTypes))
    out.dataTypes = value.dataTypes
      .filter((t) =>
        [
          "string",
          "number",
          "boolean",
          "object",
          "undefined",
          "null",
          "array",
        ].includes(String(t)),
      )
      .slice(0, 20);
  return out;
}

export function installNativeNotificationProbe(
  ses: Session,
  options: {
    preloadPath: string;
    salt: string;
    isTrustedUrl: (url: string) => boolean;
    isContentWebContents: (wc: WebContents) => boolean;
    webContents: WebContents;
    record: (record: Record<string, unknown>) => void;
  },
): Promise<void> {
  const existing = installed.get(options.webContents);
  if (existing) return existing;
  const trusted = (url: string) => {
    try {
      return options.isTrustedUrl(url);
    } catch {
      return false;
    }
  };
  const append = (raw: unknown, context: "frame" | "service-worker") => {
    const record = sanitizeNativeProbeEvent(raw);
    if (record)
      options.record({
        ...record,
        context,
        receivedAt: Date.now(),
      });
  };
  const isContentFrame = (event: Electron.IpcMainEvent) =>
    event.sender.session === ses &&
    options.isContentWebContents(event.sender) &&
    event.senderFrame === event.sender.mainFrame &&
    trusted(event.senderFrame?.url || "");
  const onConfig = (event: Electron.IpcMainEvent) => {
    if (event.sender.session !== ses) return;
    event.returnValue = isContentFrame(event)
      ? { salt: options.salt, context: "frame" }
      : null;
  };
  const onEvent = (event: Electron.IpcMainEvent, raw: unknown) => {
    if (isContentFrame(event)) append(raw, "frame");
  };
  ipcMain.on(CONFIG_CHANNEL, onConfig);
  ipcMain.on(EVENT_CHANNEL, onEvent);
  // Service-worker preloads do not run in unsandboxed renderer processes.
  // CDP auto-attachment pauses related workers before their first script runs.
  const debuggerApi = options.webContents.debugger;
  const binding = "__mdNativeProbeRecord";
  const sessions = new Set<string>();
  const workerContexts = new Map<string, Set<number>>();
  let ownsDebugger = false;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const send = (
    method: string,
    params: Record<string, unknown>,
    id?: string,
  ) => {
    let command: Promise<Record<string, unknown>>;
    try {
      command = debuggerApi.sendCommand(method, params, id);
    } catch (error) {
      return Promise.reject(error);
    }
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("probe-command-timeout")),
        2000,
      );
      command.then(
        (result) => {
          clearTimeout(timeout);
          resolve(result);
        },
        (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      );
    });
  };
  const fail = (stage: string) =>
    options.record({
      event: "worker-capture-failed",
      stage,
      receivedAt: Date.now(),
    });
  const release = (id: string) => {
    const timer = timers.get(id);
    if (timer) clearTimeout(timer);
    timers.delete(id);
    // Do not wait for a failed setup command before releasing worker execution.
    void send("Runtime.runIfWaitingForDebugger", {}, id).catch(() => {});
    void send("Debugger.resume", {}, id).catch(() => {});
  };
  debuggerApi.on("detach", (_event, reason) => {
    ownsDebugger = false;
    for (const id of timers.keys()) release(id);
    options.record({
      event: "worker-capture-detached",
      receivedAt: Date.now(),
      reason: reason === "target closed" ? "target-closed" : "other",
    });
  });
  debuggerApi.on("message", (_event, method, params, sessionId) => {
    if (!ownsDebugger) return;
    if (method === "Target.attachedToTarget") {
      const id = String(params.sessionId);
      const info = params.targetInfo;
      const supported = info.type === "service_worker" && trusted(info.url);
      options.record({
        event: "worker-attached",
        receivedAt: Date.now(),
        supported,
        pausedBeforeScript: Boolean(params.waitingForDebugger),
      });
      timers.set(
        id,
        setTimeout(() => {
          fail("startup-timeout");
          release(id);
        }, 2000),
      );
      void (async () => {
        try {
          if (supported) {
            sessions.add(id);
            workerContexts.set(id, new Set());
            // Queue setup before releasing Chromium's worker-start gate. Domain
            // enable replies cannot arrive while that gate is held.
            const runtime = send("Runtime.enable", {}, id);
            const debugging = send("Debugger.enable", {}, id);
            const breakpoint = send(
              "Debugger.setInstrumentationBreakpoint",
              { instrumentation: "beforeScriptExecution" },
              id,
            );
            const bindingReady = send(
              "Runtime.addBinding",
              { name: binding },
              id,
            );
            const ready = Promise.all([
              runtime,
              debugging,
              breakpoint,
              bindingReady,
            ]);
            void ready.catch(() => {});
            await send("Runtime.runIfWaitingForDebugger", {}, id);
            await ready;
            if (!params.waitingForDebugger) {
              options.record({
                event: "worker-capture-late",
                receivedAt: Date.now(),
              });
              await installWorker(id);
            }
          }
        } catch {
          fail("setup");
          release(id);
        } finally {
          if (!supported || !params.waitingForDebugger) release(id);
        }
      })();
    } else if (method === "Debugger.paused" && sessions.has(sessionId)) {
      if (!timers.has(sessionId))
        timers.set(
          sessionId,
          setTimeout(() => {
            fail("hook-timeout");
            release(sessionId);
          }, 2000),
        );
      void (async () => {
        try {
          await installWorker(sessionId);
        } catch {
          fail("hook-install");
        } finally {
          release(sessionId);
        }
      })();
    } else if (
      method === "Runtime.executionContextCreated" &&
      sessions.has(sessionId)
    ) {
      const context = params.context;
      if (!context.origin || trusted(context.origin))
        workerContexts.get(sessionId)?.add(context.id);
    } else if (
      method === "Runtime.bindingCalled" &&
      sessions.has(sessionId) &&
      params.name === binding
    ) {
      if (!workerContexts.get(sessionId)?.has(params.executionContextId))
        return;
      try {
        append(JSON.parse(String(params.payload)), "service-worker");
      } catch {
        /* invalid untrusted payload */
      }
    } else if (method === "Target.detachedFromTarget") {
      release(params.sessionId);
      sessions.delete(params.sessionId);
      workerContexts.delete(params.sessionId);
    }
  });
  const installWorker = async (id: string) => {
    const config = JSON.stringify({
      salt: options.salt,
      context: "service-worker",
    });
    const expression = `(${installHooks.toString()})(${config}, record => globalThis.${binding}(JSON.stringify(record)))`;
    const result = await send("Runtime.evaluate", { expression }, id);
    if (result.exceptionDetails) throw new Error("worker-hook-install-failed");
    await send("Debugger.setBreakpointsActive", { active: false }, id);
  };
  const preloadId = ses.registerPreloadScript({
    type: "frame",
    filePath: options.preloadPath,
  });
  options.webContents.once("destroyed", () => {
    ipcMain.removeListener(CONFIG_CHANNEL, onConfig);
    ipcMain.removeListener(EVENT_CHANNEL, onEvent);
    try {
      ses.unregisterPreloadScript(preloadId);
    } catch {
      /* session already stopped */
    }
    for (const id of timers.keys()) release(id);
  });
  const ready = (async () => {
    try {
      debuggerApi.attach("1.3");
      ownsDebugger = true;
      await send("Target.setAutoAttach", {
        autoAttach: true,
        waitForDebuggerOnStart: true,
        flatten: true,
      });
      options.record({ event: "worker-capture-ready", receivedAt: Date.now() });
    } catch {
      fail("attach");
    }
    options.record({
      event: "native-probe-registered",
      receivedAt: Date.now(),
      nativePresentation: true,
      sidebarShadowOnly: true,
    });
  })();
  installed.set(options.webContents, ready);
  return ready;
}
