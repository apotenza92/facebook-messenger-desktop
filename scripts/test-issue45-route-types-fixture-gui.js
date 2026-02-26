const { _electron: electron } = require('playwright');
const path = require('path');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function withPrimaryWebContents(app, fn, payload) {
  return app.evaluate(
    async ({ BrowserWindow }, { fnSource, payload }) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (!win) throw new Error('No main window');
      const views = win.getBrowserViews();
      const wc = views.length > 0 ? views[0].webContents : win.webContents;
      const runner = eval(`(${fnSource})`);
      return runner(wc, payload);
    },
    { fnSource: fn.toString(), payload },
  );
}

async function setupFixture(app, routePath, closePosition) {
  return withPrimaryWebContents(
    app,
    async (wc, payload) => {
      const script = `
        (() => {
          const payload = ${JSON.stringify(payload)};
          history.replaceState({}, '', payload.routePath);

          const oldRoot = document.getElementById('md-route-type-fixture-root');
          if (oldRoot) oldRoot.remove();
          const oldStyle = document.getElementById('md-route-type-fixture-style');
          if (oldStyle) oldStyle.remove();

          const style = document.createElement('style');
          style.id = 'md-route-type-fixture-style';
          style.textContent = 'body > *:not(#md-route-type-fixture-root){display:none !important;}';
          document.head.appendChild(style);

          const root = document.createElement('div');
          root.id = 'md-route-type-fixture-root';
          root.style.position = 'fixed';
          root.style.inset = '0';
          root.style.zIndex = '2147483600';
          root.style.background = '#000';
          document.body.appendChild(root);

          const banner = document.createElement('div');
          banner.setAttribute('role', 'banner');
          banner.style.position = 'fixed';
          banner.style.top = '0';
          banner.style.left = '0';
          banner.style.right = '0';
          banner.style.height = '56px';
          root.appendChild(banner);

          const mk = (label, side, px) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.textContent = label[0];
            btn.setAttribute('aria-label', label);
            btn.setAttribute('role', 'button');
            btn.style.position = 'fixed';
            btn.style.top = '20px';
            btn.style.width = '34px';
            btn.style.height = '34px';
            btn.style.background = '#222';
            btn.style.color = '#fff';
            btn.style.borderRadius = '999px';
            btn.style.zIndex = '2147483601';
            if (side === 'left') btn.style.left = String(px) + 'px';
            else btn.style.right = String(px) + 'px';
            root.appendChild(btn);
            return btn;
          };

          if (payload.closePosition === 'left') {
            mk('Close', 'left', 140);
          } else {
            mk('Close', 'right', 170);
          }
          mk('Download media attachment', 'right', 260);
          mk('Forward media attachment', 'right', 320);

          window.postMessage({ type: 'md-force-media-overlay-visible', visible: true }, '*');
          window.dispatchEvent(new Event('resize'));
          return true;
        })();
      `;
      return wc.executeJavaScript(script, true);
    },
    { routePath, closePosition },
  );
}

async function cleanupFixture(app) {
  return withPrimaryWebContents(
    app,
    async (wc) => {
      const script = `
        (() => {
          window.postMessage({ type: 'md-force-media-overlay-visible', visible: false }, '*');
          const root = document.getElementById('md-route-type-fixture-root');
          if (root) root.remove();
          const style = document.getElementById('md-route-type-fixture-style');
          if (style) style.remove();
          return true;
        })();
      `;
      return wc.executeJavaScript(script, true);
    },
    null,
  );
}

async function setWindowSize(app, width, height) {
  return app.evaluate(({ BrowserWindow }, size) => {
    const win = BrowserWindow.getAllWindows()[0];
    win.setSize(size.width, size.height);
    return win.getContentBounds();
  }, { width, height });
}

