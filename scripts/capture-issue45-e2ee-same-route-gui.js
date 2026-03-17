const { _electron: electron } = require('playwright');
const path = require('path');
const fs = require('fs');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const DEFAULT_WINDOW_SIZE = { width: 1440, height: 960 };
const DEFAULT_CHECKPOINTS_MS = [180, 900];

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function sanitizeSegment(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'unnamed';
}

function parseWindowSize(rawValue) {
  if (!rawValue) return { ...DEFAULT_WINDOW_SIZE };
  const match = String(rawValue).match(/^(\d+)x(\d+)$/i);
  if (!match) {
    throw new Error(`Invalid --window-size value: ${rawValue}. Expected WIDTHxHEIGHT.`);
  }

  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 640 || height < 480) {
    throw new Error(`Invalid --window-size value: ${rawValue}. Minimum supported size is 640x480.`);
  }

  return { width, height };
}

function parseCheckpoints(rawValue) {
  if (!rawValue) return DEFAULT_CHECKPOINTS_MS.slice();
  const values = String(rawValue)
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((value) => Number.isFinite(value) && value >= 0);
  if (values.length === 0) {
    throw new Error(`Invalid --checkpoints value: ${rawValue}`);
  }
  return [...new Set(values.map((value) => Math.round(value)))].sort((a, b) => a - b);
}

function parseArgs(argv) {
  const options = {
    appRoot: process.env.MESSENGER_APP_ROOT
      ? path.resolve(process.env.MESSENGER_APP_ROOT)
      : path.resolve(__dirname, '..'),
    outputDir: path.join(process.cwd(), 'test-screenshots', `issue45-e2ee-same-route-${timestamp()}`),
    label: 'current',
    windowSize: { ...DEFAULT_WINDOW_SIZE },
    checkpointsMs: DEFAULT_CHECKPOINTS_MS.slice(),
    expect: 'any',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--app-root') {
      options.appRoot = path.resolve(argv[++i]);
    } else if (arg === '--output-dir') {
      options.outputDir = path.resolve(argv[++i]);
    } else if (arg === '--label') {
      options.label = String(argv[++i] || '').trim() || options.label;
    } else if (arg === '--window-size') {
      options.windowSize = parseWindowSize(argv[++i]);
    } else if (arg === '--checkpoints') {
      options.checkpointsMs = parseCheckpoints(argv[++i]);
    } else if (arg === '--expect') {
      options.expect = String(argv[++i] || 'any').trim().toLowerCase() || 'any';
    } else if (arg === '--help' || arg === '-h') {
      console.log(`Usage: node scripts/capture-issue45-e2ee-same-route-gui.js [options]\n\nOptions:\n  --app-root <dir>       Alternate app root containing dist/main/main.js\n  --output-dir <dir>     Directory for PNGs and summary.json\n  --label <name>         Label embedded in output filenames\n  --window-size <WxH>    Fixed Electron window size (default: ${DEFAULT_WINDOW_SIZE.width}x${DEFAULT_WINDOW_SIZE.height})\n  --checkpoints <csv>    Capture checkpoints in ms after click (default: ${DEFAULT_CHECKPOINTS_MS.join(',')})\n  --expect <mode>        any | broken | fixed\n`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!['any', 'broken', 'fixed'].includes(options.expect)) {
    throw new Error(`Unknown --expect value: ${options.expect}`);
  }

  return options;
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

async function configureMainWindow(app, size) {
  return app.evaluate(
    async ({ BrowserWindow }, windowSize) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (!win) throw new Error('No main window available');
      win.setSize(windowSize.width, windowSize.height);
      win.center();
      win.show();
      return {
        width: win.getBounds().width,
        height: win.getBounds().height,
      };
    },
    size,
  );
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
      await wc.loadURL('https://www.facebook.com/messages/').catch(async () => {
        await wc.loadURL('https://www.facebook.com/');
      });
      return wc.getURL();
    },
    null,
  );
}

