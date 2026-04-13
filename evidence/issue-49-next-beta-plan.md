# Issue #49 — exact plan for the next beta follow-up

## Scope
This plan is only about the **latest reporter follow-up** after `1.3.1-beta.2`:
- comment: `https://github.com/apotenza92/facebook-messenger-desktop/issues/49#issuecomment-4235713350`

Bundles in scope:
- Marketplace repro on `1.3.1-beta.2`
  - `messenger-debug-logs-2026-04-13T10-32-36-160Z.zip`
- Group approval notification leak on `1.3.1-beta.1`
  - `messenger-debug-logs-2026-04-13T10-31-33-146Z.zip`

## Purpose
Do the minimum **correct** work needed to stop shipping partial follow-ups.

This means:
- no speculative fixes disconnected from the latest bundles
- no new beta until each reported failure has:
  - a concrete root-cause hypothesis
  - deterministic regression coverage or equivalent proof
  - targeted debug output if live validation is still incomplete
- no issue reply that just asks for another retest without explaining the exact new fix path

---

## The two things we must fix now

### 1) Marketplace still breaks on `1.3.1-beta.2`
Reporter repro:
1. open normal chat A
2. enter Marketplace
3. back out
4. switch to different normal chat B
5. enter Marketplace again
6. Marketplace back/header treatment is missing

### 2) Group approval notifications leaked after sleep/wake
Reporter note:
- happened after the laptop slept overnight
- bundle captured on `1.3.1-beta.1`
- likely wake/resume related

---

## Non-negotiable definition of done
We are **not done** until all of this is true.

### Marketplace done means
- the exact reporter repro above works reliably
- the latest `beta.2` failure shape is covered by a deterministic regression test
- ordinary chats still fail closed
- debug logs clearly show why a route was:
  - immediately cleared
  - held in rescue state
  - rescued by late Marketplace evidence
  - finally rejected as ordinary chat

### Notification done means
- approval/admin notifications that existed before sleep/wake do not appear as fresh desktop notifications after resume/unlock
- a deterministic regression test covers the wake/resume failure class
- real fresh direct messages after wake still notify
- debug logs clearly show wake generation, stale-vs-fresh reasoning, and suppression reason

### Release-quality done means
- `npm run test:issues`
- `npm run build`
- dev smoke launch
- updated `CHANGELOG.md`
- issue reply prepared with exact wording about what changed
- ideally live GUI validation; if not possible, the new deterministic tests and new diagnostics must be strong enough that the next bundle would be conclusive immediately

---

## What the latest bundles actually say

## A. Marketplace bundle (`beta.2`)
### Confirmed from the log
- a Marketplace session existed shortly before the failing handoff
- the route changed away and then back toward a Marketplace thread
- at the new-route handoff, the prior Marketplace session was cleared immediately
- at clear time, debug state showed:
  - `routeChangeDetected: true`
  - `routeChangeRecentMarketplaceMatch: true`
  - `routeChangePendingBootstrapBridgeReason: "no-pending-bootstrap-signal"`
  - transition: `cleared`
- **after** the clear, weak Marketplace header candidates appeared and were rejected

### Root-cause hypothesis
The `beta.2` bridge still assumes that rescue evidence must exist **at route-change handoff time**.

The remaining failure shape is:
1. route changes
2. first sample on the new route looks ordinary
3. old Marketplace session is cleared
4. weak Marketplace header appears slightly later on the same new route
5. there is no hold state left to rescue from

### What this means
The next fix is **not** “more pending-bootstrap bridging.”
It is:
- a short **route-change rescue window**
- plus matching logic for **late-arriving weak Marketplace evidence** on the new route

---

## B. Group approval notification bundle (`beta.1`)
### Confirmed from the log
- multiple `suspend`, `resume`, `lock-screen`, and `unlock-screen` transitions occurred
- the reporter's sleep/wake suspicion is plausible
- the exported log does not yet fully prove the end-to-end approval notification classification chain

### Root-cause hypothesis
Treat this as a wake/resume boundary bug until disproven.

