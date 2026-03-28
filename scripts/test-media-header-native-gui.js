const { _electron: electron } = require("playwright");
const fs = require("fs");
const path = require("path");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const CONTROL_SELECTORS = {
  close: [
    '[aria-label="Close" i]',
    'button[aria-label="Close" i]',
    '[role="button"][aria-label="Close" i]',
    '[aria-label="Back" i]',
    'button[aria-label="Back" i]',
    '[role="button"][aria-label="Back" i]',
    '[aria-label*="Go back" i]',
    '[aria-label="Back to Previous Page" i]',
  ],
  facebook: [
    'a[href="/"]',
    'a[href="https://www.facebook.com/"]',
    '[aria-label="Facebook" i]',
  ],
  download: [
    '[aria-label*="Download" i]',
    'button[aria-label*="Download" i]',
    '[role="button"][aria-label*="Download" i]',
  ],
  share: [
    '[aria-label*="Share" i]',
    '[aria-label*="Forward" i]',
    'button[aria-label*="Share" i]',
    'button[aria-label*="Forward" i]',
    '[role="button"][aria-label*="Share" i]',
    '[role="button"][aria-label*="Forward" i]',
  ],
  menu: ['[aria-label="Menu" i]'],
  messenger: ['[aria-label="Messenger" i]'],
  notifications: ['[aria-label*="Notifications" i]'],
  account: [
    'button[aria-label*="Account controls and settings" i]',
    '[role="button"][aria-label*="Account controls and settings" i]',
    'button[aria-label="Your profile" i]',
    '[role="button"][aria-label="Your profile" i]',
    '[aria-label*="Account controls and settings" i]',
    '[aria-label="Your profile" i]',
  ],
};

const OVERLAY_HINTS = {
  menu: ["menu", "create", "feeds?", "groups?", "events?"],
  messenger: ["chats?", "see all in messenger", "search messenger"],
  notifications: ["notifications?", "see previous notifications", "see all"],
  account: [
    "settings\\s*&\\s*privacy",
    "help\\s*&\\s*support",
    "see all profiles",
    "privacy",
    "terms",
  ],
};

const OVERLAY_LINK_PREFERENCES = {
  menu: [
    "story",
    "reel",
    "events?",
    "friends?",
    "groups?",
    "feeds?",
    "page",
    "marketplace",
  ],
  messenger: ["see all in messenger", "see all"],
  notifications: ["see all", "see previous notifications"],
  account: ["see all profiles", "privacy", "terms"],
};

const OVERLAY_HREF_PREFERENCES = {
  menu: [
    "/stories/create",
    "/reels/create",
    "/events/",
    "/friends/",
    "/groups/",
    "/feeds/",
    "/pages/",
    "/marketplace/",
  ],
  messenger: ["/messages/t/", "/messages/t", "/messages/"],
  notifications: ["/notifications/", "notif_", "ref=notif"],
  account: ["/me/", "/privacy/", "/terms"],
};

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
  const options = {
    appRoot: process.env.MESSENGER_APP_ROOT
      ? path.resolve(process.env.MESSENGER_APP_ROOT)
      : path.resolve(__dirname, ".."),
    executablePath: process.env.MESSENGER_EXECUTABLE_PATH
      ? path.resolve(process.env.MESSENGER_EXECUTABLE_PATH)
      : "",
    outputDir: path.join(
      process.cwd(),
      "test-screenshots",
      `media-header-native-${ts()}`,
    ),
    mediaCases: [],
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
    } else if (arg === "--media-case") {
      const raw = String(next || "");
      const splitAt = raw.indexOf("=");
      if (splitAt <= 0) {
        throw new Error(
          `Invalid --media-case value "${raw}". Expected label=https://...`,
        );
      }
      options.mediaCases.push({
        label: raw.slice(0, splitAt).trim(),
        url: raw.slice(splitAt + 1).trim(),
      });
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        `Usage: node scripts/test-media-header-native-gui.js [options]\n\nOptions:\n  --media-case <label=url>      Repeatable. Example: --media-case non_e2ee=https://www.facebook.com/messenger_media/?attachment_id=123\n  --output-dir <dir>            Directory for screenshots and summary.json\n  --app-root <dir>              Alternate app root containing dist/main/main.js\n  --executable-path <path>      Launch a packaged app binary instead of dist/main/main.js\n`,
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (options.mediaCases.length === 0) {
    throw new Error("At least one --media-case label=url must be provided");
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

async function navigate(app, url) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await withPrimaryWebContents(
        app,
        async (wc, targetUrl) => {
          await wc.loadURL(targetUrl);
          return wc.getURL();
        },
        url,
      );
    } catch (error) {
      lastError = error;
      await wait(700);
    }
  }

  throw lastError;
}

