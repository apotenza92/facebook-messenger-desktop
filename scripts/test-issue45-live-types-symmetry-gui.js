const { _electron: electron } = require("playwright");
const path = require("path");
const fs = require("fs");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const TARGET_MEDIA_ROUTE_TYPES = [
  "messenger_media",
  "messages_media_viewer",
  "attachment_preview",
  "photo",
  "video",
  "story",
  "reel",
];
const TARGET_THREAD_ROUTE_TYPES = ["non-e2ee", "e2ee"];
const CLOSE_CONTROL_SELECTOR = [
  '[aria-label="Close" i]',
  'button[aria-label="Close" i]',
  '[role="button"][aria-label="Close" i]',
  'a[href][aria-label="Close" i]',
  '[aria-label="Back" i]',
  'button[aria-label="Back" i]',
  '[role="button"][aria-label="Back" i]',
  'a[href][aria-label="Back" i]',
  '[aria-label*="Go back" i]',
  'button[aria-label*="Go back" i]',
  '[role="button"][aria-label*="Go back" i]',
  'a[href][aria-label*="Go back" i]',
  '[aria-label="Back to Previous Page" i]',
  'button[aria-label="Back to Previous Page" i]',
  '[role="button"][aria-label="Back to Previous Page" i]',
  'a[href][aria-label="Back to Previous Page" i]',
].join(", ");
const DEFAULT_CHECKPOINTS_MS = [150, 900, 2000];
const DEFAULT_WINDOW_SIZE = { width: 1440, height: 960 };
const THROTTLE_PRESETS = {
  off: null,
  slow3g: {
    offline: false,
    latency: 400,
    downloadThroughput: Math.floor((400 * 1024) / 8),
    uploadThroughput: Math.floor((400 * 1024) / 8),
  },
  fast3g: {
    offline: false,
    latency: 150,
    downloadThroughput: Math.floor((1.6 * 1024 * 1024) / 8),
    uploadThroughput: Math.floor((750 * 1024) / 8),
  },
};
const STEP_TIMEOUTS_MS = {
  launch: 45000,
  firstWindow: 20000,
  startupIdle: 7000,
  configureWindow: 10000,
  loadMessages: 30000,
  networkThrottle: 10000,
  navigation: 30000,
  collectThreads: 30000,
  collectMedia: 30000,
  inspectMedia: 15000,
  captureWindow: 20000,
  checkpointGrace: 5000,
  closeMedia: 10000,
  closeApp: 15000,
  debugArtifacts: 10000,
  targetedStep: 120000,
  discoveryStep: 180000,
};
const RETRYABLE_CLOSED_RE =
  /Target page, context or browser has been closed|Browser has been closed|Page closed|has been closed/i;

function ts() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function sanitizeSegment(value) {
  return (
    String(value || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "unnamed"
  );
}

function logStep(summary, phase, message, extra) {
  const entry = {
    at: new Date().toISOString(),
    phase,
    message,
    ...(extra ? { extra } : {}),
  };
  if (summary && Array.isArray(summary.progressLog)) {
    summary.progressLog.push(entry);
  }
  const suffix = extra ? ` ${JSON.stringify(extra)}` : "";
  console.log(`[Issue45Live][${phase}] ${message}${suffix}`);
}

function parseWindowSize(rawValue) {
  if (!rawValue) return { ...DEFAULT_WINDOW_SIZE };
  const match = String(rawValue).match(/^(\d+)x(\d+)$/i);
  if (!match) {
    throw new Error(
      `Invalid --window-size value: ${rawValue}. Expected WIDTHxHEIGHT.`,
    );
  }
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width < 640 ||
    height < 480
  ) {
    throw new Error(
      `Invalid --window-size value: ${rawValue}. Minimum supported size is 640x480.`,
    );
  }
  return { width, height };
}

function parseCheckpoints(rawValue) {
  if (!rawValue) return DEFAULT_CHECKPOINTS_MS.slice();
  const values = String(rawValue)
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((value) => Number.isFinite(value) && value >= 0);
  if (values.length === 0) {
    throw new Error(`Invalid --checkpoints value: ${rawValue}`);
  }
  return [...new Set(values.map((value) => Math.round(value)))].sort(
    (a, b) => a - b,
  );
}

