const { _electron: electron } = require('playwright');
const path = require('path');
const fs = require('fs');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function ts() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function safeFilePart(input) {
  return String(input || '')
    .replace(/https?:\/\//g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .slice(0, 90);
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

async function setWindowSize(app, width, height) {
  return app.evaluate(({ BrowserWindow }, size) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) throw new Error('No window');
    win.setSize(size.width, size.height);
    const bounds = win.getContentBounds();
    return { width: bounds.width, height: bounds.height };
  }, { width, height });
}

async function captureWindow(app, outPath) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const page = await app.firstWindow();
  await page.screenshot({ path: outPath });
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

async function collectThreadUrls(app) {
  return withPrimaryWebContents(
    app,
    async (wc) => {
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

          const urls = new Set();
          const totalPasses = 18;
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

          const collect = () => {
            const anchors = Array.from(document.querySelectorAll('a[href]'));
            for (const a of anchors) {
              const normalized = normalize(a.getAttribute('href'));
              if (normalized) urls.add(normalized);
            }
          };

          const scroller = findSidebarScroller();
          collect();
          for (let i = 0; i < totalPasses; i++) {
            const delta = Math.max(220, Math.round((scroller.clientHeight || window.innerHeight) * 0.8));
            scroller.scrollTop = Math.min(scroller.scrollTop + delta, scroller.scrollHeight);
            await new Promise((r) => setTimeout(r, 170));
            collect();
          }
          for (let i = 0; i < totalPasses; i++) {
            scroller.scrollTop = Math.max(0, scroller.scrollTop - 420);
          }

          return Array.from(urls);
        })();
      `;
      return wc.executeJavaScript(script, true);
    },
    null,
  );
}

function toMediaUrl(threadUrl) {
  try {
    const u = new URL(threadUrl);
    const m = u.pathname.match(/^\/messages\/(e2ee\/)?t\/([^/]+)/i);
    if (!m) return null;
    const base = `/messages/${m[1] ? 'e2ee/' : ''}t/${m[2]}/media`;
    return `${u.origin}${base}`;
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

async function collectMediaLinksFromCurrentPage(app) {
  return withPrimaryWebContents(
    app,
    async (wc) => {
      const script = `
        (async () => {
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

          const shouldIgnore = (raw) => {
            const h = String(raw || '').toLowerCase();
            return h.includes('/reel/?s=tab') || h === '/reel/' || h === '/reel';
          };

          const links = new Map();
          const scrollers = Array.from(document.querySelectorAll('div'))
            .filter((el) => el.scrollHeight > el.clientHeight + 160)
            .sort((a, b) => b.clientHeight - a.clientHeight);
          const scroller = scrollers[0] || document.scrollingElement || document.documentElement;

          const collect = () => {
            const anchors = Array.from(document.querySelectorAll('a[href]'));
            for (const a of anchors) {
              const href = a.getAttribute('href') || '';
              if (shouldIgnore(href)) continue;
              const type = routeType(href);
              if (!type) continue;
              try {
                const abs = new URL(href, window.location.origin).href;
                if (!links.has(abs)) {
                  links.set(abs, { url: abs, routeType: type });
                }
              } catch {}
            }
          };

          collect();
          for (let i = 0; i < 12; i++) {
            scroller.scrollTop = Math.min(scroller.scrollTop + 620, scroller.scrollHeight);
            await new Promise((r) => setTimeout(r, 170));
            collect();
          }
          scroller.scrollTop = 0;

          return {
            pageUrl: window.location.href,
            title: document.title,
            links: Array.from(links.values()),
          };
        })();
      `;
      return wc.executeJavaScript(script, true);
    },
    null,
  );
}

async function inspectCurrentViewer(app) {
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
              if (r.top > 420 || r.bottom < -200) continue;
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

          const chooseClose = (arr) => {
            if (!arr.length) return null;
            const sorted = [...arr].sort((a, b) => {
              const aEdge = Math.min(a.left, Math.max(0, window.innerWidth - a.right));
              const bEdge = Math.min(b.left, Math.max(0, window.innerWidth - b.right));
              if (aEdge !== bEdge) return aEdge - bEdge;
              if (a.top !== b.top) return a.top - b.top;
              return a.left - b.left;
            });
            return sorted[0];
          };

          const chooseRight = (arr) => {
            if (!arr.length) return null;
            const sorted = [...arr].sort((a, b) => {
              const ar = Math.max(0, window.innerWidth - a.right);
              const br = Math.max(0, window.innerWidth - b.right);
              if (ar !== br) return ar - br;
              if (a.top !== b.top) return a.top - b.top;
              return a.left - b.left;
            });
            return sorted[0];
          };

          const closeAll = pick('[aria-label="Close" i],button[aria-label="Close" i],[aria-label*="Go back" i],button[aria-label*="Go back" i],[aria-label="Back" i],button[aria-label="Back" i]');
          const downloadAll = pick('[aria-label*="Download" i],button[aria-label*="Download" i],[aria-label*="Save" i],button[aria-label*="Save" i]');
          const shareAll = pick('[aria-label*="Share" i],button[aria-label*="Share" i],[aria-label*="Forward" i],button[aria-label*="Forward" i]');

          const close = chooseClose(closeAll);
          const download = chooseRight(downloadAll);
          const share = chooseRight(shareAll.filter((s) => !download || s.left !== download.left || s.top !== download.top));

          const closePosition = close ? (close.left < window.innerWidth * 0.5 ? 'left' : 'right') : 'unknown';

          const toGapRight = (rect) => rect ? Math.max(0, Math.round(window.innerWidth - rect.right)) : null;

          return {
            url: window.location.href,
            viewport: {
              width: window.innerWidth,
              height: window.innerHeight,
              scrollbarWidth: Math.max(0, window.innerWidth - document.documentElement.clientWidth),
            },
            classes: {
              mediaClean: document.documentElement.classList.contains('md-fb-media-viewer-clean'),
              activeCrop: document.documentElement.classList.contains('md-fb-messages-viewport-fix'),
              leftDismiss: document.documentElement.classList.contains('md-fb-media-dismiss-left'),
            },
            closePosition,
            controls: {
              close,
              download,
              share,
              closeAll,
              downloadAll,
              shareAll,
            },
            gaps: {
              closeLeft: close ? close.left : null,
              closeRight: toGapRight(close),
              downloadRight: toGapRight(download),
              shareRight: toGapRight(share),
            },
          };
        })();
      `;
      return wc.executeJavaScript(script, true);
    },
    null,
  );
}

