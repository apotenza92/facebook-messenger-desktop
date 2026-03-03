# Call Flow GUI Testing (Michael ↔ Alex)

Use this for **all call-related changes**.

## Required direction

- **Incoming-call validation:** Michael calls Alex (`Michael -> Alex`)
- **Outgoing-call validation:** Alex calls Michael (`Alex -> Michael`)

## Command

```bash
node scripts/test-call-flows-gui.js
```

## Environment

- `MICHAEL_PROFILE_DIR` (optional): Playwright persistent profile directory for Michael.  
  Default: `./.tmp/playwright-michael-profile`
- `CALL_THREAD_URL` (optional): Conversation URL used by both sides.
- `ALEX_THREAD_URL` (optional): Overrides Alex app URL.
- `MICHAEL_THREAD_URL` (optional): Overrides Michael browser URL.
- `CALL_TEST_MODE` (optional): `incoming`, `outgoing`, or `both` (default `both`).
- `CALL_TEST_TIMEOUT_MS` (optional): Default `30000`.
- `MICHAEL_AUTOLOGIN_WITH_OP` (optional): `true`/`false` (default `true`).
- `OP_FACEBOOK_ITEM` (optional): 1Password item title for Michael credentials. Default: `Dad Facebook`.
- `OP_VAULT` (optional): Vault name/UUID when item lookup needs explicit vault.

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
MICHAEL_PROFILE_DIR="$PWD/.tmp/playwright-michael-profile" \
OP_FACEBOOK_ITEM="Dad Facebook" \
CALL_THREAD_URL="https://www.facebook.com/messages/t/<thread-id>" \
CALL_TEST_MODE=both \
node scripts/test-call-flows-gui.js
```

The script will auto-login Michael with 1Password if the profile is not already authenticated.

## Notes

- Alex side runs in the Electron app under test.
- Michael side runs in Playwright Chromium persistent context.
- Incoming test includes a stability assertion to catch quick overlay collapse/flicker regressions.
- The tmux `keepalive` window pings `op whoami` periodically to reduce idle-session expiry.
