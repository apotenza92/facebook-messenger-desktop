const { _electron: electron } = require('playwright');
const path = require('path');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function withPrimaryWebContents(electronApp, callback, payload) {
  return electronApp.evaluate(async ({ BrowserWindow }, { callbackSource, payload }) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) throw new Error('No main window available');

    const views = win.getBrowserViews();
    const wc = views.length > 0 ? views[0].webContents : win.webContents;
    const callbackFn = eval(`(${callbackSource})`);
    return callbackFn(wc, payload);
  }, {
    callbackSource: callback.toString(),
    payload,
  });
}

async function loadFacebookMessagesSurface(electronApp) {
  return withPrimaryWebContents(
    electronApp,
    async (wc) => {
      try {
        await wc.loadURL('https://www.facebook.com/messages/');
      } catch {
        await wc.loadURL('https://www.facebook.com/');
      }
      return wc.getURL();
    },
    null,
  );
}

async function runViewportScenario(electronApp, scenario) {
  return withPrimaryWebContents(
    electronApp,
    async (wc, input) => {
      const script = `
        (() => {
          const input = ${JSON.stringify(input)};
          const ACTIVE_CLASS = 'md-fb-messages-viewport-fix';
          const MEDIA_CLEAN_CLASS = 'md-fb-media-viewer-clean';
          const root = document.documentElement;

          history.replaceState({}, '', input.pathname);

          window.postMessage(
            {
              type: 'md-force-media-overlay-visible',
              visible: input.overlayVisible ? true : false,
            },
            '*',
          );

          window.dispatchEvent(new Event('resize'));

          return new Promise((resolve) => {
            setTimeout(() => {
              resolve({
                pathname: window.location.pathname,
                activeCrop: root.classList.contains(ACTIVE_CLASS),
                mediaClean: root.classList.contains(MEDIA_CLEAN_CLASS),
              });
            }, 350);
          });
        })();
      `;

      return wc.executeJavaScript(script, true);
    },
    scenario,
  );
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function run() {
  console.log('\n🧪 GUI regression test for issue #45 (E2EE vs non-E2EE media overlay)\n');

  const electronApp = await electron.launch({
    args: [path.join(__dirname, '../dist/main/main.js')],
    env: {
      ...process.env,
      NODE_ENV: 'development',
    },
  });

  try {
    await wait(4000);

    const loadedUrl = await loadFacebookMessagesSurface(electronApp);
    console.log('Loaded surface:', loadedUrl);

    const chatOnlyE2EE = await runViewportScenario(electronApp, {
      pathname: '/messages/e2ee/t/e2ee-chat',
      overlayVisible: false,
    });

    const legacyOverlay = await runViewportScenario(electronApp, {
      pathname: '/messages/t/legacy-chat',
      overlayVisible: true,
    });

    const e2eeOverlay = await runViewportScenario(electronApp, {
      pathname: '/messages/e2ee/t/e2ee-chat',
      overlayVisible: true,
    });

    console.log('Chat-only E2EE state:', chatOnlyE2EE);
    console.log('Legacy overlay state:', legacyOverlay);
    console.log('E2EE overlay state:', e2eeOverlay);

    assert(
      chatOnlyE2EE.activeCrop === true && chatOnlyE2EE.mediaClean === false,
      'Expected E2EE chat route without overlay to keep crop on and media-clean off',
    );

    assert(
      legacyOverlay.activeCrop === false && legacyOverlay.mediaClean === true,
      'Expected legacy chat media overlay to disable crop and enable media-clean',
    );

    assert(
      e2eeOverlay.activeCrop === false && e2eeOverlay.mediaClean === true,
      'Expected E2EE media overlay to disable crop and enable media-clean',
    );

    assert(
      legacyOverlay.activeCrop === e2eeOverlay.activeCrop &&
        legacyOverlay.mediaClean === e2eeOverlay.mediaClean,
      'Expected legacy and E2EE media overlays to produce identical viewport state',
    );

    console.log('\nPASS issue #45 GUI overlay parity test');
  } finally {
    await electronApp.close().catch(() => {});
  }
}

run().catch((error) => {
  console.error('\nFAIL issue #45 GUI overlay parity test:', error.message || error);
  process.exit(1);
});
