const { _electron: electron, chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const INCOMING_ANSWER_SELECTORS = [
  '[aria-label*="Answer" i]',
  '[aria-label*="Accept call" i]',
  '[aria-label*="Join call" i]',
  '[aria-label*="Accept video call" i]',
  '[aria-label*="Accept audio call" i]',
];

const INCOMING_DECLINE_SELECTORS = [
  '[aria-label*="Decline" i]',
  '[aria-label*="Ignore call" i]',
  '[aria-label*="Decline call" i]',
];

const CALL_START_INCLUDE_PATTERNS = [
  /start video call/i,
  /start audio call/i,
  /video call/i,
  /audio call/i,
  /voice call/i,
  /call/i,
];

const CALL_START_EXCLUDE_PATTERN =
  /answer|accept|decline|ignore|join|cancel|end call|hang up|mute|unmute|video on|video off/i;

function buildVisibilityHelpers() {
  return {
    isVisibleSource: `
      (el) => {
        if (!el) return false;
        const target = el instanceof HTMLElement ? el : null;
        if (!target) return false;
        if (target.closest('[aria-hidden="true"]') || target.closest('[hidden]')) return false;
        const style = window.getComputedStyle(target);
        if (
          style.display === 'none' ||
          style.visibility === 'hidden' ||
          style.opacity === '0' ||
          style.pointerEvents === 'none'
        ) {
          return false;
        }
        const rect = target.getBoundingClientRect();
        return rect.width >= 4 && rect.height >= 4;
      }
    `,
  };
}

async function withPrimaryWebContents(electronApp, fn, payload) {
  return electronApp.evaluate(
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

async function ensureElectronOnUrl(electronApp, targetUrl) {
  return withPrimaryWebContents(
    electronApp,
    async (wc, payload) => {
      await wc.loadURL(payload.targetUrl);
      return wc.getURL();
    },
    { targetUrl },
  );
}

async function evaluateInElectronPage(electronApp, scriptBody) {
  return withPrimaryWebContents(
    electronApp,
    async (wc, payload) => {
      return wc.executeJavaScript(payload.script, true);
    },
    { script: scriptBody },
  );
}

async function isElectronAuthenticated(electronApp) {
  const script = `(() => {
    const url = window.location.href || '';
    const hasLoginForm = Boolean(
      document.querySelector('input[name="email"], input[name="pass"], #login_form, [data-testid="royal_login_form"]')
    );
    return {
      url,
      authenticated: !/facebook\\.com\\/login/i.test(url) && !hasLoginForm,
    };
  })();`;
  return evaluateInElectronPage(electronApp, script);
}

async function isBrowserAuthenticated(page) {
  return page.evaluate(() => {
    const url = window.location.href || '';
    const hasLoginForm = Boolean(
      document.querySelector('input[name="email"], input[name="pass"], #login_form, [data-testid="royal_login_form"]'),
    );
    return {
      url,
      authenticated: !/facebook\.com\/login/i.test(url) && !hasLoginForm,
    };
  });
}

function readOnePasswordFacebookCredentials({ item, vault }) {
  const escapedItem = JSON.stringify(String(item));
  const escapedVault = vault && String(vault).trim() ? JSON.stringify(String(vault).trim()) : '';

  const command = escapedVault
    ? `op signin >/dev/null && op item get ${escapedItem} --vault ${escapedVault} --format json`
    : `op signin >/dev/null && op item get ${escapedItem} --format json`;

  let output;
  try {
    output = execFileSync('/bin/bash', ['-lc', command], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const detail =
      (error && error.stderr && String(error.stderr).trim()) ||
      (error && error.message) ||
      'unknown 1Password CLI error';
    throw new Error(
      `Unable to read 1Password item \"${item}\". Ensure 1Password app integration is enabled and authorize when prompted. Detail: ${detail}`,
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(String(output));
  } catch {
    throw new Error(`Failed to parse 1Password item JSON for \"${item}\".`);
  }

  const fields = Array.isArray(parsed.fields) ? parsed.fields : [];

  const pickFieldValue = (predicate) => {
    const field = fields.find(predicate);
    if (!field) return undefined;
    if (typeof field.value === 'string' && field.value.trim()) return field.value.trim();
    return undefined;
  };

  const username = pickFieldValue(
    (field) =>
      field.purpose === 'USERNAME' ||
      /user(name)?|email|login/i.test(`${field.label || ''} ${field.id || ''}`),
  );

  const password = pickFieldValue(
    (field) => field.purpose === 'PASSWORD' || /pass(word)?/i.test(`${field.label || ''} ${field.id || ''}`),
  );

  const otp = pickFieldValue(
    (field) => field.type === 'OTP' || /otp|one[- ]time|totp|2fa|auth/i.test(`${field.label || ''} ${field.id || ''}`),
  );

  if (!username || !password) {
    throw new Error(
      `1Password item \"${item}\" is missing username/password fields.`,
    );
  }

  return { username, password, otp };
}

async function attemptMichaelLoginWithOnePassword(page, { item, vault }) {
  console.log(`[Setup] Michael session unauthenticated, attempting 1Password login via item: ${item}`);

  const credentials = readOnePasswordFacebookCredentials({ item, vault });

  await page.goto('https://www.facebook.com/login.php?next=https%3A%2F%2Fwww.facebook.com%2Fmessages%2F', {
    waitUntil: 'domcontentloaded',
  });

  await page.locator('input[name="email"]').first().fill(credentials.username);
  await page.locator('input[name="pass"]').first().fill(credentials.password);

  let submitClicked = await page.evaluate(() => {
    const selectors = [
      'button[name="login"]',
      '#loginbutton',
      'button[type="submit"]',
      'input[name="login"]',
      'input[type="submit"]',
      '[role="button"][aria-label*="log in" i]',
      '[role="button"][aria-label*="login" i]',
    ];

    const isVisible = (el) => {
      if (!el || !(el instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
        return false;
      }
      const rect = el.getBoundingClientRect();
      return rect.width > 4 && rect.height > 4;
    };

    for (const selector of selectors) {
      const candidates = Array.from(document.querySelectorAll(selector));
      for (const el of candidates) {
        const disabled = el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true';
        if (disabled || !isVisible(el)) continue;
        el.click();
        return true;
      }
    }

    const form = document.querySelector('form');
    if (form) {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      return true;
    }

    return false;
  });

  if (!submitClicked) {
    try {
      await page.locator('input[name="pass"]').first().press('Enter', { timeout: 1500 });
      submitClicked = true;
    } catch {
      // ignore
    }
  }

  if (!submitClicked) {
    throw new Error('Could not submit Facebook login form in Michael session.');
  }

  await page.waitForLoadState('domcontentloaded');
  await wait(1500);

  const needsOtp = await page.evaluate(() => {
    return Boolean(
      document.querySelector(
        'input[name="approvals_code"], input[name="code"], input[autocomplete="one-time-code"]',
      ),
    );
  });

  if (needsOtp) {
    if (!credentials.otp) {
      throw new Error(
        'Facebook requested OTP but 1Password item has no OTP field configured.',
      );
    }

    const otpInput = page
      .locator(
        'input[name="approvals_code"], input[name="code"], input[autocomplete="one-time-code"]',
      )
      .first();
    await otpInput.fill(credentials.otp);

    const otpSubmitSelectors = [
      'button[type="submit"]',
      'input[type="submit"]',
      '[name="submit[Continue]"]',
    ];
    for (const selector of otpSubmitSelectors) {
      const locator = page.locator(selector).first();
      if ((await locator.count()) === 0) continue;
      try {
        await locator.click({ timeout: 1500 });
        break;
      } catch {
        // try next selector
      }
    }

    await page.waitForLoadState('domcontentloaded');
    await wait(1500);
  }

  const authState = await isBrowserAuthenticated(page);
  if (!authState.authenticated) {
    throw new Error(
      `Michael 1Password login did not complete. Current URL: ${authState.url}`,
    );
  }

  console.log('[Setup] Michael login via 1Password succeeded.');
}

async function waitForMichaelManualLogin(page, timeoutMs) {
  const waitMs = Math.max(0, Number(timeoutMs || 0));
  if (waitMs <= 0) return false;

  console.log(
    `[Setup] Waiting up to ${waitMs}ms for manual Michael login completion (solve any checkpoint/2FA in browser window)...`,
  );

  const started = Date.now();
  while (Date.now() - started < waitMs) {
    const auth = await isBrowserAuthenticated(page);
    if (auth.authenticated) {
      return true;
    }
    await wait(2000);
  }

  return false;
}

function buildIncomingVisibleScript() {
  const helpers = buildVisibilityHelpers();
  return `(() => {
    const isVisible = ${helpers.isVisibleSource};
    const hasVisible = (selectors) => {
      const all = Array.from(document.querySelectorAll(selectors.join(', ')));
      return all.some((el) => isVisible(el));
    };

    const answerSelectors = ${JSON.stringify(INCOMING_ANSWER_SELECTORS)};
    const declineSelectors = ${JSON.stringify(INCOMING_DECLINE_SELECTORS)};

    const hasAnswer = hasVisible(answerSelectors);
    const hasDecline = hasVisible(declineSelectors);

    return {
      hasAnswer,
      hasDecline,
      visible: hasAnswer && hasDecline,
      url: window.location.href,
    };
  })();`;
}

function buildClickCallStartScript() {
  return `(() => {
    const isVisible = ${buildVisibilityHelpers().isVisibleSource};
    const includePatterns = ${JSON.stringify(
      CALL_START_INCLUDE_PATTERNS.map((r) => r.source),
    )}.map((source) => new RegExp(source, 'i'));
    const excludePattern = new RegExp(${JSON.stringify(CALL_START_EXCLUDE_PATTERN.source)}, 'i');

    const candidates = Array.from(document.querySelectorAll('button, [role="button"], a[role="button"]'));
    for (const el of candidates) {
      if (!isVisible(el)) continue;
      const label = (el.getAttribute('aria-label') || el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!label) continue;
      if (excludePattern.test(label)) continue;
      if (!includePatterns.some((re) => re.test(label))) continue;

      el.scrollIntoView({ block: 'center', inline: 'nearest' });
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      return { clicked: true, label };
    }

    return { clicked: false, label: null };
  })();`;
}

function buildClickDeclineScript() {
  return `(() => {
    const isVisible = ${buildVisibilityHelpers().isVisibleSource};
    const selectors = ${JSON.stringify(INCOMING_DECLINE_SELECTORS)};
    const all = Array.from(document.querySelectorAll(selectors.join(', ')));
    for (const el of all) {
      if (!isVisible(el)) continue;
      const label = (el.getAttribute('aria-label') || el.textContent || '').replace(/\s+/g, ' ').trim();
      el.scrollIntoView({ block: 'center', inline: 'nearest' });
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      return { clicked: true, label };
    }
    return { clicked: false, label: null };
  })();`;
}

async function waitFor(fn, timeoutMs, intervalMs, description) {
  const start = Date.now();
  let lastResult;
  while (Date.now() - start < timeoutMs) {
    lastResult = await fn();
    if (lastResult) {
      return { ok: true, elapsedMs: Date.now() - start, lastResult };
    }
    await wait(intervalMs);
  }
  return { ok: false, elapsedMs: Date.now() - start, lastResult, description };
}

async function verifyStableVisibility(checkFn, durationMs = 6000, intervalMs = 300) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < durationMs) {
    const visible = await checkFn();
    if (!visible) {
      return { ok: false, elapsedMs: Date.now() - startedAt };
    }
    await wait(intervalMs);
  }
  return { ok: true, elapsedMs: Date.now() - startedAt };
}

async function runIncomingMichaelToAlex({ electronApp, michaelPage, timeoutMs }) {
  console.log('\n[Incoming] Michael -> Alex: triggering call from Michael web session...');

  const clickFromMichael = await michaelPage.evaluate(buildClickCallStartScript());
  if (!clickFromMichael.clicked) {
    throw new Error('Failed to click call start button in Michael session');
  }
  console.log(`[Incoming] Michael call button clicked: ${clickFromMichael.label}`);

  const incomingVisibleScript = buildIncomingVisibleScript();

  const appeared = await waitFor(
    async () => {
      const state = await evaluateInElectronPage(electronApp, incomingVisibleScript);
      return state.visible ? state : false;
    },
    timeoutMs,
    500,
    'Alex incoming call controls to appear',
  );

  if (!appeared.ok) {
    throw new Error('Incoming call controls did not appear in Alex app within timeout');
  }

  console.log(`[Incoming] Alex incoming controls detected after ${appeared.elapsedMs}ms`);

  const stable = await verifyStableVisibility(async () => {
    const state = await evaluateInElectronPage(electronApp, incomingVisibleScript);
    return Boolean(state && state.visible);
  }, 6000, 300);

  if (!stable.ok) {
    throw new Error(
      `Incoming call controls disappeared too early on Alex app (after ${stable.elapsedMs}ms)`,
    );
  }

  console.log('[Incoming] Alex incoming controls stayed visible for >= 6s (no 0.5s flicker)');

  const declineOnAlex = await evaluateInElectronPage(electronApp, buildClickDeclineScript());
  if (declineOnAlex.clicked) {
    console.log(`[Incoming] Declined call on Alex side: ${declineOnAlex.label || 'Decline'}`);
  }
}

async function runOutgoingAlexToMichael({ electronApp, michaelPage, timeoutMs }) {
  console.log('\n[Outgoing] Alex -> Michael: triggering call from Alex desktop app...');

  const clickFromAlex = await evaluateInElectronPage(electronApp, buildClickCallStartScript());
  if (!clickFromAlex.clicked) {
    throw new Error('Failed to click call start button in Alex app');
  }
  console.log(`[Outgoing] Alex call button clicked: ${clickFromAlex.label}`);

  const appeared = await waitFor(
    async () => {
      const state = await michaelPage.evaluate(buildIncomingVisibleScript());
      return state.visible ? state : false;
    },
    timeoutMs,
    500,
    'Michael incoming call controls to appear',
  );

  if (!appeared.ok) {
    throw new Error('Incoming call controls did not appear in Michael session within timeout');
  }

  console.log(`[Outgoing] Michael incoming controls detected after ${appeared.elapsedMs}ms`);

  const declineOnMichael = await michaelPage.evaluate(buildClickDeclineScript());
  if (declineOnMichael.clicked) {
    console.log(`[Outgoing] Declined call on Michael side: ${declineOnMichael.label || 'Decline'}`);
  }
}

async function run() {
  const appEntry = path.join(__dirname, '../dist/main/main.js');
  if (!fs.existsSync(appEntry)) {
    throw new Error('dist/main/main.js not found. Run `npm run build` first.');
  }

  const mode = String(process.env.CALL_TEST_MODE || 'both').toLowerCase();
  const timeoutMs = Number(process.env.CALL_TEST_TIMEOUT_MS || 30000);

  const threadUrl = process.env.CALL_THREAD_URL || 'https://www.facebook.com/messages/';
  const alexThreadUrl = process.env.ALEX_THREAD_URL || threadUrl;
  const michaelThreadUrl = process.env.MICHAEL_THREAD_URL || threadUrl;

  const michaelProfileDir =
    process.env.MICHAEL_PROFILE_DIR ||
    path.join(__dirname, '../.tmp/playwright-michael-profile');
  const opFacebookItem = String(process.env.OP_FACEBOOK_ITEM || 'Dad Facebook');
  const opVault = process.env.OP_VAULT || '';
  const autoLoginMichaelWithOp =
    String(process.env.MICHAEL_AUTOLOGIN_WITH_OP || 'true').toLowerCase() !== 'false';
  const michaelManualLoginTimeoutMs = Number(
    process.env.MICHAEL_MANUAL_LOGIN_TIMEOUT_MS || 180000,
  );

  let electronApp;
  let michaelContext;

  try {
    console.log('\n🧪 Call flow GUI test (Michael ↔ Alex)\n');
    console.log(`Mode: ${mode}`);
    console.log(`Alex URL: ${alexThreadUrl}`);
    console.log(`Michael URL: ${michaelThreadUrl}`);
    console.log(`Michael profile: ${michaelProfileDir}`);
    console.log(
      `Michael auto-login with 1Password: ${autoLoginMichaelWithOp ? `enabled (${opFacebookItem})` : 'disabled'}`,
    );
    console.log(`Michael manual-login fallback timeout: ${michaelManualLoginTimeoutMs}ms`);

    electronApp = await electron.launch({
      args: [appEntry],
      env: {
        ...process.env,
        NODE_ENV: 'development',
      },
    });

    await wait(4000);

    fs.mkdirSync(michaelProfileDir, { recursive: true });

    michaelContext = await chromium.launchPersistentContext(michaelProfileDir, {
      headless: false,
      viewport: { width: 1440, height: 900 },
    });

    const michaelPage = michaelContext.pages()[0] || (await michaelContext.newPage());

    await ensureElectronOnUrl(electronApp, alexThreadUrl);
    await michaelPage.goto(michaelThreadUrl, { waitUntil: 'domcontentloaded' });
    await wait(1500);

    const alexAuth = await isElectronAuthenticated(electronApp);
    let michaelAuth = await isBrowserAuthenticated(michaelPage);

    if (!alexAuth.authenticated) {
      throw new Error(`Alex app session is not authenticated. Current URL: ${alexAuth.url}`);
    }

    if (!michaelAuth.authenticated && autoLoginMichaelWithOp) {
      try {
        await attemptMichaelLoginWithOnePassword(michaelPage, {
          item: opFacebookItem,
          vault: opVault,
        });
      } catch (error) {
        console.log(
          `[Setup] Michael 1Password auto-login did not complete: ${error?.message || error}`,
        );
      }
      michaelAuth = await isBrowserAuthenticated(michaelPage);
    }

    if (!michaelAuth.authenticated) {
      const manualOk = await waitForMichaelManualLogin(
        michaelPage,
        michaelManualLoginTimeoutMs,
      );
      if (manualOk) {
        michaelAuth = await isBrowserAuthenticated(michaelPage);
      }
    }

    if (!michaelAuth.authenticated) {
      throw new Error(
        `Michael browser session is not authenticated. Current URL: ${michaelAuth.url}. ` +
          `Either pre-login this profile or keep manual login window open until authenticated.`,
      );
    }

    console.log('[Setup] Both Alex and Michael sessions are authenticated.');

    if (mode === 'incoming' || mode === 'both') {
      await runIncomingMichaelToAlex({ electronApp, michaelPage, timeoutMs });
    }

    if (mode === 'outgoing' || mode === 'both') {
      await runOutgoingAlexToMichael({ electronApp, michaelPage, timeoutMs });
    }

    console.log('\n✅ Call flow GUI test passed.');
  } finally {
    if (michaelContext) {
      await michaelContext.close().catch(() => {});
    }
    if (electronApp) {
      await electronApp.close().catch(() => {});
    }
  }
}

run().catch((error) => {
  console.error('\n❌ Call flow GUI test failed:', error?.message || error);
  process.exit(1);
});
