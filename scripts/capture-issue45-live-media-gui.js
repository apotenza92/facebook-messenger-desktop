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

async function getThreadUrls(electronApp) {
  return withPrimaryWebContents(
    electronApp,
    async (wc) => {
      const script = `
        (() => {
          const urls = new Set();
          urls.add(window.location.href);
          const anchors = Array.from(
            document.querySelectorAll(
              'a[href*="/messages/t/"], a[href*="/messages/e2ee/t/"], a[href*="/t/"], a[href*="/e2ee/t/"]'
            )
          );
          for (const a of anchors) {
            const href = a.getAttribute('href');
            if (!href) continue;
            try {
              const abs = new URL(href, window.location.origin);
              let pathname = abs.pathname || '/';
              if (pathname.startsWith('/t/') || pathname.startsWith('/e2ee/t/')) {
                pathname = '/messages' + pathname;
              }
              const normalized =
                abs.origin + pathname + (abs.search || '') + (abs.hash || '');
              urls.add(normalized);
            } catch {}
          }
          return Array.from(urls);
        })();
      `;
      return wc.executeJavaScript(script, true);
    },
    null,
  );
}

async function navigate(electronApp, url) {
  return withPrimaryWebContents(
    electronApp,
    async (wc, target) => {
      await wc.loadURL(target);
      return wc.getURL();
    },
    url,
  );
}

async function tryOpenMediaFromThread(electronApp, scrollAttempt) {
  return withPrimaryWebContents(
    electronApp,
    async (wc, payload) => {
      const script = `
        (() => {
          const payload = ${JSON.stringify(payload)};

          const getVisibleRect = (el) => {
            const r = el.getBoundingClientRect();
            if (r.width < 24 || r.height < 24) return null;
            if (r.bottom < 0 || r.top > window.innerHeight) return null;
            return r;
          };

          const isMediaHref = (href) => {
            if (!href) return false;
            const lower = href.toLowerCase();
            return (
              lower.includes('/photo') ||
              lower.includes('/video') ||
              lower.includes('/reel') ||
              lower.includes('/story') ||
              lower.includes('/messenger_media') ||
              lower.includes('/messages/media_viewer') ||
              lower.includes('/messages/attachment_preview')
            );
          };

          const candidates = [];
          const anchors = Array.from(document.querySelectorAll('a[href]'));
          for (const a of anchors) {
            const href = a.getAttribute('href') || '';
            if (!isMediaHref(href)) continue;
            const rect = getVisibleRect(a);
            if (!rect) continue;
            const hasImage = !!a.querySelector('img, video');
            candidates.push({
              element: a,
              href,
              top: rect.top,
              area: rect.width * rect.height,
              hasImage,
            });
          }

          candidates.sort((a, b) => {
            if (a.hasImage !== b.hasImage) return a.hasImage ? -1 : 1;
            if (a.top !== b.top) return a.top - b.top;
            return b.area - a.area;
          });

          const chosen = candidates[0];
          if (chosen) {
            chosen.element.scrollIntoView({ block: 'center', inline: 'nearest' });
            chosen.element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            return { opened: true, href: chosen.href, via: 'anchor-click', scrollAttempt: payload.scrollAttempt };
          }

          // Fallback: click visible images with clickable parent.
          const images = Array.from(document.querySelectorAll('img'));
          for (const img of images) {
            const rect = getVisibleRect(img);
            if (!rect) continue;
            const clickable = img.closest('a[href], [role="button"], button');
            if (!clickable) continue;
            clickable.scrollIntoView({ block: 'center', inline: 'nearest' });
            clickable.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            return { opened: true, href: null, via: 'image-click', scrollAttempt: payload.scrollAttempt };
          }

          // Try scrolling likely containers to reveal media.
          const scrollers = Array.from(document.querySelectorAll('div'))
            .filter((el) => el.scrollHeight > el.clientHeight + 200)
            .sort((a, b) => b.clientHeight - a.clientHeight)
            .slice(0, 4);

          for (const scroller of scrollers) {
            scroller.scrollTop = Math.max(0, scroller.scrollTop + 600);
          }
          window.scrollBy(0, 500);

          return { opened: false, href: null, via: 'none', scrollAttempt: payload.scrollAttempt };
        })();
      `;
      return wc.executeJavaScript(script, true);
    },
    { scrollAttempt },
  );
}

