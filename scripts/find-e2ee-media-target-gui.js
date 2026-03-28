const { _electron: electron } = require("playwright");
const fs = require("fs");
const path = require("path");

const MEDIA_ROUTE_TYPES = new Set([
  "messenger_media",
  "messages_media_viewer",
  "attachment_preview",
  "photo",
  "video",
  "story",
]);

const PREFERRED_E2EE_THREAD_IDS = [
  "8304689812901122",
  "8918269438189018",
  "7938994412885440",
  "1887152455510939",
  "8500708420055795",
  "1551184729512566",
];

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

function parseArgs(argv) {
  const args = {
    maxThreads: 10,
    maxAttempts: 24,
    appRoot: process.cwd(),
    outputDir: path.join(
      process.cwd(),
      "test-screenshots",
      `find-e2ee-media-target-${ts()}`,
    ),
    threadUrl: "",
    preferLabelContains: [],
    excludeLabelContains: [],
    preferRouteTypes: [],
    excludeRouteTypes: [],
    expect: "any",
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === "--max-threads") {
      args.maxThreads = Math.max(
        1,
        Number.parseInt(next, 10) || args.maxThreads,
      );
      i += 1;
    } else if (arg === "--max-attempts") {
      args.maxAttempts = Math.max(
        1,
        Number.parseInt(next, 10) || args.maxAttempts,
      );
      i += 1;
    } else if (arg === "--output-dir") {
      args.outputDir = path.resolve(next);
      i += 1;
    } else if (arg === "--app-root") {
      args.appRoot = path.resolve(next);
      i += 1;
    } else if (arg === "--thread-url") {
      args.threadUrl = String(next || "");
      i += 1;
    } else if (arg === "--prefer-label-contains") {
      args.preferLabelContains = String(next || "")
        .split(",")
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean);
      i += 1;
    } else if (arg === "--exclude-label-contains") {
      args.excludeLabelContains = String(next || "")
        .split(",")
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean);
      i += 1;
    } else if (arg === "--prefer-route-types") {
      args.preferRouteTypes = String(next || "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      i += 1;
    } else if (arg === "--exclude-route-types") {
      args.excludeRouteTypes = String(next || "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      i += 1;
    } else if (arg === "--expect") {
      args.expect = String(next || "any")
        .trim()
        .toLowerCase();
      i += 1;
    } else if (arg === "--help") {
      console.log(
        `Usage: node scripts/find-e2ee-media-target-gui.js [options]\n\nOptions:\n  --max-threads <n>              Max E2EE threads to search (default: ${args.maxThreads})\n  --max-attempts <n>             Max click/scroll attempts per thread (default: ${args.maxAttempts})\n  --thread-url <url>             Search only one specific E2EE thread\n  --prefer-label-contains <csv>  Prefer labels containing these substrings\n  --exclude-label-contains <csv> Skip labels containing these substrings\n  --prefer-route-types <csv>     Prefer route types like photo,video,messenger_media\n  --exclude-route-types <csv>    Skip route types like reel,story\n  --expect <mode>                any | fixed | broken\n  --output-dir <dir>             Directory for screenshots and summary.json\n  --app-root <dir>               Alternate app root containing dist/main/main.js\n`,
      );
      process.exit(0);
    }
  }

  if (!["any", "fixed", "broken"].includes(args.expect)) {
    throw new Error(`Unknown --expect value: ${args.expect}`);
  }

  return args;
}

function classifyThreadRouteType(rawUrl) {
  try {
    const pathname = new URL(rawUrl).pathname.toLowerCase();
    if (pathname.startsWith("/messages/e2ee/t/")) return "e2ee";
    if (pathname.startsWith("/messages/t/")) return "non-e2ee";
  } catch {}
  return "other";
}

