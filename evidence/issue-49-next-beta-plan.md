# Issue #49 — next `1.3.1` beta plan

## Goal
Ship the next `1.3.1-beta.*` with a focused fix for the two latest reporter follow-ups on issue #49:

1. Marketplace thread re-entry still loses the expected native back/header treatment after a normal-chat detour.
2. Some desktop notification titles are showing a stray emoji in the alternate-name suffix.

## Evidence reviewed

### Latest reporter comments
- Marketplace repro + logs:
  - `https://github.com/apotenza92/facebook-messenger-desktop/issues/49#issuecomment-4231554606`
  - attached bundle: `messenger-debug-logs-2026-04-12T12-57-07-437Z.zip`
- Notification title screenshot:
  - `https://github.com/apotenza92/facebook-messenger-desktop/issues/49#issuecomment-4233001362`
  - attached image asset: `1c0436b4-c653-4635-9624-fffc3e94fd65`

### Local review artifacts
Downloaded for local inspection:
- `/tmp/issue49-review/reporter-2026-04-12-logs.zip`
- `/tmp/issue49-review/reporter-2026-04-12-notification.png`

## Current diagnosis

### A. Marketplace regression still open
Reporter repro:
1. Open normal chat A
2. Enter Marketplace chat / panel
3. Back out
4. Switch to normal chat B
5. Re-enter Marketplace chat / panel
6. Back button/header treatment is missing or wrong

### What the log suggests
The failing re-entry reaches the Marketplace thread route, but the session is dropped too early.

Observed sequence from the log bundle:
- confirmed Marketplace session existed earlier on the same thread
- route changes away to ordinary chats
- on re-entry, the new Marketplace route briefly shows weak Marketplace evidence (`rightPaneMarketplaceSignalDetected: true`)
- state enters `weak-bootstrap-pending`
- that signal disappears before strong confirmation lands
- only weak header candidates remain
- those weak candidates are rejected
- the route settles as ordinary chat instead of keeping Marketplace visual state alive

Representative failing transitions from `media-overlay-debug.ndjson`:
- prior confirmed Marketplace route: `strong-confirmed`
- re-entry: `weak-bootstrap-pending`
- shortly after: `inactive` / `rejected`
- matched signals include:
  - `header-marketplace-candidate`
  - `header-back+marketplace-fallback-rejected`
  - `header-marketplace-rejected`

### Code hotspots
- `src/preload/marketplace-thread-policy.ts`
  - `resolveMarketplaceVisualSessionDecision()` currently clears aggressively on route change unless the new weak header matches the prior confirmed header band.
- `src/preload/preload.ts`
  - caller logic already surfaces `pendingBootstrapSignalSource`, route-change weak-header evidence, and debug tags.
- `scripts/test-issues-regressions.ts`
  - already contains nearby issue #49 coverage, including route-change weak-header bridging, but not the exact detour sequence from the latest report.

### B. Notification title emoji leak
The screenshot shows a title formatted like:
- `Conversation Name (emoji)`

That strongly suggests an emoji-only value is being treated as an alternate display name.

### Likely source
- `src/preload/notifications-inject.ts`
  - `extractRealNamesFromConversation()` scans `img[alt]` values from the conversation surface.
  - it tries to skip emoji-only values with `/^[\p{Emoji}\s]+$/u`, which is likely too weak for compound emoji sequences using modifiers / variation selectors / ZWJ joins.
  - cached names are later fed into notification title formatting.
- `src/preload/notification-display-policy.ts`
  - `formatNotificationDisplayTitle()` filters generic names, but does not defensively reject emoji-only alternates.

## Working hypotheses

### Marketplace
The route-change logic is still biased toward clearing as soon as the new route does not strongly match the prior header band. That works for stale or false-positive weak headers, but it is too strict for the reporter's detour flow where:
- Marketplace evidence appears briefly on route entry,
- then collapses into a weaker back/header presentation,
- before the new route fully stabilizes.

### Notification title
We have only a single filter point for emoji-like alternates, and it is implemented at cache-ingest time with an incomplete regex. We need both:
- a stronger cache-ingest filter, and
- a final display-boundary filter.

## Implementation plan

## 1) Marketplace route-change retention fix
Update `src/preload/marketplace-thread-policy.ts` so that a recently confirmed Marketplace session is not cleared immediately when a route change lands in a weak re-entry state.

### Proposed behavior
On route change, keep the prior Marketplace session alive for a short grace path when all of the following are true:
- previous session was recently matched / confirmed,
- new route has at least weak Marketplace evidence,
- and the evidence is consistent with fresh re-entry rather than stale residue.

