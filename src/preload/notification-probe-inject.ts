// Notification structure probe - injected into the Messenger page only when
// the user turns on Help > Record Notification Diagnostics.
//
// It answers, without recording any content:
// - What Facebook's own web notifications carry (option keys, tag and data
//   shapes, whether a thread id is present) and when Facebook closes them.
// - Whether Facebook notifies in the cases the sidebar path gets wrong:
//   the user's own messages, messages read on another device, wake catch-up.
// - How unread and read chat rows differ structurally, so unread state can
//   be detected without locale text.
// - When sleep/wake, focus and network changes happen and when the chat
//   list catches up afterwards.
//
// Titles, bodies, names, ids and URLs never leave the page. Text is only
// compared locally and reported as booleans or lengths; thread ids are
// reported as hashes salted per app run.

((window: Window & typeof globalThis) => {
  type ProbeWindow = Window & {
    __mdNotificationProbe?: NotificationProbeApi;
    __mdNotificationProbeSalt?: string;
  };
  type NotificationProbeApi = {
    onNativeConstructed: (
      instance: object,
      title: string,
      body: string,
      options: unknown,
    ) => void;
    onNativeClosed: (instance: object) => void;
    onNativeListener: (instance: object, eventName: string) => void;
    onServiceWorkerShow: (title: string, options: unknown) => void;
    onAppSend: (input: {
      href?: string;
      title: string;
      body: string;
      sourceLabel: string;
    }) => void;
  };

  const probeWindow = window as ProbeWindow;
  if (probeWindow.__mdNotificationProbe) return;

  const SALT = String(probeWindow.__mdNotificationProbeSalt || "");
  const MAX_ROW_SHAPES = 80;
  const MAX_ROW_CHANGES = 3000;
  const WAKE_WATCH_MS = 180_000;
  const CLOCK_TICK_MS = 2_000;
  const CLOCK_GAP_MS = 20_000;

  const post = (event: string, payload: Record<string, unknown> = {}) => {
    try {
      window.postMessage(
        {
          type: "electron-notification-probe",
          data: { event, pageTime: Date.now(), ...payload },
        },
        "*",
      );
    } catch {
      // Diagnostics must never break the page.
    }
  };

  // FNV-1a over salt + value: stable within a run, meaningless outside it.
  const hash = (value: string): string => {
    let h = 0x811c9dc5;
    const input = `${SALT}:${value}`;
    for (let i = 0; i < input.length; i += 1) {
      h ^= input.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(36);
  };

  // Structure of a string with its content removed: digit runs become N,
  // letter runs become a, everything else is kept (separators show shape).
  const stringShape = (value: string): string =>
    value
      .slice(0, 120)
      .replace(/[^\W\d_]+/gu, "a")
      .replace(/\d+/g, "N");

  const THREAD_ID_PATTERN = /\/t\/(\d{5,})|(?:^|\D)(\d{8,})(?:\D|$)/;
  const findThreadId = (value: unknown): string | null => {
    if (typeof value !== "string") return null;
    const match = value.match(THREAD_ID_PATTERN);
    return match ? match[1] || match[2] : null;
  };

  // Key/type tree of an arbitrary value, plus any thread id found in it.
  const valueShape = (
    value: unknown,
    depth = 0,
    found: { threadId: string | null; paths: string[] } = {
      threadId: null,
      paths: [],
    },
    pathLabel = "$",
  ): { shape: unknown; found: typeof found } => {
    if (value === null || value === undefined) {
      return { shape: String(value), found };
    }
    if (typeof value === "string") {
      const threadId = findThreadId(value);
      if (threadId) {
        found.threadId = found.threadId || threadId;
        found.paths.push(pathLabel);
      }
      return {
        shape: {
          type: "string",
          length: value.length,
          form: stringShape(value),
        },
        found,
      };
    }
    if (typeof value !== "object") return { shape: typeof value, found };
    if (depth >= 5) return { shape: "object(depth)", found };
    if (Array.isArray(value)) {
      return {
        shape: value
          .slice(0, 5)
          .map(
            (item, index) =>
              valueShape(item, depth + 1, found, `${pathLabel}[${index}]`)
                .shape,
          ),
        found,
      };
    }
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as object).slice(0, 30)) {
      out[key] = valueShape(
        (value as Record<string, unknown>)[key],
        depth + 1,
        found,
        `${pathLabel}.${key}`,
      ).shape;
    }
    return { shape: out, found };
  };

  // ---------------------------------------------------------------------------
  // Chat list helpers (structure only)
  // ---------------------------------------------------------------------------

  const findSidebar = (): Element | null =>
    document.querySelector('[role="navigation"]:has([role="grid"])') ||
    document.querySelector('[role="grid"]');

  const listRows = (): Element[] => {
    const sidebar = findSidebar();
    return sidebar
      ? Array.from(sidebar.querySelectorAll('[role="row"], [role="listitem"]'))
      : [];
  };

  const rowThreadId = (row: Element): string | null => {
    const link =
      row.querySelector('a[href*="/t/"]') || row.closest('a[href*="/t/"]');
    return findThreadId(link?.getAttribute("href") || "");
  };

  const rowTexts = (row: Element): string[] =>
    Array.from(row.querySelectorAll('[dir="auto"]'))
      .map((el) => (el.textContent || "").replace(/\s+/g, " ").trim())
      .filter(Boolean);

  // The current heuristic, recorded only to compare against structure.
  const rowUnreadByCurrentHeuristic = (row: Element): boolean =>
    (row.textContent || "").includes("Unread message:") ||
    Boolean(row.querySelector('[aria-label*="Mark as read" i]')) ||
    (row.getAttribute("aria-label") || "")
      .toLowerCase()
      .includes("unread message");

  const SAFE_ATTRIBUTE_VALUES = new Set([
    "aria-hidden",
    "aria-current",
    "aria-selected",
    "aria-expanded",
    "aria-checked",
    "aria-pressed",
    "aria-disabled",
    "aria-level",
    "aria-posinset",
    "aria-setsize",
    "role",
    "dir",
    "tabindex",
  ]);

  type NodeShape = {
    tag: string;
    attrs?: Record<string, string | true>;
    text?: number;
    weight?: string;
    color?: string;
    size?: string;
    children?: NodeShape[];
  };

  // Element tree with attribute names (values only for a safe allow-list),
  // text replaced by its length, and the styles that usually carry unread
  // state. Bounded in depth and node count.
  const nodeShape = (
    root: Element,
    budget = { nodes: 160 },
    depth = 0,
  ): NodeShape => {
    budget.nodes -= 1;
    const shape: NodeShape = { tag: root.tagName.toLowerCase() };
    const attrs: Record<string, string | true> = {};
    for (const attr of Array.from(root.attributes)) {
      if (
        attr.name === "class" ||
        attr.name === "style" ||
        attr.name === "src"
      ) {
        continue;
      }
      if (attr.name === "href") {
        attrs.href = stringShape(attr.value);
        continue;
      }
      attrs[attr.name] = SAFE_ATTRIBUTE_VALUES.has(attr.name)
        ? attr.value.slice(0, 20)
        : true;
    }
    if (Object.keys(attrs).length) shape.attrs = attrs;

    const ownText = Array.from(root.childNodes)
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent || "")
      .join("")
      .trim();
    if (ownText) {
      shape.text = ownText.length;
      try {
        const style = getComputedStyle(root);
        shape.weight = style.fontWeight;
        shape.color = style.color;
        shape.size = style.fontSize;
      } catch {
        // Detached nodes have no computed style.
      }
    }
    if (root.tagName.toLowerCase() === "svg") {
      shape.attrs = {
        ...(shape.attrs || {}),
        paths: String(root.querySelectorAll("path, use, circle").length),
      };
      return shape;
    }
    if (depth < 14 && budget.nodes > 0) {
      const children = Array.from(root.children)
        .slice(0, 20)
        .map((child) =>
          budget.nodes > 0 ? nodeShape(child, budget, depth + 1) : null,
        )
        .filter((child): child is NodeShape => child !== null);
      if (children.length) shape.children = children;
    }
    return shape;
  };

  const seenShapeHashes = new Set<string>();
  const rowShapeHash = (row: Element): string => {
    const shape = nodeShape(row);
    const serialized = JSON.stringify(shape);
    const shapeHash = hash(serialized);
    if (
      !seenShapeHashes.has(shapeHash) &&
      seenShapeHashes.size < MAX_ROW_SHAPES
    ) {
      seenShapeHashes.add(shapeHash);
      post("row-shape", { shapeHash, shape });
    }
    return shapeHash;
  };

  // Font weights of the row's [dir=auto] texts: the most likely locale-free
  // unread signal (Messenger bolds unread rows).
  const rowWeights = (row: Element): string[] =>
    Array.from(row.querySelectorAll('[dir="auto"]'))
      .slice(0, 4)
      .map((el) => {
        try {
          return getComputedStyle(el).fontWeight;
        } catch {
          return "?";
        }
      });

  type RowState = {
    threadHash: string | null;
    index: number;
    unreadHeuristic: boolean;
    weights: string[];
    shapeHash: string;
    textCount: number;
  };

  const rowState = (row: Element, index: number): RowState => {
    const threadId = rowThreadId(row);
    return {
      threadHash: threadId ? hash(threadId) : null,
      index,
      unreadHeuristic: rowUnreadByCurrentHeuristic(row),
      weights: rowWeights(row),
      shapeHash: rowShapeHash(row),
      textCount: rowTexts(row).length,
    };
  };

  const findRowForThread = (
    threadId: string,
  ): { row: Element; index: number } | null => {
    const rows = listRows();
    const index = rows.findIndex((row) => rowThreadId(row) === threadId);
    return index >= 0 ? { row: rows[index], index } : null;
  };

  // ---------------------------------------------------------------------------
  // Facebook notifications vs app notifications
  // ---------------------------------------------------------------------------

  type NativeRecord = {
    id: number;
    createdAt: number;
    threadId: string | null;
    closedAt?: number;
    listeners: Set<string>;
  };
  const nativeRecords = new WeakMap<object, NativeRecord>();
  const lastNativeByThread = new Map<string, number>();
  const lastAppSendByThread = new Map<string, number>();
  const lastLocalSendByThread = new Map<string, number>();
  let nativeCounter = 0;

  const sinceOrNull = (time: number | undefined, now: number) =>
    typeof time === "number" ? now - time : null;

  // Compare notification text with a chat row locally; only booleans and
  // lengths are reported.
  const compareWithRow = (title: string, body: string, row: Element) => {
    const texts = rowTexts(row);
    const rowTitle = texts[0] || "";
    const preview = texts.slice(1).find((text) => text.length > 0) || "";
    const endsWith = body.length > 0 && preview.endsWith(body);
    return {
      titleMatchesRow: rowTitle === title,
      titleWithinRow: rowTitle.length > 0 && title.includes(rowTitle),
      bodyEqualsPreview: preview === body,
      previewEndsWithBody: endsWith,
      previewPrefixLength: endsWith ? preview.length - body.length : null,
      bodyStartsWithPreview:
        preview.length > 0 && body.startsWith(preview.replace(/…$/, "")),
    };
  };

  const describeRowFor = (threadId: string | null, title: string) => {
    if (threadId) {
      const match = findRowForThread(threadId);
      if (match) return { how: "thread-id" as const, ...match };
    }
    const rows = listRows();
    const byTitle = rows
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => (rowTexts(row)[0] || "") === title);
    if (byTitle.length === 1) return { how: "title" as const, ...byTitle[0] };
    return {
      how: byTitle.length > 1 ? ("ambiguous" as const) : ("none" as const),
    };
  };

  const followUpRow = (
    label: string,
    id: number,
    threadId: string | null,
    title: string,
  ) => {
    for (const delay of [1_000, 5_000, 30_000]) {
      window.setTimeout(() => {
        const match = describeRowFor(threadId, title);
        post(`${label}-followup`, {
          id,
          delayMs: delay,
          rowMatch: match.how,
          row:
            "row" in match && match.row
              ? rowState(match.row, match.index)
              : null,
        });
      }, delay);
    }
  };

  const api: NotificationProbeApi = {
    onNativeConstructed(instance, title, body, options) {
      const now = Date.now();
      nativeCounter += 1;
      const id = nativeCounter;
      const opts = (
        options && typeof options === "object" ? options : {}
      ) as Record<string, unknown>;
      const tagInfo = valueShape(opts.tag);
      const dataInfo = valueShape(opts.data);
      const actionsInfo = valueShape(opts.actions);
      const threadId =
        tagInfo.found.threadId ||
        dataInfo.found.threadId ||
        actionsInfo.found.threadId;
      nativeRecords.set(instance, {
        id,
        createdAt: now,
        threadId,
        listeners: new Set(),
      });
      if (threadId) lastNativeByThread.set(threadId, now);

      const match = describeRowFor(threadId, title);
      const row = "row" in match && match.row ? match.row : null;
      const iconKind = (() => {
        if (typeof opts.icon !== "string" || !opts.icon) return "none";
        if (opts.icon.startsWith("data:")) return "data";
        try {
          const host = new URL(opts.icon, location.href).hostname;
          return host.endsWith("fbcdn.net") ? "fbcdn" : "other";
        } catch {
          return "unparseable";
        }
      })();

      post("native-constructed", {
        id,
        optionKeys: Object.keys(opts).sort(),
        tag: tagInfo.shape,
        tagHasThreadId: Boolean(tagInfo.found.threadId),
        data: dataInfo.shape,
        dataThreadPaths: dataInfo.found.paths,
        actions: actionsInfo.shape,
        threadHash: threadId ? hash(threadId) : null,
        silent: opts.silent ?? null,
        renotify: opts.renotify ?? null,
        requireInteraction: opts.requireInteraction ?? null,
        timestampDeltaMs:
          typeof opts.timestamp === "number" ? now - opts.timestamp : null,
        iconKind,
        titleLength: title.length,
        bodyLength: body.length,
        rowMatch: match.how,
        row:
          row && "index" in match ? rowState(row, match.index as number) : null,
        textComparison: row ? compareWithRow(title, body, row) : null,
        msSinceAppSendForThread: threadId
          ? sinceOrNull(lastAppSendByThread.get(threadId), now)
          : null,
        msSinceLocalSendForThread: threadId
          ? sinceOrNull(lastLocalSendByThread.get(threadId), now)
          : null,
        documentHasFocus: document.hasFocus(),
        visibility: document.visibilityState,
      });
      followUpRow("native", id, threadId, title);
    },

    onNativeClosed(instance) {
      const record = nativeRecords.get(instance);
      if (!record || record.closedAt) return;
      record.closedAt = Date.now();
      const match = record.threadId ? findRowForThread(record.threadId) : null;
      post("native-closed", {
        id: record.id,
        ageMs: record.closedAt - record.createdAt,
        listeners: Array.from(record.listeners),
        row: match ? rowState(match.row, match.index) : null,
        documentHasFocus: document.hasFocus(),
        visibility: document.visibilityState,
      });
    },

    onNativeListener(instance, eventName) {
      nativeRecords
        .get(instance)
        ?.listeners.add(String(eventName).slice(0, 20));
    },

    onServiceWorkerShow(title, options) {
      const opts = (
        options && typeof options === "object" ? options : {}
      ) as Record<string, unknown>;
      const tagInfo = valueShape(opts.tag);
      const dataInfo = valueShape(opts.data);
      const threadId = tagInfo.found.threadId || dataInfo.found.threadId;
      post("service-worker-show", {
        optionKeys: Object.keys(opts).sort(),
        tag: tagInfo.shape,
        data: dataInfo.shape,
        threadHash: threadId ? hash(threadId) : null,
        titleLength: String(title || "").length,
      });
    },

    onAppSend({ href, title, body, sourceLabel }) {
      const now = Date.now();
      const threadId = findThreadId(href || "");
      if (threadId) lastAppSendByThread.set(threadId, now);
      const match = threadId ? findRowForThread(threadId) : null;
      post("app-sent", {
        sourceLabel: String(sourceLabel || "").slice(0, 40),
        threadHash: threadId ? hash(threadId) : null,
        msSinceNativeForThread: threadId
          ? sinceOrNull(lastNativeByThread.get(threadId), now)
          : null,
        msSinceLocalSendForThread: threadId
          ? sinceOrNull(lastLocalSendByThread.get(threadId), now)
          : null,
        row: match ? rowState(match.row, match.index) : null,
        textComparison: match ? compareWithRow(title, body, match.row) : null,
        documentHasFocus: document.hasFocus(),
        visibility: document.visibilityState,
      });
      window.setTimeout(() => {
        const later = threadId ? findRowForThread(threadId) : null;
        post("app-sent-followup", {
          threadHash: threadId ? hash(threadId) : null,
          nativeAfterMs:
            threadId && (lastNativeByThread.get(threadId) ?? 0) >= now
              ? (lastNativeByThread.get(threadId) as number) - now
              : null,
          row: later ? rowState(later.row, later.index) : null,
        });
      }, 15_000);
    },
  };

  probeWindow.__mdNotificationProbe = api;

  // ---------------------------------------------------------------------------
  // Messages the user sends from this window (ground truth for "self")
  // ---------------------------------------------------------------------------

  window.addEventListener(
    "keydown",
    (event) => {
      if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
      const target = event.target instanceof Element ? event.target : null;
      const editable = target?.closest(
        '[contenteditable="true"], [role="textbox"]',
      );
      if (!editable || editable.closest('[role="navigation"]')) return;
      const threadId = findThreadId(location.pathname);
      if (!threadId) return;
      lastLocalSendByThread.set(threadId, Date.now());
      post("local-send", { threadHash: hash(threadId) });
    },
    true,
  );

  // ---------------------------------------------------------------------------
  // Chat list structure over time
  // ---------------------------------------------------------------------------

  const lastRowStates = new Map<string, RowState>();
  let rowChangeCount = 0;
  let pendingScan: number | null = null;
  let sidebarMutationsThisSecond = 0;
  let wakeWatch: {
    reason: string;
    startedAt: number;
    buckets: number[];
  } | null = null;

  const scanRows = () => {
    pendingScan = null;
    listRows().forEach((row, index) => {
      const state = rowState(row, index);
      if (!state.threadHash) return;
      const previous = lastRowStates.get(state.threadHash);
      lastRowStates.set(state.threadHash, state);
      if (!previous || rowChangeCount >= MAX_ROW_CHANGES) return;
      const changed =
        previous.unreadHeuristic !== state.unreadHeuristic ||
        previous.shapeHash !== state.shapeHash ||
        previous.weights.join() !== state.weights.join() ||
        (previous.index !== state.index && state.index === 0);
      if (!changed) return;
      rowChangeCount += 1;
      post("row-change", {
        before: previous,
        after: state,
        documentHasFocus: document.hasFocus(),
        visibility: document.visibilityState,
      });
    });
  };

  const scheduleScan = () => {
    sidebarMutationsThisSecond += 1;
    if (pendingScan !== null) return;
    pendingScan = window.setTimeout(scanRows, 1_000);
  };

  let observedSidebar: Element | null = null;
  const sidebarObserver = new MutationObserver(scheduleScan);
  const attachSidebar = () => {
    const sidebar = findSidebar();
    if (!sidebar || sidebar === observedSidebar) return;
    sidebarObserver.disconnect();
    observedSidebar = sidebar;
    sidebarObserver.observe(sidebar, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["aria-label", "aria-current", "class", "style"],
    });
    post("sidebar-attached", { rows: listRows().length });
    scanRows();
  };

  // ---------------------------------------------------------------------------
  // Sleep, wake, focus and network
  // ---------------------------------------------------------------------------

  const startWakeWatch = (reason: string) => {
    if (wakeWatch) post("wake-activity", { ...wakeWatch, interrupted: true });
    wakeWatch = { reason, startedAt: Date.now(), buckets: [] };
  };

  let lastTick = Date.now();
  window.setInterval(() => {
    const now = Date.now();
    const gap = now - lastTick;
    lastTick = now;
    if (gap > CLOCK_GAP_MS) {
      post("clock-gap", { gapMs: gap });
      startWakeWatch("clock-gap");
    }
    attachSidebar();
    if (wakeWatch) {
      wakeWatch.buckets.push(sidebarMutationsThisSecond);
      if (now - wakeWatch.startedAt >= WAKE_WATCH_MS) {
        post("wake-activity", {
          reason: wakeWatch.reason,
          bucketMs: CLOCK_TICK_MS,
          buckets: wakeWatch.buckets,
        });
        wakeWatch = null;
      }
    }
    sidebarMutationsThisSecond = 0;
  }, CLOCK_TICK_MS);

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (data?.type === "electron-power-state") {
      const state = String(data.data?.state || "");
      post("power", { state });
      if (state === "resume" || state === "unlock-screen")
        startWakeWatch(state);
    }
  });
  window.addEventListener("online", () => {
    post("network", { online: true });
    startWakeWatch("online");
  });
  window.addEventListener("offline", () => post("network", { online: false }));
  window.addEventListener("focus", () => post("focus", { focused: true }));
  window.addEventListener("blur", () => post("focus", { focused: false }));
  document.addEventListener("visibilitychange", () =>
    post("visibility", { state: document.visibilityState }),
  );

  // Facebook may register a service worker for notifications mid-session.
  try {
    const container = navigator.serviceWorker;
    const originalRegister = container?.register?.bind(container);
    if (container && originalRegister) {
      container.register = ((
        scriptURL: string | URL,
        options?: RegistrationOptions,
      ) => {
        post("service-worker-register", {
          scriptShape: stringShape(String(scriptURL)),
          scopeShape: options?.scope
            ? stringShape(String(options.scope))
            : null,
        });
        return originalRegister(scriptURL, options);
      }) as typeof container.register;
    }
  } catch {
    // Not available in this context.
  }

  post("probe-started", {
    permission:
      typeof Notification !== "undefined"
        ? String(Notification.permission)
        : "none",
    language: navigator.language,
    visibility: document.visibilityState,
  });
  attachSidebar();
})(window);