async function installFixture(app, label) {
  return withPrimaryWebContents(
    app,
    async (wc, fixtureLabel) => {
      const script = `
        (() => {
          try {
            const ACTIVE = 'md-fb-messages-viewport-fix';
            const CLEAN = 'md-fb-media-viewer-clean';
            const LEFT = 'md-fb-media-dismiss-left';
            const FIXTURE_LABEL = ${JSON.stringify(fixtureLabel)};

            var oldRoot = document.getElementById('md-issue45-e2ee-root');
            if (oldRoot) oldRoot.remove();
            var oldStyle = document.getElementById('md-issue45-e2ee-style');
            if (oldStyle) oldStyle.remove();
            if (window.__mdIssue45SameRouteTimer1) clearTimeout(window.__mdIssue45SameRouteTimer1);
            if (window.__mdIssue45SameRouteTimer2) clearTimeout(window.__mdIssue45SameRouteTimer2);
            if (window.__mdIssue45SameRouteTimer3) clearTimeout(window.__mdIssue45SameRouteTimer3);
            delete window.__mdIssue45SameRouteTimer1;
            delete window.__mdIssue45SameRouteTimer2;
            delete window.__mdIssue45SameRouteTimer3;
            delete window.__mdIssue45SameRouteFixture;

            history.replaceState({}, '', '/messages/e2ee/t/fixture-e2ee-photo');

            var style = document.createElement('style');
            style.id = 'md-issue45-e2ee-style';
            style.textContent = 'body > *:not(#md-issue45-e2ee-root){display:none !important;}';
            document.head.appendChild(style);

            var root = document.createElement('div');
            root.id = 'md-issue45-e2ee-root';
            root.style.position = 'fixed';
            root.style.inset = '0';
            root.style.background = '#f5f7fb';
            root.style.zIndex = '2147483640';
            root.style.fontFamily = '-apple-system, BlinkMacSystemFont, sans-serif';
            document.body.appendChild(root);

            var shell = document.createElement('div');
            shell.style.position = 'absolute';
            shell.style.inset = '72px 56px 40px 360px';
            shell.style.background = '#fff';
            shell.style.borderRadius = '14px';
            shell.style.boxShadow = '0 1px 4px rgba(0,0,0,0.12)';
            shell.style.overflow = 'hidden';
            root.appendChild(shell);

            var header = document.createElement('div');
            header.style.height = '64px';
            header.style.display = 'flex';
            header.style.alignItems = 'center';
            header.style.padding = '0 20px';
            header.style.borderBottom = '1px solid #e5e7eb';
            header.innerHTML = '<div style="font-weight:700">Fixture E2EE thread</div>';
            shell.appendChild(header);

            var conversation = document.createElement('div');
            conversation.style.position = 'absolute';
            conversation.style.inset = '64px 0 0 0';
            conversation.style.background = 'linear-gradient(180deg, #fafbfd 0%, #f7f8fb 100%)';
            shell.appendChild(conversation);

            var bubble = document.createElement('div');
            bubble.style.position = 'absolute';
            bubble.style.right = '48px';
            bubble.style.top = '72px';
            bubble.style.maxWidth = '560px';
            bubble.style.background = '#6d12a9';
            bubble.style.color = '#fff';
            bubble.style.padding = '18px';
            bubble.style.borderRadius = '20px';
            bubble.style.lineHeight = '1.35';
            bubble.textContent = 'Fixture message above the photo so the route stays on /messages/e2ee/t/... while the viewer tries to open.';
            conversation.appendChild(bubble);

            var tile = document.createElement('button');
            tile.type = 'button';
            tile.setAttribute('role', 'button');
            tile.setAttribute('aria-label', 'Open photo fixture');
            tile.style.position = 'absolute';
            tile.style.left = '72px';
            tile.style.top = '220px';
            tile.style.width = '340px';
            tile.style.height = '228px';
            tile.style.border = '0';
            tile.style.padding = '0';
            tile.style.borderRadius = '18px';
            tile.style.overflow = 'hidden';
            tile.style.boxShadow = '0 10px 28px rgba(0,0,0,0.18)';
            tile.style.cursor = 'pointer';
            tile.style.background = 'linear-gradient(135deg, #6941c6 0%, #2563eb 42%, #0f172a 100%)';
            conversation.appendChild(tile);

            var fauxPhoto = document.createElement('div');
            fauxPhoto.setAttribute('role', 'img');
            fauxPhoto.setAttribute('aria-label', 'Fixture E2EE photo');
            fauxPhoto.style.position = 'absolute';
            fauxPhoto.style.inset = '0';
            fauxPhoto.style.background = 'radial-gradient(circle at 22% 25%, rgba(255,255,255,0.92), rgba(255,255,255,0.08) 26%), linear-gradient(135deg, #f59e0b 0%, #ef4444 28%, #7c3aed 62%, #111827 100%)';
            tile.appendChild(fauxPhoto);

            var tileLabel = document.createElement('div');
            tileLabel.style.position = 'absolute';
            tileLabel.style.left = '18px';
            tileLabel.style.bottom = '16px';
            tileLabel.style.padding = '8px 12px';
            tileLabel.style.borderRadius = '999px';
            tileLabel.style.background = 'rgba(17,24,39,0.58)';
            tileLabel.style.color = '#fff';
            tileLabel.style.fontSize = '13px';
            tileLabel.textContent = 'Tap to open E2EE photo';
            tile.appendChild(tileLabel);

            var status = document.createElement('div');
            status.id = 'md-issue45-e2ee-status';
            status.style.position = 'fixed';
            status.style.left = '24px';
            status.style.bottom = '24px';
            status.style.zIndex = '2147483647';
            status.style.background = 'rgba(15,23,42,0.86)';
            status.style.color = '#fff';
            status.style.padding = '10px 14px';
            status.style.borderRadius = '10px';
            status.style.font = '12px -apple-system, BlinkMacSystemFont, sans-serif';
            status.style.maxWidth = '520px';
            root.appendChild(status);

            var overlay = document.createElement('div');
            overlay.style.position = 'fixed';
            overlay.style.inset = '0';
            overlay.style.display = 'none';
            overlay.style.pointerEvents = 'none';
            overlay.style.zIndex = '2147483645';
            root.appendChild(overlay);

            var backdrop = document.createElement('div');
            backdrop.style.position = 'absolute';
            backdrop.style.inset = '0';
            backdrop.style.background = 'rgba(17,24,39,0.68)';
            overlay.appendChild(backdrop);

            var closeBtn = document.createElement('button');
            closeBtn.type = 'button';
            closeBtn.setAttribute('role', 'button');
            closeBtn.setAttribute('aria-label', 'Back to Previous Page');
            closeBtn.textContent = '‹';
            closeBtn.style.position = 'fixed';
            closeBtn.style.top = '8px';
            closeBtn.style.left = '-32px';
            closeBtn.style.width = '40px';
            closeBtn.style.height = '40px';
            closeBtn.style.border = '1px solid rgba(255,255,255,0.22)';
            closeBtn.style.borderRadius = '999px';
            closeBtn.style.background = 'rgba(17,24,39,0.88)';
            closeBtn.style.color = '#fff';
            closeBtn.style.fontSize = '24px';
            closeBtn.style.display = 'none';
            closeBtn.style.pointerEvents = 'auto';
            overlay.appendChild(closeBtn);

            var viewer = document.createElement('div');
            viewer.style.position = 'absolute';
            viewer.style.left = '50%';
            viewer.style.top = '54%';
            viewer.style.transform = 'translate(-50%, -50%)';
            viewer.style.width = '640px';
            viewer.style.height = '440px';
            viewer.style.borderRadius = '16px';
            viewer.style.background = 'linear-gradient(140deg, #111827 0%, #1d4ed8 32%, #7c3aed 70%, #0f172a 100%)';
            viewer.style.boxShadow = '0 24px 48px rgba(0,0,0,0.40)';
            viewer.style.display = 'none';
            overlay.appendChild(viewer);

            var viewerBadge = document.createElement('div');
            viewerBadge.style.position = 'absolute';
            viewerBadge.style.left = '24px';
            viewerBadge.style.bottom = '24px';
            viewerBadge.style.padding = '8px 12px';
            viewerBadge.style.borderRadius = '999px';
            viewerBadge.style.background = 'rgba(255,255,255,0.12)';
            viewerBadge.style.color = '#fff';
            viewerBadge.style.fontSize = '13px';
            viewerBadge.textContent = FIXTURE_LABEL;
            viewer.appendChild(viewerBadge);

            var downloadBtn = document.createElement('button');
            downloadBtn.type = 'button';
            downloadBtn.setAttribute('role', 'button');
            downloadBtn.setAttribute('aria-label', 'Download media attachment');
            downloadBtn.textContent = '↓';
            downloadBtn.style.position = 'fixed';
            downloadBtn.style.top = '10px';
            downloadBtn.style.right = '76px';
            downloadBtn.style.width = '36px';
            downloadBtn.style.height = '36px';
            downloadBtn.style.border = '1px solid rgba(255,255,255,0.22)';
            downloadBtn.style.borderRadius = '999px';
            downloadBtn.style.background = 'rgba(17,24,39,0.88)';
            downloadBtn.style.color = '#fff';
            downloadBtn.style.display = 'none';
            downloadBtn.style.pointerEvents = 'auto';
            overlay.appendChild(downloadBtn);

            var shareBtn = document.createElement('button');
            shareBtn.type = 'button';
            shareBtn.setAttribute('role', 'button');
            shareBtn.setAttribute('aria-label', 'Forward media attachment');
            shareBtn.textContent = '↗';
            shareBtn.style.position = 'fixed';
            shareBtn.style.top = '10px';
            shareBtn.style.right = '32px';
            shareBtn.style.width = '36px';
            shareBtn.style.height = '36px';
            shareBtn.style.border = '1px solid rgba(255,255,255,0.22)';
            shareBtn.style.borderRadius = '999px';
            shareBtn.style.background = 'rgba(17,24,39,0.88)';
            shareBtn.style.color = '#fff';
            shareBtn.style.display = 'none';
            shareBtn.style.pointerEvents = 'auto';
            overlay.appendChild(shareBtn);

            window.__mdIssue45SameRouteFixture = {
              opened: false,
              controlsMounted: false,
              clickCount: 0,
            };

            function updateStatus(labelText) {
              var classes = document.documentElement.classList;
              status.textContent = [
                labelText,
                'mediaClean=' + (classes.contains(CLEAN) ? 'yes' : 'no'),
                'activeCrop=' + (classes.contains(ACTIVE) ? 'yes' : 'no'),
                'leftDismiss=' + (classes.contains(LEFT) ? 'yes' : 'no'),
                'close=' + (closeBtn.style.display !== 'none' ? 'yes' : 'no'),
                'download=' + (downloadBtn.style.display !== 'none' ? 'yes' : 'no'),
                'share=' + (shareBtn.style.display !== 'none' ? 'yes' : 'no'),
              ].join(' | ');
            }

            function maybeMountControls(reason) {
              var fixture = window.__mdIssue45SameRouteFixture;
              if (!fixture || fixture.controlsMounted) {
                updateStatus(reason + ':already');
                return;
              }
              if (!document.documentElement.classList.contains(CLEAN)) {
                updateStatus(reason + ':waiting-media-clean');
                return;
              }
              fixture.controlsMounted = true;
              viewer.style.display = 'block';
              downloadBtn.style.display = 'block';
              shareBtn.style.display = 'block';
              updateStatus(reason + ':controls-mounted');
            }

            tile.addEventListener('click', function () {
              var fixture = window.__mdIssue45SameRouteFixture;
              fixture.opened = true;
              fixture.clickCount += 1;
              overlay.style.display = 'block';
              closeBtn.style.display = 'block';
              updateStatus('opened');
            });

            updateStatus('ready');

            window.__mdIssue45SameRouteTimer1 = window.setTimeout(function () {
              var rect = tile.getBoundingClientRect();
              var x = rect.left + rect.width / 2;
              var y = rect.top + rect.height / 2;
              var init = { bubbles: true, cancelable: true, clientX: x, clientY: y };
              tile.dispatchEvent(new MouseEvent('click', init));
            }, 24);
            window.__mdIssue45SameRouteTimer2 = window.setTimeout(function () {
              maybeMountControls('t220');
            }, 220);
            window.__mdIssue45SameRouteTimer3 = window.setTimeout(function () {
              maybeMountControls('t720');
            }, 720);

            return {
              url: window.location.href,
              route: window.location.pathname,
              fixtureLabel: FIXTURE_LABEL,
            };
          } catch (error) {
            return {
              error: String(error && error.message ? error.message : error),
              stack: String(error && error.stack ? error.stack : ''),
            };
          }
        })();
      `;
      return wc.executeJavaScript(script, true);
    },
    label,
  );
}