### Likely shape of the change
Add or refine a route-change bridge path for cases like:
- `pendingBootstrapSignalSource` present on the new route, even if confirmation is not complete yet,
- or a weak Marketplace header candidate appears immediately after route entry,
- or a back-only Marketplace anchor survives the immediate rerender.

### Constraints
Do **not** make weak headers sticky forever. The bridge must still fail closed when:
- the prior Marketplace session is stale,
- the new route ages past the allowed grace window,
- or the weak evidence clearly diverges from the prior Marketplace context.

### Debug additions
Add explicit debug fields/tags for:
- route-change clear deferred vs immediate clear
- route-change bridge source (`pending-bootstrap`, `weak-header`, `back-anchor`, `bridge-only`)
- why a pending route-change bridge was rejected

## 2) Marketplace regression coverage
Extend `scripts/test-issues-regressions.ts` with the latest detour pattern.

### New deterministic cases to add
- confirmed Marketplace session → ordinary chat A → ordinary chat B → Marketplace re-entry with temporary weak bootstrap → session should stay bridged long enough to confirm
- route-change pending bootstrap should not immediately collapse to `cleared`
- stale version of the same flow should still clear
- weak re-entry on an actually ordinary chat should still fail closed

### Acceptance criteria
- `npm run test:issues` passes
- the new tests specifically guard the reporter repro sequence

## 3) Notification alternate-name sanitization
Patch all three layers: cache load, cache ingest, and display formatting.

### Cache-load cleanup
In `src/preload/notifications-inject.ts`:
- scrub cached `realNames` on load so previously stored emoji-only or decorative alternates stop showing up immediately
- normalize and rewrite cache entries when invalid names are removed
- keep migration behavior safe for existing cache formats

### Ingest-side changes
In `src/preload/notifications-inject.ts`:
- strengthen the filter used by `extractRealNamesFromConversation()`
- reject emoji-only / symbol-only / decorative alt strings
- prefer a helper with a positive signal such as "contains letters or numbers" over trying to enumerate every emoji form
- consider tightening which `img[alt]` nodes qualify as candidate real names, rather than scanning every alt in `[role="main"]`

### Display-side changes
In `src/preload/notification-display-policy.ts`:
- add a final guard that drops alternate names that are emoji-only, symbol-only, or otherwise non-name-like
- keep valid nickname/real-name suffix behavior intact

### Acceptance criteria
- cached bad alternates stop showing up in notification titles, including pre-existing bad cache entries
- a valid direct-chat title like `Nickname (Real Name)` still works
- group summaries still work
- emoji-only alternates are always dropped
- decorative or symbol-only alternates are dropped

## 4) Notification regression coverage
Add tests in `scripts/test-issues-regressions.ts` for:
- alternate name = emoji-only → filtered out
- alternate names = valid + emoji → keep only valid
- title display with old cached emoji alternate → output should omit emoji suffix
- generic alternates + emoji alternates → all filtered when appropriate

## 5) Beta verification checklist
Before cutting the next beta:
- [x] `npm run test:issues`
- [x] add deterministic coverage for the preload-side weak Marketplace bootstrap wiring
- [x] add deterministic coverage for notification cache-cleanup filtering
- [x] update `CHANGELOG.md` for the next beta draft entry
- [x] `npm run build`
- [x] `npm start` launch smoke in dev mode
- [ ] targeted Marketplace repro walkthrough using the reporter sequence with a live signed-in session
- [ ] confirm a weak Marketplace re-entry does not lose the back/header treatment in a live GUI run
- [ ] confirm ordinary chats with stray Marketplace-looking labels still fail closed in a live GUI run
- [ ] confirm no notification title appends emoji-only alternates in a live GUI run
- [ ] inspect fresh debug bundle fields if Marketplace still regresses

## Explicit acceptance criteria for the beta

### Marketplace
- reporter repro should stay in Marketplace mode after re-entry:
  - normal chat A → Marketplace → back → normal chat B → Marketplace again
- no false-positive bridge should keep ordinary chats in Marketplace mode
- debug output should distinguish between:
  - immediate clear
  - deferred clear
  - bridged re-entry
  - rejected weak re-entry

### Notification title formatting
- old bad cache entries should stop affecting titles after the updated build runs
- valid alternate-name suffixes should still render for normal direct/group chats
- emoji-only alternates should never appear in final displayed titles

## Pi subagent execution plan
Use pi subagents to keep the next beta iteration fast and isolated.

### Why use subagents here
Per the pi subagent docs/examples, subagents give:
- isolated context per task
- parallel recon/review when the work splits cleanly
- chain workflows where one agent hands compressed context to the next
- reviewer passes before shipping the beta

