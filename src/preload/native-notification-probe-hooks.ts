/// <reference lib="dom" />
export function installHooks(
  config: { salt: string; context: string },
  report: (record: Record<string, unknown>) => void,
): void {
  const root = globalThis as typeof globalThis & {
    __mdNativeNotificationProbe?: {
      pendingThreads: Array<{ threadId: string; at: number }>;
    };
    __mdNotificationProbe?: {
      onNativeThread?: (threadId: string, at: number) => void;
    };
    registration?: ServiceWorkerRegistration;
  };
  if (root.__mdNativeNotificationProbe) return;
  Object.defineProperty(root, "__mdNativeNotificationProbe", {
    value: { pendingThreads: [] },
    configurable: false,
  });
  let counter = 0;
  const records = new WeakMap<
    object,
    { id: number; createdAt: number; threadHash: string | null }
  >();
  const hash = (value: string): string => {
    let h = 0x811c9dc5;
    for (const c of `${config.salt}:${value}`) {
      h ^= c.charCodeAt(0);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(36);
  };
  const threadId = (value: unknown): string | null => {
    if (typeof value === "number" && Number.isSafeInteger(value))
      value = String(value);
    if (typeof value !== "string") return null;
    const m = value.match(/\/t\/(\d{5,})|(?:^|\D)(\d{8,})(?:\D|$)/);
    return m ? m[1] || m[2] : null;
  };
  const emit = (event: string, data: Record<string, unknown> = {}) => {
    try {
      report({
        event,
        pageTime: Date.now(),
        ...data,
        ...(typeof document !== "undefined"
          ? {
              documentHasFocus: document.hasFocus(),
              visibility: document.visibilityState,
            }
          : {}),
      });
    } catch {
      /* diagnostics must not break native behaviour */
    }
  };
  const errorKind = (error: unknown): string => {
    try {
      const name = (error as { name?: unknown })?.name;
      return typeof name === "string" &&
        [
          "AbortError",
          "NotAllowedError",
          "NotSupportedError",
          "InvalidStateError",
          "TypeError",
          "SecurityError",
          "UnknownError",
        ].includes(name)
        ? name
        : "other";
    } catch {
      return "other";
    }
  };
  const knownOptions = new Set([
    "body",
    "tag",
    "data",
    "icon",
    "badge",
    "image",
    "actions",
    "silent",
    "renotify",
    "requireInteraction",
    "timestamp",
    "lang",
    "dir",
    "vibrate",
  ]);
  const dataKeys = new Set([
    "url",
    "href",
    "threadId",
    "thread_id",
    "conversationId",
    "conversation_id",
    "id",
    "data",
    "payload",
    "notification",
  ]);
  const readMetadata = (title: unknown, options: NotificationOptions = {}) => {
    const opts = (options || {}) as NotificationOptions & {
      renotify?: boolean;
      timestamp?: number;
      actions?: unknown[];
    };
    let found = threadId(opts.tag);
    const paths: string[] = [];
    const types: string[] = [];
    const seen = new WeakSet<object>();
    const walk = (value: unknown, path: string, depth: number) => {
      if (depth > 5 || types.length >= 20) return;
      types.push(
        value === null ? "null" : Array.isArray(value) ? "array" : typeof value,
      );
      const id = threadId(value);
      if (id) {
        found = found || id;
        paths.push(path);
      }
      if (!value || typeof value !== "object" || seen.has(value)) return;
      seen.add(value);
      if (Array.isArray(value))
        value
          .slice(0, 5)
          .forEach((v, i) => walk(v, `${path}[${i}]`, depth + 1));
      else
        for (const key of Object.keys(value)
          .filter((k) => dataKeys.has(k))
          .slice(0, 10))
          walk(
            (value as Record<string, unknown>)[key],
            `${path}.${key}`,
            depth + 1,
          );
    };
    walk(opts.data, "$", 0);
    if (found && config.context === "frame") {
      if (root.__mdNotificationProbe?.onNativeThread)
        root.__mdNotificationProbe.onNativeThread(found, Date.now());
      else if (root.__mdNativeNotificationProbe!.pendingThreads.length < 100)
        root.__mdNativeNotificationProbe!.pendingThreads.push({
          threadId: found,
          at: Date.now(),
        });
    }
    const iconKind = (() => {
      if (!opts.icon) return "none";
      if (String(opts.icon).startsWith("data:")) return "data";
      try {
        return new URL(String(opts.icon), location.href).hostname.endsWith(
          "fbcdn.net",
        )
          ? "fbcdn"
          : "other";
      } catch {
        return "other";
      }
    })();
    return {
      titleLength: String(title || "").length,
      bodyLength: String(opts.body || "").length,
      optionKeys: Object.keys(opts).filter((k) => knownOptions.has(k)),
      tagLength: typeof opts.tag === "string" ? opts.tag.length : 0,
      tagHash: typeof opts.tag === "string" && opts.tag ? hash(opts.tag) : null,
      actionCount: Array.isArray(opts.actions) ? opts.actions.length : 0,
      dataPresent: opts.data != null,
      tagHasThreadId: Boolean(threadId(opts.tag)),
      threadHash: found ? hash(found) : null,
      dataThreadPaths: paths,
      dataTypes: types,
      iconKind,
      silent: opts.silent,
      renotify: opts.renotify,
      requireInteraction: opts.requireInteraction,
      timestampDeltaMs:
        typeof opts.timestamp === "number"
          ? Date.now() - opts.timestamp
          : undefined,
    };
  };
  const metadata = (title: unknown, options?: NotificationOptions) => {
    try {
      return readMetadata(title, options);
    } catch {
      emit("metadata-unavailable");
      return { threadHash: null };
    }
  };
  const remember = (
    instance: Notification,
    details: ReturnType<typeof metadata>,
  ) => {
    if (records.has(instance)) return records.get(instance)!;
    const record = {
      id: ++counter,
      createdAt: Date.now(),
      threadHash: details.threadHash,
    };
    records.set(instance, record);
    for (const name of ["show", "error", "click", "close"] as const) {
      instance.addEventListener(name, () =>
        emit(name === "close" ? "native-close-event" : `native-${name}`, {
          ...record,
          ageMs: Date.now() - record.createdAt,
        }),
      );
    }
    return record;
  };
  let constructorHook = false,
    closeHook = false,
    showNotificationHook = false,
    getNotificationsHook = false;
  try {
    const Native = root.Notification;
    if (Native) {
      const originalClose = Native.prototype.close;
      Native.prototype.close = function () {
        const result = originalClose.call(this);
        try {
          const record =
            records.get(this) || remember(this, metadata(this.title, this));
          emit("native-closed", {
            id: record.id,
            threadHash: record.threadHash,
            ageMs: Date.now() - record.createdAt,
          });
        } catch {
          emit("metadata-unavailable");
        }
        return result;
      };
      closeHook = true;
      const originalPermission = Native.requestPermission;
      Native.requestPermission = function (
        callback?: NotificationPermissionCallback,
      ) {
        emit("permission-request", { permission: Native.permission });
        return originalPermission.call(this, callback).then((permission) => {
          emit("permission-result", { permission });
          return permission;
        });
      };
      root.Notification = new Proxy(Native, {
        construct(target, args, newTarget) {
          const details = metadata(args[0], args[1]);
          let instance: Notification;
          try {
            instance = Reflect.construct(
              target,
              args,
              newTarget,
            ) as Notification;
          } catch (error) {
            emit("native-construction-failed", {
              ...details,
              errorKind: errorKind(error),
            });
            throw error;
          }
          try {
            const record = remember(instance, details);
            emit("native-constructed", {
              ...details,
              id: record.id,
              permission: Native.permission,
            });
          } catch {
            emit("metadata-unavailable");
          }
          return instance;
        },
      });
      constructorHook = true;
    }
    const pushProto = root.PushManager?.prototype;
    if (pushProto) {
      for (const name of [
        "subscribe",
        "getSubscription",
        "permissionState",
      ] as const) {
        const original = pushProto[name];
        if (typeof original !== "function") continue;
        // Inspect presence/status only: endpoints, auth/p256dh keys and payloads
        // are credentials or content and are never read by this probe.
        const wrapped = function (this: PushManager, ...args: unknown[]) {
          emit(`push-${name}-request`);
          const result = Reflect.apply(
            original,
            this,
            args,
          ) as Promise<unknown>;
          return result.then(
            (value) => {
              emit(
                `push-${name}-result`,
                name === "permissionState"
                  ? { permission: value === "prompt" ? "default" : value }
                  : { subscriptionPresent: Boolean(value) },
              );
              return value;
            },
            (error) => {
              emit(`push-${name}-rejected`, { errorKind: errorKind(error) });
              throw error;
            },
          );
        };
        Object.defineProperty(pushProto, name, {
          value: wrapped,
          writable: true,
          configurable: true,
        });
      }
    }
    const proto = root.ServiceWorkerRegistration?.prototype;
    if (proto?.showNotification) {
      const originalShow = proto.showNotification;
      proto.showNotification = function (title, options) {
        const id = ++counter;
        const details = metadata(title, options);
        emit("service-worker-show", { ...details, id });
        return originalShow.call(this, title, options).then(
          () => {
            emit("service-worker-show-resolved", {
              id,
              threadHash: details.threadHash,
            });
          },
          (error) => {
            emit("service-worker-show-rejected", {
              errorKind: errorKind(error),
              id,
              threadHash: details.threadHash,
            });
            throw error;
          },
        );
      };
      showNotificationHook = true;
    }
    if (proto?.getNotifications) {
      const originalGet = proto.getNotifications;
      proto.getNotifications = function (filter) {
        const id = ++counter;
        emit("get-notifications", {
          id,
          tagHasThreadId: Boolean(threadId(filter?.tag)),
        });
        return originalGet.call(this, filter).then(
          (items) => {
            try {
              items.forEach((item) =>
                remember(item, metadata(item.title, item)),
              );
            } catch {
              emit("metadata-unavailable");
            }
            emit("get-notifications-result", { id, count: items.length });
            return items;
          },
          (error) => {
            emit("get-notifications-rejected", {
              id,
              errorKind: errorKind(error),
            });
            throw error;
          },
        );
      };
      getNotificationsHook = true;
    }
    if (config.context === "service-worker") {
      root.addEventListener("push", (event) =>
        emit("worker-push", {
          dataPresent: Boolean((event as Event & { data?: unknown }).data),
        }),
      );
      for (const name of ["notificationclick", "notificationclose"])
        root.addEventListener(name, (event) => {
          const notification = (event as Event & { notification: Notification })
            .notification;
          emit(`worker-${name}`, metadata(notification.title, notification));
        });
    }
    const installedConstructor = root.Notification;
    const installedClose = root.Notification?.prototype.close;
    const installedShow = proto?.showNotification;
    const installedGet = proto?.getNotifications;
    const health = () =>
      emit("native-hooks-health", {
        constructorHook:
          constructorHook && root.Notification === installedConstructor,
        closeHook:
          closeHook && root.Notification?.prototype.close === installedClose,
        showNotificationHook:
          showNotificationHook && proto?.showNotification === installedShow,
        getNotificationsHook:
          getNotificationsHook && proto?.getNotifications === installedGet,
        permission: root.Notification?.permission,
        online: typeof navigator !== "undefined" ? navigator.onLine : undefined,
      });
    emit("native-hooks-ready", {
      constructorHook,
      closeHook,
      showNotificationHook,
      getNotificationsHook,
      permission: root.Notification?.permission,
    });
    setInterval(health, 60_000);
    if (config.context === "frame") {
      root.addEventListener("focus", health);
      root.addEventListener("blur", health);
      root.addEventListener("online", health);
      root.addEventListener("offline", health);
      document.addEventListener("visibilitychange", health);
    }
  } catch {
    emit("native-hooks-failed", {
      constructorHook,
      closeHook,
      showNotificationHook,
      getNotificationsHook,
    });
  }
}