async function inspectState(app) {
  return withPrimaryWebContents(
    app,
    async (wc) => {
      const script = `
        (() => {
          const ACTIVE = 'md-fb-messages-viewport-fix';
          const CLEAN = 'md-fb-media-viewer-clean';
          const LEFT = 'md-fb-media-dismiss-left';
          function pick(selector) {
            return Array.from(document.querySelectorAll(selector)).map(function (node) {
              var el = node;
              var style = window.getComputedStyle(el);
              var rect = el.getBoundingClientRect();
              return {
                label: el.getAttribute('aria-label') || '',
                display: style.display,
                visibility: style.visibility,
                left: Math.round(rect.left),
                right: Math.round(rect.right),
                top: Math.round(rect.top),
                width: Math.round(rect.width),
                height: Math.round(rect.height),
              };
            }).filter(function (item) {
              return item.display !== 'none' && item.visibility !== 'hidden' && item.width >= 6 && item.height >= 6;
            });
          }
          return {
            url: window.location.href,
            classes: {
              mediaClean: document.documentElement.classList.contains(CLEAN),
              activeCrop: document.documentElement.classList.contains(ACTIVE),
              leftDismiss: document.documentElement.classList.contains(LEFT),
            },
            statusText: (document.getElementById('md-issue45-e2ee-status') || {}).textContent || '',
            controls: {
              close: pick('[aria-label="Back to Previous Page" i], button[aria-label="Back to Previous Page" i]'),
              download: pick('[aria-label*="Download" i], button[aria-label*="Download" i]'),
              share: pick('[aria-label*="Forward" i], button[aria-label*="Forward" i], [aria-label*="Share" i], button[aria-label*="Share" i]'),
            },
          };
        })();
      `;
      return wc.executeJavaScript(script, true);
    },
    null,
  );
}

