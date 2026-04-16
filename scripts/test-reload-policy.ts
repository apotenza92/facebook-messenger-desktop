const {
  decideMessengerReload,
} = require("../src/main/reload-policy.ts");

function assertEqual(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}\nexpected: ${JSON.stringify(expected)}\nactual:   ${JSON.stringify(actual)}`,
    );
  }
}

function run() {
  assertEqual(
    decideMessengerReload({ debugExportUiActive: false }),
    { allowed: true, reason: "allowed" },
    "Reload should stay allowed when the debug export UI is inactive",
  );

  assertEqual(
    decideMessengerReload({ debugExportUiActive: true }),
    { allowed: false, reason: "debug-export-ui-active" },
    "Reload should be suppressed while the debug export UI is active",
  );

  console.log("PASS reload policy tests");
}

run();
