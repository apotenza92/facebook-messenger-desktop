# Call Flow GUI Testing (tester B ↔ tester A)

Use this for **all call-related changes**.

## Required direction

- **Incoming-call validation:** tester B calls tester A (`B -> A`)
- **Outgoing-call validation:** tester A calls tester B (`A -> B`)

## Command

```bash
node scripts/test-call-flows-gui.js
```

## Environment

- `TESTER_B_PROFILE_DIR` (optional): Playwright persistent profile directory for tester B.
  Default: `./.tmp/playwright-tester-b-profile`
- `CALL_THREAD_URL` (optional): Conversation URL used by both sides.
- `TESTER_A_THREAD_URL` (optional): Overrides tester A's app URL.
- `TESTER_B_THREAD_URL` (optional): Overrides tester B's browser URL.
- `CALL_TEST_MODE` (optional): `incoming`, `outgoing`, or `both` (default `both`).
- `CALL_TEST_TIMEOUT_MS` (optional): Default `30000`.
- `TESTER_B_AUTOLOGIN_WITH_OP` (optional): `true`/`false`; enabled only when `OP_FACEBOOK_ITEM` is set.
- `OP_FACEBOOK_ITEM` (optional): 1Password item title for tester B's dedicated test credentials. No default credential name should be committed.
- `OP_VAULT` (optional): Vault name/UUID when item lookup needs explicit vault.
- `TESTER_B_MANUAL_LOGIN_TIMEOUT_MS` (optional): How long to wait for manual login/challenge completion if auto-login doesn’t finish. Default: `180000`.

## 1Password + tmux flow (recommended)

1. Start dedicated tmux session:

```bash
./scripts/start-call-test-tmux.sh
# or detached:
./scripts/start-call-test-tmux.sh call-test --no-attach
```

2. In tmux `auth` window, sign in once:

```bash
op signin
op whoami
```

3. In tmux `runner` window, run live test:

```bash
op signin >/dev/null && \
TESTER_B_PROFILE_DIR="$PWD/.tmp/playwright-tester-b-profile" \
OP_FACEBOOK_ITEM="<test-account-item>" \
CALL_THREAD_URL="https://www.facebook.com/messages/t/<thread-id>" \
CALL_TEST_MODE=both \
node scripts/test-call-flows-gui.js
```

The script will auto-login tester B with 1Password if the profile is not already authenticated.

## Notes

- Tester A runs in the Electron app under test.
- Tester B runs in a Playwright Chromium persistent context.
- Incoming test includes a stability assertion to catch quick overlay collapse/flicker regressions.
- Facebook may require manual checkpoint/2FA/captcha even after credentials are auto-filled; keep tester B's browser window open and complete prompts when needed.
- The tmux `keepalive` window pings `op signin`/`op whoami` periodically to reduce idle-session expiry.
