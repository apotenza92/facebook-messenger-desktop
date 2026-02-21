/**
 * Automated login flow test using Playwright + Electron
 * Works with macOS BrowserView architecture
 * 
 * Prerequisites:
 * - 1Password CLI (`op`) installed and configured
 * - A "Facebook" item in 1Password with username, password, and TOTP
 * 
 * Usage: 
 *   node scripts/test-login.js           # Uses 1Password for credentials and TOTP
 *   node scripts/test-login.js <TOTP>    # Uses 1Password for credentials, manual TOTP
 * 
 * The test will:
 * 1. Clear dev user data (fresh start)
 * 2. Build and launch the app
 * 3. Click "Login with Facebook"
 * 4. Enter credentials from 1Password
 * 5. Handle 2FA (authenticator app)
 * 6. Handle "Trust this device" page
 * 7. Wait for Messenger to load
 * 8. Prompt for PIN if chat history restore dialog appears
 * 9. Test session persistence (quit and reopen)
 */

const { _electron: electron } = require('playwright');
const path = require('path');
const fs = require('fs');

// Credentials cache file (avoids repeated 1Password authorization)
const CREDS_CACHE_FILE = path.join(__dirname, '../.test-credentials.json');

// Get credentials - uses cache if available, otherwise fetches from 1Password
async function getCredentials() {
  // Check cache first
  if (fs.existsSync(CREDS_CACHE_FILE)) {
    try {
      const cached = JSON.parse(fs.readFileSync(CREDS_CACHE_FILE, 'utf8'));
      if (cached.email && cached.password) {
        console.log('  (using cached credentials)');
        return cached;
      }
    } catch (e) { /* ignore cache errors */ }
  }
  
  // Fetch from 1Password and cache
  const { execSync } = require('child_process');
  try {
    console.log('  (fetching from 1Password...)');
    const result = execSync('op item get "Facebook" --fields label=username,label=password --format json', { encoding: 'utf8' });
    const fields = JSON.parse(result);
    const creds = {
      email: fields.find(f => f.label === 'username')?.value,
      password: fields.find(f => f.label === 'password')?.value
    };
    
    // Cache credentials
    fs.writeFileSync(CREDS_CACHE_FILE, JSON.stringify(creds, null, 2));
    console.log('  (credentials cached for future runs)');
    
    return creds;
  } catch (e) {
    console.error('Failed to get credentials from 1Password:', e.message);
    process.exit(1);
  }
}

// TOTP must be fetched fresh each time (it changes every 30s)
async function getTOTP() {
  const { execSync } = require('child_process');
  try {
    console.log('  🔐 Fetching TOTP from 1Password (approve Touch ID)...');
    return execSync('op item get "Facebook" --otp', { encoding: 'utf8', timeout: 60000 }).trim();
  } catch (e) {
    console.error('Failed to get TOTP:', e.message);
    return null;
  }
}

