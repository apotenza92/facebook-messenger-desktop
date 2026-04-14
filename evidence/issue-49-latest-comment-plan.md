# Issue #49 — finalisation plan for the latest reporter comments

## Scope
This plan is for the remaining open reporter feedback after `1.3.1-beta.3`.

Comments in scope:
- latest Marketplace follow-up on `beta.3`
  - improved before sleep
  - still repros after laptop sleep
  - still repros again after roughly 20–30 minutes in the same logged-in app session
- earlier sleep/wake follow-up about group approval / admin notifications leaking after wake

## Goal
Finish this issue with one more targeted pass instead of another broad speculative beta.

That means:
- explain the remaining failure shapes precisely
- patch only the code paths that the latest bundles actually implicate
- add deterministic offline proof for both bug classes
- improve the next bundle so any remaining miss is immediately diagnosable
- only ask the reporter for two narrow validation checks

---

## Executive read

## A. Marketplace
The latest `beta.3` bundles suggest the remaining Marketplace problem is now a **continuity degradation problem**, not the original simple route-change miss.

What changed since `beta.2`:
- immediate route-change rescue is clearly better
- ordinary pre-sleep navigation looks improved

What still fails:
- after sleep/wake, or after a long-lived session, Marketplace can fall back into a weaker rendering state
- those later routes often only produce **weak bootstrap** evidence, not a durable strong header-backed session
- once the prior Marketplace continuity becomes too weak, the next Marketplace route can still clear or fail to bridge

Working hypothesis:
- the same underlying weakness explains both user observations:
  1. repro after sleep/wake
  2. repro again after 20–30 minutes without requiring sleep
- sleep/wake is probably a trigger or accelerator, not the sole root cause

## B. Notifications
The approval / admin notification leak still looks like a **wake-boundary replay problem** until disproven.

What we know:
- power-state transitions were present in the older bundle
- the beta.3 comment did not report the emoji/title issue again
- the remaining concern is whether old approval/admin rows can still be replayed as fresh notifications after resume/unlock

Working hypothesis:
- the cosmetic title problem is likely fixed
- the deeper remaining risk is stale row replay or delayed DOM hydration after wake

---

## Definition of done
We are done only when all of the following are true.

### Marketplace done means
- the app survives:
  - normal chat → Marketplace → back → other chat → Marketplace
  - the same flow after sleep/wake
  - the same flow after a long-lived session with no restart
- recent **weak-bootstrap-confirmed** Marketplace sessions can safely bridge across route changes when Facebook never re-renders the full strong header in time
- ordinary chats still fail closed
- deterministic tests cover:
  - post-sleep / long-session weak continuity
  - route-change bridging from recent weak-bootstrap state
  - expiry / mismatch / ordinary-chat rejection
- debug logs clearly distinguish:
  - strong-header continuity
  - weak-bootstrap continuity
  - why a route was rescued, expired, or rejected

### Notification done means
- pre-existing approval/admin rows do not emit fresh native notifications after resume/unlock
- fresh real DMs after wake still notify
- deterministic tests cover stale replay vs truly fresh messages
- debug logs clearly show wake generation, stale snapshot, admin/activity classification, and suppression reason

### Release-quality done means
- `npm run test:issues`
- `npm run test:issue49:offline`
- `npm run build`
- dev smoke launch
- changelog updated
- issue reply prepared with exact validation asks

---

## 1) Marketplace finalisation plan

## Root-cause target
Treat the remaining Marketplace issue as:
- **recent weak Marketplace continuity is not being preserved strongly enough across later route changes and long-lived-session churn**

This is broader than reconnect, but reconnect can be one trigger.

## Code areas
- `src/preload/marketplace-thread-policy.ts`
- `src/preload/preload.ts`
- `scripts/test-issues-regressions.ts`
- `scripts/test-issue49-offline-harness.ts`
- optionally fixture updates under `fixtures/issue49/`

## Required implementation changes

### 1.1 Preserve weak-bootstrap continuity explicitly
Add a first-class recent-session path for:
- `weak-bootstrap-confirmed`

