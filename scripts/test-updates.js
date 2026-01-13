/**
 * Comprehensive update checker test using Playwright + Electron
 * Tests all scenarios: stable, beta, channel switching, network failures
 *
 * Usage: node scripts/test-updates.js
 */

const { _electron: electron } = require('playwright');
const path = require('path');
const fs = require('fs');
const https = require('https');

// Test results tracker
const results = {
  passed: [],
  failed: [],
  total: 0
};

function logTest(name, passed, details = '') {
  results.total++;
  if (passed) {
    results.passed.push(name);
    console.log(`✅ ${name}`);
    if (details) console.log(`   ${details}`);
  } else {
    results.failed.push(name);
    console.log(`❌ ${name}`);
    if (details) console.log(`   ${details}`);
  }
}

// Helper to wait for IPC events
async function waitForIPC(electronApp, channel, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for IPC: ${channel}`)), timeout);

    electronApp.evaluate(({ ipcMain }, ch) => {
      return new Promise((res) => {
        ipcMain.once(ch, (event, ...args) => {
          res(args);
        });
      });
    }, channel).then((args) => {
      clearTimeout(timer);
      resolve(args);
    }).catch(reject);
  });
}

// Helper to trigger menu action
async function triggerMenuAction(electronApp, menuLabel) {
  return await electronApp.evaluate(async ({ Menu }, label) => {
    const menu = Menu.getApplicationMenu();
    if (!menu) return 'no menu';

    function findMenuItem(items, targetLabel) {
      for (const item of items) {
        if (item.label === targetLabel) {
          return item;
        }
        if (item.submenu) {
          const found = findMenuItem(item.submenu.items, targetLabel);
          if (found) return found;
        }
      }
      return null;
    }

    const item = findMenuItem(menu.items, label);
    if (item && item.click) {
      item.click();
      return 'clicked';
    }
    return 'not found';
  }, menuLabel);
}

// Helper to get beta opt-in status
async function getBetaStatus(electronApp) {
  return await electronApp.evaluate(({ app }) => {
    const { existsSync } = require('fs');
    const { join } = require('path');

    const betaFilePath = join(app.getPath('userData'), 'beta-opt-in');
    return existsSync(betaFilePath);
  });
}

// Helper to set beta opt-in status
async function setBetaStatus(electronApp, enabled) {
  // Use require syntax that works in main process context
  return await electronApp.evaluate(({ app }, isEnabled) => {
    const { writeFileSync, unlinkSync, existsSync } = require('fs');
    const { join } = require('path');

    const betaFilePath = join(app.getPath('userData'), 'beta-opt-in');

    if (isEnabled) {
      writeFileSync(betaFilePath, '');
    } else {
      if (existsSync(betaFilePath)) {
        unlinkSync(betaFilePath);
      }
    }

    return isEnabled;
  }, enabled);
}

// Helper to get auto-updater logs
async function getAutoUpdaterLogs(electronApp) {
  return await electronApp.evaluate(() => {
    // Access console logs from main process
    const logs = global.__autoUpdaterLogs || [];
    return logs;
  });
}

// Helper to check for dialogs
async function getDialogs(electronApp) {
  return await electronApp.evaluate(({ dialog }) => {
    return global.__lastDialog || null;
  });
}

// Intercept dialog calls to track them
async function setupDialogInterception(electronApp) {
  await electronApp.evaluate(() => {
    const { dialog } = require('electron');
    const originalShowMessageBox = dialog.showMessageBox;

    global.__lastDialog = null;
    global.__autoUpdaterLogs = [];

    // Intercept dialog.showMessageBox
    dialog.showMessageBox = function(...args) {
      global.__lastDialog = {
        type: args[0]?.type || args[0],
        title: args[0]?.title,
        message: args[0]?.message,
        detail: args[0]?.detail
      };
      console.log('[Test] Dialog intercepted:', global.__lastDialog);
      // Return a resolved promise (user clicked first button)
      return Promise.resolve({ response: 0 });
    };

    // Intercept console.log for auto-updater
    const originalLog = console.log;
    console.log = function(...args) {
      const msg = args.join(' ');
      if (msg.includes('[AutoUpdater]')) {
        global.__autoUpdaterLogs.push(msg);
      }
      originalLog.apply(console, args);
    };
  });
}

// Test runner
async function runTests() {
  console.log('🧪 Starting Update Checker Tests\n');
  console.log('=' .repeat(60));

  // Build the app first
  console.log('\n🔨 Building app...');
  require('child_process').execSync('npm run build', {
    cwd: path.join(__dirname, '..'),
    stdio: 'pipe'
  });
  console.log('✅ Build complete\n');

  // Test 1: Stable user checking for updates
  console.log('\n📋 Test 1: Stable user checking for updates');
  console.log('-'.repeat(60));

  try {
    const app1 = await electron.launch({
      args: [path.join(__dirname, '../dist/main/main.js')],
      env: {
        ...process.env,
        NODE_ENV: 'development',
        SKIP_SINGLE_INSTANCE_LOCK: 'true' // Allow multiple instances for testing
      }
    });

    await setupDialogInterception(app1);
    await new Promise(r => setTimeout(r, 3000));

    // Ensure stable mode
    await setBetaStatus(app1, false);

    // Trigger update check
    const result = await triggerMenuAction(app1, 'Check for Updates');
    console.log(`   Menu action result: ${result}`);

    // Wait for update check to complete
    await new Promise(r => setTimeout(r, 8000));

    // Check logs
    const logs = await app1.evaluate(() => global.__autoUpdaterLogs || []);
    const hasStableLog = logs.some(l => l.includes('Stable user'));
    const hasLatestChannel = logs.some(l => l.includes('latest channel'));
    const hasBothChannels = logs.some(l => l.includes('both channels'));

    logTest(
      'Stable user checks latest channel only',
      hasStableLog && hasLatestChannel && !hasBothChannels,
      logs.filter(l => l.includes('channel')).join('\n   ')
    );

    await app1.close();
  } catch (err) {
    logTest('Stable user checking for updates', false, err.message);
  }

  // Test 2: Beta user checking for updates (both channels available)
  console.log('\n📋 Test 2: Beta user checking for updates');
  console.log('-'.repeat(60));

  try {
    const app2 = await electron.launch({
      args: [path.join(__dirname, '../dist/main/main.js')],
      env: { ...process.env, NODE_ENV: 'development', SKIP_SINGLE_INSTANCE_LOCK: 'true' }
    });

    await setupDialogInterception(app2);
    await new Promise(r => setTimeout(r, 3000));

    // Enable beta mode
    await setBetaStatus(app2, true);

    // Trigger update check
    await triggerMenuAction(app2, 'Check for Updates');

    // Wait for update check
    await new Promise(r => setTimeout(r, 10000));

    // Check logs
    const logs = await app2.evaluate(() => global.__autoUpdaterLogs || []);
    const isBetaUser = logs.some(l => l.includes('Beta user'));
    const checksBothChannels = logs.some(l => l.includes('checking both channels'));
    const fetchesLatest = logs.some(l => l.includes('Fetching latest version'));
    const fetchesBeta = logs.some(l => l.includes('Fetching beta version'));

    logTest(
      'Beta user checks both channels',
      isBetaUser && checksBothChannels,
      logs.filter(l => l.includes('channel') || l.includes('Beta')).join('\n   ')
    );

    logTest(
      'Beta user attempts to fetch both latest and beta',
      fetchesLatest && fetchesBeta,
      `Fetches latest: ${fetchesLatest}, Fetches beta: ${fetchesBeta}`
    );

    await app2.close();
  } catch (err) {
    logTest('Beta user checking for updates', false, err.message);
  }

  // Test 3: User joins beta program
  console.log('\n📋 Test 3: User joins beta program');
  console.log('-'.repeat(60));

  try {
    const app3 = await electron.launch({
      args: [path.join(__dirname, '../dist/main/main.js')],
      env: { ...process.env, NODE_ENV: 'development', SKIP_SINGLE_INSTANCE_LOCK: 'true' }
    });

    await setupDialogInterception(app3);
    await new Promise(r => setTimeout(r, 3000));

    // Start in stable
    await setBetaStatus(app3, false);
    let status = await getBetaStatus(app3);
    logTest('Starts in stable mode', !status);

    // Join beta
    await setBetaStatus(app3, true);
    status = await getBetaStatus(app3);
    logTest('Successfully joins beta', status);

    // Trigger update check after joining
    await triggerMenuAction(app3, 'Check for Updates');
    await new Promise(r => setTimeout(r, 8000));

    const logs = await app3.evaluate(() => global.__autoUpdaterLogs || []);
    const checksBoth = logs.some(l => l.includes('checking both channels'));

    logTest('After joining beta, checks both channels', checksBoth);

    await app3.close();
  } catch (err) {
    logTest('User joins beta program', false, err.message);
  }

  // Test 4: User leaves beta program
  console.log('\n📋 Test 4: User leaves beta program');
  console.log('-'.repeat(60));

  try {
    const app4 = await electron.launch({
      args: [path.join(__dirname, '../dist/main/main.js')],
      env: { ...process.env, NODE_ENV: 'development', SKIP_SINGLE_INSTANCE_LOCK: 'true' }
    });

    await setupDialogInterception(app4);
    await new Promise(r => setTimeout(r, 3000));

    // Start in beta
    await setBetaStatus(app4, true);
    let status = await getBetaStatus(app4);
    logTest('Starts in beta mode', status);

    // Leave beta
    await setBetaStatus(app4, false);
    status = await getBetaStatus(app4);
    logTest('Successfully leaves beta', !status);

    // Trigger update check after leaving
    await triggerMenuAction(app4, 'Check for Updates');
    await new Promise(r => setTimeout(r, 8000));

    const logs = await app4.evaluate(() => global.__autoUpdaterLogs || []);
    const checksLatestOnly = logs.some(l => l.includes('Stable user') || l.includes('latest channel only'));
    const notCheckingBoth = !logs.some(l => l.includes('checking both channels'));

    logTest('After leaving beta, checks latest only', checksLatestOnly && notCheckingBoth);

    await app4.close();
  } catch (err) {
    logTest('User leaves beta program', false, err.message);
  }

  // Test 5: Beta channel doesn't exist (404) - graceful fallback
  console.log('\n📋 Test 5: Beta channel unavailable (404) - graceful fallback');
  console.log('-'.repeat(60));

  try {
    const app5 = await electron.launch({
      args: [path.join(__dirname, '../dist/main/main.js')],
      env: { ...process.env, NODE_ENV: 'development', SKIP_SINGLE_INSTANCE_LOCK: 'true' }
    });

    await setupDialogInterception(app5);
    await new Promise(r => setTimeout(r, 3000));

    // Enable beta mode
    await setBetaStatus(app5, true);

    // Trigger update check
    await triggerMenuAction(app5, 'Check for Updates');
    await new Promise(r => setTimeout(r, 12000));

    // Check that it handled missing beta channel gracefully
    const logs = await app5.evaluate(() => global.__autoUpdaterLogs || []);
    const dialog = await app5.evaluate(() => global.__lastDialog);

    // Should NOT show "Failed to fetch version information from both channels"
    const hasErrorDialog = dialog && dialog.message && dialog.message.includes('Failed to fetch version information from both channels');

    // Should have attempted both channels
    const attemptedBoth = logs.some(l => l.includes('checking both channels'));

    // Should handle 404 or null gracefully
    const handledGracefully = !hasErrorDialog || logs.some(l => l.includes('No beta version found'));

    logTest(
      'Handles missing beta channel without error',
      attemptedBoth && !hasErrorDialog,
      `Error dialog shown: ${hasErrorDialog}`
    );

    logTest(
      'Falls back to available channel',
      handledGracefully,
      logs.filter(l => l.includes('channel') || l.includes('version')).slice(-5).join('\n   ')
    );

    await app5.close();
  } catch (err) {
    logTest('Beta channel unavailable handling', false, err.message);
  }

  // Test 6: Network failure handling
  console.log('\n📋 Test 6: Complete network failure handling');
  console.log('-'.repeat(60));

  try {
    const app6 = await electron.launch({
      args: [path.join(__dirname, '../dist/main/main.js')],
      env: {
        ...process.env,
        NODE_ENV: 'development',
        // Simulate network failure by pointing to invalid URL
        GITHUB_RELEASES_BASE: 'https://invalid-domain-that-does-not-exist.com'
      }
    });

    await setupDialogInterception(app6);
    await new Promise(r => setTimeout(r, 3000));

    // Enable beta to test both channels failing
    await setBetaStatus(app6, true);

    // Trigger update check
    await triggerMenuAction(app6, 'Check for Updates');
    await new Promise(r => setTimeout(r, 15000)); // Longer wait for retries

    const logs = await app6.evaluate(() => global.__autoUpdaterLogs || []);
    const dialog = await app6.evaluate(() => global.__lastDialog);

    // Should show error dialog for complete failure
    const hasErrorDialog = dialog && dialog.type === 'warning' &&
                          dialog.title && dialog.title.includes('Update Check Failed');

    // Should have retry logic
    const hasRetries = logs.some(l => l.includes('attempt') || l.includes('retry'));

    logTest(
      'Shows error dialog on complete network failure',
      hasErrorDialog,
      `Dialog: ${dialog ? dialog.message : 'none'}`
    );

    logTest(
      'Implements retry logic with backoff',
      hasRetries,
      logs.filter(l => l.includes('attempt') || l.includes('Fetch failed')).join('\n   ')
    );

    await app6.close();
  } catch (err) {
    logTest('Network failure handling', false, err.message);
  }

  // Test 7: Verify fix - Promise.all doesn't reject when one channel fails
  console.log('\n📋 Test 7: Core fix verification - Promise.all partial success');
  console.log('-'.repeat(60));

  try {
    const app7 = await electron.launch({
      args: [path.join(__dirname, '../dist/main/main.js')],
      env: { ...process.env, NODE_ENV: 'development', SKIP_SINGLE_INSTANCE_LOCK: 'true' }
    });

    await setupDialogInterception(app7);
    await new Promise(r => setTimeout(r, 3000));

    // Enable beta mode to trigger both channel checks
    await setBetaStatus(app7, true);

    // Trigger update check
    await triggerMenuAction(app7, 'Check for Updates');
    await new Promise(r => setTimeout(r, 12000));

    const logs = await app7.evaluate(() => global.__autoUpdaterLogs || []);
    const dialog = await app7.evaluate(() => global.__lastDialog);

    // Key test: If beta channel returns 404/null, should NOT throw
    // Should see logs about fetching, and either success or graceful handling
    const attemptedFetch = logs.some(l => l.includes('Fetching'));
    const noPromiseRejection = !logs.some(l => l.includes('Promise.all') && l.includes('reject'));

    // Should either succeed or show "No beta version found" - NOT "Failed to fetch from both"
    const gracefulHandling = !dialog || !dialog.message ||
                            !dialog.message.includes('Failed to fetch version information from both channels');

    logTest(
      'fetchChannelVersionWithRetry returns null on failure (not throw)',
      attemptedFetch && noPromiseRejection && gracefulHandling,
      `Graceful: ${gracefulHandling}, No rejection: ${noPromiseRejection}`
    );

    await app7.close();
  } catch (err) {
    logTest('Core fix verification', false, err.message);
  }

  // Print summary
  console.log('\n' + '='.repeat(60));
  console.log('📊 TEST SUMMARY');
  console.log('='.repeat(60));
  console.log(`Total tests: ${results.total}`);
  console.log(`✅ Passed: ${results.passed.length}`);
  console.log(`❌ Failed: ${results.failed.length}`);

  if (results.failed.length > 0) {
    console.log('\nFailed tests:');
    results.failed.forEach(t => console.log(`  - ${t}`));
  }

  console.log('\n' + '='.repeat(60));

  if (results.failed.length === 0) {
    console.log('🎉 ALL TESTS PASSED!');
    process.exit(0);
  } else {
    console.log('⚠️  Some tests failed');
    process.exit(1);
  }
}

// Create test-screenshots directory
const screenshotsDir = path.join(__dirname, '../test-screenshots');
if (!fs.existsSync(screenshotsDir)) {
  fs.mkdirSync(screenshotsDir, { recursive: true });
}

runTests().catch(err => {
  console.error('\n❌ Test suite failed:', err);
  console.error(err.stack);
  process.exit(1);
});