// Helper to interact with the BrowserView content
async function withContentView(electronApp, fn) {
  return await electronApp.evaluate(async ({ BrowserWindow }, fnStr) => {
    const wins = BrowserWindow.getAllWindows();
    for (const win of wins) {
      const views = win.getBrowserViews();
      if (views.length > 0) {
        return await eval(`(async function(view) { ${fnStr} })`)(views[0]);
      }
    }
    return null;
  }, fn.toString().replace(/^[^{]*{|}[^}]*$/g, ''));
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
    console.log(`📸 Screenshot: ${filename}`);
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

// Optional manual TOTP argument (if 1Password CLI doesn't work)
const manualTOTP = process.argv[2];

// Helper to prompt for user input
function promptUser(question) {
  return new Promise((resolve) => {
    const readline = require('readline');
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function runTest() {
  console.log('🚀 Starting Electron app test...\n');
  
  if (manualTOTP) {
    console.log(`📱 Manual TOTP provided: ${manualTOTP}\n`);
  } else {
    console.log('ℹ️  TOTP will be fetched from 1Password when needed (at 2FA step)');
    console.log('   If 1Password prompts for auth, please approve it.\n');
  }

  // First, clear dev user data for fresh start
  const userDataPath = path.join(require('os').homedir(), 'Library/Application Support/Messenger-Dev');
  if (fs.existsSync(userDataPath)) {
    console.log('🧹 Clearing dev user data...');
    fs.rmSync(userDataPath, { recursive: true, force: true });
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
  await new Promise(r => setTimeout(r, 3000));
  
  // Check initial URL
  let currentUrl = await getContentUrl(electronApp);
  console.log('📍 Initial URL:', currentUrl?.substring(0, 60) + '...');
  
  // Take initial screenshot
  await takeScreenshot(electronApp, '01-login-page.png');
  
  // Verify we're on login page
  if (!currentUrl || !currentUrl.includes('loginBtn')) {
    console.log('⚠️  Not on expected login page');
    // Try waiting a bit more
    await new Promise(r => setTimeout(r, 2000));
    currentUrl = await getContentUrl(electronApp);
    console.log('📍 URL after wait:', currentUrl?.substring(0, 60) + '...');
  }

  // Step 1: Click "Login with Facebook"
  console.log('\n🔐 Step 1: Click "Login with Facebook"...');
  await executeInContent(electronApp, `
    const btn = document.getElementById('loginBtn');
    if (btn) btn.click();
  `);
  
  // Wait for navigation to Facebook
  console.log('⏳ Waiting for Facebook login page...');
  for (let i = 0; i < 15; i++) {
    await new Promise(r => setTimeout(r, 1000));
    currentUrl = await getContentUrl(electronApp);
    if (currentUrl && currentUrl.includes('facebook.com/login')) {
      break;
    }
  }
  
  console.log('📍 URL:', currentUrl);
  await takeScreenshot(electronApp, '02-facebook-login.png');
  
  if (!currentUrl || !currentUrl.includes('facebook.com/login')) {
    console.log('❌ Did not reach Facebook login page');
    await electronApp.close();
    return;
  }
  console.log('✅ Reached Facebook login page');

  // Step 2: Enter credentials
  console.log('\n🔑 Step 2: Enter credentials...');
  const creds = await getCredentials();
  
  await executeInContent(electronApp, `
    const emailField = document.getElementById('email');
    const passField = document.getElementById('pass');
    if (emailField) {
      emailField.value = '${creds.email}';
      emailField.dispatchEvent(new Event('input', { bubbles: true }));
    }
    if (passField) {
      passField.value = '${creds.password}';
      passField.dispatchEvent(new Event('input', { bubbles: true }));
    }
  `);
  
  await new Promise(r => setTimeout(r, 500));
  await takeScreenshot(electronApp, '03-credentials-entered.png');

  // Step 3: Click login button
  console.log('\n🔘 Step 3: Click login button...');
  await executeInContent(electronApp, `
    // Try multiple selectors for the login button
    let loginBtn = document.querySelector('button[name="login"]');
    if (!loginBtn) loginBtn = document.querySelector('button[type="submit"]');
    if (!loginBtn) loginBtn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.toLowerCase().includes('log in'));
    if (!loginBtn) loginBtn = document.querySelector('#loginbutton');
    if (loginBtn) {
      console.log('Found login button:', loginBtn.textContent);
      loginBtn.click();
    } else {
      console.log('Login button not found!');
    }
  `);
  
  // Wait for navigation
  console.log('⏳ Waiting for post-login navigation...');
  await new Promise(r => setTimeout(r, 5000));
  
  currentUrl = await getContentUrl(electronApp);
  console.log('📍 Post-login URL:', currentUrl);
  await takeScreenshot(electronApp, '04-after-login.png');

  // Note: 2FA and checkpoints are handled in Step 6 loop below
  console.log('\n📍 Current URL:', currentUrl);

  // Step 6: Wait for Messenger (handling 2FA and checkpoints along the way)
  console.log('\n⏳ Step 6: Wait for Messenger...');
  let reachedMessenger = false;
  let handled2FA = false;
  
  for (let i = 0; i < 45; i++) {
    currentUrl = await getContentUrl(electronApp);
    const shortUrl = currentUrl ? currentUrl.substring(0, 60) : 'null';
    console.log(`  Check ${i + 1}/45: ${shortUrl}...`);
    
    // Handle "Trust this device" / "Remember browser" page FIRST (before messages check)
    if (currentUrl && (currentUrl.includes('remember_browser') || currentUrl.includes('two_factor/checkpoint'))) {
      console.log('\n🔒 "Trust this device" page detected...');
      await takeScreenshot(electronApp, '11-trust-device.png');
      
      const trustResult = await executeInContent(electronApp, `
        (function() {
          const btns = Array.from(document.querySelectorAll('div[role="button"], button'));
          // Look for "Trust this device" button (blue button)
          const trustBtn = btns.find(b => {
            const text = (b.textContent || '').trim().toLowerCase();
            return text === 'trust this device' || text.includes('trust this device');
          });
          if (trustBtn) {
            trustBtn.click();
            return 'clicked Trust this device';
          }
          // Also try "Not now" or "Continue" as fallback
          const otherBtn = btns.find(b => {
            const text = (b.textContent || '').toLowerCase();
            return text.includes('continue') || text.includes('not now') || text.includes('skip');
          });
          if (otherBtn) {
            otherBtn.click();
            return 'clicked: ' + otherBtn.textContent.trim();
          }
          return 'no button found. Available: ' + btns.map(b => b.textContent?.trim().substring(0,30)).filter(t=>t).join(', ');
        })();
      `);
      console.log('  Result:', trustResult);
      
      await new Promise(r => setTimeout(r, 4000));
      continue;
    }
    
    // Check if we've reached the actual Messages interface
    if (currentUrl && currentUrl.includes('facebook.com/messages') && !currentUrl.includes('login') && !currentUrl.includes('checkpoint')) {
      reachedMessenger = true;
      console.log('\n✅ Reached Messenger!');
      break;
    }
    
    // Handle 2FA page (only once!)
    if (!handled2FA && currentUrl && (currentUrl.includes('two_step') || currentUrl.includes('two_factor'))) {
      handled2FA = true; // Mark as handled IMMEDIATELY to prevent re-entry
      console.log('\n🔐 2FA page detected! (will handle once)');
      await takeScreenshot(electronApp, '05-2fa-page.png');
      
      // Step A: Click "Try Another Way" - use proper mouse event simulation
      console.log('Step A: Clicking "Try Another Way"...');
      const clickedTryAnother = await executeInContent(electronApp, `
        (function() {
          // Find the button containing "Try Another Way"
          const allElements = Array.from(document.querySelectorAll('div[role="button"], button, span'));
          let target = null;
          
          // First try to find a button/div with role="button"
          for (const el of allElements) {
            if (el.textContent && el.textContent.trim() === 'Try Another Way') {
              target = el.closest('[role="button"]') || el.closest('button') || el;
              break;
            }
          }
          
          if (target) {
            // Simulate a real click with mouse events
            const rect = target.getBoundingClientRect();
            const x = rect.left + rect.width / 2;
            const y = rect.top + rect.height / 2;
            
            const mouseDown = new MouseEvent('mousedown', {
              bubbles: true, cancelable: true, view: window,
              clientX: x, clientY: y, button: 0
            });
            const mouseUp = new MouseEvent('mouseup', {
              bubbles: true, cancelable: true, view: window,
              clientX: x, clientY: y, button: 0
            });
            const click = new MouseEvent('click', {
              bubbles: true, cancelable: true, view: window,
              clientX: x, clientY: y, button: 0
            });
            
            target.dispatchEvent(mouseDown);
            target.dispatchEvent(mouseUp);
            target.dispatchEvent(click);
            
            return 'clicked: ' + target.tagName + ' at ' + Math.round(x) + ',' + Math.round(y);
          }
          return 'not found';
        })();
      `);
      console.log('  Result:', clickedTryAnother);
      
      // Wait longer for modal to appear
      await new Promise(r => setTimeout(r, 4000));
      await takeScreenshot(electronApp, '06-after-try-another.png');
      
      // Debug: Check if we're on the method selection modal
      const modalCheck = await executeInContent(electronApp, `
        const hasModal = document.body.textContent.includes('Choose a way to confirm');
        const hasAuthApp = document.body.textContent.includes('Authentication app');
        'Modal: ' + hasModal + ', AuthApp option: ' + hasAuthApp;
      `);
      console.log('  Modal check:', modalCheck);
      
      // Step B: The "Authentication app" might already be selected, just click Continue
      // First, let's make sure Authentication app is selected (click it if not)
      console.log('Step B: Selecting Authentication app if needed...');
      const selectedAuth = await executeInContent(electronApp, `
        (function() {
          // Find the Authentication app row and check if it's selected
          const rows = Array.from(document.querySelectorAll('[role="radio"], [role="listitem"], label'));
          
          for (const row of rows) {
            const text = row.textContent || '';
            if (text.includes('Authentication app') || text.includes('authenticator app')) {
              // Check if already selected (look for filled radio or aria-checked)
              const isSelected = row.getAttribute('aria-checked') === 'true' || 
                                row.querySelector('[aria-checked="true"]') ||
                                row.querySelector('svg circle[fill]');
              
              if (!isSelected) {
                row.click();
                return 'clicked to select';
              }
              return 'already selected';
            }
          }
          return 'auth option not found';
        })();
      `);
      console.log('  Auth selection:', selectedAuth);
      
      await new Promise(r => setTimeout(r, 1000));
      await takeScreenshot(electronApp, '07-auth-selected.png');
      
      // Step C: Click the Continue button (it's the big blue button at the bottom)
      console.log('Step C: Clicking Continue button...');
      const clickedContinue = await executeInContent(electronApp, `
        (function() {
          // Find Continue button - look for blue/primary buttons
          const buttons = Array.from(document.querySelectorAll('div[role="button"], button'));
          
          // Find the Continue button
          let continueBtn = buttons.find(b => {
            const text = (b.textContent || '').trim().toLowerCase();
            return text === 'continue' || text === 'next';
          });
          
          if (continueBtn) {
            // Use proper click simulation
            const rect = continueBtn.getBoundingClientRect();
            const x = rect.left + rect.width / 2;
            const y = rect.top + rect.height / 2;
            
            continueBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: x, clientY: y }));
            continueBtn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: x, clientY: y }));
            continueBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: x, clientY: y }));
            
            return 'clicked Continue at ' + Math.round(x) + ',' + Math.round(y);
          }
          
          // List available buttons for debugging
          const btnTexts = buttons.map(b => (b.textContent || '').trim().substring(0, 30)).filter(t => t);
          return 'Continue not found. Buttons: ' + btnTexts.join(' | ');
        })();
      `);
      console.log('  Result:', clickedContinue);
      
      await new Promise(r => setTimeout(r, 3000));
      await takeScreenshot(electronApp, '08-ready-for-code.png');
      
      // Step D: Enter TOTP code
      console.log('Step D: Getting TOTP code...');
      let totp = manualTOTP;
      
      if (!totp) {
        console.log('  📱 Fetching from 1Password (approve Touch ID if prompted)...');
        totp = await getTOTP();
        
        if (!totp) {
          console.log('  ❌ Could not get TOTP from 1Password.');
          console.log('  💡 Run with TOTP as argument: node scripts/test-login.js <6-digit-code>');
          // Don't exit, just continue waiting - maybe user will retry
        }
      }
      
      if (totp) {
        console.log('  TOTP:', totp);
        
        // Use Electron's clipboard and paste functionality
        const pasteResult = await electronApp.evaluate(async ({ clipboard, BrowserWindow }, code) => {
          // Write to clipboard
          clipboard.writeText(code);
          
          // Find the window with BrowserView and paste
          const wins = BrowserWindow.getAllWindows();
          for (const win of wins) {
            const views = win.getBrowserViews();
            if (views.length > 0) {
              const wc = views[0].webContents;
              
              // Focus input first
              await wc.executeJavaScript(`
                const inputs = document.querySelectorAll('input');
                const codeInput = Array.from(inputs).find(i => 
                  i.type === 'text' || i.type === 'tel' || i.type === 'number' || !i.type
                );
                if (codeInput) {
                  codeInput.focus();
                  codeInput.click();
                }
              `);
              
              // Small delay then paste
              await new Promise(r => setTimeout(r, 200));
              wc.paste();
              
              return 'pasted via Electron';
            }
          }
          return 'no view found';
        }, totp);
        
        console.log('  Result:', pasteResult);
        await new Promise(r => setTimeout(r, 500));
        
        await new Promise(r => setTimeout(r, 1000));
        await takeScreenshot(electronApp, '09-code-entered.png');
        
        // Step E: Submit the code - try Enter key first (most reliable), then click
        console.log('Step E: Submitting code with Enter key...');
        const submitResult = await executeInContent(electronApp, `
          (function() {
            // Find the input and press Enter
            const input = document.querySelector('input[type="text"], input[type="tel"]');
            if (input) {
              input.focus();
              
              // Dispatch Enter key event
              const enterEvent = new KeyboardEvent('keydown', {
                key: 'Enter',
                code: 'Enter',
                keyCode: 13,
                which: 13,
                bubbles: true,
                cancelable: true
              });
              input.dispatchEvent(enterEvent);
              
              // Also try keypress and keyup
              input.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', keyCode: 13, bubbles: true }));
              input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', keyCode: 13, bubbles: true }));
              
              // Also submit the form if there is one
              const form = input.closest('form');
              if (form) {
                form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
              }
              
              return 'pressed Enter on input';
            }
            return 'no input found';
          })();
        `);
        console.log('  Enter key result:', submitResult);
        
        await new Promise(r => setTimeout(r, 1000));
        
        // Also try clicking Continue as backup
        console.log('  Also clicking Continue button...');
        await executeInContent(electronApp, `
          (function() {
            const buttons = Array.from(document.querySelectorAll('div[role="button"], button'));
            const continueBtn = buttons.find(b => (b.textContent || '').trim() === 'Continue');
            if (continueBtn) {
              continueBtn.focus && continueBtn.focus();
              continueBtn.click();
            }
          })();
        `);
        
        console.log('⏳ Waiting for 2FA verification...');
        await new Promise(r => setTimeout(r, 6000));
        handled2FA = true;
        await takeScreenshot(electronApp, '10-after-2fa.png');
        console.log('✅ 2FA flow completed');
      }
      
      continue;
    }
    
    // Handle checkpoint pages (Continue as X) and Trust Device pages
    if (currentUrl && (currentUrl.includes('checkpoint') || currentUrl.includes('trust'))) {
      // Check for "Trust this device" page
      const pageText = await executeInContent(electronApp, `document.body.textContent`);
      
      if (pageText && pageText.includes('Trust this device')) {
        console.log('🔒 "Trust this device" page - clicking Trust...');
        await takeScreenshot(electronApp, '11-trust-device.png');
        await executeInContent(electronApp, `
          const btns = Array.from(document.querySelectorAll('div[role="button"], button'));
          const trustBtn = btns.find(b => {
            const text = (b.textContent || '').toLowerCase();
            return text.includes('trust this device') || text === 'trust';
          });
          if (trustBtn) trustBtn.click();
        `);
        await new Promise(r => setTimeout(r, 3000));
      } else {
        console.log('👤 Checkpoint - clicking Continue...');
        await executeInContent(electronApp, `
          const btns = Array.from(document.querySelectorAll('div[role="button"], button'));
          const continueBtn = btns.find(b => b.textContent && b.textContent.toLowerCase().includes('continue'));
          if (continueBtn) continueBtn.click();
        `);
      }
    }
    
    await new Promise(r => setTimeout(r, 2000));
  }

  // Final screenshot
  await takeScreenshot(electronApp, '09-final.png');
  console.log('\n📍 Final URL:', await getContentUrl(electronApp));

  if (reachedMessenger) {
    console.log('\n🎉 LOGIN TEST PASSED!');
    
    // Wait for Messenger UI to load
    await new Promise(r => setTimeout(r, 3000));
    await takeScreenshot(electronApp, '10-messenger-ui.png');
    
    // Step 7: Handle PIN entry for chat history restore
    console.log('\n🔐 Step 7: Check for PIN dialog...');
    
    // Wait a bit for PIN dialog to appear
    await new Promise(r => setTimeout(r, 2000));
    
    const hasPinDialog = await executeInContent(electronApp, `
      document.body.textContent.includes('Enter your PIN to restore your chat history')
    `);
    
    if (hasPinDialog) {
      // Prompt user for PIN
      const PIN = await promptUser('📝 PIN dialog detected! Enter your 6-digit PIN: ');
      
      if (!PIN || PIN.length !== 6) {
        console.log('  ⚠️  Invalid PIN (must be 6 digits), skipping PIN entry...');
      } else {
        console.log('📝 Entering PIN...');
        await takeScreenshot(electronApp, '11-pin-dialog.png');
        
        // Click on the first PIN box to focus
        await executeInContent(electronApp, `
          (function() {
            // Find the PIN input boxes - they're styled divs with role="textbox" or visible input areas
            const boxes = Array.from(document.querySelectorAll('[role="textbox"], input'));
            // Also look for the specific PIN input container
            const pinContainer = document.querySelector('[aria-label*="PIN"], [aria-label*="pin"]');
            if (pinContainer) {
              pinContainer.click();
              pinContainer.focus && pinContainer.focus();
              return 'clicked PIN container';
            }
            // Click the first box-like element in the PIN area
            if (boxes.length > 0) {
              boxes[0].click();
              boxes[0].focus && boxes[0].focus();
              return 'clicked first box';
            }
            // Fallback: click in the general area of the PIN dialog
            const dialog = document.querySelector('[role="dialog"]') || document.querySelector('.x1n2onr6');
            if (dialog) {
              const inputs = dialog.querySelectorAll('input, [role="textbox"], [contenteditable]');
              if (inputs.length > 0) {
                inputs[0].click();
                inputs[0].focus && inputs[0].focus();
                return 'clicked dialog input';
              }
            }
            return 'no input found to click';
          })();
        `);
        
        await new Promise(r => setTimeout(r, 300));
        
        // Use Electron's clipboard paste to enter PIN (like we did for TOTP)
        const pinResult = await electronApp.evaluate(async ({ clipboard, BrowserWindow }, pin) => {
          clipboard.writeText(pin);
          
          const wins = BrowserWindow.getAllWindows();
          for (const win of wins) {
            const views = win.getBrowserViews();
            if (views.length > 0) {
              const wc = views[0].webContents;
              
              // Focus any visible input in the PIN area
              await wc.executeJavaScript(`
                (function() {
                  // Try multiple selectors to find the PIN input
                  const selectors = [
                    'input[type="tel"]',
                    'input[type="text"]', 
                    'input[type="number"]',
                    'input:not([type="hidden"])',
                    '[role="textbox"]',
                    '[contenteditable="true"]'
                  ];
                  for (const sel of selectors) {
                    const el = document.querySelector(sel);
                    if (el) {
                      el.focus();
                      el.click();
                      return 'focused: ' + sel;
                    }
                  }
                  return 'no input to focus';
                })();
              `);
              
              await new Promise(r => setTimeout(r, 200));
              wc.paste();
              
              return 'pasted PIN via Electron';
            }
          }
          return 'no view found';
        }, PIN);
        
        console.log('  Result:', pinResult);
        
        await new Promise(r => setTimeout(r, 1000));
        await takeScreenshot(electronApp, '12-pin-entered.png');
        
        console.log('⏳ Waiting 10 seconds for chat history to load...');
        await new Promise(r => setTimeout(r, 10000));
        await takeScreenshot(electronApp, '13-after-pin-wait.png');
      }
    } else {
      console.log('  No PIN dialog detected, continuing...');
    }
    
    // Step 8: Test session persistence - quit and reopen
    console.log('\n🔄 Step 8: Testing session persistence...');
    console.log('  Closing app...');
    await electronApp.close();
    
    console.log('  Waiting 3 seconds...');
    await new Promise(r => setTimeout(r, 3000));
    
    console.log('  Reopening app (WITHOUT reset)...');
    const electronApp2 = await electron.launch({
      args: [path.join(__dirname, '../dist/main/main.js')],
      env: {
        ...process.env,
        NODE_ENV: 'development'
      }
    });
    
    console.log('  Waiting 8 seconds for app to fully load...');
    await new Promise(r => setTimeout(r, 8000));
    
    const restartUrl = await getContentUrl(electronApp2);
    console.log('📍 URL after restart:', restartUrl);
    
    await takeScreenshot(electronApp2, '14-after-restart.png');
    
    // Verify session persisted
    if (restartUrl && restartUrl.includes('facebook.com/messages') && !restartUrl.includes('login') && !restartUrl.includes('loginBtn')) {
      console.log('\n✅ SESSION PERSISTED - Still logged in to Messenger!');
      console.log('\n🎉🎉🎉 FULL LOGIN FLOW TEST PASSED! 🎉🎉🎉');
    } else {
      console.log('\n❌ SESSION LOST - Back to login page');
      console.log('   URL:', restartUrl);
    }
    
    // Keep open for inspection
    console.log('\n📋 Screenshots saved to test-screenshots/');
    console.log('App stays open 30s for inspection...');
    await new Promise(r => setTimeout(r, 30000));
    await electronApp2.close();
    
  } else {
    console.log('\n❌ LOGIN TEST FAILED - Did not reach Messenger');
    
    // Keep open for inspection
    console.log('\n📋 Screenshots saved to test-screenshots/');
    console.log('App stays open 30s for inspection...');
    await new Promise(r => setTimeout(r, 30000));
    await electronApp.close();
  }
  
  console.log('👋 Done!');
}

// Create screenshots directory
const screenshotsDir = path.join(__dirname, '../test-screenshots');
if (!fs.existsSync(screenshotsDir)) {
  fs.mkdirSync(screenshotsDir, { recursive: true });
}

runTest().catch(async (err) => {
  console.error('\n❌ Test failed:', err.message);
  console.error(err.stack);
  process.exit(1);
});