That continuity should carry:
- route key
- timestamp / age
- source signals (`right-pane-action`, weak header candidate, etc.)
- whether it ever had a strong header band
- why it is still considered bridgeable

### 1.2 Allow safe route-change rescue from recent weak-bootstrap sessions
If the previous Marketplace session was only weak-bootstrap-confirmed, allow a short rescue path on the next route when the new route shows a consistent Marketplace progression, even without an early back control.

Evidence that can be sufficient in combination:
- recent prior Marketplace continuity still within time budget
- right-pane Marketplace action signal on the new route
- repeat weak Marketplace candidate on the new route
- route-change timing consistent with a Messenger rerender, not a random old screen

Evidence that must still fail closed:
- only ordinary-chat chrome for the whole rescue window
- mismatched continuation shape across routes
- stale prior session beyond the rescue budget
- stray Marketplace text without route/context corroboration

### 1.3 Add a long-session degradation guard
The latest `beta.3` log suggests continuity can decay during a long app run.

Add explicit handling for:
- recent Marketplace continuity that is still valid even if the last few samples are visually weak
- a clear cutoff after which the continuity must be dropped

This should prevent:
- “works right after login but breaks after 20–30 minutes”

### 1.4 Decide whether reconnect should trigger a soft reset or re-evaluation
Allen suggested a reload on reconnect.

Treat this as an optional mitigation, not the main fix.

Plan:
- first implement the continuity fix so the app can survive without reload
- then evaluate whether `online-recovery` should additionally trigger a targeted Marketplace re-evaluation or safe state refresh
- avoid full app reload unless the underlying continuity bug still needs a fallback

## Required Marketplace diagnostics
Log whether continuity came from:
- `strong-confirmed`
- `weak-bootstrap-confirmed`
- `route-change-rescue`
- `online-recovery` / wake-boundary re-evaluation (if added)

Add debug fields/tags for:
- `marketplaceContinuityKind`
- `marketplaceContinuityAgeMs`
- `marketplaceContinuityBridgeAllowed`
- `route-change-rescue-from-weak-bootstrap`
- `route-change-rescue-rejected-no-bridgeable-continuity`
- `route-change-rescue-rejected-insufficient-new-route-evidence`
- `route-change-rescue-expired`

## Required Marketplace tests

### Deterministic regression tests
Add cases for:
1. prior `weak-bootstrap-confirmed` Marketplace session → route change → weak Marketplace evidence on new route → **should bridge**
2. same as above after simulated `resume` / `online-recovery` → **should bridge**
3. same as above after continuity age exceeds safe window → **should clear**
4. ordinary chat with weak Marketplace-ish noise → **should clear**
5. long-lived-session case where strong header never returns but repeated weak Marketplace evidence persists → **should keep continuity long enough to survive navigation**

### Offline harness scenarios
Extend the DOM harness to simulate:
- wake/resume rerender where the new route initially looks ordinary
- delayed Marketplace chrome arrival without early back control
- long-lived session degradation where only weak Marketplace signals remain

## Marketplace proof checkpoints before release
- Can the latest `beta.3` time-based repro be mapped to a recent weak-bootstrap continuity loss?
- Is the new rescue path safe without a back control?
- What exact combination of weak signals is enough to rescue?
- What exact timeout drops continuity to avoid stickiness?

---

## 2) Notification finalisation plan

## Root-cause target
Treat the remaining notification concern as:
- **stale approval/admin activity can still cross the wake boundary and look fresh if Messenger rehydrates late**

## Code areas
- `src/preload/notifications-inject.ts`
- `src/preload/notification-decision-policy.ts`
- `src/shared/notification-activity-policy.ts`
- `scripts/test-issues-regressions.ts`
- `scripts/test-issue49-offline-harness.ts`
- optionally fixture updates under `fixtures/issue49/`

## Required implementation changes

### 2.1 Re-audit wake-boundary unread snapshots
Verify that on:
- `resume`
- `unlock-screen`
- `online-recovery`

the snapshot of existing unread rows is always refreshed before delayed DOM replay can be treated as a new notification.

### 2.2 Tighten stale admin/activity replay suppression
For rows classified as approval/admin/global Facebook activity:
- suppress if the row existed before the wake generation
- suppress if it reappears during the settling period without a true freshness signal