### Recommended agent roles
Available built-in agents are enough here:
- `scout` — fast recon and evidence extraction
- `planner` — implementation planning and risk review
- `worker` — code changes + tests
- `reviewer` — diff review and regression review

### Suggested workflow

#### Phase 1 — parallel recon
Run two scouts in parallel:
1. Marketplace session-policy scout
   - inspect `marketplace-thread-policy.ts`, `preload.ts`, existing issue #49 tests, and failing debug fields
2. Notification-title scout
   - inspect `notifications-inject.ts`, `notification-display-policy.ts`, and relevant tests

Expected output:
- one compressed context summary per track
- exact file/function change points
- list of tests to add

#### Phase 2 — planning chain
Feed the scout outputs into `planner` to produce a single combined implementation plan for the next beta.

Expected output:
- minimal patch order
- risk notes
- validation sequence

#### Phase 3 — implementation split
Use separate `worker` runs for:
1. Marketplace policy + tests
2. Notification title sanitization + tests

If both changes are developed in parallel, prefer isolated worktrees to avoid file conflicts.

#### Phase 4 — review
Run `reviewer` on the combined diff with focus on:
- false-positive Marketplace bridging
- accidental broadening of notification-name filtering
- missing regression coverage
- privacy-safe diagnostics and changelog wording

#### Phase 5 — final worker polish
Use one final `worker` pass to apply reviewer feedback, run tests, and prepare the beta summary.

## Example subagent patterns to use

### Parallel scouts
- use subagent parallel mode for the two recon tracks
- ideal when Marketplace and notification title work are still independent

### Plan chain
- use subagent chain mode:
  - `scout` → `planner`
- useful when turning raw code evidence into a concise patch plan

### Implement + review chain
- use subagent chain mode:
  - `worker` → `reviewer` → `worker`
- useful right before the beta cut

## Concrete subagent run outline

### 1. Recon
- Parallel:
  - `scout`: trace issue #49 Marketplace route-change/session logic and propose minimal fix points
  - `scout`: trace notification title alternate-name flow and propose minimal sanitization fix points

### 2. Consolidated plan
- Chain:
  - `planner`: combine the two scout outputs into a patch plan with tests and beta validation

### 3. Implementation
- Parallel or sequential, depending on overlap:
  - `worker`: implement Marketplace route-change grace bridge + tests
  - `worker`: implement notification alternate-name sanitization + tests

### 4. Review and polish
- Chain:
  - `reviewer`: review both diffs for regressions
  - `worker`: apply review feedback and rerun `npm run test:issues`

## Suggested deliverables for the next beta
- code fix for Marketplace route-change re-entry
- code fix for notification emoji-title suffix leak
- cache cleanup for previously stored invalid alternate names
- new deterministic regressions for both
- short beta notes telling the reporter exactly what to verify

## Draft reporter/beta verification note
When the next `1.3.1-beta.*` is available, ask for two focused checks:

1. Marketplace re-entry flow
   - start in a normal chat
   - enter a Marketplace chat
   - back out
   - switch to a different normal chat
   - enter Marketplace again
   - confirm the Marketplace back/header treatment stays correct

2. Notification title suffixes
   - watch for any desktop notification that still shows an emoji or decorative symbol in parentheses after the conversation name

If either issue still happens, request a fresh debug bundle immediately after repro.

## Beta ask-back after release
Request focused validation on:
1. normal chat → Marketplace → back → different normal chat → Marketplace again
2. any desktop notification that previously showed an emoji in the title suffix

If either still fails, ask for a fresh debug bundle immediately after repro so the new debug fields can confirm whether the route-change bridge, cache cleanup, or title sanitization still missed a case.

## Checklist status update — 2026-04-13
Completed locally:
- implemented Marketplace route-change pending-bootstrap bridge support
- implemented notification alternate-name filtering plus persisted cache cleanup
- expanded future debug-bundle coverage for Marketplace route-change bridge decisions and notification title/cache sanitization events
- added deterministic tests for the caller-side weak-bootstrap flow
- added deterministic tests for notification cache cleanup
- ran `npm run test:issues`
- ran `npm run build`
- ran `npm start` launch smoke in dev mode
- drafted `CHANGELOG.md` entry for `1.3.1-beta.2`

Still best handled as live human validation before or immediately after the beta cut:
- walk the exact Marketplace detour flow in a signed-in GUI session
- verify no notification title still shows an emoji/decorative suffix in real use

## Optional tracking follow-up
Optionally mirror the key action items into `evidence/regression-todo.md` so this beta work stays visible alongside the broader regression queue.
