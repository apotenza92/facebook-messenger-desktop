import type { WebContents } from "electron";

const MAX_BODY = 512 * 1024;
const MAX_TRACKED = 500;
const MAX_EVENTS_PER_MINUTE = 600;
// Never export arbitrary payload keys: user names and IDs can themselves be keys.
const KEYS = new Set([
  "data",
  "payload",
  "variables",
  "extensions",
  "errors",
  "error",
  "code",
  "notification",
  "notifications",
  "notification_type",
  "notification_id",
  "thread_id",
  "threadId",
  "conversation_id",
  "conversationId",
  "thread_key",
  "thread_fbid",
  "other_user_id",
  "message_id",
  "messageId",
  "sender_id",
  "actor_id",
  "id",
  "body",
  "text",
  "title",
  "message",
  "messages",
  "snippet",
  "is_unread",
  "unread",
  "unread_count",
  "is_read",
  "read",
  "read_receipt",
  "muted",
  "is_muted",
  "mute_until",
  "timestamp",
  "time",
  "type",
  "event",
  "delta",
  "deltas",
  "class",
  "seq",
  "sequence_id",
  "sync_token",
  "queue",
  "tasks",
  "task_id",
  "label",
  "request_id",
  "version",
  "step",
  "steps",
  "sp",
  "deps",
  "epoch_id",
  "lastIssuedSeqId",
  "firstDeltaSeqId",
  "lastIssuedSeqId",
  "deltaNewMessage",
  "messageMetadata",
  "threadKey",
  "threadFbId",
  "otherUserFbId",
  "messageId",
  "actorFbId",
  "offlineThreadingId",
  "push",
  "subscription",
  "endpoint",
  "keys",
  "auth",
  "p256dh",
  "token",
  "access_token",
  "cookie",
  "url",
  "href",
  "sound",
  "silent",
  "renotify",
  "requireInteraction",
  "tag",
  "actions",
  "badge",
  "icon",
  "is_group_thread",
  "fb_api_req_friendly_name",
  "doc_id",
  "operationName",
  "query",
  "result",
]);
const THREAD_KEYS = new Set([
  "thread_id",
  "threadId",
  "conversation_id",
  "conversationId",
  "thread_fbid",
  "threadFbId",
  "other_user_id",
  "otherUserFbId",
]);
const STATE_KEYS = new Set([
  "is_unread",
  "unread",
  "is_read",
  "read",
  "muted",
  "is_muted",
  "silent",
  "renotify",
  "requireInteraction",
]);
const SENSITIVE_KEYS = new Set([
  "body",
  "text",
  "title",
  "snippet",
  "token",
  "access_token",
  "cookie",
  "endpoint",
  "auth",
  "p256dh",
  "sync_token",
  "query",
  "url",
  "href",
]);
export const networkHash = (salt: string, value: string): string => {
  let h = 0x811c9dc5;
  for (const c of `${salt}:${value}`) {
    h ^= c.charCodeAt(0);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
};

// Inspect only bounded structure. Values, raw URLs, headers and payloads never
// enter the log. Parsing nested JSON helps observe MQTT/GraphQL envelopes.
export function describeNetworkPayload(
  bytes: Buffer,
  salt: string,
  binary = false,
) {
  const fields: Record<string, unknown>[] = [];
  const threadHashes = new Set<string>();
  let format = "opaque",
    truncated = false;
  let mqtt: Record<string, unknown> | undefined;
  if (bytes.length > MAX_BODY)
    return { format: "oversize", bytes: bytes.length, truncated: true };
  let body = bytes;
  if (binary && bytes.length >= 2) {
    const packetType = bytes[0] >>> 4;
    let length = 0,
      multiplier = 1,
      offset = 1,
      ended = false;
    for (let i = 0; i < 4 && offset < bytes.length; i++) {
      const digit = bytes[offset++];
      length += (digit & 127) * multiplier;
      multiplier *= 128;
      if (!(digit & 128)) {
        ended = true;
        break;
      }
    }
    if (
      packetType >= 1 &&
      packetType <= 14 &&
      ended &&
      offset + length === bytes.length
    ) {
      format = "mqtt";
      mqtt = {
        packetType,
        qos: (bytes[0] >>> 1) & 3,
        retain: Boolean(bytes[0] & 1),
      };
      if (packetType === 3 && offset + 2 <= bytes.length) {
        const topicLength = bytes.readUInt16BE(offset);
        offset += 2;
        if (offset + topicLength > bytes.length)
          return { format: "malformed-mqtt", bytes: bytes.length };
        const topic = bytes
          .subarray(offset, offset + topicLength)
          .toString("utf8");
        mqtt.topicKind = [
          "/ls_resp",
          "/ls_req",
          "/t_ms",
          "/messenger_sync_get_diffs",
          "/messenger_sync_create_queue",
        ].includes(topic)
          ? topic
          : "other";
        mqtt.topicHash = networkHash(salt, topic);
        offset += topicLength + ((bytes[0] >>> 1) & 3 ? 2 : 0);
        if (offset > bytes.length)
          return { format: "malformed-mqtt", bytes: bytes.length };
        body = bytes.subarray(offset);
      } else body = Buffer.alloc(0);
    }
  }
  const walk = (value: unknown, path: string, depth: number, key = "") => {
    if (fields.length >= 80 || depth > 8) {
      truncated = true;
      return;
    }
    const type =
      value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    const field: Record<string, unknown> = { path, type };
    if (typeof value === "boolean" && STATE_KEYS.has(key)) field.value = value;
    if (
      typeof value === "string" &&
      ["fb_api_req_friendly_name", "operationName"].includes(key)
    )
      field.operationHash = networkHash(salt, value);
    if (typeof value === "string") field.length = value.length;
    if (Array.isArray(value)) field.count = value.length;
    fields.push(field);
    if (
      THREAD_KEYS.has(key) &&
      (typeof value === "string" || Number.isSafeInteger(value)) &&
      /^\d{8,20}$/.test(String(value))
    )
      threadHashes.add(networkHash(salt, String(value)));
    if (SENSITIVE_KEYS.has(key)) return;
    if (
      typeof value === "string" &&
      ["payload", "data", "variables"].includes(key)
    ) {
      try {
        walk(JSON.parse(value), `${path}.$json`, depth + 1);
      } catch {
        /* opaque */
      }
    } else if (Array.isArray(value)) {
      for (const item of value.slice(0, 5)) walk(item, `${path}[]`, depth + 1);
      if (value.length > 5) truncated = true;
    } else if (value && typeof value === "object") {
      const entries = Object.entries(value);
      if (entries.length > 40) truncated = true;
      for (const [name, child] of entries.slice(0, 40)) {
        const label = KEYS.has(name)
          ? name
          : `keyHash:${networkHash(salt, name)}`;
        walk(child, `${path}.${label}`, depth + 1, name);
      }
    }
  };
  const text = body.toString("utf8").replace(/^for\s*\(;;\);\s*/, "");
  try {
    walk(JSON.parse(text), "$", 0);
    if (format !== "mqtt") format = "json";
  } catch {
    // GraphQL streaming/batched responses may be newline-delimited JSON.
    const lines = text.split("\n").filter((line) => line.trim());
    if (lines.length > 1) {
      for (const line of lines.slice(0, 5)) {
        try {
          walk(JSON.parse(line), "$[]", 0);
        } catch {
          /* no raw fallback */
        }
      }
      if (fields.length && format !== "mqtt") format = "ndjson";
      if (lines.length > 5) truncated = true;
    }
  }
  return {
    format,
    bytes: bytes.length,
    fields,
    threadHashes: [...threadHashes].slice(0, 20),
    truncated,
    ...(mqtt ? { mqtt } : {}),
  };
}

type Send = (
  method: string,
  params: Record<string, unknown>,
  sessionId?: string,
) => Promise<Record<string, unknown>>;
export function createNotificationNetworkProbe(options: {
  webContents: WebContents;
  salt: string;
  isTrustedUrl: (url: string) => boolean;
  record: (record: Record<string, unknown>) => void;
  send: Send;
}) {
  type Entry = {
    id: number;
    context: string;
    route: string;
    at: number;
    mime?: string;
    bytes?: number;
  };
  const debuggerApi = options.webContents.debugger;
  const requests = new Map<string, Entry>();
  const sockets = new Map<string, Entry>();
  const enabled = new Set<string>();
  const contexts = new Map<string, string>();
  const attachedWorkers = new Set<string>();
  let browserContextId: string | undefined;
  let sequence = 0,
    minute = Date.now(),
    eventCount = 0,
    pending = 0,
    closed = false;
  const emit = (event: string, data: Record<string, unknown> = {}) => {
    if (closed) return;
    if (Date.now() - minute >= 60000) {
      minute = Date.now();
      eventCount = 0;
    }
    if (++eventCount > MAX_EVENTS_PER_MINUTE) {
      if (eventCount === MAX_EVENTS_PER_MINUTE + 1)
        options.record({
          event: "network-capture-limit",
          receivedAt: Date.now(),
          limit: MAX_EVENTS_PER_MINUTE,
        });
      return;
    }
    options.record({ event, ...data, receivedAt: Date.now() });
  };
  const route = (url: string): string | null => {
    try {
      const parsed = new URL(url);
      parsed.protocol =
        parsed.protocol === "wss:"
          ? "https:"
          : parsed.protocol === "ws:"
            ? "http:"
            : parsed.protocol;
      if (!options.isTrustedUrl(parsed.href)) return null;
      if (/graphql/i.test(parsed.pathname)) return "graphql";
      if (/mqtt|chat|realtime/i.test(parsed.hostname + parsed.pathname))
        return "realtime";
      if (/push|notification/i.test(parsed.pathname)) return "notification";
      return "other";
    } catch {
      return null;
    }
  };
  const safeEntry = (entry: Entry) => ({
    id: entry.id,
    context: entry.context,
    route: entry.route,
  });
  const payload = (
    entry: Entry,
    transport: string,
    direction: string,
    bytes: Buffer,
    binary = false,
  ) =>
    emit("network-payload", {
      ...safeEntry(entry),
      transport,
      direction,
      ...describeNetworkPayload(bytes, options.salt, binary),
    });
  const remember = (map: Map<string, Entry>, key: string, entry: Entry) => {
    if (map.size >= MAX_TRACKED) {
      map.delete(map.keys().next().value!);
      emit("network-tracking-limit");
    }
    map.set(key, entry);
  };
  interface NetworkParams {
    requestId: string;
    url?: string;
    type: string;
    dataLength?: number;
    encodedDataLength?: number;
    canceled?: boolean;
    data?: string;
    request?: { url: string; method: string; postData?: string };
    response?: {
      url?: string;
      mimeType?: string;
      status?: number;
      fromServiceWorker?: boolean;
      fromDiskCache?: boolean;
      opcode?: number;
      payloadData?: string;
    };
  }
  const onMessage = (
    _event: unknown,
    method: string,
    raw: unknown,
    sessionId = "",
  ) => {
    const params = raw as NetworkParams;
    if (closed) return;
    if (["Target.targetCreated", "Target.targetInfoChanged"].includes(method)) {
      const info = (
        raw as {
          targetInfo: {
            type: string;
            url: string;
            targetId: string;
            browserContextId?: string;
          };
        }
      ).targetInfo;
      if (
        info.type === "worker" &&
        info.browserContextId === browserContextId &&
        route(info.url) &&
        !attachedWorkers.has(info.targetId)
      ) {
        attachedWorkers.add(info.targetId);
        void options
          .send("Target.attachToTarget", {
            targetId: info.targetId,
            flatten: true,
          })
          .catch(() =>
            emit("network-capture-failed", { context: "dedicated-worker" }),
          );
      }
      return;
    }
    if (!enabled.has(sessionId)) return;
    const key = `${sessionId}:${params.requestId}`;
    if (
      method === "Network.requestWillBeSent" ||
      method === "Network.webSocketCreated"
    ) {
      const request = params.request;
      const category = route(request?.url || params.url || "");
      if (!category) {
        requests.delete(key);
        sockets.delete(key);
        return;
      }
      const entry: Entry = {
        id: ++sequence,
        context: contexts.get(sessionId) || "frame",
        route: category,
        at: Date.now(),
      };
      if (method === "Network.webSocketCreated") {
        remember(sockets, key, entry);
        emit("network-socket-open", safeEntry(entry));
      } else {
        // Documents, scripts and media are irrelevant and can be very large.
        if (
          !["XHR", "Fetch", "EventSource", "Ping", "Other"].includes(
            params.type,
          )
        )
          return;
        remember(requests, key, entry);
        emit("network-request", {
          ...safeEntry(entry),
          method: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "HEAD"].includes(
            request?.method || "",
          )
            ? request!.method
            : "other",
          resourceType: params.type,
        });
        if (
          typeof request?.postData === "string" &&
          request!.postData!.length <= MAX_BODY
        ) {
          let body = request!.postData!;
          if (!body.trim().startsWith("{")) {
            const form = new URLSearchParams(body);
            // Ignore credentials and arbitrary form names completely.
            body = JSON.stringify(
              Object.fromEntries(
                [
                  "variables",
                  "fb_api_req_friendly_name",
                  "doc_id",
                  "operationName",
                ]
                  .filter((k) => form.has(k))
                  .map((k) => [k, form.get(k)]),
              ),
            );
          }
          payload(entry, "http", "sent", Buffer.from(body));
        }
      }
    } else if (method === "Network.responseReceived") {
      const entry = requests.get(key);
      if (!entry) return;
      const response = params.response;
      if (!response) return;
      // Redirect destinations must be trusted too, before retrieving any body.
      if (!route(response.url || "")) {
        requests.delete(key);
        return;
      }
      entry.mime = /json|javascript|text\/plain/.test(String(response.mimeType))
        ? "structured"
        : "other";
      emit("network-response", {
        ...safeEntry(entry),
        status: response.status,
        mime: entry.mime,
        fromServiceWorker: Boolean(response.fromServiceWorker),
        fromDiskCache: Boolean(response.fromDiskCache),
      });
    } else if (method === "Network.dataReceived") {
      const entry = requests.get(key);
      if (entry)
        entry.bytes = (entry.bytes || 0) + (Number(params.dataLength) || 0);
    } else if (method === "Network.loadingFinished") {
      const entry = requests.get(key);
      if (!entry) return;
      requests.delete(key);
      emit("network-complete", {
        ...safeEntry(entry),
        durationMs: Date.now() - entry.at,
        encodedBytes: params.encodedDataLength,
      });
      if (entry.mime !== "structured") return;
      if (
        (entry.bytes || 0) > MAX_BODY ||
        (params.encodedDataLength || 0) > MAX_BODY ||
        pending >= 4
      ) {
        emit("network-body-skipped", {
          ...safeEntry(entry),
          reason: pending >= 4 ? "busy" : "oversize",
        });
        return;
      }
      pending++;
      void options
        .send(
          "Network.getResponseBody",
          { requestId: params.requestId },
          sessionId || undefined,
        )
        .then((result) => {
          if (typeof result.body === "string")
            payload(
              entry,
              "http",
              "received",
              Buffer.from(
                result.body,
                result.base64Encoded ? "base64" : "utf8",
              ),
            );
        })
        .catch(() => emit("network-body-unavailable", safeEntry(entry)))
        .finally(() => pending--);
    } else if (method === "Network.loadingFailed") {
      const entry = requests.get(key);
      if (!entry) return;
      requests.delete(key);
      emit("network-failed", {
        ...safeEntry(entry),
        canceled: Boolean(params.canceled),
      });
    } else if (
      ["Network.webSocketFrameReceived", "Network.webSocketFrameSent"].includes(
        method,
      )
    ) {
      const entry = sockets.get(key);
      if (!entry) return;
      const frame = params.response;
      if (!frame) return;
      if (
        ![1, 2].includes(frame.opcode || 0) ||
        typeof frame.payloadData !== "string"
      )
        return;
      if (frame.payloadData.length > MAX_BODY * 1.4) {
        emit("network-body-skipped", {
          ...safeEntry(entry),
          reason: "oversize",
        });
        return;
      }
      payload(
        entry,
        "websocket",
        method.endsWith("Received") ? "received" : "sent",
        Buffer.from(frame.payloadData, frame.opcode === 2 ? "base64" : "utf8"),
        frame.opcode === 2,
      );
    } else if (method === "Network.eventSourceMessageReceived") {
      const entry = requests.get(key);
      if (
        entry &&
        typeof params.data === "string" &&
        params.data.length <= MAX_BODY
      )
        payload(entry, "eventsource", "received", Buffer.from(params.data));
    } else if (
      method === "Network.webSocketClosed" ||
      method === "Network.webSocketFrameError"
    ) {
      const entry = sockets.get(key);
      if (!entry) return;
      emit(
        method.endsWith("Closed")
          ? "network-socket-close"
          : "network-socket-error",
        safeEntry(entry),
      );
      if (method.endsWith("Closed")) sockets.delete(key);
    }
  };
  debuggerApi.on("message", onMessage);
  return {
    async discoverWorkers() {
      try {
        const result = await options.send("Target.getTargetInfo", {});
        browserContextId = (result.targetInfo as { browserContextId?: string })
          .browserContextId;
        await options.send("Target.setDiscoverTargets", {
          discover: true,
          filter: [{ type: "worker", exclude: false }, { exclude: true }],
        });
      } catch {
        emit("network-capture-failed", { context: "dedicated-worker" });
      }
    },
    async enable(
      sessionId = "",
      context = sessionId ? "service-worker" : "frame",
    ) {
      enabled.add(sessionId);
      contexts.set(sessionId, context);
      try {
        await options.send(
          "Network.enable",
          {
            maxTotalBufferSize: 2 * 1024 * 1024,
            maxResourceBufferSize: MAX_BODY,
            maxPostDataSize: 64 * 1024,
          },
          sessionId || undefined,
        );
        emit("network-capture-ready", {
          context,
        });
      } catch {
        enabled.delete(sessionId);
        emit("network-capture-failed", {
          context,
        });
      }
    },
    removeSession(sessionId: string) {
      enabled.delete(sessionId);
      contexts.delete(sessionId);
      for (const map of [requests, sockets])
        for (const key of map.keys())
          if (key.startsWith(`${sessionId}:`)) map.delete(key);
    },
    dispose() {
      closed = true;
      debuggerApi.removeListener("message", onMessage);
      requests.clear();
      sockets.clear();
      enabled.clear();
    },
  };
}
