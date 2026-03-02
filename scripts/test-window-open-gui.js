const { _electron: electron } = require('playwright');
const path = require('path');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function getPrimaryTargetInfo(electronApp) {
  return electronApp.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return { hasWindow: false, usingBrowserView: false, url: null };
    const views = win.getBrowserViews();
    if (views.length > 0) {
      return {
        hasWindow: true,
        usingBrowserView: true,
        url: views[0].webContents.getURL(),
      };
    }
    return {
      hasWindow: true,
      usingBrowserView: false,
      url: win.webContents.getURL(),
    };
  });
}

async function setupShellIntercept(electronApp) {
  await electronApp.evaluate(({ shell }) => {
    globalThis.__mdOpenedExternal = [];
    const original = shell.openExternal.bind(shell);
    globalThis.__mdOriginalOpenExternal = original;
    shell.openExternal = (url, options) => {
      globalThis.__mdOpenedExternal.push(String(url));
      return Promise.resolve();
    };
  });
}

async function restoreShellIntercept(electronApp) {
  await electronApp.evaluate(({ shell }) => {
    if (globalThis.__mdOriginalOpenExternal) {
      shell.openExternal = globalThis.__mdOriginalOpenExternal;
    }
  });
}

async function readState(electronApp) {
  return electronApp.evaluate(({ BrowserWindow }) => {
    const windows = BrowserWindow.getAllWindows();
    const mainWindow =
      windows.find((win) => win.getBrowserViews().length > 0) || windows[0];

    const childWindows = windows.filter((win) => win !== mainWindow);

    let mainTargetUrl = '';
    try {
      const mainViews = mainWindow?.getBrowserViews?.() || [];
      mainTargetUrl =
        mainViews.length > 0
          ? mainViews[0].webContents.getURL()
          : (mainWindow?.webContents.getURL() || '');
    } catch {
      mainTargetUrl = '';
    }

    return {
      windowCount: windows.length,
      childWindowCount: childWindows.length,
      mainTargetUrl,
      windowUrls: windows.map((win) => {
        try {
          return win.webContents.getURL();
        } catch {
          return 'about:blank';
        }
      }),
      openedExternal: [...(globalThis.__mdOpenedExternal || [])],
    };
  });
}

async function closeChildWindows(electronApp) {
  await electronApp.evaluate(({ BrowserWindow }) => {
    const wins = BrowserWindow.getAllWindows();
    const mainWindow =
      wins.find((win) => win.getBrowserViews().length > 0) || wins[0];

    for (const win of wins) {
      if (win !== mainWindow && !win.isDestroyed()) {
        win.close();
      }
    }
  });
}

async function triggerWindowOpen(electronApp, url) {
  await electronApp.evaluate(async ({ BrowserWindow }, targetUrl) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) throw new Error('No main window');

    const views = win.getBrowserViews();
    const wc = views.length > 0 ? views[0].webContents : win.webContents;
    const script = `(() => {
      const link = document.createElement('a');
      link.href = ${JSON.stringify(targetUrl)};
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.style.display = 'none';
      document.body.appendChild(link);
      link.click();
      link.remove();
    })();`;
    try {
      await wc.executeJavaScript(script, true);
    } catch {
      // Ignore result errors; open handler side effects are what we assert.
    }
  }, url);
}

async function triggerAboutBlankThenNavigate(electronApp, targetUrl) {
  await triggerAboutBlankNavigationSequence(electronApp, [targetUrl]);
}

