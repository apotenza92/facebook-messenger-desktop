/**
 * Keyboard Shortcuts Test using Playwright + Electron
 * Tests all keyboard shortcuts in the Messenger Desktop app
 * 
 * Usage: node scripts/test-keyboard-shortcuts.js
 * 
 * Requires: Logged-in session (run test-login.js first if needed)
 */

const { _electron: electron } = require('playwright');
const path = require('path');
const fs = require('fs');

// Test results tracking
const results = {
  passed: [],
  failed: [],
  skipped: []
};

function logResult(name, passed, reason = '') {
  if (passed) {
    results.passed.push(name);
    console.log(`  ✅ ${name}`);
  } else {
    results.failed.push({ name, reason });
    console.log(`  ❌ ${name}${reason ? ': ' + reason : ''}`);
  }
}

async function getContentUrl(electronApp) {
  return await electronApp.evaluate(async ({ BrowserWindow }) => {
    const wins = BrowserWindow.getAllWindows();
    for (const win of wins) {
      const views = win.getBrowserViews();
      if (views.length > 0) {
        return views[0].webContents.getURL();
      }
    }
    return null;
  });
}

async function takeScreenshot(electronApp, filename) {
  const screenshot = await electronApp.evaluate(async ({ BrowserWindow }) => {
    const wins = BrowserWindow.getAllWindows();
    for (const win of wins) {
      const views = win.getBrowserViews();
      if (views.length > 0) {
        const image = await views[0].webContents.capturePage();
        return image.toPNG().toString('base64');
      }
    }
    return null;
  });
  
  if (screenshot) {
    fs.writeFileSync(`test-screenshots/${filename}`, Buffer.from(screenshot, 'base64'));
    console.log(`  📸 Screenshot: ${filename}`);
    return true;
  }
  return false;
}

async function executeInContent(electronApp, script) {
  try {
    return await electronApp.evaluate(async ({ BrowserWindow }, js) => {
      const wins = BrowserWindow.getAllWindows();
      for (const win of wins) {
        const views = win.getBrowserViews();
        if (views.length > 0) {
          try {
            return await views[0].webContents.executeJavaScript(js);
          } catch (e) {
            console.log('JS execution error:', e.message);
            return null;
          }
        }
      }
      return null;
    }, script);
  } catch (e) {
    console.log('executeInContent error:', e.message);
    return null;
  }
}

async function sendKeyCombo(electronApp, key, modifiers = {}) {
  await electronApp.evaluate(async ({ BrowserWindow }, { key, modifiers }) => {
    const wins = BrowserWindow.getAllWindows();
    for (const win of wins) {
      const views = win.getBrowserViews();
      if (views.length > 0) {
        const wc = views[0].webContents;
        
        // Build keyCode based on key
        let keyCode = key;
        if (key === '/') keyCode = 'Slash';
        else if (key === '[') keyCode = 'BracketLeft';
        else if (key === ']') keyCode = 'BracketRight';
        else if (key === 'Escape') keyCode = 'Escape';
        else if (key >= '1' && key <= '9') keyCode = `Digit${key}`;
        else keyCode = key.toUpperCase();
        
        // Send keydown event
        wc.sendInputEvent({
          type: 'keyDown',
          keyCode: keyCode,
          modifiers: Object.keys(modifiers).filter(m => modifiers[m])
        });
        
        await new Promise(r => setTimeout(r, 50));
        
        // Send keyup event
        wc.sendInputEvent({
          type: 'keyUp',
          keyCode: keyCode,
          modifiers: Object.keys(modifiers).filter(m => modifiers[m])
        });
      }
    }
  }, { key, modifiers });
}

