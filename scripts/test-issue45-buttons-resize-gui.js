const { _electron: electron } = require('playwright');
const path = require('path');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function withPrimaryWebContents(electronApp, fn, payload) {
  return electronApp.evaluate(
    async ({ BrowserWindow }, { fnSource, payload }) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (!win) throw new Error('No main window available');
      const views = win.getBrowserViews();
      const wc = views.length > 0 ? views[0].webContents : win.webContents;
      const runner = eval(`(${fnSource})`);
      return runner(wc, payload);
    },
    { fnSource: fn.toString(), payload },
  );
}

async function setWindowSize(electronApp, width, height) {
  return electronApp.evaluate(({ BrowserWindow }, { width, height }) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) throw new Error('No window');
    win.setSize(width, height);
    return win.getContentBounds();
  }, { width, height });
}

async function loadMessages(electronApp) {
  return withPrimaryWebContents(
    electronApp,
    async (wc) => {
      await wc.loadURL('https://www.facebook.com/messages/').catch(async () => {
        await wc.loadURL('https://www.facebook.com/');
      });
      return wc.getURL();
    },
    null,
  );
}

async function setupScenario(electronApp, scenario) {
  return withPrimaryWebContents(
    electronApp,
    async (wc, scenario) => {
      const script = `
        (() => {
          const scenario = ${JSON.stringify(scenario)};

          const old = document.getElementById('md-resize-test-root');
          if (old) old.remove();
          const oldStyle = document.getElementById('md-resize-test-isolation-style');
          if (oldStyle) oldStyle.remove();

          const isolationStyle = document.createElement('style');
          isolationStyle.id = 'md-resize-test-isolation-style';
          isolationStyle.textContent =
            'body > *:not(#md-resize-test-root) { display: none !important; }';
          document.head.appendChild(isolationStyle);

          const root = document.createElement('div');
          root.id = 'md-resize-test-root';
          root.style.position = 'fixed';
          root.style.inset = '0';
          root.style.zIndex = '2147483630';
          root.style.pointerEvents = 'none';
          document.body.appendChild(root);

          const banner = document.createElement('div');
          banner.setAttribute('role', 'banner');
          banner.style.position = 'fixed';
          banner.style.left = '0';
          banner.style.right = '0';
          banner.style.top = '0';
          banner.style.height = '56px';
          banner.style.pointerEvents = 'none';
          root.appendChild(banner);

          const makeButton = (label, side, offset) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.setAttribute('aria-label', label);
            btn.setAttribute('role', 'button');
            btn.textContent = label[0];
            btn.style.position = 'fixed';
            btn.style.top = '22px';
            btn.style.width = '30px';
            btn.style.height = '30px';
            btn.style.zIndex = '2147483631';
            btn.style.pointerEvents = 'auto';
            if (side === 'left') btn.style.left = String(offset) + 'px';
            else btn.style.right = String(offset) + 'px';
            root.appendChild(btn);
            return btn;
          };

          const closeSide = scenario.closePosition === 'left' ? 'left' : 'right';
          const closeNode = makeButton('Close', closeSide, scenario.closePosition === 'left' ? 140 : 180);
          let downloadNode = null;
          let shareNode = null;
          if (scenario.includeActions) {
            downloadNode = makeButton('Download', 'right', 250);
            shareNode = makeButton('Share', 'right', 320);
          }

          window.postMessage({ type: 'md-force-media-overlay-visible', visible: true }, '*');
          window.dispatchEvent(new Event('resize'));

          return true;
        })();
      `;
      return wc.executeJavaScript(script, true);
    },
    scenario,
  );
}

async function readScenarioMetrics(electronApp) {
  return withPrimaryWebContents(
    electronApp,
    async (wc) => {
      const script = `
        (() => {
          const host = document.getElementById('md-resize-test-root');
          const find = (sel) => {
            const node = host ? host.querySelector(sel) : null;
            if (!(node instanceof HTMLElement)) return null;
            const rect = node.getBoundingClientRect();
            return {
              left: Math.round(rect.left),
              right: Math.round(rect.right),
              top: Math.round(rect.top),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
            };
          };

          const closeRect = find('[aria-label="Close" i]');
          const downloadRect = find('[aria-label*="Download" i], [aria-label*="Save" i]');
          const shareRect = find('[aria-label*="Share" i], [aria-label*="Forward" i]');

          const rightGap = (rect) => (rect ? Math.round(window.innerWidth - rect.right) : null);

          return {
            viewport: {
              width: window.innerWidth,
              height: window.innerHeight,
              scrollbarWidth:
                window.innerWidth - document.documentElement.clientWidth,
            },
            classes: {
              mediaClean: document.documentElement.classList.contains('md-fb-media-viewer-clean'),
              activeCrop: document.documentElement.classList.contains('md-fb-messages-viewport-fix'),
              leftDismiss: document.documentElement.classList.contains('md-fb-media-dismiss-left'),
            },
            closeRect,
            downloadRect,
            shareRect,
            gaps: {
              closeLeft: closeRect ? closeRect.left : null,
              closeRight: rightGap(closeRect),
              downloadRight: rightGap(downloadRect),
              shareRight: rightGap(shareRect),
            },
          };
        })();
      `;
      return wc.executeJavaScript(script, true);
    },
    null,
  );
}

