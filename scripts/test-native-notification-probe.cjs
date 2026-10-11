const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
if (
  process.platform === "linux" &&
  !process.env.DISPLAY &&
  !process.env.MD_HARNESS_UNDER_XVFB
) {
  const result = spawnSync("xvfb-run", ["-a", process.execPath, __filename], {
    stdio: "inherit",
    env: { ...process.env, MD_HARNESS_UNDER_XVFB: "1" },
  });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}
const { _electron: electron } = require("playwright");
(async () => {
  const main = path.join(__dirname, "notification-dom/native-probe-main.cjs");
  const app = await electron.launch({
    args: process.platform === "linux" ? ["--no-sandbox", main] : [main],
    timeout: 15000,
  });
  try {
    const page = await app.firstWindow();
    page.on("pageerror", (error) => console.error("[Fixture]", error.message));
    page.on("console", (message) => {
      if (message.type() === "error")
        console.error("[Fixture]", message.text());
    });
    await page.waitForLoadState("load", { timeout: 5000 });
    assert(
      await page.evaluate(() => window.dedicatedReady),
      "unrelated dedicated worker must start",
    );
    await page.waitForTimeout(150);
    const initialEvents = await app.evaluate(() => global.probeEvents);
    assert.equal(
      initialEvents.filter(
        (r) => r.event === "native-constructed" && r.context === "frame",
      ).length,
      1,
      "must capture notification before DOMContentLoaded",
    );
    const installedConstructor = await page.evaluate(() => {
      window.fixtureNativeConstructor = Notification;
      window.fixtureNativeShow =
        ServiceWorkerRegistration.prototype.showNotification;
      return Notification.permission;
    });
    assert.equal(installedConstructor, "granted");
    await page.addScriptTag({
      path: path.resolve(__dirname, "../dist/preload/notifications-inject.js"),
    });
    assert(
      await page.evaluate(
        () =>
          Notification === window.fixtureNativeConstructor &&
          ServiceWorkerRegistration.prototype.showNotification ===
            window.fixtureNativeShow,
      ),
      "late sidebar injection must preserve the real native APIs",
    );
    await page.evaluate(async () => {
      const registration = await Promise.race([
        window.swReady,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("worker startup timed out")), 5000),
        ),
      ]);
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("worker notification call timed out")),
          5000,
        );
        const channel = new MessageChannel();
        channel.port1.onmessage = (event) => {
          clearTimeout(timeout);
          if (event.data === "promise") resolve();
          else reject(new Error(event.data));
        };
        registration.active.postMessage("notify", [channel.port2]);
      });
      const later = new window.cachedNotification("Fixture Cached Name", {
        body: "Private cached body",
      });
      later.close();
    });
    await page.waitForTimeout(300);
    const events = await app.evaluate(() => global.probeEvents);
    const by = (event, context) =>
      events.filter((r) => r.event === event && r.context === context);

    assert.equal(
      by("native-constructed", "frame").length,
      2,
      "capture parser-time and cached constructor calls",
    );
    assert.equal(
      by("native-closed", "frame").length,
      2,
      "capture real close calls",
    );
    assert.equal(
      by("service-worker-show", "service-worker").length,
      1,
      "capture calls inside actual worker",
    );
    assert.equal(by("native-hooks-ready", "frame").length, 1);
    assert.equal(by("native-hooks-ready", "service-worker").length, 1);
    const pageEvent = by("native-constructed", "frame")[0];
    const workerEvent = by("service-worker-show", "service-worker")[0];
    assert.equal(
      pageEvent.threadHash,
      workerEvent.threadHash,
      "same app-run salt across contexts",
    );
    assert.equal(pageEvent.tagHasThreadId, true);
    assert.deepEqual(workerEvent.dataThreadPaths, ["$.url"]);
    assert.equal(
      events.filter((r) => r.event === "worker-capture-failed").length,
      0,
      "worker setup must complete without fallback",
    );
    // Reject injected arbitrary content at the main-process bridge.
    await page.evaluate(() => {
      const subscription = navigator.serviceWorker.ready.then((r) =>
        r.pushManager.getSubscription(),
      );
      window.fixturePushRead = subscription;
    });
    await page.evaluate(() => window.fixturePushRead);
    assert(
      (await app.evaluate(() => global.probeEvents)).some(
        (r) => r.event === "push-getSubscription-result",
      ),
      "record push subscription availability",
    );
    const serialized = JSON.stringify(
      await app.evaluate(() => global.probeEvents),
    );
    for (const secret of [
      "Fixture Page Name",
      "Fixture Worker Name",
      "Private",
      "100000000009999",
      "/messages/t/",
      "127.0.0.1",
    ])
      assert(!serialized.includes(secret), `must not export ${secret}`);
    console.log(
      "[NativeNotificationProbe] Parser-time, cached API, real worker and privacy checks passed",
    );
  } catch (error) {
    console.log(
      "[Fixture failure events]",
      JSON.stringify(await app.evaluate(() => global.probeEvents)),
    );
    throw error;
  } finally {
    await app.close();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