function extractThreadId(rawUrl) {
  try {
    const match = new URL(rawUrl).pathname.match(
      /^\/messages\/(?:e2ee\/)?t\/([^/]+)/i,
    );
    return match?.[1] || "";
  } catch {
    return "";
  }
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

    const browserWindowCount = await app
      .evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
      .catch(() => 0);
    if (browserWindowCount > 0) {
      const refreshedWindows = app.windows();
      if (refreshedWindows.length > 0) {
        return refreshedWindows[0];
      }
    }

    await wait(250);
  }

  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for any Electron window`,
  );
}

async function captureWindow(app, outPath) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const page = await waitForAnyWindow(app);
  await page.screenshot({ path: outPath });
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

async function navigate(app, url) {
  return withPrimaryWebContents(
    app,
    async (wc, targetUrl) => {
      try {
        await wc.loadURL(targetUrl);
        return { ok: true, url: wc.getURL() };
      } catch (error) {
        return { ok: false, url: wc.getURL(), error: String(error) };
      }
    },
    url,
  );
}

async function collectThreadUrls(app) {
  const urls = await withPrimaryWebContents(
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
            const cands = [nav, ...Array.from(nav.querySelectorAll('div'))]
              .filter((el) => el.scrollHeight > el.clientHeight + 120)
              .sort((a, b) => b.clientHeight - a.clientHeight);
            if (cands[0]) scroller = cands[0];
          }

          const collect = () => {
            for (const a of Array.from(document.querySelectorAll('a[href]'))) {
              const normalized = normalize(a.getAttribute('href'));
              if (normalized) urls.add(normalized);
            }
          };

          collect();
          for (let i = 0; i < 180; i += 1) {
            const delta = Math.max(220, Math.round((scroller.clientHeight || innerHeight) * 0.85));
            scroller.scrollTop = Math.min(scroller.scrollTop + delta, scroller.scrollHeight);
            await new Promise((resolve) => setTimeout(resolve, 170));
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

  return urls.map((url) => ({
    url,
    routeType: classifyThreadRouteType(url),
    threadId: extractThreadId(url),
  }));
}

function rankE2EEThreads(threads) {
  const preferredIndex = new Map(
    PREFERRED_E2EE_THREAD_IDS.map((id, index) => [id, index]),
  );

  return [...threads].sort((a, b) => {
    const aIndex = preferredIndex.has(a.threadId)
      ? preferredIndex.get(a.threadId)
      : Number.POSITIVE_INFINITY;
    const bIndex = preferredIndex.has(b.threadId)
      ? preferredIndex.get(b.threadId)
      : Number.POSITIVE_INFINITY;
    if (aIndex !== bIndex) return aIndex - bIndex;
    return a.url.localeCompare(b.url);
  });
}

async function inspectSurface(app) {
  return withPrimaryWebContents(
    app,
    async (wc, closeSelector) => {
      const script = `
        (() => {
          const pick = (selectors) => {
            const nodes = Array.from(document.querySelectorAll(selectors));
            const out = [];
            const seen = new Set();
            for (const node of nodes) {
              if (!(node instanceof HTMLElement)) continue;
              const style = window.getComputedStyle(node);
              if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
              const r = node.getBoundingClientRect();
              if (r.width < 6 || r.height < 6) continue;
              if (r.top > 360 || r.bottom < -160) continue;
              const item = {
                label: node.getAttribute('aria-label') || '',
                left: Math.round(r.left),
                right: Math.round(r.right),
                top: Math.round(r.top),
                width: Math.round(r.width),
                height: Math.round(r.height),
              };
              const key = [item.label, item.left, item.right, item.top, item.width, item.height].join('|');
              if (seen.has(key)) continue;
              seen.add(key);
              out.push(item);
            }
            return out;
          };

          const href = window.location.href;
          const parsed = new URL(href);
          const path = parsed.pathname.toLowerCase();
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

          const controls = {
            close: pick(${JSON.stringify(closeSelector)}),
            download: pick('[aria-label*="Download" i],button[aria-label*="Download" i],[aria-label*="Save" i],button[aria-label*="Save" i]'),
            share: pick('[aria-label*="Share" i],button[aria-label*="Share" i],[aria-label*="Forward" i],button[aria-label*="Forward" i]'),
          };

          return {
            url: href,
            host: parsed.hostname,
            path,
            routeType,
            classes: {
              activeCrop: document.documentElement.classList.contains('md-fb-messages-viewport-fix'),
            },
            controls,
          };
        })();
      `;
      return wc.executeJavaScript(script, true);
    },
    CLOSE_CONTROL_SELECTOR,
  );
}

function evaluateSurface(state) {
  const sameRouteViewer =
    state.routeType === "e2ee-thread" &&
    (state.controls.download.length > 0 ||
      state.controls.share.length > 0 ||
      state.controls.close.length > 0);

  const counts = {
    close: state.controls.close.length,
    download: state.controls.download.length,
    share: state.controls.share.length,
  };

  const fixed =
    sameRouteViewer &&
    state.classes.activeCrop === false &&
    counts.close === 1 &&
    counts.download === 1 &&
    counts.share === 1;

  let reason = "fixed";
  if (!sameRouteViewer) reason = "viewer-not-open";
  else if (state.classes.activeCrop) reason = "crop-still-active";
  else if (counts.close === 0) reason = "close-missing";
  else if (counts.download === 0) reason = "download-missing";
  else if (counts.share === 0) reason = "share-missing";
  else if (counts.close > 1) reason = "close-duplicated";
  else if (counts.download > 1) reason = "download-duplicated";
  else if (counts.share > 1) reason = "share-duplicated";

  return {
    isExternal: !/facebook\.com$/.test(String(state.host || "")),
    isMediaRoute: MEDIA_ROUTE_TYPES.has(state.routeType),
    isSameRouteViewer: sameRouteViewer,
    counts,
    fixed,
    reason,
    successKind: MEDIA_ROUTE_TYPES.has(state.routeType)
      ? state.routeType
      : sameRouteViewer
        ? "e2ee_same_route"
        : null,
  };
}

async function clickNextMediaCandidate(app, seenKeys, options) {
  return withPrimaryWebContents(
    app,
    async (wc, payload) => {
      const script = `
        (() => {
          const seen = new Set(${JSON.stringify(payload.seenKeys || [])});
          const preferLabels = ${JSON.stringify(payload.preferLabelContains || [])};
          const excludeLabels = ${JSON.stringify(payload.excludeLabelContains || [])};
          const preferRouteTypes = new Set(${JSON.stringify(payload.preferRouteTypes || [])});
          const excludeRouteTypes = new Set(${JSON.stringify(payload.excludeRouteTypes || [])});

          const routeTypeFromUrl = (raw) => {
            try {
              const abs = new URL(raw, window.location.origin);
              const p = abs.pathname.toLowerCase();
              if (p.startsWith('/messenger_media')) return 'messenger_media';
              if (p.startsWith('/messages/media_viewer')) return 'messages_media_viewer';
              if (p.startsWith('/messages/attachment_preview')) return 'attachment_preview';
              if (p.startsWith('/photo') || p.startsWith('/photos')) return 'photo';
              if (p.startsWith('/video') || p.startsWith('/watch')) return 'video';
              if (p.startsWith('/story') || p.startsWith('/stories')) return 'story';
              if (p.startsWith('/reel') || p.startsWith('/reels')) return 'reel';
              if (p.startsWith('/messages/e2ee/t/')) return 'e2ee-thread';
              if (p.startsWith('/messages/t/')) return 'thread';
              return 'other';
            } catch {
              return 'other';
            }
          };

          const isVisible = (el) => {
            if (!(el instanceof HTMLElement)) return null;
            if (el.closest('[aria-hidden="true"]') || el.closest('[hidden]')) return null;
            const style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return null;
            const r = el.getBoundingClientRect();
            if (r.width < 16 || r.height < 16) return null;
            if (r.bottom < 0 || r.top > window.innerHeight) return null;
            if (r.left < Math.min(180, window.innerWidth * 0.15)) return null;
            if (r.top < 40) return null;
            return r;
          };

          const toAbs = (raw) => {
            try {
              return new URL(raw, window.location.origin).href;
            } catch {
              return '';
            }
          };

          const sameOriginFacebook = (raw) => {
            try {
              const abs = new URL(raw, window.location.origin);
              return abs.hostname === 'facebook.com' || abs.hostname.endsWith('.facebook.com');
            } catch {
              return false;
            }
          };

          const candidateKey = (parts) => parts.filter(Boolean).join(' | ');

          const shouldSkipLabel = (label) => /seen by|message seen|delivered|sent$/i.test(String(label || ''));
          const currentUrl = window.location.href;

          const matchesAnyTerm = (value, terms) => {
            const lower = String(value || '').toLowerCase();
            return terms.some((term) => lower.includes(term));
          };

          const scoreCandidate = (candidate) => {
            if (preferRouteTypes.has(candidate.routeType)) return -2;
            if (matchesAnyTerm(candidate.label, preferLabels)) return -1;
            if (candidate.routeType && candidate.routeType !== 'other' && candidate.routeType !== 'reel') return 0;
            if (candidate.sameOrigin && !candidate.href) return 1;
            if (candidate.sameOrigin) return 2;
            if (candidate.href) return 6;
            return 4;
          };

          const candidates = [];

          for (const anchor of Array.from(document.querySelectorAll('a[href]'))) {
            if (!(anchor instanceof HTMLElement)) continue;
            const rect = isVisible(anchor);
            if (!rect) continue;
            const href = anchor.getAttribute('href') || '';
            const abs = toAbs(href);
            const routeType = routeTypeFromUrl(abs);
            const mediaChild = anchor.querySelector('img, video, [role="img"]');
            const mediaRect = mediaChild ? isVisible(mediaChild) : null;
            const mediaSrc =
              mediaChild instanceof HTMLImageElement
                ? mediaChild.currentSrc || mediaChild.src || ''
                : mediaChild instanceof HTMLVideoElement
                  ? mediaChild.currentSrc || mediaChild.src || ''
                  : mediaChild instanceof HTMLElement
                    ? mediaChild.getAttribute('src') || mediaChild.style.backgroundImage || ''
                    : '';
            const hasMediaChild = Boolean(mediaRect && mediaRect.width >= 72 && mediaRect.height >= 72 && mediaRect.width * mediaRect.height >= 4096);
            const key = candidateKey([
              'anchor',
              abs,
              mediaSrc,
              anchor.getAttribute('aria-label') || '',
              String(Math.round(rect.top)),
              String(Math.round(rect.left)),
            ]);
            const label = anchor.getAttribute('aria-label') || '';
            if (seen.has(key)) continue;
            if (shouldSkipLabel(label)) continue;
            if (excludeRouteTypes.has(routeType)) continue;
            if (matchesAnyTerm(label, excludeLabels)) continue;
            if (!hasMediaChild && routeType === 'other') continue;
            if (routeType === 'other' && abs && abs !== currentUrl) continue;
            candidates.push({
              key,
              node: anchor,
              method: 'anchor',
              href: abs,
              routeType,
              sameOrigin: sameOriginFacebook(abs),
              label,
              mediaSrc,
              top: rect.top,
              area: rect.width * rect.height,
              hasMediaChild,
            });
          }

          for (const media of Array.from(document.querySelectorAll('img, video, [role="img"]'))) {
            if (!(media instanceof HTMLElement)) continue;
            const rect = isVisible(media);
            if (!rect) continue;
            const clickable = media.closest('a[href], [role="button"], button, [tabindex]');
            if (!(clickable instanceof HTMLElement)) continue;
            const href = clickable instanceof HTMLAnchorElement ? clickable.href : clickable.getAttribute('href') || '';
            const abs = href ? toAbs(href) : '';
            const routeType = routeTypeFromUrl(abs);
            const mediaSrc =
              media instanceof HTMLImageElement
                ? media.currentSrc || media.src || ''
                : media instanceof HTMLVideoElement
                  ? media.currentSrc || media.src || ''
                  : media.getAttribute('src') || media.style.backgroundImage || '';
            if (rect.width < 72 || rect.height < 72 || rect.width * rect.height < 4096) continue;
            if (!mediaSrc && media.getAttribute('role') !== 'img') continue;
            const label = clickable.getAttribute('aria-label') || media.getAttribute('aria-label') || '';
            if (shouldSkipLabel(label)) continue;
            if (excludeRouteTypes.has(routeType)) continue;
            if (matchesAnyTerm(label, excludeLabels)) continue;
            if (routeType === 'other' && abs && abs !== currentUrl) continue;
            const key = candidateKey([
              'media',
              abs,
              mediaSrc,
              label,
              String(Math.round(rect.top)),
              String(Math.round(rect.left)),
            ]);
            if (seen.has(key)) continue;
            candidates.push({
              key,
              node: clickable,
              method: 'media-clickable',
              href: abs,
              routeType,
              sameOrigin: abs ? sameOriginFacebook(abs) : true,
              label,
              mediaSrc,
              top: rect.top,
              area: rect.width * rect.height,
              hasMediaChild: true,
            });
          }

          candidates.sort((a, b) => {
            const aScore = scoreCandidate(a);
            const bScore = scoreCandidate(b);
            if (aScore !== bScore) return aScore - bScore;
            if (a.hasMediaChild !== b.hasMediaChild) return a.hasMediaChild ? -1 : 1;
            if (a.area !== b.area) return b.area - a.area;
            return b.top - a.top;
          });

          const clickNode = (node) => {
            node.scrollIntoView({ block: 'center', inline: 'nearest' });
            const r = node.getBoundingClientRect();
            const x = r.left + r.width / 2;
            const y = r.top + r.height / 2;
            const events = ['pointerdown', 'mousedown', 'mouseup', 'click'];
            for (const type of events) {
              node.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y }));
            }
            if (typeof node.click === 'function') node.click();
          };

          if (candidates[0]) {
            const candidate = candidates[0];
            clickNode(candidate.node);
            return {
              clicked: true,
              key: candidate.key,
              method: candidate.method,
              href: candidate.href,
              routeType: candidate.routeType,
              label: candidate.label,
              mediaSrc: candidate.mediaSrc || '',
            };
          }

          const scrollers = Array.from(document.querySelectorAll('div'))
            .filter((el) => el.scrollHeight > el.clientHeight + 180)
            .map((el) => {
              const r = el.getBoundingClientRect();
              return { el, left: r.left, width: r.width, height: r.height };
            })
            .filter((entry) => entry.width > 240 && entry.height > 220 && entry.left > window.innerWidth * 0.18)
            .sort((a, b) => b.height - a.height)
            .slice(0, 3);

          const updates = [];
          for (const entry of scrollers) {
            const delta = Math.max(240, Math.round((entry.el.clientHeight || innerHeight) * 0.8));
            const before = entry.el.scrollTop;
            entry.el.scrollTop = Math.max(0, entry.el.scrollTop - delta);
            updates.push({ before, after: entry.el.scrollTop, delta: before - entry.el.scrollTop });
          }

          return {
            clicked: false,
            scrolled: true,
            updates,
          };
        })();
      `;
      return wc.executeJavaScript(script, true);
    },
    {
      seenKeys,
      preferLabelContains: options.preferLabelContains,
      excludeLabelContains: options.excludeLabelContains,
      preferRouteTypes: options.preferRouteTypes,
      excludeRouteTypes: options.excludeRouteTypes,
    },
  );
}

async function searchThread(app, thread, options, outDir) {
  const result = {
    threadUrl: thread.url,
    threadId: thread.threadId,
    attempts: [],
    found: false,
    match: null,
  };

  const seenKeys = new Set();
  let consecutiveNoCandidate = 0;

  const nav = await navigate(app, thread.url);
  if (!nav.ok) {
    result.error = nav.error;
    return result;
  }
  await wait(1200);

  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    const clickResult = await clickNextMediaCandidate(
      app,
      Array.from(seenKeys),
      options,
    );
    if (clickResult.key) {
      seenKeys.add(clickResult.key);
    }

    const attemptSummary = {
      attempt,
      click: clickResult,
      states: [],
    };

    if (!clickResult.clicked) {
      consecutiveNoCandidate += 1;
      result.attempts.push(attemptSummary);
      if (consecutiveNoCandidate >= 5) break;
      await wait(350);
      continue;
    }

    consecutiveNoCandidate = 0;

    let matchedState = null;
    for (const delay of [250, 900, 1800]) {
      await wait(delay === 250 ? 250 : delay === 900 ? 650 : 900);
      const state = await inspectSurface(app);
      const evaluation = evaluateSurface(state);
      attemptSummary.states.push({ delayMs: delay, state, evaluation });

      if (evaluation.successKind) {
        matchedState = { delayMs: delay, state, evaluation };
      }

      if (evaluation.isExternal) break;
    }

    if (matchedState) {
      result.found = true;
      result.match = {
        successKind: matchedState.evaluation.successKind,
        click: clickResult,
        state: matchedState.state,
        evaluation: matchedState.evaluation,
        delayMs: matchedState.delayMs,
      };
      const shotName = `${safe(thread.url)}-attempt${attempt}-${matchedState.evaluation.successKind}.png`;
      await captureWindow(app, path.join(outDir, shotName));
      result.match.screenshot = shotName;
      result.attempts.push(attemptSummary);
      return result;
    }

    result.attempts.push(attemptSummary);
    const reset = await navigate(app, thread.url);
    if (!reset.ok) {
      result.resetError = reset.error;
      break;
    }
    await wait(900);
  }

  return result;
}

async function run() {
  const options = parseArgs(process.argv);
  fs.mkdirSync(options.outputDir, { recursive: true });

  const summary = {
    generatedAt: new Date().toISOString(),
    options: {
      maxThreads: options.maxThreads,
      maxAttempts: options.maxAttempts,
      threadUrl: options.threadUrl || null,
    },
    discoveredThreads: [],
    searchedThreads: [],
    found: null,
  };

  console.log("Output folder:", options.outputDir);

  const app = await electron.launch({
    args: [path.join(options.appRoot, "dist/main/main.js")],
    env: {
      ...process.env,
      NODE_ENV: "development",
      SKIP_SINGLE_INSTANCE_LOCK: "true",
    },
  });

  try {
    await waitForAnyWindow(app);
    await wait(4500);
    const loaded = await loadMessagesHome(app);
    console.log("Loaded:", loaded);

    let e2eeThreads;
    if (options.threadUrl) {
      e2eeThreads = [
        {
          url: options.threadUrl,
          routeType: classifyThreadRouteType(options.threadUrl),
          threadId: extractThreadId(options.threadUrl),
        },
      ].filter((entry) => entry.routeType === "e2ee");
    } else {
      const allThreads = await collectThreadUrls(app);
      summary.discoveredThreads = allThreads;
      e2eeThreads = rankE2EEThreads(
        allThreads.filter((entry) => entry.routeType === "e2ee"),
      ).slice(0, options.maxThreads);
    }

    console.log(
      "Searching E2EE threads:",
      e2eeThreads.map((entry) => entry.url),
    );

    for (const thread of e2eeThreads) {
      console.log("Searching thread:", thread.url);
      const threadResult = await searchThread(
        app,
        thread,
        options,
        options.outputDir,
      );
      summary.searchedThreads.push(threadResult);

      if (threadResult.found) {
        summary.found = {
          threadUrl: thread.url,
          threadId: thread.threadId,
          ...threadResult.match,
        };
        break;
      }
    }

    const summaryPath = path.join(options.outputDir, "summary.json");
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
    console.log("Summary:", summaryPath);

    if (summary.found) {
      if (options.expect === "fixed" && !summary.found.evaluation?.fixed) {
        throw new Error(
          `Expected fixed result, got ${summary.found.evaluation?.reason || "unknown"}`,
        );
      }
      if (options.expect === "broken" && summary.found.evaluation?.fixed) {
        throw new Error(
          "Expected broken result, but discovery matched a fixed state",
        );
      }
      console.log("FOUND E2EE media target:", {
        threadUrl: summary.found.threadUrl,
        successKind: summary.found.successKind,
        currentUrl: summary.found.state.url,
        reason: summary.found.evaluation?.reason || null,
      });
      return;
    }

    throw new Error("No real E2EE in-app media target found");
  } finally {
    await app.close().catch(() => {});
  }
}

run().catch((error) => {
  console.error("FAIL find E2EE media target:", error.message || error);
  process.exit(1);
});