function classifyThreadRouteType(rawUrl) {
  try {
    const pathname = new URL(rawUrl).pathname.toLowerCase();
    if (pathname.startsWith("/messages/e2ee/t/")) return "e2ee";
    if (pathname.startsWith("/messages/t/")) return "non-e2ee";
  } catch {}
  return "other";
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

function sanitizeUrlForOutput(rawUrl, includeRawTargets) {
  if (!rawUrl) return undefined;
  if (includeRawTargets) return rawUrl;

  try {
    const parsed = new URL(rawUrl);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "[redacted]";
  }
}

function sanitizeStateForOutput(state, includeRawTargets) {
  return {
    ...(includeRawTargets ? { url: state.url } : {}),
    routeType: state.routeType,
    viewport: state.viewport,
    closePosition: state.closePosition,
    classes: state.classes,
    controls: state.controls,
    controlPresence: state.controlPresence,
    actionVisibility: state.actionVisibility,
    banner: state.banner,
  };
}

function isClosedTargetError(error) {
  return RETRYABLE_CLOSED_RE.test(
    String(error && error.message ? error.message : error),
  );
}

function createStepError(message, summary, extra) {
  const error = new Error(message);
  error.issue45StepDetails = {
    phase: summary?.activePhase || null,
    lastKnownUrl: summary?.lastKnownUrl || null,
    authState: summary?.preflight || null,
    ...(extra || {}),
  };
  return error;
}

async function withTimeout(label, timeoutMs, fn, summary) {
  const startedAt = Date.now();
  logStep(summary, label, "start", { timeoutMs });
  let timer;
  try {
    const result = await Promise.race([
      Promise.resolve().then(fn),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(
            createStepError(`Timed out waiting for ${label}`, summary, {
              timeoutMs,
            }),
          );
        }, timeoutMs);
      }),
    ]);
    logStep(summary, label, "done", { durationMs: Date.now() - startedAt });
    return result;
  } catch (error) {
    logStep(summary, label, "failed", {
      durationMs: Date.now() - startedAt,
      error: String(error && error.message ? error.message : error),
    });
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function parseArgs(argv) {
  const options = {
    appRoot: process.env.MESSENGER_APP_ROOT
      ? path.resolve(process.env.MESSENGER_APP_ROOT)
      : path.resolve(__dirname, ".."),
    outputDir: path.join(
      process.cwd(),
      "test-screenshots",
      `issue45-live-types-symmetry-${ts()}`,
    ),
    label: "current",
    threadAlias: "target-thread",
    threadUrl: "",
    mediaUrl: "",
    mediaHrefContains: "",
    checkpointsMs: DEFAULT_CHECKPOINTS_MS.slice(),
    throttle: "off",
    windowSize: { ...DEFAULT_WINDOW_SIZE },
    includeRawTargets: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--output-dir") {
      options.outputDir = path.resolve(argv[++i]);
    } else if (arg === "--label") {
      options.label = String(argv[++i] || "").trim() || options.label;
    } else if (arg === "--thread-alias") {
      options.threadAlias =
        String(argv[++i] || "").trim() || options.threadAlias;
    } else if (arg === "--thread-url") {
      options.threadUrl = String(argv[++i] || "").trim();
    } else if (arg === "--media-url") {
      options.mediaUrl = String(argv[++i] || "").trim();
    } else if (arg === "--media-href-contains") {
      options.mediaHrefContains = String(argv[++i] || "").trim();
    } else if (arg === "--checkpoints") {
      options.checkpointsMs = parseCheckpoints(argv[++i]);
    } else if (arg === "--throttle") {
      options.throttle =
        String(argv[++i] || "off")
          .trim()
          .toLowerCase() || "off";
    } else if (arg === "--window-size") {
      options.windowSize = parseWindowSize(argv[++i]);
    } else if (arg === "--include-raw-targets") {
      options.includeRawTargets = true;
    } else if (arg === "--app-root") {
      options.appRoot = path.resolve(argv[++i]);
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        `Usage: node scripts/test-issue45-live-types-symmetry-gui.js [options]\n\nOptions:\n  --output-dir <dir>           Directory for screenshots and summary.json\n  --label <name>               Label used in artifact filenames and debug exports\n  --thread-alias <alias>       Friendly alias stored in summaries (default: target-thread)\n  --thread-url <url>           Exact thread URL for targeted capture mode\n  --media-url <url>            Exact media URL for targeted capture mode\n  --media-href-contains <txt>  Select a thread media link containing this text when --media-url is omitted\n  --checkpoints <csv>          Capture checkpoints in ms (default: ${DEFAULT_CHECKPOINTS_MS.join(",")})\n  --throttle <mode>            Network emulation preset: ${Object.keys(THROTTLE_PRESETS).join(", ")}\n  --window-size <WxH>          Fixed Electron window size (default: ${DEFAULT_WINDOW_SIZE.width}x${DEFAULT_WINDOW_SIZE.height})\n  --include-raw-targets        Store raw URLs in summary.json instead of redacted paths\n  --app-root <dir>             Alternate app root containing dist/main/main.js\n`,
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (
    !Object.prototype.hasOwnProperty.call(THROTTLE_PRESETS, options.throttle)
  ) {
    throw new Error(`Unknown --throttle value: ${options.throttle}`);
  }

  options.mode =
    options.threadUrl || options.mediaUrl || options.mediaHrefContains
      ? "targeted"
      : "discovery";
  return options;
}

async function waitForAppWindow(app, summary) {
  return withTimeout(
    "first window",
    STEP_TIMEOUTS_MS.firstWindow,
    async () => {
      const page = await app.firstWindow();
      if (!page)
        throw createStepError("Timed out waiting for first window", summary);
      return page;
    },
    summary,
  );
}

async function withPrimaryWebContents(
  app,
  fn,
  payload,
  summary,
  label = "withPrimaryWebContents",
  retryBudget = 1,
) {
  let lastError;
  for (let attempt = 1; attempt <= retryBudget + 1; attempt += 1) {
    try {
      return await app.evaluate(
        async ({ BrowserWindow }, { fnSource, payload }) => {
          const win = BrowserWindow.getAllWindows()[0];
          if (!win || win.isDestroyed())
            throw new Error("No main window available");
          const views =
            typeof win.getBrowserViews === "function"
              ? win.getBrowserViews()
              : [];
          const wc = views.length > 0 ? views[0].webContents : win.webContents;
          if (!wc || wc.isDestroyed())
            throw new Error("Primary webContents unavailable");
          const runner = eval(`(${fnSource})`);
          return runner(wc, payload);
        },
        { fnSource: fn.toString(), payload },
      );
    } catch (error) {
      lastError = error;
      if (isClosedTargetError(error) && attempt <= retryBudget) {
        logStep(summary, label, "retry after closed target", {
          attempt,
          error: String(error.message || error),
        });
        await wait(400);
        continue;
      }
      throw createStepError(
        `${label} failed: ${error.message || error}`,
        summary,
        { attempt, retryBudget },
      );
    }
  }
  throw createStepError(
    `${label} failed: ${lastError && lastError.message ? lastError.message : lastError}`,
    summary,
  );
}

async function configureMainWindow(app, size, summary) {
  return withTimeout(
    "configure main window",
    STEP_TIMEOUTS_MS.configureWindow,
    async () => {
      return app.evaluate(async ({ BrowserWindow }, windowSize) => {
        const win = BrowserWindow.getAllWindows()[0];
        if (!win || win.isDestroyed())
          throw new Error("No main window available");
        win.setSize(windowSize.width, windowSize.height);
        win.center();
        win.show();
        return {
          width: win.getBounds().width,
          height: win.getBounds().height,
        };
      }, size);
    },
    summary,
  );
}

async function captureWindow(
  app,
  outputPath,
  summary,
  label = "capture window",
) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  return withTimeout(
    label,
    STEP_TIMEOUTS_MS.captureWindow,
    async () => {
      const page = await waitForAppWindow(app, summary);
      if (typeof page.isClosed === "function" && page.isClosed()) {
        throw createStepError("Target page closed before screenshot", summary, {
          outputPath,
        });
      }
      try {
        await page.screenshot({ path: outputPath });
        return outputPath;
      } catch (error) {
        if (isClosedTargetError(error)) {
          throw createStepError(
            "Target page/context/browser was closed during screenshot",
            summary,
            { outputPath },
          );
        }
        throw error;
      }
    },
    summary,
  );
}

async function loadMessages(app, summary) {
  return withTimeout(
    "load Messages",
    STEP_TIMEOUTS_MS.loadMessages,
    async () => {
      const url = await withPrimaryWebContents(
        app,
        async (wc) => {
          await wc
            .loadURL("https://www.facebook.com/messages/")
            .catch(async () => {
              await wc.loadURL("https://www.facebook.com/");
            });
          return wc.getURL();
        },
        null,
        summary,
        "loadMessages.withPrimaryWebContents",
        1,
      );
      summary.lastKnownUrl = url;
      return url;
    },
    summary,
  );
}

async function navigate(
  app,
  url,
  summary,
  label = "navigate",
  retryBudget = 1,
) {
  return withTimeout(
    label,
    STEP_TIMEOUTS_MS.navigation,
    async () => {
      return withPrimaryWebContents(
        app,
        async (wc, targetUrl) => {
          await wc.loadURL(targetUrl);
          return wc.getURL();
        },
        url,
        summary,
        label,
        retryBudget,
      );
    },
    summary,
  );
}

async function collectThreadUrls(app, summary, passes = 16) {
  return withTimeout(
    "collect thread urls",
    STEP_TIMEOUTS_MS.collectThreads,
    async () => {
      const urls = await withPrimaryWebContents(
        app,
        async (wc, passCount) => {
          const script = `
          (async () => {
            const totalPasses = Number(${JSON.stringify(passCount)} || 16);
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
            const scrollerCandidates = Array.from(document.querySelectorAll('div'))
              .filter((el) => el.scrollHeight > el.clientHeight + 120)
              .sort((a, b) => b.clientHeight - a.clientHeight);
            const scroller = scrollerCandidates[0] || document.scrollingElement || document.documentElement;

            const collect = () => {
              const anchors = Array.from(document.querySelectorAll('a[href]'));
              for (const a of anchors) {
                const normalized = normalize(a.getAttribute('href'));
                if (normalized) urls.add(normalized);
              }
            };

            collect();
            for (let i = 0; i < totalPasses; i++) {
              scroller.scrollTop = Math.min(scroller.scrollTop + 500, scroller.scrollHeight);
              await new Promise((r) => setTimeout(r, 160));
              collect();
            }
            scroller.scrollTop = 0;
            return Array.from(urls);
          })();
        `;
          return wc.executeJavaScript(script, true);
        },
        passes,
        summary,
        "collectThreadUrls.execute",
        1,
      );

      return urls.map((url) => ({
        url,
        routeType: classifyThreadRouteType(url),
        normalizedThreadKey: normalizeThreadKey(url),
      }));
    },
    summary,
  );
}

async function collectMediaLinksInThread(app, summary, passes = 8) {
  return withTimeout(
    "collect media links",
    STEP_TIMEOUTS_MS.collectMedia,
    async () => {
      return withPrimaryWebContents(
        app,
        async (wc, passCount) => {
          const script = `
          (async () => {
            const totalPasses = Number(${JSON.stringify(passCount)} || 8);

            const routeTypeFromUrl = (raw) => {
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

            const isGoodMediaHref = (raw) => {
              if (!raw) return false;
              const lower = raw.toLowerCase();
              if (lower.includes('/reel/?s=tab') || lower === '/reel/' || lower === '/reel') {
                return false;
              }
              return routeTypeFromUrl(raw) !== null;
            };

            const links = new Map();
            const collect = () => {
              const anchors = Array.from(document.querySelectorAll('a[href]'));
              for (const a of anchors) {
                const href = a.getAttribute('href') || '';
                if (!isGoodMediaHref(href)) continue;
                try {
                  const abs = new URL(href, window.location.origin).href;
                  const routeType = routeTypeFromUrl(abs);
                  if (!routeType) continue;
                  if (!links.has(abs)) {
                    links.set(abs, { url: abs, routeType });
                  }
                } catch {}
              }
            };

            const scrollers = Array.from(document.querySelectorAll('div'))
              .filter((el) => el.scrollHeight > el.clientHeight + 200)
              .sort((a, b) => b.clientHeight - a.clientHeight);
            const scroller = scrollers[0] || document.scrollingElement || document.documentElement;

            collect();
            for (let i = 0; i < totalPasses; i++) {
              scroller.scrollTop = Math.min(scroller.scrollTop + 700, scroller.scrollHeight);
              await new Promise((r) => setTimeout(r, 180));
              collect();
            }
            scroller.scrollTop = 0;
            return Array.from(links.values());
          })();
        `;
          return wc.executeJavaScript(script, true);
        },
        passes,
        summary,
        "collectMediaLinks.execute",
        1,
      );
    },
    summary,
  );
}

async function inspectCurrentMedia(app, summary) {
  return withTimeout(
    "inspect current media",
    STEP_TIMEOUTS_MS.inspectMedia,
    async () => {
      const state = await withPrimaryWebContents(
        app,
        async (wc, selector) => {
          const script = `
          (() => {
            const closeSelector = ${JSON.stringify(selector)};
            const pick = (selectors) => {
              const nodes = Array.from(document.querySelectorAll(selectors));
              const out = [];
              for (const node of nodes) {
                const el = node;
                const style = window.getComputedStyle(el);
                if (style.display === 'none' || style.visibility === 'hidden') continue;
                const r = el.getBoundingClientRect();
                if (r.width < 6 || r.height < 6) continue;
                if (r.top > 360 || r.bottom < -160) continue;
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

            const bannerSelectors = [
              '[role="banner"]',
              'header',
              '[aria-label="Facebook" i]',
              'a[aria-label="Facebook" i]',
              'a[href="/"]',
            ].join(', ');
            const collectVisibleTopNodes = (selectors) => {
              return Array.from(document.querySelectorAll(selectors)).flatMap((node) => {
                const el = node;
                if (!(el instanceof Element)) return [];
                const style = window.getComputedStyle(el);
                if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return [];
                const r = el.getBoundingClientRect();
                if (r.width < 6 || r.height < 6) return [];
                if (r.bottom < -20 || r.top > 120) return [];
                return [{
                  label: el.getAttribute('aria-label') || el.textContent?.trim() || el.tagName,
                  top: Math.round(r.top),
                  left: Math.round(r.left),
                  width: Math.round(r.width),
                  height: Math.round(r.height),
                }];
              });
            };

            const controls = {
              close: pick(closeSelector),
              download: pick('[aria-label*="Download" i],button[aria-label*="Download" i],[aria-label*="Save" i],button[aria-label*="Save" i]'),
              share: pick('[aria-label*="Share" i],button[aria-label*="Share" i],[aria-label*="Forward" i],button[aria-label*="Forward" i]'),
              navigation: pick('[aria-label*="Previous" i],[aria-label*="Next" i],[aria-label*="previous" i],[aria-label*="next" i]'),
            };

            const path = (() => {
              try { return new URL(window.location.href).pathname.toLowerCase(); }
              catch { return window.location.pathname.toLowerCase(); }
            })();

            const routeType =
              path.startsWith('/messenger_media') ? 'messenger_media' :
              path.startsWith('/messages/media_viewer') ? 'messages_media_viewer' :
              path.startsWith('/messages/attachment_preview') ? 'attachment_preview' :
              path.startsWith('/photo') || path.startsWith('/photos') ? 'photo' :
              path.startsWith('/video') || path.startsWith('/watch') ? 'video' :
              path.startsWith('/story') || path.startsWith('/stories') ? 'story' :
              path.startsWith('/reel') || path.startsWith('/reels') ? 'reel' :
              path.startsWith('/messages/e2ee/t/') ? 'e2ee-thread' :
              path.startsWith('/messages/t/') ? 'thread' :
              'other';

            const firstClose = controls.close[0] || null;
            const closePosition = firstClose
              ? (firstClose.left < window.innerWidth * 0.5 ? 'left' : 'right')
              : 'unknown';

            const bannerNodes = collectVisibleTopNodes(bannerSelectors);
            const facebookLogoVisible = bannerNodes.some((node) => /facebook/i.test(String(node.label || '')));
            const bannerVisible = bannerNodes.length > 0;
            const actionVisibility = {
              close: controls.close.length > 0,
              download: controls.download.length > 0,
              share: controls.share.length > 0,
              navigation: controls.navigation.length > 0,
            };

            return {
              url: window.location.href,
              routeType,
              viewport: {
                width: window.innerWidth,
                height: window.innerHeight,
                scrollbarWidth: Math.max(0, window.innerWidth - document.documentElement.clientWidth),
              },
              closePosition,
              controls,
              controlPresence: {
                close: controls.close.length > 0,
                download: controls.download.length > 0,
                share: controls.share.length > 0,
                navigation: controls.navigation.length > 0,
              },
              actionVisibility: {
                ...actionVisibility,
                anyMediaActions: actionVisibility.close || actionVisibility.download || actionVisibility.share || actionVisibility.navigation,
              },
              banner: {
                visible: bannerVisible,
                facebookLogoVisible,
                nodes: bannerNodes.slice(0, 8),
              },
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
        CLOSE_CONTROL_SELECTOR,
        summary,
        "inspectCurrentMedia.execute",
        1,
      );
      summary.lastKnownUrl =
        state && state.url ? state.url : summary.lastKnownUrl;
      return state;
    },
    summary,
  );
}

function approx(a, b, tolerance = 5) {
  return (
    typeof a === "number" &&
    typeof b === "number" &&
    Math.abs(a - b) <= tolerance
  );
}

function evaluateSymmetry(state) {
  const close = state.controls.close[0] || null;
  const download = state.controls.download[0] || null;
  const share = state.controls.share[0] || null;

  if (!close || !download || !share) {
    return {
      ok: false,
      reason: "missing_controls",
      metrics: null,
    };
  }

  const closeLeftGap = close.left;
  const closeRightGap = Math.max(0, state.viewport.width - close.right);
  const downloadRightGap = Math.max(0, state.viewport.width - download.right);
  const shareRightGap = Math.max(0, state.viewport.width - share.right);

  const isLeftLayout =
    state.closePosition === "left" || state.classes.leftDismiss === true;

  const expectedDownloadRight = isLeftLayout
    ? closeLeftGap
    : closeRightGap + 48;
  const expectedShareRight = isLeftLayout
    ? closeLeftGap + 48
    : closeRightGap + 96;

  const topAligned =
    approx(download.top, close.top) && approx(share.top, close.top);
  const rightAligned =
    approx(downloadRightGap, expectedDownloadRight) &&
    approx(shareRightGap, expectedShareRight);

  return {
    ok: topAligned && rightAligned,
    reason: topAligned && rightAligned ? "ok" : "misaligned",
    metrics: {
      closeTop: close.top,
      downloadTop: download.top,
      shareTop: share.top,
      closeLeftGap,
      closeRightGap,
      downloadRightGap,
      shareRightGap,
      expectedDownloadRight,
      expectedShareRight,
      isLeftLayout,
    },
  };
}

async function closeMedia(app, summary) {
  return withTimeout(
    "close media",
    STEP_TIMEOUTS_MS.closeMedia,
    async () => {
      return withPrimaryWebContents(
        app,
        async (wc, selector) => {
          const script = `
          (() => {
            const selector = ${JSON.stringify(selector)};
            const node = document.querySelector(selector);
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
        CLOSE_CONTROL_SELECTOR,
        summary,
        "closeMedia.execute",
        1,
      );
    },
    summary,
  );
}

function classifyAuthState(url) {
  const lower = String(url || "").toLowerCase();
  if (!lower)
    return { ok: false, kind: "blank", message: "No URL was loaded." };
  if (lower.includes("/login") || lower.includes("recover")) {
    return {
      ok: false,
      kind: "login",
      message:
        "Messenger session is not logged in. Complete login before re-running.",
    };
  }
  if (lower.includes("checkpoint") || lower.includes("challenge")) {
    return {
      ok: false,
      kind: "challenge",
      message:
        "Facebook login challenge/checkpoint is blocking capture. Resolve the checkpoint manually, then re-run.",
    };
  }
  if (lower.includes("/messages") || lower.includes("/messenger")) {
    return { ok: true, kind: "messages", message: "Messages surface reached." };
  }
  return {
    ok: false,
    kind: "unexpected",
    message:
      "App did not land on Messenger. Follow docs/issue45-allen-evidence.md: ensure a real logged-in Messenger session is open before running live capture.",
  };
}

async function gatherPreflight(app, summary) {
  return withTimeout(
    "session preflight",
    12000,
    async () => {
      const state = await withPrimaryWebContents(
        app,
        async (wc) => {
          const currentUrl = wc.getURL();
          const html = await wc
            .executeJavaScript(
              `
          (() => ({
            href: window.location.href,
            title: document.title || '',
            hasPasswordInput: Boolean(document.querySelector('input[type="password"]')),
            hasLoginForm: Boolean(document.querySelector('form input[name="email"], form input[name="pass"]')),
            bodyTextSample: (document.body && document.body.innerText ? document.body.innerText : '').slice(0, 500),
          }))();
        `,
              true,
            )
            .catch(() => ({
              href: currentUrl,
              title: "",
              hasPasswordInput: false,
              hasLoginForm: false,
              bodyTextSample: "",
            }));
          return { url: currentUrl, ...html };
        },
        null,
        summary,
        "preflight.execute",
        1,
      );

      const classified = classifyAuthState(state.url || state.href);
      if (state.hasPasswordInput || state.hasLoginForm) {
        classified.ok = false;
        classified.kind = "login";
        classified.message =
          "Messenger session appears logged out (login form detected). Follow docs/issue45-allen-evidence.md and complete login manually first.";
      }

      return {
        ...state,
        classification: classified,
      };
    },
    summary,
  );
}

async function captureTimelineWithScreenshots(app, options, summary) {
  const timeline = [];
  let elapsed = 0;

  for (const checkpoint of options.checkpointsMs) {
    const waitFor = Math.max(0, checkpoint - elapsed);
    logStep(summary, "checkpoint", "awaiting checkpoint", {
      checkpointMs: checkpoint,
      waitForMs: waitFor,
      threadAlias: options.threadAlias,
      mode: options.mode,
    });
    if (waitFor > 0) {
      await withTimeout(
        `checkpoint ${checkpoint}ms wait`,
        waitFor + STEP_TIMEOUTS_MS.checkpointGrace,
        async () => {
          await wait(waitFor);
        },
        summary,
      );
      elapsed = checkpoint;
    }

    const state = await inspectCurrentMedia(app, summary);
    const screenshotFile = `${options.baseName}-${checkpoint}ms.png`;
    const screenshotPath = path.join(options.outputDir, screenshotFile);
    await captureWindow(
      app,
      screenshotPath,
      summary,
      `capture checkpoint ${checkpoint}ms`,
    );
    timeline.push({
      atMs: checkpoint,
      screenshotFile,
      routeType: state.routeType,
      classes: state.classes,
      banner: state.banner,
      actionVisibility: state.actionVisibility,
      controlPresence: state.controlPresence,
      ...(options.includeRawTargets ? { url: state.url } : {}),
    });
    logStep(summary, "checkpoint", "captured checkpoint", {
      checkpointMs: checkpoint,
      screenshotFile,
      routeType: state.routeType,
      bannerVisible: state.banner?.visible,
      facebookLogoVisible: state.banner?.facebookLogoVisible,
    });
  }

  return timeline;
}

function createCoverageSummary(findings) {
  const coverage = {};

  for (const threadRouteType of TARGET_THREAD_ROUTE_TYPES) {
    coverage[threadRouteType] = {};
    for (const mediaRouteType of TARGET_MEDIA_ROUTE_TYPES) {
      const matches = findings.filter(
        (finding) =>
          finding.sourceThreadRouteType === threadRouteType &&
          finding.expectedMediaRouteType === mediaRouteType,
      );
      coverage[threadRouteType][mediaRouteType] = {
        total: matches.length,
        ok: matches.filter((finding) => finding.status === "ok").length,
        needsReview: matches.filter(
          (finding) => finding.status === "needs_review",
        ).length,
        missing: matches.filter((finding) => finding.status === "missing")
          .length,
      };
    }
  }

  return coverage;
}

async function waitForFile(filePath, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(filePath)) return true;
    await wait(200);
  }
  return fs.existsSync(filePath);
}

async function runTargetedCapture(app, options, summary) {
  return withTimeout(
    "targeted capture",
    STEP_TIMEOUTS_MS.targetedStep,
    async () => {
      if (options.threadUrl) {
        logStep(summary, "targeted", "navigating to thread", {
          threadAlias: options.threadAlias,
          threadUrl: sanitizeUrlForOutput(
            options.threadUrl,
            options.includeRawTargets,
          ),
        });
        const threadResult = await navigate(
          app,
          options.threadUrl,
          summary,
          "navigate to thread URL",
        );
        summary.threadNavigation = {
          routeType: classifyThreadRouteType(threadResult),
          normalizedThreadKey: normalizeThreadKey(threadResult),
          ...(options.includeRawTargets ? { url: threadResult } : {}),
        };
        summary.lastKnownUrl = threadResult;
        await wait(900);
      }

      let selectedMediaUrl = options.mediaUrl || "";
      let mediaDiscovery = null;

      if (!selectedMediaUrl) {
        logStep(summary, "targeted", "discovering media links in thread", {
          threadAlias: options.threadAlias,
          selectionMode: options.mediaHrefContains
            ? "contains-match"
            : "first-candidate",
        });
        const links = await collectMediaLinksInThread(app, summary, 8);
        const normalizedNeedle = options.mediaHrefContains.toLowerCase();
        const matched = normalizedNeedle
          ? links.find((link) =>
              link.url.toLowerCase().includes(normalizedNeedle),
            )
          : links[0];

        mediaDiscovery = {
          candidateCount: links.length,
          selectedRouteType: matched?.routeType || null,
          selectionMode: normalizedNeedle
            ? "contains-match"
            : "first-candidate",
          ...(options.includeRawTargets
            ? {
                candidates: links,
                selectedMediaUrl: matched?.url,
              }
            : {}),
        };

        if (!matched) {
          throw createStepError(
            options.mediaHrefContains
              ? `No media link matched --media-href-contains ${options.mediaHrefContains}`
              : "No media link found in the targeted thread",
            summary,
            { mediaDiscovery },
          );
        }

        selectedMediaUrl = matched.url;
      }

      logStep(summary, "targeted", "navigating to media", {
        threadAlias: options.threadAlias,
        mediaUrl: sanitizeUrlForOutput(
          selectedMediaUrl,
          options.includeRawTargets,
        ),
      });
      const resultingMediaUrl = await navigate(
        app,
        selectedMediaUrl,
        summary,
        "navigate to media URL",
      );
      summary.lastKnownUrl = resultingMediaUrl;

      const baseName = `${sanitizeSegment(options.label)}-${sanitizeSegment(options.threadAlias)}`;
      const timeline = await captureTimelineWithScreenshots(
        app,
        {
          checkpointsMs: options.checkpointsMs,
          outputDir: options.outputDir,
          baseName,
          includeRawTargets: options.includeRawTargets,
          mode: options.mode,
          threadAlias: options.threadAlias,
        },
        summary,
      );
      const finalState = await inspectCurrentMedia(app, summary);
      const evaluation = evaluateSymmetry(finalState);

      summary.target = {
        threadAlias: options.threadAlias,
        threadRouteType:
          summary.threadNavigation?.routeType ||
          classifyThreadRouteType(options.threadUrl),
        targets: {
          threadUrl: sanitizeUrlForOutput(
            options.threadUrl,
            options.includeRawTargets,
          ),
          mediaUrl: sanitizeUrlForOutput(
            selectedMediaUrl,
            options.includeRawTargets,
          ),
          resultingMediaUrl: sanitizeUrlForOutput(
            resultingMediaUrl,
            options.includeRawTargets,
          ),
          mediaHrefContains: options.mediaHrefContains || undefined,
        },
        mediaDiscovery,
      };
      summary.timeline = timeline;
      summary.finalState = sanitizeStateForOutput(
        finalState,
        options.includeRawTargets,
      );
      summary.evaluation = evaluation;
      summary.status = evaluation.ok ? "ok" : "needs_review";
      logStep(summary, "targeted", "targeted capture complete", {
        evaluation: evaluation.reason,
        routeType: finalState.routeType,
        facebookLogoVisible: finalState.banner?.facebookLogoVisible,
        bannerVisible: finalState.banner?.visible,
      });
      return summary;
    },
    summary,
  );
}

async function runDiscoveryCapture(app, options, summary) {
  return withTimeout(
    "discovery capture",
    STEP_TIMEOUTS_MS.discoveryStep,
    async () => {
      const findings = [];
      const candidateBuckets = new Map();
      const threadEntries = await collectThreadUrls(app, summary, 18);
      summary.threadEntriesDiscovered = threadEntries.length;
      logStep(summary, "discovery", "thread discovery complete", {
        count: threadEntries.length,
      });

      for (const thread of threadEntries.slice(0, 40)) {
        if (!TARGET_THREAD_ROUTE_TYPES.includes(thread.routeType)) {
          continue;
        }

        logStep(summary, "discovery", "scanning thread for media", {
          routeType: thread.routeType,
          threadUrl: sanitizeUrlForOutput(
            thread.url,
            options.includeRawTargets,
          ),
        });
        await navigate(
          app,
          thread.url,
          summary,
          "navigate discovery thread",
        ).catch((error) => {
          logStep(summary, "discovery", "thread navigation failed", {
            error: String(error.message || error),
          });
        });
        await wait(900);
        const links = await collectMediaLinksInThread(app, summary, 8);
        for (const link of links) {
          const bucketKey = `${thread.routeType}:${link.routeType}`;
          if (!candidateBuckets.has(bucketKey)) {
            candidateBuckets.set(bucketKey, []);
          }
          const bucket = candidateBuckets.get(bucketKey);
          if (!bucket.some((item) => item.url === link.url)) {
            bucket.push({
              ...link,
              sourceThreadUrl: thread.url,
              sourceThreadRouteType: thread.routeType,
              sourceThreadNormalizedKey: thread.normalizedThreadKey,
            });
          }
        }
      }

      for (const threadRouteType of TARGET_THREAD_ROUTE_TYPES) {
        for (const mediaRouteType of TARGET_MEDIA_ROUTE_TYPES) {
          const bucketKey = `${threadRouteType}:${mediaRouteType}`;
          const candidates = candidateBuckets.get(bucketKey) || [];

          if (candidates.length === 0) {
            findings.push({
              sourceThreadRouteType: threadRouteType,
              expectedMediaRouteType: mediaRouteType,
              status: "missing",
              reason: "no_link_found",
            });
            continue;
          }

          let captured = false;
          for (const candidate of candidates.slice(0, 6)) {
            logStep(summary, "discovery", "capturing candidate", {
              sourceThreadRouteType: candidate.sourceThreadRouteType,
              expectedMediaRouteType: mediaRouteType,
              candidateUrl: sanitizeUrlForOutput(
                candidate.url,
                options.includeRawTargets,
              ),
            });
            await navigate(
              app,
              candidate.url,
              summary,
              "navigate discovery media",
            ).catch((error) => {
              logStep(summary, "discovery", "candidate navigation failed", {
                error: String(error.message || error),
              });
            });
            const baseName = `${String(findings.length + 1).padStart(2, "0")}-${sanitizeSegment(options.label)}-${sanitizeSegment(threadRouteType)}-${sanitizeSegment(mediaRouteType)}`;
            const timeline = await captureTimelineWithScreenshots(
              app,
              {
                checkpointsMs: options.checkpointsMs,
                outputDir: options.outputDir,
                baseName,
                includeRawTargets: options.includeRawTargets,
                mode: options.mode,
                threadAlias: `${threadRouteType}:${mediaRouteType}`,
              },
              summary,
            );
            const state = await inspectCurrentMedia(app, summary);
            const evalResult = evaluateSymmetry(state);

            findings.push({
              sourceThreadRouteType: candidate.sourceThreadRouteType,
              expectedMediaRouteType: mediaRouteType,
              sourceThreadNormalizedKey: candidate.sourceThreadNormalizedKey,
              status: evalResult.ok ? "ok" : "needs_review",
              timeline,
              resultingMediaRouteType: state.routeType,
              state: sanitizeStateForOutput(state, options.includeRawTargets),
              evaluation: evalResult,
              ...(options.includeRawTargets
                ? {
                    sourceThreadUrl: candidate.sourceThreadUrl,
                    candidateUrl: candidate.url,
                    resultingMediaUrl: state.url,
                  }
                : {}),
            });

            captured = true;
            await closeMedia(app, summary).catch((error) => {
              logStep(summary, "discovery", "close media failed", {
                error: String(error.message || error),
              });
            });
            await wait(500);
            break;
          }

          if (!captured) {
            findings.push({
              sourceThreadRouteType: threadRouteType,
              expectedMediaRouteType: mediaRouteType,
              status: "missing",
              reason: "open_failed",
            });
          }
        }
      }

      const coverage = createCoverageSummary(findings);
      const routeTypeCoverage = {
        "non-e2ee": findings.filter(
          (finding) =>
            finding.sourceThreadRouteType === "non-e2ee" &&
            finding.status !== "missing",
        ).length,
        e2ee: findings.filter(
          (finding) =>
            finding.sourceThreadRouteType === "e2ee" &&
            finding.status !== "missing",
        ).length,
      };
      const notes = [];
      if (routeTypeCoverage.e2ee === 0) {
        notes.push(
          "No real E2EE media candidate was available for this run. Coverage is incomplete for parity verification.",
        );
      }
      if (routeTypeCoverage["non-e2ee"] === 0) {
        notes.push(
          "No real non-E2EE media candidate was available for this run. Coverage is incomplete for parity verification.",
        );
      }

      summary.findings = findings;
      summary.coverage = coverage;
      summary.routeTypeCoverage = routeTypeCoverage;
      summary.notes = notes;
      summary.status = findings.some(
        (finding) => finding.status === "needs_review",
      )
        ? "needs_review"
        : findings.some((finding) => finding.status === "missing")
          ? "incomplete"
          : "ok";
      return summary;
    },
    summary,
  );
}

function persistSummary(options, summary) {
  const summaryPath = path.join(options.outputDir, "summary.json");
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  console.log("Summary path:", summaryPath);
  return summaryPath;
}

async function run() {
  const options = parseArgs(process.argv.slice(2));
  fs.mkdirSync(options.outputDir, { recursive: true });

  const expectedDebugReport = path.join(
    options.outputDir,
    `${sanitizeSegment(options.label)}-debug-report.json`,
  );
  const expectedDebugLog = path.join(
    options.outputDir,
    `${sanitizeSegment(options.label)}-media-overlay-debug.ndjson`,
  );

  const summary = {
    generatedAt: new Date().toISOString(),
    appRoot: options.appRoot,
    mode: options.mode,
    label: options.label,
    threadAlias: options.threadAlias,
    outputDir: options.outputDir,
    checkpointsMs: options.checkpointsMs,
    throttle: options.throttle,
    status: "running",
    activePhase: "init",
    lastKnownUrl: null,
    progressLog: [],
    debugArtifacts: {
      expectedReportFile: path.basename(expectedDebugReport),
      expectedNdjsonFile: path.basename(expectedDebugLog),
    },
  };

  logStep(summary, "init", "starting live type symmetry run", {
    outputDir: options.outputDir,
    appRoot: options.appRoot,
    mode: options.mode,
    label: options.label,
    threadAlias: options.threadAlias,
    checkpoints: options.checkpointsMs,
    throttle: options.throttle,
  });

  let app;
  try {
    summary.activePhase = "launch";
    app = await withTimeout(
      "electron launch",
      STEP_TIMEOUTS_MS.launch,
      async () => {
        return electron.launch({
          args: [path.join(options.appRoot, "dist/main/main.js")],
          env: {
            ...process.env,
            NODE_ENV: "development",
            SKIP_SINGLE_INSTANCE_LOCK: "true",
            MESSENGER_ISSUE45_TEST_EXPORT_DIR: options.outputDir,
            MESSENGER_ISSUE45_TEST_EXPORT_LABEL: sanitizeSegment(options.label),
            MESSENGER_ISSUE45_TEST_RESET_DEBUG_LOG: "1",
          },
        });
      },
      summary,
    );

    summary.activePhase = "startup-wait";
    await withTimeout(
      "startup idle wait",
      STEP_TIMEOUTS_MS.startupIdle,
      async () => {
        await wait(4500);
      },
      summary,
    );

    summary.activePhase = "window";
    await waitForAppWindow(app, summary);
    summary.appliedWindowSize = await configureMainWindow(
      app,
      options.windowSize,
      summary,
    );

    summary.activePhase = "load-messages";
    summary.loadedUrl = await loadMessages(app, summary);
    summary.lastKnownUrl = summary.loadedUrl;

    summary.activePhase = "preflight";
    summary.preflight = await gatherPreflight(app, summary);
    summary.lastKnownUrl = summary.preflight.url || summary.lastKnownUrl;
    if (!summary.preflight.classification.ok) {
      throw createStepError(summary.preflight.classification.message, summary, {
        preflight: summary.preflight,
      });
    }

    summary.activePhase = "throttle";
    summary.networkThrottle = await withTimeout(
      "configure network throttling",
      STEP_TIMEOUTS_MS.networkThrottle,
      async () => {
        if (options.throttle === "off") {
          return withPrimaryWebContents(
            app,
            async (wc) => {
              try {
                if (wc.debugger.isAttached()) {
                  await wc.debugger.sendCommand(
                    "Network.emulateNetworkConditions",
                    {
                      offline: false,
                      latency: 0,
                      downloadThroughput: -1,
                      uploadThroughput: -1,
                    },
                  );
                  await wc.debugger.sendCommand("Network.disable");
                  wc.debugger.detach();
                }
                return { applied: true, mode: "off" };
              } catch (error) {
                return {
                  applied: false,
                  mode: "off",
                  error: String(error && error.message ? error.message : error),
                };
              }
            },
            null,
            summary,
            "configureNetwork.off",
            1,
          );
        }

        const preset = THROTTLE_PRESETS[options.throttle];
        return withPrimaryWebContents(
          app,
          async (wc, payload) => {
            try {
              if (!wc.debugger.isAttached()) {
                wc.debugger.attach("1.3");
              }
              await wc.debugger.sendCommand("Network.enable");
              await wc.debugger.sendCommand(
                "Network.emulateNetworkConditions",
                payload.preset,
              );
              return {
                applied: true,
                mode: payload.mode,
                preset: payload.preset,
              };
            } catch (error) {
              return {
                applied: false,
                mode: payload.mode,
                preset: payload.preset,
                error: String(error && error.message ? error.message : error),
              };
            }
          },
          { mode: options.throttle, preset },
          summary,
          "configureNetwork.on",
          1,
        );
      },
      summary,
    );

    summary.activePhase =
      options.mode === "targeted" ? "targeted" : "discovery";
    if (options.mode === "targeted") {
      await runTargetedCapture(app, options, summary);
    } else {
      await runDiscoveryCapture(app, options, summary);
    }

    summary.status = summary.status === "running" ? "ok" : summary.status;
    summary.activePhase = "complete";
    persistSummary(options, summary);
    return options.outputDir;
  } catch (err) {
    summary.status = "failed";
    summary.failure = {
      message: err && err.message ? err.message : String(err),
      phase: summary.activePhase,
      lastKnownUrl: summary.lastKnownUrl,
      preflight: summary.preflight || null,
      details: err && err.issue45StepDetails ? err.issue45StepDetails : null,
    };
    persistSummary(options, summary);
    throw err;
  } finally {
    summary.activePhase = "shutdown";
    if (app) {
      await withTimeout(
        "close electron app",
        STEP_TIMEOUTS_MS.closeApp,
        async () => {
          await app.close().catch(() => {});
        },
        summary,
      ).catch(() => {});
    }
    await withTimeout(
      "wait for debug report",
      STEP_TIMEOUTS_MS.debugArtifacts,
      async () => {
        await waitForFile(
          expectedDebugReport,
          STEP_TIMEOUTS_MS.debugArtifacts,
        ).catch(() => false);
      },
      summary,
    ).catch(() => {});
    await withTimeout(
      "wait for debug ndjson",
      STEP_TIMEOUTS_MS.debugArtifacts,
      async () => {
        await waitForFile(
          expectedDebugLog,
          STEP_TIMEOUTS_MS.debugArtifacts,
        ).catch(() => false);
      },
      summary,
    ).catch(() => {});
    summary.debugArtifacts.reportFound = fs.existsSync(expectedDebugReport);
    summary.debugArtifacts.ndjsonFound = fs.existsSync(expectedDebugLog);
    persistSummary(options, summary);
  }
}

run().catch((err) => {
  console.error("FAIL live type symmetry test:", err.message || err);
  if (err && err.issue45StepDetails) {
    console.error(
      "Failure details:",
      JSON.stringify(err.issue45StepDetails, null, 2),
    );
  }
  process.exit(1);
});