async function dispatchKeyEvent(electronApp, key, modifiers = {}) {
  // Use JavaScript to dispatch keyboard event (more reliable for custom handlers)
  return await executeInContent(electronApp, `
    (function() {
      const event = new KeyboardEvent('keydown', {
        key: '${key}',
        code: '${key === '/' ? 'Slash' : key === '[' ? 'BracketLeft' : key === ']' ? 'BracketRight' : key === 'Escape' ? 'Escape' : key.length === 1 && key >= '1' && key <= '9' ? 'Digit' + key : 'Key' + key.toUpperCase()}',
        keyCode: ${key === '/' ? 191 : key === '[' ? 219 : key === ']' ? 221 : key === 'Escape' ? 27 : key >= '1' && key <= '9' ? 48 + parseInt(key) : key.toUpperCase().charCodeAt(0)},
        which: ${key === '/' ? 191 : key === '[' ? 219 : key === ']' ? 221 : key === 'Escape' ? 27 : key >= '1' && key <= '9' ? 48 + parseInt(key) : key.toUpperCase().charCodeAt(0)},
        ctrlKey: ${!!modifiers.control},
        metaKey: ${!!modifiers.meta},
        shiftKey: ${!!modifiers.shift},
        altKey: ${!!modifiers.alt},
        bubbles: true,
        cancelable: true
      });
      document.dispatchEvent(event);
      return true;
    })()
  `);
}

async function waitForElement(electronApp, selector, timeout = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const exists = await executeInContent(electronApp, `!!document.querySelector('${selector}')`);
    if (exists) return true;
    await new Promise(r => setTimeout(r, 100));
  }
  return false;
}

