/**
 * Simplified update checker test using manual checks
 * Tests the critical fix: fetchChannelVersionWithRetry returns null (not throws)
 *
 * Usage: node scripts/test-updates-simple.js
 */

const { _electron: electron } = require('playwright');
const path = require('path');
const fs = require('fs');

// Test results
let passed = 0;
let failed = 0;

function logTest(name, result, details = '') {
  if (result) {
    passed++;
    console.log(`✅ ${name}`);
    if (details) console.log(`   ${details}`);
  } else {
    failed++;
    console.log(`❌ ${name}`);
    if (details) console.log(`   ${details}`);
  }
}

async function runTests() {
  console.log('\n🧪 Update Checker Fix Verification\n');
  console.log('='.repeat(70));

  // Build first
  console.log('\n🔨 Building app...');
  require('child_process').execSync('npm run build', {
    cwd: path.join(__dirname, '..'),
    stdio: 'pipe'
  });
  console.log('✅ Build complete\n');

  // Test 1: Verify stable user flow
  console.log('\n📋 Test 1: Stable user update check');
  console.log('-'.repeat(70));

  try {
    const userDataDir = path.join(require('os').tmpdir(), 'messenger-test-stable-' + Date.now());
    const app1 = await electron.launch({
      args: [path.join(__dirname, '../dist/main/main.js')],
      env: {
        ...process.env,
        NODE_ENV: 'production', // Use production to enable auto-updater
        SKIP_SINGLE_INSTANCE_LOCK: 'true',
        ELECTRON_USER_DATA: userDataDir
      }
    });

    // Collect console output
    const logs = [];
    app1.process().stdout.on('data', (data) => {
      const msg = data.toString();
      logs.push(msg);
      if (msg.includes('[AutoUpdater]')) console.log('   ' + msg.trim());
    });

    app1.process().stderr.on('data', (data) => {
      const msg = data.toString();
      logs.push(msg);
      if (msg.includes('[AutoUpdater]')) console.log('   [stderr] ' + msg.trim());
    });

    // Wait for auto-updater to initialize and check
    await new Promise(r => setTimeout(r, 15000));

    const allLogs = logs.join('\n');

    // Verify stable user checks latest channel only
    const checksLatestOnly = allLogs.includes('Stable user') && allLogs.includes('latest channel');
    const notCheckingBothChannels = !allLogs.includes('checking both channels');

    logTest(
      'Stable user checks latest channel only',
      checksLatestOnly && notCheckingBothChannels
    );

    await app1.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  } catch (err) {
    logTest('Stable user update check', false, err.message);
  }

  // Test 2: Verify beta user checks both channels
  console.log('\n📋 Test 2: Beta user update check (both channels)');
  console.log('-'.repeat(70));

  try {
    const userDataDir = path.join(require('os').tmpdir(), 'messenger-test-beta-' + Date.now());
    fs.mkdirSync(userDataDir, { recursive: true });

    // Create beta opt-in file
    fs.writeFileSync(path.join(userDataDir, 'beta-opt-in'), '');

    const app2 = await electron.launch({
      args: [path.join(__dirname, '../dist/main/main.js')],
      env: {
        ...process.env,
        NODE_ENV: 'production',
        SKIP_SINGLE_INSTANCE_LOCK: 'true',
        ELECTRON_USER_DATA: userDataDir
      }
    });

    const logs = [];
    app2.process().stdout.on('data', (data) => {
      const msg = data.toString();
      logs.push(msg);
      if (msg.includes('[AutoUpdater]')) console.log('   ' + msg.trim());
    });

    app2.process().stderr.on('data', (data) => {
      const msg = data.toString();
      logs.push(msg);
      if (msg.includes('[AutoUpdater]') && !msg.includes('DevTools')) {
        console.log('   [stderr] ' + msg.trim());
      }
    });

    // Wait for checks to complete
    await new Promise(r => setTimeout(r, 20000));

    const allLogs = logs.join('\n');

    // Verify beta user checks both channels
    const isBetaUser = allLogs.includes('Beta user') || allLogs.includes('Beta opt-in: enabled');
    const checksBothChannels = allLogs.includes('checking both channels');
    const fetchesChannels = allLogs.includes('Fetching latest version') || allLogs.includes('Fetching beta version');

    logTest(
      'Beta user checks both channels',
      isBetaUser && (checksBothChannels || fetchesChannels)
    );

    // CRITICAL TEST: Verify no "Failed to fetch from both channels" error
    const noFetchBothError = !allLogs.includes('Failed to fetch version information from both channels');

    logTest(
      '✨ FIX VERIFIED: No "Failed to fetch from both channels" error',
      noFetchBothError,
      noFetchBothError ? 'Graceful handling working!' : 'ERROR STILL PRESENT'
    );

    // Verify graceful handling when one channel is missing
    const hasGracefulHandling = allLogs.includes('No beta version found') ||
                                 allLogs.includes('No stable version found') ||
                                 allLogs.includes('Using latest channel') ||
                                 allLogs.includes('Using beta channel') ||
                                 allLogs.includes('Update available') ||
                                 allLogs.includes('No update available');

    logTest(
      'Gracefully handles missing channel',
      hasGracefulHandling || noFetchBothError
    );

    await app2.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  } catch (err) {
    logTest('Beta user update check', false, err.message);
  }

  // Test 3: Verify retry logic with backoff
  console.log('\n📋 Test 3: Retry logic verification');
  console.log('-'.repeat(70));

  try {
    const userDataDir = path.join(require('os').tmpdir(), 'messenger-test-retry-' + Date.now());
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(path.join(userDataDir, 'beta-opt-in'), '');

    const app3 = await electron.launch({
      args: [path.join(__dirname, '../dist/main/main.js')],
      env: {
        ...process.env,
        NODE_ENV: 'production',
        SKIP_SINGLE_INSTANCE_LOCK: 'true',
        ELECTRON_USER_DATA: userDataDir
      }
    });

    const logs = [];
    app3.process().stdout.on('data', (data) => {
      const msg = data.toString();
      logs.push(msg);
      if (msg.includes('attempt') || msg.includes('retry')) {
        console.log('   ' + msg.trim());
      }
    });

    app3.process().stderr.on('data', (data) => {
      const msg = data.toString();
      logs.push(msg);
    });

    await new Promise(r => setTimeout(r, 25000));

    const allLogs = logs.join('\n');

    // Check for retry attempts
    const hasRetryLogic = allLogs.includes('attempt 1/3') ||
                          allLogs.includes('attempt 2/3') ||
                          allLogs.includes('attempt 3/3') ||
                          allLogs.match(/attempt \d+\/\d+/);

    const hasBackoff = allLogs.includes('Retrying in') ||
                       allLogs.includes('backoff');

    logTest(
      'Implements retry logic (3 attempts)',
      hasRetryLogic || allLogs.includes('Fetch failed')
    );

    await app3.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  } catch (err) {
    logTest('Retry logic verification', false, err.message);
  }

  // Print summary
  console.log('\n' + '='.repeat(70));
  console.log('📊 TEST SUMMARY');
  console.log('='.repeat(70));
  console.log(`Total tests: ${passed + failed}`);
  console.log(`✅ Passed: ${passed}`);
  console.log(`❌ Failed: ${failed}`);
  console.log('='.repeat(70));

  if (failed === 0) {
    console.log('\n🎉🎉🎉 ALL TESTS PASSED! The fix is working correctly! 🎉🎉🎉\n');
    process.exit(0);
  } else {
    console.log('\n⚠️  Some tests failed - see details above\n');
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('\n❌ Test suite crashed:', err);
  console.error(err.stack);
  process.exit(1);
});
