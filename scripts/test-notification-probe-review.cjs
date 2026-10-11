const assert = require("node:assert/strict");
const { summarize } = require("./review-notification-probe.cjs");
const rows = [
  { event: "native-probe-registered", nativePresentation: true },
  { event: "native-hooks-ready", context: "frame" },
  { event: "service-worker-show", threadHash: "abc", receivedAt: 1000 },
  { event: "app-sent", threadHash: "abc", receivedAt: 2000 },
  { event: "native-probe-registered", nativePresentation: true },
  { event: "app-sent", threadHash: "abc", receivedAt: 3000 },
  { event: "worker-capture-late" },
  { event: "row-change-limit" },
  { event: "Private content", body: "Private" },
];
const report = summarize(
  rows.map((r) => JSON.stringify(r)).join("\n") + "\npartial",
);
assert.equal(
  report.correlation.attemptsNearNativeCall,
  1,
  "do not correlate across app runs",
);
assert.equal(report.correlation.attemptsWithoutNearbyNativeCall, 1);
assert.equal(report.invalidLines, 1);
assert.equal(report.unknownEvents, 1);
assert(report.warnings.some((w) => w.includes("late")));
assert(!JSON.stringify(report).includes("Private"));
assert(summarize("").warnings.some((w) => w.includes("No confirmed")));
console.log(
  "[NotificationProbeReview] Missing coverage, run boundaries, truncation and private-content checks passed",
);