async function readMetrics(app) {
  return withPrimaryWebContents(
    app,
    async (wc) => {
      const script = `
        (() => {
          const q = (sel) => document.querySelector(sel);
          const rect = (n) => {
            if (!(n instanceof HTMLElement)) return null;
            const r = n.getBoundingClientRect();
            return { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top) };
          };

          const close = rect(q('[aria-label="Close" i]'));
          const download = rect(q('[aria-label*="Download" i], [aria-label*="Save" i]'));
          const share = rect(q('[aria-label*="Forward" i], [aria-label*="Share" i]'));

          const rightGap = (r) => (r ? Math.round(window.innerWidth - r.right) : null);

          return {
            viewport: { width: window.innerWidth, height: window.innerHeight },
            classes: {
              mediaClean: document.documentElement.classList.contains('md-fb-media-viewer-clean'),
              leftDismiss: document.documentElement.classList.contains('md-fb-media-dismiss-left'),
            },
            close,
            download,
            share,
            gaps: {
              closeLeft: close ? close.left : null,
              closeRight: rightGap(close),
              downloadRight: rightGap(download),
              shareRight: rightGap(share),
            },
          };
        })();
      `;
      return wc.executeJavaScript(script, true);
    },
    null,
  );
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
function near(a, b, tol = 5) {
  return typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= tol;
}

async function run() {
  console.log('\n🧪 Fixture route-type symmetry test (#45)\n');
  const app = await electron.launch({
    args: [path.join(__dirname, '../dist/main/main.js')],
    env: { ...process.env, NODE_ENV: 'development' },
  });

  const routeTypes = [
    '/messenger_media/test',
    '/messages/media_viewer/test',
    '/messages/attachment_preview/test',
    '/photo/test',
    '/video/test',
    '/story/test',
    '/reel/test',
  ];

  try {
    await wait(4000);

    for (const routePath of routeTypes) {
      for (const closePosition of ['left', 'right']) {
        await cleanupFixture(app);
        await setupFixture(app, routePath, closePosition);
        await wait(700);

        await setWindowSize(app, 1120, 820);
        await wait(450);
        const before = await readMetrics(app);

        await setWindowSize(app, 860, 640);
        await wait(550);
        const after = await readMetrics(app);

        console.log(`\n${routePath} / close=${closePosition}`);
        console.log(' before', before.gaps, before.classes);
        console.log(' after ', after.gaps, after.classes);

        assert(before.classes.mediaClean === true, `${routePath}:${closePosition} mediaClean false`);
        assert(after.classes.mediaClean === true, `${routePath}:${closePosition} mediaClean false after resize`);

        if (closePosition === 'left') {
          assert(before.classes.leftDismiss === true, `${routePath}:${closePosition} leftDismiss false`);
          assert(after.classes.leftDismiss === true, `${routePath}:${closePosition} leftDismiss false after resize`);

          assert(near(before.gaps.downloadRight, before.gaps.closeLeft), `${routePath}:${closePosition} download not mirrored before`);
          assert(near(before.gaps.shareRight, before.gaps.closeLeft + 48), `${routePath}:${closePosition} share not mirrored before`);
          assert(near(after.gaps.downloadRight, after.gaps.closeLeft), `${routePath}:${closePosition} download not mirrored after`);
          assert(near(after.gaps.shareRight, after.gaps.closeLeft + 48), `${routePath}:${closePosition} share not mirrored after`);
        } else {
          assert(before.classes.leftDismiss === false, `${routePath}:${closePosition} leftDismiss true unexpectedly`);
          assert(after.classes.leftDismiss === false, `${routePath}:${closePosition} leftDismiss true after resize`);

          assert(near(before.gaps.downloadRight, before.gaps.closeRight + 48), `${routePath}:${closePosition} download spacing bad before`);
          assert(near(before.gaps.shareRight, before.gaps.closeRight + 96), `${routePath}:${closePosition} share spacing bad before`);
          assert(near(after.gaps.downloadRight, after.gaps.closeRight + 48), `${routePath}:${closePosition} download spacing bad after`);
          assert(near(after.gaps.shareRight, after.gaps.closeRight + 96), `${routePath}:${closePosition} share spacing bad after`);
        }

        assert(near(before.download.top, before.close.top), `${routePath}:${closePosition} top misaligned before`);
        assert(near(before.share.top, before.close.top), `${routePath}:${closePosition} top misaligned before`);
        assert(near(after.download.top, after.close.top), `${routePath}:${closePosition} top misaligned after`);
        assert(near(after.share.top, after.close.top), `${routePath}:${closePosition} top misaligned after`);
      }
    }

    console.log('\nPASS fixture route-type symmetry test (#45)');
  } finally {
    await cleanupFixture(app).catch(() => {});
    await app.close().catch(() => {});
  }
}

run().catch((err) => {
  console.error('\nFAIL fixture route-type symmetry test (#45):', err.message || err);
  process.exit(1);
});