async function inspectMediaState(electronApp) {
  return withPrimaryWebContents(
    electronApp,
    async (wc) => {
      const script = `
        (() => {
          const pick = (selectors) => {
            const nodes = Array.from(document.querySelectorAll(selectors));
            const visible = [];
            for (const n of nodes) {
              const el = n;
              const style = window.getComputedStyle(el);
              if (style.display === 'none' || style.visibility === 'hidden') continue;
              const r = el.getBoundingClientRect();
              if (r.width < 6 || r.height < 6) continue;
              if (r.bottom < -200 || r.top > 320) continue;
              visible.push({
                label: el.getAttribute('aria-label') || '',
                left: Math.round(r.left),
                right: Math.round(r.right),
                top: Math.round(r.top),
                width: Math.round(r.width),
                height: Math.round(r.height),
              });
            }
            return visible;
          };

          const close = pick('[aria-label="Close" i], button[aria-label="Close" i], [aria-label*="Go back" i], button[aria-label*="Go back" i], [aria-label="Back" i], button[aria-label="Back" i]');
          const download = pick('[aria-label*="Download" i], button[aria-label*="Download" i], [aria-label*="Save" i], button[aria-label*="Save" i]');
          const share = pick('[aria-label*="Share" i], button[aria-label*="Share" i], [aria-label*="Forward" i], button[aria-label*="Forward" i]');

          const closeNode = close[0] || null;
          const closePosition = closeNode
            ? (closeNode.left < window.innerWidth * 0.5 ? 'left' : 'right')
            : 'unknown';

          return {
            url: window.location.href,
            classes: {
              mediaClean: document.documentElement.classList.contains('md-fb-media-viewer-clean'),
              activeCrop: document.documentElement.classList.contains('md-fb-messages-viewport-fix'),
              leftDismiss: document.documentElement.classList.contains('md-fb-media-dismiss-left'),
            },
            closePosition,
            controls: { close, download, share },
          };
        })();
      `;
      return wc.executeJavaScript(script, true);
    },
    null,
  );
}

async function captureMainWindow(electronApp, outPath) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const page = await electronApp.firstWindow();
  await page.screenshot({ path: outPath });
}

async function run() {
  const outDir = path.join(process.cwd(), 'test-screenshots', `issue45-live-media-${ts()}`);
  fs.mkdirSync(outDir, { recursive: true });

  console.log('Output folder:', outDir);

  const electronApp = await electron.launch({
    args: [path.join(__dirname, '../dist/main/main.js')],
    env: { ...process.env, NODE_ENV: 'development' },
  });

  const captures = [];

  try {
    await wait(4500);
    const loaded = await loadMessages(electronApp);
    console.log('Loaded:', loaded);

    const threadUrls = await getThreadUrls(electronApp);
    console.log(`Found ${threadUrls.length} thread candidates`);

    const needPositions = new Set(['left', 'right']);

    for (const threadUrl of threadUrls.slice(0, 16)) {
      if (needPositions.size === 0) break;

      console.log('\nThread:', threadUrl);
      await navigate(electronApp, threadUrl).catch(() => {});
      await wait(1200);

      let opened = false;
      for (let attempt = 0; attempt < 4; attempt++) {
        const openResult = await tryOpenMediaFromThread(electronApp, attempt + 1);
        if (openResult.opened) {
          opened = true;
          console.log('  Opened media via', openResult.via, openResult.href || '(no href)');
          break;
        }
        await wait(500);
      }

      if (!opened) {
        console.log('  No media opened from this thread');
        continue;
      }

      await wait(1500);
      const state = await inspectMediaState(electronApp);
      console.log('  Media state:', {
        url: state.url,
        closePosition: state.closePosition,
        classes: state.classes,
        closeCount: state.controls.close.length,
        downloadCount: state.controls.download.length,
        shareCount: state.controls.share.length,
      });

      const fileName = `${captures.length + 1}-${state.closePosition}.png`;
      const filePath = path.join(outDir, fileName);
      await captureMainWindow(electronApp, filePath);

      captures.push({
        file: fileName,
        threadUrl,
        ...state,
      });

      if (state.closePosition === 'left' || state.closePosition === 'right') {
        needPositions.delete(state.closePosition);
      }

      await navigate(electronApp, threadUrl).catch(() => {});
      await wait(700);
    }

    const summaryPath = path.join(outDir, 'summary.json');
    fs.writeFileSync(summaryPath, JSON.stringify({ captures }, null, 2));

    console.log('\nCaptured:', captures.length);
    console.log('Summary:', summaryPath);
    console.log('Folder:', outDir);

    if (captures.length === 0) {
      throw new Error('No live media captures were found from available chats');
    }

    return outDir;
  } finally {
    await electronApp.close().catch(() => {});
  }
}

run().catch((err) => {
  console.error('FAIL live capture:', err.message || err);
  process.exit(1);
});
