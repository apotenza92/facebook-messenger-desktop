# Native Facebook notification diagnostics

Normal operation denies Facebook browser notification permission, replaces the
page's `Notification` API and uses the app's sidebar/policy engine to send native
Electron alerts. The opt-in diagnostics mode changes this deliberately: Facebook
can use the actual browser APIs, its service-worker registrations are retained,
and the sidebar engine records attempted alerts without displaying duplicates.
Facebook may display notifications the usual app filters. Stop diagnostics and
restart to restore normal behavior. This is an experiment, not a replacement
notification engine or a promise of Chrome-equivalent background delivery.

## Why the earlier capture was insufficient

The previous hooks were installed after page loading. Facebook could cache an
original constructor before the hooks existed. Its page-world
`ServiceWorkerRegistration` wrapper did not observe calls executing inside an
actual worker. Registrations were also cleared, while page notifications were
recorded and suppressed. Therefore zero native events in those logs cannot
establish that Facebook never generated native notifications.

Frame hooks now run before page scripts via a session preload. The isolated
bridge accepts only the trusted main Messenger frame. Trusted service workers
are attached through Chromium's debugger and instrumented at the first script
execution breakpoint before they can cache their notification methods. Auto-attachment
is restricted to service workers so unrelated workers and cross-origin frames
continue loading normally. Worker
setup has a two-second watchdog and command deadlines, releasing paused workers
on failure. Already-running workers are explicitly labelled late; cached methods
in them cannot be recovered retrospectively. Opening DevTools can detach worker
capture, and the log records this. Subframes and unrelated windows are outside
the current frame capture boundary.

## What is observed

- Page notification construction, native show/error/click/close events and
  explicit `close()` calls, including calls through cached constructors.
- Actual worker `showNotification()` calls, promise resolution/rejection,
  `getNotifications()` calls/results and notification close calls. Synchronous
  constructor failures and known error categories are recorded without error text.
- Worker push arrival and notification click/close events. Push content is never
  inspected. No synthetic push is injected into a live Facebook account.
- Facebook's calls to `PushManager.subscribe()`, `getSubscription()` and
  `permissionState()`, their success/failure, and subscription presence. No push
  endpoint, authentication key or application-server key is recorded. The probe
  does not initiate subscriptions itself.
- Permission state, focus, visibility, online state, hook readiness and periodic
  health checks to detect overwritten methods. Health records occur every minute
  and on frame focus/network/visibility transitions.
- Option names, title/body/tag lengths, salted tag/thread hashes, candidate
  thread locations under known data keys, value types, icon category, action
  count, silent/renotify/requireInteraction flags and timestamp age.
- Existing sidebar comparison, local-send markers, row changes and sleep/wake
  context. Sidebar changes are capped at 3,000 per page; hitting that cap emits
  `row-change-limit`. Native capture continues independently.

Metadata inspection must not change native return values, notification objects
or rejection reasons. The main-process native bridge reconstructs an allowlisted
record, dropping arbitrary strings, unknown keys and unsupported data paths.
Thread matching is a hypothesis: long numeric tags/known data values are candidate
thread IDs, not independently verified identifiers. Hashes use the same random
salt throughout one app run and change after restarting. Hashes support local
correlation; they are not encryption and should still be handled as private data.

## Controlled live test on each platform

Use a beta/development build containing this change. Tests below supplement the
deterministic suite; they do not replace it. Start with short, deliberate cases
instead of collecting unlabelled logs for days.

1. Enable **Help → Record Notification Diagnostics**, read the behavior notice
   and restart. Ensure Facebook's own website notification setting and the OS
   notification setting permit alerts. Do not change other accounts or send
   messages automatically.
2. Confirm `native-probe-registered` has `nativePresentation: true`, followed by
   frame `native-hooks-ready` with successful flags. A worker needs its own
   readiness event. `worker-capture-ready` alone only confirms debugger setup.
   Record the exact app/platform versions and site settings in private notes.
3. Add a diagnostics marker before each case, then record in private notes
   whether a native alert appeared, stayed visible, disappeared or opened the
   expected conversation. Use neutral case labels, never private message text.
