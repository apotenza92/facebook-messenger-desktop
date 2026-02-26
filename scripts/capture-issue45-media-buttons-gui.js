const { _electron: electron } = require('playwright');
const path = require('path');
const fs = require('fs');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

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

async function captureMainWindow(electronApp, outputPath) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const winPage = await electronApp.firstWindow();
  await winPage.screenshot({ path: outputPath });
  return outputPath;
}

async function loadMessagesSurface(electronApp) {
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

async function applyScenario(electronApp, scenario) {
  return withPrimaryWebContents(
    electronApp,
    async (wc, input) => {
      const script = `
        (() => {
          const scenario = ${JSON.stringify(input)};
          const ACTIVE = 'md-fb-messages-viewport-fix';
          const CLEAN = 'md-fb-media-viewer-clean';
          const LEFT = 'md-fb-media-dismiss-left';

          const oldHost = document.getElementById('md-test-overlay-root');
          if (oldHost) oldHost.remove();
          const oldStyle = document.getElementById('md-test-overlay-isolation-style');
          if (oldStyle) oldStyle.remove();

          const isolationStyle = document.createElement('style');
          isolationStyle.id = 'md-test-overlay-isolation-style';
          isolationStyle.textContent = 'body > *:not(#md-test-overlay-root) { display: none !important; }';
          document.head.appendChild(isolationStyle);

          history.replaceState({}, '', '/messages/t/gui-media-buttons-capture');

          const host = document.createElement('div');
          host.id = 'md-test-overlay-root';
          host.style.position = 'fixed';
          host.style.inset = '0';
          host.style.zIndex = '2147483640';
          host.style.pointerEvents = 'none';
          host.style.background = '#0b0b0c';
          document.body.appendChild(host);

          const media = document.createElement('div');
          media.style.position = 'fixed';
          media.style.left = '50%';
          media.style.top = '52%';
          media.style.transform = 'translate(-50%, -50%)';
          media.style.width = '560px';
          media.style.height = '420px';
          media.style.background = 'linear-gradient(145deg, #252730, #141821)';
          media.style.border = '1px solid #2f3440';
          media.style.borderRadius = '8px';
          host.appendChild(media);

          const banner = document.createElement('div');
          banner.setAttribute('role', 'banner');
          banner.style.position = 'fixed';
          banner.style.left = '0';
          banner.style.right = '0';
          banner.style.top = '0';
          banner.style.height = '56px';
          banner.style.zIndex = '2147483641';
          banner.style.pointerEvents = 'auto';
          host.appendChild(banner);

          const logo = document.createElement('a');
          logo.href = '/';
          logo.setAttribute('aria-label', 'Facebook');
          logo.textContent = 'f';
          logo.style.position = 'absolute';
          logo.style.left = '16px';
          logo.style.top = '14px';
          logo.style.width = '24px';
          logo.style.height = '24px';
          logo.style.borderRadius = '999px';
          logo.style.background = '#1877f2';
          logo.style.color = '#fff';
          logo.style.display = 'grid';
          logo.style.placeItems = 'center';
          logo.style.fontWeight = '700';
          logo.style.textDecoration = 'none';
          logo.style.pointerEvents = 'auto';
          banner.appendChild(logo);

          const status = document.createElement('div');
          status.id = 'md-test-status';
          status.style.position = 'fixed';
          status.style.left = '16px';
          status.style.bottom = '16px';
          status.style.background = 'rgba(0,0,0,0.7)';
          status.style.color = '#fff';
          status.style.padding = '6px 10px';
          status.style.borderRadius = '6px';
          status.style.font = '12px -apple-system, BlinkMacSystemFont, sans-serif';
          status.style.zIndex = '2147483646';
          status.style.pointerEvents = 'none';
          host.appendChild(status);

          const clickCounts = { close: 0, download: 0, share: 0 };
          const createButton = (key, label, style) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.textContent = label[0];
            btn.setAttribute('aria-label', label);
            btn.setAttribute('role', 'button');
            btn.style.position = 'fixed';
            btn.style.top = '16px';
            btn.style.width = '30px';
            btn.style.height = '30px';
            btn.style.borderRadius = '999px';
            btn.style.border = '1px solid #666';
            btn.style.background = '#18191a';
            btn.style.color = '#fff';
            btn.style.fontSize = '13px';
            btn.style.zIndex = '2147483642';
            btn.style.pointerEvents = 'auto';
            if (style.left) btn.style.left = style.left;
            if (style.right) btn.style.right = style.right;
            btn.addEventListener('click', () => {
              clickCounts[key] += 1;
            });
            host.appendChild(btn);
            return btn;
          };

          const closeBtn =
            scenario.closePosition === 'left'
              ? createButton('close', 'Close', { left: '16px' })
              : createButton('close', 'Close', { right: '16px' });

          let downloadBtn = null;
          let shareBtn = null;
          if (scenario.includeActions) {
            downloadBtn = createButton('download', 'Download', { right: '72px' });
            shareBtn = createButton('share', 'Share', { right: '128px' });
          }

          const hitTest = (btn) => {
            if (!btn) return { ok: true, topLabel: null };
            const rect = btn.getBoundingClientRect();
            const x = rect.left + rect.width / 2;
            const y = rect.top + rect.height / 2;
            const topEl = document.elementFromPoint(x, y);
            const ok = topEl === btn || (topEl instanceof Element && btn.contains(topEl));
            return {
              ok,
              topLabel: topEl instanceof Element ? (topEl.getAttribute('aria-label') || topEl.tagName) : null,
            };
          };

          const clickBtn = (btn) => {
            if (!btn) return;
            const rect = btn.getBoundingClientRect();
            const x = rect.left + rect.width / 2;
            const y = rect.top + rect.height / 2;
            btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
          };

          window.postMessage({ type: 'md-force-media-overlay-visible', visible: true }, '*');
          window.dispatchEvent(new Event('resize'));

          return new Promise((resolve) => {
            setTimeout(() => {
              const closeHit = hitTest(closeBtn);
              const downloadHit = hitTest(downloadBtn);
              const shareHit = hitTest(shareBtn);

              clickBtn(closeBtn);
              if (downloadBtn) clickBtn(downloadBtn);
              if (shareBtn) clickBtn(shareBtn);

              const logoStyle = window.getComputedStyle(logo);
              const classes = {
                activeCrop: document.documentElement.classList.contains(ACTIVE),
                mediaClean: document.documentElement.classList.contains(CLEAN),
                leftDismiss: document.documentElement.classList.contains(LEFT),
              };

              status.textContent =
                scenario.name +
                ' | close:' +
                String(clickCounts.close) +
                ' download:' +
                String(clickCounts.download) +
                ' share:' +
                String(clickCounts.share);

              resolve({
                classes,
                closeHit,
                downloadHit,
                shareHit,
                clickCounts,
                logoVisible:
                  logoStyle.display !== 'none' &&
                  logoStyle.visibility !== 'hidden' &&
                  logoStyle.pointerEvents !== 'none',
              });
            }, 500);
          });
        })();
      `;

      return wc.executeJavaScript(script, true);
    },
    scenario,
  );
}

async function clearScenario(electronApp) {
  return withPrimaryWebContents(
    electronApp,
    async (wc) => {
      const script = `
        (() => {
          window.postMessage({ type: 'md-force-media-overlay-visible', visible: false }, '*');
          const host = document.getElementById('md-test-overlay-root');
          if (host) host.remove();
          const style = document.getElementById('md-test-overlay-isolation-style');
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

async function run() {
  const outDir = path.join(process.cwd(), 'test-screenshots', `issue45-media-buttons-${timestamp()}`);
  fs.mkdirSync(outDir, { recursive: true });

  console.log('\n🧪 Running media-button GUI checks + screenshots\n');
  console.log('Output folder:', outDir);

  const electronApp = await electron.launch({
    args: [path.join(__dirname, '../dist/main/main.js')],
    env: {
      ...process.env,
      NODE_ENV: 'development',
    },
  });

  try {
    await wait(4500);
    const loaded = await loadMessagesSurface(electronApp);
    console.log('Loaded surface:', loaded);

    const scenarios = [
      { name: 'right-with-actions', closePosition: 'right', includeActions: true },
      { name: 'left-with-actions', closePosition: 'left', includeActions: true },
      { name: 'left-only', closePosition: 'left', includeActions: false },
      { name: 'right-only', closePosition: 'right', includeActions: false },
    ];

    for (const scenario of scenarios) {
      const result = await applyScenario(electronApp, scenario);
      console.log(`\n${scenario.name}:`, result);

      assert(result.classes.mediaClean === true, `${scenario.name}: mediaClean should be true`);
      assert(result.classes.activeCrop === false, `${scenario.name}: activeCrop should be false`);
      assert(result.closeHit.ok === true, `${scenario.name}: close hit-test failed (${result.closeHit.topLabel})`);
      assert(result.clickCounts.close >= 1, `${scenario.name}: close click did not fire`);

      if (scenario.includeActions) {
        assert(result.downloadHit.ok === true, `${scenario.name}: download hit-test failed (${result.downloadHit.topLabel})`);
        assert(result.shareHit.ok === true, `${scenario.name}: share hit-test failed (${result.shareHit.topLabel})`);
        assert(result.clickCounts.download >= 1, `${scenario.name}: download click did not fire`);
        assert(result.clickCounts.share >= 1, `${scenario.name}: share click did not fire`);
      }

      if (scenario.closePosition === 'left') {
        assert(result.classes.leftDismiss === true, `${scenario.name}: expected leftDismiss=true`);
        assert(result.logoVisible === false, `${scenario.name}: expected facebook logo hidden`);
      } else {
        assert(result.classes.leftDismiss === false, `${scenario.name}: expected leftDismiss=false`);
      }

      await wait(200);
      const imagePath = path.join(outDir, `${scenario.name}.png`);
      await captureMainWindow(electronApp, imagePath);
      console.log('Saved screenshot:', imagePath);

      await clearScenario(electronApp);
      await wait(250);
    }

    console.log('\nPASS: all media button scenarios validated and screens captured');
    console.log('Screenshot folder:', outDir);
    return outDir;
  } finally {
    await clearScenario(electronApp).catch(() => {});
    await electronApp.close().catch(() => {});
  }
}

run().catch((err) => {
  console.error('\nFAIL capture test:', err.message || err);
  process.exit(1);
});
