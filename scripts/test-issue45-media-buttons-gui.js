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

async function runScenario(electronApp, scenario) {
  return withPrimaryWebContents(
    electronApp,
    async (wc, input) => {
      const script = `
        (() => {
          const input = ${JSON.stringify(input)};
          const ACTIVE = 'md-fb-messages-viewport-fix';
          const CLEAN = 'md-fb-media-viewer-clean';
          const LEFT = 'md-fb-media-dismiss-left';

          const root = document.documentElement;
          history.replaceState({}, '', '/messages/t/gui-media-buttons-test');

          const old = document.getElementById('md-test-overlay-root');
          if (old) old.remove();
          const oldIsolation = document.getElementById('md-test-overlay-isolation-style');
          if (oldIsolation) oldIsolation.remove();

          const isolationStyle = document.createElement('style');
          isolationStyle.id = 'md-test-overlay-isolation-style';
          isolationStyle.textContent =
            'body > *:not(#md-test-overlay-root) { display: none !important; }';
          document.head.appendChild(isolationStyle);

          const host = document.createElement('div');
          host.id = 'md-test-overlay-root';
          host.style.position = 'fixed';
          host.style.inset = '0';
          host.style.zIndex = '2147483640';
          host.style.pointerEvents = 'auto';
          document.body.appendChild(host);

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
          logo.textContent = 'FB';
          logo.style.position = 'absolute';
          logo.style.left = '12px';
          logo.style.top = '12px';
          logo.style.width = '28px';
          logo.style.height = '28px';
          logo.style.background = '#4b4f56';
          logo.style.color = 'white';
          logo.style.display = 'grid';
          logo.style.placeItems = 'center';
          banner.appendChild(logo);

          const clickCounts = { close: 0, download: 0, share: 0, logo: 0 };
          logo.addEventListener('click', (e) => {
            e.preventDefault();
            clickCounts.logo += 1;
          });

          const makeAction = (key, label, style) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.textContent = label;
            btn.setAttribute('role', 'button');
            btn.setAttribute('aria-label', label);
            btn.style.setProperty('position', 'fixed', 'important');
            btn.style.setProperty('top', style.top, 'important');
            btn.style.setProperty('right', style.right || 'auto', 'important');
            btn.style.setProperty('left', style.left || 'auto', 'important');
            btn.style.setProperty('width', '28px', 'important');
            btn.style.setProperty('height', '28px', 'important');
            btn.style.setProperty('z-index', '2147483642', 'important');
            btn.style.setProperty('pointer-events', 'auto', 'important');
            btn.style.setProperty('background', '#222', 'important');
            btn.style.setProperty('color', '#fff', 'important');
            btn.addEventListener('click', () => {
              clickCounts[key] += 1;
            });
            host.appendChild(btn);
            return btn;
          };

          let closeBtn;
          let downloadBtn;
          let shareBtn;

          if (input.closePosition === 'right') {
            closeBtn = makeAction('close', 'Close', { top: '12px', right: '12px' });
          } else {
            closeBtn = makeAction('close', 'Close', { top: '12px', left: '12px' });
          }

          if (input.includeActions) {
            downloadBtn = makeAction('download', 'Download', { top: '12px', right: '52px' });
            shareBtn = makeAction('share', 'Share', { top: '12px', right: '92px' });
          }

          window.postMessage({ type: 'md-force-media-overlay-visible', visible: true }, '*');
          window.dispatchEvent(new Event('resize'));

          const clickCenter = (el) => {
            if (!el) return { clicked: false, topLabel: null };
            const rect = el.getBoundingClientRect();
            if (rect.width < 2 || rect.height < 2) return { clicked: false, topLabel: null };
            const x = rect.left + rect.width / 2;
            const y = rect.top + rect.height / 2;
            const topEl = document.elementFromPoint(x, y);
            if (!(topEl instanceof Element)) return { clicked: false, topLabel: null };
            topEl.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
            return {
              clicked: true,
              topLabel: topEl.getAttribute('aria-label') || topEl.tagName,
            };
          };

          return new Promise((resolve) => {
            setTimeout(() => {
              const closeClick = clickCenter(closeBtn);
              const downloadClick = downloadBtn ? clickCenter(downloadBtn) : null;
              const shareClick = shareBtn ? clickCenter(shareBtn) : null;

              const logoStyle = window.getComputedStyle(logo);

              const result = {
                viewport: {
                  innerWidth: window.innerWidth,
                  innerHeight: window.innerHeight,
                },
                classes: {
                  activeCrop: root.classList.contains(ACTIVE),
                  mediaClean: root.classList.contains(CLEAN),
                  leftDismiss: root.classList.contains(LEFT),
                },
                clickCounts,
                clickTargets: {
                  closeClick,
                  downloadClick,
                  shareClick,
                },
                logoVisible:
                  logoStyle.display !== 'none' &&
                  logoStyle.visibility !== 'hidden' &&
                  logoStyle.pointerEvents !== 'none',
                closeRect: closeBtn ? closeBtn.getBoundingClientRect().toJSON() : null,
                downloadRect: downloadBtn ? downloadBtn.getBoundingClientRect().toJSON() : null,
                shareRect: shareBtn ? shareBtn.getBoundingClientRect().toJSON() : null,
              };

              window.postMessage({ type: 'md-force-media-overlay-visible', visible: false }, '*');
              host.remove();
              isolationStyle.remove();
              resolve(result);
            }, 450);
          });
        })();
      `;

      return wc.executeJavaScript(script, true);
    },
    scenario,
  );
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function run() {
  console.log('\n🧪 GUI media buttons behavior test (#45)\n');

  const electronApp = await electron.launch({
    args: [path.join(__dirname, '../dist/main/main.js')],
    env: {
      ...process.env,
      NODE_ENV: 'development',
    },
  });

  try {
    await wait(4000);
    const loaded = await loadMessagesSurface(electronApp);
    console.log('Loaded surface:', loaded);

    const scenarios = [
      { name: 'Right dismiss + actions', closePosition: 'right', includeActions: true },
      { name: 'Left dismiss + actions', closePosition: 'left', includeActions: true },
      { name: 'Left dismiss only', closePosition: 'left', includeActions: false },
      { name: 'Right dismiss only', closePosition: 'right', includeActions: false },
    ];

    for (const scenario of scenarios) {
      const result = await runScenario(electronApp, scenario);
      console.log(`\n${scenario.name}:`, result);

      assert(result.classes.mediaClean === true, `${scenario.name}: expected media-clean enabled`);
      assert(result.classes.activeCrop === false, `${scenario.name}: expected crop disabled in media mode`);
      assert(result.clickCounts.close >= 1, `${scenario.name}: close button was not clickable`);

      if (scenario.includeActions) {
        assert(result.clickCounts.download >= 1, `${scenario.name}: download button was not clickable`);
        assert(result.clickCounts.share >= 1, `${scenario.name}: share button was not clickable`);
      }

      if (scenario.closePosition === 'left') {
        assert(result.classes.leftDismiss === true, `${scenario.name}: expected left-dismiss class`);
        assert(result.logoVisible === false, `${scenario.name}: expected facebook logo control hidden`);
      } else {
        assert(result.classes.leftDismiss === false, `${scenario.name}: did not expect left-dismiss class`);
      }
    }

    console.log('\nPASS GUI media buttons behavior test (#45)');
  } finally {
    await electronApp.close().catch(() => {});
  }
}

run().catch((error) => {
  console.error('\nFAIL GUI media buttons behavior test (#45):', error.message || error);
  process.exit(1);
});