Most likely buckets:
1. existing unread/admin rows are re-treated as fresh after wake
2. approval/admin notifications are not filtered consistently after resume/unlock
3. settling after wake is too short for Messenger's delayed DOM refresh
4. stale candidate state survives power-state transitions

### What this means
The next fix is **not** more title formatting work.
It is:
- harder wake/resume stale-notification suppression
- explicit approval/admin classification at the right boundary
- debug output that proves why something was allowed or suppressed after wake

---

## Exact work to do

## 1) Marketplace: implement a route-change rescue state
Target files:
- `src/preload/marketplace-thread-policy.ts`
- `src/preload/preload.ts`
- `scripts/test-issues-regressions.ts`

### Required behavior
When a recently confirmed Marketplace session route-changes and the new route is still within a short grace window:
- do **not** final-clear immediately just because the first sample looks ordinary
- keep a short-lived rescue state carrying the previous Marketplace context
- allow the new route to recover the session if later evidence appears soon after, such as:
  - weak Marketplace header band in the expected top-left region
  - back-anchor + weak Marketplace label pairing that settles slightly later
  - repeated weak-header progression consistent with Facebook finishing render after URL change

### Guardrails
Fail closed if:
- prior Marketplace session is stale
- rescue window expires
- later weak evidence is spatially inconsistent with the previous Marketplace header region
- route stabilizes as a normal chat with only ordinary-chat controls

### Concrete implementation steps
1. add a policy-level state for **route-change rescue pending**
2. preserve enough prior session geometry and timing to evaluate delayed weak evidence
3. evaluate late weak evidence against prior confirmed Marketplace context
4. expire rescue deterministically when:
   - only ordinary-chat evidence remains for long enough, or
   - rescue timeout is reached
5. emit explicit debug tags/fields for:
   - `route-change-rescue-pending`
   - `route-change-rescue-late-weak-header`
   - `route-change-rescue-expired`
   - `route-change-rescue-rejected-ordinary`
   - `route-change-rescue-rejected-mismatch`

### Things to avoid
- do not make Marketplace sticky forever
- do not rescue based on a bare `Marketplace` label anywhere on screen
- do not rescue ordinary chats that merely contain Marketplace links or residual top-chrome noise

---

## 2) Marketplace: turn the latest bundle into exact regression tests
Target file:
- `scripts/test-issues-regressions.ts`

### Required tests
1. **latest reporter shape**
   - confirmed Marketplace session
   - route changes away
   - route changes back
   - first new-route sample looks ordinary
   - second/third sample produces weak Marketplace header in the right region
   - expected: rescued, not cleared
2. same flow but rescue evidence arrives too late
   - expected: clear
3. same flow but weak header is spatially inconsistent
   - expected: clear
4. ordinary chat with stray Marketplace-ish label after route change
   - expected: clear
5. ordinary chat with Marketplace link + back button but no real Marketplace thread context
   - expected: clear

### Test standard
At least one Marketplace test should be shaped directly from the `beta.2` bundle timeline so we are not guessing.

---

## 3) Notifications: harden wake/resume stale-notification suppression
Target files:
- `src/preload/notifications-inject.ts`
- `src/preload/notification-decision-policy.ts`
- `src/shared/notification-activity-policy.ts`
- `scripts/test-issues-regressions.ts`

### Required behavior
On `resume` / `unlock-screen`:
- existing unread/admin rows must not be treated as fresh notifications
- approval/admin notifications must still be suppressed after wake even if Messenger rehydrates them late
- fresh real direct messages after wake must still notify

### Concrete implementation steps
1. audit where wake/unlock resets current notification candidate state
2. identify where existing-vs-fresh unread rows are snapshotted and compared
3. add or tighten explicit approval/admin notification classification if currently too weak
4. make wake/resume settling stricter for stale/admin rows
5. ensure stale candidate state cannot leak across wake generations
6. emit debug data for:
   - wake generation id
   - power-state transition received
   - stale-unread snapshot count
   - candidate classified as approval/admin
   - suppressed because pre-existing after wake
   - allowed because truly fresh after wake

