const { _electron: electron } = require('playwright');
const path = require('path');
const fs = require('fs');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const DEFAULT_WINDOW_SIZES = [
  { width: 1280, height: 900, tag: '1280x900' },
  { width: 1040, height: 760, tag: '1040x760' },
  { width: 860, height: 640, tag: '860x640' },
];
const TARGET_ROUTE_TYPES = [
  'messenger_media',
  'messages_media_viewer',
  'attachment_preview',
  'photo',
  'video',
  'story',
  'reel',
];

function ts() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function safe(input) {
  return String(input || '')
    .replace(/https?:\/\//g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .slice(0, 90);
}

function parseArgs(argv) {
  const options = {
    mode: 'direct',
    appRoot: process.env.MESSENGER_APP_ROOT
      ? path.resolve(process.env.MESSENGER_APP_ROOT)
      : path.resolve(__dirname, '..'),
    outputDir: '',
    maxThreads: 40,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--mode') {
      options.mode = String(argv[++i] || '').trim().toLowerCase() || options.mode;
    } else if (arg === '--output-dir') {
      options.outputDir = path.resolve(argv[++i]);
    } else if (arg === '--app-root') {
      options.appRoot = path.resolve(argv[++i]);
    } else if (arg === '--max-threads') {
      options.maxThreads = Math.max(1, Number(argv[++i]) || options.maxThreads);
    } else if (arg === '--help' || arg === '-h') {
      console.log(`Usage: node scripts/test-issue45-real-resize-gui.js [options]\n\nOptions:\n  --mode <direct|click-flow>  direct = navigate chosen media URLs; click-flow = open first media from /media pages\n  --output-dir <dir>          Directory for screenshots and summary.json\n  --app-root <dir>            Alternate app root containing dist/main/main.js\n  --max-threads <n>           Max threads to scan while discovering candidates\n`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!['direct', 'click-flow'].includes(options.mode)) {
    throw new Error(`Unknown --mode value: ${options.mode}`);
  }

  if (!options.outputDir) {
    options.outputDir = path.join(process.cwd(), 'test-screenshots', `issue45-real-resize-${options.mode}-${ts()}`);
  }

  return options;
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

async function collectThreadUrls(app, totalPasses = 18) {
  return withPrimaryWebContents(
    app,
    async (wc, totalPasses) => {
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
          for (let i = 0; i < Number(totalPasses || 18); i++) {
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
    totalPasses,
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
                if (!links.has(abs)) links.set(abs, { url: abs, routeType: type });
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

async function countMediaCandidatesOnMediaPage(app) {
  const result = await collectMediaLinksFromCurrentPage(app);
  return result.links || [];
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
            return h.includes('/messenger_media') || h.includes('/messages/media_viewer') || h.includes('/messages/attachment_preview') || h.includes('/photo') || h.includes('/photos') || h.includes('/video') || h.includes('/watch') || h.includes('/story') || h.includes('/stories');
          };

          const candidates = [];
          for (const a of Array.from(document.querySelectorAll('a[href]'))) {
            const href = a.getAttribute('href') || '';
            if (!isTarget(href)) continue;
            const r = a.getBoundingClientRect();
            if (r.width < 12 || r.height < 12) continue;
            candidates.push({ node: a, href, top: r.top, area: r.width * r.height });
          }

          candidates.sort((a, b) => (a.top - b.top) || (b.area - a.area));
          const c = candidates[0];
          if (!c) return { opened: false, href: null };

          c.node.scrollIntoView({ block: 'center', inline: 'nearest' });
          const r = c.node.getBoundingClientRect();
          c.node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }));
          return { opened: true, href: c.href };
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
            return [...arr].sort((a, b) => {
              const aEdge = Math.min(a.left, Math.max(0, window.innerWidth - a.right));
              const bEdge = Math.min(b.left, Math.max(0, window.innerWidth - b.right));
              if (aEdge !== bEdge) return aEdge - bEdge;
              if (a.top !== b.top) return a.top - b.top;
              return a.left - b.left;
            })[0];
          };

          const chooseRight = (arr) => {
            if (!arr.length) return null;
            return [...arr].sort((a, b) => {
              const ar = Math.max(0, window.innerWidth - a.right);
              const br = Math.max(0, window.innerWidth - b.right);
              if (ar !== br) return ar - br;
              if (a.top !== b.top) return a.top - b.top;
              return a.left - b.left;
            })[0];
          };

          const closeAll = pick('[aria-label="Close" i],button[aria-label="Close" i],[aria-label*="Go back" i],button[aria-label*="Go back" i],[aria-label="Back" i],button[aria-label="Back" i]');
          const downloadAll = pick('[aria-label*="Download" i],button[aria-label*="Download" i],[aria-label*="Save" i],button[aria-label*="Save" i]');
          const shareAll = pick('[aria-label*="Share" i],button[aria-label*="Share" i],[aria-label*="Forward" i],button[aria-label*="Forward" i]');

          const close = chooseClose(closeAll);
          const download = chooseRight(downloadAll);
          const share = chooseRight(shareAll.filter((s) => !download || s.left !== download.left || s.top !== download.top));
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
            closePosition: close ? (close.left < window.innerWidth * 0.5 ? 'left' : 'right') : 'unknown',
            controls: { close, download, share, closeAll, downloadAll, shareAll },
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

async function runDirectMode(app, options) {
  const report = {
    mode: 'direct',
    candidatesByType: {},
    routeTypeResults: [],
    sizes: DEFAULT_WINDOW_SIZES,
  };

  const threads = await collectThreadUrls(app);
  console.log('Threads discovered:', threads.length);

  const candidatesByType = new Map();
  for (const thread of threads.slice(0, options.maxThreads)) {
    const mediaUrl = toMediaUrl(thread);
    if (!mediaUrl) continue;

    const nav = await navigate(app, mediaUrl);
    if (!nav.ok) continue;
    await wait(1100);

    const media = await collectMediaLinksFromCurrentPage(app);
    for (const link of media.links) {
      if (!candidatesByType.has(link.routeType)) candidatesByType.set(link.routeType, []);
      const arr = candidatesByType.get(link.routeType);
      if (!arr.some((x) => x.url === link.url)) {
        arr.push({ ...link, fromThread: thread, fromMediaPage: mediaUrl });
      }
    }
  }

  report.candidatesByType = Object.fromEntries(Array.from(candidatesByType.entries()).map(([k, v]) => [k, v.length]));

  for (const routeType of TARGET_ROUTE_TYPES) {
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
    for (const size of DEFAULT_WINDOW_SIZES) {
      await setWindowSize(app, size.width, size.height);
      await wait(750);
      const state = await inspectCurrentViewer(app);
      const symmetry = evaluateSymmetry(state);
      const fileName = `${routeType}-${size.tag}-${safe(chosen.url)}.png`;
      await captureWindow(app, path.join(options.outputDir, fileName));
      sizeResults.push({ size, fileName, state, symmetry });
    }

    report.routeTypeResults.push({
      routeType,
      status: sizeResults.every((r) => r.symmetry.ok) ? 'ok' : 'needs_review',
      chosen,
      sizeResults,
    });
  }

  return report;
}

async function runClickFlowMode(app, options) {
  const summary = {
    mode: 'click-flow',
    testedThreads: [],
    sizes: DEFAULT_WINDOW_SIZES,
    results: [],
  };

  const threads = await collectThreadUrls(app);
  console.log('Threads discovered:', threads.length);

  const mediaThreads = [];
  for (const thread of threads.slice(0, options.maxThreads)) {
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
    for (const size of DEFAULT_WINDOW_SIZES) {
      await setWindowSize(app, size.width, size.height);
      await wait(500);
      await navigate(app, t.mediaUrl);
      await wait(900);
      const opened = await openFirstMediaByClickFromCurrentPage(app);
      await wait(1300);
      const state = await inspectCurrentViewer(app);
      const evaluation = evaluateSymmetry(state);
      const fileName = `${safe(t.thread)}-${size.tag}.png`;
      await captureWindow(app, path.join(options.outputDir, fileName));

      summary.results.push({
        thread: t.thread,
        mediaUrl: t.mediaUrl,
        size,
        opened,
        fileName,
        state,
        evaluation,
      });

      await closeViewer(app).catch(() => {});
      await wait(350);
    }
  }

  return summary;
}

async function run() {
  const options = parseArgs(process.argv.slice(2));
  fs.mkdirSync(options.outputDir, { recursive: true });
  console.log('Output folder:', options.outputDir);
  console.log('Mode:', options.mode);

  const app = await electron.launch({
    args: [path.join(options.appRoot, 'dist/main/main.js')],
    env: { ...process.env, NODE_ENV: 'development' },
  });

  try {
    await wait(4500);
    const homeUrl = await loadMessagesHome(app);
    console.log('Loaded:', homeUrl);

    const report = options.mode === 'click-flow'
      ? await runClickFlowMode(app, options)
      : await runDirectMode(app, options);

    const summaryPath = path.join(options.outputDir, 'summary.json');
    fs.writeFileSync(summaryPath, JSON.stringify(report, null, 2));
    console.log('Summary:', summaryPath);
    console.log('Folder:', options.outputDir);
  } finally {
    await app.close().catch(() => {});
  }
}

run().catch((err) => {
  console.error('FAIL real resize capture:', err.message || err);
  process.exit(1);
});
