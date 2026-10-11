// Local-only review. Never echo untrusted payloads, hashes, names or paths.
const fs = require("node:fs");
const EVENTS = new Set([
  "network-worker-attached-late",
  "network-capture-ready",
  "network-capture-failed",
  "network-capture-detached",
  "network-capture-limit",
  "network-tracking-limit",
  "network-payload",
  "network-request",
  "network-response",
  "network-complete",
  "network-failed",
  "network-body-skipped",
  "network-body-unavailable",
  "network-socket-open",
  "network-socket-close",
  "network-socket-error",
  "native-probe-registered",
  "native-preload-started",
  "native-hooks-ready",
  "native-hooks-failed",
  "native-hooks-health",
  "metadata-unavailable",
  "worker-capture-ready",
  "worker-capture-failed",
  "worker-capture-late",
  "worker-capture-detached",
  "worker-attached",
  "native-constructed",
  "native-construction-failed",
  "native-closed",
  "native-show",
  "native-error",
  "native-click",
  "native-close-event",
  "permission-request",
  "permission-result",
  "service-worker-show",
  "service-worker-show-resolved",
  "service-worker-show-rejected",
  "get-notifications",
  "get-notifications-result",
  "get-notifications-rejected",
  "worker-push",
  "worker-notificationclick",
  "worker-notificationclose",
  "push-subscribe-request",
  "push-subscribe-result",
  "push-subscribe-rejected",
  "push-getSubscription-request",
  "push-getSubscription-result",
  "push-getSubscription-rejected",
  "push-permissionState-request",
  "push-permissionState-result",
  "push-permissionState-rejected",
  "app-sent",
  "row-change",
  "row-change-limit",
  "local-send",
  "marker",
  "suspend",
  "resume",
]);
const hash = (value) =>
  typeof value === "string" && /^[a-z0-9]{1,16}$/.test(value) ? value : null;
function summarize(text) {
  const counts = {};
  let invalidLines = 0,
    unknownEvents = 0,
    run = 0,
    healthFailures = 0,
    nativeModeRuns = 0;
  const native = [],
    shadow = [],
    network = [];
  const transports = new Set();
  const contexts = new Set();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      invalidLines++;
      continue;
    }
    if (!row || !EVENTS.has(row.event)) {
      unknownEvents++;
      continue;
    }
    counts[row.event] = (counts[row.event] || 0) + 1;
    if (row.event === "native-probe-registered") {
      run++;
      if (row.nativePresentation === true) nativeModeRuns++;
    }
    if (
      row.event === "native-hooks-ready" &&
      ["frame", "service-worker"].includes(row.context)
    )
      contexts.add(row.context);
    if (
      row.event === "native-hooks-health" &&
      [
        row.closeHook,
        row.constructorHook,
        row.showNotificationHook,
        row.getNotificationsHook,
      ].includes(false)
    )
      healthFailures++;
    const at = Number.isFinite(row.receivedAt) ? row.receivedAt : row.pageTime;
    if (!Number.isFinite(at)) continue;
    if (row.event === "network-payload" && row.direction === "received") {
      if (["http", "websocket", "eventsource"].includes(row.transport))
        transports.add(row.transport);
      if (Array.isArray(row.threadHashes))
        for (const value of row.threadHashes.slice(0, 20)) {
          const hashed = hash(value);
          if (hashed) network.push({ run, at, hash: hashed });
        }
    }
    const entry = { run, at, hash: hash(row.threadHash) };
    if (["native-constructed", "service-worker-show"].includes(row.event))
      native.push(entry);
    if (row.event === "app-sent") shadow.push(entry);
  }
  let comparable = 0,
    nearby = 0;
  for (const row of shadow) {
    if (!row.hash) continue;
    comparable++;
    if (
      native.some(
        (n) =>
          n.run === row.run &&
          n.hash === row.hash &&
          Math.abs(n.at - row.at) <= 5000,
      )
    )
      nearby++;
  }
  const warnings = [];
  if (!nativeModeRuns)
    warnings.push(
      "No confirmed real-native mode: older captures may have suppressed notifications.",
    );
  if (!contexts.has("frame"))
    warnings.push("No frame hook readiness evidence.");
  if (!contexts.has("service-worker"))
    warnings.push(
      "No worker hook readiness evidence; no observed worker is also possible.",
    );
  if (
    counts["worker-capture-failed"] ||
    counts["native-hooks-failed"] ||
    healthFailures
  )
    warnings.push(
      "Capture failed or hooks were replaced; zero calls cannot establish zero Facebook notifications.",
    );
  if (counts["network-worker-attached-late"])
    warnings.push(
      "Dedicated-worker network attachment is passive and late; startup traffic may be missing.",
    );
  if (counts["worker-capture-late"])
    warnings.push(
      "Existing workers were attached late: previously cached methods may bypass capture.",
    );
  if (counts["worker-capture-detached"])
    warnings.push("Debugger detached: later worker activity may be missing.");
  if (counts["row-change-limit"])
    warnings.push("Sidebar sampling hit its limit. Native capture continues.");
  if (counts["push-subscribe-rejected"])
    warnings.push(
      "Push subscription failed: inspect transport availability in a controlled test.",
    );
  if (!counts["network-capture-ready"])
    warnings.push("No network capture readiness evidence.");
  if (counts["network-capture-failed"] || counts["network-capture-detached"])
    warnings.push(
      "Network capture failed or detached; traffic may be missing.",
    );
  if (
    counts["network-capture-limit"] ||
    counts["network-tracking-limit"] ||
    counts["network-body-skipped"] ||
    counts["network-body-unavailable"]
  )
    warnings.push(
      "Network sampling was limited or response bodies unavailable; payload coverage is incomplete.",
    );
  if (invalidLines)
    warnings.push("Invalid/incomplete NDJSON lines were skipped.");
  return {
    nativeModeRuns,
    readyContexts: [...contexts].sort(),
    eventCounts: counts,
    healthFailures,
    invalidLines,
    unknownEvents,
    network: {
      incomingTransports: [...transports].sort(),
      nativeCallsWithHash: native.filter((n) => n.hash).length,
      nativeCallsNearIncomingNetwork: native.filter(
        (n) =>
          n.hash &&
          network.some(
            (r) =>
              r.run === n.run &&
              r.hash === n.hash &&
              Math.abs(n.at - r.at) <= 5000,
          ),
      ).length,
    },
    correlation: {
      windowSeconds: 5,
      sidebarAttemptsWithHash: comparable,
      attemptsNearNativeCall: nearby,
      attemptsWithoutNearbyNativeCall: comparable - nearby,
    },
    warnings,
    interpretation:
      "Calls and timing correlations do not prove OS display, correctness, delivery completeness or muted/read suppression. Hashes are scoped to an app run.",
  };
}
module.exports = { summarize };
if (require.main === module) {
  const files = process.argv.slice(2);
  if (!files.length) {
    console.error(
      "Usage: npm run review:notification:probe -- <private-capture.ndjson> [another-capture.ndjson]",
    );
    process.exitCode = 1;
  } else
    try {
      console.log(
        JSON.stringify(
          files.map((file, i) => ({
            capture: i + 1,
            ...summarize(fs.readFileSync(file, "utf8")),
          })),
          null,
          2,
        ),
      );
    } catch {
      console.error(
        "Unable to read a capture. Check the supplied local files.",
      );
      process.exitCode = 1;
    }
}