async function triggerAboutBlankNavigationSequence(
  electronApp,
  navigationUrls,
  hopDelayMs = 120,
) {
  await electronApp.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) throw new Error('No main window');

    const views = win.getBrowserViews();
    const wc = views.length > 0 ? views[0].webContents : win.webContents;
    const script = `(() => {
      const popup = window.open('about:blank', '_blank', 'noopener,noreferrer');
      if (!popup) return;
    })();`;

    try {
      await wc.executeJavaScript(script, true);
    } catch {
      // Ignore result errors; open handler side effects are what we assert.
    }
  });

  await wait(hopDelayMs);

  for (const targetUrl of navigationUrls) {
    await electronApp.evaluate(async ({ BrowserWindow }, nextUrl) => {
      const windows = BrowserWindow.getAllWindows();
      const mainWindow =
        windows.find((win) => win.getBrowserViews().length > 0) || windows[0];
      const childWindow = [...windows]
        .reverse()
        .find((win) => win !== mainWindow && !win.isDestroyed());
      if (!childWindow) {
        throw new Error('No child window to navigate');
      }

      try {
        await childWindow.webContents.executeJavaScript(
          `window.location.href = ${JSON.stringify(nextUrl)};`,
          true,
        );
      } catch {
        // Ignore aborted navigations; side effects are asserted separately.
      }
    }, targetUrl);
    await wait(hopDelayMs);
  }
}

async function runCase(electronApp, testCase) {
  const before = await readState(electronApp);
  if (Array.isArray(testCase.bootstrapNavigationSequence)) {
    await triggerAboutBlankNavigationSequence(
      electronApp,
      testCase.bootstrapNavigationSequence,
      testCase.bootstrapHopDelayMs,
    );
  } else if (testCase.bootstrapViaAboutBlank) {
    await triggerAboutBlankThenNavigate(electronApp, testCase.url);
  } else {
    await triggerWindowOpen(electronApp, testCase.url);
  }
  await wait(typeof testCase.waitAfterMs === 'number' ? testCase.waitAfterMs : 800);
  const after = await readState(electronApp);

  const newWindows = after.childWindowCount - before.childWindowCount;
  const newExternal = after.openedExternal.slice(before.openedExternal.length);

  const externalPass = testCase.expected.externalUrl
    ? newExternal.includes(testCase.expected.externalUrl)
    : newExternal.length === 0;

  const inAppPass = testCase.expected.inAppUrlContains
    ? after.mainTargetUrl.includes(testCase.expected.inAppUrlContains)
    : true;

  const pass =
    newWindows === testCase.expected.newWindows && externalPass && inAppPass;

  return {
    name: testCase.name,
    url: testCase.url,
    pass,
    observed: {
      newWindows,
      newExternal,
      mainTargetUrl: after.mainTargetUrl,
      windowUrls: after.windowUrls,
    },
    expected: testCase.expected,
  };
}