async function cleanupScenario(electronApp) {
  return withPrimaryWebContents(
    electronApp,
    async (wc) => {
      const script = `
        (() => {
          window.postMessage({ type: 'md-force-media-overlay-visible', visible: false }, '*');
          const root = document.getElementById('md-resize-test-root');
          if (root) root.remove();
          const style = document.getElementById('md-resize-test-isolation-style');
          if (style) style.remove();
          return true;
        })();
      `;
      return wc.executeJavaScript(script, true);
    },
    null,
  );
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function within(value, expected, tolerance = 5) {
  return typeof value === 'number' && Math.abs(value - expected) <= tolerance;
}

async function run() {
  console.log('\n🧪 GUI media button pinning + resize test (#45)\n');

  const electronApp = await electron.launch({
    args: [path.join(__dirname, '../dist/main/main.js')],
    env: { ...process.env, NODE_ENV: 'development' },
  });

  try {
    await wait(4200);
    const loaded = await loadMessages(electronApp);
    console.log('Loaded:', loaded);

    const scenarios = [
      { name: 'right-with-actions', closePosition: 'right', includeActions: true },
      { name: 'left-with-actions', closePosition: 'left', includeActions: true },
      { name: 'right-only', closePosition: 'right', includeActions: false },
      { name: 'left-only', closePosition: 'left', includeActions: false },
    ];

    for (const scenario of scenarios) {
      await cleanupScenario(electronApp);
      await setupScenario(electronApp, scenario);
      await wait(700);

      await setWindowSize(electronApp, 1180, 860);
      await wait(500);
      const before = await readScenarioMetrics(electronApp);

      await setWindowSize(electronApp, 860, 640);
      await wait(600);
      const after = await readScenarioMetrics(electronApp);

      console.log(`\n${scenario.name} before resize:`, before.gaps, before.classes);
      console.log(`${scenario.name} after resize:`, after.gaps, after.classes);

      assert(before.classes.mediaClean === true, `${scenario.name}: mediaClean should be true (before)`);
      assert(after.classes.mediaClean === true, `${scenario.name}: mediaClean should be true (after)`);
      assert(before.classes.activeCrop === false, `${scenario.name}: crop should be off (before)`);
      assert(after.classes.activeCrop === false, `${scenario.name}: crop should be off (after)`);

      const beforeIsLeftLayout = before.classes.leftDismiss === true;
      const afterIsLeftLayout = after.classes.leftDismiss === true;
      const expectedBeforeDownloadRight = beforeIsLeftLayout
        ? before.gaps.closeLeft
        : before.gaps.closeRight + 48;
      const expectedAfterDownloadRight = afterIsLeftLayout
        ? after.gaps.closeLeft
        : after.gaps.closeRight + 48;
      const expectedBeforeShareRight = beforeIsLeftLayout
        ? before.gaps.closeLeft + 48
        : before.gaps.closeRight + 96;
      const expectedAfterShareRight = afterIsLeftLayout
        ? after.gaps.closeLeft + 48
        : after.gaps.closeRight + 96;

      if (scenario.closePosition === 'left') {
        assert(before.classes.leftDismiss === true, `${scenario.name}: expected leftDismiss before`);
        assert(after.classes.leftDismiss === true, `${scenario.name}: expected leftDismiss after`);
        assert(
          within(after.gaps.closeLeft, before.gaps.closeLeft),
          `${scenario.name}: close left gap shifted on resize (${before.gaps.closeLeft} -> ${after.gaps.closeLeft})`,
        );
      } else {
        assert(before.classes.leftDismiss === false, `${scenario.name}: expected right dismiss before`);
        assert(after.classes.leftDismiss === false, `${scenario.name}: expected right dismiss after`);
        assert(
          within(after.gaps.closeRight, before.gaps.closeRight),
          `${scenario.name}: close right gap shifted on resize (${before.gaps.closeRight} -> ${after.gaps.closeRight})`,
        );
      }

      if (scenario.includeActions) {
        assert(
          within(before.gaps.downloadRight, expectedBeforeDownloadRight),
          `${scenario.name}: download not pinned before (${before.gaps.downloadRight}) expected ${expectedBeforeDownloadRight}`,
        );
        assert(
          within(after.gaps.downloadRight, expectedAfterDownloadRight),
          `${scenario.name}: download not pinned after (${after.gaps.downloadRight}) expected ${expectedAfterDownloadRight}`,
        );
        assert(
          within(before.gaps.shareRight, expectedBeforeShareRight),
          `${scenario.name}: share not pinned before (${before.gaps.shareRight}) expected ${expectedBeforeShareRight}`,
        );
        assert(
          within(after.gaps.shareRight, expectedAfterShareRight),
          `${scenario.name}: share not pinned after (${after.gaps.shareRight}) expected ${expectedAfterShareRight}`,
        );

        assert(
          before.closeRect && before.downloadRect && before.shareRect,
          `${scenario.name}: expected close/download/share rects before resize`,
        );
        assert(
          after.closeRect && after.downloadRect && after.shareRect,
          `${scenario.name}: expected close/download/share rects after resize`,
        );

        assert(
          within(before.downloadRect.top, before.closeRect.top),
          `${scenario.name}: download top misaligned before (${before.downloadRect.top} vs close ${before.closeRect.top})`,
        );
        assert(
          within(before.shareRect.top, before.closeRect.top),
          `${scenario.name}: share top misaligned before (${before.shareRect.top} vs close ${before.closeRect.top})`,
        );
        assert(
          within(after.downloadRect.top, after.closeRect.top),
          `${scenario.name}: download top misaligned after (${after.downloadRect.top} vs close ${after.closeRect.top})`,
        );
        assert(
          within(after.shareRect.top, after.closeRect.top),
          `${scenario.name}: share top misaligned after (${after.shareRect.top} vs close ${after.closeRect.top})`,
        );
      }
    }

    console.log('\nPASS GUI media button pinning + resize test (#45)');
  } finally {
    await cleanupScenario(electronApp).catch(() => {});
    await electronApp.close().catch(() => {});
  }
}

run().catch((error) => {
  console.error('\nFAIL GUI media button pinning + resize test (#45):', error.message || error);
  process.exit(1);
});
