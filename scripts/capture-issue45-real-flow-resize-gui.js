const { _electron: electron } = require('playwright');
const path = require('path');
const fs = require('fs');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function ts() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function safe(input) {
  return String(input || '').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80);
}

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

async function setWindowSize(app, width, height) {
  return app.evaluate(({ BrowserWindow }, size) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) throw new Error('No window');
    win.setSize(size.width, size.height);
    const b = win.getContentBounds();
    return { width: b.width, height: b.height };
  }, { width, height });
}

async function captureWindow(app, filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const page = await app.firstWindow();
  await page.screenshot({ path: filePath });
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

async function collectThreads(app) {
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
              if (pathname.startsWith('/t/') || pathname.startsWith('/e2ee/t/')) pathname = '/messages' + pathname;
              if (!(pathname.startsWith('/messages/t/') || pathname.startsWith('/messages/e2ee/t/'))) return null;
              return abs.origin + pathname;
            } catch {
              return null;
            }
          };

          const urls = new Set();
          const totalPasses = 18;
          const nav = document.querySelector('[role="navigation"]');
          let scroller = document.scrollingElement || document.documentElement;
          if (nav instanceof HTMLElement) {
            const cands = [nav, ...Array.from(nav.querySelectorAll('div'))].filter((el) => el.scrollHeight > el.clientHeight + 120);
            cands.sort((a, b) => b.clientHeight - a.clientHeight);
            if (cands[0]) scroller = cands[0];
          }

          const collect = () => {
            const anchors = Array.from(document.querySelectorAll('a[href]'));
            for (const a of anchors) {
              const n = normalize(a.getAttribute('href'));
              if (n) urls.add(n);
            }
          };

          collect();
          for (let i = 0; i < totalPasses; i++) {
            const delta = Math.max(220, Math.round((scroller.clientHeight || innerHeight) * 0.8));
            scroller.scrollTop = Math.min(scroller.scrollTop + delta, scroller.scrollHeight);
            await new Promise((r) => setTimeout(r, 170));
            collect();
          }
          scroller.scrollTop = 0;

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
    return `${u.origin}/messages/${m[1] ? 'e2ee/' : ''}t/${m[2]}/media`;
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
      } catch (e) {
        return { ok: false, error: String(e), currentUrl: wc.getURL() };
      }
      return { ok: true, currentUrl: wc.getURL() };
    },
    url,
  );
}

async function countMediaCandidatesOnMediaPage(app) {
  return withPrimaryWebContents(
    app,
    async (wc) => {
      const script = `
        (() => {
          const isTarget = (href) => {
            if (!href) return false;
            const h = href.toLowerCase();
            if (h.includes('/reel/?s=tab') || h === '/reel/' || h === '/reel') return false;
            return h.includes('/messenger_media') || h.includes('/messages/media_viewer') || h.includes('/messages/attachment_preview') || h.includes('/photo') || h.includes('/video') || h.includes('/story');
          };
          const out = [];
          for (const a of Array.from(document.querySelectorAll('a[href]'))) {
            const href = a.getAttribute('href') || '';
            if (!isTarget(href)) continue;
            const abs = new URL(href, window.location.origin).href;
            if (!out.includes(abs)) out.push(abs);
          }
          return out;
        })();
      `;
      return wc.executeJavaScript(script, true);
    },
    null,
  );
}

async function openFirstMediaByClickFromCurrentPage(app) {
  return withPrimaryWebContents(
    app,
    async (wc) => {
      const script = `
        (() => {
          const isTarget = (href) => {
            if (!href) return false;
            const h = href.toLowerCase();
            if (h.includes('/reel/?s=tab') || h === '/reel/' || h === '/reel') return false;
            return h.includes('/messenger_media') || h.includes('/messages/media_viewer') || h.includes('/messages/attachment_preview') || h.includes('/photo') || h.includes('/video') || h.includes('/story');
          };

          const candidates = [];
          for (const a of Array.from(document.querySelectorAll('a[href]'))) {
            const href = a.getAttribute('href') || '';
            if (!isTarget(href)) continue;
            const r = a.getBoundingClientRect();
            if (r.width < 12 || r.height < 12) continue;
            candidates.push({ node: a, href, top: r.top, area: r.width * r.height });
          }

          candidates.sort((a, b) => {
            if (a.top !== b.top) return a.top - b.top;
            return b.area - a.area;
          });

          const c = candidates[0];
          if (!c) return { opened: false, href: null };

          c.node.scrollIntoView({ block: 'center', inline: 'nearest' });
          const r = c.node.getBoundingClientRect();
          const x = r.left + r.width / 2;
          const y = r.top + r.height / 2;
          c.node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
          return { opened: true, href: c.href };
        })();
      `;
      return wc.executeJavaScript(script, true);
    },
    null,
  );
}