async function run() {
  console.log('\n🧪 GUI window-open behavior test\n');

  const electronApp = await electron.launch({
    args: [path.join(__dirname, '../dist/main/main.js')],
    env: {
      ...process.env,
      NODE_ENV: 'development',
    },
  });

  try {
    await wait(3500);

    const targetInfo = await getPrimaryTargetInfo(electronApp);
    console.log('Primary target:', targetInfo);

    await setupShellIntercept(electronApp);
    await closeChildWindows(electronApp);

    const cases = [
      {
        name: 'Call-like Facebook URL opens child call window',
        url: 'https://www.facebook.com/videochat/',
        expected: { newWindows: 1 },
      },
      {
        name: 'About:blank bootstrap to trusted non-call Facebook thread is rerouted to main view',
        url: 'https://www.facebook.com/messages/t/1234567890',
        bootstrapViaAboutBlank: true,
        expected: {
          newWindows: 0,
          inAppUrlContains: '/messages/t/1234567890',
        },
      },
      {
        name: 'About:blank multi-hop bootstrap (call-safe hops) stays in child window',
        url: 'https://www.facebook.com/videochat/',
        bootstrapNavigationSequence: [
          'https://www.facebook.com/videochat/?step=1',
          'https://www.facebook.com/videochat/?step=2',
          'https://www.facebook.com/videochat/',
        ],
        waitAfterMs: 1200,
        expected: { newWindows: 1 },
      },
      {
        name: 'About:blank outgoing-call bootstrap (call-safe -> thread -> call) stays in child window',
        url: 'https://www.facebook.com/videochat/',
        bootstrapNavigationSequence: [
          'https://www.facebook.com/videochat/?step=entry',
          'https://www.facebook.com/messages/t/1234567890',
          'https://www.facebook.com/videochat/?step=final',
        ],
        waitAfterMs: 1200,
        expected: { newWindows: 1 },
      },
      {
        name: 'About:blank bootstrap allows trusted intermediate non-call hop before final call URL',
        url: 'https://www.facebook.com/videochat/',
        bootstrapNavigationSequence: [
          'https://www.facebook.com/ajax/call_bootstrap_bridge/',
          'https://www.facebook.com/videochat/',
        ],
        waitAfterMs: 1200,
        expected: { newWindows: 1 },
      },
      {
        name: 'About:blank outgoing-call bootstrap (trusted intermediate -> thread -> call) stays in child window',
        url: 'https://www.facebook.com/videochat/',
        bootstrapNavigationSequence: [
          'https://www.facebook.com/videochat/?step=entry',
          'https://www.facebook.com/ajax/call_bootstrap_bridge/',
          'https://www.facebook.com/messages/t/1234567890',
          'https://www.facebook.com/videochat/?step=final',
        ],
        waitAfterMs: 1200,
        expected: { newWindows: 1 },
      },
      {
        name: 'About:blank cross-domain bootstrap (facebook -> messenger -> facebook call) stays in child window',
        url: 'https://www.facebook.com/videochat/',
        bootstrapNavigationSequence: [
          'https://www.facebook.com/videochat/?step=fb',
          'https://www.messenger.com/call/start/?thread_id=3333333333',
          'https://www.facebook.com/videochat/',
        ],
        waitAfterMs: 1200,
        expected: { newWindows: 1 },
      },
      {
        name: 'About:blank bootstrap to trusted non-call messenger URL is blocked and routed external',
        url: 'https://www.messenger.com/',
        bootstrapNavigationSequence: [
          'https://www.facebook.com/videochat/',
          'https://www.messenger.com/',
        ],
        waitAfterMs: 1200,
        expected: { newWindows: 0, externalUrl: 'https://www.messenger.com/' },
      },
      {
        name: 'About:blank bootstrap external escape is blocked and routed external',
        url: 'https://example.com/',
        bootstrapNavigationSequence: [
          'https://www.facebook.com/videochat/?step=entry',
          'https://example.com/',
        ],
        waitAfterMs: 1200,
        expected: { newWindows: 0, externalUrl: 'https://example.com/' },
      },
      {
        name: 'Facebook thread URL opens in-app (no child window)',
        url: 'https://www.facebook.com/messages/t/1234567890',
        expected: {
          newWindows: 0,
          inAppUrlContains: '/messages/t/1234567890',
        },
      },
      {
        name: 'Non-Facebook URL opens external browser',
        url: 'https://example.com/',
        expected: { newWindows: 0, externalUrl: 'https://example.com/' },
      },
    ];

    const results = [];
    for (const testCase of cases) {
      const result = await runCase(electronApp, testCase);
      results.push(result);
      console.log(`${result.pass ? '✅' : '❌'} ${result.name}`);
      if (!result.pass) {
        console.log('   expected:', result.expected);
        console.log('   observed:', result.observed);
      }
      await closeChildWindows(electronApp);
      await wait(250);
    }

    const failed = results.filter((r) => !r.pass);
    if (failed.length > 0) {
      throw new Error(`${failed.length} GUI case(s) failed`);
    }

    console.log('\nPASS GUI window-open behavior test');
  } finally {
    await restoreShellIntercept(electronApp).catch(() => {});
    await electronApp.close().catch(() => {});
  }
}

run().catch((err) => {
  console.error('\nFAIL GUI window-open behavior test:', err.message || err);
  process.exit(1);
});
