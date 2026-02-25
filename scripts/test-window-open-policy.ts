import {
  decideWindowOpenAction,
  type WindowOpenAction,
} from "../src/main/url-policy";

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(
      `${message}\n  expected: ${String(expected)}\n  actual:   ${String(actual)}`,
    );
  }
}

function expectAction(url: string, expected: WindowOpenAction): void {
  const actual = decideWindowOpenAction(url);
  assertEqual(actual, expected, `Window-open action mismatch for ${url}`);
}

function run(): void {
  // Should stay as child windows (call-like flows)
  expectAction("about:blank", "allow-child-window");
  expectAction(
    "https://www.facebook.com/videochat/",
    "allow-child-window",
  );
  expectAction(
    "https://www.messenger.com/call/start/?thread_id=123",
    "allow-child-window",
  );

  // Should be rerouted into the main view (media viewer overlays)
  expectAction(
    "https://www.facebook.com/messages/media_viewer/?thread_id=123",
    "reroute-main-view",
  );
  expectAction(
    "https://www.facebook.com/photo/?fbid=12345",
    "reroute-main-view",
  );

  // Should trigger native download handling
  expectAction(
    "https://scontent-syd2-1.xx.fbcdn.net/v/t39.30808-6/example.jpg",
    "download-media",
  );

  // Message thread links should stay in-app
  expectAction("https://www.facebook.com/messages/t/123", "reroute-main-view");

  // Non-messages links should open externally in system browser
  expectAction("https://www.messenger.com/t/123", "open-external-browser");
  expectAction("https://www.facebook.com/groups/some-group", "open-external-browser");
  expectAction("https://example.com/call", "open-external-browser");

  console.log("PASS window-open policy regression tests");
}

try {
  run();
} catch (error) {
  console.error("FAIL window-open policy regression tests failed:", error);
  process.exit(1);
}
