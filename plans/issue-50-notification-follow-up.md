# Issue #50 Notification Follow-up Plan

## Goal
Resolve the remaining Issue #50 notification leaks reported from `1.3.1-beta.14`, based on the 2026-05-06 issue comment and attached debug bundle.

The specific reported failure is two back-to-back notifications after the reporter had been away from the computer:
1. a group admin/management notification leak; and
2. a Facebook social activity notification, `someone liked your answer to their question`, associated with the same group.

## Current Understanding
- Issue #50 has already gone through several beta fixes:
  - incoming-call first-toast and duplicate-reminder fixes;
  - post-call history suppression;
  - muted-group placeholder/race suppression;
  - service-worker/browser-originated notification suppression for group/admin, global activity, and call history payloads.
- The new debug bundle is from `1.3.1-beta.14` on macOS with notification debug logging enabled.
- Local analysis copy: `/tmp/issue50-logs/2026-05-06/extracted/messenger-debug-logs-2026-05-06T03-29-00-741Z/`.
- The bundle shows:
  - app version `1.3.1-beta.14`;
  - notification permission checks for Facebook notifications denied with `browser-notifications-disabled`;
  - only three app-displayed notifications in `notification-debug.ndjson`, all ordinary direct-message bridge notifications from an unmuted direct thread;
  - no `show-notification-request`, `show-notification-classified`, `show-notification-displayed`, `Native notification ...`, or `Service worker notification candidate analysis` events matching the two reported leaks near the wake/export window;
  - a wake/unlock sequence at about `2026-05-06T03:23Z`, followed by settling suppression and badge recount events, but no captured leaked notification payload;
  - the current route at export remained an E2EE direct message thread, not the affected group thread.
- Therefore, the latest bundle does **not** prove a normal bridge/native/service-worker display-boundary miss. It points to one of these remaining possibilities:
  1. a notification source still not instrumented by the app;
  2. macOS re-presenting already-delivered notifications after wake/unlock;
  3. a Chromium/Electron notification path outside the page-level `Notification` constructor and the page-level `ServiceWorkerRegistration.showNotification` wrapper;
  4. a policy false-negative if the actual payload title/body was group-scoped rather than Facebook-shell-scoped.

## Clarifying Questions and Answers
None; enough context was provided in the initial request and the issue/debug bundle are available for read-only review.

## Constraints and Non-Goals
- Do not implement until this plan is approved.
- Preserve ordinary message notifications, including unmuted direct and group messages.
- Avoid broad text suppression that could drop real message bodies containing words like `liked your answer` in normal conversation.
- Do not rely on people's real names in public-facing notes, changelog entries, or release notes.
- Keep changes conservative and evidence-driven; this is a beta follow-up for a rare leak after previous notification-policy fixes.
- Stable release actions are out of scope for this plan.

## Assumptions
- The reported group/admin leak and the `liked your answer` leak occurred close to the export time, after a wake/unlock or away-from-computer interval.
- The reporter was running `1.3.1-beta.14` for this bundle.
- If the app had created the leaked notifications through the current bridge/native display boundary, `notification-debug.ndjson` should contain display or suppression events for them.
- The `liked your answer to their question` activity is a non-message Facebook/group social activity and should be suppressed for this desktop Messenger wrapper.
- macOS delivered-notification re-presentation is plausible enough to guard against because the bundle shows no app display event for the leak.

## Likely Files / Areas
- `src/main/main.ts`
  - notification permission handlers;
  - power/wake/unlock handling;
  - notification debug export and logging;
  - any session-level notification/service-worker instrumentation available in Electron 28.
- `src/main/notification-handler.ts`
  - active notification tracking;
  - macOS notification `id`/`groupId` use;
  - close/cleanup behavior on wake/focus/export paths.
- `src/shared/notification-activity-policy.ts`
  - group-management and global/social activity classifiers.
- `src/preload/notification-decision-policy.ts`
  - browser/native activity suppression decisions;
  - source-aware suppression helper behavior.
