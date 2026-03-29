const { _electron: electron } = require("playwright");
const path = require("path");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs(argv) {
  const options = {
    threadUrl: String(
      process.env.MESSENGER_ISSUE45_CLOSE_THREAD_URL || "",
    ).trim(),
    mediaUrl: String(
      process.env.MESSENGER_ISSUE45_CLOSE_MEDIA_URL || "",
    ).trim(),
    openMode: String(
      process.env.MESSENGER_ISSUE45_CLOSE_OPEN_MODE || "thread-click",
    )
      .trim()
      .toLowerCase(),
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--thread-url") {
      options.threadUrl = String(next || "").trim();
      i += 1;
    } else if (arg === "--media-url") {
      options.mediaUrl = String(next || "").trim();
      i += 1;
    } else if (arg === "--open-mode") {
      options.openMode = String(next || "thread-click")
        .trim()
        .toLowerCase();
      i += 1;
    } else if (arg === "--help") {
      console.log(
        `Usage: node scripts/test-issue45-close-return-gui.js [options]\n\nOptions:\n  --thread-url <url>   Exact thread to validate first\n  --media-url <url>    Exact media URL to match/open before closing\n  --open-mode <mode>   thread-click (default) or direct-url\n`,
      );
      process.exit(0);
    }
  }

  if (options.openMode !== "thread-click" && options.openMode !== "direct-url") {
    throw new Error(`Unsupported --open-mode value: ${options.openMode}`);
  }

  return options;
}

