# Call Flow GUI Testing (Michael ↔ Alex)

Use this for **all call-related changes**.

## Required direction

- **Incoming-call validation:** Michael calls Alex (`Michael -> Alex`)
- **Outgoing-call validation:** Alex calls Michael (`Alex -> Michael`)

## Command

```bash
node scripts/test-call-flows-gui.js
```

## Required environment

- `MICHAEL_PROFILE_DIR` (**required**): Playwright persistent profile directory that is already logged into Michael's Facebook account.
- `CALL_THREAD_URL` (optional): Conversation URL used by both sides.
- `ALEX_THREAD_URL` (optional): Overrides Alex app URL.
- `MICHAEL_THREAD_URL` (optional): Overrides Michael browser URL.
- `CALL_TEST_MODE` (optional): `incoming`, `outgoing`, or `both` (default `both`).
- `CALL_TEST_TIMEOUT_MS` (optional): Default `30000`.

Example:

```bash
MICHAEL_PROFILE_DIR="$HOME/.messenger-test-profiles/michael" \
CALL_THREAD_URL="https://www.facebook.com/messages/t/<thread-id>" \
CALL_TEST_MODE=both \
node scripts/test-call-flows-gui.js
```

## Notes

- Alex side runs in the Electron app under test.
- Michael side runs in Playwright Chromium persistent context.
- The script fails fast if either side is not authenticated.
- Incoming test includes a stability assertion to catch quick overlay collapse/flicker regressions.