function deriveThreadUrlFromMediaUrl(input) {
  try {
    const parsed = new URL(input);
    const threadId =
      parsed.searchParams.get("thread_id") ||
      parsed.searchParams.get("threadId") ||
      "";
    if (threadId) {
      return `${parsed.origin}/messages/t/${threadId}/`;
    }
  } catch {
    return null;
  }
  return null;
}

async function navigateToMediaUrl(app, mediaUrl) {
  const parentThreadUrl = deriveThreadUrlFromMediaUrl(mediaUrl);

  if (parentThreadUrl) {
    await navigate(app, parentThreadUrl);
    await wait(900);
  }

  try {
    return await navigate(app, mediaUrl);
  } catch (error) {
    if (!parentThreadUrl) {
      throw error;
    }

    await navigate(app, parentThreadUrl);
    await wait(1200);

    return withPrimaryWebContents(
      app,
      async (wc, targetUrl) => {
        await wc.executeJavaScript(
          `window.location.href = ${JSON.stringify(targetUrl)};`,
          true,
        );
        return wc.getURL();
      },
      mediaUrl,
    );
  }
}

async function evaluateInMessagesPage(app, fn, payload) {
  return withPrimaryWebContents(
    app,
    async (wc, payload) => {
      const runner = eval(`(${payload.fnSource})`);
      return wc.executeJavaScript(`(${runner.toString()})(${JSON.stringify(payload.data)})`, true);
    },
    { fnSource: fn.toString(), data: payload },
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

async function collectMediaState(app) {
  return evaluateInMessagesPage(
    app,
    ({ controlSelectors }) => {
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
        if (rect.width < 4 || rect.height < 4) {
          return false;
        }
        return rect.bottom > 0 && rect.right > 0;
      };

      const normalize = (value) =>
        String(value || "")
          .replace(/\s+/g, " ")
          .trim();

      const selectors = Object.fromEntries(
        Object.entries(controlSelectors).map(([key, values]) => [
          key,
          values.join(", "),
        ]),
      );

      const pickFirstVisible = (selector) => {
        let matches = [];
        try {
          matches = Array.from(document.querySelectorAll(selector));
        } catch {
          matches = [];
        }

        for (const node of matches) {
          if (!(node instanceof HTMLElement) || !isVisible(node)) {
            continue;
          }

          const rect = node.getBoundingClientRect();
          return {
            label: normalize(
              node.getAttribute("aria-label") ||
                node.getAttribute("title") ||
                node.textContent,
            ),
            href:
              node instanceof HTMLAnchorElement
                ? node.href
                : node.getAttribute("href") || null,
            rect: {
              left: Math.round(rect.left),
              top: Math.round(rect.top),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
              right: Math.round(rect.right),
              bottom: Math.round(rect.bottom),
            },
            center: {
              x: Math.round(rect.left + rect.width / 2),
              y: Math.round(rect.top + rect.height / 2),
            },
          };
        }

        return null;
      };

      const controls = {};
      for (const [key, selector] of Object.entries(selectors)) {
        controls[key] = pickFirstVisible(selector);
      }

      return {
        url: window.location.href,
        title: document.title,
        routeKind: (() => {
          const path = window.location.pathname.toLowerCase();
          if (
            path.startsWith("/messenger_media") ||
            path.startsWith("/messages/media_viewer") ||
            path.startsWith("/messages/attachment_preview") ||
            path.startsWith("/photo") ||
            path.startsWith("/photos") ||
            path.startsWith("/video") ||
            path.startsWith("/watch") ||
            path.startsWith("/story") ||
            path.startsWith("/stories") ||
            path.startsWith("/reel") ||
            path.startsWith("/reels")
          ) {
            return "media";
          }
          if (path === "/messages" || path.startsWith("/messages/")) {
            return "chat";
          }
          return "other";
        })(),
        headerSuppression: {
          activeClass: document.documentElement.classList.contains(
            "md-fb-messages-viewport-fix",
          ),
          collapseClass: document.documentElement.classList.contains(
            "md-fb-messages-header-collapsed",
          ),
          hiddenHeaderCount: document.querySelectorAll(
            "[data-md-fb-header-suppression]",
          ).length,
          hiddenChromeCount: document.querySelectorAll(
            "[data-md-fb-hidden-chrome]",
          ).length,
          shellStretchCount: document.querySelectorAll(
            "[data-md-fb-shell-stretch]",
          ).length,
        },
        controls,
        topRightControls: Array.from(
          document.querySelectorAll("button, [role='button'], a[href]"),
        )
          .filter((node) => {
            if (!(node instanceof HTMLElement) || !isVisible(node)) {
              return false;
            }
            const rect = node.getBoundingClientRect();
            return rect.top <= 80 && rect.left >= window.innerWidth - 260;
          })
          .map((node) => {
            const rect = node.getBoundingClientRect();
            return {
              label: normalize(
                node.getAttribute("aria-label") ||
                  node.getAttribute("title") ||
                  node.textContent,
              ),
              href:
                node instanceof HTMLAnchorElement
                  ? node.href
                  : node.getAttribute("href") || null,
              rect: {
                left: Math.round(rect.left),
                top: Math.round(rect.top),
                width: Math.round(rect.width),
                height: Math.round(rect.height),
              },
            };
          }),
        lastExternalNavigation:
          window.__mdLastExternalNavigation || {
            url:
              document.documentElement.getAttribute(
                "data-md-last-external-url",
              ) || null,
            reason:
              document.documentElement.getAttribute(
                "data-md-last-external-reason",
              ) || null,
            at:
              document.documentElement.getAttribute(
                "data-md-last-external-at",
              ) || null,
          },
      };
    },
    { controlSelectors: CONTROL_SELECTORS },
  );
}

async function clearLastExternalNavigation(app) {
  return evaluateInMessagesPage(
    app,
    () => {
      delete window.__mdLastExternalNavigation;
      document.documentElement.removeAttribute("data-md-last-external-url");
      document.documentElement.removeAttribute("data-md-last-external-reason");
      document.documentElement.removeAttribute("data-md-last-external-at");
      return true;
    },
    null,
  );
}

async function clickHeaderControl(app, kind) {
  const target = await evaluateInMessagesPage(
    app,
    ({ kind, controlSelectors }) => {
      const normalize = (value) =>
        String(value || "")
          .replace(/\s+/g, " ")
          .trim();

      const isVisible = (node) => {
        if (!(node instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(node);
        if (style.display === "none" || style.visibility === "hidden") {
          return false;
        }
        const rect = node.getBoundingClientRect();
        return rect.width >= 4 && rect.height >= 4;
      };

      const selector = (controlSelectors[kind] || []).join(", ");
      let visibleMatches = Array.from(document.querySelectorAll(selector))
        .filter((node) => isVisible(node))
        .sort((a, b) => {
          const rectA = a.getBoundingClientRect();
          const rectB = b.getBoundingClientRect();
          return rectA.width * rectA.height - rectB.width * rectB.height;
        });

      if (kind === "menu" && visibleMatches.length === 0) {
        visibleMatches = Array.from(
          document.querySelectorAll("button, [role='button'], a[href]"),
        )
          .filter((node) => {
            if (!(node instanceof HTMLElement) || !isVisible(node)) {
              return false;
            }
            const rect = node.getBoundingClientRect();
            if (rect.top > 72) return false;
            if (rect.left < window.innerWidth - 260 || rect.left > window.innerWidth - 120) {
              return false;
            }
            if (rect.width > 64 || rect.height > 64) return false;
            const label = normalize(
              node.getAttribute("aria-label") ||
                node.getAttribute("title") ||
                node.textContent,
            );
            return !/messenger|notifications|account controls|your profile/i.test(label);
          })
          .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
      }

      const match = visibleMatches[0];
      if (!(match instanceof HTMLElement)) {
        return { ok: false, reason: `No visible control for ${kind}` };
      }

      const rect = match.getBoundingClientRect();
      return {
        ok: true,
        label:
          match.getAttribute("aria-label") ||
          match.getAttribute("title") ||
          match.textContent ||
          "",
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2),
      };
    },
    { kind, controlSelectors: CONTROL_SELECTORS },
  );

  if (!target.ok) {
    return target;
  }

  await sendInputClick(app, target.x, target.y);
  return target;
}

async function clickOverlayNavigationLink(app, kind) {
  const target = await evaluateInMessagesPage(
    app,
    ({ kind, overlayHints, linkPreferences, hrefPreferences }) => {
      const normalize = (value) =>
        String(value || "")
          .replace(/\s+/g, " ")
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
        return (
          rect.width >= 4 &&
          rect.height >= 4 &&
          rect.top <= 260 &&
          rect.left >= window.innerWidth * 0.45
        );
      };

      const hintPatterns = (overlayHints[kind] || []).map(
        (source) => new RegExp(source, "i"),
      );
      const linkPatterns = (linkPreferences[kind] || []).map(
        (source) => new RegExp(source, "i"),
      );
      const hrefFragments = (hrefPreferences[kind] || []).map((source) =>
        String(source || "").toLowerCase(),
      );

      const describeAnchor = (node) => {
        if (!(node instanceof HTMLElement) || !isVisible(node)) {
          return null;
        }

        const href =
          node instanceof HTMLAnchorElement
            ? node.href
            : node.getAttribute("href") || "";
        if (!href || href.startsWith("javascript:")) {
          return null;
        }

        const label = normalize(
          node.getAttribute("aria-label") ||
            node.getAttribute("title") ||
            node.textContent,
        );
        if (/log out/i.test(label)) {
          return null;
        }

        const rect = node.getBoundingClientRect();
        return {
          node,
          href,
          label,
          rect: {
            left: Math.round(rect.left),
            top: Math.round(rect.top),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
        };
      };

      const ancestors = Array.from(
        document.querySelectorAll("[role='dialog'], [role='menu'], [aria-modal='true'], div"),
      ).filter((node) => {
        if (!(node instanceof HTMLElement) || !isVisible(node)) {
          return false;
        }

        const text = normalize(
          [
            node.getAttribute("aria-label"),
            node.getAttribute("title"),
            node.textContent,
          ]
            .filter(Boolean)
            .join(" "),
        ).slice(0, 1200);

        return hintPatterns.some((pattern) => pattern.test(text));
      });

      const root = ancestors.sort((a, b) => {
        const rectA = a.getBoundingClientRect();
        const rectB = b.getBoundingClientRect();
        return rectB.width * rectB.height - rectA.width * rectA.height;
      })[0];

      if (!(root instanceof HTMLElement)) {
        const fallbackCandidates = Array.from(
          document.querySelectorAll("a[href], [role='link'][href]"),
        )
          .map((node) => describeAnchor(node))
          .filter(Boolean)
          .filter((candidate) => {
            const href = String(candidate.href || "").toLowerCase();
            return (
              linkPatterns.some((pattern) => pattern.test(candidate.label)) ||
              hrefFragments.some((fragment) => href.includes(fragment))
            );
          });

        const fallback = fallbackCandidates[0];
        if (!fallback) {
          return { ok: false, reason: `No visible ${kind} overlay root found` };
        }

        return {
          ok: true,
          href: fallback.href,
          label: fallback.label,
          x: fallback.x,
          y: fallback.y,
        };
      }

      const anchors = Array.from(root.querySelectorAll("a[href]"))
        .map((node) => describeAnchor(node))
        .filter(Boolean);

      if (anchors.length === 0) {
        const fallbackCandidates = Array.from(
          document.querySelectorAll("a[href], [role='link'][href]"),
        )
          .map((node) => describeAnchor(node))
          .filter(Boolean)
          .filter((candidate) => {
            const href = String(candidate.href || "").toLowerCase();
            return (
              linkPatterns.some((pattern) => pattern.test(candidate.label)) ||
              hrefFragments.some((fragment) => href.includes(fragment))
            );
          });

        const fallback = fallbackCandidates[0];
        if (!fallback) {
          return { ok: false, reason: `No navigational anchors found for ${kind}` };
        }

        return {
          ok: true,
          href: fallback.href,
          label: fallback.label,
          x: fallback.x,
          y: fallback.y,
        };
      }

      let chosen =
        anchors.find((anchor) => {
          const href = String(anchor.href || "").toLowerCase();
          return (
            linkPatterns.some((pattern) => pattern.test(anchor.label)) ||
            hrefFragments.some((fragment) => href.includes(fragment))
          );
        }) || anchors[0];

      if (kind === "messenger") {
        chosen =
          anchors.find((anchor) =>
            /\/messages\/(?:e2ee\/)?t\/[^/?#]+\/?$/i.test(anchor.href),
          ) ||
          anchors.find((anchor) =>
            /\/messages\/(?:e2ee\/)?t\/?$/i.test(anchor.href),
          ) ||
          chosen;
      }

      return {
        ok: true,
        href: chosen.href,
        label: chosen.label,
        x: chosen.x,
        y: chosen.y,
      };
    },
    {
      kind,
      overlayHints: OVERLAY_HINTS,
      linkPreferences: OVERLAY_LINK_PREFERENCES,
      hrefPreferences: OVERLAY_HREF_PREFERENCES,
    },
  );

  if (!target.ok) {
    return target;
  }

  await sendInputClick(app, target.x, target.y);
  return target;
}

async function runCase(app, options, mediaCase) {
  const caseDir = path.join(options.outputDir, mediaCase.label);
  fs.mkdirSync(caseDir, { recursive: true });

  const initialUrl = await navigateToMediaUrl(app, mediaCase.url);
  await wait(1500);

  const summary = {
    label: mediaCase.label,
    inputUrl: mediaCase.url,
    initialUrl,
    initialState: await collectMediaState(app),
    facebookButton: null,
    overlays: {},
  };

  await captureWindow(app, path.join(caseDir, `${safe(mediaCase.label)}-media.png`));

  await clearLastExternalNavigation(app);
  const facebookClick = await clickHeaderControl(app, "facebook");
  await wait(500);
  summary.facebookButton = {
    click: facebookClick,
    state: await collectMediaState(app),
  };

  for (const kind of ["menu", "messenger", "notifications", "account"]) {
    await navigateToMediaUrl(app, mediaCase.url);
    await wait(1200);
    await clearLastExternalNavigation(app);

    const openResult = await clickHeaderControl(app, kind);
    await wait(600);

    const overlayState = await collectMediaState(app);
    await captureWindow(
      app,
      path.join(caseDir, `${safe(mediaCase.label)}-${kind}-overlay.png`),
    );

    const clickResult = await clickOverlayNavigationLink(app, kind);
    await wait(600);

    summary.overlays[kind] = {
      openResult,
      overlayState,
      clickResult,
      postClickState: await collectMediaState(app),
    };
  }

  return summary;
}

async function launchApp(options) {
  if (options.executablePath) {
    return electron.launch({
      executablePath: options.executablePath,
      args: [],
    });
  }

  return electron.launch({
    args: [path.join(options.appRoot, "dist", "main", "main.js")],
  });
}

async function main() {
  const options = parseArgs(process.argv);
  fs.mkdirSync(options.outputDir, { recursive: true });

  const app = await launchApp(options);
  const results = [];

  try {
    await waitForAnyWindow(app);
    await wait(1200);

    for (const mediaCase of options.mediaCases) {
      results.push(await runCase(app, options, mediaCase));
    }
  } finally {
    await app.close().catch(() => {});
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    outputDir: options.outputDir,
    cases: results,
  };

  fs.writeFileSync(
    path.join(options.outputDir, "summary.json"),
    JSON.stringify(summary, null, 2),
  );

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
