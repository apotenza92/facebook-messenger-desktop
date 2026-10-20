const {
  decideMoveToApplicationsPrompt,
} = require("../src/main/move-to-applications-policy.ts");

function assertEqual(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}\nexpected: ${JSON.stringify(expected)}\nactual:   ${JSON.stringify(actual)}`,
    );
  }
}

const homeDir = "/Users/tester";
const base = {
  platform: "darwin",
  isDev: false,
  homeDir,
  alreadyPrompted: false,
};
const exeIn = (bundle) => `${bundle}/Contents/MacOS/Messenger Beta`;

function run() {
  assertEqual(
    decideMoveToApplicationsPrompt({
      ...base,
      exePath: exeIn("/Applications/Messenger Beta.app"),
    }),
    { prompt: false, reason: "installed" },
    "An app already in /Applications should not offer to move",
  );

  assertEqual(
    decideMoveToApplicationsPrompt({
      ...base,
      exePath: exeIn(`${homeDir}/Applications/Messenger Beta.app`),
    }),
    { prompt: false, reason: "installed" },
    "An app in ~/Applications should not offer to move",
  );

  // A quarantined app that Finder never moved runs from a read-only App
  // Translocation mirror of its real location. Offering to move it would
  // replace the real copy with one that cannot be moved.
  assertEqual(
    decideMoveToApplicationsPrompt({
      ...base,
      exePath: exeIn(
        "/private/var/folders/ab/cd/T/AppTranslocation/0F1E2D3C-4B5A-6978-8796-A5B4C3D2E1F0/d/Messenger Beta.app",
      ),
    }),
    { prompt: false, reason: "translocated" },
    "A translocated app should not offer to move or replace its real copy",
  );

  assertEqual(
    decideMoveToApplicationsPrompt({
      ...base,
      exePath: exeIn(`${homeDir}/Downloads/Messenger Beta.app`),
    }),
    {
      prompt: true,
      appBundlePath: `${homeDir}/Downloads/Messenger Beta.app`,
      destinationPath: "/Applications/Messenger Beta.app",
    },
    "An app run from Downloads should offer to move into /Applications",
  );

  assertEqual(
    decideMoveToApplicationsPrompt({
      ...base,
      alreadyPrompted: true,
      exePath: exeIn(`${homeDir}/Downloads/Messenger Beta.app`),
    }),
    { prompt: false, reason: "already-prompted" },
    "The move prompt should only be offered once",
  );

  assertEqual(
    decideMoveToApplicationsPrompt({
      ...base,
      platform: "win32",
      exePath: "C:\\Program Files\\Messenger Beta\\Messenger Beta.exe",
    }),
    { prompt: false, reason: "not-macos" },
    "Only macOS offers to move into Applications",
  );

  console.log("[MoveToApplications] policy tests passed");
}

run();
