# Changelog

## [1.3.1-beta.8] - 2026-04-16

### Fixed

- **Marketplace threads should no longer trigger ghost incoming-call notifications**
  - Tighten incoming-call button matching so generic Marketplace `Accept` / `Decline` style actions and broad `data-testid*="call"` matches no longer escalate into high-confidence incoming-call popups.
  - Stop treating overlapping `Join call` selectors as both the accept and join side of an explicit call-control pair, which could previously promote a stale Marketplace/thread action into a fake incoming call.
  - Keep real call detection working by still accepting explicit decline+answer or decline+join call control pairs, while adding deterministic coverage for the Marketplace-style false-positive shape.

### Validation

- `npm run test:issues`
- `npm run build`

## [1.3.1-beta.7] - 2026-04-16

### Added

- **Extra debug provenance for unexpected refresh/reload reports**
  - Record explicit app-owned reload requests, suppression decisions, offline-page reroutes, renderer-recovery dialog responses, and app-triggered `loadURL(...)` requests in a new bundled `reload-debug.ndjson` log.
  - Capture main-frame navigation lifecycle events such as `will-navigate`, `did-start-navigation`, `did-redirect-navigation`, `did-navigate`, and `did-navigate-in-page` for the main Messenger surfaces and child windows so future bundles can distinguish page-driven reboots from app-owned reload paths.
  - Include the new reload/navigation trace in exported debug bundles and `debug-summary.json` so future reports can show who initiated a refresh and what URL transition actually happened.

### Fixed

- **Exported debug bundles now preserve reload/navigation evidence across app-owned fallback paths**
  - Log session-start routing, login/homepage redirects, reset/logout reloads, and offline fallback loads through the same provenance-aware helper so those app-owned navigations are visible in future bundles instead of only appearing as a final URL change.

### Validation

- `npm run build`
- `npm run test:issues`
- `npm run test:reload-policy`
- `npm run test:release`

## [1.3.1-beta.6] - 2026-04-15

### Fixed

- **Issue #49 follow-up: fail closed for muted reply-style leaks that arrive as generic `New message` notifications** ([#49](https://github.com/apotenza92/facebook-messenger-desktop/issues/49))
  - Treat reply-style notification payloads that carry the actual preview in the title while the body collapses to generic `New message` text as ambiguous whenever a muted unread group row still overlaps that preview.
  - Keep normal direct-message delivery intact when the same preview only overlaps unmuted candidates, so the new guard targets muted leaks without broadly suppressing legitimate notifications.
  - Extend the deterministic and offline Issue #49 coverage for the reported muted group reply leak shape.

### Validation

- `npm run test:release`
- `npm run test:issues`
- `npm run test:issue49:offline`
- `npm run build`

## [1.3.1-beta.5] - 2026-04-15

### Fixed

- **Issue #49 follow-up: keep Marketplace re-entry alive after multiple ordinary-chat detours** ([#49](https://github.com/apotenza92/facebook-messenger-desktop/issues/49))
  - Retain a short-lived recent Marketplace continuity snapshot even after the active Marketplace session has already cleared, so a later Marketplace re-entry can still recover the native back/header treatment when Facebook first re-renders only a right-pane Marketplace action or a weak matching header.
  - Keep the detached continuity bridge time-bounded and require corroborating Marketplace evidence, so ordinary chats and generic Marketplace item-link noise still fail closed.
  - Extend the deterministic and offline Issue #49 coverage for the reported multi-chat detour sequence, including detached recent-continuity bridging, stale expiry, and ordinary-chat rejection.

### Validation

- `npm run test:release`
- `npm run test:issues`
- `npm run test:issue49:offline`
- `npm run build`

## [1.3.1-beta.4] - 2026-04-14

### Fixed

- **Issue #49 follow-up: keep weak Marketplace continuity alive later in a session and tighten wake-boundary replay diagnostics** ([#49](https://github.com/apotenza92/facebook-messenger-desktop/issues/49))
  - Bridge recent `weak-bootstrap` Marketplace sessions across route changes when the next route again exposes a corroborating right-pane Marketplace action, so the native Marketplace back/header treatment is less likely to drop out after sleep, reconnect churn, or longer-running sessions that no longer re-render the full strong header in time.
  - Keep the weak-continuity bridge fail-closed for stale sessions and generic Marketplace item-link noise, and add explicit debug provenance for when weak-bootstrap route-change bridging was allowed, blocked, or used.
  - Record wake-generation snapshot state for existing unread rows and log when native or mutation-driven notifications are suppressed as pre-existing wake/online-recovery replays, making future approval/admin bundles much more conclusive if anything still slips through.
  - Extend the deterministic and offline Issue #49 coverage for weak-bootstrap route-change continuity plus `online-recovery` stale admin replay suppression.

### Validation

- `npm run test:issues`
- `npm run test:issue49:offline`
- `npm run build`

## [1.3.1-beta.3] - 2026-04-13

### Fixed

- **Issue #49 follow-up: rescue delayed Marketplace re-entry headers after route change and harden wake/resume approval-notification suppression** ([#49](https://github.com/apotenza92/facebook-messenger-desktop/issues/49))
  - Keep a recently confirmed Marketplace thread in a short route-change rescue state when the next route first looks ordinary, so delayed weak Marketplace headers can still recover the native back/header treatment instead of clearing too early.
  - Tighten the Marketplace regression coverage around the latest `1.3.1-beta.2` reporter timeline, including fixture-driven replays and an offline DOM harness that simulates the delayed weak-header sequence without needing a signed-in Facebook session.
  - Snapshot fresh unread rows across wake/resume-style settling boundaries and suppress replayed approval/admin activity more aggressively so stale group-management rows are less likely to leak through as fresh desktop notifications after sleep or reconnect recovery.
  - Add fixture-driven notification wake/replay coverage and an offline DOM harness for stale approval/admin replay versus real fresh direct messages after wake.

### Validation

- `npm run test:issues`
- `npm run test:issue49:offline`
- `npm run build`
- `npm start` (launch smoke in dev mode)

## [1.3.1-beta.2] - 2026-04-13

### Fixed

- **Issue #49 follow-up: keep Marketplace re-entry alive through weak route-change bootstrap and stop emoji-only notification title suffixes** ([#49](https://github.com/apotenza92/facebook-messenger-desktop/issues/49))
  - Keep a recently confirmed Marketplace thread bridged across a route change when the next thread first reappears only as a pending weak Marketplace bootstrap, instead of clearing the Marketplace session before the new route has time to settle.
  - Extend the deterministic Marketplace coverage to include pending route-change bootstrap bridging, stale pending-bootstrap expiry, and the weak-bootstrap caller-side transition rules used by preload.
  - Filter emoji-only and decorative alternate names out of notification title formatting, scrub previously cached invalid alternate names on load, and keep valid nickname/real-name suffixes intact.
  - Add deterministic coverage for notification alternate-name filtering plus legacy cache cleanup so the stray emoji suffix replay is guarded going forward.

### Validation

- `npm run test:issues`
- `npm run build`
- `npm start` (launch smoke in dev mode)

## [1.3.1-beta.1] - 2026-04-12

### Fixed

- **Issue #49 follow-up: bridge Marketplace route handoffs when the next thread starts as a weak header-only render** ([#49](https://github.com/apotenza92/facebook-messenger-desktop/issues/49))
  - Keep the previous Marketplace visual session alive long enough for route-change policy to inspect the next thread instead of clearing it immediately when the URL changes.
  - Bridge directly into the next route when it appears straight after a confirmed Marketplace thread and the new top-left `Marketplace` header band still matches the previous Marketplace header region, even if Facebook has not rendered the native back control yet.
  - Add deterministic coverage for this route-handoff replay and new debug signal tags so future bundles show whether a weak next-route Marketplace header was accepted or rejected during the handoff.

### Validation

- `npm run test:issues`
- `npm run build`

## [1.3.0] - 2026-04-11

### Changed

