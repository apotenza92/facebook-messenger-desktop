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
  return String(input || '')
    .replace(/^https?:\/\//, '')
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
    const b = win.getContentBounds();
    return { width: b.width, height: b.height };
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
              if (pathname.startsWith('/t/') || pathname.startsWith('/e2ee/t/')) pathname = '/messages' + pathname;
              if (!(pathname.startsWith('/messages/t/') || pathname.startsWith('/messages/e2ee/t/'))) return null;
              return abs.origin + pathname;
            } catch {
              return null;
            }
          };

          const urls = new Set();
          const totalPasses = 160;
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
          for (let i = 0; i < totalPasses; i++) {
            const delta = Math.max(220, Math.round((scroller.clientHeight || innerHeight) * 0.85));
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

function toMediaPageUrl(threadUrl) {
  try {
    const u = new URL(threadUrl);
    const m = u.pathname.match(/^\/messages\/(e2ee\/)?t\/([^/]+)/i);
    if (!m) return null;
    return `${u.origin}/messages/${m[1] ? 'e2ee/' : ''}t/${m[2]}/media`;
  } catch {
    return null;
  }
}

async function countMediaLinksOnCurrentPage(app) {
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

          const unique = new Set();
          for (const a of Array.from(document.querySelectorAll('a[href]'))) {
            const href = a.getAttribute('href') || '';
            if (!isMediaHref(href)) continue;
            try {
              unique.add(new URL(href, window.location.origin).href);
            } catch {}
          }
          return unique.size;
        })();
      `;
      return wc.executeJavaScript(script, true);
    },
    null,
  );
}

async function tryOpenMediaFromThread(app, pass) {
  return withPrimaryWebContents(
    app,
    async (wc, pass) => {
      const script = `
        (() => {
          const pass = Number(${JSON.stringify(pass)} || 1);

          const isMediaHref = (raw) => {
            if (!raw) return false;
            const h = raw.toLowerCase();
            if (h.includes('/reel/?s=tab') || h === '/reel/' || h === '/reel') return false;
            return (
              h.includes('/messenger_media') ||
              h.includes('/messages/media_viewer') ||
              h.includes('/messages/attachment_preview') ||
              h.includes('/photo') ||
              h.includes('/photos') ||
              h.includes('/video') ||
              h.includes('/watch') ||
              h.includes('/story') ||
              h.includes('/stories')
            );
          };

          const visibleRect = (el) => {
            const r = el.getBoundingClientRect();
            if (r.width < 12 || r.height < 12) return null;
            if (r.bottom < 0 || r.top > window.innerHeight) return null;
            return r;
          };

          const clickNode = (node) => {
            node.scrollIntoView({ block: 'center', inline: 'nearest' });
            const r = node.getBoundingClientRect();
            const x = r.left + r.width / 2;
            const y = r.top + r.height / 2;
            node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
          };

          const mediaAnchorCandidates = [];
          for (const a of Array.from(document.querySelectorAll('a[href]'))) {
            const href = a.getAttribute('href') || '';
            if (!isMediaHref(href)) continue;
            const r = visibleRect(a);
            if (!r) continue;
            mediaAnchorCandidates.push({
              node: a,
              href,
              top: r.top,
              area: r.width * r.height,
              hasMediaChild: !!a.querySelector('img, video'),
            });
          }

          mediaAnchorCandidates.sort((a, b) => {
            if (a.hasMediaChild !== b.hasMediaChild) return a.hasMediaChild ? -1 : 1;
            if (a.top !== b.top) return a.top - b.top;
            return b.area - a.area;
          });

          if (mediaAnchorCandidates[0]) {
            const c = mediaAnchorCandidates[0];
            clickNode(c.node);
            return { opened: true, method: 'media-anchor', href: c.href, pass };
          }

          const thumbCandidates = [];
          for (const media of Array.from(document.querySelectorAll('img, video'))) {
            const r = visibleRect(media);
            if (!r) continue;
            const clickable = media.closest('a[href], [role="button"], button');
            if (!clickable) continue;
            if (clickable instanceof HTMLElement) {
              thumbCandidates.push({
                node: clickable,
                top: r.top,
                area: r.width * r.height,
              });
            }
          }

          thumbCandidates.sort((a, b) => {
            if (a.top !== b.top) return a.top - b.top;
            return b.area - a.area;
          });

          if (thumbCandidates[0]) {
            clickNode(thumbCandidates[0].node);
            return { opened: true, method: 'thumb-click', href: null, pass };
          }

          // Scroll likely conversation pane (prefer right side containers)
          const scrollers = Array.from(document.querySelectorAll('div'))
            .filter((el) => el.scrollHeight > el.clientHeight + 180)
            .map((el) => {
              const r = el.getBoundingClientRect();
              return { el, left: r.left, width: r.width, height: r.height };
            })
            .filter((s) => s.width > 200 && s.height > 200)
            .sort((a, b) => {
              const aScore = (a.left > window.innerWidth * 0.2 ? 1000 : 0) + a.height;
              const bScore = (b.left > window.innerWidth * 0.2 ? 1000 : 0) + b.height;
              return bScore - aScore;
            })
            .slice(0, 4);

          for (const s of scrollers) {
            s.el.scrollTop = Math.min(s.el.scrollTop + 700, s.el.scrollHeight);
          }
          window.scrollBy(0, 400);

          return { opened: false, method: 'none', href: null, pass };
        })();
      `;
      return wc.executeJavaScript(script, true);
    },
    pass,
  );
}

async function inspectState(app) {
  return withPrimaryWebContents(
    app,
    async (wc) => {
      const script = `
        (() => {
          const closeCount = document.querySelectorAll('[aria-label="Close" i],button[aria-label="Close" i],[aria-label*="Go back" i],button[aria-label*="Go back" i],[aria-label="Back" i],button[aria-label="Back" i]').length;
          const downloadCount = document.querySelectorAll('[aria-label*="Download" i],button[aria-label*="Download" i],[aria-label*="Save" i],button[aria-label*="Save" i]').length;
          const shareCount = document.querySelectorAll('[aria-label*="Share" i],button[aria-label*="Share" i],[aria-label*="Forward" i],button[aria-label*="Forward" i]').length;

          return {
            url: window.location.href,
            classes: {
              mediaClean: document.documentElement.classList.contains('md-fb-media-viewer-clean'),
              activeCrop: document.documentElement.classList.contains('md-fb-messages-viewport-fix'),
              leftDismiss: document.documentElement.classList.contains('md-fb-media-dismiss-left'),
            },
            counts: {
              close: closeCount,
              download: downloadCount,
              share: shareCount,
            },
          };
        })();
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
          node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }));
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
  const outDir = path.join(process.cwd(), 'test-screenshots', `issue45-extensive-thread-open-close-${ts()}`);
  fs.mkdirSync(outDir, { recursive: true });
  console.log('Output folder:', outDir);

  const app = await electron.launch({
    args: [path.join(__dirname, '../dist/main/main.js')],
    env: { ...process.env, NODE_ENV: 'development' },
  });

  const summary = {
    detection: {
      method: 'Deep sidebar scan (160 passes) + URL classification: /messages/e2ee/t/<id> = E2EE, /messages/t/<id> = non-E2EE',
      totalThreadsDiscovered: 0,
      e2eeThreadsDiscovered: 0,
      nonE2EEThreadsDiscovered: 0,
      selectedOldestNonE2EEThreads: [],
    },
    sizes: [
      { width: 1280, height: 900, tag: '1280x900' },
      { width: 1040, height: 760, tag: '1040x760' },
      { width: 860, height: 640, tag: '860x640' },
    ],
    threads: [],
    runs: [],
  };

  try {
    await wait(4500);
    const home = await loadMessagesHome(app);
    console.log('Loaded:', home);

    const allThreads = await collectThreadUrls(app);
    const e2eeThreads = allThreads.filter((u) => u.includes('/messages/e2ee/t/'));
    const nonE2EEThreads = allThreads.filter(
      (u) => u.includes('/messages/t/') && !u.includes('/messages/e2ee/t/'),
    );

    summary.detection.totalThreadsDiscovered = allThreads.length;
    summary.detection.e2eeThreadsDiscovered = e2eeThreads.length;
    summary.detection.nonE2EEThreadsDiscovered = nonE2EEThreads.length;

    // Set insertion order reflects first-seen while scrolling downward.
    // Use the tail of the list to target oldest-discovered non-E2EE threads.
    const oldestCandidates = nonE2EEThreads.slice(-10);
    summary.detection.selectedOldestNonE2EEThreads = [...oldestCandidates];

    const withMedia = [];
    for (const threadUrl of oldestCandidates) {
      const mediaPage = toMediaPageUrl(threadUrl);
      if (!mediaPage) continue;

      const navMedia = await navigate(app, mediaPage);
      if (!navMedia.ok) continue;
      await wait(700);

      const mediaCount = await countMediaLinksOnCurrentPage(app);
      if (mediaCount > 0) {
        withMedia.push(threadUrl);
      }
      if (withMedia.length >= 6) break;
    }

    summary.threads = withMedia;

    console.log('Thread discovery:', {
      total: allThreads.length,
      e2ee: e2eeThreads.length,
      nonE2EE: nonE2EEThreads.length,
      oldestCandidates: oldestCandidates.length,
      selectedWithMedia: summary.threads.length,
    });

    assert(summary.threads.length > 0, 'No old non-E2EE threads with media found');

    let totalChecks = 0;
    let totalFailures = 0;

    for (const size of summary.sizes) {
      await setWindowSize(app, size.width, size.height);
      await wait(450);

      for (const thread of summary.threads) {
        for (let cycle = 1; cycle <= 3; cycle++) {
          totalChecks += 1;
          const run = {
            size,
            thread,
            cycle,
            opened: null,
            openState: null,
            after250: null,
            after900: null,
            after1800: null,
            switchTarget: null,
            afterSwitch300: null,
            afterSwitch1500: null,
            pass: false,
            failureReason: null,
            screenshots: [],
          };

          try {
            const nav = await navigate(app, thread);
            if (!nav.ok) {
              run.failureReason = `navigate-thread-failed:${nav.error}`;
              totalFailures += 1;
              summary.runs.push(run);
              continue;
            }
            await wait(900);

            let opened = null;
            for (let pass = 1; pass <= 6; pass++) {
              opened = await tryOpenMediaFromThread(app, pass);
              if (opened.opened) break;
              await wait(300);
            }
            run.opened = opened;

            if (!opened || !opened.opened) {
              run.failureReason = 'no-media-opened-from-thread';
              totalFailures += 1;
              summary.runs.push(run);
              continue;
            }

            await wait(1300);
            run.openState = await inspectState(app);

            const openShot = `${safe(thread)}-${size.tag}-cycle${cycle}-open.png`;
            await captureWindow(app, path.join(outDir, openShot));
            run.screenshots.push(openShot);

            await closeMedia(app);
            await wait(250);
            run.after250 = await inspectState(app);

            await wait(650);
            run.after900 = await inspectState(app);

            await wait(900);
            run.after1800 = await inspectState(app);

            const closeShot = `${safe(thread)}-${size.tag}-cycle${cycle}-after-close.png`;
            await captureWindow(app, path.join(outDir, closeShot));
            run.screenshots.push(closeShot);

            const switchTarget = summary.threads.find((u) => u !== thread) || thread;
            run.switchTarget = switchTarget;

            const navSwitch = await navigate(app, switchTarget);
            if (!navSwitch.ok) {
              run.failureReason = `switch-target-nav-failed:${navSwitch.error}`;
              totalFailures += 1;
              summary.runs.push(run);
              continue;
            }

            await wait(300);
            run.afterSwitch300 = await inspectState(app);

            await wait(1200);
            run.afterSwitch1500 = await inspectState(app);

            const switchShot = `${safe(thread)}-${size.tag}-cycle${cycle}-after-switch.png`;
            await captureWindow(app, path.join(outDir, switchShot));
            run.screenshots.push(switchShot);

            const isMessagesNonMediaUrl = (url) =>
              typeof url === 'string' &&
              url.includes('/messages/') &&
              !url.includes('/messenger_media') &&
              !url.includes('/messages/media_viewer') &&
              !url.includes('/messages/attachment_preview') &&
              !url.includes('/photo') &&
              !url.includes('/video') &&
              !url.includes('/story') &&
              !url.includes('/reel');

            const settled = run.after1800;
            const closeRecovered =
              isMessagesNonMediaUrl(settled.url) &&
              settled.classes.mediaClean === false &&
              settled.classes.activeCrop === true;

            const switchSettled = run.afterSwitch1500;
            const switchRecovered =
              isMessagesNonMediaUrl(switchSettled.url) &&
              switchSettled.classes.mediaClean === false &&
              switchSettled.classes.activeCrop === true;

            run.pass = closeRecovered && switchRecovered;
            if (!run.pass) {
              run.failureReason = `recovery-invalid:close=${JSON.stringify(settled)}|switch=${JSON.stringify(switchSettled)}`;
              totalFailures += 1;
            }
          } catch (error) {
            run.failureReason = `exception:${String(error?.message || error)}`;
            totalFailures += 1;
          }

          summary.runs.push(run);
        }
      }
    }

    const summaryPath = path.join(outDir, 'summary.json');
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));

    console.log('Summary:', summaryPath);
    console.log('Totals:', {
      totalChecks,
      totalFailures,
      totalPasses: totalChecks - totalFailures,
    });

    const failures = summary.runs.filter((r) => !r.pass);
    if (failures.length > 0) {
      console.log('Failure sample:', failures.slice(0, 3));
      throw new Error(`${failures.length} extensive GUI runs failed`);
    }

    console.log('PASS extensive thread open/close GUI test');
  } finally {
    await app.close().catch(() => {});
  }
}

run().catch((error) => {
  console.error('FAIL extensive thread open/close GUI test:', error.message || error);
  process.exit(1);
});
