// Real Electron page/worker fixtures: no Facebook account or external network.
const { app, BrowserWindow, session } = require("electron");
const http = require("http");
const path = require("path");
const sourceRoot =
  process.env.MD_NATIVE_PROBE_SOURCE_ROOT || path.resolve(__dirname, "../..");
const probeModule = path.join(
  sourceRoot,
  "dist/main/native-notification-probe.js",
);
const { installNativeNotificationProbe } = require(probeModule);

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const server = http.createServer((req, res) => {
    if (req.url === "/dedicated.js") {
      res.setHeader("Content-Type", "application/javascript");
      res.end("postMessage('dedicated-ready')");
    } else if (req.url === "/frame") {
      res.setHeader("Content-Type", "text/html");
      res.end("<!doctype html><p>Neutral cross-origin frame</p>");
    } else if (req.url === "/sw.js") {
      res.setHeader("Content-Type", "application/javascript");
      res.end(`const show = self.registration.showNotification.bind(self.registration);
        self.addEventListener('install', () => self.skipWaiting());
        self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
        self.addEventListener('message', event => event.waitUntil((async () => { try {
          const result = show('Fixture Worker Name', {body:'Private fixture worker body', tag:'100000000009999', data:{url:'/messages/t/100000000009999/', secret:'Private fixture value'}});
          event.ports[0].postMessage(typeof result.then === 'function' ? 'promise' : 'invalid');
          const items = await self.registration.getNotifications();
          items.forEach(item => item.close());
          await result; } catch (error) {event.ports[0].postMessage('failed: '+error.name);}
        })()));`);
    } else {
      res.setHeader("Content-Type", "text/html");
      const frameOrigin = `http://localhost:${server.address().port}`;
      res.end(`<!doctype html><iframe src="${frameOrigin}/frame"></iframe><script>
        window.dedicatedReady = new Promise(resolve => {
          const worker = new Worker('/dedicated.js');
          worker.onmessage = () => resolve(true);
        });
        window.cachedNotification = Notification;
        window.earlyNotification = new cachedNotification('Fixture Page Name', {body:'Private fixture page body',tag:'100000000009999',data:{url:'/messages/t/100000000009999/',secret:'Private fixture value'}});
        window.earlyNotification.close();
        window.swReady = navigator.serviceWorker.register('/sw.js').then(() => navigator.serviceWorker.ready);
      </script>`);
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const ses = session.fromPartition(`probe-fixture-${Date.now()}`);
  global.probeEvents = [];
  global.fixtureWindow = new BrowserWindow({
    show: false,
    webPreferences: { session: ses, contextIsolation: true, sandbox: false },
  });
  await installNativeNotificationProbe(ses, {
    preloadPath: path.resolve(
      sourceRoot,
      "dist/preload/native-notification-probe-preload.js",
    ),
    salt: "fixture-salt",
    webContents: global.fixtureWindow.webContents,
    isTrustedUrl: (url) => new URL(url).origin === origin,
    isContentWebContents: (wc) => wc === global.fixtureWindow?.webContents,
    record: (record) => global.probeEvents.push(record),
  });
  ses.setPermissionRequestHandler((_wc, _permission, callback) =>
    callback(true),
  );
  ses.setPermissionCheckHandler(() => true);
  await global.fixtureWindow.loadURL(origin);
  app.on("will-quit", () => server.close());
});
app.on("window-all-closed", () => app.quit());