- `src/preload/notifications-inject.ts`
  - page-level `Notification` interception;
  - service-worker diagnostics wrapper;
  - wake-boundary/settling diagnostic logging.
- `scripts/test-issues-regressions.ts`
  - deterministic regression coverage for the new social/group activity phrases and notification cleanup behavior.
- `scripts/test-notification*.ts` / notification test scripts if present and relevant.

## Implementation Strategy
1. Reproduce the log conclusion in a small internal analysis note or comments for the implementation pass:
   - app-displayed notification count is ordinary direct-message-only;
   - no captured leaked payload near wake/export;
   - browser notification permission is denied;
   - wake/unlock path occurs shortly before export.
2. Add a conservative group/social activity classifier extension:
   - classify `liked your answer to their question` and close variants as suppressible Facebook/group social activity;
   - prefer source-aware suppression so ordinary message text is not blocked merely because a human wrote similar words;
   - keep final display-boundary suppression conservative unless the payload clearly looks like Facebook activity rather than a chat message.
3. Harden notification lifecycle cleanup around away/wake scenarios:
   - assign stable macOS notification identifiers/group identifiers for app-created notifications where useful;
   - close tracked non-call notifications on wake/unlock/focus when they are no longer fresh, especially while starting a wake-settling window;
   - ensure cleanup is logged so a future bundle can distinguish app cleanup from non-app OS re-presentation.
4. Broaden instrumentation for currently invisible paths:
   - add explicit logs when wake/unlock cleanup runs and how many active notifications are closed;
   - log notification `show`, `failed`, `close`, `click`, and `action` events from `NotificationHandler` with redacted/minimal payload metadata;
   - investigate Electron 28 session/service-worker APIs for any main-process notification presentation hooks or service-worker lifecycle events that can prove whether Chromium is displaying notifications outside the page wrappers;
   - if no hook exists, record that explicitly in debug logs at startup.
5. Add regression coverage before changing behavior:
   - classifier tests for group admin and `liked your answer to their question` style activity;
   - false-positive tests showing ordinary direct/group message notifications still pass;
   - wake cleanup tests around active notification tracking;
   - debug logging tests where feasible.
6. Run deterministic validation and then prepare a beta release if the user asks to proceed through release steps after implementation.

## Subagent Handoff Plan
- `scout` / `context-builder`:
  - verify the exact Issue #50 timeline and inspect the 2026-05-06 bundle;
  - identify Electron 28 APIs available for session/service-worker notification instrumentation and notification lifecycle cleanup.
- `worker` slice 1:
  - implement source-aware classifier changes for group/social activity suppression with tests.
- `worker` slice 2:
  - implement notification lifecycle cleanup/logging around wake/unlock/focus and `NotificationHandler` events.
- `worker` slice 3, only if supported by Electron 28:
  - add main-process session/service-worker notification instrumentation not covered by page wrappers.
- `reviewer`:
  - review the diff for false positives that would suppress real chat messages;
  - run relevant tests and inspect logs emitted by synthetic notification paths.
- `oracle`, if needed:
  - decide between aggressive suppression and diagnostics-only behavior if Electron/macOS does not expose the invisible notification source.

## Acceptance Criteria
- The reported `someone liked your answer to their question` activity is classified/suppressed when it appears as Facebook/group activity.
- Group admin/management notifications remain suppressed at every app-controlled notification boundary.
- Ordinary direct messages and unmuted group messages still notify.
- Muted group placeholder/race suppression remains intact.
- Post-call history/status suppression remains intact.
- Wake/unlock/focus cleanup prevents app-tracked stale notifications from being re-shown where Electron supports it.
- A future debug bundle will clearly show one of:
  - the leaked notification was suppressed;
  - the app closed/cleaned an old delivered notification;
  - the notification came from a still-uncontrolled OS/browser path, with enough diagnostics to identify that gap.

