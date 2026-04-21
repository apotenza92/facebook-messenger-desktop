# Issue #50 Follow-up Plan

## Summary
Implement issue #50 in two stages inside one tracked workstream:
1. fix the two proven call-notification regressions now;
2. harden diagnostics and wake-boundary suppression for the remaining group-management leak before broadening that classifier.

No user-facing API changes are required. Internal changes should introduce:
- one shared caller-extraction/normalisation path used by preload and main;
- one internal pure helper for “same call session, better caller arrived” notification upgrades;
- one richer internal call-activity classification result that can distinguish:
  - active incoming call;
  - suppressible call history/system activity;
  - non-call activity.

## Implementation Changes
### 1. Incoming-call caller-name regression
- Remove the bespoke preload caller parsing in `src/preload/notifications-inject.ts` and route caller extraction through the same normalisation rules used by `src/shared/incoming-call-evidence.ts`.
- The extractor must reject accessibility/chrome junk such as `callProfile pictureIncoming`, including camelCase variants and mixed generic tokens.
- Keep the existing placeholder-echo suppression in main, but add an explicit “same session, same key, improved caller/body” path in the incoming-call IPC policy so a generic first toast is immediately upgraded when the real caller arrives.
- Re-display the notification only when the new caller is non-null and the body improves; do not create duplicate extra toasts for unchanged bodies or later placeholder echoes.

### 2. Post-call history notification suppression
- Extend the shared call classifier to mark call-history/system rows as suppressible, not merely “non-incoming”.
- Suppress at least these bodies:
  - `X called you`
  - `You called X`
  - `Call ended`
  - `Missed video/audio call`
  - `Call cancelled`
  - `Answered elsewhere` / `Answered on another device`
  - `Joined the video/audio call`
  - `Video/audio call has started`
- Preserve current allowed incoming-call behaviour for genuine ringing payloads such as `X is calling you`, `Incoming video call`, and `X wants to call`.
- Apply the suppression result in all notification decision points:
  - preload native-notification interception;
  - preload mutation/sidebar path;
  - main-process display boundary.
- Evaluate both the raw payload and the matched sidebar row, because one source may be generic while the other contains the call-history wording.

### 3. Remaining group-management/admin leak
- Do not ship a broad phrase-table expansion blind. First add structured classifier logging so the next leak bundle shows exactly which branch failed.
- For every candidate notification, log:
  - source (`native`, `observed-row`, `matched-row`);
  - normalised href;
  - classifier result for raw payload and matched row;
  - suppression reason;
  - wake generation / settling state;
  - whether a wake-boundary snapshot existed.
- Make wake-boundary snapshots classification-aware: store href plus activity classification, not only href plus body, so post-wake replays are suppressed even when Messenger rewrites the body text for the same admin event.
- After instrumentation, broaden the shared group-management classifier to cover the missing moderation/membership phrasing family the next bundle proves, then run that classifier against both raw payload and matched row text.

## Test Plan
- Extend `scripts/test-issues-regressions.ts` with:
  - caller normalisation cases that reject `callProfile pictureIncoming` and similar junk;
  - extractor cases that still accept real caller names;
  - incoming-call session-upgrade cases:
    - generic active body + same-key named caller => immediate update;
    - named active body + placeholder echo => no update;
    - same-key named caller + unchanged body => no extra display;
  - call-history suppression cases for `Amanda called you`, `You called Amanda`, `Call ended`, and one allowed incoming-call control;
  - main-process display-boundary cases proving suppressible call activity is blocked and genuine incoming calls still show.
- Add wake-replay regression coverage for admin/global activity where the snapshot and replay bodies differ but the href is the same.
- Keep `npm run test:issues` as the deterministic release gate.
- Manual validation:
  - incoming call first toast shows the real caller on the first notification, not on the reminder;
  - no duplicate toasts during the same ring;
  - completed call does not emit `X called you`;
  - fresh direct messages still notify;
  - if a group/admin leak is reproduced again, the exported bundle identifies whether it was a phrase gap, row-matching gap, or wake-replay miss.

## Assumptions
- Persistent plan location: `plans/`, per user choice.
- Delivery shape: staged implementation, per user choice.
- The group-management fix should not broaden suppression beyond proven admin/moderation activity until the richer logs capture the escaping phrase.
- Existing live validation remains the repo checklist flow in `docs/call-testing.md` plus the call GUI harness already used for call-related fixes.

## 2026-04-21 Beta.9 Reporter Follow-up Review

### Uploaded Bundle
- Bundle: `messenger-debug-logs-2026-04-21T01-50-09-160Z.zip`.
- App version: `1.3.1-beta.9`.
- Local analysis path: `/tmp/issue50-logs/2026-04-21/extracted/messenger-debug-logs-2026-04-21T01-50-09-160Z/`.
- The bundle confirms the post-call history fix: the reporter no longer sees `X called you` after ending a call.
- The notification log does not contain the leaked group-admin candidate. There are no `=== NATIVE NOTIFICATION INTERCEPTED ===`, `show-notification-request`, `show-notification-classified`, `show-notification-displayed`, or preload candidate-analysis rows for the leak window.
- Wake-boundary rows in this bundle recorded `0` existing unread conversations, so this export cannot prove a phrase-table miss or wake-replay miss. The leak either occurred outside the exported in-memory/file window, or came through a notification source that bypasses the current page `Notification` constructor and renderer bridge logging.

### New Regressions Reported
- First incoming-call toast still falls back to `Someone is calling you on Messenger`.
- After pickup, two named incoming-call notifications appear.
- Completed-call history notifications remain suppressed.
- Group-admin leaks are rarer but still possible.

### Root-cause Hypotheses
- The first toast is still generic because beta.9 shows immediately when the first qualifying incoming-call evidence has no normalised caller. The later “improved caller arrived” path upgrades the active notification, but it cannot make the first displayed toast named.
- The duplicate named notifications after pickup likely come from the main-process incoming-call reminder timer. It refreshes every 12 seconds for up to 120 seconds and only stops when preload emits `incoming-call-ended`; pickup/connected states may remove the incoming controls too late, or leave enough stale state for reminders after the call has been answered.
- The group-admin leak is probably not yet a classifier phrase miss. The beta.9 classifier logging that should identify raw payload, matched row, href, wake generation, and suppression reason was not present for the leaked notification at all.

### Next Fix Order
1. Add a short pending-first-toast grace path for callerless incoming-call evidence. If a named same-session signal arrives during the grace window, show only the named toast; otherwise flush the generic toast after the timeout.
2. Stop and close active incoming-call reminders when the call UI transitions away from a ringing state, not only after the delayed `incoming-call-ended` controls-disappeared path. Add coverage for “generic first signal, named second signal, answered before reminder” so pickup cannot emit duplicate named reminders.
3. Extend notification diagnostics to catch notification sources that do not pass through the page `Notification` constructor or `show-notification` IPC. Log permission-granted notification paths and any Electron/session-level notification events available for service-worker style notifications.
4. Increase or harden the exported notification evidence window so a freshly reported leak cannot fall out of the bundle before export.
5. Only after the next bundle contains the actual leaked payload, broaden the group-management classifier for the proven moderation/membership wording and run that classifier against both raw payload and matched row text.

### Additional Test Coverage Needed
- First callerless incoming-call signal is held briefly and replaced by a named same-session signal without displaying a generic toast.
- Callerless first signal still displays after the grace timeout when no better caller arrives.
- Incoming-call reminder stops when the ringing state is answered/connected and does not show named duplicate reminders after pickup.
- Debug export includes a synthetic service-worker-style or non-constructor notification source with the same classifier payload fields as native and bridge notifications.
