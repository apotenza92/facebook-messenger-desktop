const { _electron: electron } = require("playwright");
const fs = require("fs");
const path = require("path");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const TOP_BAR_CHROME_SELECTORS = [
  '[role="banner"] [aria-label="Menu" i]',
  '[role="banner"] [aria-label="Messenger" i]',
  '[role="banner"] [aria-label*="Notifications" i]',
  '[role="banner"] [aria-label*="Account controls and settings" i]',
  '[role="banner"] [aria-label="Your profile" i]',
  '[role="banner"] [aria-label="Facebook" i]',
  '[role="banner"] [aria-label*="Search" i]',
  '[role="banner"] input[placeholder*="Search" i]',
  '[role="banner"] a[href="/"]',
  '[role="banner"] a[href="https://www.facebook.com/"]',
  '[role="banner"] a[href*="/notifications/"]',
  '[role="banner"] a[href="/messages/"]',
];

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
    threadUrl: process.env.MESSENGER_EMOJI_THREAD_URL || "",
    outputDir: path.join(
      process.cwd(),
      "test-screenshots",
      `emoji-composer-${ts()}`,
    ),
    cycles: 3,
    maxOpenMs: 2000,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--thread-url") {
      options.threadUrl = String(argv[++i] || "").trim();
    } else if (arg === "--output-dir") {
      options.outputDir = path.resolve(String(argv[++i] || "").trim());
    } else if (arg === "--cycles") {
      options.cycles = Math.max(1, Number(argv[++i]) || options.cycles);
    } else if (arg === "--max-open-ms") {
      options.maxOpenMs = Math.max(100, Number(argv[++i]) || options.maxOpenMs);
    } else if (arg === "--app-root") {
      options.appRoot = path.resolve(String(argv[++i] || "").trim());
    } else if (arg === "--executable-path") {
      options.executablePath = path.resolve(String(argv[++i] || "").trim());
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        `Usage: node scripts/test-emoji-composer-gui.js [options]\n\nOptions:\n  --thread-url <url>       Target conversation URL to validate\n  --cycles <n>             Number of open/select/close cycles (default: 3)\n  --max-open-ms <ms>       Maximum allowed picker-open latency (default: 2000)\n  --output-dir <dir>       Directory for summary.json and screenshots\n  --app-root <dir>         Alternate app root containing dist/main/main.js\n  --executable-path <path> Launch a packaged app binary instead of dist/main/main.js\n`,
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

async function evaluateInElectronPage(app, script) {
  return withPrimaryWebContents(
    app,
    async (wc, payload) => wc.executeJavaScript(payload.script, true),
    { script },
  );
}

async function sendInputClick(app, x, y) {
  return withPrimaryWebContents(
    app,
    async (wc, point) => {
      const px = Math.round(point.x);
      const py = Math.round(point.y);
      wc.sendInputEvent({ type: "mouseMove", x: px, y: py, button: "left" });
      wc.sendInputEvent({
        type: "mouseDown",
        x: px,
        y: py,
        button: "left",
        clickCount: 1,
      });
      wc.sendInputEvent({
        type: "mouseUp",
        x: px,
        y: py,
        button: "left",
        clickCount: 1,
      });
      return true;
    },
    { x, y },
  );
}

async function ensureElectronOnUrl(app, targetUrl) {
  if (!targetUrl) return null;
  return withPrimaryWebContents(
    app,
    async (wc, payload) => {
      await wc.loadURL(payload.targetUrl);
      return wc.getURL();
    },
    { targetUrl },
  );
}

async function discoverFirstThreadUrl(app) {
  return evaluateInElectronPage(
    app,
    `(() => {
      const anchors = Array.from(
        document.querySelectorAll('a[href*="/messages/t/"], a[href*="/messages/e2ee/t/"]'),
      );
      for (const anchor of anchors) {
        try {
          return new URL(anchor.href, window.location.origin).href;
        } catch {
          // Ignore malformed thread hrefs
        }
      }
      return null;
    })();`,
  );
}

async function waitFor(fn, timeoutMs, intervalMs, description) {
  const started = Date.now();
  let lastResult;
  while (Date.now() - started < timeoutMs) {
    lastResult = await fn();
    if (lastResult) {
      return { ok: true, elapsedMs: Date.now() - started, lastResult };
    }
    await wait(intervalMs);
  }
  return {
    ok: false,
    elapsedMs: Date.now() - started,
    lastResult,
    description,
  };
}

function buildComposerStateScript() {
  return `(() => {
    const isVisible = (el) => {
      if (!el || !(el instanceof HTMLElement)) return false;
      if (el.closest('[aria-hidden="true"]') || el.closest('[hidden]')) return false;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
      const rect = el.getBoundingClientRect();
      return rect.width >= 4 && rect.height >= 4;
    };
    const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const triggerSelectors = [
      '[aria-label*="emoji" i]',
      '[title*="emoji" i]',
      '[data-testid*="emoji"]',
    ];
    const overlaySelectors = [
      '[role="dialog"]',
      '[role="menu"]',
      '[role="listbox"]',
      '[role="grid"]',
      '[aria-modal="true"]',
      '[data-testid*="popover"]',
      '[data-testid*="emoji"]',
    ];
    const topBarSelectors = ${JSON.stringify(TOP_BAR_CHROME_SELECTORS)};
    const genericOptionPattern = /(close|search|recent|frequently|skin tone|sticker|gif|emoji picker|choose an emoji)/i;
    const collectVisibleLabels = (elements) => {
      const labels = [];
      for (const el of elements) {
        if (!isVisible(el)) continue;
        const label = normalize(el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '');
        if (!label) continue;
        labels.push(label);
      }
      return Array.from(new Set(labels));
    };
    const pickOverlay = () =>
      overlayCandidates.find((node) => {
        const rect = node.getBoundingClientRect();
        return rect.width >= 120 && rect.height >= 120;
      }) || overlayCandidates[0] || null;

    const emojiTriggers = Array.from(document.querySelectorAll(triggerSelectors.join(', ')))
      .filter((el) => isVisible(el))
      .map((el) => normalize(el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent))
      .filter(Boolean);

    const overlayCandidates = Array.from(document.querySelectorAll(overlaySelectors.join(', ')))
      .filter((el) => isVisible(el))
      .filter((el) => {
        const label = normalize(el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent).slice(0, 240);
        if (/(emoji|sticker|gif)/i.test(label)) return true;
        return Array.from(el.querySelectorAll('button, [role="button"], [aria-label]'))
          .slice(0, 12)
          .some((child) => /(emoji|sticker|gif)/i.test(normalize(child.getAttribute('aria-label') || child.textContent)));
      });

    const overlay = pickOverlay();
    const emojiOptions = overlay
      ? Array.from(
          overlay.querySelectorAll('button, [role="button"], [role="gridcell"], [tabindex], [data-testid]')
        )
          .filter((el) => isVisible(el))
          .map((el) => {
            const asset =
              (el.matches && el.matches('img[alt]') ? el : null) ||
              el.querySelector?.('img[alt]') ||
              null;
            const alt = normalize(asset && asset.getAttribute && asset.getAttribute('alt'));
            const label = normalize(
              (el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('title'))) ||
              alt ||
              el.textContent
            );
            const rect = el.getBoundingClientRect();
            return {
              label,
              alt,
              width: rect.width,
              height: rect.height,
              hasEmojiAsset: Boolean(alt),
            };
          })
          .filter((entry) => {
            if (!entry.label) return false;
            if (genericOptionPattern.test(entry.label)) return false;
            if (entry.width > 96 || entry.height > 96) return false;
            return entry.hasEmojiAsset || /\\p{Extended_Pictographic}/u.test(entry.label);
          })
      : [];
    const topBarChromeVisibleLabels = collectVisibleLabels(
      Array.from(document.querySelectorAll(topBarSelectors.join(', '))),
    );
    const topLeftChromeSquares = Array.from(
      document.querySelectorAll('button, [role="button"], a[href]')
    ).filter((el) => {
      if (!isVisible(el)) return false;
      const rect = el.getBoundingClientRect();
      if (rect.top > 84 || rect.left > 160) return false;
      if (rect.width < 24 || rect.height < 24 || rect.width > 96 || rect.height > 96) return false;
      if (Math.abs(rect.width - rect.height) > 12) return false;
      const label = normalize(el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent);
      return !/(choose an emoji|search messenger|search emoji|messenger|all|unread|groups)/i.test(label);
    });
    const topLeftChromeLabels = topLeftChromeSquares.map((el) =>
      normalize(el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent) || '<top-left-square>'
    );
    const allTopBarChromeLabels = Array.from(
      new Set([...topBarChromeVisibleLabels, ...topLeftChromeLabels]),
    );

    const composerCandidates = Array.from(
      document.querySelectorAll(
        'div[contenteditable="true"][role="textbox"], div[contenteditable="true"][aria-label*="message" i], div[contenteditable="true"]',
      ),
    ).filter((el) => isVisible(el));
    const composer = composerCandidates[0] || null;

    return {
      url: window.location.href,
      title: document.title,
      composerReady: composerCandidates.length > 0,
      emojiTriggerLabels: emojiTriggers.slice(0, 10),
      emojiPickerVisible: overlayCandidates.length > 0,
      overlayCount: overlayCandidates.length,
      composerCount: composerCandidates.length,
      emojiOptionCount: emojiOptions.length,
      emojiOptionLabels: emojiOptions.slice(0, 12).map((entry) => entry.label),
      topBarChromeVisible: allTopBarChromeLabels.length > 0,
      topBarChromeVisibleLabels: allTopBarChromeLabels.slice(0, 20),
      composerText: composer ? normalize(composer.textContent) : '',
      composerHtml: composer ? normalize(composer.innerHTML).slice(0, 400) : '',
    };
  })();`;
}

function buildFindEmojiTriggerPointScript() {
  return `(() => {
    const isVisible = (el) => {
      if (!el || !(el instanceof HTMLElement)) return false;
      if (el.closest('[aria-hidden="true"]') || el.closest('[hidden]')) return false;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
      const rect = el.getBoundingClientRect();
      return rect.width >= 4 && rect.height >= 4;
    };
    const candidates = Array.from(document.querySelectorAll('button, [role="button"], a[role="button"], [aria-label], [title]'));
    for (const el of candidates) {
      if (!isVisible(el)) continue;
      const label = String(el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '')
        .replace(/\\s+/g, ' ')
        .trim();
      if (!/emoji/i.test(label)) continue;
      el.scrollIntoView({ block: 'center', inline: 'nearest' });
      const rect = el.getBoundingClientRect();
      return {
        clicked: true,
        label,
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
      };
    }
    return { clicked: false, label: null, x: null, y: null };
  })();`;
}

function buildFindEmojiOptionPointScript() {
  return `(() => {
    const isVisible = (el) => {
      if (!el || !(el instanceof HTMLElement)) return false;
      if (el.closest('[aria-hidden="true"]') || el.closest('[hidden]')) return false;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
      const rect = el.getBoundingClientRect();
      return rect.width >= 4 && rect.height >= 4;
    };
    const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const genericOptionPattern = /(close|search|recent|frequently|skin tone|sticker|gif|emoji picker|choose an emoji)/i;
    const overlaySelectors = ['[role="dialog"]', '[role="menu"]', '[role="grid"]', '[role="listbox"]', '[aria-modal="true"]'];
    const overlays = Array.from(document.querySelectorAll(overlaySelectors.join(', '))).filter((el) => {
      if (!isVisible(el)) return false;
      const label = normalize(el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent).slice(0, 240);
      return /(emoji|sticker|gif)/i.test(label);
    });
    const overlay = overlays.find((el) => {
      const rect = el.getBoundingClientRect();
      return rect.width >= 120 && rect.height >= 120;
    }) || overlays[0];
    if (!overlay) return { inserted: false, label: null };

    const candidates = Array.from(
      overlay.querySelectorAll('button, [role="button"], [role="gridcell"], [tabindex], [data-testid]')
    );
    for (const el of candidates) {
      if (!isVisible(el)) continue;
      const asset =
        (el.matches && el.matches('img[alt]') ? el : null) ||
        el.querySelector?.('img[alt]') ||
        null;
      const alt = normalize(asset && asset.getAttribute && asset.getAttribute('alt'));
      const label = normalize(
        (el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('title'))) ||
        alt ||
        el.textContent
      );
      const rect = el.getBoundingClientRect();
      if (!label || genericOptionPattern.test(label)) continue;
      if (rect.width > 96 || rect.height > 96) continue;
      if (!(alt || /\\p{Extended_Pictographic}/u.test(label))) continue;
      return {
        inserted: true,
        label,
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
      };
    }

    return { inserted: false, label: null, x: null, y: null };
  })();`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  fs.mkdirSync(options.outputDir, { recursive: true });

  const app = await electron.launch(
    options.executablePath
      ? {
          executablePath: options.executablePath,
          env: {
            ...process.env,
            MESSENGER_DISABLE_EXTENSIONS: "1",
          },
        }
      : {
          args: [path.join(options.appRoot, "dist/main/main.js")],
          env: {
            ...process.env,
            MESSENGER_DISABLE_EXTENSIONS: "1",
          },
        },
  );

  try {
    const page = await waitForAnyWindow(app);
    await page.waitForLoadState("domcontentloaded");
    await wait(1500);

    let targetThreadUrl = options.threadUrl;
    if (!targetThreadUrl) {
      targetThreadUrl = (await discoverFirstThreadUrl(app)) || "";
    }

    if (targetThreadUrl) {
      await ensureElectronOnUrl(app, targetThreadUrl);
      await wait(1500);
    }

    const ready = await waitFor(
      async () => {
        const state = await evaluateInElectronPage(
          app,
          buildComposerStateScript(),
        );
        return state &&
          state.composerReady &&
          state.emojiTriggerLabels.length > 0
          ? state
          : false;
      },
      15000,
      500,
      "composer and emoji trigger to become visible",
    );
    if (!ready.ok) {
      throw new Error(
        `Composer/emoji trigger not ready. Last state: ${JSON.stringify(ready.lastResult)}`,
      );
    }

    const cycleResults = [];
    let openScreenshotPath = null;
    for (let cycle = 0; cycle < options.cycles; cycle += 1) {
      const before = await evaluateInElectronPage(
        app,
        buildComposerStateScript(),
      );
      const click = await evaluateInElectronPage(
        app,
        buildFindEmojiTriggerPointScript(),
      );
      if (!click.clicked) {
        throw new Error(`Cycle ${cycle + 1}: could not click emoji trigger`);
      }
      await sendInputClick(app, click.x, click.y);

      const opened = await waitFor(
        async () => {
          const state = await evaluateInElectronPage(
            app,
            buildComposerStateScript(),
          );
          return state && state.emojiPickerVisible && state.emojiOptionCount > 0
            ? state
            : false;
        },
        10000,
        300,
        `emoji picker to open on cycle ${cycle + 1}`,
      );
      if (!opened.ok) {
        throw new Error(
          `Cycle ${cycle + 1}: emoji picker did not open. Last state: ${JSON.stringify(opened.lastResult)}`,
        );
      }
      if (opened.elapsedMs > options.maxOpenMs) {
        throw new Error(
          `Cycle ${cycle + 1}: emoji picker opened too slowly (${opened.elapsedMs}ms > ${options.maxOpenMs}ms). State: ${JSON.stringify(opened.lastResult)}`,
        );
      }
      if (opened.lastResult?.topBarChromeVisible) {
        throw new Error(
          `Cycle ${cycle + 1}: Facebook top-bar chrome became visible while the emoji picker was open. State: ${JSON.stringify(opened.lastResult)}`,
        );
      }
      if (cycle === 0) {
        openScreenshotPath = path.join(
          options.outputDir,
          "emoji-composer-open.png",
        );
        await page.screenshot({ path: openScreenshotPath });
      }

      const inserted = await evaluateInElectronPage(
        app,
        buildFindEmojiOptionPointScript(),
      );
      if (!inserted.inserted) {
        throw new Error(
          `Cycle ${cycle + 1}: could not insert an emoji from the picker`,
        );
      }
      await sendInputClick(app, inserted.x, inserted.y);

      await page.keyboard.press("Escape").catch(() => {});
      await wait(800);

      const after = await evaluateInElectronPage(
        app,
        buildComposerStateScript(),
      );
      if (!after || !after.composerReady) {
        throw new Error(
          `Cycle ${cycle + 1}: composer was no longer ready after emoji interaction. State: ${JSON.stringify(after)}`,
        );
      }
      if (
        before &&
        after &&
        before.composerText === after.composerText &&
        before.composerHtml === after.composerHtml
      ) {
        throw new Error(
          `Cycle ${cycle + 1}: composer content did not change after emoji selection. Before: ${JSON.stringify(before)} After: ${JSON.stringify(after)}`,
        );
      }

      cycleResults.push({
        cycle: cycle + 1,
        triggerLabel: click.label,
        insertedLabel: inserted.label,
        openElapsedMs: opened.elapsedMs,
        openedState: opened.lastResult,
        beforeState: before,
        finalState: after,
      });
    }

    const screenshotPath = path.join(
      options.outputDir,
      "emoji-composer-final.png",
    );
    await page.screenshot({ path: screenshotPath });

    const summary = {
      ok: true,
      threadUrl: targetThreadUrl || null,
      cycles: options.cycles,
      cycleResults,
      openScreenshotPath,
      screenshotPath,
    };
    fs.writeFileSync(
      path.join(options.outputDir, "summary.json"),
      JSON.stringify(summary, null, 2),
      "utf8",
    );
    console.log(`PASS emoji composer GUI test (${options.cycles} cycles)`);
    console.log(
      `Summary written to ${path.join(options.outputDir, "summary.json")}`,
    );
  } finally {
    await app.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error("FAIL emoji composer GUI test failed:", error);
  process.exit(1);
});
