const { _electron: electron } = require('playwright');
const path = require('path');
const fs = require('fs');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function ts() {
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

async function collectThreadUrls(electronApp, passes = 12) {
  return withPrimaryWebContents(
    electronApp,
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

          // Scroll back up so first items remain reachable for manual follow-up.
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

async function navigate(electronApp, url) {
  return withPrimaryWebContents(
    electronApp,
    async (wc, url) => {
      await wc.loadURL(url);
      return wc.getURL();
    },
    url,
  );
}

async function tryOpenMedia(electronApp) {
  return withPrimaryWebContents(
    electronApp,
    async (wc) => {
      const script = `
        (async () => {
          const isMediaHref = (href) => {
            if (!href) return false;
            const h = href.toLowerCase();

            // Skip generic reels feed links that don't represent message media viewer controls.
            if (h.includes('/reel/?s=tab') || h === '/reel/' || h === '/reel') {
              return false;
            }

            return (
              h.includes('/messenger_media') ||
              h.includes('/messages/media_viewer') ||
              h.includes('/messages/attachment_preview') ||
              h.includes('/photo') ||
              h.includes('/photos') ||
              h.includes('/video') ||
              h.includes('/watch') ||
              h.includes('/story') ||
              h.includes('/stories') ||
              h.includes('/reel')
            );
          };

          const visibleRect = (el) => {
            const r = el.getBoundingClientRect();
            if (r.width < 20 || r.height < 20) return null;
            if (r.bottom < 0 || r.top > window.innerHeight) return null;
            return r;
          };

          const click = (el) => {
            el.scrollIntoView({ block: 'center', inline: 'nearest' });
            const r = el.getBoundingClientRect();
            const x = r.left + r.width / 2;
            const y = r.top + r.height / 2;
            el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
          };

          for (let pass = 0; pass < 5; pass++) {
            const links = Array.from(document.querySelectorAll('a[href]'));
            const candidates = [];
            for (const link of links) {
              const href = link.getAttribute('href') || '';
              if (!isMediaHref(href)) continue;
              const r = visibleRect(link);
              if (!r) continue;
              candidates.push({
                node: link,
                href,
                hasImage: !!link.querySelector('img, video'),
                top: r.top,
                area: r.width * r.height,
              });
            }

            candidates.sort((a, b) => {
              if (a.hasImage !== b.hasImage) return a.hasImage ? -1 : 1;
              if (a.top !== b.top) return a.top - b.top;
              return b.area - a.area;
            });

            if (candidates[0]) {
              click(candidates[0].node);
              return { opened: true, href: candidates[0].href, pass: pass + 1, method: 'media-link' };
            }

            const mediaThumbs = Array.from(document.querySelectorAll('img, video'));
            for (const thumb of mediaThumbs) {
              const r = visibleRect(thumb);
              if (!r) continue;
              const clickable = thumb.closest('a[href], [role="button"], button');
              if (!clickable) continue;
              click(clickable);
              return { opened: true, href: null, pass: pass + 1, method: 'thumb-click' };
            }

            const scrollers = Array.from(document.querySelectorAll('div'))
              .filter((el) => el.scrollHeight > el.clientHeight + 200)
              .sort((a, b) => b.clientHeight - a.clientHeight)
              .slice(0, 5);
            for (const s of scrollers) {
              s.scrollTop = Math.min(s.scrollTop + 700, s.scrollHeight);
            }
            window.scrollBy(0, 500);
            await new Promise((r) => setTimeout(r, 220));
          }

          return { opened: false, href: null, pass: 5, method: 'none' };
        })();
      `;
      return wc.executeJavaScript(script, true);
    },
    null,
  );
}

async function inspectMedia(electronApp) {
  return withPrimaryWebContents(
    electronApp,
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
              if (r.top > 360 || r.bottom < -200) continue;
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

          const pathname = (() => {
            try { return new URL(window.location.href).pathname.toLowerCase(); }
            catch { return window.location.pathname.toLowerCase(); }
          })();

          const routeType =
            pathname.startsWith('/messenger_media') ? 'messenger_media' :
            pathname.startsWith('/messages/media_viewer') ? 'messages_media_viewer' :
            pathname.startsWith('/messages/attachment_preview') ? 'attachment_preview' :
            pathname.startsWith('/photo') || pathname.startsWith('/photos') ? 'photo' :
            pathname.startsWith('/video') || pathname.startsWith('/watch') ? 'video' :
            pathname.startsWith('/reel') || pathname.startsWith('/reels') ? 'reel' :
            pathname.startsWith('/story') || pathname.startsWith('/stories') ? 'story' :
            'other';

          return {
            url: window.location.href,
            routeType,
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

async function closeMedia(electronApp) {
  return withPrimaryWebContents(
    electronApp,
    async (wc) => {
      const script = `
        (() => {
          const selectors = [
            '[aria-label="Close" i]',
            'button[aria-label="Close" i]',
            '[aria-label*="Go back" i]',
            'button[aria-label*="Go back" i]',
            '[aria-label="Back" i]',
            'button[aria-label="Back" i]',
          ].join(', ');
          const node = document.querySelector(selectors);
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

async function captureWindow(electronApp, outPath) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const page = await electronApp.firstWindow();
  await page.screenshot({ path: outPath });
}

function buildTypeKey(state) {
  return [
    state.routeType,
    state.closePosition,
    state.controls.download.length > 0 ? 'download' : 'no-download',
    state.controls.share.length > 0 ? 'share' : 'no-share',
    state.classes.leftDismiss ? 'left-dismiss-class' : 'no-left-dismiss-class',
  ].join('|');
}

async function run() {
  const outDir = path.join(process.cwd(), 'test-screenshots', `issue45-live-scan-${ts()}`);
  fs.mkdirSync(outDir, { recursive: true });
  console.log('Output folder:', outDir);

  const app = await electron.launch({
    args: [path.join(__dirname, '../dist/main/main.js')],
    env: { ...process.env, NODE_ENV: 'development' },
  });

  const captures = [];
  const seenTypeKeys = new Set();

  try {
    await wait(4500);
    const loaded = await loadMessages(app);
    console.log('Loaded:', loaded);

    const threads = await collectThreadUrls(app, 16);
    console.log('Collected thread URLs:', threads.length);

    for (const thread of threads.slice(0, 40)) {
      console.log('\nThread:', thread);
      await navigate(app, thread).catch(() => {});
      await wait(1000);

      const opened = await tryOpenMedia(app);
      if (!opened.opened) {
        console.log('  No media found in this thread');
        continue;
      }
      console.log('  Opened media:', opened.method, opened.href || '(no href)');

      await wait(1300);
      const state = await inspectMedia(app);
      const typeKey = buildTypeKey(state);

      console.log('  State:', {
        routeType: state.routeType,
        closePosition: state.closePosition,
        classes: state.classes,
        closeCount: state.controls.close.length,
        downloadCount: state.controls.download.length,
        shareCount: state.controls.share.length,
        typeKey,
      });

      if (!seenTypeKeys.has(typeKey)) {
        seenTypeKeys.add(typeKey);
        const file = `${captures.length + 1}-${state.routeType}-${state.closePosition}.png`;
        const outPath = path.join(outDir, file);
        await captureWindow(app, outPath);
        captures.push({ file, thread, ...state, typeKey });
        console.log('  Captured new type:', file);
      } else {
        console.log('  Type already captured, skipping screenshot');
      }

      await closeMedia(app).catch(() => {});
      await wait(500);

      if (seenTypeKeys.size >= 6) {
        break;
      }
    }

    const summaryPath = path.join(outDir, 'summary.json');
    fs.writeFileSync(summaryPath, JSON.stringify({ captures }, null, 2));

    console.log('\nCapture types found:', seenTypeKeys.size);
    console.log('Screenshots:', captures.length);
    console.log('Summary:', summaryPath);
    console.log('Folder:', outDir);

    if (captures.length === 0) {
      throw new Error('No media scenarios captured from available chats');
    }

    return outDir;
  } finally {
    await app.close().catch(() => {});
  }
}

run().catch((err) => {
  console.error('FAIL live media scan:', err.message || err);
  process.exit(1);
});