function evaluateResult(state) {
  const closeVisible = state.controls.close.length > 0;
  const downloadVisible = state.controls.download.length > 0;
  const shareVisible = state.controls.share.length > 0;
  const fixed =
    state.classes.mediaClean === true &&
    state.classes.activeCrop === false &&
    closeVisible &&
    downloadVisible &&
    shareVisible;

  return {
    fixed,
    reason: fixed
      ? 'fixed'
      : !state.classes.mediaClean
        ? 'media-clean-missing'
        : state.classes.activeCrop
          ? 'crop-still-active'
          : !closeVisible
            ? 'close-missing'
            : !downloadVisible
              ? 'download-missing'
              : !shareVisible
                ? 'share-missing'
                : 'unknown',
  };
}

async function run() {
  const options = parseArgs(process.argv.slice(2));
  fs.mkdirSync(options.outputDir, { recursive: true });

  console.log('Output folder:', options.outputDir);
  console.log('App root:', options.appRoot);
  console.log('Label:', options.label);
  console.log('Checkpoints:', options.checkpointsMs.join(', '));
  console.log('Expect:', options.expect);

  const app = await electron.launch({
    args: [path.join(options.appRoot, 'dist/main/main.js')],
    env: {
      ...process.env,
      NODE_ENV: 'development',
    },
  });

  try {
    await wait(3500);
    const loadedUrl = await loadMessages(app);
    const appliedWindowSize = await configureMainWindow(app, options.windowSize);
    const fixtureInstall = await installFixture(app, options.label);
    if (fixtureInstall && fixtureInstall.error) {
      throw new Error(`Failed to install fixture: ${fixtureInstall.error}`);
    }

    const timeline = [];
    const baseName = sanitizeSegment(options.label);
    let previousCheckpoint = 0;

    for (const checkpoint of options.checkpointsMs) {
      const delta = Math.max(0, checkpoint - previousCheckpoint);
      if (delta > 0) {
        await wait(delta);
      }
      previousCheckpoint = checkpoint;

      const screenshotFile = `${baseName}-${String(checkpoint).padStart(4, '0')}ms.png`;
      const screenshotPath = path.join(options.outputDir, screenshotFile);
      await captureWindow(app, screenshotPath);
      const state = await inspectState(app);
      timeline.push({
        atMs: checkpoint,
        screenshotFile,
        state,
        evaluation: evaluateResult(state),
      });
    }

    const finalState = await inspectState(app);
    const evaluation = evaluateResult(finalState);
    const summary = {
      generatedAt: new Date().toISOString(),
      appRoot: options.appRoot,
      label: options.label,
      loadedUrl,
      appliedWindowSize,
      fixtureInstall,
      checkpointsMs: options.checkpointsMs,
      timeline,
      finalState,
      evaluation,
    };

    const summaryPath = path.join(options.outputDir, 'summary.json');
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
    console.log('Summary path:', summaryPath);

    if (options.expect === 'fixed' && !evaluation.fixed) {
      throw new Error(`Expected fixed result, got ${evaluation.reason}`);
    }
    if (options.expect === 'broken' && evaluation.fixed) {
      throw new Error('Expected broken result, but fixture evaluated as fixed');
    }
  } finally {
    await app.close().catch(() => {});
  }
}

run().catch((error) => {
  console.error('FAIL issue #45 E2EE same-route capture:', error.message || error);
  process.exit(1);
});
