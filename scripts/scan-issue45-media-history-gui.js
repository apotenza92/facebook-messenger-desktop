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

async function loadMessagesHome(app) {
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

async function collectThreadUrls(app, passes = 18) {
  return withPrimaryWebContents(
    app,
    async (wc, passes) => {
      const script = `
        (async () => {
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

          const totalPasses = Number(${JSON.stringify(16)});
          const urls = new Set();
          const findSidebarScroller = () => {
            const nav = document.querySelector('[role="navigation"]');
            if (!(nav instanceof HTMLElement)) return document.scrollingElement || document.documentElement;
            let best = nav;
            const stack = [nav, ...Array.from(nav.querySelectorAll('div'))];
            for (const node of stack) {
              if (!(node instanceof HTMLElement)) continue;
              if (node.scrollHeight > node.clientHeight + 120) {
                if (node.clientHeight > best.clientHeight) best = node;
              }
            }
            return best;
          };

          const collectVisible = () => {
            const anchors = Array.from(document.querySelectorAll('a[href]'));
            for (const anchor of anchors) {
              const href = anchor.getAttribute('href');
              const normalized = normalize(href);
              if (normalized) urls.add(normalized);
            }
          };

          const scroller = findSidebarScroller();
          collectVisible();

          for (let i = 0; i < totalPasses; i++) {
            const delta = Math.max(220, Math.round((scroller.clientHeight || window.innerHeight) * 0.8));
            scroller.scrollTop = Math.min(scroller.scrollTop + delta, scroller.scrollHeight);
            await new Promise((r) => setTimeout(r, 180));
            collectVisible();
          }

          for (let i = 0; i < totalPasses; i++) {
            scroller.scrollTop = Math.max(0, scroller.scrollTop - 400);
          }

          return Array.from(urls);
        })();
      `;
      return wc.executeJavaScript(script, true);
    },
    passes,
  );
}

function toMediaHistoryUrl(threadUrl) {
  try {
    const u = new URL(threadUrl);
    const m = u.pathname.match(/^\/messages\/(e2ee\/)?t\/([^/]+)/i);
    if (!m) return null;
    const base = `/messages/${m[1] ? 'e2ee/' : ''}t/${m[2]}`;
    return `${u.origin}${base}/media`;
  } catch {
    return null;
  }
}

async function navigate(app, url) {
  return withPrimaryWebContents(
    app,
    async (wc, url) => {
      try {
        await wc.loadURL(url);
      } catch (error) {
        return { ok: false, error: String(error), currentUrl: wc.getURL() };
      }
      return { ok: true, currentUrl: wc.getURL() };
    },
    url,
  );
}

async function collectMediaLinksFromCurrentPage(app, passes = 12) {
  return withPrimaryWebContents(
    app,
    async (wc, passes) => {
      const script = `
        (async () => {
          const totalPasses = Number(${JSON.stringify(passes)} || 12);
          const links = new Map();

          const routeType = (raw) => {
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

          const ignore = (raw) => {
            const h = String(raw || '').toLowerCase();
            return h.includes('/reel/?s=tab') || h === '/reel/' || h === '/reel';
          };

          const collect = () => {
            const anchors = Array.from(document.querySelectorAll('a[href]'));
            for (const a of anchors) {
              const href = a.getAttribute('href') || '';
              if (ignore(href)) continue;
              const type = routeType(href);
              if (!type) continue;
              try {
                const abs = new URL(href, window.location.origin).href;
                if (!links.has(abs)) links.set(abs, { url: abs, routeType: type });
              } catch {}
            }
          };

          const scrollers = Array.from(document.querySelectorAll('div'))
            .filter((el) => el.scrollHeight > el.clientHeight + 160)
            .sort((a, b) => b.clientHeight - a.clientHeight);
          const scroller = scrollers[0] || document.scrollingElement || document.documentElement;

          collect();
          for (let i = 0; i < totalPasses; i++) {
            scroller.scrollTop = Math.min(scroller.scrollTop + 640, scroller.scrollHeight);
            await new Promise((r) => setTimeout(r, 170));
            collect();
          }
          scroller.scrollTop = 0;

          return {
            url: window.location.href,
            title: document.title,
            links: Array.from(links.values()),
          };
        })();
      `;
      return wc.executeJavaScript(script, true);
    },
    passes,
  );
}

async function inspectMediaControls(app) {
  return withPrimaryWebContents(
    app,
    async (wc) => {
      const script = `
        (() => {
          const pick = (selector) => {
            const out = [];
            for (const node of Array.from(document.querySelectorAll(selector))) {
              const el = node;
              const style = window.getComputedStyle(el);
              if (style.display === 'none' || style.visibility === 'hidden') continue;
              const r = el.getBoundingClientRect();
              if (r.width < 6 || r.height < 6) continue;
              if (r.top > 360 || r.bottom < -180) continue;
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

          const close0 = close[0] || null;
          const closePosition = close0 ? (close0.left < innerWidth * 0.5 ? 'left' : 'right') : 'unknown';

          return {
            url: window.location.href,
            viewport: { width: window.innerWidth, height: window.innerHeight },
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

async function captureWindow(app, outPath) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const page = await app.firstWindow();
  await page.screenshot({ path: outPath });
}

function evaluateSymmetry(state) {
  const close = state.controls.close[0];
  const download = state.controls.download[0];
  const share = state.controls.share[0];
  if (!close || !download || !share) {
    return { ok: false, reason: 'missing_controls' };
  }

  const closeLeft = close.left;
  const closeRight = Math.max(0, state.viewport.width - close.right);
  const downloadRight = Math.max(0, state.viewport.width - download.right);
  const shareRight = Math.max(0, state.viewport.width - share.right);
  const isLeft = state.closePosition === 'left' || state.classes.leftDismiss === true;

  const expectedDownload = isLeft ? closeLeft : closeRight + 48;
  const expectedShare = isLeft ? closeLeft + 48 : closeRight + 96;

  const near = (a, b, t = 5) => typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= t;

  const topOk = near(download.top, close.top) && near(share.top, close.top);
  const gapOk = near(downloadRight, expectedDownload) && near(shareRight, expectedShare);

  return {
    ok: topOk && gapOk,
    reason: topOk && gapOk ? 'ok' : 'misaligned',
    metrics: {
      closeTop: close.top,
      downloadTop: download.top,
      shareTop: share.top,
      closeLeft,
      closeRight,
      downloadRight,
      shareRight,
      expectedDownload,
      expectedShare,
      isLeft,
    },
  };
}

async function run() {
  const outDir = path.join(process.cwd(), 'test-screenshots', `issue45-media-history-scan-${ts()}`);
  fs.mkdirSync(outDir, { recursive: true });

  console.log('Output folder:', outDir);

  const app = await electron.launch({
    args: [path.join(__dirname, '../dist/main/main.js')],
    env: { ...process.env, NODE_ENV: 'development' },
  });

  try {
    await wait(4300);
    const loaded = await loadMessagesHome(app);
    console.log('Loaded:', loaded);

    const threads = await collectThreadUrls(app, 80);
    console.log('Threads found:', threads.length);

    const candidateByType = new Map();
    const threadMediaStats = [];

    for (const thread of threads.slice(0, 120)) {
      const mediaUrl = toMediaHistoryUrl(thread);
      if (!mediaUrl) continue;

      const nav = await navigate(app, mediaUrl);
      if (!nav.ok) {
        threadMediaStats.push({ thread, mediaUrl, ok: false, error: nav.error });
        continue;
      }
      await wait(1200);

      const collected = await collectMediaLinksFromCurrentPage(app, 12);
      threadMediaStats.push({ thread, mediaUrl, ok: true, count: collected.links.length, finalUrl: collected.url });

      for (const link of collected.links) {
        if (!candidateByType.has(link.routeType)) {
          candidateByType.set(link.routeType, []);
        }
        const arr = candidateByType.get(link.routeType);
        if (!arr.some((x) => x.url === link.url)) {
          arr.push({ ...link, thread, mediaUrl });
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

    const findings = [];

    for (const type of targetTypes) {
      const candidates = candidateByType.get(type) || [];
      if (candidates.length === 0) {
        findings.push({ type, status: 'missing', reason: 'no_media_history_link' });
        continue;
      }

      let captured = false;
      for (const candidate of candidates.slice(0, 8)) {
        const nav = await navigate(app, candidate.url);
        if (!nav.ok) continue;
        await wait(1300);

        const state = await inspectMediaControls(app);
        const evalResult = evaluateSymmetry(state);

        const file = `${findings.length + 1}-${type}.png`;
        await captureWindow(app, path.join(outDir, file));

        findings.push({
          type,
          status: evalResult.ok ? 'ok' : 'needs_review',
          candidate,
          file,
          state,
          evaluation: evalResult,
        });

        captured = true;
        break;
      }

      if (!captured) {
        findings.push({ type, status: 'missing', reason: 'candidate_navigation_failed' });
      }
    }

    const summary = {
      threadMediaStats,
      candidateCounts: Object.fromEntries(
        Array.from(candidateByType.entries()).map(([k, v]) => [k, v.length]),
      ),
      findings,
    };

    const summaryPath = path.join(outDir, 'summary.json');
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));

    const okCount = findings.filter((f) => f.status === 'ok').length;
    const reviewCount = findings.filter((f) => f.status === 'needs_review').length;
    const missingCount = findings.filter((f) => f.status === 'missing').length;

    console.log('Summary:', summaryPath);
    console.log('Result counts:', { okCount, reviewCount, missingCount, total: findings.length });
    console.log('Candidate counts:', summary.candidateCounts);
    console.log('Folder:', outDir);
  } finally {
    await app.close().catch(() => {});
  }
}

run().catch((err) => {
  console.error('FAIL media history scan:', err.message || err);
  process.exit(1);
});
