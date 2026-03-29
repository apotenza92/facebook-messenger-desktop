const { _electron: electron } = require("playwright");
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function ts() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function parseArgs(argv) {
  const options = {
    appRoot: process.env.MESSENGER_APP_ROOT
      ? path.resolve(process.env.MESSENGER_APP_ROOT)
      : path.resolve(__dirname, ".."),
    executablePath: process.env.MESSENGER_EXECUTABLE_PATH
      ? path.resolve(process.env.MESSENGER_EXECUTABLE_PATH)
      : "",
    outputDir: path.join(
      process.cwd(),
      "output",
      "playwright",
      `media-click-route-${ts()}`,
    ),
    threadUrl: "https://www.facebook.com/messages/t/6860983763931910/",
    hrefContains: "attachment_id=2647398358969687",
    mediaUrl: "",
    maxDiscoveryThreads: 30,
    clickMode: "trusted",
    source: "media-tab",
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === "--app-root") {
      options.appRoot = path.resolve(next);
      i += 1;
    } else if (arg === "--executable-path") {
      options.executablePath = path.resolve(next);
      i += 1;
    } else if (arg === "--output-dir") {
      options.outputDir = path.resolve(next);
      i += 1;
    } else if (arg === "--thread-url") {
      options.threadUrl = String(next || "").trim() || options.threadUrl;
      i += 1;
    } else if (arg === "--href-contains") {
      options.hrefContains = String(next ?? "").trim();
      i += 1;
    } else if (arg === "--media-url") {
      options.mediaUrl = String(next || "").trim();
      i += 1;
    } else if (arg === "--max-discovery-threads") {
      options.maxDiscoveryThreads = Math.max(
        1,
        Number(next) || options.maxDiscoveryThreads,
      );
      i += 1;
    } else if (arg === "--click-mode") {
      const mode = String(next || "").trim().toLowerCase();
      if (mode !== "trusted" && mode !== "os") {
        throw new Error(`Unsupported click mode: ${mode}`);
      }
      options.clickMode = mode;
      i += 1;
    } else if (arg === "--source") {
      const source = String(next || "").trim().toLowerCase();
      if (source !== "media-tab" && source !== "chat" && source !== "direct") {
        throw new Error(`Unsupported source: ${source}`);
      }
      options.source = source;
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        `Usage: node scripts/test-media-click-route-gui.js [options]\n\nOptions:\n  --thread-url <url>             Preferred thread to try first\n  --href-contains <text>         Substring that must appear in the target media href\n  --media-url <url>              Navigate to this media URL from inside the thread instead of clicking a tile\n  --source <media-tab|chat|direct>  Open via a thread media tab, in-chat media click, or direct URL\n  --max-discovery-threads <n>    Extra sidebar threads to try if the preferred thread has no usable media tile\n  --click-mode <trusted|os>      Use Electron input events or macOS cliclick for real OS clicks\n  --output-dir <dir>             Directory for screenshot and summary.json\n  --app-root <dir>               Alternate app root containing dist/main/main.js\n  --executable-path <path>       Launch a packaged app binary instead of dist/main/main.js\n`,
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
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

async function waitForAnyWindow(app, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const windows = app.windows();
    if (windows.length > 0) {
      return windows[0];
    }
    await wait(250);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for any Electron window`);
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

async function focusPrimaryWindow(app) {
  return app.evaluate(({ BrowserWindow, app: electronApp }) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) throw new Error("No main window available");
    win.show();
    win.moveTop();
    win.focus();
    electronApp.focus({ steal: true });
    return {
      pid: process.pid,
    };
  });
}

async function getPrimaryWindowClickContext(app) {
  return app.evaluate(({ BrowserWindow, screen }) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) throw new Error("No main window available");
    const views = win.getBrowserViews();
    const contentBounds = win.getContentBounds();
    const viewBounds =
      views.length > 0
        ? views[0].getBounds()
        : { x: 0, y: 0, width: contentBounds.width, height: contentBounds.height };
    const display = screen.getDisplayMatching(contentBounds);
    return {
      contentBounds,
      viewBounds,
      scaleFactor: display?.scaleFactor || 1,
    };
  });
}

function runCliclickClick(x, y) {
  execFileSync("/opt/homebrew/bin/cliclick", ["-w", "80", `c:${x},${y}`], {
    stdio: "pipe",
  });
}

function runCliclickMove(x, y) {
  execFileSync("/opt/homebrew/bin/cliclick", ["-w", "40", `m:${x},${y}`], {
    stdio: "pipe",
  });
}

function frontmostProcess(pid) {
  execFileSync("osascript", [
    "-e",
    `tell application "System Events" to set frontmost of first application process whose unix id is ${Number(pid)} to true`,
  ]);
}

async function clickWithCliclick(app, x, y, scaleFactor = 1) {
  const focusInfo = await focusPrimaryWindow(app);
  frontmostProcess(focusInfo.pid);
  await wait(180);
  const context = await getPrimaryWindowClickContext(app);
  const screenX = Math.round(
    context.contentBounds.x + context.viewBounds.x + x * scaleFactor,
  );
  const screenY = Math.round(
    context.contentBounds.y + context.viewBounds.y + y * scaleFactor,
  );
  runCliclickClick(screenX, screenY);
  await wait(220);
  return {
    screenX,
    screenY,
    scaleFactor,
    contentBounds: context.contentBounds,
    viewBounds: context.viewBounds,
    displayScaleFactor: context.scaleFactor,
  };
}

async function moveWithCliclick(app, x, y, scaleFactor = 1) {
  const focusInfo = await focusPrimaryWindow(app);
  frontmostProcess(focusInfo.pid);
  await wait(180);
  const context = await getPrimaryWindowClickContext(app);
  const screenX = Math.round(
    context.contentBounds.x + context.viewBounds.x + x * scaleFactor,
  );
  const screenY = Math.round(
    context.contentBounds.y + context.viewBounds.y + y * scaleFactor,
  );
  runCliclickMove(screenX, screenY);
  await wait(180);
  return {
    screenX,
    screenY,
    scaleFactor,
    contentBounds: context.contentBounds,
    viewBounds: context.viewBounds,
    displayScaleFactor: context.scaleFactor,
  };
}

async function performClick(app, point, clickMode) {
  if (clickMode === "os") {
    return {
      mode: "os",
      ...(await clickWithCliclick(app, point.x, point.y, 1)),
    };
  }

  await sendInputClick(app, point.x, point.y);
  return {
    mode: "trusted",
    x: point.x,
    y: point.y,
  };
}

async function revealMediaControls(app, clickMode) {
  if (clickMode === "os") {
    const context = await getPrimaryWindowClickContext(app);
    return {
      mode: "os",
      ...(await moveWithCliclick(
        app,
        Math.max(64, context.viewBounds.width - 96),
        28,
        1,
      )),
    };
  }

  return withPrimaryWebContents(
    app,
    async (wc) => {
      const bounds = wc.getBounds();
      wc.sendInputEvent({
        type: "mouseMove",
        x: Math.max(64, Math.round(bounds.width - 96)),
        y: 28,
      });
      return {
        mode: "trusted",
        x: Math.max(64, Math.round(bounds.width - 96)),
        y: 28,
      };
    },
    null,
  );
}

async function installDownloadProbe(app) {
  return app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) throw new Error("No main window");
    const views = win.getBrowserViews();
    const wc = views.length > 0 ? views[0].webContents : win.webContents;
    const globalState = globalThis;

    if (!globalState.__mdDownloadProbeInstalled) {
      globalState.__mdDownloadProbeInstalled = true;
      globalState.__mdDownloadProbeEvents = [];
      wc.session.on("will-download", (_event, item) => {
        const event = {
          type: "will-download",
          url: item.getURL(),
          filename: item.getFilename(),
          savePath: item.getSavePath(),
        };
        globalState.__mdDownloadProbeEvents.push(event);
      });
    }

    globalState.__mdDownloadProbeEvents = [];
    return true;
  });
}

async function readDownloadProbe(app) {
  return app.evaluate(() => {
    return globalThis.__mdDownloadProbeEvents || [];
  });
}

async function navigate(app, url) {
  return withPrimaryWebContents(
    app,
    async (wc, targetUrl) => {
      const timeoutMs = 10000;
      await Promise.race([
        wc.loadURL(targetUrl),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error(`Timed out loading ${targetUrl}`)),
            timeoutMs,
          ),
        ),
      ]);
      return wc.getURL();
    },
    url,
  );
}

async function collectThreadUrls(app, passes = 24) {
  return withPrimaryWebContents(
    app,
    async (wc, totalPasses) => {
      return wc.executeJavaScript(
        `(async () => {
          const normalize = (raw) => {
            if (!raw) return null;
            try {
              const abs = new URL(raw, window.location.origin);
              let pathname = abs.pathname || "/";
              if (pathname.startsWith("/t/") || pathname.startsWith("/e2ee/t/")) {
                pathname = "/messages" + pathname;
              }
              if (!(pathname.startsWith("/messages/t/") || pathname.startsWith("/messages/e2ee/t/"))) {
                return null;
              }
              return abs.origin + pathname.replace(/\\/+$/, "") + "/";
            } catch {
              return null;
            }
          };

          const urls = new Set();
          const findSidebarScroller = () => {
            const nav = document.querySelector('[role="navigation"]');
            if (!(nav instanceof HTMLElement)) {
              return document.scrollingElement || document.documentElement;
            }
            let best = nav;
            const stack = [nav, ...Array.from(nav.querySelectorAll("div"))];
            for (const node of stack) {
              if (!(node instanceof HTMLElement)) continue;
              if (node.scrollHeight > node.clientHeight + 120 && node.clientHeight > best.clientHeight) {
                best = node;
              }
            }
            return best;
          };

          const collectVisible = () => {
            for (const anchor of Array.from(document.querySelectorAll('a[href]'))) {
              const normalized = normalize(anchor.getAttribute("href"));
              if (normalized) urls.add(normalized);
            }
          };

          const scroller = findSidebarScroller();
          collectVisible();
          for (let i = 0; i < Number(${JSON.stringify(totalPasses)} || 24); i += 1) {
            const delta = Math.max(220, Math.round((scroller.clientHeight || window.innerHeight) * 0.8));
            scroller.scrollTop = Math.min(scroller.scrollTop + delta, scroller.scrollHeight);
            await new Promise((resolve) => setTimeout(resolve, 180));
            collectVisible();
          }
          scroller.scrollTop = 0;
          return Array.from(urls);
        })()`,
        true,
      );
    },
    passes,
  );
}

async function navigateViaPageLocation(app, url) {
  return withPrimaryWebContents(
    app,
    async (wc, targetUrl) => {
      await wc.executeJavaScript(
        `window.location.href = ${JSON.stringify(targetUrl)};`,
        true,
      );
      return true;
    },
    url,
  );
}

function deriveMediaIndexUrl(threadUrl) {
  try {
    const parsed = new URL(threadUrl);
    const pathname = parsed.pathname.replace(/\/+$/, "");
    parsed.pathname = `${pathname}/media/`;
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

async function locateMediaTarget(app, hrefContains) {
  return withPrimaryWebContents(
    app,
    async (wc, payload) => {
      return wc.executeJavaScript(
        `(() => {
          const hrefContains = ${JSON.stringify(payload.hrefContains || "")};
          const norm = (value) =>
            String(value || "")
              .replace(/\\s+/g, " ")
              .trim();

          const isVisible = (node) => {
            if (!(node instanceof HTMLElement)) return false;
            if (node.closest("[hidden]") || node.closest('[aria-hidden="true"]')) {
              return false;
            }
            const style = window.getComputedStyle(node);
            if (style.display === "none" || style.visibility === "hidden") {
              return false;
            }
            const rect = node.getBoundingClientRect();
            return rect.width >= 20 && rect.height >= 20 && rect.bottom > 0 && rect.right > 0;
          };

          const candidates = [];
          for (const node of Array.from(document.querySelectorAll("a[href]"))) {
            if (!(node instanceof HTMLAnchorElement) || !isVisible(node)) continue;
            const href = node.href || "";
            if (!href) continue;
            if (!href.includes("/messenger_media") &&
                !href.includes("/messages/media_viewer") &&
                !href.includes("/messages/attachment_preview") &&
                !href.includes("/photo") &&
                !href.includes("/video") &&
                !href.includes("/story")) {
              continue;
            }
            if (hrefContains && !href.includes(hrefContains)) {
              continue;
            }
            const rect = node.getBoundingClientRect();
            candidates.push({
              source: "anchor",
              href,
              label: norm(node.getAttribute("aria-label") || node.getAttribute("title") || node.textContent),
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

          if (candidates.length === 0) {
            for (const node of Array.from(document.querySelectorAll("img, video"))) {
              if (!(node instanceof HTMLElement) || !isVisible(node)) continue;
              const rect = node.getBoundingClientRect();
              if (rect.width < 80 || rect.height < 80) continue;
              if (rect.left < Math.max(180, window.innerWidth * 0.2)) continue;
              if (rect.top < 100) continue;
              candidates.push({
                source: node.tagName.toLowerCase(),
                href: "",
                label: norm(
                  node.getAttribute("aria-label") ||
                    node.getAttribute("title") ||
                    node.getAttribute("alt") ||
                    node.textContent,
                ),
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
          }

          candidates.sort((a, b) => {
            if (a.rect.top !== b.rect.top) return a.rect.top - b.rect.top;
            return b.rect.width * b.rect.height - a.rect.width * a.rect.height;
          });

          return {
            pageUrl: window.location.href,
            candidates: candidates.slice(0, 20),
            target: candidates[0] || null,
          };
        })()`,
        true,
      );
    },
    { hrefContains },
  );
}

async function collectMediaTileCandidates(app) {
  return withPrimaryWebContents(
    app,
    async (wc) => {
      return wc.executeJavaScript(
        `(() => {
          const norm = (value) =>
            String(value || "")
              .replace(/\\s+/g, " ")
              .trim();

          const isVisible = (node) => {
            if (!(node instanceof HTMLElement)) return false;
            if (node.closest("[hidden]") || node.closest('[aria-hidden="true"]')) {
              return false;
            }
            const style = window.getComputedStyle(node);
            if (style.display === "none" || style.visibility === "hidden") {
              return false;
            }
            const rect = node.getBoundingClientRect();
            return rect.width >= 20 && rect.height >= 20 && rect.bottom > 0 && rect.right > 0;
          };

          const interactiveRoot = (node) => {
            if (!(node instanceof HTMLElement)) return null;
            const root =
              node.closest("a[href]") ||
              node.closest("button") ||
              node.closest('[role="button"]') ||
              node.closest("[tabindex]");
            return root instanceof HTMLElement ? root : node;
          };

          const seen = new Set();
          const candidates = [];
          const selectors = [
            "img",
            "video",
            "a[href]",
            "button",
            '[role="button"]',
            '[style*="background-image"]',
          ];

          for (const selector of selectors) {
            for (const node of Array.from(document.querySelectorAll(selector))) {
              const root = interactiveRoot(node);
              if (!(root instanceof HTMLElement) || !isVisible(root)) continue;

              const rect = root.getBoundingClientRect();
              if (rect.width < 80 || rect.height < 80) continue;
              if (rect.left < Math.max(180, window.innerWidth * 0.2)) continue;
              if (rect.top < 80) continue;
              if (rect.bottom > window.innerHeight - 20) continue;

              const key = [
                Math.round(rect.left),
                Math.round(rect.top),
                Math.round(rect.width),
                Math.round(rect.height),
              ].join(":");
              if (seen.has(key)) continue;
              seen.add(key);

              const href =
                root instanceof HTMLAnchorElement
                  ? root.href
                  : root.getAttribute("href") || "";
              const label = norm(
                root.getAttribute("aria-label") ||
                  root.getAttribute("title") ||
                  root.textContent,
              );
              const backgroundImage = window.getComputedStyle(root).backgroundImage;

              candidates.push({
                href,
                label,
                sourceTag: root.tagName.toLowerCase(),
                hasBackgroundImage:
                  typeof backgroundImage === "string" &&
                  backgroundImage !== "none",
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
          }

          candidates.sort((a, b) => {
            if (a.rect.top !== b.rect.top) return a.rect.top - b.rect.top;
            return a.rect.left - b.rect.left;
          });

          return {
            url: window.location.href,
            title: document.title,
            candidates: candidates.slice(0, 40),
          };
        })()`,
        true,
      );
    },
    null,
  );
}

async function collectChatMediaCandidates(app) {
  return withPrimaryWebContents(
    app,
    async (wc) => {
      return wc.executeJavaScript(
        `(async () => {
          const norm = (value) =>
            String(value || "")
              .replace(/\\s+/g, " ")
              .trim();

          const visibleRect = (node) => {
            if (!(node instanceof HTMLElement)) return null;
            if (node.closest("[hidden]") || node.closest('[aria-hidden="true"]')) {
              return null;
            }
            const style = window.getComputedStyle(node);
            if (style.display === "none" || style.visibility === "hidden") {
              return null;
            }
            const rect = node.getBoundingClientRect();
            if (rect.width < 24 || rect.height < 24) return null;
            if (rect.bottom < 0 || rect.top > window.innerHeight) return null;
            return rect;
          };

          const isMediaHref = (raw) => {
            if (!raw) return false;
            const h = String(raw).toLowerCase();
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

          const locateScroller = () => {
            const scrollers = Array.from(document.querySelectorAll('div'))
              .filter((el) => el.scrollHeight > el.clientHeight + 180)
              .map((el) => {
                const r = el.getBoundingClientRect();
                return { el, left: r.left, width: r.width, height: r.height };
              })
              .filter((entry) => entry.width > 240 && entry.height > 220 && entry.left > window.innerWidth * 0.18)
              .sort((a, b) => b.height - a.height);
            return (scrollers[0] && scrollers[0].el) || document.scrollingElement || document.documentElement;
          };

          const collect = () => {
            const candidates = [];
            const seen = new Set();

            for (const anchor of Array.from(document.querySelectorAll('a[href]'))) {
              if (!(anchor instanceof HTMLAnchorElement)) continue;
              if (!isMediaHref(anchor.getAttribute('href') || anchor.href || '')) continue;
              const rect = visibleRect(anchor);
              if (!rect) continue;
              const key = [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height)].join(':');
              if (seen.has(key)) continue;
              seen.add(key);
              candidates.push({
                href: anchor.href || anchor.getAttribute('href') || '',
                label: norm(anchor.getAttribute('aria-label') || anchor.getAttribute('title') || anchor.textContent),
                sourceTag: 'a',
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

            for (const media of Array.from(document.querySelectorAll('img, video, [role="img"]'))) {
              if (!(media instanceof HTMLElement)) continue;
              const rect = visibleRect(media);
              if (!rect) continue;
              if (rect.width < 72 || rect.height < 72 || rect.width * rect.height < 4096) continue;
              const clickable = media.closest('a[href], [role="button"], button, [tabindex]');
              if (!(clickable instanceof HTMLElement)) continue;
              const clickableRect = visibleRect(clickable) || rect;
              const key = [Math.round(clickableRect.left), Math.round(clickableRect.top), Math.round(clickableRect.width), Math.round(clickableRect.height)].join(':');
              if (seen.has(key)) continue;
              seen.add(key);
              candidates.push({
                href:
                  clickable instanceof HTMLAnchorElement
                    ? clickable.href
                    : clickable.getAttribute('href') || '',
                label: norm(
                  clickable.getAttribute('aria-label') ||
                    media.getAttribute('aria-label') ||
                    clickable.textContent
                ),
                sourceTag: clickable.tagName.toLowerCase(),
                center: {
                  x: Math.round(clickableRect.left + clickableRect.width / 2),
                  y: Math.round(clickableRect.top + clickableRect.height / 2),
                },
                rect: {
                  left: Math.round(clickableRect.left),
                  top: Math.round(clickableRect.top),
                  width: Math.round(clickableRect.width),
                  height: Math.round(clickableRect.height),
                },
              });
            }

            candidates.sort((a, b) => {
              if (!!a.href !== !!b.href) return a.href ? -1 : 1;
              if (a.rect.top !== b.rect.top) return a.rect.top - b.rect.top;
              return b.rect.width * b.rect.height - a.rect.width * a.rect.height;
            });

            return candidates.slice(0, 30);
          };

          const scroller = locateScroller();
          let candidates = collect();
          for (let pass = 0; pass < 8 && candidates.length === 0; pass += 1) {
            if (scroller instanceof HTMLElement || scroller === document.documentElement || scroller === document.scrollingElement) {
              const delta = Math.max(240, Math.round((scroller.clientHeight || innerHeight) * 0.8));
              scroller.scrollTop = Math.max(0, scroller.scrollTop - delta);
            } else {
              window.scrollBy(0, -400);
            }
            await new Promise((resolve) => setTimeout(resolve, 220));
            candidates = collect();
          }

          return {
            url: window.location.href,
            title: document.title,
            candidates,
          };
        })()`,
        true,
      );
    },
    null,
  );
}

async function waitForMediaRoute(app, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await collectMediaViewerState(app);
    if (
      state.url.includes("/messenger_media") ||
      state.url.includes("/messages/media_viewer") ||
      state.url.includes("/messages/attachment_preview") ||
      state.url.includes("/photo") ||
      state.url.includes("/video") ||
      state.url.includes("/story")
    ) {
      return state;
    }
    await wait(200);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for media route`);
}

async function waitForMediaSurface(app, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await collectMediaViewerState(app);
    if (
      state.url.includes("/messenger_media") ||
      state.url.includes("/messages/media_viewer") ||
      state.url.includes("/messages/attachment_preview") ||
      state.url.includes("/photo") ||
      state.url.includes("/video") ||
      state.url.includes("/story") ||
      state.download ||
      state.close ||
      state.facebookHome
    ) {
      return state;
    }
    await wait(200);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for media surface`);
}

async function navigateBack(app) {
  return withPrimaryWebContents(
    app,
    async (wc) => {
      if (wc.navigationHistory.canGoBack()) {
        wc.navigationHistory.goBack();
        return true;
      }
      return false;
    },
    null,
  );
}

async function tryOpenViewerFromThreadMediaTab(
  app,
  threadUrl,
  hrefContains,
  clickMode,
) {
  const mediaIndexUrl = deriveMediaIndexUrl(threadUrl);
  if (!mediaIndexUrl) {
    return {
      ok: false,
      threadUrl,
      reason: "could_not_derive_media_tab",
    };
  }

  console.log("[MediaRouteTest] Trying thread:", threadUrl);
  await navigate(app, threadUrl);
  await wait(1200);
  await navigate(app, mediaIndexUrl);
  await wait(1800);

  const tileCandidates = await collectMediaTileCandidates(app);
  console.log(
    "[MediaRouteTest] Candidates on media tab:",
    threadUrl,
    tileCandidates.candidates.length,
  );
  for (const candidate of tileCandidates.candidates) {
    if (hrefContains && candidate.href && !candidate.href.includes(hrefContains)) {
      continue;
    }

    console.log("[MediaRouteTest] Clicking candidate:", {
      threadUrl,
      sourceTag: candidate.sourceTag,
      label: candidate.label,
      href: candidate.href,
      rect: candidate.rect,
    });
    const clickInfo = await performClick(app, candidate.center, clickMode);
    await wait(900);
    try {
      const mediaState = await waitForMediaRoute(app, 2200);
      return {
        ok: true,
        threadUrl,
        sourcePage: mediaIndexUrl,
        targetInfo: {
          ...tileCandidates,
          clickedCandidate: candidate,
          clickInfo,
        },
        mediaState,
      };
    } catch {
      await navigateBack(app).catch(() => false);
      await wait(700);
    }
  }

  return {
    ok: false,
    threadUrl,
    sourcePage: mediaIndexUrl,
    targetInfo: tileCandidates,
    reason: "no_visible_media_tile_opened_viewer",
  };
}

async function tryOpenViewerFromThreadChat(
  app,
  threadUrl,
  hrefContains,
  clickMode,
) {
  console.log("[MediaRouteTest] Trying thread chat:", threadUrl);
  await navigate(app, threadUrl);
  await wait(1800);

  const tileCandidates = await collectChatMediaCandidates(app);
  console.log(
    "[MediaRouteTest] Chat candidates:",
    threadUrl,
    tileCandidates.candidates.length,
  );
  for (const candidate of tileCandidates.candidates) {
    if (hrefContains && candidate.href && !candidate.href.includes(hrefContains)) {
      continue;
    }

    console.log("[MediaRouteTest] Clicking chat candidate:", {
      threadUrl,
      sourceTag: candidate.sourceTag,
      label: candidate.label,
      href: candidate.href,
      rect: candidate.rect,
    });
    const clickInfo = await performClick(app, candidate.center, clickMode);
    await wait(1200);
    try {
      const mediaState = await waitForMediaSurface(app, 3500);
      return {
        ok: true,
        threadUrl,
        sourcePage: threadUrl,
        targetInfo: {
          ...tileCandidates,
          clickedCandidate: candidate,
          clickInfo,
        },
        mediaState,
      };
    } catch {
      await navigateBack(app).catch(() => false);
      await wait(700);
    }
  }

  return {
    ok: false,
    threadUrl,
    sourcePage: threadUrl,
    targetInfo: tileCandidates,
    reason: "no_visible_chat_media_opened_viewer",
  };
}

async function collectMediaViewerState(app) {
  return withPrimaryWebContents(
    app,
    async (wc) => {
      return wc.executeJavaScript(
        `(() => {
          const isVisible = (node) => {
            if (!(node instanceof HTMLElement)) return false;
            if (node.closest("[hidden]") || node.closest('[aria-hidden="true"]')) {
              return false;
            }
            const style = window.getComputedStyle(node);
            if (style.display === "none" || style.visibility === "hidden") {
              return false;
            }
            const rect = node.getBoundingClientRect();
            return rect.width >= 4 && rect.height >= 4 && rect.bottom > 0 && rect.right > 0;
          };

          const pick = (selectors) => {
            for (const selector of selectors) {
              for (const node of Array.from(document.querySelectorAll(selector))) {
                if (!(node instanceof HTMLElement) || !isVisible(node)) continue;
                const rect = node.getBoundingClientRect();
                return {
                  label: String(
                    node.getAttribute("aria-label") ||
                      node.getAttribute("title") ||
                      node.textContent ||
                      "",
                  )
                    .replace(/\\s+/g, " ")
                    .trim(),
                  href:
                    node instanceof HTMLAnchorElement
                      ? node.href
                      : node.getAttribute("href") || null,
                  center: {
                    x: Math.round(rect.left + rect.width / 2),
                    y: Math.round(rect.top + rect.height / 2),
                  },
                  rect: {
                    left: Math.round(rect.left),
                    top: Math.round(rect.top),
                    width: Math.round(rect.width),
                    height: Math.round(rect.height),
                    right: Math.round(rect.right),
                    bottom: Math.round(rect.bottom),
                  },
                };
              }
            }
            return null;
          };

          return {
            url: window.location.href,
            title: document.title,
            close: pick([
              '[aria-label="Close" i]',
              'button[aria-label="Close" i]',
              '[aria-label*="Go back" i]',
              'button[aria-label*="Go back" i]',
              '[aria-label="Back" i]',
              'button[aria-label="Back" i]',
            ]),
            download: pick([
              '[aria-label*="Download" i]',
              'button[aria-label*="Download" i]',
              '[role="button"][aria-label*="Download" i]',
              '[aria-label*="Save" i]',
            ]),
            share: pick([
              '[aria-label*="Forward" i]',
              '[aria-label*="Share" i]',
              'button[aria-label*="Forward" i]',
              'button[aria-label*="Share" i]',
            ]),
            facebookHome: pick([
              '[aria-label="Facebook" i]',
              'a[aria-label="Facebook" i]',
            ]),
          };
        })()`,
        true,
      );
    },
    null,
  );
}

async function main() {
  const options = parseArgs(process.argv);
  fs.mkdirSync(options.outputDir, { recursive: true });

  const app = await (options.executablePath
    ? electron.launch({ executablePath: options.executablePath, args: [] })
    : electron.launch({
        args: [path.join(options.appRoot, "dist", "main", "main.js")],
      }));

  try {
    const page = await waitForAnyWindow(app);
    await wait(1500);
    await installDownloadProbe(app);

    let sourcePage = options.threadUrl;
    let targetInfo = null;
    let effectiveThreadUrl = options.threadUrl;

    if (options.source === "direct" || options.mediaUrl) {
      await navigate(app, options.threadUrl);
      await wait(2200);
      sourcePage = options.mediaUrl;
      await navigateViaPageLocation(app, options.mediaUrl);
      await wait(1200);
    } else {
      const discoveryThreads = [options.threadUrl];
      await navigate(app, "https://www.facebook.com/messages/");
      await wait(1800);
      for (const discovered of await collectThreadUrls(app, 20)) {
        if (discoveryThreads.includes(discovered)) continue;
        discoveryThreads.push(discovered);
        if (discoveryThreads.length >= options.maxDiscoveryThreads) break;
      }

      let openResult = null;
      for (const candidateThread of discoveryThreads) {
        const attempt =
          options.source === "chat"
            ? await tryOpenViewerFromThreadChat(
                app,
                candidateThread,
                options.hrefContains,
                options.clickMode,
              )
            : await tryOpenViewerFromThreadMediaTab(
                app,
                candidateThread,
                options.hrefContains,
                options.clickMode,
              );
        if (attempt.ok) {
          openResult = attempt;
          break;
        }
      }

      if (!openResult || !openResult.ok) {
        const screenshotPath = path.join(options.outputDir, "media-tab-failure.png");
        await page.screenshot({ path: screenshotPath });
        const failureSummary = {
          generatedAt: new Date().toISOString(),
          threadUrl: options.threadUrl,
          sourcePage: null,
          hrefContains: options.hrefContains,
          mediaUrl: null,
          clickMode: options.clickMode,
          source: options.source,
          targetInfo: openResult?.targetInfo ?? null,
          failure:
            options.source === "chat"
              ? "no_visible_chat_media_opened_viewer"
              : "no_visible_media_tile_opened_viewer",
          triedThreads: discoveryThreads,
          screenshotPath,
        };
        fs.writeFileSync(
          path.join(options.outputDir, "summary.json"),
          JSON.stringify(failureSummary, null, 2),
          "utf8",
        );
        throw new Error(
          options.source === "chat"
            ? `No visible in-chat media opened a media viewer via ${options.clickMode} click across ${discoveryThreads.length} threads`
            : `No visible media tile opened a media viewer via ${options.clickMode} click across ${discoveryThreads.length} thread media tabs`,
        );
      }

      effectiveThreadUrl = openResult.threadUrl;
      sourcePage = openResult.sourcePage;
      targetInfo = openResult.targetInfo;
    }

    let mediaState = await waitForMediaRoute(app, 12000);
    let mediaControlsReveal = null;
    if (!mediaState.download) {
      mediaControlsReveal = await revealMediaControls(app, options.clickMode);
      await wait(600);
      mediaState = await collectMediaViewerState(app);
    }
    const screenshotPath = path.join(options.outputDir, "media-view.png");
    await page.screenshot({ path: screenshotPath });

    let downloadClick = null;
    if (mediaState.download) {
      downloadClick = await performClick(
        app,
        mediaState.download.center,
        options.clickMode,
      );
      await wait(1200);
    }

    const downloadProbe = await readDownloadProbe(app);

    const summary = {
      generatedAt: new Date().toISOString(),
      threadUrl: effectiveThreadUrl,
      sourcePage,
      hrefContains: options.hrefContains,
      mediaUrl: options.mediaUrl || null,
      clickMode: options.clickMode,
      source: options.source,
      targetInfo,
      mediaState,
      mediaControlsReveal,
      downloadClick,
      downloadProbe,
      screenshotPath,
    };

    fs.writeFileSync(
      path.join(options.outputDir, "summary.json"),
      JSON.stringify(summary, null, 2),
      "utf8",
    );

    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await app.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
