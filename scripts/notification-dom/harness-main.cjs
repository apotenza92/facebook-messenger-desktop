// Electron entry for the deterministic notification DOM harness.
// Serves an empty Messenger-shaped page on https://www.facebook.com from
// memory (no network) so the real injected page scripts run against
// fixture sidebars with their production origin and routes.
const { app, BrowserWindow, protocol, session } = require("electron");

const FIXTURE_HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Messenger</title></head>
  <body><div id="mount"></div></body>
</html>`;

app.commandLine.appendSwitch("disable-gpu");
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  await session.defaultSession.clearStorageData();
  protocol.handle("https", (request) => {
    const url = new URL(request.url);
    if (url.hostname === "www.facebook.com") {
      return new Response(FIXTURE_HTML, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    return new Response("", { status: 404 });
  });

  const win = new BrowserWindow({
    show: false,
    width: 1000,
    height: 800,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      // Hidden test windows must keep running timers and observers at
      // full speed, like a backgrounded Messenger window.
      backgroundThrottling: false,
    },
  });
  await win.loadURL("https://www.facebook.com/messages/");
});

app.on("window-all-closed", () => app.quit());