### 2.3 Ensure fresh DMs still pass
Keep a positive path for:
- truly new direct message rows after wake
- rows that were absent from the pre-wake snapshot and become unread only after the wake generation begins

### 2.4 Add clearer debugging
For every post-wake candidate, log:
- wake generation id
- whether the row existed in the pre-wake snapshot
- activity classification
- settling period status
- final suppression / allow reason

## Required notification tests
Add deterministic cases for:
1. pre-existing approval/admin row + resume/unlock + delayed replay → **suppressed**
2. pre-existing global activity row + resume/unlock + delayed replay → **suppressed**
3. truly fresh DM row after wake → **allowed**
4. stale row survives cache or rerender noise across wake generations → **suppressed**
5. `online-recovery` behaves like other wake boundaries for stale admin rows → **suppressed**

## Notification proof checkpoints before release
- Can we point to the exact place where an old row would otherwise be mis-read as fresh?
- Are admin/activity rows suppressed early enough in both native and mutation-observer paths?
- Do fresh direct messages still notify in the deterministic wake tests?
- Would the next debug bundle immediately prove whether a wake replay slipped through again?

---

## 3) Final validation checklist

### Implementation / test checklist
- [ ] extend Marketplace continuity model to include recent weak-bootstrap sessions
- [ ] add weak-bootstrap route-change rescue logic
- [ ] add long-session degradation regression coverage
- [ ] optionally evaluate targeted online-recovery Marketplace re-evaluation
- [ ] re-audit wake-boundary snapshot logic for notifications
- [ ] harden stale admin/activity replay suppression
- [ ] add wake-boundary notification regressions
- [ ] extend offline harness for both failure shapes
- [ ] `npm run test:issues`
- [ ] `npm run test:issue49:offline`
- [ ] `npm run build`
- [ ] dev smoke launch

### Evidence / release checklist
- [ ] update `CHANGELOG.md`
- [ ] summarize exactly what changed in Marketplace continuity handling
- [ ] summarize exactly what changed in wake-boundary notification suppression
- [ ] prepare issue reply with two narrow asks only

---

## 4) Reporter-facing validation asks for the next beta
Keep the request narrow.

### Ask 1 — Marketplace
Please test:
1. launch the app and log in normally
2. try normal chat → Marketplace → back → other chat → Marketplace
3. repeat once after sleep/wake
4. repeat again later in the same long-running session without restarting

What we want to know:
- does Marketplace still lose its back/header treatment in any of those three situations?

### Ask 2 — Notifications
Please confirm whether any approval/admin/group-management notification appears as a fresh desktop notification after sleep/wake.

What we want to know:
- did any stale admin/activity notification appear after wake?
- did real fresh direct messages still notify normally?

---

## 5) Pi subagent execution plan
Use subagents to keep the two bug classes separate.

### Phase 1 — scout in parallel
- `scout`: map the latest `beta.3` Marketplace sleep/time-based bundles to the exact continuity-loss transition points
- `scout`: map current wake-boundary notification suppression and identify any remaining stale replay gap

### Phase 2 — planner
- `planner`: turn the two scout reports into a minimal patch order with explicit false-positive risks

### Phase 3 — implementation workers
- `worker`: Marketplace weak-bootstrap continuity + rescue tests + offline harness additions
- `worker`: notification wake-boundary replay hardening + tests + offline harness additions

### Phase 4 — reviewer
- `reviewer`: specifically check for
  - Marketplace over-stickiness
  - rescue without sufficient corroboration
  - notification over-suppression of real fresh DMs
  - missing diagnostics needed for the next bundle

### Phase 5 — polish
- final pass for changelog, issue reply draft, and full validation reruns

---

## 6) Ship criteria
Ship the next beta only if:
- Marketplace continuity survives both the sleep-triggered and time-based cases in deterministic coverage
- notification wake-boundary tests prove stale approval/admin replay is suppressed
- logs are conclusive enough that any further miss will be obvious from the next bundle
- the issue reply can truthfully say the new beta targets:
  1. Marketplace weak-continuity loss after sleep / long sessions
  2. stale approval/admin replay after wake