### Things to avoid
- do not suppress all post-wake notifications blindly
- do not rely on title/body heuristics alone if route/context can strengthen classification
- do not leave the wake path under-instrumented again

---

## 4) Notifications: add deterministic wake/resume regressions
Target file:
- `scripts/test-issues-regressions.ts`

### Required tests
1. existing unread approval/admin notification survives sleep/wake
   - expected: suppressed
2. delayed DOM refresh after unlock/resume replays an existing approval/admin row
   - expected: suppressed
3. real fresh direct message after wake
   - expected: notify
4. generic admin text that previously slipped through
   - expected: suppressed
5. wake boundary clears stale state so an old candidate cannot later display as fresh
   - expected: suppressed

### Test standard
At least one notification test must explicitly model:
- pre-sleep existing row
- suspend/resume or lock/unlock transition
- delayed post-wake replay

---

## 5) Root-cause proof checkpoints before release
These questions must be answered in code/comments/tests before shipping the next beta.

### Marketplace proof checkpoints
- what exact state was missing when the late weak header arrived?
- what rescue window length is needed, and why is it safe?
- what exact evidence is sufficient to rescue?
- what exact evidence is insufficient and must still fail closed?

### Notification proof checkpoints
- where exactly is the stale approval/admin row crossing the fresh-notification boundary?
- is the suppression fix happening at the earliest reliable place?
- what post-wake scenario still allows real fresh direct messages through?
- what debug fields would let the next bundle prove success or failure immediately?

If we cannot answer these, the fix is not ready.

---

## 6) Validation checklist before another beta
- [ ] reproduce the latest Marketplace timeline from the bundle in deterministic tests
- [ ] implement Marketplace rescue-state fix
- [ ] prove ordinary-chat false positives still fail closed
- [ ] reproduce the wake/resume notification class in deterministic tests
- [ ] implement wake/resume stale/admin suppression hardening
- [ ] `npm run test:issues`
- [ ] `npm run build`
- [ ] dev smoke launch
- [ ] update `CHANGELOG.md`
- [ ] prepare issue reply with exact explanation of the two fixes

### Strongly preferred before release
- [ ] signed-in GUI validation of the exact Marketplace detour sequence
- [ ] local wake/resume validation for notifications if practical

---

## 7) Communication plan for the next reply
Only reply once the next targeted fix is underway or shipped.

### The reply must do four things
1. acknowledge that Marketplace still reproduced on `beta.2`
2. explain that the miss is a **late weak-header after route-change** case
3. explain that the approval leak likely involves a **wake/resume stale-notification boundary**
4. ask for only two narrow validation checks on the next beta

### What not to say
- do not imply `beta.2` should already have covered the latest Marketplace shape if it did not
- do not ask for a generic retest with no explanation
- do not overstate certainty on the notification root cause beyond what the bundle proves

---

## 8) Pi subagent execution plan
Use subagents to avoid mixing the two bug classes.

### Phase 1 — parallel scouts
- `scout`: map the exact `beta.2` Marketplace failure timeline onto code entry points
- `scout`: map wake/resume notification flow and identify stale/admin crossing point

### Phase 2 — planner
- `planner`: produce minimal patch order and explicit regression risks

### Phase 3 — workers
- `worker`: Marketplace rescue-state implementation + tests
- `worker`: wake/resume notification suppression + tests

### Phase 4 — review
- `reviewer`: specifically check for
  - Marketplace over-stickiness / false positives
  - notification over-suppression after wake
  - missing debug evidence

### Phase 5 — polish
- final `worker` pass for review feedback, test reruns, changelog, and issue reply draft

---

## 9) Final deliverables for the next beta
The next beta should contain exactly this:
- Marketplace route-change rescue state for late weak header arrival
- deterministic Marketplace regressions derived from the latest `beta.2` failure shape
- stronger wake/resume stale/admin notification suppression
- deterministic wake/resume approval-notification regressions
- richer diagnostics that make the next bundle conclusive if anything still slips through
- concise issue reply with two exact validation asks
