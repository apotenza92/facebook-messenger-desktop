# Issue #49 bounded beta autopilot

This is the **bounded** local watcher/release bot for issue `#49`.

It is intentionally not an unbounded infinite maintainer loop.

## What it does

When a new reporter comment appears on issue `#49`, the autopilot can:

1. poll the issue with `gh`
2. clone/sync a dedicated local repo under `.tmp/issue49-autopilot/repo`
3. download comment attachments into `.tmp/issue49-autopilot/runs/comment-<id>/attachments/`
4. invoke `pi` in that dedicated clone with a persistent session directory
5. let `pi` analyze the new comment and attachments, implement a minimal fix if warranted, add tests, and prepare the next beta release metadata
6. rerun validation locally:
   - `npm run test:release`
   - `npm run test:issues`
   - `npm run test:issue49:offline`
   - `npm run build`
7. if the result is marked `ready-for-beta` and public actions are enabled:
   - commit the prepared patch
   - push to `main`
   - run `./scripts/release.sh <beta-version>`
   - wait for the GitHub release to appear
   - post the drafted issue reply

## Guardrails

The autopilot is bounded by default:

- watches **issue #49** only
- skips bot comments
- watches non-owner comments by default, or an explicit reporter allowlist via `ISSUE49_AUTOPILOT_WATCH_USERS`
- stops after `ISSUE49_AUTOPILOT_MAX_CYCLES` handled comments
- only ships **beta** releases (`ready-for-beta` requires a prerelease version)
- fails closed if:
  - `pi` does not produce the required result file
  - tests/build fail
  - release metadata is missing or invalid
  - push/release/comment steps fail

## Runtime state

All runtime state is local-only under:

- `.tmp/issue49-autopilot/state.json`
- `.tmp/issue49-autopilot/autopilot.log`
- `.tmp/issue49-autopilot/pi-sessions/`
- `.tmp/issue49-autopilot/runs/comment-<id>/`

## Startup behavior

On the **first run**, the watcher baselines the latest existing watched comment and then waits for future replies.
That avoids replaying the entire historical issue thread by default.

If you intentionally want backlog processing, pass `--replay-history` (for example via `ISSUE49_AUTOPILOT_ARGS="--replay-history"`).

## Modes

### Dry run
Safe default. The autopilot can analyze, patch, test, and draft replies, but it will **not** push, release, or comment.

```bash
node -r ./scripts/register-ts.js scripts/issue49-autopilot.ts --once --dry-run
```

### Public bounded beta autopilot
Allows:
- push to `main`
- beta release
- issue reply

```bash
ISSUE49_AUTOPILOT_PUBLIC=1 \
node -r ./scripts/register-ts.js scripts/issue49-autopilot.ts --loop --public-actions
```

## tmux launcher

Start in tmux:

```bash
./scripts/start-issue49-autopilot-tmux.sh
```

Detached:

```bash
./scripts/start-issue49-autopilot-tmux.sh --detached
```

Enable public actions explicitly:

```bash
ISSUE49_AUTOPILOT_PUBLIC=1 ./scripts/start-issue49-autopilot-tmux.sh
```

## Useful environment variables

- `ISSUE49_AUTOPILOT_PUBLIC=1` — enable push + beta release + comment
- `ISSUE49_AUTOPILOT_POLL_SECONDS=300` — poll interval
- `ISSUE49_AUTOPILOT_MAX_CYCLES=8` — hard stop after N handled comments
- `ISSUE49_AUTOPILOT_WATCH_USERS=user1,user2` — restrict to specific reporter login(s)
- `ISSUE49_AUTOPILOT_PI_MODEL=...` — optional `pi` model override
- `ISSUE49_AUTOPILOT_PI_THINKING=high` — optional `pi` thinking override
- `ISSUE49_AUTOPILOT_ARGS="..."` — raw extra args passed to the watcher command (for example `--replay-history`)

## Notes

- The dedicated clone avoids interfering with normal work in the main repo checkout.
- The autopilot does **not** close the issue automatically.
- If a cycle is marked `needs-human` or `failed`, inspect the matching run directory for artifacts and logs.
