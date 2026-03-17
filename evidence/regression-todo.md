# Regression todo list

Single working checklist for active regressions.

Last updated: 2026-03-17

## Repo housekeeping

- [x] Audited overlapping Issue #45 scripts and documented the inventory in `docs/issue45-script-audit.md`
- [x] Deleted older Issue #45 media-button/live-capture scripts
- [x] Merged the two real resize Issue #45 scripts into `scripts/test-issue45-real-resize-gui.js`
- [x] Consolidated `test:issue45:live:scan:gui` onto the maintained live-types harness

## Test capability

- Desktop app logged in on primary account
- Web browser login available on secondary account
- Real two-account message testing is available
- Real two-account call testing is available

## Recommended order

### Easiest next

- [~] **41-B — marketplace links open inside the app again**
- [~] **41-A — own website-sent message triggers app notification**
- [ ] **41-C — muted group chats leaking notifications again**
- [ ] **41-D — non-chat Facebook activity notifications appearing again**

### Harder / timing-sensitive

- [~] **45-A — E2EE photo viewer missing controls / wrong top chrome**
- [ ] **45-B — non-E2EE / marketplace top bar briefly reappears**
- [ ] **41-E — microphone not released when remote side hangs up**

---

## Active items

- [~] **41-A — own website-sent message triggers app notification**
  - Status:
    - hard self-authored preview suppression was added
    - deterministic regression coverage was added
    - native/mutation suppression now checks both the original notification payload and the matched sidebar preview so dropped `You:` prefixes do not leak through
    - synthetic GUI no-message check now passes for a page-side `new Notification(... "You: ...")` probe on the current build
    - one real E2EE retest did **not** reproduce yet
    - one real browser-assisted non-E2EE retest on `Anju pant tickler` sent exactly one website-side message and captured zero desktop notifications on the instrumented app window
  - Still needed:
    - [x] retest on non-E2EE thread
    - [ ] retest from regular Facebook chat surface
    - [ ] retest on self-thread if accessible
    - [ ] verify real incoming messages from secondary account still notify normally
  - Notes:
    - likely easier than media issues
    - main remaining task is broader real verification

- [~] **41-B — marketplace links open inside the app again**
  - Goal:
    - marketplace links should open externally, not inside the app
  - Status:
    - marketplace URLs are now forced external before any in-app reroute logic
    - same-frame marketplace anchor clicks are now intercepted in preload and handed to the system browser
    - deterministic regression coverage was added for direct + wrapped marketplace URLs
    - GUI routing harness is healthy again and now passes the marketplace external-open case
  - Still needed:
    - [ ] find a real message containing a marketplace link
    - [ ] click it in the app and capture current behavior on current build
    - [ ] verify the real link opens externally without an in-app route hijack
  - Notes:
    - likely the easiest next item
    - existing code already intended marketplace to open externally; wrapped/messages URLs were the weak point

- [ ] **41-C — muted group chats leaking notifications again**
  - Goal:
    - muted groups produce no notifications
  - Still needed:
    - [ ] identify a real muted group target
    - [ ] send one fresh real message into it
    - [ ] verify whether even one notification leaks
    - [ ] compare with deterministic muted-conflict coverage

- [ ] **41-D — non-chat Facebook activity notifications appearing again**
  - Goal:
    - likes/comments/post activity should not appear as app notifications
  - Still needed:
    - [ ] trigger or observe a real non-message Facebook activity event
    - [ ] verify suppression in app
    - [ ] verify real message notifications still work
    - [ ] verify incoming-call notifications still work

- [ ] **41-E — microphone not released when remote side hangs up**
  - Goal:
    - microphone/input resources release immediately no matter who hangs up
  - Still needed:
    - [ ] run a real two-account call
    - [ ] have remote side hang up first
    - [ ] verify mic release immediately
    - [ ] compare against local hang-up behavior

- [~] **45-A — E2EE photo viewer missing controls / wrong top chrome**
  - Status:
    - real before/after evidence exists for a real E2EE thread
    - current behavior improved significantly
    - current real captures show media mode entering correctly
    - current real captures now show close/download/share top controls in current build
  - Still needed:
    - [ ] decide whether current evidence is clean enough for final reporter-facing proof
    - [ ] confirm close flow is also clean in the same real thread
    - [ ] keep only real screenshots/evidence for final proof

- [ ] **45-B — non-E2EE / marketplace top bar briefly reappears**
  - Goal:
    - no brief top-bar reappearance after media close or marketplace chat switch
  - Still needed:
    - [ ] script exact flow: open photo -> close -> switch chat -> wait 2–3s
    - [ ] run on known old non-E2EE threads
    - [ ] run marketplace chat entry/re-entry flow
    - [ ] retry under throttling if needed
    - [ ] capture debug report if reproduced

---

## Cross-reference / keep watching

- [ ] **46-A — muted-conflict fail-closed behavior**
  - deterministic coverage exists
  - needs live confirmation only if muted leaks continue

- [ ] **Call notification echo / duplicate pickup notifications**
  - keep watching during real call tests

- [ ] **Notification title count noise**
  - keep watching during non-chat activity tests

---

## Current best next pick

If choosing one item to work on next:

1. **41-B marketplace links opening in-app again**
2. **41-A own website-sent message notification verification**
3. **41-C muted group leak retest**