async function runTests() {
  console.log('🚀 Starting Keyboard Shortcuts Tests...\n');

  // Check if already logged in (using existing session)
  const userDataPath = path.join(require('os').homedir(), 'Library/Application Support/Messenger-Dev');
  if (!fs.existsSync(userDataPath)) {
    console.log('⚠️  No existing session found. Run test-login.js first.');
    console.log('   Attempting to run anyway...\n');
  }

  // Build the app first
  console.log('🔨 Building app...');
  require('child_process').execSync('npm run build', { 
    cwd: path.join(__dirname, '..'),
    stdio: 'inherit'
  });

  // Launch Electron app
  console.log('\n📱 Launching Electron app...');
  const electronApp = await electron.launch({
    args: [path.join(__dirname, '../dist/main/main.js')],
    env: {
      ...process.env,
      NODE_ENV: 'development'
    }
  });

  // Wait for app to initialize
  console.log('⏳ Waiting for app to load...');
  await new Promise(r => setTimeout(r, 5000));
  
  let currentUrl = await getContentUrl(electronApp);
  console.log('📍 Current URL:', currentUrl?.substring(0, 60) + '...');
  
  // Check if we're on messenger
  const isLoggedIn = currentUrl && currentUrl.includes('facebook.com/messages') && 
                     !currentUrl.includes('login') && !currentUrl.includes('loginBtn');
  
  if (!isLoggedIn) {
    console.log('\n⚠️  Not logged in to Messenger. Some tests may fail.');
    console.log('   Run test-login.js first for full testing.\n');
  } else {
    console.log('✅ Logged in to Messenger\n');
    // Give extra time for Messenger UI to fully load
    await new Promise(r => setTimeout(r, 3000));
  }
  
  await takeScreenshot(electronApp, 'shortcuts-00-initial.png');

  // ============================================================================
  // TEST 1: Cmd/Ctrl + / → Keyboard Shortcuts Help
  // ============================================================================
  console.log('\n📋 TEST 1: Keyboard Shortcuts Help (Cmd+/)');
  
  // Dispatch the keyboard event using JavaScript (works with our event listener)
  await dispatchKeyEvent(electronApp, '/', { meta: true });
  await new Promise(r => setTimeout(r, 500));
  
  const shortcutsVisible = await executeInContent(electronApp, `
    !!document.querySelector('[data-shortcuts-backdrop]')
  `);
  
  await takeScreenshot(electronApp, 'shortcuts-01-help-overlay.png');
  logResult('Cmd+/ opens shortcuts help', shortcutsVisible);
  
  if (shortcutsVisible) {
    // TEST 1b: Escape closes shortcuts help
    console.log('\n📋 TEST 1b: Escape closes shortcuts help');
    await dispatchKeyEvent(electronApp, 'Escape', {});
    await new Promise(r => setTimeout(r, 300));
    
    const shortcutsHidden = await executeInContent(electronApp, `
      !document.querySelector('[data-shortcuts-backdrop]')
    `);
    
    await takeScreenshot(electronApp, 'shortcuts-02-help-closed.png');
    logResult('Escape closes shortcuts help', shortcutsHidden);
    
    // TEST 1c: Click backdrop closes shortcuts help
    console.log('\n📋 TEST 1c: Click backdrop closes shortcuts help');
    await dispatchKeyEvent(electronApp, '/', { meta: true });
    await new Promise(r => setTimeout(r, 300));
    
    await executeInContent(electronApp, `
      const backdrop = document.querySelector('[data-shortcuts-backdrop]');
      if (backdrop) {
        backdrop.click();
      }
    `);
    await new Promise(r => setTimeout(r, 300));
    
    const shortcutsHiddenAfterClick = await executeInContent(electronApp, `
      !document.querySelector('[data-shortcuts-backdrop]')
    `);
    
    await takeScreenshot(electronApp, 'shortcuts-03-help-clicked-away.png');
    logResult('Click backdrop closes shortcuts help', shortcutsHiddenAfterClick);
  }

  // ============================================================================
  // TEST 2: Cmd/Ctrl + Shift + P → Command Palette
  // ============================================================================
  console.log('\n📋 TEST 2: Command Palette (Cmd+Shift+P)');
  
  await dispatchKeyEvent(electronApp, 'p', { meta: true, shift: true });
  await new Promise(r => setTimeout(r, 500));
  
  const paletteVisible = await executeInContent(electronApp, `
    !!document.querySelector('[data-palette-input]')
  `);
  
  await takeScreenshot(electronApp, 'shortcuts-04-command-palette.png');
  logResult('Cmd+Shift+P opens command palette', paletteVisible);
  
  if (paletteVisible) {
    // TEST 2b: Escape closes command palette
    console.log('\n📋 TEST 2b: Escape closes command palette');
    await dispatchKeyEvent(electronApp, 'Escape', {});
    await new Promise(r => setTimeout(r, 300));
    
    const paletteHidden = await executeInContent(electronApp, `
      !document.querySelector('[data-palette-input]')
    `);
    
    await takeScreenshot(electronApp, 'shortcuts-05-palette-closed.png');
    logResult('Escape closes command palette', paletteHidden);
    
    // TEST 2c: Typing filters contacts
    console.log('\n📋 TEST 2c: Command palette filtering');
    await dispatchKeyEvent(electronApp, 'p', { meta: true, shift: true });
    await new Promise(r => setTimeout(r, 300));
    
    const initialContacts = await executeInContent(electronApp, `
      document.querySelectorAll('[data-palette-item]').length
    `);
    
    // Type something in the input
    await executeInContent(electronApp, `
      const input = document.querySelector('[data-palette-input]');
      if (input) {
        input.value = 'zzz';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    `);
    await new Promise(r => setTimeout(r, 200));
    
    const filteredContacts = await executeInContent(electronApp, `
      document.querySelectorAll('[data-palette-item]').length
    `);
    
    logResult('Typing filters contacts', filteredContacts < initialContacts || initialContacts === 0);
    
    // Close palette
    await dispatchKeyEvent(electronApp, 'Escape', {});
    await new Promise(r => setTimeout(r, 200));
  }

  // ============================================================================
  // TEST 3: Chat Navigation (only if logged in with chats)
  // ============================================================================
  if (isLoggedIn) {
    console.log('\n📋 TEST 3: Chat Navigation (Cmd+1-9)');
    
    // Get initial URL
    const urlBefore = await getContentUrl(electronApp);
    
    // Try Cmd+1 to jump to first chat
    await dispatchKeyEvent(electronApp, '1', { meta: true });
    await new Promise(r => setTimeout(r, 1000));
    
    const urlAfter1 = await getContentUrl(electronApp);
    await takeScreenshot(electronApp, 'shortcuts-06-after-cmd1.png');
    
    // Check if URL changed to include /t/ (a chat thread)
    const navigatedToChat = urlAfter1 && urlAfter1.includes('/t/');
    logResult('Cmd+1 navigates to first chat', navigatedToChat);
    
    if (navigatedToChat) {
      // TEST 3b: Cmd+Shift+] for next chat
      console.log('\n📋 TEST 3b: Next Chat (Cmd+Shift+])');
      await dispatchKeyEvent(electronApp, ']', { meta: true, shift: true });
      await new Promise(r => setTimeout(r, 1000));
      
      const urlAfterNext = await getContentUrl(electronApp);
      await takeScreenshot(electronApp, 'shortcuts-07-after-next.png');
      
      // URL should change (different thread ID)
      const navigatedNext = urlAfterNext && urlAfterNext !== urlAfter1;
      logResult('Cmd+Shift+] navigates to next chat', navigatedNext);
      
      // TEST 3c: Cmd+Shift+[ for previous chat
      console.log('\n📋 TEST 3c: Previous Chat (Cmd+Shift+[)');
      await dispatchKeyEvent(electronApp, '[', { meta: true, shift: true });
      await new Promise(r => setTimeout(r, 1000));
      
      const urlAfterPrev = await getContentUrl(electronApp);
      await takeScreenshot(electronApp, 'shortcuts-08-after-prev.png');
      
      // Should go back to previous chat
      logResult('Cmd+Shift+[ navigates to previous chat', urlAfterPrev && urlAfterPrev.includes('/t/'));
    }
  } else {
    results.skipped.push('Chat navigation (not logged in)');
    console.log('\n⏭️  Skipping chat navigation tests (not logged in)');
  }

  // ============================================================================
  // TEST 4: Theme Detection (check if overlays use appropriate colors)
  // ============================================================================
  console.log('\n📋 TEST 4: Theme Detection');
  
  // Open shortcuts help
  await dispatchKeyEvent(electronApp, '/', { meta: true });
  await new Promise(r => setTimeout(r, 300));
  
  const overlayStyles = await executeInContent(electronApp, `
    (function() {
      const overlay = document.querySelector('[data-shortcuts-backdrop]');
      if (!overlay) return null;
      const inner = overlay.querySelector('div > div');
      if (!inner) return null;
      const style = window.getComputedStyle(inner);
      return {
        background: style.backgroundColor,
        color: style.color
      };
    })()
  `);
  
  // Check page background to detect theme
  const pageTheme = await executeInContent(electronApp, `
    (function() {
      const body = document.body;
      const style = window.getComputedStyle(body);
      const bg = style.backgroundColor;
      // Parse RGB values to check if it's dark
      const match = bg.match(/rgb\\((\\d+),\\s*(\\d+),\\s*(\\d+)\\)/);
      if (match) {
        const [, r, g, b] = match.map(Number);
        const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
        return luminance < 0.5 ? 'dark' : 'light';
      }
      return 'unknown';
    })()
  `);
  
  console.log(`  Page theme detected: ${pageTheme}`);
  console.log(`  Overlay styles:`, overlayStyles);
  
  // Currently overlay always uses dark theme colors (#242526)
  // This test checks if it exists - theme matching will be added separately
  logResult('Shortcuts overlay renders', !!overlayStyles);
  
  await dispatchKeyEvent(electronApp, 'Escape', {});
  await new Promise(r => setTimeout(r, 200));

  // ============================================================================
  // SUMMARY
  // ============================================================================
  console.log('\n' + '='.repeat(60));
  console.log('📊 TEST SUMMARY');
  console.log('='.repeat(60));
  console.log(`✅ Passed: ${results.passed.length}`);
  console.log(`❌ Failed: ${results.failed.length}`);
  console.log(`⏭️  Skipped: ${results.skipped.length}`);
  
  if (results.failed.length > 0) {
    console.log('\nFailed tests:');
    results.failed.forEach(f => console.log(`  - ${f.name}: ${f.reason || 'unknown'}`));
  }
  
  if (results.skipped.length > 0) {
    console.log('\nSkipped tests:');
    results.skipped.forEach(s => console.log(`  - ${s}`));
  }

  // Keep app open briefly for inspection
  console.log('\n📋 Screenshots saved to test-screenshots/');
  console.log('App stays open 10s for inspection...');
  await new Promise(r => setTimeout(r, 10000));
  
  await electronApp.close();
  console.log('\n👋 Done!');
  
  // Exit with error code if tests failed
  if (results.failed.length > 0) {
    process.exit(1);
  }
}

// Create screenshots directory
const screenshotsDir = path.join(__dirname, '../test-screenshots');
if (!fs.existsSync(screenshotsDir)) {
  fs.mkdirSync(screenshotsDir, { recursive: true });
}

runTests().catch(async (err) => {
  console.error('\n❌ Test failed:', err.message);
  console.error(err.stack);
  process.exit(1);
});