async function inspectControls(app) {
  return withPrimaryWebContents(
    app,
    async (wc) => {
      const script = `
        (() => {
          const pick = (selector) => {
            const out = [];
            for (const n of Array.from(document.querySelectorAll(selector))) {
              const el = n;
              const st = getComputedStyle(el);
              if (st.display === 'none' || st.visibility === 'hidden') continue;
              const r = el.getBoundingClientRect();
              if (r.width < 6 || r.height < 6) continue;
              if (r.top > 420 || r.bottom < -200) continue;
              out.push({ label: el.getAttribute('aria-label') || '', left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) });
            }
            return out;
          };

          const chooseClose = (arr) => {
            if (!arr.length) return null;
            const sorted = [...arr].sort((a,b)=>{
              const ae = Math.min(a.left, Math.max(0, innerWidth - a.right));
              const be = Math.min(b.left, Math.max(0, innerWidth - b.right));
              if (ae !== be) return ae - be;
              if (a.top !== b.top) return a.top - b.top;
              return a.left - b.left;
            });
            return sorted[0];
          };
          const chooseRight = (arr) => {
            if (!arr.length) return null;
            const sorted = [...arr].sort((a,b)=>{
              const ar = Math.max(0, innerWidth - a.right);
              const br = Math.max(0, innerWidth - b.right);
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
          const share = chooseRight(shareAll.filter((s)=>!download || s.left!==download.left || s.top!==download.top));

          const gRight = (r) => r ? Math.max(0, Math.round(innerWidth - r.right)) : null;

          return {
            url: location.href,
            viewport: { width: innerWidth, height: innerHeight },
            classes: {
              mediaClean: document.documentElement.classList.contains('md-fb-media-viewer-clean'),
              activeCrop: document.documentElement.classList.contains('md-fb-messages-viewport-fix'),
              leftDismiss: document.documentElement.classList.contains('md-fb-media-dismiss-left'),
            },
            closePosition: close ? (close.left < innerWidth * 0.5 ? 'left' : 'right') : 'unknown',
            controls: { close, download, share, closeAll, downloadAll, shareAll },
            gaps: {
              closeLeft: close ? close.left : null,
              closeRight: gRight(close),
              downloadRight: gRight(download),
              shareRight: gRight(share),
            },
          };
        })();
      `;
      return wc.executeJavaScript(script, true);
    },
    null,
  );
}

function evaluate(state) {
  const c = state.controls.close;
  const d = state.controls.download;
  const s = state.controls.share;
  if (!c || !d || !s) return { ok: false, reason: 'missing_controls' };
  const isLeft = state.closePosition === 'left' || state.classes.leftDismiss;
  const expD = isLeft ? state.gaps.closeLeft : state.gaps.closeRight + 48;
  const expS = isLeft ? state.gaps.closeLeft + 48 : state.gaps.closeRight + 96;
  const near = (a,b,t=5)=> typeof a==='number' && typeof b==='number' && Math.abs(a-b)<=t;
  const topOk = near(d.top,c.top) && near(s.top,c.top);
  const gapOk = near(state.gaps.downloadRight, expD) && near(state.gaps.shareRight, expS);
  return { ok: topOk && gapOk, reason: topOk && gapOk ? 'ok' : 'misaligned', metrics: { expD, expS } };
}

async function closeViewer(app) {
  return withPrimaryWebContents(
    app,
    async (wc) => {
      const script = `
        (() => {
          const node = document.querySelector('[aria-label="Close" i],button[aria-label="Close" i],[aria-label*="Go back" i],button[aria-label*="Go back" i],[aria-label="Back" i],button[aria-label="Back" i]');
          if (!(node instanceof HTMLElement)) return false;
          const r = node.getBoundingClientRect();
          node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: r.left + r.width/2, clientY: r.top + r.height/2 }));
          return true;
        })();
      `;
      return wc.executeJavaScript(script, true);
    },
    null,
  );
}

async function run() {
  const outDir = path.join(process.cwd(), 'test-screenshots', `issue45-real-flow-resize-${ts()}`);
  fs.mkdirSync(outDir, { recursive: true });
  console.log('Output folder:', outDir);

  const app = await electron.launch({
    args: [path.join(__dirname, '../dist/main/main.js')],
    env: { ...process.env, NODE_ENV: 'development' },
  });

  const summary = { testedThreads: [], sizes: [], results: [] };
  const sizes = [
    { width: 1280, height: 900, tag: '1280x900' },
    { width: 1040, height: 760, tag: '1040x760' },
    { width: 860, height: 640, tag: '860x640' },
  ];
  summary.sizes = sizes;

  try {
    await wait(4500);
    const home = await loadMessagesHome(app);
    console.log('Loaded:', home);

    const threads = await collectThreads(app);
    console.log('Threads discovered:', threads.length);

    const mediaThreads = [];
    for (const thread of threads.slice(0, 40)) {
      const mediaUrl = toMediaUrl(thread);
      if (!mediaUrl) continue;
      const nav = await navigate(app, mediaUrl);
      if (!nav.ok) continue;
      await wait(900);
      const links = await countMediaCandidatesOnMediaPage(app);
      if (links.length > 0) {
        mediaThreads.push({ thread, mediaUrl, linkCount: links.length });
      }
      if (mediaThreads.length >= 4) break;
    }

    summary.testedThreads = mediaThreads;

    for (const t of mediaThreads) {
      for (const size of sizes) {
        await setWindowSize(app, size.width, size.height);
        await wait(500);

        await navigate(app, t.mediaUrl);
        await wait(900);
        const opened = await openFirstMediaByClickFromCurrentPage(app);
        await wait(1300);

        const state = await inspectControls(app);
        const evalResult = evaluate(state);

        const fileName = `${safe(t.thread)}-${size.tag}.png`;
        await captureWindow(app, path.join(outDir, fileName));

        summary.results.push({
          thread: t.thread,
          mediaUrl: t.mediaUrl,
          size,
          opened,
          fileName,
          state,
          evaluation: evalResult,
        });

        await closeViewer(app).catch(() => {});
        await wait(350);
      }
    }

    const summaryPath = path.join(outDir, 'summary.json');
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));

    const okCount = summary.results.filter((r) => r.evaluation.ok).length;
    const failCount = summary.results.length - okCount;

    console.log('Summary:', summaryPath);
    console.log('Counts:', { okCount, failCount, total: summary.results.length });
    console.log('Folder:', outDir);
  } finally {
    await app.close().catch(() => {});
  }
}

run().catch((err) => {
  console.error('FAIL real flow resize capture:', err.message || err);
  process.exit(1);
});
