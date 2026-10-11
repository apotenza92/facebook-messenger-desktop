const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const {
  installHooks,
} = require("../dist/preload/native-notification-probe-hooks");
const source = fs.readFileSync(
  path.join(__dirname, "../dist/main/native-notification-probe.js"),
  "utf8",
);
const { EventEmitter } = require("node:events");
const ipcMain = new EventEmitter();
const exportsStub = {};
vm.runInNewContext(source, {
  exports: exportsStub,
  require: (name) =>
    name === "electron"
      ? { ipcMain }
      : name.includes("notification-network-probe")
        ? require("../dist/main/notification-network-probe")
        : require("../dist/preload/native-notification-probe-hooks"),
  Set,
  Map,
  WeakMap,
  setTimeout,
  clearTimeout,
  Date,
});
const { sanitizeNativeProbeEvent } = exportsStub;
(async () => {
  const controllerEvents = [],
    commands = [];
  const debuggerApi = new EventEmitter();
  debuggerApi.attach = () => {};
  debuggerApi.sendCommand = (method, params, session) => {
    commands.push({ method, session });
    // Simulate Chromium refusing to reply to worker Runtime.enable.
    if (method === "Runtime.enable") return new Promise(() => {});
    return Promise.resolve({});
  };
  let unregistered = false;
  const ses = {
    registerPreloadScript: () => "fixture-preload",
    unregisterPreloadScript: () => {
      unregistered = true;
    },
  };
  const wc = new EventEmitter();
  Object.assign(wc, {
    debugger: debuggerApi,
    session: ses,
    mainFrame: { url: "https://fixture.invalid/" },
  });
  await exportsStub.installNativeNotificationProbe(ses, {
    webContents: wc,
    preloadPath: "fixture",
    salt: "fixture",
    isTrustedUrl: (url) => url.startsWith("https://fixture.invalid/"),
    isContentWebContents: (value) => value === wc,
    record: (r) => controllerEvents.push(r),
  });
  const denied = {
    sender: wc,
    senderFrame: { url: "https://untrusted.invalid/" },
  };
  ipcMain.emit("native-notification-probe-config", denied);
  assert.equal(denied.returnValue, null, "reject unrelated frames");
  ipcMain.emit("native-notification-probe-event", denied, {
    event: "native-constructed",
  });
  assert(!controllerEvents.some((r) => r.event === "native-constructed"));
  const accepted = { sender: wc, senderFrame: wc.mainFrame };
  ipcMain.emit("native-notification-probe-event", accepted, {
    event: "native-constructed",
    title: "Private title",
    titleLength: 3,
  });
  assert.equal(
    controllerEvents.find((r) => r.event === "native-constructed").title,
    undefined,
  );
  debuggerApi.emit(
    "message",
    {},
    "Target.attachedToTarget",
    {
      sessionId: "fixture-worker",
      waitingForDebugger: true,
      targetInfo: {
        type: "service_worker",
        url: "https://fixture.invalid/sw.js",
      },
    },
    "",
  );
  await new Promise((resolve) => setTimeout(resolve, 2150));
  assert(
    controllerEvents.some((r) => r.event === "worker-capture-failed"),
    "surface stalled capture",
  );
  assert(
    commands.some(
      (c) => c.method === "Debugger.resume" && c.session === "fixture-worker",
    ),
    "release stalled worker",
  );
  debuggerApi.emit(
    "message",
    {},
    "Target.attachedToTarget",
    {
      sessionId: "untrusted-worker",
      waitingForDebugger: true,
      targetInfo: {
        type: "service_worker",
        url: "https://untrusted.invalid/sw.js",
      },
    },
    "",
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert(
    !commands.some(
      (c) => c.method === "Runtime.enable" && c.session === "untrusted-worker",
    ),
    "never instrument untrusted workers",
  );
  assert(
    commands.some(
      (c) =>
        c.method === "Runtime.runIfWaitingForDebugger" &&
        c.session === "untrusted-worker",
    ),
    "release excluded worker",
  );
  wc.emit("destroyed");
  assert(unregistered);
  assert.equal(
    ipcMain.listenerCount("native-notification-probe-event"),
    0,
    "clean up bridges",
  );
  const events = [];
  const intervals = [];
  class Native extends EventTarget {
    static permission = "granted";
    static requestPermission(callback) {
      callback?.("granted");
      return Promise.resolve("granted");
    }
    constructor(title, options) {
      super();
      if (title === "reject") throw rejection;
      this.title = title;
      Object.assign(this, options);
    }
    close() {
      this.closed = true;
      return "native-close-result";
    }
  }
  const rejection = new Error("fixture rejection with private text");
  const item = new Native("Private title", { tag: "100000000009999" });
  class Registration {
    showNotification(title, options) {
      if (title === "reject") return Promise.reject(rejection);
      this.last = { title, options };
      return Promise.resolve();
    }
    getNotifications() {
      return Promise.resolve([item]);
    }
  }
  class PushManager {
    subscribe() {
      return Promise.reject(rejection);
    }
    getSubscription() {
      return Promise.resolve({
        endpoint: "Private endpoint",
        keys: "Private keys",
      });
    }
    permissionState() {
      return Promise.resolve("granted");
    }
  }
  const workerListeners = {};
  const root = {
    Notification: Native,
    ServiceWorkerRegistration: Registration,
    PushManager,
    EventTarget,
    navigator: { onLine: true },
    location: { href: "https://fixture.invalid" },
    URL,
    Date,
    Math,
    WeakMap,
    WeakSet,
    Set,
    Proxy,
    Reflect,
    setInterval: (fn) => intervals.push(fn),
    addEventListener: (name, fn) => (workerListeners[name] = fn),
    report: (r) => events.push(sanitizeNativeProbeEvent(r)),
  };
  vm.runInNewContext(
    `(${installHooks.toString()})({salt:'fixture',context:'service-worker'},report)`,
    root,
  );
  const native = new root.Notification("Private title", {
    body: "Private body",
    tag: "100000000009999",
    data: { url: "/t/100000000009999/", unexpected: "Private data" },
  });
  assert(native instanceof Native);
  assert.throws(
    () => new root.Notification("reject"),
    (e) => e === rejection,
  );
  assert(
    events.some((r) => r.event === "native-construction-failed"),
    "capture synchronous constructor failure",
  );
  assert.equal(native.close(), "native-close-result");
  let callbackResult;
  assert.equal(
    await root.Notification.requestPermission((p) => (callbackResult = p)),
    "granted",
  );
  assert.equal(callbackResult, "granted");
  const registration = new Registration();
  const options = { body: "Private body" };
  await registration.showNotification("allowed", options);
  assert.equal(
    registration.last.options,
    options,
    "original options must be forwarded unchanged",
  );
  await assert.rejects(
    registration.showNotification("reject"),
    (e) => e === rejection,
  );
  assert.equal(
    (await registration.getNotifications())[0],
    item,
    "native objects must be returned unchanged",
  );
  await assert.rejects(new PushManager().subscribe(), (e) => e === rejection);
  assert.equal(
    (await new PushManager().getSubscription()).endpoint,
    "Private endpoint",
  );
  await new PushManager().permissionState();
  workerListeners.push({
    data: {
      text: () => {
        throw new Error("must not read push payload");
      },
    },
  });
  workerListeners.notificationclick({ notification: native });
  intervals[0]();
  root.Notification = Native;
  intervals[0]();
  assert(
    events.some(
      (r) => r.event === "native-hooks-health" && r.constructorHook === false,
    ),
    "detect overwritten hook",
  );
  assert(events.some((r) => r.event === "service-worker-show-rejected"));
  assert(events.some((r) => r.event === "push-subscribe-rejected"));
  assert(events.some((r) => r.event === "worker-push" && r.dataPresent));
  assert(!JSON.stringify(events).includes("Private"));
  assert(!JSON.stringify(events).includes("100000000009999"));
  assert.equal(sanitizeNativeProbeEvent({ event: "arbitrary" }), null);
  assert.deepEqual(
    JSON.parse(
      JSON.stringify(
        sanitizeNativeProbeEvent({
          event: "native-constructed",
          title: "Private",
          threadHash: "Private value",
          optionKeys: ["body", "Private"],
          dataThreadPaths: ["$.url", "$.Private"],
          pageTime: Infinity,
        }),
      ),
    ),
    {
      event: "native-constructed",
      optionKeys: ["body"],
      dataThreadPaths: ["$.url"],
    },
  );
  console.log(
    "[NativeNotificationHooks] Native return values, rejection identity, lifecycle, health and allowlist privacy passed",
  );
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
