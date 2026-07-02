const { _electron: electron } = require("playwright");
const fs = require("fs");
const path = require("path");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const DWELL_ASSERT_INTERVAL_MS = 5_000;

function ts() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function parseArgs(argv) {
  const targetLabel = String(process.env.MESSENGER_SUBVIEW_LABEL || "Archived chats")
    .replace(/\s+/g, " ")
    .trim();
  const defaultSettleMs = /\barchived chats?\b/i.test(targetLabel) ? 180_000 : 0;
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
      `messenger-subview-back-${ts()}`,
    ),
    targetLabel,
    homeAfterSubview: false,
    settleMs: parseNonNegativeInteger(
      process.env.MESSENGER_SUBVIEW_SETTLE_MS,
      defaultSettleMs,
      "MESSENGER_SUBVIEW_SETTLE_MS",
    ),
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--app-root") {
      options.appRoot = path.resolve(String(next || "").trim());
      i += 1;
    } else if (arg === "--executable-path") {
      options.executablePath = path.resolve(String(next || "").trim());
      i += 1;
    } else if (arg === "--output-dir") {
      options.outputDir = path.resolve(String(next || "").trim());
      i += 1;
    } else if (arg === "--target-label") {
      options.targetLabel = String(next || "").replace(/\s+/g, " ").trim();
      i += 1;
      if (!process.env.MESSENGER_SUBVIEW_SETTLE_MS) {
        options.settleMs = /\barchived chats?\b/i.test(options.targetLabel)
          ? 180_000
          : 0;
      }
    } else if (arg === "--settle-ms") {
      options.settleMs = parseNonNegativeInteger(next, options.settleMs, arg);
      i += 1;
    } else if (arg === "--home-after-subview") {
      options.homeAfterSubview = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        `Usage: node scripts/test-archived-chat-back-gui.js [options]\n\nOptions:\n  --target-label <text>    Three-dots menu subview label to open (default: Archived chats)\n  --settle-ms <ms>         Dwell before clicking Back (default: 180000 for Archived chats, 0 otherwise)\n  --home-after-subview     Click Facebook Home from the opened subview and expect Chats to return\n  --output-dir <dir>       Directory for summary.json and screenshots\n  --app-root <dir>         Alternate app root containing dist/main/main.js\n  --executable-path <path> Launch a packaged app binary instead of dist/main/main.js\n`,
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function parseNonNegativeInteger(value, fallback, label) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return fallback;
  }

  const parsed = Number(String(value).trim());
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative number of milliseconds`);
  }

  return Math.round(parsed);
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

async function navigate(app, url) {
  return withPrimaryWebContents(
    app,
    async (wc, targetUrl) => {
      await wc.loadURL(targetUrl).catch(() => undefined);
      return wc.getURL();
    },
    url,
  );
}

async function sendInputClick(app, point) {
  return withPrimaryWebContents(
    app,
    async (wc, rawPoint) => {
      const x = Math.round(rawPoint.x);
      const y = Math.round(rawPoint.y);
      wc.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
      wc.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
      return true;
    },
    point,
  );
}

async function screenshot(app, outputDir, name) {
  const filePath = path.join(outputDir, `${name}.png`);
  const pngBase64 = await withPrimaryWebContents(
    app,
    async (wc) => {
      const image = await wc.capturePage();
      return image.toPNG().toString("base64");
    },
    null,
  );
  fs.writeFileSync(filePath, Buffer.from(pngBase64, "base64"));
  return filePath;
}

async function evaluatePageState(app, targetLabel = "Archived chats") {
  const targetPatternSource = `\\b${String(targetLabel)
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\s+/g, "\\s+")}\\b`;
  return withPrimaryWebContents(
    app,
    async (wc, payload) => {
      return wc.executeJavaScript(
        `(() => {
          const targetLabel = ${JSON.stringify(payload.targetLabel)};
          const targetPattern = new RegExp(${JSON.stringify(payload.targetPatternSource)}, 'i');
          const visible = (node) => {
            if (!(node instanceof HTMLElement)) return false;
            if (node.closest('[hidden]') || node.closest('[aria-hidden="true"]')) return false;
            const style = getComputedStyle(node);
            if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
            const rect = node.getBoundingClientRect();
            return rect.width >= 8 && rect.height >= 8 && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
          };
          const labelOf = (node) => String(
            node.getAttribute('aria-label') ||
            node.getAttribute('title') ||
            node.textContent ||
            ''
          ).replace(/\\s+/g, ' ').trim();
          const centerOf = (node) => {
            const rect = node.getBoundingClientRect();
            return {
              x: Math.round(rect.left + rect.width / 2),
              y: Math.round(rect.top + rect.height / 2),
              rect: {
                left: Math.round(rect.left),
                top: Math.round(rect.top),
                width: Math.round(rect.width),
                height: Math.round(rect.height),
              },
            };
          };
          const controls = Array.from(document.querySelectorAll("button, [role='button'], [role='menuitem'], a[href], [aria-label], [title], h1, h2, h3, [role='heading']"))
            .filter(visible)
            .map((node) => ({ node, label: labelOf(node), ...centerOf(node) }));
          const targetSubview = controls.find((item) => targetPattern.test(item.label));
          const back = controls.find((item) => /\\b(back|go back|back to previous page)\\b/i.test(item.label) && item.rect.left <= 140 && item.rect.top <= 180);
          const targetEntry = controls.find((item) => targetPattern.test(item.label) && (item.node.matches("button, [role='button'], [role='menuitem'], a[href]") || item.node.closest("button, [role='button'], [role='menuitem'], a[href]")));
          const compactAction = (item) =>
            (item.node.matches("button, [role='button'], [role='menuitem'], a[href]") ||
              item.node.closest("button, [role='button'], [role='menuitem'], a[href]")) &&
            item.rect.width <= 180 &&
            item.rect.height <= 80;
          const menuEntry =
            controls.find((item) => compactAction(item) && /\\b(settings, help and more\\b|more options\\b|more\\b)/i.test(item.label) && item.rect.left >= 180 && item.rect.left <= 320 && item.rect.top <= 150) ||
            controls.find((item) => compactAction(item) && /\\b(menu|settings, help and more)\\b/i.test(item.label) && item.rect.left <= 320 && item.rect.top <= 180) ||
            controls.find((item) => compactAction(item) && /^more$/i.test(item.label) && item.rect.left <= 260 && item.rect.top <= 260) ||
            controls.find((item) => compactAction(item) && /^all chats$/i.test(item.label) && item.rect.left <= 260 && item.rect.top <= 260);
          const homeEntry = controls.find((item) => {
            if (!/^home$/i.test(item.label)) return false;
            const href = item.node.href || item.node.getAttribute('href') || '';
            return /facebook\\.com\\/?$/i.test(href) || href === '/' || href === '';
          });
          const thread =
            Array.from(document.querySelectorAll('a[href*="/messages/t/"], a[href*="/messages/e2ee/t/"], a[href^="/t/"], a[href^="/e2ee/t/"]'))
            .filter(visible)
            .map((node) => ({ node, label: labelOf(node), href: node.href || node.getAttribute('href') || '', ...centerOf(node) }))
            .filter((item) => item.rect.top > 120 && !targetPattern.test(item.label))
            .sort((a, b) => a.rect.top - b.rect.top)[0] ||
            controls
              .filter((item) =>
                (item.node.matches("button, [role='button'], [role='link'], a[href]") || item.node.closest("button, [role='button'], [role='link'], a[href]")) &&
                item.rect.top > 120 &&
                item.rect.left <= 40 &&
                item.rect.width >= 180 &&
                !targetPattern.test(item.label) &&
                !/\\b(loading|more options|back|facebook|search|conversation with|messages in conversation|start a voice call|start a video call|conversation information)\\b/i.test(item.label)
              )
              .sort((a, b) => a.rect.top - b.rect.top)[0] ||
            null;
          return {
            url: location.href,
            title: document.title,
            isTargetThread: /^\\/messages\\/(?:e2ee\\/)?t\\//i.test(location.pathname) && Boolean(targetSubview && back),
            bodyTextSample: document.body ? document.body.textContent.replace(/\\s+/g, ' ').trim().slice(0, 400) : '',
            rootClasses: document.documentElement.className,
            headerSuppressionActive: document.documentElement.classList.contains('md-fb-messages-viewport-fix'),
            clickableLabels: controls.map((item) => item.label).filter(Boolean).slice(0, 40),
            targetSubview: targetSubview ? { label: targetSubview.label, ...centerOf(targetSubview.node) } : null,
            back: back ? { label: back.label, ...centerOf(back.node) } : null,
            targetEntry: targetEntry ? { label: targetEntry.label, ...centerOf(targetEntry.node) } : null,
            archived: targetSubview ? { label: targetSubview.label, ...centerOf(targetSubview.node) } : null,
            archivedEntry: targetEntry ? { label: targetEntry.label, ...centerOf(targetEntry.node) } : null,
            homeEntry: homeEntry ? { label: homeEntry.label, ...centerOf(homeEntry.node) } : null,
            menuEntry: menuEntry ? { label: menuEntry.label, ...centerOf(menuEntry.node) } : null,
            thread: thread ? { label: thread.label, href: thread.href || null, ...centerOf(thread.node) } : null,
          };
        })()`,
        true,
      );
    },
    { targetLabel, targetPatternSource },
  );
}

async function clickPointIfPresent(app, item, description) {
  if (!item || typeof item.x !== "number" || typeof item.y !== "number") {
    throw new Error(`Could not find clickable ${description}`);
  }
  await sendInputClick(app, { x: item.x, y: item.y });
  await wait(1200);
}

async function waitForState(
  app,
  targetLabel,
  predicate,
  description,
  timeoutMs = 15000,
) {
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  while (Date.now() < deadline) {
    latest = await evaluatePageState(app, targetLabel);
    if (predicate(latest)) {
      return latest;
    }
    await wait(400);
  }
  throw new Error(
    `Timed out waiting for ${description}. Last state: ${JSON.stringify(latest, null, 2)}`,
  );
}

async function dwellOnSubviewThread(app, options, summary) {
  if (options.settleMs <= 0) {
    summary.dwell = {
      settleMs: options.settleMs,
      assertionIntervalMs: DWELL_ASSERT_INTERVAL_MS,
      skipped: true,
    };
    return;
  }

  const startedAt = Date.now();
  const deadline = startedAt + options.settleMs;
  const middleAt = startedAt + Math.floor(options.settleMs / 2);
  let capturedMiddle = false;
  let latest = null;

  summary.dwell = {
    settleMs: options.settleMs,
    assertionIntervalMs: DWELL_ASSERT_INTERVAL_MS,
    skipped: false,
    checks: [],
  };

  latest = await evaluatePageState(app, options.targetLabel);
  summary.states.targetThreadDwellStart = latest;
  summary.screenshots.targetThreadDwellStart = await screenshot(
    app,
    options.outputDir,
    "05a-target-thread-dwell-start",
  );

  while (Date.now() < deadline) {
    latest = await evaluatePageState(app, options.targetLabel);
    const elapsedMs = Date.now() - startedAt;
    const backVisible = Boolean(latest.back);
    const targetSubviewVisible = Boolean(latest.targetSubview);
    const headerSuppressionInactive = latest.headerSuppressionActive === false;
    summary.dwell.checks.push({
      elapsedMs,
      backVisible,
      targetSubviewVisible,
      headerSuppressionInactive,
      url: latest.url,
    });

    if (!backVisible || !targetSubviewVisible || !headerSuppressionInactive) {
      summary.states.targetThreadDwellFailure = latest;
      summary.screenshots.targetThreadDwellFailure = await screenshot(
        app,
        options.outputDir,
        "05x-target-thread-dwell-failure",
      );
      throw new Error(
        `${options.targetLabel} Back did not survive the ${options.settleMs}ms dwell. Latest state: ${JSON.stringify(latest, null, 2)}`,
      );
    }

    if (!capturedMiddle && Date.now() >= middleAt) {
      capturedMiddle = true;
      summary.states.targetThreadDwellMiddle = latest;
      summary.screenshots.targetThreadDwellMiddle = await screenshot(
        app,
        options.outputDir,
        "05b-target-thread-dwell-middle",
      );
    }

    await wait(Math.min(DWELL_ASSERT_INTERVAL_MS, Math.max(0, deadline - Date.now())));
  }

  latest = await evaluatePageState(app, options.targetLabel);
  if (!latest.back || !latest.targetSubview || latest.headerSuppressionActive) {
    summary.states.targetThreadDwellEnd = latest;
    summary.screenshots.targetThreadDwellEnd = await screenshot(
      app,
      options.outputDir,
      "05c-target-thread-dwell-end",
    );
    throw new Error(
      `${options.targetLabel} Back was not stable at dwell end. Latest state: ${JSON.stringify(latest, null, 2)}`,
    );
  }

  summary.states.targetThreadDwellEnd = latest;
  summary.screenshots.targetThreadDwellEnd = await screenshot(
    app,
    options.outputDir,
    "05c-target-thread-dwell-end",
  );
}

async function main() {
  const options = parseArgs(process.argv);
  fs.mkdirSync(options.outputDir, { recursive: true });

  const app = await (options.executablePath
    ? electron.launch({
        executablePath: options.executablePath,
        env: { ...process.env, MESSENGER_DISABLE_EXTENSIONS: "1" },
      })
    : electron.launch({
        args: [path.join(options.appRoot, "dist", "main", "main.js")],
        env: { ...process.env, MESSENGER_DISABLE_EXTENSIONS: "1" },
      }));

  const summary = {
    outputDir: options.outputDir,
    screenshots: {},
    states: {},
    verdict: "unknown",
  };

  try {
    await waitForAnyWindow(app);
    await navigate(app, "https://www.facebook.com/messages/");
    await waitForState(
      app,
      options.targetLabel,
      (state) =>
        state.clickableLabels.length > 0 ||
        /messenger|chats?|search messenger/i.test(state.bodyTextSample),
      "Messenger home controls",
      45000,
    );
    await wait(1000);

    summary.targetLabel = options.targetLabel;
    summary.states.home = await evaluatePageState(app, options.targetLabel);
    summary.screenshots.home = await screenshot(app, options.outputDir, "01-home");

    if (!summary.states.home.targetEntry) {
      if (!summary.states.home.menuEntry) {
        throw new Error(
          `Could not find ${options.targetLabel} or a Messenger menu entry`,
        );
      }
      await clickPointIfPresent(app, summary.states.home.menuEntry, "Messenger menu");
      await wait(800);
      summary.states.afterMenuClick = await evaluatePageState(
        app,
        options.targetLabel,
      );
      summary.screenshots.afterMenuClick = await screenshot(
        app,
        options.outputDir,
        "02-menu-click",
      );
      summary.states.afterMenu = await waitForState(
        app,
        options.targetLabel,
        (state) => Boolean(state.targetEntry),
        `${options.targetLabel} menu entry`,
        8000,
      );
      summary.screenshots.afterMenu = await screenshot(
        app,
        options.outputDir,
        "03-menu",
      );
    }

    const targetEntry =
      summary.states.afterMenu?.targetEntry || summary.states.home.targetEntry;
    await clickPointIfPresent(app, targetEntry, `${options.targetLabel} entry`);
    summary.states.targetList = await waitForState(
      app,
      options.targetLabel,
      (state) => Boolean(state.targetSubview && state.back),
      `${options.targetLabel} list with visible Back control`,
      30000,
    );
    summary.screenshots.targetList = await screenshot(
      app,
      options.outputDir,
      "04-target-list",
    );

    if (options.homeAfterSubview) {
      if (!summary.states.targetList.homeEntry) {
        throw new Error("Could not find Facebook Home entry in subview");
      }
      await clickPointIfPresent(
        app,
        summary.states.targetList.homeEntry,
        "Facebook Home entry",
      );
      summary.states.afterHome = await waitForState(
        app,
        options.targetLabel,
        (state) =>
          /\\bchats?\\b/i.test(state.bodyTextSample) &&
          !state.targetSubview,
        "Chats after Facebook Home from subview",
        12000,
      );
      summary.screenshots.afterHome = await screenshot(
        app,
        options.outputDir,
        "05-after-home",
      );
      summary.verdict = "pass";
      return;
    }

    if (summary.states.targetList.thread) {
      await clickPointIfPresent(
        app,
        summary.states.targetList.thread,
        `${options.targetLabel} row`,
      );
      summary.states.targetThread = await waitForState(
        app,
        options.targetLabel,
        (state) => Boolean(state.back),
        `${options.targetLabel} thread with visible Back control`,
      );
      summary.screenshots.targetThread = await screenshot(
        app,
        options.outputDir,
        "05-target-thread",
      );
      await dwellOnSubviewThread(app, options, summary);

      await clickPointIfPresent(
        app,
        summary.states.targetThread.back,
        `${options.targetLabel} thread Back control`,
      );
      summary.states.afterBack = await waitForState(
        app,
        options.targetLabel,
        (state) => Boolean(state.targetSubview && state.back),
        `return to ${options.targetLabel} list after thread Back`,
      );
    } else if (summary.states.targetList.isTargetThread) {
      summary.states.targetThread = summary.states.targetList;
      await dwellOnSubviewThread(app, options, summary);
      await clickPointIfPresent(
        app,
        summary.states.targetThread.back,
        `${options.targetLabel} thread Back control`,
      );
      summary.states.afterBack = await waitForState(
        app,
        options.targetLabel,
        (state) =>
          Boolean(state.targetSubview && state.back) ||
          (!state.targetSubview &&
            state.headerSuppressionActive &&
            state.clickableLabels.some((label) => /^chats$/i.test(label))),
        `return from preselected ${options.targetLabel} thread after Back`,
      );
    } else {
      summary.states.targetThread = null;
      await clickPointIfPresent(
        app,
        summary.states.targetList.back,
        `${options.targetLabel} list Back control`,
      );
      summary.states.afterBack = await waitForState(
        app,
        options.targetLabel,
        (state) =>
          !state.targetSubview &&
          state.headerSuppressionActive &&
          state.clickableLabels.some((label) => /^chats$/i.test(label)),
        "return to normal Chats with Facebook top bar hidden after list Back",
      );
    }
    summary.screenshots.afterBack = await screenshot(
      app,
      options.outputDir,
      "06-after-back",
    );

    summary.verdict = "passed";
    fs.writeFileSync(
      path.join(options.outputDir, "summary.json"),
      JSON.stringify(summary, null, 2),
      "utf8",
    );
    console.log(
      `PASS Messenger subview back GUI regression (${options.targetLabel}, ${options.outputDir})`,
    );
  } catch (error) {
    summary.verdict = "failed";
    summary.error = String(error && error.stack ? error.stack : error);
    fs.writeFileSync(
      path.join(options.outputDir, "summary.json"),
      JSON.stringify(summary, null, 2),
      "utf8",
    );
    console.error("FAIL Messenger subview back GUI regression:", error);
    process.exitCode = 1;
  } finally {
    await app.close().catch(() => {});
  }
}

main();