async function withPrimaryWebContents(app, fn, payload) {
  return app.evaluate(
    async ({ BrowserWindow }, { fnSource, payload }) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (!win) throw new Error("No main window available");
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
      await wc.loadURL("https://www.facebook.com/messages/").catch(async () => {
        await wc.loadURL("https://www.facebook.com/");
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
    return `${u.origin}/messages/${m[1] ? "e2ee/" : ""}t/${m[2]}/media`;
  } catch {
    return null;
  }
}

function normalizeThreadKey(rawUrl) {
  try {
    const pathname = new URL(rawUrl).pathname.replace(/\/+$/, "") || "/";
    return pathname
      .replace(/^\/messages\/e2ee\/t\//i, "/t/")
      .replace(/^\/messages\/t\//i, "/t/");
  } catch {
    return String(rawUrl || "");
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

async function sendInputClick(app, x, y) {
  return withPrimaryWebContents(
    app,
    async (wc, point) => {
      wc.sendInputEvent({
        type: "mouseDown",
        x: Math.round(point.x),
        y: Math.round(point.y),
        button: "left",
        clickCount: 1,
      });
      wc.sendInputEvent({
        type: "mouseUp",
        x: Math.round(point.x),
        y: Math.round(point.y),
        button: "left",
        clickCount: 1,
      });
      return true;
    },
    { x, y },
  );
}

function deriveThreadUrlFromMediaUrl(input) {
  try {
    const parsed = new URL(input);
    const threadId =
      parsed.searchParams.get("thread_id") ||
      parsed.searchParams.get("threadId") ||
      "";
    if (!threadId) return null;
    return `${parsed.origin}/messages/t/${threadId}/`;
  } catch {
    return null;
  }
}

function toMediaIndexUrl(threadUrl) {
  try {
    const parsed = new URL(threadUrl);
    parsed.pathname = `${parsed.pathname.replace(/\/+$/, "")}/media/`;
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

async function findVisibleMediaTarget(app, hrefNeedle) {
  return withPrimaryWebContents(
    app,
    async (wc, payload) => {
      const script = `
        (async () => {
          const hrefNeedle = String(${JSON.stringify(payload.hrefNeedle || "")});
          const isMediaHref = (raw) => {
            if (!raw) return false;
            const h = String(raw).toLowerCase();
            if (h.includes('/reel/?s=tab') || h === '/reel/' || h === '/reel') return false;
            return h.includes('/messenger_media') || h.includes('/messages/media_viewer') || h.includes('/messages/attachment_preview') || h.includes('/photo') || h.includes('/photos') || h.includes('/video') || h.includes('/watch') || h.includes('/story') || h.includes('/stories');
          };
          const isVisible = (node) => {
            if (!(node instanceof HTMLElement)) return false;
            if (node.closest('[hidden]') || node.closest('[aria-hidden="true"]')) return false;
            const style = window.getComputedStyle(node);
            if (style.display === 'none' || style.visibility === 'hidden') return false;
            const rect = node.getBoundingClientRect();
            return rect.width >= 24 && rect.height >= 24 && rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight;
          };
          const scrollers = Array.from(document.querySelectorAll('div'))
            .filter((el) => el.scrollHeight > el.clientHeight + 180)
            .sort((a, b) => b.clientHeight - a.clientHeight);
          const scroller = scrollers[0] || document.scrollingElement || document.documentElement;

          const collect = () => {
            const matches = [];
            for (const anchor of Array.from(document.querySelectorAll('a[href]'))) {
              if (!(anchor instanceof HTMLAnchorElement) || !isVisible(anchor)) continue;
              const href = anchor.href || anchor.getAttribute('href') || '';
              if (!isMediaHref(href)) continue;
              if (hrefNeedle && !href.includes(hrefNeedle)) continue;
              const rect = anchor.getBoundingClientRect();
              matches.push({
                href,
                center: {
                  x: Math.round(rect.left + rect.width / 2),
                  y: Math.round(rect.top + rect.height / 2),
                },
                rect: {
                  left: Math.round(rect.left),
                  top: Math.round(rect.top),
                  width: Math.round(rect.width),
                  height: Math.round(rect.height),
                },
              });
            }
            matches.sort((a, b) => {
              if (a.rect.top !== b.rect.top) return a.rect.top - b.rect.top;
              return b.rect.width * b.rect.height - a.rect.width * a.rect.height;
            });
            return matches[0] || null;
          };

          let match = collect();
          for (let pass = 0; pass < 10 && !match; pass += 1) {
            scroller.scrollTop = Math.max(0, scroller.scrollTop - Math.max(260, Math.round((scroller.clientHeight || innerHeight) * 0.8)));
            await new Promise((resolve) => setTimeout(resolve, 220));
            match = collect();
          }
          return match;
        })();
      `;
      return wc.executeJavaScript(script, true);
    },
    { hrefNeedle },
  );
}

async function waitForMediaSurface(app, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const state = await inspectState(app);
    if (
      String(state.url || "").includes("/messenger_media") ||
      state.closeCount > 0 ||
      state.downloadCount > 0
    ) {
      return state;
    }
    await wait(200);
  }
  return inspectState(app);
}

async function openMediaFromThread(app, threadUrl, mediaUrl) {
  const hrefNeedle = String(mediaUrl || "").trim();
  const mediaIndexUrl = toMediaIndexUrl(threadUrl);

  await navigate(app, threadUrl);
  await wait(1200);

  let target = await findVisibleMediaTarget(app, hrefNeedle);
  if (!target && mediaIndexUrl) {
    await navigate(app, mediaIndexUrl);
    await wait(1400);
    target = await findVisibleMediaTarget(app, hrefNeedle);
  }

  if (!target) {
    return { opened: false, reason: "no_matching_media_target_visible" };
  }

  await sendInputClick(app, target.center.x, target.center.y);
  await wait(1200);
  return {
    opened: true,
    target,
    state: await waitForMediaSurface(app),
  };
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
        (() => {
          const normalizeThreadKey = (rawUrl) => {
            try {
              const pathname = new URL(rawUrl).pathname.replace(/\/+$/, '') || '/';
              return pathname
                .replace(/^\/messages\/e2ee\/t\//i, '/t/')
                .replace(/^\/messages\/t\//i, '/t/');
            } catch {
              return rawUrl;
            }
          };
          return {
            url: window.location.href,
            normalizedThreadKey: normalizeThreadKey(window.location.href),
            classes: {
              activeCrop: document.documentElement.classList.contains('md-fb-messages-viewport-fix'),
            },
            closeCount: document.querySelectorAll('[aria-label="Close" i],button[aria-label="Close" i],[aria-label*="Go back" i],button[aria-label*="Go back" i],[aria-label="Back" i],button[aria-label="Back" i],[aria-label="Back to Previous Page" i],button[aria-label="Back to Previous Page" i]').length,
            downloadCount: document.querySelectorAll('[aria-label*="Download" i],button[aria-label*="Download" i],[aria-label*="Save" i],button[aria-label*="Save" i]').length,
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
          const node = document.querySelector('[aria-label="Close" i],button[aria-label="Close" i],[aria-label*="Go back" i],button[aria-label*="Go back" i],[aria-label="Back" i],button[aria-label="Back" i],[aria-label="Back to Previous Page" i],button[aria-label="Back to Previous Page" i]');
          if (!(node instanceof HTMLElement)) return false;
          const r = node.getBoundingClientRect();
          const x = r.left + r.width / 2;
          const y = r.top + r.height / 2;
          for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click']) {
            node.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y }));
          }
          if (typeof node.click === 'function') node.click();
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
  const options = parseArgs(process.argv);
  console.log("\n🧪 Issue #45 close-return crop regression check\n");

  const app = await electron.launch({
    args: [path.join(__dirname, "../dist/main/main.js")],
    env: {
      ...process.env,
      NODE_ENV: "development",
      SKIP_SINGLE_INSTANCE_LOCK: "true",
    },
  });

  try {
    await wait(4500);
    const home = await loadMessagesHome(app);
    console.log("Loaded:", home);

    const threads = options.threadUrl
      ? [options.threadUrl]
      : options.mediaUrl
        ? [deriveThreadUrlFromMediaUrl(options.mediaUrl)].filter(Boolean)
      : await collectThreads(app);
    console.log("Threads discovered:", threads.length);

    let validated = 0;
    for (const thread of threads.slice(0, 20)) {
      const expectedThreadKey = normalizeThreadKey(thread);
      let opened;

      if (options.openMode === "direct-url") {
        const mediaPage = options.mediaUrl || toMediaPage(thread);
        if (!mediaPage) continue;
        const nav = await navigate(app, mediaPage);
        if (!nav.ok) continue;
        await wait(900);

        if (!options.mediaUrl) {
          opened = await openFirstMediaLink(app);
          if (!opened.opened) continue;
        } else {
          opened = { opened: true };
        }
        await wait(1400);
      } else {
        opened = await openMediaFromThread(app, thread, options.mediaUrl);
        if (!opened.opened) continue;
      }

      const openState = await inspectState(app);
      if (!openState.classes.activeCrop || openState.closeCount === 0) continue;

      await closeMedia(app);
      await wait(700);
      const afterShort = await inspectState(app);

      await wait(1300);
      const afterSettled = await inspectState(app);

      console.log("\nThread:", thread);
      console.log("  open:", openState);
      console.log("  afterShort:", afterShort);
      console.log("  afterSettled:", afterSettled);

      assert(
        afterSettled.classes.activeCrop === true,
        "activeCrop did not return after close",
      );
      assert(
        String(afterSettled.normalizedThreadKey || "").startsWith(
          expectedThreadKey,
        ),
        `close returned to wrong thread (${afterSettled.normalizedThreadKey}) expected ${expectedThreadKey}`,
      );

      validated += 1;
      if (validated >= 3) break;
    }

    assert(validated > 0, "No media close flows validated");
    console.log(
      `\nPASS close-return crop regression check (validated ${validated} threads)`,
    );
  } finally {
    await app.close().catch(() => {});
  }
}

run().catch((error) => {
  console.error(
    "\nFAIL close-return crop regression check:",
    error.message || error,
  );
  process.exit(1);
});
