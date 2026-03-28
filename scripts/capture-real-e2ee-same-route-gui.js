const { _electron: electron } = require("playwright");
const fs = require("fs");
const path = require("path");

const DEFAULT_WINDOW_SIZE = { width: 1280, height: 900 };
const DEFAULT_CHECKPOINTS_MS = [250, 900, 1800, 3000];

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

const DOWNLOAD_SELECTOR =
  '[aria-label*="Download" i],button[aria-label*="Download" i],[aria-label*="Save" i],button[aria-label*="Save" i]';
const SHARE_SELECTOR =
  '[aria-label*="Share" i],button[aria-label*="Share" i],[aria-label*="Forward" i],button[aria-label*="Forward" i]';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function ts() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function safe(input) {
  return String(input || "")
    .replace(/^https?:\/\//, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .slice(0, 90);
}

function parseWindowSize(rawValue) {
  if (!rawValue) return { ...DEFAULT_WINDOW_SIZE };
  const match = String(rawValue).match(/^(\d+)x(\d+)$/i);
  if (!match) {
    throw new Error(`Invalid --window-size value: ${rawValue}`);
  }
  return { width: Number(match[1]), height: Number(match[2]) };
}

function parseCheckpoints(rawValue) {
  if (!rawValue) return DEFAULT_CHECKPOINTS_MS.slice();
  const values = String(rawValue)
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((value) => Number.isFinite(value) && value >= 0);
  if (values.length === 0)
    throw new Error(`Invalid --checkpoints value: ${rawValue}`);
  return [...new Set(values.map((value) => Math.round(value)))].sort(
    (a, b) => a - b,
  );
}

function parseArgs(argv) {
  const options = {
    appRoot: path.resolve(__dirname, ".."),
    outputDir: path.join(
      process.cwd(),
      "test-screenshots",
      `real-e2ee-same-route-${ts()}`,
    ),
    threadUrl: String(process.env.MESSENGER_REAL_E2EE_THREAD_URL || "").trim(),
    labelContains:
      String(
        process.env.MESSENGER_REAL_E2EE_LABEL_CONTAINS || "Open GIF",
      ).trim() || "Open GIF",
    mediaSrcContains: String(
      process.env.MESSENGER_REAL_E2EE_MEDIA_SRC_CONTAINS || "",
    ).trim(),
    excludeLabelContains: String(
      process.env.MESSENGER_REAL_E2EE_EXCLUDE_LABELS || "",
    ).trim(),
    checkpointsMs: DEFAULT_CHECKPOINTS_MS.slice(),
    windowSize: { ...DEFAULT_WINDOW_SIZE },
    expect: "any",
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--app-root") {
      options.appRoot = path.resolve(next);
      i += 1;
    } else if (arg === "--output-dir") {
      options.outputDir = path.resolve(next);
      i += 1;
    } else if (arg === "--thread-url") {
      options.threadUrl = String(next || "").trim();
      i += 1;
    } else if (arg === "--label-contains") {
      options.labelContains = String(next || "").trim();
      i += 1;
    } else if (arg === "--media-src-contains") {
      options.mediaSrcContains = String(next || "").trim();
      i += 1;
    } else if (arg === "--exclude-label-contains") {
      options.excludeLabelContains = String(next || "").trim();
      i += 1;
    } else if (arg === "--checkpoints") {
      options.checkpointsMs = parseCheckpoints(next);
      i += 1;
    } else if (arg === "--window-size") {
      options.windowSize = parseWindowSize(next);
      i += 1;
    } else if (arg === "--expect") {
      options.expect = String(next || "any")
        .trim()
        .toLowerCase();
      i += 1;
    } else if (arg === "--help") {
      console.log(
        `Usage: node scripts/capture-real-e2ee-same-route-gui.js --thread-url <url> [options]\n\nOptions:\n  --app-root <dir>              Alternate app root containing dist/main/main.js\n  --output-dir <dir>            Directory for screenshots and summary.json\n  --label-contains <text>       Prefer clickable media whose aria label contains this text\n  --media-src-contains <text>   Prefer media whose src/currentSrc contains this text\n  --exclude-label-contains <t>  Skip candidates whose label contains this text\n  --checkpoints <csv>           Capture checkpoints in ms (default: ${DEFAULT_CHECKPOINTS_MS.join(",")})\n  --window-size <WxH>           Fixed Electron window size (default: ${DEFAULT_WINDOW_SIZE.width}x${DEFAULT_WINDOW_SIZE.height})\n  --expect <mode>               any | broken | fixed\n`,
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.threadUrl) {
    throw new Error("--thread-url is required");
  }
  if (!["any", "broken", "fixed"].includes(options.expect)) {
    throw new Error(`Unknown --expect value: ${options.expect}`);
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

async function configureMainWindow(app, size) {
  return app.evaluate(({ BrowserWindow }, windowSize) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) throw new Error("No main window available");
    win.setSize(windowSize.width, windowSize.height);
    win.center();
    win.show();
    return win.getBounds();
  }, size);
}

async function captureWindow(app, outputPath) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const page = await app.firstWindow();
  await page.screenshot({ path: outputPath });
}

async function loadMessages(app) {
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

async function navigate(app, url) {
  return withPrimaryWebContents(
    app,
    async (wc, targetUrl) => {
      await wc.loadURL(targetUrl);
      return wc.getURL();
    },
    url,
  );
}

async function openTargetMedia(app, selection) {
  return withPrimaryWebContents(
    app,
    async (wc, payload) => {
      const script = `
        (async () => {
          try {
            const needle = String(${JSON.stringify(payload.labelContains || "")}).toLowerCase();
            const mediaNeedle = String(${JSON.stringify(payload.mediaSrcContains || "")}).toLowerCase();
            const excludeNeedle = String(${JSON.stringify(payload.excludeLabelContains || "")}).toLowerCase();
            const isVisible = (el) => {
            if (!(el instanceof HTMLElement)) return null;
            const style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return null;
            if (el.closest('[aria-hidden="true"]') || el.closest('[hidden]')) return null;
            const r = el.getBoundingClientRect();
            if (r.width < 20 || r.height < 20) return null;
            if (r.bottom < 0 || r.top > innerHeight) return null;
            return r;
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

            const collectCandidates = () => {
            const out = [];

            for (const media of Array.from(document.querySelectorAll('img, video, [role="img"]'))) {
              if (!(media instanceof HTMLElement)) continue;
              const rect = isVisible(media);
              if (!rect) continue;
              if (rect.width < 72 || rect.height < 72 || rect.width * rect.height < 4096) continue;
              const clickable = media.closest('a[href], [role="button"], button, [tabindex]');
              if (!(clickable instanceof HTMLElement)) continue;
              const label = (
                clickable.getAttribute('aria-label') ||
                media.getAttribute('aria-label') ||
                clickable.textContent ||
                ''
              ).trim();
              const href = clickable instanceof HTMLAnchorElement ? clickable.href : clickable.getAttribute('href') || '';
              const mediaSrc =
                media instanceof HTMLImageElement
                  ? media.currentSrc || media.src || ''
                  : media instanceof HTMLVideoElement
                    ? media.currentSrc || media.src || ''
                    : media.getAttribute('src') || media.style.backgroundImage || '';
              const lowerLabel = label.toLowerCase();
              const lowerMediaSrc = String(mediaSrc || '').toLowerCase();
              if (excludeNeedle && lowerLabel.includes(excludeNeedle)) continue;
              out.push({
                node: clickable,
                label,
                href,
                mediaSrc,
                top: rect.top,
                area: rect.width * rect.height,
                preferredLabel: needle ? lowerLabel.includes(needle) : false,
                preferredMediaSrc: mediaNeedle ? lowerMediaSrc.includes(mediaNeedle) : false,
                sameRouteCandidate: !href,
                imageLike: /\.(png|jpe?g|webp|gif)(\?|$)/i.test(mediaSrc),
              });
            }

            out.sort((a, b) => {
              if (a.preferredMediaSrc !== b.preferredMediaSrc) return a.preferredMediaSrc ? -1 : 1;
              if (a.preferredLabel !== b.preferredLabel) return a.preferredLabel ? -1 : 1;
              if (a.sameRouteCandidate !== b.sameRouteCandidate) return a.sameRouteCandidate ? -1 : 1;
              if (a.imageLike !== b.imageLike) return a.imageLike ? -1 : 1;
              if (a.area !== b.area) return b.area - a.area;
              return b.top - a.top;
            });

            return out;
          };

            const scroller = locateScroller();
            let candidate = null;
            for (let pass = 0; pass < 12; pass += 1) {
              candidate = collectCandidates()[0] || null;
              if (candidate) break;
              if (scroller instanceof HTMLElement || scroller === document.documentElement || scroller === document.scrollingElement) {
                const delta = Math.max(240, Math.round((scroller.clientHeight || innerHeight) * 0.8));
                scroller.scrollTop = Math.max(0, scroller.scrollTop - delta);
              }
              await new Promise((resolve) => setTimeout(resolve, 220));
            }

            if (!candidate) {
              return { opened: false, reason: 'no-media-candidate' };
            }

            candidate.node.scrollIntoView({ block: 'center', inline: 'nearest' });
            const r = candidate.node.getBoundingClientRect();
            const x = r.left + r.width / 2;
            const y = r.top + r.height / 2;
            for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click']) {
              candidate.node.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y }));
            }
            if (typeof candidate.node.click === 'function') candidate.node.click();

            return {
              opened: true,
              label: candidate.label,
              href: candidate.href,
              mediaSrc: candidate.mediaSrc,
            };
          } catch (error) {
            return {
              opened: false,
              reason: 'script-error',
              error: String(error && error.stack ? error.stack : error),
            };
          }
        })();
      `;
      return wc.executeJavaScript(script, true);
    },
    selection,
  );
}

async function inspectState(app) {
  return withPrimaryWebContents(
    app,
    async (wc, payload) => {
      const script = `
        (() => {
          const pick = (selector) => {
            return Array.from(document.querySelectorAll(selector)).flatMap((node) => {
              if (!(node instanceof HTMLElement)) return [];
              const style = window.getComputedStyle(node);
              if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return [];
              const rect = node.getBoundingClientRect();
              if (rect.width < 6 || rect.height < 6) return [];
              if (rect.top > 320 || rect.bottom < -160) return [];
              return [{
                label: node.getAttribute('aria-label') || '',
                left: Math.round(rect.left),
                right: Math.round(rect.right),
                top: Math.round(rect.top),
                width: Math.round(rect.width),
                height: Math.round(rect.height),
              }];
            });
          };

          const viewportWidth = window.innerWidth;
          const viewportHeight = window.innerHeight;
          const inViewport = (items) => items.filter((item) => item.right > 0 && item.left < viewportWidth && item.top < viewportHeight);
          const onScreenActions = (items) => items.filter((item) => item.left >= 0 && item.right <= viewportWidth && item.top >= 0 && item.top <= 120);
          const dedupe = (items) => {
            const seen = new Set();
            const out = [];
            for (const item of items) {
              const key = [item.label, item.left, item.right, item.top, item.width, item.height].join('|');
              if (seen.has(key)) continue;
              seen.add(key);
              out.push(item);
            }
            return out;
          };

          const close = pick(${JSON.stringify(payload.closeSelector)});
          const download = pick(${JSON.stringify(payload.downloadSelector)});
          const share = pick(${JSON.stringify(payload.shareSelector)});

          return {
            url: window.location.href,
            viewport: { width: viewportWidth, height: viewportHeight },
            classes: {
              activeCrop: document.documentElement.classList.contains('md-fb-messages-viewport-fix'),
            },
            controls: {
              close: dedupe(inViewport(close)),
              download: dedupe(inViewport(download)),
              share: dedupe(inViewport(share)),
            },
            visibleCluster: {
              close: dedupe(onScreenActions(close)),
              download: dedupe(onScreenActions(download)),
              share: dedupe(onScreenActions(share)),
            },
          };
        })();
      `;
      return wc.executeJavaScript(script, true);
    },
    {
      closeSelector: CLOSE_CONTROL_SELECTOR,
      downloadSelector: DOWNLOAD_SELECTOR,
      shareSelector: SHARE_SELECTOR,
    },
  );
}

function evaluateState(state) {
  const closeCount = state.visibleCluster.close.length;
  const downloadCount = state.visibleCluster.download.length;
  const shareCount = state.visibleCluster.share.length;

  const fixed =
    state.classes.activeCrop === true &&
    closeCount === 1 &&
    downloadCount === 1 &&
    shareCount === 1;

  let reason = "fixed";
  if (!state.classes.activeCrop) reason = "crop-inactive";
  else if (closeCount === 0) reason = "close-missing";
  else if (downloadCount === 0) reason = "download-missing";
  else if (shareCount === 0) reason = "share-missing";
  else if (closeCount > 1) reason = "close-duplicated";
  else if (downloadCount > 1) reason = "download-duplicated";
  else if (shareCount > 1) reason = "share-duplicated";

  return {
    fixed,
    reason,
    counts: { closeCount, downloadCount, shareCount },
  };
}

async function run() {
  const options = parseArgs(process.argv);
  fs.mkdirSync(options.outputDir, { recursive: true });

  const summary = {
    generatedAt: new Date().toISOString(),
    options: {
      threadUrl: options.threadUrl,
      labelContains: options.labelContains,
      checkpointsMs: options.checkpointsMs,
      expect: options.expect,
      appRoot: options.appRoot,
    },
    openResult: null,
    timeline: [],
    finalEvaluation: null,
  };

  console.log("Output folder:", options.outputDir);
  console.log("Thread:", options.threadUrl);

  const app = await electron.launch({
    args: [path.join(options.appRoot, "dist/main/main.js")],
    env: {
      ...process.env,
      NODE_ENV: "development",
      SKIP_SINGLE_INSTANCE_LOCK: "true",
    },
  });

  try {
    await wait(4500);
    await configureMainWindow(app, options.windowSize);
    await loadMessages(app);
    await navigate(app, options.threadUrl);
    await wait(1200);

    const openResult = await openTargetMedia(app, {
      labelContains: options.labelContains,
      mediaSrcContains: options.mediaSrcContains,
      excludeLabelContains: options.excludeLabelContains,
    });
    summary.openResult = openResult;
    if (!openResult.opened) {
      throw new Error(openResult.reason || "Failed to open target media");
    }

    let elapsed = 0;
    for (const checkpoint of options.checkpointsMs) {
      const waitForMs = Math.max(0, checkpoint - elapsed);
      if (waitForMs > 0) {
        await wait(waitForMs);
      }
      elapsed = checkpoint;

      const state = await inspectState(app);
      const evaluation = evaluateState(state);
      const screenshotFile = `${safe(options.threadUrl)}-${String(checkpoint).padStart(4, "0")}ms.png`;
      await captureWindow(app, path.join(options.outputDir, screenshotFile));

      summary.timeline.push({
        checkpointMs: checkpoint,
        state,
        evaluation,
        screenshotFile,
      });
      console.log(`checkpoint ${checkpoint}ms`, evaluation);
    }

    const finalEntry = summary.timeline[summary.timeline.length - 1];
    summary.finalEvaluation = finalEntry ? finalEntry.evaluation : null;

    const summaryPath = path.join(options.outputDir, "summary.json");
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
    console.log("Summary:", summaryPath);

    if (options.expect === "fixed" && !summary.finalEvaluation?.fixed) {
      throw new Error(
        `Expected fixed result, got ${summary.finalEvaluation?.reason || "unknown"}`,
      );
    }
    if (options.expect === "broken" && summary.finalEvaluation?.fixed) {
      throw new Error(
        "Expected broken result, but final checkpoint evaluated as fixed",
      );
    }
  } finally {
    await app.close().catch(() => {});
  }
}

run().catch((error) => {
  console.error("FAIL real E2EE same-route capture:", error.message || error);
  process.exit(1);
});