4. Test the matrix below with a cooperating tester or naturally arriving events.
   Note the user action and OS result separately from API events.
5. Stop recording on both machines and restart. Preserve both the current
   `notification-probe.ndjson` and its `.1` rotated predecessor if present.
   Keep original logs private; share only reviewed aggregate conclusions.

| Case                                                   | What to establish                                                |
| ------------------------------------------------------ | ---------------------------------------------------------------- |
| Incoming message while focused on its conversation     | Facebook's focus/read suppression                                |
| Incoming message while focused on another conversation | Page versus worker notification source                           |
| App hidden/minimized or unfocused                      | Native display, tag reuse, click destination                     |
| Several messages in one thread, then another thread    | Replacement/coalescing and tag semantics                         |
| Muted conversation                                     | Whether Facebook emits or suppresses the native call             |
| Own message sent from this device and another device   | Self-message suppression and synchronization                     |
| Read on another device before/after alert              | Close/getNotifications behavior and stale alert removal          |
| Sleep/wake and offline/online recovery                 | Catch-up, duplicate suppression and timestamp age                |
| Reaction, group/admin activity and incoming call       | What Facebook natively treats as an alert                        |
| Other interface language                               | Native delivery without English preview detection                |
| Page reload and app restart                            | Hook readiness, registration persistence, late worker gaps       |
| App fully quit                                         | Whether any background delivery exists independently of Electron |

For a browser comparison, repeat matching cases in a normal supported browser
with the same website notification settings and separately verify OS permission.
Compare observed delivery, rather than assuming Electron's Chromium engine has
all Chrome services. Electron's upstream [Web Push issue](https://github.com/electron/electron/issues/6697)
reports a missing push transport. Electron's
[`pushNotifications` API](https://www.electronjs.org/docs/latest/api/push-notifications)
provides APNS integration; it is not an automatic bridge to Facebook's existing
browser push subscriptions. The experiment needs to establish whether Facebook
uses page-driven calls while connected, Web Push, or both in this runtime.

## Local review and interpretation

```sh
npm run review:notification:probe -- /private/path/mac.ndjson /private/path/pc.ndjson
```

The command is offline and prints aggregate counts and coverage warnings only.
Each input is summarized separately; combine rotated segments in chronological
order privately if reviewing a complete run. Unknown events are counted without
printing their names or values. Incomplete lines are reported. Five-second
same-thread correlations are descriptive timing evidence, not delivery accuracy.
Run boundaries prevent matching unrelated restarted captures.

A `native-constructed` or `service-worker-show` record is an API attempt, not proof
that an OS banner appeared. Promise resolution and native `show` events provide
additional evidence, but manual observation is still required. No `worker-push`
records can mean no push traffic, unavailable transport, no registration, late
attachment or capture failure. Readiness/health must be evaluated before interpreting
zero events. Native capture changes permissions and keeps a debugger attached,
which can affect scheduling and worker lifetime; this is an instrumented experiment.

Retiring the sidebar engine requires repeated evidence on macOS, Windows and
Linux that incoming delivery, focus/read/mute handling, own messages, wake
recovery, coalescing, closure and clicks work through native APIs. If only page
notifications work, that may still remove text heuristics while the app is
running, but it does not establish notifications while the app is quit. If Web
Push fails, a separate supported transport or browser/PWA approach must be
assessed; hardcoded word detection does not solve that boundary.

## Deterministic checks

```sh
npm run build
npm run test:notification:probe
npm run test:ci
```

The real Electron fixture runs only against a local HTTP server and fresh
nonpersistent partition, with no Facebook account or external requests. It
constructs a notification in a parser-time script, caches the constructor,
registers a real worker whose first line caches `showNotification`, and proves
late sidebar injection preserves native APIs. These checks also verify shared
hashes and absence of fixture content/IDs/URLs in captured records. Unit fixtures
verify native return values, errors, health checks, push payload noninspection,
and allowlisted metadata. OS notification display and live Facebook policy remain
separate supplemental checks.
