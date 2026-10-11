const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const {
  describeNetworkPayload,
  networkHash,
  createNotificationNetworkProbe,
} = require("../dist/main/notification-network-probe");
const salt = "fixture-salt";
const input = {
  notification: {
    thread_id: "100000000009999",
    body: "Private message",
    is_unread: true,
  },
  "Private Name": { token: "Private token" },
  payload: JSON.stringify({ threadId: "100000000009999", muted: false }),
};
const result = describeNetworkPayload(Buffer.from(JSON.stringify(input)), salt);
assert.equal(result.format, "json");
assert.deepEqual(result.threadHashes, [networkHash(salt, "100000000009999")]);
assert(
  result.fields.some((f) => f.path.endsWith(".is_unread") && f.value === true),
);
assert(
  result.fields.some((f) => f.path.endsWith(".muted") && f.value === false),
);
assert(!JSON.stringify(result).includes("Private"));
assert(!JSON.stringify(result).includes("100000000009999"));
assert.equal(
  describeNetworkPayload(Buffer.alloc(512 * 1024 + 1), salt).format,
  "oversize",
);
assert.equal(
  describeNetworkPayload(Buffer.from([0x30, 5, 0, 9, 1, 2, 3]), salt, true)
    .format,
  "malformed-mqtt",
);
assert.equal(
  describeNetworkPayload(Buffer.from("for (;;);" + JSON.stringify(input)), salt)
    .format,
  "json",
);
assert(
  describeNetworkPayload(
    Buffer.from(JSON.stringify(input) + "\n" + JSON.stringify(input)),
    salt,
  ).fields.length,
);
(async () => {
  const debuggerApi = new EventEmitter(),
    events = [],
    commands = [];
  let destroyed = false;
  const wc = {
    get debugger() {
      if (destroyed) throw new Error("Object has been destroyed");
      return debuggerApi;
    },
  };
  const probe = createNotificationNetworkProbe({
    webContents: wc,
    salt,
    isTrustedUrl: (url) => new URL(url).hostname === "fixture.invalid",
    record: (r) => events.push(r),
    send: async (method, params) => {
      commands.push(method);
      return { body: JSON.stringify(input) };
    },
  });
  await probe.enable();
  const emit = (method, params) =>
    debuggerApi.emit("message", {}, method, params, "");
  emit("Network.requestWillBeSent", {
    requestId: "private-id",
    type: "Fetch",
    request: {
      url: "https://untrusted.invalid/graphql",
      method: "POST",
      postData: JSON.stringify(input),
    },
  });
  emit("Network.loadingFinished", {
    requestId: "private-id",
    encodedDataLength: 1,
  });
  assert(!commands.includes("Network.getResponseBody"));
  emit("Network.requestWillBeSent", {
    requestId: "private-id",
    type: "Fetch",
    request: {
      url: "https://fixture.invalid/graphql?token=Private",
      method: "POST",
      postData: JSON.stringify(input),
    },
  });
  emit("Network.responseReceived", {
    requestId: "private-id",
    response: {
      url: "https://fixture.invalid/graphql",
      mimeType: "application/json",
      status: 200,
    },
  });
  emit("Network.dataReceived", {
    requestId: "private-id",
    dataLength: 600 * 1024,
  });
  emit("Network.loadingFinished", {
    requestId: "private-id",
    encodedDataLength: 1,
  });
  assert(
    events.some(
      (r) => r.event === "network-body-skipped" && r.reason === "oversize",
    ),
  );
  assert(
    !commands.includes("Network.getResponseBody"),
    "compressed large body must not be fetched",
  );
  for (let i = 0; i < 650; i++)
    emit("Network.requestWillBeSent", {
      requestId: String(i),
      type: "Fetch",
      request: { url: "https://fixture.invalid/graphql", method: "GET" },
    });
  assert.equal(
    events.filter((r) => r.event === "network-capture-limit").length,
    1,
  );
  assert(!JSON.stringify(events).includes("Private"));
  assert(!JSON.stringify(events).includes("private-id"));
  destroyed = true;
  assert.doesNotThrow(
    () => probe.dispose(),
    "destroyed WebContents cleanup must be safe",
  );
  assert.equal(debuggerApi.listenerCount("message"), 0);
  console.log(
    "[NotificationNetworkProbe] Structure, nested JSON, trust, limits, ID correlation and privacy checks passed",
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