## Verification Checklist
- [x] Run `npm run test:issues`.
- [x] Run `npm run test:notification` if present/available.
- [x] Run `npm run build`.
- [x] Manually inspect the new tests for false-positive coverage around real chat messages.
- [x] If implementing wake cleanup, run or add a focused smoke test proving tracked stale notifications are closed on wake/unlock cleanup while fresh message and incoming-call notifications are preserved.
- [x] Before any beta release, update `CHANGELOG.md` and `package.json` for the target beta version.
- [x] For a beta release, confirm the release notes avoid real names and summarize the 2026-05-06 bundle finding without exposing private thread/message content.

## Progress Log
- 2026-05-06: Read Issue #50 comments via `gh issue view` and downloaded/extracted `messenger-debug-logs-2026-05-06T03-29-00-741Z.zip`.
- 2026-05-06: Reviewed `debug-summary.json` and `notification-debug.ndjson`. Found no app-controlled display event for the two reported leaks; only ordinary direct-message bridge notifications were displayed in the captured notification log.
- 2026-05-06: Updated this durable plan with the new root-cause direction: combine conservative social/group classifier coverage with wake notification cleanup and broader invisible-path diagnostics.
- 2026-05-06: Implemented source/title-scoped browser activity suppression for `Someone liked your answer to their question` style Facebook/group activity, with explicit false-positive tests for sender-titled chat text.
- 2026-05-06: Implemented app-created notification lifecycle tracking, stale wake/unlock cleanup, notification lifecycle logging, and service-worker/browser notification instrumentation availability diagnostics.
- 2026-05-06: Reviewer caught two issues during execution: overly broad non-shell phrase suppression and too-broad wake cleanup. Both were narrowed before validation.
- 2026-05-06: Validation passed: `npm run test:issues`, `npm run test:notification`, and `npm run build`.
- 2026-05-06: Prepared `1.3.1-beta.15` release metadata in `package.json`, `package-lock.json`, and `CHANGELOG.md`, then reran `npm run test:issues`, `npm run test:notification`, and `npm run build` successfully.
- 2026-05-06: Committed and pushed `fix: harden notification activity leaks (#50)`, ran `./scripts/release.sh 1.3.1-beta.15`, and monitored the Build and Release workflow to success.
- 2026-05-06: Manually ran the Snap Promotion Check workflow. It completed successfully; no promotion occurred because the Snap store edge channel still reported `1.3.1-beta.14` at check time, so the scheduled six-hour workflow should pick up `1.3.1-beta.15` after Snapcraft/Launchpad publishes it to edge.
- 2026-05-06: Posted a concise Issue #50 follow-up comment noting that `1.3.1-beta.15` is built and asking for a fresh bundle if any group/admin or group activity notification leaks again.

## Final Status
Implemented, locally validated, released as `1.3.1-beta.15`, and monitored to successful CI completion.

## Files Changed
- `src/preload/notification-decision-policy.ts`
- `src/main/notification-handler.ts`
- `src/main/main.ts`
- `scripts/test-issues-regressions.ts`
- `CHANGELOG.md`
- `package.json`
- `package-lock.json`
- `plans/issue-50-notification-follow-up.md`

## Tests Run
- `npm run test:issues` — passed.
- `npm run test:notification` — passed.
- `npm run build` — passed.

## Remaining Risks
- The beta.14 bundle still did not capture an app-controlled display event for the reported leaks, so the fix combines conservative suppression for the proven activity phrase with diagnostics/cleanup for possible invisible OS/browser paths.
- Electron 28 does not expose a main-process service-worker notification presentation payload hook; diagnostics record available hooks and service-worker running-status changes, but payload capture still depends on permission/page-wrapper paths.
- Stale-notification cleanup can only close notifications still tracked by this app process.

## Follow-up Recommendations
- If preparing a beta, update `CHANGELOG.md` and `package.json`, then release a beta only after confirming release notes avoid real names/private thread content.
- Ask the reporter for a fresh beta bundle if any group/admin or answer-like activity notification leaks again; the new diagnostics should make the remaining path clearer.

## Open Decisions
- Whether to ship the next fix as another beta immediately after release prep or first ask the reporter for one more diagnostics-only bundle. Current implementation is ready for beta validation if desired.