- **Facebook Messages migration and desktop shell refresh** ([#41](https://github.com/apotenza92/facebook-messenger-desktop/issues/41))
  - Moved the app onto Facebook's current `facebook.com/messages` surface and rebuilt the top-chrome cleanup around a BrowserView crop plus native window chrome, which removes the old bottom gutter and reduces header flicker during normal chat use.
  - Restored the native title bar approach on macOS and removed the injected Facebook/login warning banner.

### Fixed

- **Media, routing, and thread-surface reliability** ([#41](https://github.com/apotenza92/facebook-messenger-desktop/issues/41), [#45](https://github.com/apotenza92/facebook-messenger-desktop/issues/45))
  - Restored non-E2EE and E2EE media viewer controls, close-return behaviour, and download handling on Facebook's newer viewer shells.
  - Fixed wrapped link and profile routing so Messenger threads stay in-app while profile and broader Facebook navigation still go out to the system browser when appropriate.
  - Hardened refresh and recovery behaviour so the app reliably returns to the intended Messages surface after media, profile, or reconnect churn.
- **Incoming-call handling and notification filtering** ([#46](https://github.com/apotenza92/facebook-messenger-desktop/issues/46), [#47](https://github.com/apotenza92/facebook-messenger-desktop/issues/47), [#49](https://github.com/apotenza92/facebook-messenger-desktop/issues/49))
  - Reworked incoming-call detection, overlay persistence, popup lifecycle, and notification dedupe so stale call-like states and duplicate reminders are much less likely after reflow, sleep/wake, or repeated ringing.
  - Tightened muted-chat, self-authored, and non-message Facebook activity suppression, including group join/request variants that could previously leak through as native popups.
  - Added bundled debug-log export for notification, incoming-call, layout/media, and renderer-failure traces to make follow-up reports far more actionable.
- **Composer and keyboard ergonomics**
  - Restored and hardened the injected shortcut layer, including quick switcher, help, next/previous chat, and number-based navigation bindings.
  - Kept emoji, sticker, and GIF composer overlays responsive without letting Facebook chrome leak back into view during normal chat use.
- **Marketplace messaging and thread layout hardening** ([#49](https://github.com/apotenza92/facebook-messenger-desktop/issues/49))
  - Kept Marketplace Inbox, Buying, and Selling messaging surfaces in-app while continuing to open broader Marketplace browsing externally.
  - Rebuilt Marketplace thread handling around route-scoped session rules, same-route rerender bridging, stronger ordinary-chat clear guards, and richer privacy-safe debug provenance.
  - Further hardened Marketplace header detection for fresh-route split `Back` plus `Marketplace` variants so the native back button and reduced top crop are more likely to stay stable on the reported thread flow.

### Validation

- `npm run test:issues`
- `npm run test:release`
- `npm run build`

## [1.3.0-beta.54] - 2026-04-10

### Fixed

- **Issue #49 follow-up: keep recently confirmed Marketplace threads alive through same-route header collapse** ([#49](https://github.com/apotenza92/facebook-messenger-desktop/issues/49))
  - Sustain a same-route Marketplace session when Facebook briefly rerenders the confirmed thread down to a back-button anchor without the visible `Marketplace` label, instead of treating that immediate rerender as ordinary-chat evidence.
  - Record Marketplace confirmation provenance plus post-confirmation grace, back-anchor matching, and ordinary-clear block reasons in the debug logs so future bundles show exactly why a same-route session stayed bridged or started clearing.
  - Extend the deterministic Marketplace regressions to cover the chat-detour re-entry flow, back-anchor continuity, weak-bootstrap provenance, and slightly shifted same-route header-band matching.

### Validation

- `npm run test:issues`
- `npm run test:release`
- `npm run build`

## [1.3.0-beta.53] - 2026-04-09

### Fixed

- **Issue #49 follow-up: delay weak Marketplace route handoff confirmation until the route has actually settled** ([#49](https://github.com/apotenza92/facebook-messenger-desktop/issues/49))
  - Keep fresh-route weak Marketplace signals in a pending state until the same route has stayed stable for repeated scans long enough to rule out the immediate handoff churn that was still promoting the Marketplace reduced-crop session too early.
  - Add weak-bootstrap age and confirmation-eligibility debug fields to Marketplace logging, so future bundles show whether a route was still settling or had genuinely matured enough to confirm.

### Validation

- `npm run test:issues`
- `npm run test:release`
- `npm run build`

## [1.3.0-beta.52] - 2026-04-09

### Fixed

- **Issue #49 follow-up: defer same-route Marketplace clears and expand muted-notification diagnostics** ([#49](https://github.com/apotenza92/facebook-messenger-desktop/issues/49))
  - Keep a confirmed Marketplace session alive through brief same-route ordinary-chat rerenders until the ordinary-only state has repeated long enough to be trusted, so the Marketplace back button and reduced crop do not drop out after a valid confirmation.
  - Record when an ordinary-only clear is pending versus actually applied, including the last Marketplace match age and corroboration count, so future debug bundles can pinpoint why a Marketplace session stayed or cleared.
  - Attach structured candidate-ranking provenance to mutation notification decisions and keep a larger recent notification log window in exported debug bundles, so intermittent muted-group leaks are easier to trace even when the export is taken a few seconds late.

### Validation

- `npm run test:issues`
- `npm run test:release`
- `npm run build`

## [1.3.0-beta.51] - 2026-04-08

### Fixed

- **Issue #49 follow-up: block weak Marketplace startup bootstraps, tighten group-management notification suppression, and stabilise incoming-call caller reuse** ([#49](https://github.com/apotenza92/facebook-messenger-desktop/issues/49))
  - Confirm Marketplace mode immediately only from the native `Back + Marketplace` thread header, and require settled repeated same-route weak evidence before a fresh route can enter the Marketplace reduced-crop path.
  - Keep weak Marketplace signals scoped to previously confirmed routes so ordinary chats cannot inherit Marketplace session state from earlier thread renders.
  - Expand shared Facebook activity suppression for join-request, participation-request, and membership-request notifications, including person-titled variants that reach the main process.
  - Reuse the active caller identity for placeholder incoming-call echoes and suppress duplicate anonymous follow-up toasts within the same ringing session.

### Validation

- `npm run build`
- `npm run test:issues`
- `npm run test:release`

## [1.3.0-beta.50] - 2026-04-08

### Fixed

- **Keyboard shortcuts: restore the injected shortcut layer and harden navigation bindings**
  - Isolate injected page scripts so a helper-policy script cannot abort the main Messenger page injection path and silently disable keyboard shortcuts.
  - Match `Cmd/Ctrl+/`, `Cmd/Ctrl+O`, `Cmd/Ctrl+1-9`, and `Cmd/Ctrl+Shift+[ / ]` by `KeyboardEvent.code` with sensible `key` fallbacks, so symbol shortcuts keep working across keyboard layouts.
  - De-duplicate visible sidebar thread rows and add active-row fallbacks so next/previous chat navigation moves to a different visible thread instead of getting stuck on duplicate rows.
- **Shortcut smoke coverage: align automated tests with the live bindings**
  - Update the regression script to validate `Cmd/Ctrl+O` as the canonical quick switcher shortcut, use layout-safe slash events for the help overlay, and assert that next-chat navigation leaves the current visible thread.

### Validation

- `npm run build`
- `node scripts/test-keyboard-shortcuts.js`

## [1.3.0-beta.49] - 2026-04-08

### Fixed

- **Issue #49 follow-up: replace time-limited Marketplace and notification fallbacks with persistent session rules** ([#49](https://github.com/apotenza92/facebook-messenger-desktop/issues/49))
  - Keep Marketplace thread state alive per thread route until there is positive evidence that the user has left that Marketplace thread or the view has explicitly become an ordinary chat, instead of letting the reduced-crop path expire after repeated rerenders or idle gaps.
  - Treat repeated same-thread weak or missing Marketplace rerenders as neutral refreshes, so the native Marketplace back button does not disappear again on later re-entry attempts.
  - Track incoming-call notifications by a stable call or thread session key, reject placeholder caller artefacts before display, and stop re-showing a second native alert when caller metadata improves mid-ring.
  - Move non-message Facebook activity suppression onto the shared final notification display path and add explicit debug events for notifications that were actually displayed or suppressed.

### Validation

- `npm run build`
- `npm run test:issues`
- `npm run test:release`
- Live GUI validation pending beta feedback

## [1.3.0-beta.48] - 2026-04-06

### Fixed

- **Issue #49 follow-up: restore the normal chat top crop to the intended 56px baseline** ([#49](https://github.com/apotenza92/facebook-messenger-desktop/issues/49))
  - Correct the ordinary-chat BrowserView crop floor so regular threads stop sitting a few pixels too low after the Facebook top chrome is removed.
  - Keep the Marketplace route-scoped session behaviour unchanged, so the Marketplace back-button and reduced-crop fixes continue to use their separate reduced crop path.

### Validation

- `npm run build`
- `npm run test:issues`
- Live BrowserView verification confirmed the ordinary chat crop moved from `48px` back to `56px`

## [1.3.0-beta.47] - 2026-04-06

### Fixed

- **Issue #49 follow-up: replace Marketplace crop carry-over with a route-scoped Marketplace session** ([#49](https://github.com/apotenza92/facebook-messenger-desktop/issues/49))
  - Confirm Marketplace mode only from strong in-thread evidence, then keep it alive across weak same-route rerenders only when the `Marketplace` header still matches the previously confirmed header band.
  - Reject stray top-left `Marketplace` labels on ordinary chats instead of letting them refresh Marketplace state, so post-Marketplace spacing drift and delayed re-entry failures are much less likely to recur.
  - Add privacy-safe Marketplace debug provenance and deterministic session-sequence coverage for repeated re-entry, same-route DOM churn, mismatched weak headers, and immediate route-change clears.

### Changed

- **Issue-specific validation**
  - Narrow `npm run test:issues` to the deterministic issue regression suite for this Marketplace work, while keeping the older window-open GUI script available separately as `npm run test:window-open:gui`.

### Validation

- `npm run build`
- `npm run test:issues`
- `npm run test:release`

## [1.3.0-beta.46] - 2026-04-06

### Fixed

- **Issue #49 follow-up: renew Marketplace crop carry-over across repeated same-route re-entry rerenders** ([#49](https://github.com/apotenza92/facebook-messenger-desktop/issues/49))
  - Refresh the confirmed Marketplace crop window when Facebook rerenders the same thread into a weaker Marketplace-only header, so the native back button and reduced top crop stay stable beyond the second re-entry.
  - Keep fully signal-free bridge states temporary only, so ordinary chats still cannot inherit a self-renewing Marketplace crop from a stray `Marketplace` label.
  - Add deterministic sequence coverage for the reported third/fourth Marketplace re-entry repro on the same route, including route-scoped carry-over guards.

### Validation

- `npm run build`
- `npm run test:issues`

## [1.3.0-beta.45] - 2026-04-03

### Fixed

- **Issue #49 follow-up: extend Marketplace crop carry-over across weaker same-route rerenders and add a main-process notification safety net** ([#49](https://github.com/apotenza92/facebook-messenger-desktop/issues/49))
  - Keep a confirmed Marketplace thread crop alive longer on the same thread route so brief Facebook rerenders that temporarily drop Marketplace header signals do not immediately hide the back button again or re-enable the wrong top-bar suppression path.
  - Add a main-process fallback suppression check for obvious non-message Facebook activity payloads such as join-request / participation-request notifications, so those can still be blocked even if they reach Electron outside the usual preload classification path.
  - Record main-process `show-notification` requests and suppressions in the notification debug log so any remaining leaks are easier to trace.

### Validation

- `npm run build`
- `npm run test:issues`
- `npm run test:window-open`

## [1.3.0-beta.44] - 2026-04-03

### Fixed

- **Issue #49 follow-up: keep Marketplace thread crop stable across same-route re-entry rerenders** ([#49](https://github.com/apotenza92/facebook-messenger-desktop/issues/49))
  - Keep the reduced Marketplace visual crop alive briefly on the same thread route after a confirmed `Back + Marketplace` detection, even if Facebook rerenders into a weaker Marketplace-only header state.
  - Prevent those weak same-route rerenders from dropping back into the normal chat header-suppression path, which could hide the Marketplace back button again or let the top bar reappear.

### Validation

- `npm run build`
- `npm run test:issues`
- `npm run test:window-open`

## [1.3.0-beta.43] - 2026-04-02

### Fixed

- **Issue #49 follow-up: harden muted media/link notification suppression and generic Facebook notification filtering** ([#49](https://github.com/apotenza92/facebook-messenger-desktop/issues/49))
  - Fail closed when terse sender-style notifications like `sent a photo.` or `shared a link.` could belong to either an unmuted direct thread or a muted group.
  - Tighten notification target scoring so person-title Facebook activity payloads do not match chat rows unless the body actually corroborates the unread conversation preview.
  - Expand non-message Facebook activity suppression for request/join/participation notification variants.

### Changed

- **Beta debug-log capture and export overhaul**
  - Beta builds now capture notification, incoming-call, and layout/media debug logs by default, while stable builds keep those logs off unless explicitly enabled.
  - Replaced the old layout-only Help export path with `Help -> Export Debug Logs…`, bundling notification, incoming-call, layout/media, and renderer-failure logs together with a summary report.
  - Added summarized raw `NotificationOptions` capture for intercepted web notifications so follow-up reports can reveal whether Facebook is providing structured metadata like `tag`, `data`, `actions`, `image`, or `timestamp`.

### Validation

- `npm run build`
- `npm run test:issues`
- `npm run test:window-open`

## [1.3.0-beta.42] - 2026-04-01

### Fixed

- **Issue #49 follow-up: stop post-Marketplace chat flicker from tripping the same-route media overlay path** ([#49](https://github.com/apotenza92/facebook-messenger-desktop/issues/49))
  - Used the exported layout debug report to confirm the bad loop was no longer stale Marketplace state; the app was wrongly flipping an ordinary `/messages/t/...` chat into media mode when Facebook rendered a `Back` control, a `Share` control, and a large preview card together.
  - Tightened same-route media overlay detection so those ordinary chat controls no longer disable header suppression or send regular chat clicks down the external-browser path.
  - Kept the stronger Marketplace crop carry-over guard so generic top-chrome `Marketplace` or `Back` labels still cannot refresh the Marketplace layout heuristic on ordinary chats.

### Validation

- `npm run build`
- `npm run test:issues:deterministic`
- `npm run test:window-open`

## [1.3.0-beta.41] - 2026-03-31

### Fixed

- **Issue #49 follow-up: stop generic Facebook top-bar flicker from tripping the Marketplace layout path** ([#49](https://github.com/apotenza92/facebook-messenger-desktop/issues/49))
  - Tightened Marketplace thread activation so a bare `Marketplace` label in Facebook's own top chrome no longer disables the normal chat crop path by itself.
  - Scoped the temporary Marketplace crop carry-over to the same chat route, reducing cross-chat top-bar flicker while keeping short same-thread Marketplace re-renders stable.

### Validation

- `npm run build`
- `npm run test:issues:deterministic`

## [1.3.0-beta.40] - 2026-03-31

### Fixed

- **Issue #49 follow-up: crop the Facebook top chrome on the native Marketplace thread header variant instead of hiding the wrong in-thread UI** ([#49](https://github.com/apotenza92/facebook-messenger-desktop/issues/49))
  - Detect the same-route Marketplace `Back + Marketplace` thread header and switch that surface to a reduced BrowserView crop so the native back control stays visible while the Facebook top chrome is visually trimmed away.
  - Keep ordinary Messenger chats on the existing header-suppression path and hold the Marketplace crop briefly across Facebook header re-renders so the layout does not flicker between two different shell strategies.

### Validation

- `npm run build`
- `npm run test:issues:deterministic`
- `npm run test:release`
- `npm run test:window-open`

## [1.3.0-beta.39] - 2026-03-30

### Fixed

- **Issue #49 follow-up: harden muted group notification suppression when Messenger mixes real names and nicknames** ([#49](https://github.com/apotenza92/facebook-messenger-desktop/issues/49))
  - Fail closed when a muted group preview points to the same sender activity as a native notification even if Messenger surfaces the sender with a nickname in one place and a real name in another.
  - Expand muted-notification matching to use both rendered sidebar previews and hidden conversation metadata collected from Messenger's accessibility labels, tooltips, and avatar text.

### Changed

- **Notification debug capture for muted-notification follow-up**
  - Persist the existing preload notification debug stream to `notification-debug.ndjson` in the app logs folder so cold-start and refresh-related notification reports can be captured without extra instrumentation.
  - Format notification titles with both the visible Messenger name and known alternate names when that metadata is available, making alias-related notification reports easier to inspect.

### Validation

- `npm run build`
- `npm run test:issues:deterministic`
- `npm run test:release`
- `npm run test:window-open`

## [1.3.0-beta.38] - 2026-03-30

### Fixed

- **Issue #49 follow-up: keep Marketplace thread back controls visible without letting the Facebook top bar leak back in** ([#49](https://github.com/apotenza92/facebook-messenger-desktop/issues/49))
  - Keep same-route Marketplace thread panels on the normal Messages header-suppression path so the Facebook top chrome stays hidden when Marketplace opens inside `/messages/t/...`.
  - Continue disabling the BrowserView crop for those Marketplace thread panels so Facebook's native in-thread `Back + Marketplace` controls remain visible.

### Validation

- `npm run build`
- `npm run test:issues:deterministic`
- `npm run test:window-open`

## [1.3.0-beta.37] - 2026-03-30

### Fixed

- **Issue #49 follow-up: detect the in-thread Marketplace `Back + Marketplace` header variant and stop cropping it** ([#49](https://github.com/apotenza92/facebook-messenger-desktop/issues/49))
  - Expanded same-route Marketplace thread detection beyond the earlier right-pane action buttons so the app also recognizes the native top-left Marketplace header variant that keeps the URL on `/messages/t/...`.
  - When that Marketplace thread header is present, disable the Messenger BrowserView crop so Facebook's own in-thread back button stays visible instead of sliding under the window edge.

### Changed

- **Layout debug capture for Marketplace/thread-shell issues**
  - Added privacy-safe Marketplace thread debug signals to the existing layout debug stream so follow-up reports can confirm whether the app detected Marketplace action hints, the Marketplace header, and the `Back + Marketplace` combination.
  - Renamed the user-facing export action to `Export Layout Debug Report…` so it can be used for Marketplace/layout regressions without referencing issue #45.

### Validation

- `npm run build`
- `npm run test:issues:deterministic`
- `npm run test:window-open`
- `npm run test:release`

## [1.3.0-beta.36] - 2026-03-30

### Fixed

- **Issue #45 follow-up: modern media viewer downloads now use the real Messenger click path** ([#45](https://github.com/apotenza92/facebook-messenger-desktop/issues/45))
  - Keep modern media validation on the real in-thread click flow instead of loading `messenger_media` URLs directly, which was falling back to Facebook's older white-top-bar shell.
  - Intercept visible media download clicks in preload and route Facebook media/blob URLs into Electron's native download pipeline so media downloads work across the current viewer shells without extra top-bar customization.
  - Expand media download URL handling to cover Facebook `blob:` downloads and `fbsbx.com` media hosts.

### Changed

- **Media GUI harness cleanup**
  - Removed the old issue-45 GUI harnesses that were built around the earlier crop/symmetry approach and direct media URL assumptions.
  - Added a focused modern media GUI check that opens media from a real chat click and validates the current download path.
  - Updated the close-return GUI check to open media from thread context by default, with direct URL loading kept only as an explicit fallback mode.

### Validation

- `npm run build`
- `npm run test:issues:deterministic`
- `npm run test:window-open`
- `npm run test:release`
- `node scripts/test-media-click-route-gui.js --source chat --thread-url "https://www.facebook.com/messages/t/8462785550492790/" --click-mode os`
- Real local manual verification in the app that modern media viewer downloads now work

## [1.3.0-beta.35] - 2026-03-29

### Fixed

- **Issue #49 follow-up: keep Marketplace messaging surfaces in-app without reintroducing old Messenger crop hacks** ([#49](https://github.com/apotenza92/facebook-messenger-desktop/issues/49))
  - Keep `Marketplace Inbox`, `Buying`, and `Selling` surfaces inside the app instead of forcing them out to the system browser.
  - Continue opening generic Marketplace browse/listing navigation externally so item pages and broader Marketplace browsing do not take over the app shell.
  - Disable the Messenger BrowserView crop on Marketplace thread surfaces so Facebook's native Marketplace header/actions render without the chat-specific chrome cleanup path interfering.
- **Remove the injected Facebook/login warning banner**
  - Stop inserting the custom "unofficial app" banner on login, verification, and other Facebook intermediate pages.

### Changed

- **Marketplace routing and viewport regression coverage**
  - Added deterministic coverage for the new Marketplace in-app route split and for Marketplace threads opting out of the Messenger crop path.

### Validation

- `npm run build`
- `npm run test:window-open`
- `npm run test:issues:deterministic`
- Real live Marketplace navigation checks for:
  - `https://www.facebook.com/marketplace/inbox`
  - `https://www.facebook.com/marketplace/you`
  - `https://www.facebook.com/marketplace/you/selling`

## [1.3.0-beta.34] - 2026-03-29

### Fixed

- **Issue #41 follow-up: keep emoji overlays fast without leaking Facebook chrome** ([#41](https://github.com/apotenza92/facebook-messenger-desktop/issues/41))
  - Removed the temporary emoji-triggered BrowserView uncrop so opening the emoji picker no longer brings the Facebook top chrome back into view.
  - Fixed the main emoji-picker slowdown by teaching the global call-popup observer to ignore emoji/gif/sticker portal DOM and to stop deep-walking large unrelated subtrees.
  - Kept real emoji insertion working while the normal chat crop stays active, so the picker opens and inserts emoji without exposing the top-left Facebook search strip.

### Changed

- **Emoji GUI regression coverage**
  - Upgraded the live emoji harness to assert picker-open latency, hidden Facebook chrome during picker-open, and real emoji insertion into the composer.

### Validation

- `npm run build`
- `npm run test:issues`
- `npm run test:release`
- `node scripts/test-emoji-composer-gui.js --cycles 5 --max-open-ms 2000`

## [1.3.0-beta.33] - 2026-03-29

### Fixed

- **Issue #41 follow-up: composer overlays and generic notification leak hardening** ([#41](https://github.com/apotenza92/facebook-messenger-desktop/issues/41))
  - Temporarily disable the BrowserView chat crop while emoji/sticker/GIF composer overlays are open so the composer stays responsive instead of freezing behind the cropped messages surface.
  - Harden generic notification suppression for Facebook-shell/social-activity payloads and fail closed more often on generic `Notification`-style titles.
  - Keep the existing `Draft:` self-authored suppression path covered in deterministic regression tests.

### Changed

- **Emoji GUI validation hardening**
  - Updated the emoji composer GUI harness to wait for real Electron windows instead of depending on Playwright's flaky `firstWindow()` event path.

### Validation

- `npm run build`
- `npm run test:issues`
- `node scripts/test-emoji-composer-gui.js --cycles 5`

## [1.3.0-beta.32] - 2026-03-28

### Fixed

- **Issue #41 follow-up: switch `facebook.com/messages` chrome cleanup to a window-level crop** ([#41](https://github.com/apotenza92/facebook-messenger-desktop/issues/41))
  - Moved normal chat top-bar suppression to a BrowserView crop so the hidden Facebook chrome no longer leaves a bottom gutter or flashes back in during scroll/reflow.
  - During unanswered incoming calls, incoming-call hint state now blocks whole-banner suppression so actionable incoming controls stay available while the Facebook bar remains hidden.
  - Hardened call-state parsing around mute/unmute labels so active call controls remain stable under the new crop path.

### Changed

- **Call and media regression validation hardening**
  - Extended live incoming-ring validation to hold for 15 seconds and verify that hidden Facebook chrome does not come back while incoming call actions stay available.
  - Hardened the live call harness around Electron startup/teardown, trusted popup clicks, and repeated mute/unmute cycles so the real-account regression runs are more reliable.
- **Electron runtime update**
  - Updated Electron to `40.8.0`.

### Validation

- `npm run build`
- `npm run test:issues`
- Real two-account live call validation:
  - unanswered incoming ring held for 15 seconds with hidden Facebook chrome and actionable incoming controls still available
  - unanswered outgoing ring
  - answered calls in both directions with 5 mute/unmute cycles and no white-window crash

## [1.3.0-beta.31] - 2026-03-18

### Fixed

- **Issue #41 follow-up: real media/profile regressions for items 1, 2, and 4** ([#41](https://github.com/apotenza92/facebook-messenger-desktop/issues/41))
  - Stop non-E2EE media viewers from stacking overlapping fallback/native buttons and ensure close returns to the originating chat instead of drifting to the newest thread.
  - Restore same-route E2EE media controls on real attachment/photo flows so close, download, and forward buttons appear as a single clean cluster.
  - Route Facebook profile links back out to the system browser again, including wrapped in-thread profile URLs, and make refresh reset stray in-app profile pages back to `facebook.com/messages`.

### Changed

- **Issue #45 regression harness cleanup** ([#45](https://github.com/apotenza92/facebook-messenger-desktop/issues/45))
  - Removed the old synthetic fixture-based GUI scripts and consolidated validation onto real-target discovery/capture flows.
  - Added pinned real GUI checks for the exact non-E2EE close-return path and a real E2EE same-route attachment/photo thread.

### Validation

- `npm run build`
- `npm run test:window-open`
- `npm run test:issues:deterministic`
- `npm run test:issue45:live:types:gui -- --thread-alias non-e2ee-check --thread-url "https://www.facebook.com/messages/t/6860983763931910/" --media-url "https://www.facebook.com/messenger_media/?attachment_id=2647398358969687&message_id=mid.%24gABhgB0QPEwajKarbymc-GWN1MKmF&thread_id=6860983763931910"`
- `npm run test:issue45:e2ee:same-route:current:gui`
- `npm run test:issues:e2e`
- Real direct non-E2EE close-return check on `https://www.facebook.com/messages/t/6860983763931910/` -> `messenger_media` -> close -> same thread restored

## [1.3.0-beta.30] - 2026-03-17

### Fixed

- **Issue #41 follow-up: stop more self-notification and marketplace routing regressions** ([#41](https://github.com/apotenza92/facebook-messenger-desktop/issues/41))
  - Force marketplace links back out to the system browser, including wrapped `facebook.com/messages/...?...u=...marketplace...` routes and same-frame link clicks that Facebook tries to keep inside the app.
  - Broaden self-authored notification suppression so outgoing `You:` previews and similar website-side self-message variants do not generate native desktop notifications.
  - Added a browser-assisted non-E2EE regression retest with zero leaked self-notifications during a real same-account website send.
- **Muted notification matching hardening**
  - Keep fail-closed behavior when notification text could belong to a muted group instead of an unmuted direct thread, reducing the chance of muted chat leaks.
  - Expand muted sidebar detection across newer icon and accessibility-label variants.

### Changed

- **Issue #45 evidence and regression tooling cleanup** ([#45](https://github.com/apotenza92/facebook-messenger-desktop/issues/45))
  - Consolidated overlapping real-media GUI scripts into the maintained resize/live-type harnesses and documented the remaining evidence flow.
  - Restored GUI routing coverage around marketplace external-open handling and added focused helpers for self-notification capture during live verification.

### Validation

- `npm run build`
- `npm run test:issues:deterministic`
- `npm run test:window-open`
- `node scripts/test-window-open-gui.js`
- Real browser-assisted non-E2EE self-message retest on a `/messages/t/...` thread with zero captured desktop notifications

## [1.3.0-beta.29] - 2026-03-13

### Fixed

- **Issue #41 follow-up: real incoming-call answer UI + notification dedupe** ([#41](https://github.com/apotenza92/facebook-messenger-desktop/issues/41))
  - Recognize Facebook's plain `Accept` incoming-call control so the clean incoming-call overlay state applies on the real answered-call UI and the Facebook top bar stays hidden.
  - Suppress the duplicate no-key incoming-call notification echo that could fire immediately after answering.
  - Hardened the live call harness so answered-call validation survives destroyed popup windows and asserts notification count during ring + answer.
- **Issue #45 follow-up: photo/media close recovery no longer sticks the main window in media mode**
  - Stop chat threads with large inline media and share controls from being misclassified as an active media viewer after closing a photo.
  - Clear the temporary media-open hint immediately on dismiss and URL transitions so BrowserView crop recovery happens promptly instead of waiting out the hint window.
  - Added deterministic and GUI regression coverage for the stuck `mediaClean` recovery path.

### Validation

- `npm run build`
- `npm run test:issues`
- `npm run test:issue45:close:return:gui`
- `npm run test:issue45:thread:extensive:gui`
- Real two-account live call validation:
  - Michael -> Alex answer/hangup with clean incoming overlay and exactly one incoming-call notification
  - Alex -> Michael answer/hangup
  - incoming/outgoing ring flows

## [1.3.0-beta.28] - 2026-03-13

### Fixed

- **Issue #41 follow-up: tighten stale incoming-call recovery and overlay activation rules** ([#41](https://github.com/apotenza92/facebook-messenger-desktop/issues/41))
  - Stop status text like `Video call has started` and `Join the video call` from being classified as new incoming calls.
  - Prevent soft/background evidence from activating the incoming-call overlay hint unless explicit incoming-call UI is actually visible.
  - Treat periodic scans that find visible incoming-call controls as explicit DOM evidence instead of weaker background evidence.
  - Centralize incoming-call window focus behavior and expand deterministic regression coverage for the stale/false-positive cases.
- **Photo viewer loading polish**
  - Keep the Facebook top banner hidden only during the bounded media-loading window and stop suppression as soon as marked close/download/share controls appear, preventing navigation controls from disappearing after the viewer UI mounts.

### Validation

- `npm run test:issues:deterministic`
- `npm run build`

## [1.3.0-beta.27] - 2026-03-12

### Fixed

- **Photo viewer: hide Facebook top bar earlier while photos are still loading**
  - Added an in-thread media-open hint so photo/video opens from conversation media panels are treated as active overlays before Facebook finishes mounting the full media control set.
  - Hide Facebook's top banner chrome during that early loading window, instead of waiting for the later download/share controls to appear.
  - Keep the normal loaded-state behavior unchanged once the real media controls mount.

### Validation

- `NODE_OPTIONS=--max-old-space-size=4096 npm run build`
- Real live validation on the `JLew` thread:
  - reproduced the transient top-bar flash on the pre-fix build by opening `Media -> View photo sent on 24 February 2026, 14:46` under throttled network
  - verified the beta.27 build hides the Facebook top bar within ~200ms of the same real photo-open flow and keeps media controls visible once loading completes

## [1.3.0-beta.26] - 2026-03-10

### Changed

- **Issue #47 follow-up behavior adjustment** ([#47](https://github.com/apotenza92/facebook-messenger-desktop/issues/47))
  - Reverted the `beta.25` incoming-call foreground change so real incoming calls keep using the native system notification instead of forcing the Messenger window to the front.
  - Kept the tighter post-call media cleanup so microphone access is still more likely to be released when the call ends, even if the post-call/redial UI remains open.

### Validation

- `npm run build`

## [1.3.0-beta.25] - 2026-03-10

### Changed

- **Issue #47 follow-up polish** ([#47](https://github.com/apotenza92/facebook-messenger-desktop/issues/47))
  - Skip the native incoming-call notification when the Messenger window has already been successfully brought to the foreground, keeping the system notification as a fallback only when focus does not succeed.
  - Release media tracks more aggressively from active call peer connections when the call ends, so microphone access is less likely to remain active until the redial/post-call window is closed.
  - Expanded call-ended DOM observation in the injected call window to react to in-place text updates, not just newly added nodes, which improves post-call cleanup on Facebook’s redial/end-call screens.

### Validation

- `npm run build`

## [1.3.0-beta.24] - 2026-03-10

### Fixed

- **Issues #41 / #47: ghost incoming-call alerts could still appear after stale recovery or low-confidence call-like signals** ([#41](https://github.com/apotenza92/facebook-messenger-desktop/issues/41), [#47](https://github.com/apotenza92/facebook-messenger-desktop/issues/47))
  - Introduced evidence-based incoming-call classification so low-confidence native notifications and weak DOM signals no longer escalate into real incoming-call reminder/focus state.
  - Added recovery settling for `offline -> online`, `resume`, and `unlock-screen` so stale call-like state after sleep/network churn is suppressed until real incoming-call UI is visible again.
  - Expanded explicit non-incoming exclusions for statuses like missed/cancelled/joined/answered-elsewhere calls and removed title-only escalation paths.
- **Issue #48: messages viewport crop now re-applies after stale recovery events** ([#48](https://github.com/apotenza92/facebook-messenger-desktop/issues/48))
  - Added viewport/header recovery rechecks on `online`, `focus`, `visibilitychange`, `resume`, and `unlock-screen` so the Facebook top bar is less likely to remain exposed after reconnect or wake.

### Added

- **Incoming-call diagnostics + stronger live call coverage**
  - Added structured incoming-call debug logging and shared evidence helpers across preload/main call-detection paths.
  - Extended the GUI call harness to cover answered-call flows on both sides, hang-up cleanup, and message-only no-ghost-notification validation.

### Validation

- `npm run build`
- `npm run test:issues:deterministic`
- `npm run test:issues:e2e`
- Real two-account live validation:
  - incoming call answered on the receiving side
  - outgoing call answered on the remote side
  - normal message flow with no ghost `Incoming call` notification

## [1.3.0-beta.23] - 2026-03-09

### Fixed

- **Issue #47: incoming-call reminder could still false-trigger with no real incoming call** ([#47](https://github.com/apotenza92/facebook-messenger-desktop/issues/47))
  - Stopped notification-only call classifications from arming the repeating incoming-call reminder/focus path in the main process.
  - Required the fallback periodic call scan to extract a real caller before it can escalate into incoming-call state, preventing generic `Someone is calling you...` reminders from low-confidence DOM noise.

### Validation

- `npm run build`
- `npm run test:issues`

## [1.3.0-beta.22] - 2026-03-09

### Fixed

- **Issue #47: incoming-call UI could still collapse when Messenger reflowed call chrome** ([#47](https://github.com/apotenza92/facebook-messenger-desktop/issues/47))
  - Broadened incoming-call visibility detection to keep the call state alive from real overlay/dialog/banner signals instead of requiring only a narrow Answer+Decline snapshot.
  - Refreshed incoming-call hint heartbeat timestamps while the hint stays active so preload no longer expires the overlay using the original activation window.
  - Restored a conservative end-of-call observer that clears stale call state only after the visible call UI has been gone long enough to confirm the call actually ended.
- **Issue #47: outgoing or off-device call status could spam incoming-call notifications** ([#47](https://github.com/apotenza92/facebook-messenger-desktop/issues/47))
  - Excluded sidebar/navigation statuses like `Ongoing Call...`, joined-call state, started-call state, and ended-call state from incoming-call notification classification.
  - Prevented chat-list/sidebar call status rows from being treated as in-page incoming-call popup signals.
  - Allowed repeated detections of the same real ringing call to upgrade an existing generic system notification with the caller name instead of staying stuck on `Someone is calling you...`.

### Validation

- `npm run build`
- `npm run test:issues`

## [1.3.0-beta.21] - 2026-03-05

### Fixed

- **Issue #47: incoming call Answer/Decline popup could appear briefly then disappear** ([#47](https://github.com/apotenza92/facebook-messenger-desktop/issues/47))
  - Stopped clearing incoming-call overlay state on normal in-Messages navigation churn (`did-navigate` / `did-navigate-in-page`), which Facebook can emit during call UI animation.
  - Kept incoming-call reset behavior only when leaving Messages routes, preventing 1-second popup collapse while preserving cleanup on real route exits.
  - Removed aggressive call-ended auto-clear path based solely on transient control disappearance to avoid false end detection during Messenger reflow.
- **Incoming call notification consistency**
  - Reduced keyed incoming-call notification dedupe TTL from 45s to 12s so repeated real call attempts are less likely to be silently suppressed during tester retests.

### Validation

- `npm run build`
- `npm run test:issues:deterministic`

## [1.3.0-beta.20] - 2026-03-03

### Fixed

- **Issue #47: incoming-call controls/overlay could still vanish mid-ring or linger after a missed call** ([#47](https://github.com/apotenza92/facebook-messenger-desktop/issues/47))
  - Retuned incoming-call hint heartbeat/recheck windows so transient Messenger control reflows keep the incoming-call state alive while ringing, but stale hint state now clears much faster after the call ends.
  - Reduced incoming-call end grace/confirmation timing in the injected observer so missed/ended calls emit end signals sooner.
  - Reduced fallback hold durations so the top empty strip after missed/ended calls is removed sooner.

### Validation

- `npm run build`
- `npm run test:issues:deterministic`

## [1.3.0-beta.19] - 2026-03-03

### Fixed

- **Issue #47: incoming-call controls could still disappear while title continued showing caller** ([#47](https://github.com/apotenza92/facebook-messenger-desktop/issues/47))
  - Extended incoming-call visibility detection to include title-based call signals (`is calling`, `calling you`, `incoming call`) so transient control DOM changes don't collapse incoming-call mode mid-ring.
  - Tuned preload hint-clearing thresholds to avoid aggressive false clears when Messenger briefly reflows call UI.
  - Hardened manual incoming-call-ended handling so soft end signals are deferred while call signals are still active.
- **Incoming call native notification persistence + caller text cleanup**
  - Added incoming-call notification reminder loop (with stale timeout + explicit end handling) so system notifications can persist while call is still ringing.
  - Added NotificationHandler-level caller-body sanitization fallback to suppress generic placeholders like `Profile picture is calling...`.

### Validation

- `npm run build`
- `npm run test:issues:deterministic`

## [1.3.0-beta.18] - 2026-03-03

### Fixed

- **Issue #47: incoming-call UI could still collapse after a few seconds in live flows** ([#47](https://github.com/apotenza92/facebook-messenger-desktop/issues/47))
  - Made incoming-call overlay hint handling in preload sticky with a minimum hold window + miss-grace window so temporary Messenger UI/control reflows no longer clear the hint too aggressively.
  - Prevented heartbeat/recheck timers from force-clearing hint state immediately on transient missing controls; hint now persists unless disappearance is sustained.
- **Incoming call notification caller text hardening**
  - Added main-process caller sanitization fallback to drop generic labels (`Profile picture`, `Someone`, etc.) so notifications now fall back to `Someone is calling you on Messenger` instead of awkward placeholder names.

### Validation

- `npm run build`
- `npm run test:issues:deterministic`

## [1.3.0-beta.17] - 2026-03-03

### Fixed

- **Issue #47: incoming-call overlay no longer collapses immediately after appearing** ([#47](https://github.com/apotenza92/facebook-messenger-desktop/issues/47))
  - Added grace + confirmation windows before treating call controls as disappeared, preventing 0.5s flicker from transient Messenger UI reflows.
  - Tracked last-seen incoming-call controls and only emit `incoming-call-ended` after sustained control absence.
- **Incoming call notification caller text fallback cleanup**
  - Filtered generic labels (e.g. `Profile picture`) from caller-name extraction so native notifications avoid awkward `Profile picture is calling you...` text.
  - Improved incoming-call overlay hint visibility checks to scan all matching Answer/Decline controls (not just first match), reducing false clears.

### Validation

- `npm run build`
- `npm run test:issues:deterministic`

## [1.3.0-beta.16] - 2026-03-02

### Fixed

- **Issue #47: incoming call top-gap lifecycle regressions** ([#47](https://github.com/apotenza92/facebook-messenger-desktop/issues/47))
  - Kept incoming-call overlay hint state scoped to the active Messenger webContents and added watchdog/load/navigation recovery so stale hint states are cleared reliably.
  - Added explicit incoming-call ended/declined signal path from injected page observers to clear overlay hint/crop state immediately when call controls disappear.
  - Prevented incoming-call overlays from being misclassified as media overlay mode, avoiding persistent top-gap layout artifacts.
- **Issue #47: outgoing call popup startup routing delays** ([#47](https://github.com/apotenza92/facebook-messenger-desktop/issues/47))
  - Refined about:blank child-window bootstrap policy to support bounded trusted intermediate hops used by Facebook call startup flows while maintaining strict routing controls for non-call destinations.
  - Added stronger policy + GUI regression coverage for outgoing call bootstrap sequences (`call-safe -> thread -> call`, trusted intermediate hops, expiry/negative cases).
- **Incoming call notification polish**
  - Improved caller-name extraction/formatting and dedupe key stability across DOM/native call signal paths to reduce duplicate/ugly notification text.
- **Dev stability**
  - Guarded stdout/stderr broken-pipe (`EPIPE`) cases during local/dev harness shutdown so interrupted piped runs no longer throw uncaught exceptions.

### Validation

- `npm run build`
- `npm run test:window-open`
- `npm run test:issues`
- `npm run test:release`

## [1.3.0-beta.15] - 2026-02-28

### Fixed

- **Issue #46: muted group notifications could still leak in sender/group ambiguity cases** ([#46](https://github.com/apotenza92/facebook-messenger-desktop/issues/46))
  - Tightened notification target policy to fail closed with explicit `muted-conflict` classification when sender-style payloads can also map to muted group conversations
  - Expanded deterministic regression coverage for muted individual, muted group-title, and sender/group overlap scenarios
- **Issue #47: incoming audio/video call popup could fail to appear in latest beta flows** ([#47](https://github.com/apotenza92/facebook-messenger-desktop/issues/47))
  - Hardened about:blank child-window bootstrap handling to allow a bounded multi-hop same-site call startup sequence before strict popup routing resumes
  - Routed incoming call notification classification through the policy API and ensured call notifications are not blocked by message-only mute matching
  - Added GUI regression coverage for multi-hop about:blank call bootstrap and external escape routing

### Validation

- `npm run build`
- `npm run test:issues`
- `npm run test:window-open`

## [1.3.0-beta.14] - 2026-02-27

### Changed

- **Issue #45: faster but reliable media close recovery timing polish** ([#45](https://github.com/apotenza92/facebook-messenger-desktop/issues/45))
  - Tuned media-overlay transition debounce for quicker post-close cleanup while preserving stability across route/layout variants
  - Added/adjusted dismiss-action fast-path recheck timings so E2EE close behavior feels closer to non-E2EE without reintroducing stale media state

### Validation

- Re-ran regression checks after timing adjustments:
  - `npm run test:issues`
  - `npm run test:issue45:close:return:gui` (multiple runs)
  - `npm run test:issue45:thread:extensive:gui` (multiple runs)

## [1.3.0-beta.13] - 2026-02-27

### Added

- **Issue #45 diagnostics and easy tester log export** ([#45](https://github.com/apotenza92/facebook-messenger-desktop/issues/45))
  - Added detailed media-overlay debug telemetry in preload + main process (route transitions, computed media signals, forced state-off events, and class/state snapshots)
  - Persist debug stream to `media-overlay-debug.ndjson` in the app logs directory
  - Added `Help → Export Issue #45 Debug Report…` to generate a single JSON report containing environment details + recent debug timeline
  - Added `Help → Open Logs Folder` for quick access when attaching raw logs

### Changed

- Expanded non-E2EE regression coverage in `scripts/test-issue45-thread-open-close-extensive-gui.js`:
  - deep sidebar scan for older non-E2EE threads
  - explicit E2EE vs non-E2EE URL classification in summary output
  - close-then-switch-chat validation timing for the reported delayed top-bar reappearance pattern

### Internal

- Added auto-updater lifecycle markers to debug timeline to help rule in/out upgrade-state interactions during repro sessions

## [1.3.0-beta.12] - 2026-02-26

### Fixed

- **Issue #45: Facebook top bar could remain visible after closing non-E2EE media viewer** ([#45](https://github.com/apotenza92/facebook-messenger-desktop/issues/45))
  - Tightened media-overlay detection in preload to require explicit media actions (dismiss + download/share) so closed media does not keep stale media state
  - Added main-process guard to force media-viewer state off on return navigation to normal `/messages/...` routes and re-apply chat crop immediately
  - Added close-return regression coverage for real media flows (`npm run test:issue45:close:return:gui`)
- **Suppress non-message Facebook activity popups while preserving call popups**
  - Added policy-level detection for global Facebook social activity notifications (likes/comments/tags/friend requests, etc.)
  - Suppress only likely social/activity payloads with Facebook-shell titles
  - Explicitly keep call-like notifications allowed (`calling you`, `is calling`, etc.) to avoid interfering with incoming video/audio call behavior

### Added

- Notification policy regression assertions in `scripts/test-issues-regressions.ts`:
  - non-message Facebook activity payloads are suppressed
  - direct message payloads are not suppressed
  - incoming call payloads are not suppressed

## [1.3.0-beta.11] - 2026-02-26

### Fixed

- **Issue #47: incoming call popup could stay blank / delayed before controls appear** ([#47](https://github.com/apotenza92/facebook-messenger-desktop/issues/47))
  - Fixed child-window navigation handling for call popups that bootstrap via `about:blank` and then perform an initial Facebook/Messenger navigation before entering RTC/call routes
  - Prevented premature reroute/close of that bootstrap navigation, which could hide incoming call Answer/Decline UI and cause ~15s blank call windows
  - Kept strict popup policy behavior for subsequent navigations (main-view reroute, media download, external browser) after bootstrap is complete

- **Issue #45: media-viewer controls were misaligned/non-clickable across layout variants** ([#45](https://github.com/apotenza92/facebook-messenger-desktop/issues/45))
  - Reworked media action detection/pinning for `Close`, `Download`, and `Forward/Share` with hit-validation so only clickable nodes are pinned
  - Added left-dismiss layout handling and mirrored right-side spacing based on measured close-button gap for more symmetric control placement
  - Unified vertical alignment so right-side media actions stay level with the active close control
  - Preserved and restored original inline styles when pinning/unpinning media actions to prevent stale layout drift
  - Kept media control placement stable during window resize while maintaining Messages crop/media mode transitions

### Added

- Window-open GUI regression coverage for call bootstrap flow:
  - `scripts/test-window-open-gui.js` now includes an `about:blank` → `/messages/t/...` child-window bootstrap case to prevent this regression from returning
- Expanded issue #45 GUI coverage:
  - `npm run test:issue45:gui` for E2EE vs legacy media mode parity
  - `npm run test:issue45:buttons:gui` for pinned control spacing + resize behavior
  - `npm run test:issue45:live:scan:gui` and `npm run test:issue45:media-history:gui` for live chat/media discovery snapshots
  - `npm run test:issue45:real:resize:gui -- --mode click-flow` for real media-history click flow checks across multiple window sizes

## [1.3.0-beta.10] - 2026-02-25

### Fixed

- **External link routing regression**
  - Restored expected behavior so normal links open in the system browser instead of being treated as call windows
  - Kept Facebook/Messenger call flows opening in dedicated in-app child windows
- **Messages thread popup routing**
  - `_blank` opens to Facebook Messages thread URLs are now routed back into the main in-app Messenger surface instead of spawning/retaining child windows
- **Child window navigation policy parity**
  - Applied the same routing decisions to child-window navigations (in-app reroute, media download, external browser) to prevent inconsistent behavior after popup creation

### Added

- Window-open routing regression tests:
  - `npm run test:window-open` for deterministic policy coverage
  - `scripts/test-window-open-gui.js` Playwright/Electron GUI smoke test for real popup behavior

## [1.3.0-beta.9] - 2026-02-24

### Fixed

- **Issue #45: deterministic media-view behavior and top-right control layout** ([#45](https://github.com/apotenza92/facebook-messenger-desktop/issues/45))
  - Added explicit viewport-mode policy (`chat`/`media`/`other`) and media overlay state IPC so BrowserView crop is disabled whenever media viewer is active
  - Added media-view cleanup in preload to hide Facebook global top-right controls in media viewer context
  - Repositioned remaining media actions to stable top-right placement and aligned selectors with current Facebook labels (`Download media attachment`, `Forward media attachment`)
  - Added guard against stale media state during rapid transitions and route changes
- **Issue #46: fail-closed muted notification mapping and duplicate suppression** ([#46](https://github.com/apotenza92/facebook-messenger-desktop/issues/46))
  - Added notification decision policy module with confidence scoring + ambiguity detection and fail-closed suppression on uncertain mapping
  - Routed native notification target matching through unread-row candidates and muted conversation checks before forwarding
  - Unified dedupe keying around normalized conversation href with TTL protection to block sender/group double-fire sequences
- **Main process stability during close/reopen test runs**
  - Prevented `Object has been destroyed` crash path by avoiding `mainWindow.webContents` access in the `closed` handler and cleaning media state using cached webContents IDs

### Added

- Deterministic local regression suite for issue repro patterns:
  - `npm run test:issues` command
  - `scripts/test-issues-regressions.ts` covering #45 media mode transitions and #46 muted/ambiguous notification decisions

## [1.3.0-beta.8] - 2026-02-24

### Fixed

- **Issue #45 follow-up: media popup flow still showed Facebook top controls / could open broken child windows** ([#45](https://github.com/apotenza92/facebook-messenger-desktop/issues/45))
  - Reroute Messenger media popup URLs (`/messages/attachment_preview`, `/messages/media_viewer`, `/photo`, `/video.php`, `/story.php`, etc.) into the main app surface instead of allowing separate child windows
  - Keep Messages-surface routing active for `/messages/attachment_preview` and `/messages/media_viewer` so header crop + viewport compensation remain applied
  - Hardened media-route matching to include dot-suffix paths (for example `.php` routes)
  - Restored media viewer top controls (`Close`, `Download`, `Share`) by excluding media preview/viewer subroutes from Messages header crop logic
- **Issue #46 hardening: reduce non-messages notification leakage paths** ([#46](https://github.com/apotenza92/facebook-messenger-desktop/issues/46))
  - Scoped injected renderer notifications to Messages routes only (`/messages`, `/t/*`, `/e2ee/t/*`) to avoid forwarding non-chat Facebook notifications

## [1.3.0-beta.6] - 2026-02-24

### Fixed

- **Issue #45: media viewer still showed Facebook top controls/title count noise** ([#45](https://github.com/apotenza92/facebook-messenger-desktop/issues/45))
  - Treat media viewer routes (`/photo`, `/video`, `/reel`, `/story`, etc.) as part of the Messages surface
  - Keep Messages header crop/viewport compensation active while media is open to prevent top-bar control pop-in
  - Force Messenger-style window title on media viewer routes and ignore unrelated Facebook global notification prefixes
- **Issue #46: muted conversations occasionally leaked a first notification after launch/refresh** ([#46](https://github.com/apotenza92/facebook-messenger-desktop/issues/46))
  - Disabled legacy preload notification forwarding path that could emit unfiltered notifications before mute checks
  - Removed renderer native `notifications` permission allowlist so site notifications cannot bypass app-level mute filtering

## [1.3.0-beta.5] - 2026-02-23

### Fixed

- **Issue #45: migration banner incorrectly shown/persisting during media open/close** ([#45](https://github.com/apotenza92/facebook-messenger-desktop/issues/45))
  - Added route exclusions so auth-flow disclaimer banners do not appear on Facebook media/content viewer routes (photo/video/reels/stories/watch)
  - Added banner lifecycle cleanup on navigation and SPA route changes so injected banner DOM/CSS is removed when leaving login/verification/intermediate pages
  - Hardened session-state gating for intermediate banner injection to avoid false positives when cookie/session checks are unavailable

## [1.3.0-beta.4] - 2026-02-23

### Changed

- Reverted macOS main window to the native system title bar/chrome
- Removed custom macOS titlebar overlay and seam/shadow workaround
- Preserved Facebook /messages header-removal behavior (viewport crop + compensation)

## [1.3.0-beta.3] - 2026-02-22

### Fixed

- **Issue #44 follow-up: muted + unread badge reliability on facebook.com/messages** ([#44](https://github.com/apotenza92/facebook-messenger-desktop/issues/44))
  - Re-enabled MutationObserver notification path for Facebook Messages where native `Notification(...)` callbacks are not always emitted
  - Updated muted detection for current Facebook Messages icon markup (including new mute bell slash path signatures)
  - MutationObserver notifications now explicitly skip muted conversations
  - Badge counting refactored to use sidebar DOM as the sole unread source (removed page-title count fallback)
  - Improved mark read/unread responsiveness with immediate recount bursts so dock/taskbar badges update without needing chat switches

## [1.3.0-beta.2] - 2026-02-22

### Fixed

- **Issue #44: muted chats and phantom unread counts after Facebook Messages migration** ([#44](https://github.com/apotenza92/facebook-messenger-desktop/issues/44))
  - Strengthened muted conversation detection to handle both legacy and new Facebook icon markup (`svg path`, `svg use`, accessibility labels/tooltips)
  - Excluded muted chats from both native notifications and DOM unread badge recounts
  - Canonicalized thread paths (`/messages/t/`, `/messages/e2ee/t/`, `/e2ee/t/`) to avoid duplicate counting/notification records for the same chat
  - Filtered hidden/virtualized sidebar rows during DOM unread recount to reduce phantom increments
  - Broadened unread indicator matching to tolerate Facebook label casing/wording changes
- **Titlebar unread source isolation**
  - On `/messages`, titlebar count now uses app-computed Messenger unread count instead of Facebook page-title prefix
  - Fixes false `(1)` titlebar cases caused by non-Messenger Facebook notification counters appearing in `document.title`
  - Keeps title text synced while preventing global Facebook notification noise from leaking into Messenger unread UX

## [1.3.0-beta.1] - 2026-02-19

### Changed

- **Backend migration**: App backend now targets `https://www.facebook.com/messages/` instead of `messenger.com` ([#41](https://github.com/apotenza92/facebook-messenger-desktop/issues/41))
- **Navigation scope**: In-app navigation now stays focused on Messages/auth routes; non-messaging Facebook pages open in the system browser
- **Session startup**: Cookie/session checks now validate against `facebook.com` and load the Messages URL directly

### Fixed

- **Facebook header UI**: Added route-aware suppression for Facebook's top branded header on `/messages` so chat content fills the app window
- **Notifications**: Notification click-to-navigate now canonicalizes legacy thread links to Facebook Messages URLs
- **Calls/popups**: Child window/call URL allowlists and permission checks now support Facebook-hosted call flows
- **Badge**: Fixed unread badge count drift when reactions arrive in the currently open conversation ([#43](https://github.com/apotenza92/facebook-messenger-desktop/issues/43))
  - Badge reconciliation now trusts a lower, sidebar-verified DOM unread count while focused in an active chat
  - Prevents badge from staying stuck until switching to another conversation

## [1.2.7] - 2026-02-19

### Fixed

- **Offline recovery**: Retry, auto-retry countdown, and reload shortcuts now correctly navigate back to Messenger instead of reloading the offline data page ([#40](https://github.com/apotenza92/facebook-messenger-desktop/issues/40))
- **Messenger UI**: Removed custom media-viewer CSS override on macOS
  - No longer injects `messenger-media-viewer-fix` offsets for Close/Download/Forward controls
  - Messenger media viewer buttons now use native messenger.com styling
- **Badge**: Fixed unread chat count getting stuck at `1` in some cases ([#38](https://github.com/apotenza92/facebook-messenger-desktop/issues/38))
  - Badge DOM recount now scopes to the chats sidebar instead of scanning the full document
  - Counts only real conversation rows with `/t/` links and deduplicates by normalized conversation path
  - Tightened unread detection to explicit signals (`Unread message`, `Mark as Read`) to avoid false positives
  - Added source-decision logs for title-vs-DOM badge arbitration to aid beta validation

## [1.2.7-beta.1] - 2026-02-07

### Fixed

- **Messenger UI**: Removed custom media-viewer CSS override on macOS
  - No longer injects `messenger-media-viewer-fix` offsets for Close/Download/Forward controls
  - Messenger media viewer buttons now use native messenger.com styling
- **Badge**: Fixed unread chat count getting stuck at `1` in some cases ([#38](https://github.com/apotenza92/facebook-messenger-desktop/issues/38))
  - Badge DOM recount now scopes to the chats sidebar instead of scanning the full document
  - Counts only real conversation rows with `/t/` links and deduplicates by normalized conversation path
  - Tightened unread detection to explicit signals (`Unread message`, `Mark as Read`) to avoid false positives
  - Added source-decision logs for title-vs-DOM badge arbitration to aid beta validation

## [1.2.6] - 2026-02-03

### Added

- **Icon selection**: New "Icon" menu lets users choose official (blue) or beta (orange) icons
  - Applies immediately to dock/taskbar/tray icons (launcher icons follow installed app)

### Fixed

- **Auto-update**: Beta users can now correctly update to stable releases
  - Fixed release workflow bug where beta-\*.yml files were incorrectly overwritten with stable artifact paths
  - Beta users will now receive proper update packages when stable versions are released
- **Badge**: Focus-based clearing now waits for focus and retries, preventing premature clears while unfocused
  - Adds short retry checks on focus/visibility to account for DOM/title settling
  - Allows clear when title is 0 and DOM is temporarily unavailable

## [1.2.6-beta.4] - 2026-02-02

### Fixed

- **Badge**: Tightened deferred clear logic so focus reliably clears the badge when chats are read ([#38](https://github.com/apotenza92/facebook-messenger-desktop/issues/38))
  - Adds short retry checks on focus/visibility to account for DOM/title settling
  - Allows clear when title is 0 and DOM is temporarily unavailable

## [1.2.6-beta.3] - 2026-01-31

### Fixed

- **Badge**: Prevented aggressive badge clearing while the app is unfocused ([#38](https://github.com/apotenza92/facebook-messenger-desktop/issues/38))
  - Badge now clears when the app is focused and the chat is truly read

### Changed

- **Project cleanup**: Removed internal prompt/orchestration files

## [1.2.6-beta.2] - 2026-01-30

### Added

- **Icon selection**: New "Icon" menu lets stable and beta users choose official (blue) or beta (orange) icons
  - Applies immediately to dock/taskbar/tray icons (launcher icons follow installed app)

## [1.2.6-beta.1] - 2026-01-29

### Fixed

- **Auto-update**: Beta users can now correctly update to stable releases
  - Fixed release workflow bug where beta-\*.yml files were incorrectly overwritten with stable artifact paths
  - Beta users will now receive proper update packages when stable versions are released

## [1.2.5] - 2026-01-29

### Added

- **Quick switcher & keyboard shortcuts**: Command palette with real-name learning, shortcuts overlay, and sidebar navigation keys

### Fixed

- **Audio/Video calls**: Microphone release reliability when calls end
- **Notifications**: Click-to-navigate and stale notification suppression after sleep/wake
- **Badge**: Immediate clearing when reading messages in the active chat
- **Keyboard shortcuts**: Startup focus, navigation accuracy, and modifier key handling
- **Command palette**: Enter key now works when searching by real name

### Changed

- **Quick switcher**: Renamed from command palette and moved to Cmd/Ctrl+O

## [1.2.5-beta.11] - 2026-01-26

### Fixed

- **Audio/Video calls**: Improved microphone release reliability ([#33](https://github.com/apotenza92/facebook-messenger-desktop/issues/33))
  - Previous fix ran in isolated preload context, missing streams created by Messenger
  - New approach injects script into page context to intercept RTCPeerConnection
  - Tracks streams via addTrack calls and DOM media element scanning
  - Added "nuclear option": requests fresh mic access and immediately releases it
  - Guarantees microphone release even when Messenger has already stopped tracks

### Changed

- **Keyboard Shortcuts**: Command palette renamed to "Quick switcher"
  - New shortcut: Cmd/Ctrl+O (was Cmd/Ctrl+Shift+P)
  - Updated all UI text and log messages

## [1.2.5-beta.10] - 2026-01-23

### Fixed

- **Audio/Video calls**: Microphone now releases when call ends, not when window closes ([#33](https://github.com/apotenza92/facebook-messenger-desktop/issues/33))
  - Added track `ended` event listeners to detect when Facebook stops media tracks
  - Added DOM observer to detect "call ended" UI patterns (e.g., "Call ended", "No answer", "Unavailable")
  - Microphone/camera released immediately upon call termination

## [1.2.5-beta.9] - 2026-01-22

### Improved

- **Keyboard Shortcuts Overlay**: UI improvements
  - Wider dialog to prevent text crowding
  - Shows platform-specific shortcuts (⌘ on macOS, Ctrl on Windows/Linux)

## [1.2.5-beta.8] - 2026-01-22

### Fixed

- **Command Palette**: Fixed Enter key not working when searching by real name
  - Search results matched real names but selection only checked nicknames
  - Now uses same matching logic for both display and selection
- **Real Name Extraction**: Improved speed and reliability
  - Now starts extraction after 500ms (was 1.5s)
  - Retries up to 5 times for slow-loading conversations
  - Total coverage ~8 seconds for conversations that load slowly

## [1.2.5-beta.7] - 2026-01-22

### Added

- **Real Name Learning**: Command palette now learns and searches by real names
  - Automatically extracts real names from conversation avatar alt text
  - Caches names in localStorage (persists across restarts)
  - Search matches both nickname and all member real names
  - Shows as "Nickname (Real Name)" for 1:1 chats
  - Shows as "Group Name (Member1, Member2, ...)" for group chats
  - Avatar initial uses first real name when available

### Fixed

- **Keyboard Shortcuts**: Fixed Cmd+Shift+[ and Cmd+Shift+] not working
  - Was checking for `[` and `]` keys, but with Shift pressed they become `{` and `}`
  - Now uses `e.code` for reliable physical key detection
- **Keyboard Shortcuts**: Fixed shortcuts not working on app startup
  - Content view now auto-focuses when Messenger loads
  - No longer requires clicking inside the app first
- **Keyboard Shortcuts**: Fixed navigation going to wrong chat
  - Sidebar row detection now only counts rows with valid conversation links
  - Consistent indexing between current position detection and navigation
- **Shortcuts Overlay & Command Palette**: Now match Messenger's theme
  - Detects dark/light mode via `__fb-dark-mode` class or background luminance
  - Uses appropriate colors for each theme
- **Script Injection**: Prevented double-injection of keyboard handlers

## [1.2.5-beta.6] - 2026-01-22

### Added

- **Keyboard Shortcuts** for faster navigation and operations:
  - **Cmd/Ctrl + 1-9**: Jump directly to numbered chat in sidebar
  - **Cmd/Ctrl + Shift + [**: Navigate to previous chat
  - **Cmd/Ctrl + Shift + ]**: Navigate to next chat
  - **Cmd/Ctrl + Shift + P**: Open command palette with contact search
  - **Cmd/Ctrl + /**: Show keyboard shortcuts overlay
  - All shortcuts work on macOS (Cmd), Windows, and Linux (Ctrl)

- **Command Palette** for instant contact search:
  - Access with Cmd/Ctrl + Shift + P
  - Fuzzy search through all contacts in sidebar
  - Click result or press Enter to open conversation

- **Keyboard Shortcuts Menu**:
  - Added "Keyboard Shortcuts" to Help menu
  - Shows all available shortcuts and their functions
  - Easy reference for power users

## [1.2.5-beta.5] - 2026-01-22

### Fixed

- **Audio calls**: Microphone now consistently released after calls end ([#33](https://github.com/apotenza92/facebook-messenger-desktop/issues/33))
  - Root cause: `call-window-preload.js` was injected after page load, missing early `getUserMedia()` calls
  - Fix: Use `call-window-preload.js` as actual preload script for call windows to ensure override runs before any page JavaScript
  - Microphone no longer lingers in macOS menu bar (orange icon) after call ends

## [1.2.5-beta.4] - 2026-01-20

### Fixed

- Fixed macOS notification click not navigating to the correct chat conversation

## [1.2.5-beta.3] - 2026-01-18

### Fixed

- **Notifications**: Fix click-to-navigate not opening the correct chat when clicking notifications
  - Fixed regex bug in path normalization that prevented link matching
  - Now searches for Messenger's `role="link"` elements, not just `<a>` tags
  - Uses pointer events for better compatibility with Messenger's React handlers
  - Added retry logic for when sidebar isn't rendered yet after window focus

## [1.2.5-beta.2] - 2026-01-18

### Fixed

- **Badge**: Badge now clears immediately when reading messages in the active chat ([#38](https://github.com/apotenza92/facebook-messenger-desktop/issues/38))
  - Detects when Enter key is pressed (message sent) and triggers badge recount
  - Monitors sidebar for unread status changes in real-time
  - No longer requires switching chats to refresh the badge count

## [1.2.5-beta.1] - 2026-01-17

### Fixed

- **Notifications**: Suppress backlog notifications after sleep/wake by re-entering settling mode and recording unread state
- **Notifications**: Native notifications now require a matching unread sidebar row before sending
- **Notifications**: Resume/unlock settling only allows fresh messages, avoiding stale or self-sent alerts

## [1.2.4] - 2026-01-16

### Added

- **Update frequency setting**: Control how often the app checks for updates ([#37](https://github.com/apotenza92/facebook-messenger-desktop/issues/37))
  - Options: Never, On Startup, Every Hour, Every 6 Hours, Every 12 Hours, Daily, Weekly
  - Default is "Daily" to reduce update popup frequency
  - Persists last check time so restarts don't trigger redundant checks
  - Available in app menu under "Update Frequency"

### Fixed

- **Windows**: Beta and stable now install to separate directories
  - Stable: `%LOCALAPPDATA%\Programs\facebook-messenger-desktop\`
  - Beta: `%LOCALAPPDATA%\Programs\facebook-messenger-desktop-beta\`
  - Previously both installed to the same directory, causing conflicts

## [1.2.3-beta.2] - 2026-01-15

### Fixed

- **Auto-update**: Improved beta detection logic to ensure correct artifact selection
- **Testing**: Added comprehensive automated tests for beta/stable coexistence scenarios

### Changed

- Rolled back 1.2.4-beta.1 release due to incomplete beta updater fixes

## [1.2.3-beta.1] - 2026-01-14

### Fixed

- **Auto-update**: Beta app now correctly downloads beta-branded artifacts when updating
  - Uses separate update channel (beta-\*.yml) to ensure correct artifact selection
  - Fixes issue where beta app would install stable app and cause dock/taskbar confusion

## [1.2.3] - 2026-01-14

### Fixed

- **All platforms**: Beta users no longer get stable app installed separately when a stable release comes out
  - Beta channel now receives stable releases through beta-branded installers
  - Preserves taskbar shortcuts, app ID, and user data when updating from beta to stable
  - Applies to Windows, macOS, and Linux (deb/rpm)
- **Windows**: Uninstaller no longer affects the other app variant
  - Beta uninstall won't kill stable process or remove stable shortcuts (and vice versa)
  - Only removes shortcuts that point to the specific installation being uninstalled
  - Correctly cleans up app data folder (Messenger-Beta vs Messenger)
- **Linux**: Package scripts now handle beta and stable independently
  - after-install.sh detects which variant is being installed
  - after-remove.sh only removes symlinks/icons for the variant being uninstalled
- **macOS**: In-app uninstall now uses correct bundle ID for beta vs stable
- **All platforms**: In-app "Logout and Reset" uses correct paths for each variant

## [1.2.2] - 2026-01-14

### Added

- **Side-by-side installation**: Beta and stable versions can now be installed simultaneously on all platforms
- **Menu bar**: Default mode changed to "always visible" for new users

### Fixed

- **Windows**: Taskbar shortcut breaking after auto-update ("shortcut has been moved" error)
- **Windows**: Beta installer no longer tries to close stable "Messenger.exe" (and vice versa)
- **Windows/Linux**: Menu bar hover detection and F10 toggle behavior
- **macOS**: Code signing failing due to Linux icon files being included
- **Linux Snap**: Version stuck on 1.1.8
- **Update dialog**: Traffic light close button sizing and markdown rendering

### Improved

- **Update notifications/dialogs**: "Messenger Beta" branding for beta users
- **Snap promotion**: Runs every 6 hours via dedicated workflow
- **Build config**: Platform-specific files only included for relevant builds
- **Download page**: Various UI improvements including animated connectors

### Changed

- Renamed "Reset & Logout" menu item to "Logout and Reset App"
- Consolidated release documentation into AGENTS.md

## [1.2.2-beta.6] - 2026-01-14

### Improved

- **Update notifications**: Download progress notification now specifies "Messenger Beta" for beta users
  - Notification body and tray tooltip both reflect the app variant being updated
- **Download page**: Beta Version disclaimer spacing reduced for closer proximity to download and command sections
- **Download page**: Added animated connectors from download button to terminal commands
  - macOS: Visual flow from Download → Homebrew installation command
  - Linux: Visual flow from Download → Terminal installation command
- **Download page**: Connectors now visible on mobile devices with optimized stroke width
  - Previously hidden on screens ≤640px, now display with thinner stroke for better mobile UX

## [1.2.2-beta.5] - 2026-01-14

### Fixed

- **Update dialog**: Traffic light close button was oversized (inheriting generic button padding)
- **Update dialog**: Markdown `**bold**` syntax now renders correctly in release notes

## [1.2.2-beta.4] - 2026-01-14

### Fixed

- **macOS**: Code signing failing due to Linux icon files being included in macOS builds
  - `asarUnpack` now only applies to Linux builds

### Improved

- **Snap promotion**: Now runs every 6 hours via dedicated workflow instead of during release
  - More reliable promotion even if Launchpad builds take longer than expected
  - Handles both beta and stable channel promotion automatically
- **Build config**: Platform-specific files only included for relevant builds
  - Windows PowerShell shortcut fix script only bundled in Windows builds
  - NSIS installer/uninstaller icons now correctly use beta icons for beta builds
- **Download page**: Auto-detects OS on page refresh instead of persisting previous selection

### Changed

- Consolidated release documentation into AGENTS.md (removed RELEASE_PROCESS.md)
- New `./scripts/release.sh` for streamlined releases

## [1.2.2-beta.3] - 2026-01-14

### Fixed

- **Windows**: Taskbar shortcut breaking after auto-update ("shortcut has been moved" error)
  - Shortcut fix now runs AFTER app restarts from new location (not before)
  - Tracks version in `last-version.json` to detect when update was applied
  - PowerShell script dynamically detects beta vs stable for correct AUMID
- **Windows**: Beta installer no longer tries to close stable "Messenger.exe" (and vice versa)
  - NSIS script now properly handles beta/stable separation
  - Only updates shortcuts matching the correct app variant

### Improved

- **Download page**: GitHub icon now properly centered below description
- **Download page**: Beta notice moved below Stable/Beta toggle
- **Download page**: Version number displayed below channel toggle (blue for stable, orange for beta)
- **Download page**: Consistent orange color (#ff6b00) across all beta elements
- **Update dialogs**: Now show "Messenger Beta" branding when running beta version
  - "Messenger Beta Update" / "Messenger Beta Update Ready" titles
  - "Messenger Beta is running the latest version" message

### Changed

- Dev menu simplified to Windows update testing only
  - "Test Windows Update & Shortcut Fix": Full workflow simulation with version tracking
  - "Run Shortcut Fix Now": Immediate shortcut fix execution

## [1.2.2-beta.2] - 2026-01-14

### Added

- **Side-by-side installation**: Beta and stable versions can now be installed simultaneously on all platforms
  - Different app identifiers: `com.facebook.messenger.desktop` (stable) vs `com.facebook.messenger.desktop.beta` (beta)
  - Separate user data directories: `Messenger` vs `Messenger-Beta`
  - Separate Homebrew casks: `facebook-messenger-desktop` vs `facebook-messenger-desktop-beta`
  - Different Linux packages: `facebook-messenger-desktop` vs `facebook-messenger-desktop-beta`
  - **Orange app icon** for beta to visually distinguish from stable (blue) version

## [1.2.2-beta.1] - 2026-01-14

### Fixed

- **Windows/Linux**: Menu bar hover detection not working properly
- **Windows/Linux**: F10 now permanently toggles menu bar visibility (previously would hide again when clicking in the app)
- **Windows/Linux**: "Hide Menu Bar" / "Show Menu Bar" label now correctly says "Toggle Menu Bar"
- **Linux Snap**: Version stuck on 1.1.8 - now uses package.json version instead of `git describe`

### Improved

- **Download page**: Beta channel now always shows latest version (beta or stable, whichever is newer)
- **Download page**: Stable/Beta toggle always visible, removed version number display
- **Download page**: Orange theme applied to all buttons when Beta is selected
- **CI**: Snap promotion now waits for Launchpad builds to complete before promoting

### Changed

- Renamed "Reset & Logout" menu item to "Logout and Reset App" for clarity

## [1.2.1] - 2026-01-14

### Fixed

- Beta users not receiving beta updates (issue #34)
  - Worked around electron-updater GitHub provider bug where `allowPrerelease` doesn't work
  - Auto-updater now queries GitHub API directly to find the correct release

### Improved

- Redesigned update notification dialog
  - Custom HTML-based dialog with proper styling and fixed dimensions
  - Scrollable changelog section that doesn't overflow the window
  - Bold section headers and formatted bullet points
  - Dark/light theme support matching system preference
  - Keyboard shortcuts: Enter to download, Escape to dismiss

### Changed

- **Redesigned beta program** - stable and beta are now completely separate app tracks
  - **Stable users**: Install from the download page, receive stable updates only
  - **Beta users**: Install the beta version specifically, receive beta updates only
  - Removed the in-app "Join Beta Program" / "Leave Beta Program" menu toggle
  - Beta versions clearly display as **"Messenger Beta"** in dock, taskbar, window title
  - To switch tracks: uninstall current version, install desired track from download page
  - Legacy beta opt-in preference files are automatically cleaned up on update

### Added

- **Beta installation options** on download page (toggle Stable/Beta at top):
  - macOS: `brew install --cask apotenza92/tap/facebook-messenger-desktop@beta`
  - Linux Snap: `sudo snap install facebook-messenger-desktop --beta`
  - All platforms: Direct download links for beta builds
- Download page dynamically updates all links, commands, and labels per channel

## [1.2.0] - 2026-01-14

### Fixed

- Beta channel users not receiving updates (issue #34)
  - Rewrote auto-update system to use electron-updater's native prerelease support
  - Removed custom YML fetching logic that was causing "internet connection" errors
  - Beta users now properly receive beta updates via GitHub's prerelease flag
  - Stable users only receive stable releases
- Misleading "internet connection" error messages during update checks
  - Now shows accurate error messages based on actual failure type
  - Network errors clearly indicate connection issues
  - Other errors show the actual error message

### Changed

- Simplified update channel architecture
  - Removed generate-channel-yml.js build step
  - Updates now use GitHub Releases prerelease flag instead of separate YML files

## [1.1.9] - 2026-01-13

### Added

- Auto-hide menu bar with hover, Alt, and F10 toggle (issue #31)
  - Menu bar is hidden by default on Windows/Linux
  - Hovering near top of window (3px zone) temporarily shows menu bar
  - Alt key temporarily shows menu bar while held (Electron default behavior)
  - F10 key or View menu item toggles permanent visibility
  - Menu bar state persists correctly between temporary and permanent visibility
- Retry logic for channel version fetching with exponential backoff
  - 3 attempts with 1s, 2s, 4s delays for network resilience
  - Better handling of temporary network issues
  - User-friendly error dialogs instead of silent failures
- Comprehensive AI assistant instructions and release policies
  - Single .ai-instructions.md file for AI models to follow
  - Detailed release process documentation
  - Playwright test suite for update checker scenarios

### Fixed

- Microphone not released after audio calls end (issue #33)
  - Microphone now properly stops when call windows close
  - Works for both user-initiated and remote-initiated hang-ups
  - Added MediaStream tracking and cleanup via preload script
  - Prevents orange microphone indicator from staying active on macOS
  - Also handles video tracks and screen sharing cleanup
- Update checker failing when beta channel is unavailable
  - Fixed Promise.all rejection when one channel fails to fetch
  - Now gracefully handles cases where beta channel doesn't exist
  - Returns null instead of throwing error, allowing fallback to available channel
  - Prevents "Failed to fetch version information from both channels" error for beta users
- Beta/stable channel auto-update system improvements
  - Automatic YML file generation for both latest and beta channels across all platforms
  - Fixed promise error handling with proper rejection and 30-second timeout
  - Network failures now show clear error messages to users
- Windows 11 taskbar shortcuts breaking after auto-updates
  - Auto-updates now run the shortcut fix script before restart
  - Ensures AppUserModelId property is maintained on taskbar pins
  - Shortcuts remain functional after app updates
  - Test feature available in Develop menu for Windows users
- Cross-platform build improvements
  - YML generator now works correctly on macOS, Linux, and Windows
  - Platform-agnostic validation for build artifacts

## [1.1.8-beta.2] - 2026-01-13

### Fixed

- Beta/stable channel auto-update system improvements
  - Automatic YML file generation for both latest and beta channels across all platforms
  - Fixed promise error handling with proper rejection and 30-second timeout
  - Added retry logic with exponential backoff (3 attempts: 1s, 2s, 4s delays)
  - User-friendly error dialogs instead of silent failures
  - Network failures now show clear error messages to users
- Windows 11 taskbar shortcuts breaking after auto-updates
  - Auto-updates now run the shortcut fix script before restart
  - Ensures AppUserModelId property is maintained on taskbar pins
  - Shortcuts remain functional after app updates
  - Test feature available in Develop menu for Windows users

### Added

- Channel YML generator script (scripts/generate-channel-yml.js)
  - Automatically copies latest*.yml to beta*.yml for all platforms
  - Integrated into GitHub Actions workflow after builds
- Retry logic for channel version fetching (fetchChannelVersionWithRetry)
  - Exponential backoff for network resilience
  - Better handling of temporary network issues
- Standalone PowerShell script for Windows shortcut maintenance (scripts/fix-windows-shortcuts.ps1)
  - Uses .NET COM interop to access Windows Shell APIs
  - Updates AppUserModelId property on all Messenger shortcuts
  - Scans taskbar, Start Menu, and Desktop locations
- runWindowsShortcutFix() function for auto-update integration
  - Executes during update-downloaded event
  - Includes detailed result parsing and error handling
- Improved test diagnostics for Windows taskbar fix

## [1.1.8-beta.1] - 2026-01-13

### Added

- Auto-hide menu bar with hover, Alt, and F10 toggle (issue #31)
  - Menu bar is hidden by default on Windows/Linux
  - Hovering near top of window (3px zone) temporarily shows menu bar
  - Alt key temporarily shows menu bar while held (Electron default behavior)
  - F10 key or View menu item toggles permanent visibility
  - Menu bar state persists correctly between temporary and permanent visibility

### Fixed

- TypeScript compilation error in menu creation code

## [1.1.7] - 2026-01-13

### Fixed

- False "No Internet Connection" message during login
  - Error codes -2 (ERR_FAILED) and -3 (ERR_ABORTED) were too broad and caused false positives
  - Now only genuine network errors trigger the offline page
- Users stuck on facebook.com when reopening app
  - App was prematurely setting login flow state on startup
  - Now properly redirects from facebook.com to messenger.com after session validation

### Added

- Reset & Logout menu item for users to clear all session data
  - Accessible from Messenger menu (macOS) or Help menu (Windows/Linux)
  - Clears all cookies, cache, and local storage
  - Returns user to login screen without reinstalling the app
  - Equivalent to `npm run start:reset` but for production users

## [1.1.6] - 2026-01-12

### Fixed

- Login flow: Robust new user login that prevents redirect loops and flash of login page (issue #29)
  - App checks for existing session cookies before showing login page
  - State-based tracking prevents premature redirects during Facebook authentication
  - Properly handles 2FA, checkpoints, and "Trust this device" screens
  - Session persists correctly after app restart
- macOS: Spellcheck now enabled (issue #30)
  - Previously disabled on macOS, now works correctly
  - Both webpage-based and native spellcheck now functional

### Added

- Automated login flow test script (scripts/test-login.js)
  - Uses Playwright to automate the full login flow for testing
  - Integrates with 1Password CLI for credentials and TOTP
  - Tests session persistence after app restart

## [1.1.5] - 2026-01-12

### Changed

- Login flow now uses facebook.com instead of messenger.com
  - Messenger.com's login has issues with "approve from another device" verification
  - Facebook.com provides a more robust and complete authentication flow
  - After login, automatically redirects to Messenger
- New branded login intro page before Facebook authentication
- Consistent banner shown throughout entire login/verification flow

## [1.1.4] - 2026-01-12

### Fixed

- Beta channel: Users now correctly see stable updates when they are newer (issue #28)
  - Previously, beta users on v1.1.2 would not see v1.1.3 stable update
  - Root cause: electron-updater ignores channel setting when allowPrerelease is enabled
  - Fix: Smart update check now fetches both channels and picks the higher version

## [1.1.3] - 2026-01-12

### Fixed

- View menu: Reload and Force Reload now work correctly (issue #26)
  - On macOS, reload was targeting the wrong webContents (empty title bar window instead of Messenger content)
  - Cmd+R / Ctrl+R and Cmd+Shift+R / Ctrl+Shift+R now properly reload the Messenger page
- Badge counter: Added periodic recheck every 30 seconds (issue #27)
  - Catches cases where messages are read on another device
  - The local DOM doesn't update automatically, but periodic rechecks sync the badge count

### Added

- Offline detection with auto-retry (issue #25)
  - When app starts without internet (e.g., at login before network is ready), shows a friendly offline page
  - Includes manual Retry button and automatic retry countdown (10 seconds)
  - No more blank windows when launching without network connectivity

## [1.1.2] - 2026-01-10

### Fixed

- Windows 11: Pinned taskbar shortcuts no longer break after updates
- Beta program: Users now receive stable updates in addition to beta releases

### Added

- Develop menu: "Test Taskbar Fix (Simulate Update)" for testing on Windows

## [1.1.2-beta.2] - 2026-01-10

### Fixed

- Beta users now receive stable updates (issue #24)
  - Previously, beta users would only see newer beta versions, missing stable releases
  - Now beta users receive whichever version is newest, whether beta or stable

## [1.1.2-beta.1] - 2026-01-10

### Fixed

- Windows 11: Pinned taskbar shortcuts no longer break after updates
  - Root cause: WScript.Shell cannot set System.AppUserModel.ID property required by Windows 11
  - Fix: Now uses Windows Shell API via .NET interop to properly set AppUserModelId on shortcuts
  - This ensures Windows 11 maintains the association between the pinned icon and the app

### Added

- Develop menu: "Test Taskbar Fix (Simulate Update)" for beta testers on Windows
  - Runs the same shortcut fix logic that executes during actual updates
  - Shows detailed results of which shortcuts were found and updated
  - Offers to quit the app so you can test clicking the pinned taskbar icon

## [1.1.1] - 2026-01-10

### Fixed

- Facebook Marketplace links now open in system browser (issue #24)
  - Clicking "view more items", "view seller profile", or other Marketplace links in chats now opens them externally
  - The app is signed into Messenger but not Facebook, so Marketplace pages don't work in-app
  - Also redirects other non-Messenger Facebook URLs to system browser while preserving login flow

## [1.1.0] - 2026-01-09

### Summary

- Stability milestone release

## [1.0.10] - 2026-01-09

### Added

- Linux: Flatpak builds now included in releases
  - Available for both x64 and ARM64 architectures
  - Self-hosted Flatpak repository updated automatically on release

## [1.0.9] - 2026-01-09

### Changed

- CI: Attempted native ARM64 runners (reverted in 1.0.10 due to electron-builder issues)

## [1.0.8] - 2026-01-09

### Fixed

- macOS: Icon theme switching now works again (issue #23)
  - Dark icons were accidentally excluded from builds in v1.0.7
  - "Match System", "Light Icon", and "Dark Icon" options now properly switch the dock icon
  - Tahoe glass/clear effects still work in "Match System" mode
- Update dialog changelog section no longer overflows the screen (issue #23)
  - Shows only the changelog for the version being updated to
  - Dialog is now always visible and buttons are accessible

## [1.0.7] - 2026-01-09

### Added

- Update dialogs now show changelog of what's new in the update
  - Fetches changelog from GitHub when update is available
  - Beta users see both stable and beta entries
  - Stable users see only stable release entries
- Develop menu now available to beta testers
  - Access via menu bar on all platforms
  - Includes testing tools: Update workflow, Notification, Taskbar shortcut fix (Windows)

### Changed

- Joining beta program now automatically checks for beta updates
  - Previously showed a message telling users to manually check
  - Now immediately checks and notifies if a beta update is available

### Fixed

- Duplicate notifications for old messages no longer appear (issue #13)
  - Only messages within 1 minute trigger notifications
  - Old unread messages that appear when scrolling or after app restart are now ignored
  - Detects Messenger's relative timestamps (e.g., "5m", "2h", "3d", "1w") to identify old messages
- macOS: Media viewer controls no longer obscured by title bar (issue #21)
  - Close, download, and forward buttons now fully visible when viewing photos/videos
  - Injects CSS to push controls below the custom title bar overlay
- Update check no longer shows "Update check failed" when already on the latest version
  - Beta users especially affected when no newer releases available
  - Now correctly shows "You're up to date!" in these cases
- Notification badge now clears when actively viewing a conversation (issue #22)
  - Previously, badge wouldn't update until switching to another chat
  - Now excludes the currently-viewed conversation from unread count when window is focused
  - Added responsive badge updates when user interacts (clicks, types) in a conversation
- Flatpak: App now launches correctly
  - Fixed Electron binary corruption caused by flatpak-builder stripping
  - Fixed missing resources directory (flatpak-builder flattens archive structure)
  - Added in-app uninstall support via flatpak-spawn

## [1.0.7-beta.7] - 2026-01-09

### Fixed

- Notifications not appearing for new messages (regression from beta.1)
  - Messages within 1 minute ("1m" timestamp) now correctly trigger notifications
  - Previous fix was too aggressive and blocked all messages with any timestamp

## [1.0.7-beta.6] - 2026-01-09

### Fixed

- Notification badge now clears when actively viewing a conversation (issue #22)
  - Previously, badge wouldn't update until switching to another chat
  - Now excludes the currently-viewed conversation from unread count when window is focused
  - Added responsive badge updates when user interacts (clicks, types) in a conversation

## [1.0.7-beta.5] - 2026-01-08

### Added

- Update dialogs now show changelog of what's new in the update
  - Fetches changelog from GitHub when update is available
  - Beta users see both stable and beta entries
  - Stable users see only stable release entries

### Fixed

- Update check no longer shows "Update check failed" when already on the latest version
  - Beta users especially affected when no newer releases available
  - Now correctly shows "You're up to date!" in these cases

## [1.0.7-beta.4] - 2026-01-08

### Added

- Develop menu now available to beta testers
  - Access via menu bar on all platforms
  - Includes testing tools: Update workflow, Notification, Taskbar shortcut fix (Windows)

## [1.0.7-beta.3] - 2026-01-08

### Fixed

- macOS: Media viewer controls no longer obscured by title bar (issue #21)
  - Close, download, and forward buttons now fully visible when viewing photos/videos
  - Injects CSS to push controls below the custom title bar overlay

## [1.0.7-beta.2] - 2026-01-08

### Changed

- Joining beta program now automatically checks for beta updates
  - Previously showed a message telling users to manually check
  - Now immediately checks and notifies if a beta update is available

## [1.0.7-beta.1] - 2026-01-08

### Fixed

- Duplicate notifications for old messages no longer appear (issue #13)
  - Only messages that JUST arrived (no visible timestamp) will trigger notifications
  - Old unread messages that appear when scrolling or after app restart are now ignored
  - Detects Messenger's relative timestamps (e.g., "5m", "2h", "3d", "1w") to identify old messages

## [1.0.6] - 2026-01-08

### Added

- Beta program for early access to new features and bug fixes
  - Join via Messenger menu (macOS) or Help menu (Windows/Linux)
  - "Check for Updates" becomes "Check for Beta Updates" when enrolled
  - Leave anytime from the same menu
  - Snap/Flatpak users shown instructions to switch to direct download for beta access

## [1.0.5] - 2026-01-08

### Changed

- Login page now uses messenger.com/login/ (simpler, cleaner form structure)
- Custom branded login page with Messenger Desktop header, icon, and disclaimer
- Login page icon now uses high-resolution SVG for crisp rendering at any size

### Added

- Native media download handling (issue #20)
  - Images and videos from chat now download directly to Downloads folder
  - No longer opens external browser for Facebook CDN media URLs
  - Shows native notification when download completes
  - Click notification to reveal file in Downloads folder
- Verification page banner for 2FA and security checkpoint pages
  - Shows "You're signing in to Messenger Desktop" with app icon
  - Explains user is completing Facebook verification
  - Includes disclaimer about unofficial app status
  - Platform-specific positioning (accounts for macOS title bar overlay)

## [1.0.4] - 2026-01-07

### Changed

- Linux uninstall now uses Electron's native dialog instead of zenity/kdialog
- All Linux package types now use pkexec for authentication during uninstall
  - deb: apt remove with pkexec
  - rpm: dnf remove with pkexec
  - Snap: snap remove with pkexec
  - Flatpak: flatpak uninstall with pkexec (previously had no auth)
  - AppImage: Deletes the .AppImage file with pkexec
- Snap auto-promotion timeout increased from 60 to 90 minutes (Launchpad builds can be slow)
- Snap promotion workflow now shows detailed status and error reporting

### Added

- AppImage uninstall support
  - Detects AppImage installations via APPIMAGE environment variable
  - Deletes the .AppImage file and cleans up desktop entries/icons
  - Uses systemd-run to survive app exit, with fallback to direct spawn
- Screen sharing support during calls (issue #19)
  - Adds setDisplayMediaRequestHandler for getDisplayMedia() calls
  - Shows a picker dialog to choose which screen or window to share
  - Auto-selects if only one screen is available
  - Includes macOS screen recording permission prompt
- Linux: XWayland mode toggle for screen sharing compatibility
  - Help menu option to switch between native Wayland and XWayland modes
  - When screen sharing on native Wayland, prompts user to switch to XWayland
  - Preference is saved and persists across restarts
  - XWayland provides reliable screen sharing at cost of some Wayland features

### Fixed

- Deb/RPM: App not appearing in GNOME Applications menu
  - electron-builder was generating incomplete Categories field
  - Post-install script now fixes Categories to include InstantMessaging and Chat
- Snap: Desktop file and icon now properly included in snap/gui/ directory
  - Fixes app not appearing in application menu after snap install

## [1.0.3] - 2026-01-07

### Changed

- Snap auto-promotion now polls for build completion instead of fixed wait time
  - Checks every 2 minutes for new builds to appear in edge channel
  - Promotes immediately when builds complete (no more guessing)
  - 60 minute timeout as fallback

### Fixed

- Snap desktop file not being exported correctly (icon not showing in app menu)
  - Added desktop: directive to snapcraft.yaml for proper snapd integration

## [1.0.2] - 2026-01-06

### Added

- Automatic Snap promotion to stable channel after GitHub releases
  - New releases now automatically get promoted from edge to stable on Snap Store

### Fixed

- Linux deb/rpm: Icon not appearing in application menu (was showing generic gear icon)
  - Fixed icon name mismatch between desktop entry and installed icons
  - Added asarUnpack config to extract icons from asar archive for post-install script
  - Icons now correctly installed to /usr/share/icons/hicolor/

## [1.0.1] - 2026-01-06

### Fixed

- Snapcraft builds failing due to YAML indentation issues in heredocs
- Desktop file not being generated correctly for Snap packages
- First successful ARM64 Snap build
- Added note to uninstall dialog about package manager uninstall for Flatpak/Snap/apt/dnf users

## [1.0.0] - 2026-01-06

### Fixed

- Flatpak repository not accessible from self-hosted repo
  - GitHub Pages was serving from main branch /docs folder, but Flatpak repo was deployed to gh-pages branch
  - Now correctly deploys Flatpak repo to docs/flatpak/repo on main branch
  - Added .nojekyll file to prevent Jekyll from ignoring OSTree files

## [0.9.9] - 2026-01-06

### Added

- Bring window to foreground on incoming calls (issue #17)
  - When you receive a call, the app automatically opens if hidden and comes to foreground
  - Works when the app is minimized, in the background, or hidden to the tray
  - Detects calls via notification content and in-page call popup UI
  - On macOS, also bounces the dock icon for extra visibility
- Dark mode app icon with theme switching
  - New "Icon Appearance" submenu with three options: Match System, Light Icon, Dark Icon
  - "Match System" (default) on macOS: Uses native bundle icon, enabling Tahoe's glass/clear effects and automatic dark mode
  - "Match System" on Windows/Linux: Auto-switches between light/dark icons based on OS theme
  - "Light Icon" / "Dark Icon": Override with our custom icons (dark icon has white interior)
  - Menu location: Messenger menu (macOS) or File menu (Windows/Linux)
  - Preference is saved and persists across app restarts
- Notification Settings menu item on all platforms
  - macOS: Messenger menu → Notification Settings (opens System Settings > Notifications)
  - Windows: Help menu → Notification Settings (opens Settings > Notifications)
  - Linux: Help menu → Notification Settings (opens GNOME/KDE notification settings)
  - Helps users easily enable notifications if they're not receiving them (issue #13)
- macOS: Detect if notifications are disabled after app updates (issue #13)
  - Uses a bundled Swift helper to check notification authorization status
  - Prompts users to enable notifications if they're turned off
  - Includes "Don't ask again" checkbox for users who intentionally disabled notifications
  - Only shown once per update, not on every launch

### Fixed

- Snapcraft builds failing due to undefined CRAFT_ARCH variable
  - Now uses CRAFT_ARCH_BUILD_FOR with fallback to SNAPCRAFT_TARGET_ARCH
- macOS dock icon appearing larger than other app icons (issue #15)
  - Icon now matches Apple's design guidelines with ~8.5% transparent margin
  - Allows macOS to properly render shadows around the icon
  - Based on analysis of Apple's Messages.app icon structure

## [0.9.8] - 2026-01-06

### Fixed

- Muted conversations no longer trigger notifications or count toward badge (issue #14)
  - Native notifications now check muted status before sending
  - Badge count excludes muted conversations
  - Detects muted status via the "bell with slash" icon in sidebar
- Fixed Snapcraft builds failing on ARM64 and x64
  - Electron's install script was failing in the restricted build environment
  - Now skips automatic Electron download during npm ci (manual download handles target arch)

## [0.9.7] - 2026-01-06

### Changed

- Refined app icon design for better visual balance and macOS compatibility (issue #15)
  - Restored original Messenger chat bubble shape for proper dock sizing on macOS
  - Simplified network diagram with larger center node and uniform outer nodes
  - Center node is now prominent, outer nodes are 65% the size of center
  - Reduced icon scale from 80% to 72% for macOS Big Sur/Sequoia compatibility
  - Icons now have proper padding for system shadow rendering
- Simplified Linux build workflow
  - Removed redundant ARM64 Flatpak job (cross-compilation in main Linux job handles it)
  - Renamed build jobs for clarity: "Build Linux" now builds all x64 and ARM64 packages

## [0.9.6] - 2026-01-06

### Changed

- All Snap builds now handled by Snapcraft's "Build from GitHub" service
  - Removed electron-builder snap target from GitHub Actions
  - Removed update-snapstore job from release workflow
  - Snapcraft automatically builds and publishes both amd64 and arm64 snaps
  - Added .launchpad.yaml for auto-release to stable channel

### Fixed

- Fixed Flatpak repository deployment to GitHub Pages
  - Previous workflow incorrectly added all source files to gh-pages branch
  - Now properly clones gh-pages separately and only copies flatpak repo files

## [0.9.5] - 2026-01-06

### Changed

- New distinctive app icon featuring an isometric cube/graph design in a speech bubble
  - Visually unique to avoid confusion and potential trademark issues with official Messenger
  - Updated across all platforms: macOS (app, dock, DMG), Windows (taskbar, tray), Linux (all sizes)
- ARM64 Snap builds now use Snapcraft's "Build from GitHub" service
  - snapcraft remote-build has OAuth issues in CI environments
  - x64 Snap still built and uploaded via GitHub Actions
  - ARM64 Snap built automatically by Snapcraft when repo is linked at snapcraft.io

### Fixed

- Fixed repeated notifications for old unread messages (issue #13)
  - Messages left unread indefinitely no longer trigger duplicate notifications
  - Removed time-based expiry; records now cleared only when conversations are read or app restarts
  - Native notification records are now properly cleared when conversations are read

## [0.9.4] - 2026-01-06

### Changed

- Simplified and cleaned up release workflow
  - Separate build jobs per platform for clearer naming
  - Removed unreliable ARM64 Snap remote build (x64 Snap only for now)
  - Added continue-on-error to WinGet/Flatpak updates (don't fail release if these fail)
  - Better error messages for GPG key configuration issues
  - Proper job dependencies (release waits for all builds)

## [0.9.3] - 2026-01-06

### Fixed

- Fixed Linux build failure: Removed ARM64 from electron-builder snap target (ARM64 snap builds via remote build only)
- Fixed snapcraft authentication: Updated to use environment variable directly instead of deprecated --with flag

## [0.9.2] - 2026-01-06

### Added

- Linux ARM64 support for Snap and Flatpak packages
  - Snap ARM64 builds via Snapcraft remote-build service
  - Flatpak ARM64 builds on GitHub Actions ARM64 runners
  - Updated download page to show ARM64 Snap and Flatpak options

### Changed

- Cleaned up flatpak folder structure
  - Moved flatpak-repo.gpg to project root (common convention for public keys)
  - Removed flatpak README.md
- Added engines field to package.json to specify Node.js version requirement

## [0.9.1] - 2026-01-05

### Fixed

- macOS: Fixed badge count not displaying in dock icon
  - Changed from app.setBadgeCount() to app.dock.setBadge() for better reliability
  - Badge now properly shows unread message count on macOS
- Fixed badge updates not working when marking chats as unread
  - Added DOM-based unread conversation counting to catch manually marked unread chats
  - Badge now updates correctly for both new messages and manually marked unread chats
- Improved badge update responsiveness when reading messages
  - Reduced debounce time from 500ms to 200ms for faster updates
  - Added immediate checks on window focus and URL changes
  - Fixed badge flash when opening conversations by adding delay for DOM verification

### Improved

- Badge count detection now works from page context using postMessage bridge
  - No longer depends on electronAPI availability timing
  - More reliable badge updates across all scenarios

## [0.9.0] - 2026-01-05

### Added

- Self-hosted Flatpak repository for Linux users
  - Users can now install via: flatpak remote-add + flatpak install
  - GPG-signed repository hosted on GitHub Pages
  - Shows up in GNOME Software and KDE Discover after adding the repo
  - Updates via flatpak update or software center

### Changed

- Download page: Complete redesign with platform-specific pages
  - Each platform (macOS, Windows, Linux) now has its own dedicated download view
  - Clicking "Other platforms" links switches to that platform's download page instead of direct downloads
  - Architecture toggle (x64/ARM64 for Windows/Linux, Apple Silicon/Intel for macOS) on all platforms
  - Auto-detection selects the correct architecture tab based on user's system
  - Platform text shown as heading above the architecture toggle
- Download page: Added Flatpak install command to Linux downloads
- Linux Snap/Flatpak: Disabled built-in auto-updater
  - These package formats must be updated through their package managers
  - Check for Updates menu now shows helpful message with the correct update command
- Linux deb/rpm: Update installation now uses zenity/kdialog for password prompts
  - More reliable than pkexec which requires a polkit agent
  - Consistent with the uninstall dialog behavior

## [0.8.10] - 2026-01-05

### Fixed

- Fixed audio and video call buttons not working (broken since v0.4.1)
  - Messenger opens calls in a pop-up window which was being blocked
  - Messenger uses about:blank URLs for call windows, which are now allowed
  - Pop-up windows for messenger.com URLs now open as Electron windows
  - Child windows can navigate to messenger.com call URLs after opening
  - External links still open in system browser as before
- macOS: Fixed camera and microphone permissions not being requested
  - App now prompts for camera/microphone access on first launch
  - Added required Info.plist usage description strings
- Linux Flatpak: Added device permissions for webcam and audio access

### Changed

- Added "unofficial" disclaimers throughout the app and documentation
  - README, download page, About dialog, and LICENSE now include trademark notices
  - Clarifies this is a third-party, non-affiliated project
  - All references updated to indicate unofficial status

## [0.8.9] - 2026-01-04

### Fixed

- Linux deb/rpm: Fixed auto-updates returning 404 errors (especially on Fedora)
  - Download URLs were using Node.js arch names (x64/arm64) instead of Linux package names
  - RPM now correctly uses x86_64/aarch64 naming
  - DEB now correctly uses amd64/arm64 naming
- Linux deb/rpm: Fixed app not being available in terminal PATH after installation
  - Symlink now created from /usr/bin/facebook-messenger-desktop to /opt/Messenger/
  - Commands like `which facebook-messenger-desktop` now work as expected
- Linux: Fixed double window appearing when launching app while another instance is running
  - Single instance lock was correctly detecting the other instance but app.quit() is asynchronous
  - Added process.exit() to immediately terminate before window creation code could run

## [0.8.8] - 2026-01-04

### Added

- Linux: Comprehensive diagnostic logging for window creation to debug double window issue
  - Logs timestamps, event sources (second-instance, activate, tray-click), and full state at each step
  - Shows exactly when events fire and what guards block/allow window creation
  - Check logs at ~/.config/Messenger/logs/ or run from terminal to see output

### Fixed

- Windows: Fixed pinned taskbar shortcut showing "Can't open this item" after installing auto-update
  - NSIS installer now deletes and recreates the taskbar shortcut to clear stale state
  - Writes PowerShell script to temp file for reliable execution (avoids escaping issues)
  - Kills any running Messenger process first to prevent file locks
  - Added multiple shell notifications and icon cache refresh for reliability
- Linux: Attempted fix for double window still appearing despite 0.8.7 debounce fix
  - Added app initialization flag to queue second-instance events until window is ready
  - Increased debounce from 500ms to 1000ms to catch rapid double-clicks
- Linux: Fixed 20+ second delay when clicking Uninstall Messenger (especially on Snap)
  - Electron's native dialogs go through xdg-desktop-portal which can be very slow
  - Now uses zenity (GTK) or kdialog (KDE) which are fast and match desktop theme
  - Falls back to Electron dialog if neither tool is available
- Linux deb/rpm: Fixed app icon not appearing in applications menu on Ubuntu
  - Icons are now explicitly installed to hicolor theme during package installation
  - Added after-remove script to clean up icons when package is uninstalled

## [0.8.7] - 2026-01-04

### Fixed

- Fixed slow uninstall dialog on Snap (and other platforms)
  - Confirmation dialog now appears immediately when clicking Uninstall
  - Package manager detection moved to after user confirms, not before
- Linux deb/rpm: Fixed app failing to launch with sandbox error
  - Post-install script now sets correct ownership and SUID permissions on chrome-sandbox
  - Previously required manual fix: sudo chown root:root /opt/Messenger/chrome-sandbox && sudo chmod 4755
- Linux: Fixed double window appearing when clicking dock/dash icon repeatedly
  - Added debounce to prevent both second-instance and activate events from creating windows
- Linux: Fixed app icon appearing too small in dash/dock
  - Increased icon background from 72% to 85% of canvas size
  - Logo now fills 68% of canvas (was 56%)
- Linux deb/rpm: Fixed app icon not showing in application menu
  - Added explicit Icon field to desktop file configuration
- Linux deb/rpm: Fixed installation hanging when installing via terminal
  - Removed dbus-send command that could block without a desktop session

## [0.8.6] - 2026-01-04

### Fixed

- Windows: Fixed taskbar icon becoming blank after auto-update
  - Icon is now re-applied after window ready-to-show and on window show events
  - NSIS installer clears Windows icon cache during updates to force refresh
  - Shell notification sent to refresh taskbar after update completes
- Linux Snap: Fixed app crashing when using in-app uninstaller
  - Snap apps cannot uninstall themselves while running due to sandbox confinement
  - App now quits first, then runs snap remove in a detached process
- Linux Flatpak: Fixed potential crash when using in-app uninstaller
  - Same deferred uninstall approach as Snap for sandbox compatibility
- Linux: Fixed ghost icons remaining in Pop!\_OS COSMIC app launcher after uninstall
  - All uninstallers now clear pop-launcher cache
  - All uninstallers now clear COSMIC app cache
  - Desktop database and icon caches are refreshed after uninstall

## [0.8.5] - 2026-01-04

### Fixed

- Linux: App now appears in application menu after installing deb/rpm via terminal
  - Added post-install script that updates desktop database and icon cache
  - Notifies GNOME Shell to refresh its app list

## [0.8.4] - 2026-01-04

### Fixed

- Linux: Fixed double window appearing when clicking dash icon after previously closing window
  - Added isDestroyed() check to prevent showing/focusing destroyed windows
  - Added race condition guard to prevent simultaneous window creation from second-instance and activate events
- Linux: Improved icon sizing in dash - icon now has transparent padding around it
  - White rounded background is now 72% of canvas (was 100%)
  - Messenger logo is 56% of canvas for better visibility within the smaller background
  - Icon now appears properly sized relative to other system icons in GNOME/KDE dash

## [0.8.3] - 2026-01-04

### Fixed

- Linux Snap: Fixed Snap Store upload failing due to duplicate plugs in snap configuration
  - Removed redundant desktop/x11/wayland/unity7 plugs that were already included in "default"
- Linux: Fixed in-app uninstall not actually removing the app on Fedora/RPM systems
  - Detection commands (rpm, dpkg-query) now use full paths for GUI environments
  - pkexec authentication dialog now appears properly (app window hides instead of quitting immediately)
  - Cleanup script waits for package manager to complete before refreshing caches
- Linux: Fixed app icon remaining in application menu after uninstall
  - User-specific desktop entries in ~/.local/share/applications/ are now cleaned up
  - User icons in ~/.local/share/icons/hicolor/ are now removed
  - Desktop database and icon caches are refreshed after uninstall
  - GNOME Shell and KDE Plasma are notified to refresh their app lists

## [0.8.2] - 2026-01-04

### Fixed

- Linux: Fixed duplicate window appearing briefly when clicking dock/dash icon after closing window
  - Activate event handler was incorrectly registered inside createWindow, causing listeners to accumulate
  - Now uses same showMainWindow() function as tray icon for consistent behavior
- Linux: Fixed app icon appearing too large in dash/dock compared to other apps
  - Reduced icon size from 80% to 68% of canvas (16% margins instead of 10%)
  - Now matches proportions of other desktop applications in GNOME/KDE

## [0.8.1] - 2026-01-04

### Fixed

- Windows: Fixed taskbar icon showing as missing after app updates
  - NSIS installer now updates existing pinned shortcuts to point to the new executable
  - Preserves pinned status while refreshing the shortcut target path
- Linux: Restart to update now works for deb and rpm package installs
  - Downloads the correct package type and installs with pkexec (graphical sudo)
  - Previously only worked for AppImage installs
- Linux: Added detection for Snap and Flatpak installs

## [0.8.0] - 2026-01-04

### Added

- Linux Snap: First-run help message for desktop integration (XDG_DATA_DIRS setup)
- Linux: New rounded tray icon for better visibility in system tray

### Fixed

- Linux AppImage: App now detaches from terminal immediately so the command returns
- Linux Snap: Added desktop integration plugs for better system integration (wayland, x11, unity7)
- Linux: Auto-update no longer shows crash message (windows closed cleanly before quitAndInstall)
- Windows: Improved update dialog with clear SmartScreen bypass and file unblock instructions

### Changed

- Linux Snap: Updated to core22 base for better compatibility

## [0.7.9] - 2026-01-04

### Fixed

- Linux: Fixed app showing with wrong icon (gear) in taskbar/dock due to WMClass mismatch
- Fixed race condition where clicking app icon could spawn multiple instances before single instance lock was checked

## [0.7.8] - 2026-01-04

### Fixed

- Linux: In-app uninstall now properly removes .deb and .rpm packages
  - Automatically detects if installed via apt/dpkg or dnf/rpm
  - Uses pkexec for graphical password prompt to run package manager uninstall
  - No longer shows "remove the package separately" message for .deb/.rpm installs

### Changed

- Download page: Extension now shown next to download button instead of in button text

## [0.7.7] - 2026-01-04

### Fixed

- Linux: Desktop icon now appears in application menu after installing .deb/.rpm packages
  - Icons are now installed to hicolor icon theme in all required sizes (16x16 through 512x512)
  - Added StartupWMClass to .desktop file for proper window grouping in taskbar

## [0.7.6] - 2026-01-03

### Added

- Linux: Now builds Snap packages for Snap Store users (x64 only)
- Linux: Now builds Flatpak packages for Flathub users (x64 only)
- Download page: Added Snap and Flatpak options to Linux format picker
- Download page: Install commands for each Linux format (apt, dnf, snap, flatpak)
- Download page: Copy button for each install command

### Changed

- Linux packages now use consistent naming: facebook-messenger-desktop-{arch}.{ext}
- Download page: Detected platform is now hidden from Other platforms section
- Download page: Linux section shows clean format list with install instructions

## [0.7.5] - 2026-01-03

### Added

- Linux: Now builds .deb packages for Debian/Ubuntu users
- Linux: Now builds .rpm packages for Fedora/RHEL users
- Linux: Added ARM64 support for all package formats (Raspberry Pi, Pine64, etc.)
- Download page: Linux users now see a format picker with AppImage, .deb, and .rpm options
- Download page: Added toggle to switch between x64 and ARM64 builds

### Improved

- Download page: All Linux downloads now listed in "Other platforms" section
- Consistent file naming across all Linux formats (x64/arm64 instead of mixed amd64/x86_64/aarch64)

## [0.7.4] - 2026-01-03

### Fixed

- Notifications for old unread messages no longer appear when opening the app
  - Native notifications are now suppressed during initial 8-second startup period
  - Prevents Messenger from flooding notifications for messages that were already there

## [0.7.3] - 2026-01-04

### Fixed

- Windows: In-app uninstall now properly removes the app from Apps and Features
- Windows: Uninstaller now kills running Messenger process and removes taskbar pins
- macOS: Fixed Homebrew detection by using full path to brew executable
- Windows: Fixed dialog buttons showing ampersand instead of and

### Improved

- Simplified uninstall flow to single confirmation dialog on all platforms
- Added administrator permission notice to Windows uninstall dialog
- Install source detection now re-runs when app version changes (handles reinstall via different method)
- Consistent uninstall messaging across all platforms

## [0.7.2] - 2026-01-03

### Fixed

- Uninstall dialog no longer hangs - install source is now detected at startup and cached
- Uninstalling via Apps and Features now fully removes all app data (login, cache, etc.)
- macOS: Fixed Saved Application State cleanup using wrong bundle ID

### Improved

- Install source (winget/Homebrew/direct) is detected once on first run and cached permanently
  - No more slow winget/brew commands at uninstall time
  - Detection only happens once - install method never changes
- Complete data removal on all platforms during uninstall:
  - Windows: Now cleans both %APPDATA% and %LOCALAPPDATA% via NSIS uninstaller
  - macOS: Now also cleans Preferences, HTTPStorages, and WebKit directories
  - Linux: Now also cleans ~/.local/share directory
- Updated uninstall dialog text to correctly indicate automatic uninstall behavior

## [0.7.1] - 2026-01-03

### Improved

- Windows: Updates now download automatically instead of redirecting to download page
  - Installer downloads directly to Downloads folder with progress tracking
  - After download, app offers to run installer automatically
  - Built-in SmartScreen bypass instructions shown before quitting

## [0.7.0] - 2026-01-03

### Fixed

- Develop menu no longer appears in production builds (was showing on Windows/Linux)

## [0.6.8] - 2026-01-03

### Added

- Native download progress UI for updates:
  - Taskbar/dock progress bar shows download percentage
  - Title bar shows detailed progress (e.g., "Downloading update: 45% (34.2 MB / 67.5 MB) @ 2.3 MB/s")
  - System tray tooltip shows progress and speed
  - Windows: Taskbar flashes when download completes
- Develop menu (dev mode only) with testing tools:
  - Test Update Workflow: Simulates the full update download experience
  - Test Notification: Sends a test notification
  - Quick access to DevTools and Force Reload
- Dev mode now automatically kills existing production Messenger instances to avoid conflicts

### Fixed

- macOS: Download progress now shows in the custom title bar overlay (was only updating dock)

### Improved

- Uninstall dialog now appears immediately instead of waiting for package manager detection
- macOS: Uninstall now automatically moves app bundle to Trash after quit
- Windows: Uninstall now automatically runs the NSIS uninstaller after quit

### Changed

- Windows: Tray icon now uses rounded style to match the app icon

## [0.6.6] - 2026-01-02

### Fixed

- Uninstall now properly removes all app data, including cache directory (was causing login to persist after reinstall)
  - Windows: Now cleans both %APPDATA%\Messenger and %LOCALAPPDATA%\Messenger
  - macOS: Now cleans both ~/Library/Application Support/Messenger and ~/Library/Caches/Messenger
  - Linux: Now cleans both ~/.config/Messenger and ~/.cache/Messenger
- Fixed Windows uninstall cleanup command using incorrect PowerShell syntax for multiple paths

### Improved

- macOS: Uninstall now also removes Saved Application State (window position memory)
- Increased cleanup delay from 1 to 2 seconds for more reliable file deletion

## [0.6.5] - 2026-01-02

### Changed

- Windows: Auto-updates now redirect to download page instead of failing silently (temporary workaround until code signing is set up)

### Improved

- Download page now shows version number and release date (fetched from GitHub releases)

## [0.6.4] - 2026-01-02

### Fixed

- Windows: "Restart Now" for updates now properly quits the app to install the update

### Improved

- Uninstall now detects Homebrew (macOS) and winget (Windows) installations and runs the appropriate package manager uninstall command

## [0.6.3] - 2026-01-02

### Changed

- **Windows/Linux menus**: Reorganized menus to follow platform conventions
  - Help menu now contains: View on GitHub, Check for Updates, Uninstall, About
  - File menu simplified to just Quit
- **macOS**: View on GitHub in Messenger menu (unchanged, follows macOS conventions)

## [0.6.0] - 2026-01-02

### Added

- **GitHub link in About dialog** - All platforms now show a link to the project's GitHub page
- **Custom About dialog for Windows/Linux** - Beautiful, modern dialog matching macOS aesthetics with app icon, version, and GitHub link

### Fixed

- **"Messenger can't be closed" error during auto-update** - Fixed race condition in quit handler that prevented the NSIS installer from starting properly on Windows
- **Duplicate version display** - Windows no longer shows version in brackets (e.g., was showing "0.5.8 (0.5.8.0)")

### Changed

- About dialog now respects system dark/light mode on Windows/Linux
- macOS About panel now includes credits with GitHub URL

## [0.5.8] - 2026-01-02

### Changed

- **Update dialogs**: Replaced custom update window with native OS dialogs for a cleaner, more consistent experience

## [0.5.7] - 2026-01-02

### Fixed

- **Windows about dialog**: Version now displays correctly (e.g. "0.5.7" instead of "0.5.7.0")

### Improved

- **Uninstaller**: Now removes app from macOS dock and Windows taskbar when uninstalling
- **Uninstaller dialog**: Better formatting with spacing between lines on macOS

## [0.5.6] - 2026-01-02

### Fixed

- **Windows about dialog**: Version now displays correctly as "0.5.6" instead of "0.5.6.0"

## [0.5.5] - 2026-01-02

### Fixed

- **Update dialog fixes**: Restart button now shows correctly, window properly sized for all platforms, uses standard app icon
- **Windows system tray**: Fixed tray icon not appearing (was malformed ICO file)
- **Windows tray behavior**: Single-click now shows app (standard Windows convention)
- **Update install on quit**: If user clicks "Later" then quits, update installs silently without auto-restarting (respects user's choice to quit)

### Added

- Windows/Linux: "About Messenger" now in File menu

## [0.5.4] - 2026-01-02

### Fixed

- macOS: "Check for Updates" no longer shows a brief flash notification - now consistently uses the custom update window

## [0.5.3] - 2026-01-02

### Added

- **Visual update progress window** - New unified window shows download progress with speed indicator (works on all platforms)
- User now chooses when to download updates instead of automatic background downloads
- Single window transitions through all states: available → downloading → ready to install
- Cancel button during download, clear error messages if something fails

### Changed

- **macOS menu reorganization** - "Check for Updates" and "Uninstall" now under the Messenger app menu (more standard macOS behavior)
- Added standard Window menu on macOS for window management
- File menu now only contains standard items (Close Window)

### Fixed

- Updates no longer appear to "download forever" - errors are now shown to the user instead of silently failing

## [0.5.2] - 2026-01-02

### Fixed

- macOS dock icon now displays at correct size when app is running (removed custom dock icon override that caused oversized icon)
- Windows: Clicking taskbar icon now properly restores window when app is running in system tray
- Auto-update "Restart Now" now properly quits the app to install updates (previously just hid the window due to close-to-tray behavior)

## [0.5.1] - 2026-01-02

### Fixed

- Windows taskbar icon now displays correctly at all sizes (uses ICO file with multiple resolutions)

## [0.5.0] - 2026-01-02

### Added

- **Windows ARM support!** Native ARM64 builds for Windows on ARM devices
- **System tray** for Windows/Linux - app stays running in background when window is closed
- **Windows taskbar badges** show unread message count overlay
- Tray context menu with Show/Hide, Check for Updates, and Quit options
- External links (target="\_blank") now open in system browser instead of new Electron windows
- Platform and architecture logging on startup for debugging

### Changed

- **Windows/Linux now use native window frames** instead of custom title bar overlay (cleaner look)
- Improved Windows taskbar icon grouping with proper AppUserModelId
- Build scripts are now cross-platform compatible (works on Windows, macOS, Linux)
- Minimum window width adjusted to ensure sidebar always visible on Windows

### Fixed

- Windows notifications now show "Messenger" instead of app ID in final builds
- Muted conversations no longer trigger notifications
- Icon handling improved across all platforms (rounded icons for Windows/Linux)

### Technical

- Added `scripts/clean.js` for cross-platform build cleanup
- Icon generation scripts auto-install dependencies if missing
- Added `--force` flag to regenerate icons even if they exist
- Reduced logging noise in production builds

## [0.4.2] - 2026-01-02

### Changed

- Version bump

## [0.4.1] - 2026-01-01

### Fixed

- **No more notification spam on app launch!** Existing unread messages are now recorded before notifications are enabled
- Fixed notifications appearing for every message when opening "Message Requests" or other sections
- Added settling period after navigation to prevent false notifications when switching between views

### Technical

- MutationObserver now scans and records all existing unread conversations before accepting new notifications
- URL change detection triggers re-settling to handle SPA navigation
- Multiple scan passes ensure late-loading conversations are also recorded

## [0.4.0] - 2026-01-01

### Added

- **Audio & video calls now work!** Added camera and microphone permission support
- macOS entitlements for camera and microphone access (required for notarized builds)
- Permission handler for media access requests from messenger.com
- Notification permission prompt on first launch (macOS)

### Technical

- Added `entitlements.mac.plist` with camera, microphone, and JIT entitlements
- Added `setPermissionRequestHandler` and `setPermissionCheckHandler` for media permissions

## [0.3.1] - 2026-01-01

### Fixed

- Release workflow now requires CHANGELOG.md entry (no more broken changelog links)
- Added missing changelog entries for versions 0.1.8 through 0.3.0

## [0.3.0] - 2026-01-01

### Changed

- Version bump for stable release

## [0.2.3] - 2026-01-01

### Added

- Initial Winget support for Windows users (pending approval)

## [0.2.2] - 2026-01-01

### Changed

- Simplified artifact names by removing version numbers for cleaner direct download links

## [0.2.1] - 2026-01-01

### Added

- Automatic Homebrew cask update in release workflow

## [0.2.0] - 2026-01-01

### Added

- Homebrew installation support for macOS (`brew install apotenza92/tap/facebook-messenger-desktop`)
- Rounded app icon for README

## [0.1.9] - 2026-01-01

### Fixed

- Auto-updater now works on macOS (switched to zip format, added yml manifests to releases)
- Async/await handling in app initialization

## [0.1.8] - 2026-01-01

### Fixed

- Notifications now show correct thread when sidebar is scrolled

## [0.1.7] - 2026-01-01

### Added

- Custom DMG installer with branded background and icon for macOS

### Improved

- Notification fallback system now correctly identifies the sender by reading the newest thread from the chat list
- Simplified development workflow: `npm run start` for local testing, `npm run dist:*` for releases
- Auto-updater only runs in production builds (skipped in development mode)

### Fixed

- Notifications now show the correct sender name and message preview instead of the currently open conversation
- "Check for Updates" menu item disabled in development mode to avoid errors
- Removed redundant `start-dev.js` script in favor of simpler `dev.js`

## [0.1.6] - 2025-12-31

### Added

- Fallback notification system for when Messenger's service worker is unavailable
- Title-based unread count detection triggers native notifications

## [0.1.5] - 2025-12-30

### Added

- In-app uninstall command wipes Messenger data (user data, logs, temp) after quit with clearer prompts.
- Uninstall scheduling runs cleanup after exit to avoid immediate re-creation.

### Fixed

- Consistent `userData`/logs path pinned to `Messenger` to avoid spawning `facebook-messenger-desktop`.
- Window state uses pinned path; reset flags still supported.
- Mac build now produces separate arm64 and x64 DMGs with clearer names; Windows/Linux artifacts named more plainly.

## [0.1.4] - 2025-12-30

### Fixed

- macOS release artifacts are now signed and notarized (CI wired with Apple Developer credentials).

## [0.1.3] - 2025-12-30

### Fixed

- Window position/size now persists reliably; added one-time `--reset-window` flag for dev resets.
- Dev launches pass CLI args through; start script forwards args.

## [0.1.2] - 2025-12-30

### Fixed

- Release workflow stability and artifact scope (only dmg/exe/AppImage)
- Electron-builder config validation (DMG config moved to root)

## [0.1.1] - 2025-12-30

### Fixed

- Windows icon packaging (real multi-size ICO)
- Release workflow: prevent auto-publish, ensure release notes file is generated, and allow contents write

## [0.1.0] - 2025-12-30

### Added

- Initial beta release
