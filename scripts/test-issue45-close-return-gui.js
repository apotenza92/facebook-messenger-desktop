const { _electron: electron } = require('playwright');
const path = require('path');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
          const nav = document.querySelector('[role="navigation"]');
          let scroller = document.scrollingElement || document.documentElement;
          if (nav instanceof HTMLElement) {
            const cands = [nav, ...Array.from(nav.querySelectorAll('div'))].filter((el) => el.scrollHeight > el.clientHeight + 120);
            cands.sort((a, b) => b.clientHeight - a.clientHeight);
            if (cands[0]) scroller = cands[0];
          }

          const collect = () => {
            for (const a of Array.from(document.querySelectorAll('a[href]'))) {
              const n = normalize(a.getAttribute('href'));
              if (n) urls.add(n);
            }
          };

          collect();
          for (let i = 0; i < 16; i++) {
            const delta = Math.max(220, Math.round((scroller.clientHeight || innerHeight) * 0.8));
            scroller.scrollTop = Math.min(scroller.scrollTop + delta, scroller.scrollHeight);
            await new Promise((r) => setTimeout(r, 160));
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

function toMediaPage(threadUrl) {
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

async function openFirstMediaLink(app) {
  return withPrimaryWebContents(
    app,
    async (wc) => {
      const script = `
        (() => {
          const isMediaHref = (raw) => {
            if (!raw) return false;
            const h = raw.toLowerCase();
            if (h.includes('/reel/?s=tab') || h === '/reel/' || h === '/reel') return false;
            return h.includes('/messenger_media') || h.includes('/messages/media_viewer') || h.includes('/messages/attachment_preview') || h.includes('/photo') || h.includes('/video') || h.includes('/story');
          };
          const candidates = [];
          for (const a of Array.from(document.querySelectorAll('a[href]'))) {
            const href = a.getAttribute('href') || '';
            if (!isMediaHref(href)) continue;
            const r = a.getBoundingClientRect();
            if (r.width < 10 || r.height < 10) continue;
            candidates.push({ node: a, href, top: r.top, area: r.width * r.height });
          }
          candidates.sort((a,b)=> (a.top - b.top) || (b.area - a.area));
          const c = candidates[0];
          if (!c) return { opened: false };
          c.node.scrollIntoView({ block: 'center', inline: 'nearest' });
          const r = c.node.getBoundingClientRect();
          c.node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: r.left + r.width/2, clientY: r.top + r.height/2 }));
          return { opened: true, href: c.href };
        })();
      `;
      return wc.executeJavaScript(script, true);
    },
    null,
  );
}

async function inspectState(app) {
  return withPrimaryWebContents(
    app,
    async (wc) => {
      const script = `
        (() => ({
          url: window.location.href,
          classes: {
            mediaClean: document.documentElement.classList.contains('md-fb-media-viewer-clean'),
            activeCrop: document.documentElement.classList.contains('md-fb-messages-viewport-fix'),
            leftDismiss: document.documentElement.classList.contains('md-fb-media-dismiss-left'),
          },
          closeCount: document.querySelectorAll('[aria-label="Close" i],button[aria-label="Close" i],[aria-label*="Go back" i],button[aria-label*="Go back" i],[aria-label="Back" i],button[aria-label="Back" i]').length,
          downloadCount: document.querySelectorAll('[aria-label*="Download" i],button[aria-label*="Download" i],[aria-label*="Save" i],button[aria-label*="Save" i]').length,
        }))();
      `;
      return wc.executeJavaScript(script, true);
    },
    null,
  );
}

async function closeMedia(app) {
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

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function run() {
  console.log('\n🧪 Issue #45 close-return crop regression check\n');

  const app = await electron.launch({
    args: [path.join(__dirname, '../dist/main/main.js')],
    env: { ...process.env, NODE_ENV: 'development' },
  });

  try {
    await wait(4500);
    const home = await loadMessagesHome(app);
    console.log('Loaded:', home);

    const threads = await collectThreads(app);
    console.log('Threads discovered:', threads.length);

    let validated = 0;
    for (const thread of threads.slice(0, 20)) {
      const mediaPage = toMediaPage(thread);
      if (!mediaPage) continue;

      const nav = await navigate(app, mediaPage);
      if (!nav.ok) continue;
      await wait(900);

      const opened = await openFirstMediaLink(app);
      if (!opened.opened) continue;
      await wait(1400);

      const openState = await inspectState(app);
      if (!openState.classes.mediaClean) continue;

      await closeMedia(app);
      await wait(700);
      const afterShort = await inspectState(app);

      await wait(1300);
      const afterSettled = await inspectState(app);

      console.log('\nThread:', thread);
      console.log('  open:', openState);
      console.log('  afterShort:', afterShort);
      console.log('  afterSettled:', afterSettled);

      assert(afterSettled.classes.mediaClean === false, 'mediaClean stayed on after close');
      assert(afterSettled.classes.activeCrop === true, 'activeCrop did not return after close');

      validated += 1;
      if (validated >= 3) break;
    }

    assert(validated > 0, 'No media close flows validated');
    console.log(`\nPASS close-return crop regression check (validated ${validated} threads)`);
  } finally {
    await app.close().catch(() => {});
  }
}

run().catch((error) => {
  console.error('\nFAIL close-return crop regression check:', error.message || error);
  process.exit(1);
});
