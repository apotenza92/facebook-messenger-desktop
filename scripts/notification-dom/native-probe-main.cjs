// Real Electron page/worker fixtures: no Facebook account or external network.
const { app, BrowserWindow, session } = require("electron");
const http = require("http");
const path = require("path");
const { createHash } = require("node:crypto");
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
    if (req.url.startsWith("/api/graphql")) {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          data: {
            notification: {
              thread_id: "100000000009999",
              body: "Private network message",
              is_unread: true,
            },
          },
          secret: "Private token",
        }),
      );
    } else if (req.url === "/dedicated.js") {
      res.setHeader("Content-Type", "application/javascript");
      res.end(`fetch('/api/graphql').then(r=>r.json());
        setTimeout(() => { const socket = new WebSocket(location.origin.replace('http:','ws:')+'/mqtt');
        let received=0; socket.onmessage=()=>{if(++received===2){socket.close();postMessage('dedicated-ready');}};
        socket.onerror=()=>postMessage('dedicated-failed');},300);`);
    } else if (req.url === "/frame") {
      res.setHeader("Content-Type", "text/html");
      res.end("<!doctype html><p>Neutral cross-origin frame</p>");
    } else if (req.url === "/sw.js") {
      res.setHeader("Content-Type", "application/javascript");
      res.end(`const show = self.registration.showNotification.bind(self.registration);
        self.addEventListener('install', () => self.skipWaiting());
        self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
        self.addEventListener('message', event => event.waitUntil((async () => { try {
          await fetch('/api/graphql?private=PrivateQuery');
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
        window.networkReady = (async () => {
          await fetch('/api/graphql?private=PrivateQuery', {method:'POST',body:JSON.stringify({variables:{thread_id:'100000000009999',body:'Private request body'}})}).then(r => r.json());
          await new Promise(resolve => {
            const socket = new WebSocket(location.origin.replace('http:','ws:')+'/mqtt?token=PrivateToken');
            let received = 0;
            socket.onopen = () => socket.send(JSON.stringify({thread_id:'100000000009999',body:'Private outgoing body'}));
            socket.onmessage = () => {if (++received === 2) {socket.close(); resolve();}};
          });
        })();
        window.cachedNotification = Notification;
        window.earlyNotification = new cachedNotification('Fixture Page Name', {body:'Private fixture page body',tag:'100000000009999',data:{url:'/messages/t/100000000009999/',secret:'Private fixture value'}});
        window.earlyNotification.close();
        window.swReady = navigator.serviceWorker.register('/sw.js').then(() => navigator.serviceWorker.ready);
      </script>`);
    }
  });
  const connections = new Set();
  server.on("connection", (socket) => {
    connections.add(socket);
    socket.on("close", () => connections.delete(socket));
  });
  server.on("upgrade", (req, socket) => {
    const accept = createHash("sha1")
      .update(
        req.headers["sec-websocket-key"] +
          "258EAFA5-E914-47DA-95CA-C5AB0DC85B11",
      )
      .digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " +
        accept +
        "\r\n\r\n",
    );
    const send = (opcode, body) => {
      const header = Buffer.alloc(body.length < 126 ? 2 : 4);
      header[0] = 0x80 | opcode;
      header[1] = body.length < 126 ? body.length : 126;
      if (body.length >= 126) header.writeUInt16BE(body.length, 2);
      socket.write(Buffer.concat([header, body]));
    };
    send(
      1,
      Buffer.from(
        JSON.stringify({
          notification: {
            thread_id: "100000000009999",
            body: "Private socket message",
          },
        }),
      ),
    );
    const topic = Buffer.from("/ls_resp");
    const payload = Buffer.from(
      JSON.stringify({
        payload: JSON.stringify({
          thread_id: "100000000009999",
          is_unread: true,
          body: "Private MQTT body",
        }),
      }),
    );
    const remaining = 2 + topic.length + payload.length;
    const length = [];
    let n = remaining;
    do {
      let digit = n % 128;
      n = Math.floor(n / 128);
      length.push(digit | (n ? 128 : 0));
    } while (n);
    const topicLength = Buffer.alloc(2);
    topicLength.writeUInt16BE(topic.length);
    send(
      2,
      Buffer.concat([
        Buffer.from([0x30, ...length]),
        topicLength,
        topic,
        payload,
      ]),
    );
    socket.on("data", (data) => {
      if ((data[0] & 15) === 8) {
        socket.end(Buffer.from([0x88, 0]));
      }
    });
    socket.on("error", () => {});
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
  app.on("will-quit", () => {
    for (const socket of connections) socket.destroy();
    server.close();
  });
});
app.on("window-all-closed", () => app.quit());