function evaluateSymmetry(state) {
  const close = state.controls.close;
  const download = state.controls.download;
  const share = state.controls.share;
  if (!close || !download || !share) {
    return { ok: false, reason: 'missing_controls' };
  }

  const isLeft = state.closePosition === 'left' || state.classes.leftDismiss === true;
  const expectedDownload = isLeft ? state.gaps.closeLeft : state.gaps.closeRight + 48;
  const expectedShare = isLeft ? state.gaps.closeLeft + 48 : state.gaps.closeRight + 96;

  const near = (a, b, t = 5) => typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= t;
  const topAligned = near(download.top, close.top) && near(share.top, close.top);
  const gapAligned = near(state.gaps.downloadRight, expectedDownload) && near(state.gaps.shareRight, expectedShare);

  return {
    ok: topAligned && gapAligned,
    reason: topAligned && gapAligned ? 'ok' : 'misaligned',
    metrics: {
      closeTop: close.top,
      downloadTop: download.top,
      shareTop: share.top,
      closeLeft: state.gaps.closeLeft,
      closeRight: state.gaps.closeRight,
      downloadRight: state.gaps.downloadRight,
      shareRight: state.gaps.shareRight,
      expectedDownload,
      expectedShare,
      isLeft,
    },
  };
}

async function run() {
  const outDir = path.join(process.cwd(), 'test-screenshots', `issue45-real-resize-${ts()}`);
  fs.mkdirSync(outDir, { recursive: true });
  console.log('Output folder:', outDir);

  const app = await electron.launch({
    args: [path.join(__dirname, '../dist/main/main.js')],
    env: { ...process.env, NODE_ENV: 'development' },
  });

  try {
    await wait(4500);
    const homeUrl = await loadMessagesHome(app);
    console.log('Loaded:', homeUrl);

    const threads = await collectThreadUrls(app);
    console.log('Threads discovered:', threads.length);

    const candidatesByType = new Map();
    for (const thread of threads.slice(0, 80)) {
      const mediaUrl = toMediaUrl(thread);
      if (!mediaUrl) continue;

      const nav = await navigate(app, mediaUrl);
      if (!nav.ok) continue;
      await wait(1100);

      const media = await collectMediaLinksFromCurrentPage(app);
      for (const link of media.links) {
        if (!candidatesByType.has(link.routeType)) {
          candidatesByType.set(link.routeType, []);
        }
        const arr = candidatesByType.get(link.routeType);
        if (!arr.some((x) => x.url === link.url)) {
          arr.push({ ...link, fromThread: thread, fromMediaPage: mediaUrl });
        }
      }
    }

    const targetRouteTypes = [
      'messenger_media',
      'messages_media_viewer',
      'attachment_preview',
      'photo',
      'video',
      'story',
      'reel',
    ];

    const sizes = [
      { width: 1280, height: 900, tag: '1280x900' },
      { width: 1040, height: 760, tag: '1040x760' },
      { width: 860, height: 640, tag: '860x640' },
    ];

    const report = {
      candidatesByType: Object.fromEntries(
        Array.from(candidatesByType.entries()).map(([k, v]) => [k, v.length]),
      ),
      routeTypeResults: [],
    };

    for (const routeType of targetRouteTypes) {
      const candidates = candidatesByType.get(routeType) || [];
      if (candidates.length === 0) {
        report.routeTypeResults.push({ routeType, status: 'missing', reason: 'no_real_candidate_found' });
        continue;
      }

      const chosen = candidates[0];
      const nav = await navigate(app, chosen.url);
      if (!nav.ok) {
        report.routeTypeResults.push({ routeType, status: 'missing', reason: 'navigate_failed', chosen });
        continue;
      }
      await wait(1300);

      const sizeResults = [];
      for (const size of sizes) {
        await setWindowSize(app, size.width, size.height);
        await wait(750);
        const state = await inspectCurrentViewer(app);
        const symmetry = evaluateSymmetry(state);

        const fileName = `${routeType}-${size.tag}-${safeFilePart(chosen.url)}.png`;
        await captureWindow(app, path.join(outDir, fileName));

        sizeResults.push({
          size,
          fileName,
          state,
          symmetry,
        });
      }

      const allOk = sizeResults.every((r) => r.symmetry.ok === true);
      report.routeTypeResults.push({
        routeType,
        status: allOk ? 'ok' : 'needs_review',
        chosen,
        sizeResults,
      });
    }

    const summaryPath = path.join(outDir, 'summary.json');
    fs.writeFileSync(summaryPath, JSON.stringify(report, null, 2));

    const okCount = report.routeTypeResults.filter((r) => r.status === 'ok').length;
    const reviewCount = report.routeTypeResults.filter((r) => r.status === 'needs_review').length;
    const missingCount = report.routeTypeResults.filter((r) => r.status === 'missing').length;

    console.log('Summary:', summaryPath);
    console.log('Counts:', { okCount, reviewCount, missingCount, total: report.routeTypeResults.length });
    console.log('Candidate counts:', report.candidatesByType);
    console.log('Folder:', outDir);
  } finally {
    await app.close().catch(() => {});
  }
}

run().catch((err) => {
  console.error('FAIL real resize capture:', err.message || err);
  process.exit(1);
});
