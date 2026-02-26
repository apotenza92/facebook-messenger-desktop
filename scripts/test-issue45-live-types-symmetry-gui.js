const { _electron: electron } = require('playwright');
const path = require('path');
const fs = require('fs');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function ts() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

async function withPrimaryWebContents(app, fn, payload) {
  return app.evaluate(
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

async function loadMessages(app) {
  return withPrimaryWebContents(
    app,
    async (wc) => {
      await wc.loadURL('https://www.facebook.com/messages/').catch(async () => {
        await wc.loadURL('https://www.facebook.com/');
      });
      return wc.getURL();
    },
    null,
  );
}

async function collectThreadUrls(app, passes = 16) {
  return withPrimaryWebContents(
    app,
    async (wc, passes) => {
      const script = `
        (async () => {
          const totalPasses = Number(${JSON.stringify(passes)} || 16);
          const normalize = (raw) => {
            if (!raw) return null;
            try {
              const abs = new URL(raw, window.location.origin);
              let pathname = abs.pathname || '/';
              if (pathname.startsWith('/t/') || pathname.startsWith('/e2ee/t/')) {
                pathname = '/messages' + pathname;
              }
              if (!(pathname.startsWith('/messages/t/') || pathname.startsWith('/messages/e2ee/t/'))) {
                return null;
              }
              return abs.origin + pathname;
            } catch {
              return null;
            }
          };

          const urls = new Set();
          const scrollerCandidates = Array.from(document.querySelectorAll('div'))
            .filter((el) => el.scrollHeight > el.clientHeight + 120)
            .sort((a, b) => b.clientHeight - a.clientHeight);
          const scroller = scrollerCandidates[0] || document.scrollingElement || document.documentElement;

          const collect = () => {
            const anchors = Array.from(document.querySelectorAll('a[href]'));
            for (const a of anchors) {
              const normalized = normalize(a.getAttribute('href'));
              if (normalized) urls.add(normalized);
            }
          };

          collect();
          for (let i = 0; i < totalPasses; i++) {
            scroller.scrollTop = Math.min(scroller.scrollTop + 500, scroller.scrollHeight);
            await new Promise((r) => setTimeout(r, 160));
            collect();
          }
          scroller.scrollTop = 0;

          return Array.from(urls);
        })();
      `;
      return wc.executeJavaScript(script, true);
    },
    passes,
  );
}

async function navigate(app, url) {
  return withPrimaryWebContents(
    app,
    async (wc, url) => {
      await wc.loadURL(url);
      return wc.getURL();
    },
    url,
  );
}

async function collectMediaLinksInThread(app, passes = 8) {
  return withPrimaryWebContents(
    app,
    async (wc, passes) => {
      const script = `
        (async () => {
          const totalPasses = Number(${JSON.stringify(passes)} || 8);

          const routeTypeFromUrl = (raw) => {
            try {
              const p = new URL(raw, window.location.origin).pathname.toLowerCase();
              if (p.startsWith('/messenger_media')) return 'messenger_media';
              if (p.startsWith('/messages/media_viewer')) return 'messages_media_viewer';
              if (p.startsWith('/messages/attachment_preview')) return 'attachment_preview';
              if (p.startsWith('/photo') || p.startsWith('/photos')) return 'photo';
              if (p.startsWith('/video') || p.startsWith('/watch')) return 'video';
              if (p.startsWith('/story') || p.startsWith('/stories')) return 'story';
              if (p.startsWith('/reel') || p.startsWith('/reels')) return 'reel';
              return null;
            } catch {
              return null;
            }
          };

          const isGoodMediaHref = (raw) => {
            if (!raw) return false;
            const lower = raw.toLowerCase();
            if (lower.includes('/reel/?s=tab') || lower === '/reel/' || lower === '/reel') {
              return false;
            }
            return routeTypeFromUrl(raw) !== null;
          };

          const links = new Map();
          const collect = () => {
            const anchors = Array.from(document.querySelectorAll('a[href]'));
            for (const a of anchors) {
              const href = a.getAttribute('href') || '';
              if (!isGoodMediaHref(href)) continue;
              try {
                const abs = new URL(href, window.location.origin).href;
                const routeType = routeTypeFromUrl(abs);
                if (!routeType) continue;
                if (!links.has(abs)) {
                  links.set(abs, { url: abs, routeType });
                }
              } catch {}
            }
          };

          const scrollers = Array.from(document.querySelectorAll('div'))
            .filter((el) => el.scrollHeight > el.clientHeight + 200)
            .sort((a, b) => b.clientHeight - a.clientHeight);
          const scroller = scrollers[0] || document.scrollingElement || document.documentElement;

          collect();
          for (let i = 0; i < totalPasses; i++) {
            scroller.scrollTop = Math.min(scroller.scrollTop + 700, scroller.scrollHeight);
            await new Promise((r) => setTimeout(r, 180));
            collect();
          }
          scroller.scrollTop = 0;

          return Array.from(links.values());
        })();
      `;
      return wc.executeJavaScript(script, true);
    },
    passes,
  );
}

async function inspectCurrentMedia(app) {
  return withPrimaryWebContents(
    app,
    async (wc) => {
      const script = `
        (() => {
          const pick = (selectors) => {
            const nodes = Array.from(document.querySelectorAll(selectors));
            const out = [];
            for (const node of nodes) {
              const el = node;
              const style = window.getComputedStyle(el);
              if (style.display === 'none' || style.visibility === 'hidden') continue;
              const r = el.getBoundingClientRect();
              if (r.width < 6 || r.height < 6) continue;
              if (r.top > 360 || r.bottom < -160) continue;
              out.push({
                label: el.getAttribute('aria-label') || '',
                left: Math.round(r.left),
                right: Math.round(r.right),
                top: Math.round(r.top),
                width: Math.round(r.width),
                height: Math.round(r.height),
              });
            }
            return out;
          };

          const close = pick('[aria-label="Close" i],button[aria-label="Close" i],[aria-label*="Go back" i],button[aria-label*="Go back" i],[aria-label="Back" i],button[aria-label="Back" i]');
          const download = pick('[aria-label*="Download" i],button[aria-label*="Download" i],[aria-label*="Save" i],button[aria-label*="Save" i]');
          const share = pick('[aria-label*="Share" i],button[aria-label*="Share" i],[aria-label*="Forward" i],button[aria-label*="Forward" i]');

          const firstClose = close[0] || null;
          const closePosition = firstClose
            ? (firstClose.left < window.innerWidth * 0.5 ? 'left' : 'right')
            : 'unknown';

          const path = (() => {
            try { return new URL(window.location.href).pathname.toLowerCase(); }
            catch { return window.location.pathname.toLowerCase(); }
          })();

          const routeType =
            path.startsWith('/messenger_media') ? 'messenger_media' :
            path.startsWith('/messages/media_viewer') ? 'messages_media_viewer' :
            path.startsWith('/messages/attachment_preview') ? 'attachment_preview' :
            path.startsWith('/photo') || path.startsWith('/photos') ? 'photo' :
            path.startsWith('/video') || path.startsWith('/watch') ? 'video' :
            path.startsWith('/story') || path.startsWith('/stories') ? 'story' :
            path.startsWith('/reel') || path.startsWith('/reels') ? 'reel' :
            'other';

          return {
            url: window.location.href,
            routeType,
            viewport: {
              width: window.innerWidth,
              height: window.innerHeight,
              scrollbarWidth: Math.max(0, window.innerWidth - document.documentElement.clientWidth),
            },
            closePosition,
            controls: { close, download, share },
            classes: {
              mediaClean: document.documentElement.classList.contains('md-fb-media-viewer-clean'),
              activeCrop: document.documentElement.classList.contains('md-fb-messages-viewport-fix'),
              leftDismiss: document.documentElement.classList.contains('md-fb-media-dismiss-left'),
            },
          };
        })();
      `;
      return wc.executeJavaScript(script, true);
    },
    null,
  );
}

function approx(a, b, tolerance = 5) {
  return typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= tolerance;
}

function evaluateSymmetry(state) {
  const close = state.controls.close[0] || null;
  const download = state.controls.download[0] || null;
  const share = state.controls.share[0] || null;

  if (!close || !download || !share) {
    return {
      ok: false,
      reason: 'missing_controls',
      metrics: null,
    };
  }

  const closeLeftGap = close.left;
  const closeRightGap = Math.max(0, state.viewport.width - close.right);
  const downloadRightGap = Math.max(0, state.viewport.width - download.right);
  const shareRightGap = Math.max(0, state.viewport.width - share.right);

  const isLeftLayout = state.closePosition === 'left' || state.classes.leftDismiss === true;

  const expectedDownloadRight = isLeftLayout ? closeLeftGap : closeRightGap + 48;
  const expectedShareRight = isLeftLayout ? closeLeftGap + 48 : closeRightGap + 96;

  const topAligned = approx(download.top, close.top) && approx(share.top, close.top);
  const rightAligned =
    approx(downloadRightGap, expectedDownloadRight) &&
    approx(shareRightGap, expectedShareRight);

  return {
    ok: topAligned && rightAligned,
    reason: topAligned && rightAligned ? 'ok' : 'misaligned',
    metrics: {
      closeTop: close.top,
      downloadTop: download.top,
      shareTop: share.top,
      closeLeftGap,
      closeRightGap,
      downloadRightGap,
      shareRightGap,
      expectedDownloadRight,
      expectedShareRight,
      isLeftLayout,
    },
  };
}

async function captureWindow(app, outputPath) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const page = await app.firstWindow();
  await page.screenshot({ path: outputPath });
}

async function closeMedia(app) {
  return withPrimaryWebContents(
    app,
    async (wc) => {
      const script = `
        (() => {
          const selector = [
            '[aria-label="Close" i]',
            'button[aria-label="Close" i]',
            '[aria-label*="Go back" i]',
            'button[aria-label*="Go back" i]',
            '[aria-label="Back" i]',
            'button[aria-label="Back" i]'
          ].join(', ');
          const node = document.querySelector(selector);
          if (!(node instanceof HTMLElement)) return false;
          const r = node.getBoundingClientRect();
          const x = r.left + r.width / 2;
          const y = r.top + r.height / 2;
          node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
          return true;
        })();
      `;
      return wc.executeJavaScript(script, true);
    },
    null,
  );
}

async function run() {
  const outDir = path.join(process.cwd(), 'test-screenshots', `issue45-live-types-symmetry-${ts()}`);
  fs.mkdirSync(outDir, { recursive: true });

  console.log('Output folder:', outDir);

  const app = await electron.launch({
    args: [path.join(__dirname, '../dist/main/main.js')],
    env: { ...process.env, NODE_ENV: 'development' },
  });

  const findings = [];
  const typeToCandidates = new Map();

  try {
    await wait(4500);
    const loaded = await loadMessages(app);
    console.log('Loaded:', loaded);

    const threadUrls = await collectThreadUrls(app, 18);
    console.log('Threads discovered:', threadUrls.length);

    for (const threadUrl of threadUrls.slice(0, 40)) {
      await navigate(app, threadUrl).catch(() => {});
      await wait(900);
      const links = await collectMediaLinksInThread(app, 8);
      for (const link of links) {
        if (!typeToCandidates.has(link.routeType)) {
          typeToCandidates.set(link.routeType, []);
        }
        const arr = typeToCandidates.get(link.routeType);
        if (!arr.some((item) => item.url === link.url)) {
          arr.push({ ...link, threadUrl });
        }
      }
    }

    const targetTypes = [
      'messenger_media',
      'messages_media_viewer',
      'attachment_preview',
      'photo',
      'video',
      'story',
      'reel',
    ];

    for (const targetType of targetTypes) {
      const candidates = typeToCandidates.get(targetType) || [];
      if (candidates.length === 0) {
        findings.push({ type: targetType, status: 'missing', reason: 'no_link_found' });
        continue;
      }

      let captured = false;
      for (const candidate of candidates.slice(0, 6)) {
        await navigate(app, candidate.url).catch(() => {});
        await wait(1400);

        const state = await inspectCurrentMedia(app);
        const evalResult = evaluateSymmetry(state);

        const file = `${findings.length + 1}-${targetType}.png`;
        await captureWindow(app, path.join(outDir, file));

        findings.push({
          type: targetType,
          status: evalResult.ok ? 'ok' : 'needs_review',
          candidateUrl: candidate.url,
          fromThread: candidate.threadUrl,
          file,
          state,
          evaluation: evalResult,
        });

        captured = true;
        await closeMedia(app).catch(() => {});
        await wait(500);
        break;
      }

      if (!captured) {
        findings.push({ type: targetType, status: 'missing', reason: 'open_failed' });
      }
    }

    const summaryPath = path.join(outDir, 'summary.json');
    fs.writeFileSync(summaryPath, JSON.stringify({ findings }, null, 2));

    const okCount = findings.filter((f) => f.status === 'ok').length;
    const missingCount = findings.filter((f) => f.status === 'missing').length;
    const reviewCount = findings.filter((f) => f.status === 'needs_review').length;

    console.log('Summary path:', summaryPath);
    console.log('Results:', { okCount, reviewCount, missingCount, total: findings.length });

    return outDir;
  } finally {
    await app.close().catch(() => {});
  }
}

run().catch((err) => {
  console.error('FAIL live type symmetry test:', err.message || err);
  process.exit(1);
});
