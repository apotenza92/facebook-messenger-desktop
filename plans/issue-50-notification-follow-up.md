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
