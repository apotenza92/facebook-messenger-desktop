import { contextBridge, ipcRenderer } from "electron";

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld("electronAPI", {
  // Notification API override (legacy - kept for compatibility)
  showNotification: (data: {
    title: string;
    body: string;
    icon?: string;
    tag?: string;
    silent?: boolean;
  }) => {
    ipcRenderer.send("show-notification", data);
  },

  // Unread count updates
  updateUnreadCount: (count: number) => {
    console.log(`[Preload] Sending update-unread-count: ${count}`);
    ipcRenderer.send("update-unread-count", count);
  },

  // Clear badge
  clearBadge: () => {
    ipcRenderer.send("clear-badge");
  },

  // Incoming call - bring window to foreground
  incomingCall: () => {
    console.log("[Preload] Sending incoming-call signal");
    ipcRenderer.send("incoming-call");
  },

  // Notification actions
  onNotificationAction: (callback: (action: string, data: any) => void) => {
    ipcRenderer.on("notification-action-handler", (event, action, data) => {
      callback(action, data);
    });
  },

  // Test notification (for testing)
  testNotification: () => {
    ipcRenderer.send("test-notification");
  },

  // Menu bar hover tracking
  sendMousePosition: (y: number) => {
    ipcRenderer.send("mouse-position", y);
  },
});

// Forward power/sleep state changes to page context
ipcRenderer.on(
  "power-state",
  (_event, data: { state: string; timestamp: number }) => {
    try {
      window.postMessage({ type: "electron-power-state", data }, "*");
    } catch {
      // Ignore postMessage failures
    }
  },
);

// Listen for notification events from the injected script
// The injected script dispatches custom events that we can catch
// We need to inject a listener into the page context that forwards to us
(function setupNotificationBridge() {
  // Inject a script into the page context to listen for custom events
  // and forward them to the preload context via a message
  const _bridgeScript = `
    (function() {
      window.addEventListener('electron-notification', function(event) {
        // Forward to preload via a message we can catch
        window.postMessage({ type: 'electron-notification', data: event.detail }, '*');
      });
    })();
  `;

  // Execute the bridge listener in the page context
  // This runs after the page loads, so we'll inject it via main process

  // Also listen for messages (fallback)
  window.addEventListener("message", (event: MessageEvent) => {
    // Only process messages from the same origin (our injected script)
    if (event.data && typeof event.data === "object") {
      // Handle both 'electron-notification' (from bridge) and 'notification' (from fallback)
      if (
        event.data.type === "electron-notification" ||
        event.data.type === "notification"
      ) {
        const data = event.data.data;
        try {
          console.log("[Preload Bridge] Received electron-notification", {
            title: data?.title,
            hasIcon: Boolean(data?.icon),
            tag: data?.tag,
            id: data?.id,
          });
        } catch {
          /* intentionally empty */
        }

        // Convert icon if it's a data URL
        if (data.icon) {
          const image = new Image();
          image.crossOrigin = "anonymous";

          image.addEventListener("load", () => {
            const canvas = document.createElement("canvas");
            const context = canvas.getContext("2d");
            if (context) {
              canvas.width = image.width;
              canvas.height = image.height;
              context.drawImage(image, 0, 0);

              const iconDataUrl = canvas.toDataURL();
              ipcRenderer.send("show-notification", {
                title: data.title,
                body: data.body,
                icon: iconDataUrl,
                tag: data.tag,
                silent: data.silent,
                id: data.id,
                href: data.href, // Pass conversation URL for click navigation
              });
              try {
                console.log(
                  "[Preload Bridge] Sent notification with icon to main",
                  { id: data.id, title: data.title, href: data.href },
                );
              } catch {
                /* intentionally empty */
              }
            }
          });

          image.addEventListener("error", () => {
            // If image loading fails, send without icon
            ipcRenderer.send("show-notification", {
              title: data.title,
              body: data.body,
              tag: data.tag,
              silent: data.silent,
              id: data.id,
              href: data.href, // Pass conversation URL for click navigation
            });
            try {
              console.warn(
                "[Preload Bridge] Icon load failed, sent without icon",
                { id: data.id, title: data.title, href: data.href },
              );
            } catch {
              /* intentionally empty */
            }
          });

          image.src = data.icon;
        } else {
          // No icon, send directly
          ipcRenderer.send("show-notification", {
            title: data.title,
            body: data.body,
            tag: data.tag,
            silent: data.silent,
            id: data.id,
            href: data.href, // Pass conversation URL for click navigation
          });
          try {
            console.log(
              "[Preload Bridge] Sent notification without icon to main",
              { id: data.id, title: data.title, href: data.href },
            );
          } catch {
            /* intentionally empty */
          }
        }
      } else if (event.data.type === "electron-fallback-log") {
        try {
          ipcRenderer.send("log-fallback", event.data.data);
        } catch {
          /* intentionally empty */
        }
      } else if (event.data.type === "electron-badge-update") {
        // Handle badge count updates from page context
        const count = event.data.count;
        if (typeof count === "number") {
          console.log(
            `[Preload Bridge] Received badge update from page context: ${count}`,
          );
          ipcRenderer.send("update-unread-count", count);
        }
      } else if (event.data.type === "electron-incoming-call") {
        // Handle incoming call detection from page context
        console.log(
          "[Preload Bridge] Incoming call detected - signaling main process",
        );
        ipcRenderer.send("incoming-call");
      } else if (event.data.type === "electron-recount-badge") {
        // Handle badge recount request from injected script (issue #38)
        console.log(
          "[Preload Bridge] Badge recount requested - triggering DOM count",
        );
        // Dispatch custom event that the badge monitor will catch
        document.dispatchEvent(
          new CustomEvent("electron-badge-recount-request", { detail: {} }),
        );
      }
    }
  });
})();

// Track mouse position for menu bar hover (Windows/Linux only)
// We use screenY and window.screenY to calculate position relative to window top
// This is more reliable than clientY which starts at the web content area
if (process.platform !== "darwin") {
  let lastInHoverZone = false;
  const HOVER_ZONE = 10; // Pixels from top of window content area

  function setupMouseTracking() {
    document.addEventListener("mousemove", (event: MouseEvent) => {
      // Use clientY - position within the viewport/web content
      const y = event.clientY;

      // Detect if mouse is near the top of the content area
      const inHoverZone = y <= HOVER_ZONE;

      // Only send updates when state changes (to avoid spam)
      if (inHoverZone !== lastInHoverZone) {
        lastInHoverZone = inHoverZone;
        if (window.electronAPI && window.electronAPI.sendMousePosition) {
          window.electronAPI.sendMousePosition(y);
        }
      }
    });
  }

  // Set up mouse tracking when DOM is ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", setupMouseTracking);
  } else {
    setupMouseTracking();
  }
}

// Media viewer CSS adjustment for macOS title bar
// Pushes media viewer controls down to be fully below the custom title bar overlay
(function setupMediaViewerCSSAdjustment() {
  if (process.platform !== "darwin") return; // Only needed on macOS

  const TOP_OFFSET = 16;
  const style = document.createElement("style");
  style.id = "messenger-media-viewer-fix";
  style.textContent = `
    /* Push media viewer top controls down */
    /* Close button is a direct div, download/share are wrapped in spans */
    [aria-label="Close"][role="button"],
    span:has([aria-label="Download media attachment"]),
    span:has([aria-label="Forward media attachment"]) {
      transform: translateY(${TOP_OFFSET}px) !important;
    }
  `;

  // Inject when DOM is ready
  const inject = () => {
    if (!document.getElementById("messenger-media-viewer-fix")) {
      document.head.appendChild(style);
      console.log("[Preload] Media viewer CSS fix injected");
    }
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", inject);
  } else {
    inject();
  }
})();

// Legacy Notification override (kept as fallback, but main injection happens after page load)
// This must happen immediately and be non-configurable to prevent messenger.com from overriding it
(function () {
  "use strict";

  // Store original Notification constructor if it exists
  const _OriginalNotification = window.Notification;

  // Create a robust Notification override
  function createNotificationOverride() {
    class ElectronNotification {
      public title: string;
      public body: string;
      public tag?: string;
      private options: NotificationOptions;
      private listeners: Map<string, EventListener[]> = new Map();

      constructor(title: string, options?: NotificationOptions) {
        this.title = title;
        this.options = options || {};
        this.tag = this.options.tag;
        this.body = this.options.body || "";

        console.log("[Notification Override] Creating notification:", {
          title,
          body: this.body,
          tag: this.tag,
        });

        // Forward to Electron main process
        if ((window as any).electronAPI) {
          (window as any).electronAPI.showNotification({
            title: this.title,
            body: this.body,
            icon: this.options.icon,
            tag: this.tag,
            silent: this.options.silent,
          });
        } else {
          console.warn("[Notification Override] electronAPI not available yet");
        }
      }

      addEventListener(event: string, listener: EventListener | null) {
        if (!listener) return;
        if (!this.listeners.has(event)) {
          this.listeners.set(event, []);
        }
        this.listeners.get(event)!.push(listener);
      }

      removeEventListener(event: string, listener: EventListener | null) {
        if (!listener) return;
        const listeners = this.listeners.get(event);
        if (listeners) {
          const index = listeners.indexOf(listener);
          if (index > -1) {
            listeners.splice(index, 1);
          }
        }
      }

      close() {
        // Notification closed
      }

      static requestPermission(): Promise<NotificationPermission> {
        return Promise.resolve("granted");
      }

      static get permission(): NotificationPermission {
        return "granted";
      }

      // Some scripts assign to Notification.permission; include a no-op setter to avoid TypeErrors
      static set permission(_value: NotificationPermission) {
        // ignore
      }
    }

    return ElectronNotification;
  }

  const ElectronNotification = createNotificationOverride();

  // Replace window.Notification immediately and make it non-configurable
  try {
    // Delete existing Notification if it exists and is configurable
    const existingDescriptor = Object.getOwnPropertyDescriptor(
      window,
      "Notification",
    );
    if (existingDescriptor && existingDescriptor.configurable) {
      delete (window as any).Notification;
    }

    Object.defineProperty(window, "Notification", {
      value: ElectronNotification,
      writable: false,
      configurable: false,
      enumerable: true,
    });

    // Note: We don't need to define the prototype property - it's already
    // read-only on class constructors and cannot be reassigned

    console.log(
      "[Notification Override] Successfully overridden Notification API",
    );
  } catch (e) {
    // If defineProperty fails, we can't safely assign a class constructor directly
    // as it may cause prototype errors. Log the error and continue.
    console.error(
      "[Notification Override] Failed to override Notification API:",
      e,
    );
    console.warn(
      "[Notification Override] Notifications may not work correctly",
    );
  }

  // Continuously monitor and re-override if messenger.com tries to change it
  let _overrideCheckInterval: number | null = null;

  function ensureOverride() {
    // Check if Notification was changed by comparing constructor name or instance
    const currentNotification = (window as any).Notification;

    // If it's already our notification, don't do anything
    if (currentNotification === ElectronNotification) {
      return;
    }

    // Check if it has our class name
    if (
      currentNotification &&
      currentNotification.name === "ElectronNotification"
    ) {
      return;
    }

    // Only try to override if it's actually different
    console.log(
      "[Notification Override] Detected Notification was changed, re-overriding...",
    );

    // Check if the property is configurable
    const descriptor = Object.getOwnPropertyDescriptor(window, "Notification");
    if (descriptor && !descriptor.configurable) {
      // If it's non-configurable and not ours, we can't change it
      // This shouldn't happen if our initial override worked, but handle it gracefully
      console.warn(
        "[Notification Override] Cannot override - property is non-configurable",
      );
      return;
    }

    try {
      // If property exists and is configurable, delete it first to avoid conflicts
      if (descriptor && descriptor.configurable) {
        delete (window as any).Notification;
      }

      Object.defineProperty(window, "Notification", {
        value: ElectronNotification,
        writable: false,
        configurable: false,
        enumerable: true,
      });
    } catch (e) {
      // If defineProperty fails completely, log the error but don't try direct assignment
      // Direct assignment of class constructors can cause prototype errors
      console.warn("[Notification Override] Failed to re-override:", e);
    }
  }

  // Check periodically to ensure override stays in place (every 2 seconds)
  _overrideCheckInterval = window.setInterval(ensureOverride, 2000);

  // Also override when DOM is ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      ensureOverride();
    });
  } else {
    ensureOverride();
  }

  // Monitor page title for unread count
  function monitorUnreadCount() {
    let lastTitle = document.title;
    let unreadCount = 0;
    let pendingClear = false;

    // Parse unread count from title (e.g., "(5) Messenger")
    function parseUnreadCount(title: string): number {
      const match = title.match(/^\((\d+)\)/);
      return match ? parseInt(match[1], 10) : 0;
    }

    const isAppFocused = (): boolean => {
      return document.hasFocus() && document.visibilityState === "visible";
    };

    let pendingClearRetryTimeout: number | null = null;
    const schedulePendingClearRetry = (attempt = 0): void => {
      if (!pendingClear || !isAppFocused()) {
        return;
      }
      if (pendingClearRetryTimeout !== null) {
        clearTimeout(pendingClearRetryTimeout);
      }
      const maxAttempts = 3;
      const retryDelay = 150;

      pendingClearRetryTimeout = window.setTimeout(() => {
        pendingClearRetryTimeout = null;
        if (!pendingClear || !isAppFocused()) {
          return;
        }

        const domCount = countUnreadConversations();
        const titleCount = parseUnreadCount(document.title);
        const canClear =
          unreadCount > 0 &&
          titleCount === 0 &&
          (domCount === 0 || domCount === -1);

        if (canClear) {
          console.log("[BadgeMonitor] Applying deferred badge clear (retry)");
          pendingClear = false;
          unreadCount = 0;
          sendBadgeUpdate(unreadCount);
          return;
        }

        if (attempt + 1 < maxAttempts) {
          schedulePendingClearRetry(attempt + 1);
        }
      }, retryDelay);
    };

    // Send badge update via postMessage (works from page context)
    function sendBadgeUpdate(count: number) {
      if (count === 0 && unreadCount > 0 && !isAppFocused()) {
        pendingClear = true;
        console.log(
          "[BadgeMonitor] Deferring badge clear until app is focused",
        );
        return;
      }
      if (count > 0) {
        pendingClear = false;
      }
      console.log(
        `[BadgeMonitor] Sending badge update via postMessage: ${count}`,
      );
      window.postMessage({ type: "electron-badge-update", count }, "*");
    }

    // Check initial title
    unreadCount = parseUnreadCount(lastTitle);
    console.log(
      `[BadgeMonitor] Initial title: "${lastTitle}", parsed count: ${unreadCount}`,
    );
    // Send initial count
    sendBadgeUpdate(unreadCount);

    // Monitor title changes with immediate response
    const titleObserver = new MutationObserver(() => {
      if (document.title !== lastTitle) {
        lastTitle = document.title;
        const newCount = parseUnreadCount(lastTitle);
        // Always send count updates (including 0) to ensure badge stays in sync
        if (newCount !== unreadCount) {
          console.log(
            `[BadgeMonitor] Title changed: "${lastTitle}", new count: ${newCount} (was ${unreadCount})`,
          );

          // When count goes to 0, wait a bit for DOM to update before trusting the title
          // This prevents the badge from flashing when opening a conversation
          if (newCount === 0 && unreadCount > 0) {
            // User likely opened a conversation - wait for DOM to reflect the read state
            setTimeout(() => {
              const domCount = countUnreadConversations();
              const titleCount = parseUnreadCount(document.title);

              // Use DOM count if it's valid, otherwise use title count
              const finalCount =
                domCount >= 0 && domCount !== titleCount
                  ? domCount
                  : titleCount;

              if (finalCount !== unreadCount) {
                console.log(
                  `[BadgeMonitor] After delay, final count: ${finalCount} (title: ${titleCount}, DOM: ${domCount})`,
                );
                unreadCount = finalCount;
                sendBadgeUpdate(unreadCount);
              }
            }, 300); // Wait 300ms for DOM to update
          } else {
            // For increases or non-zero counts, update immediately
            unreadCount = newCount;
            sendBadgeUpdate(unreadCount);
            // Also trigger DOM check when count changes to 0 from a non-zero value
            if (newCount === 0) {
              debouncedCountUnread();
            }
          }
        }
      }
    });

    // Debounce DOM counting to avoid performance issues
    let domCountTimeout: number | null = null;
    const debouncedCountUnread = () => {
      if (domCountTimeout !== null) {
        clearTimeout(domCountTimeout);
      }
      domCountTimeout = window.setTimeout(() => {
        const domCount = countUnreadConversations();
        console.log(
          `[BadgeMonitor] DOM count check: ${domCount} (current: ${unreadCount})`,
        );

        const titleCount = parseUnreadCount(document.title);

        if (
          pendingClear &&
          isAppFocused() &&
          unreadCount > 0 &&
          titleCount === 0 &&
          (domCount === 0 || domCount === -1)
        ) {
          console.log("[BadgeMonitor] Applying deferred badge clear");
          pendingClear = false;
          unreadCount = 0;
          sendBadgeUpdate(unreadCount);
          domCountTimeout = null;
          return;
        }

        // Use DOM count if it's valid and provides useful information
        if (domCount >= 0) {
          // Use DOM count when:
          // 1. Title says 0 but DOM shows unread (catches manually marked unread chats)
          // 2. DOM count is higher than title count (title might be stale)
          // Prefer title count when it's > 0 and matches or is higher than DOM count
          const shouldUseDomCount =
            (titleCount === 0 && domCount > 0) || // Title says 0 but DOM shows unread
            domCount > titleCount; // DOM count is higher (more accurate)

          if (shouldUseDomCount && domCount !== unreadCount) {
            console.log(
              `[BadgeMonitor] Using DOM count: ${domCount} (title count: ${titleCount})`,
            );
            unreadCount = domCount;
            sendBadgeUpdate(unreadCount);
          }
        }
        domCountTimeout = null;
      }, 200); // Reduced debounce to 200ms for faster updates
    };

    // Observe title element
    titleObserver.observe(document.querySelector("title") || document.head, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    // Also monitor for unread indicators in the DOM
    // This catches manually marked unread chats and is a fallback if title doesn't change
    function countUnreadConversations(): number {
      try {
        // Helper to check if we're currently viewing a conversation
        // Used to exclude the active conversation from unread count (issue #22)
        const getCurrentConversationPath = (): string | null => {
          const path = window.location.pathname;
          // Messenger conversation URLs: /t/THREAD_ID or /e2ee/t/THREAD_ID
          if (path.startsWith("/t/") || path.startsWith("/e2ee/t/")) {
            return path.split(/[?#]/)[0].replace(/\/+$/, ""); // Normalize
          }
          return null;
        };

        const isWindowFocused = (): boolean => {
          return document.hasFocus() && document.visibilityState === "visible";
        };

        const currentConversationPath = getCurrentConversationPath();
        const windowFocused = isWindowFocused();

        // Find conversation rows - use the same selectors as notifications-inject.ts
        // Messenger uses [role="row"] for conversation rows
        const conversationSelectors = [
          '[role="row"]', // Standard conversation row (same as notification system)
          'div[role="list"] > div[role="listitem"]', // Alternative structure
          'ul[role="list"] > li[role="listitem"]', // Another alternative
        ];

        const allConversations: Element[] = [];
        conversationSelectors.forEach((selector) => {
          try {
            const elements = document.querySelectorAll(selector);
            allConversations.push(...Array.from(elements));
          } catch (_e) {
            // Ignore selector errors
          }
        });

        // If we didn't find conversations, try finding by links
        if (allConversations.length === 0) {
          const links = document.querySelectorAll(
            'a[href*="/t/"], a[href*="/e2ee/t/"]',
          );
          links.forEach((link) => {
            // Find the parent row element
            let parent = link.parentElement;
            while (parent && parent !== document.body) {
              if (
                parent.getAttribute("role") === "row" ||
                parent.getAttribute("role") === "listitem" ||
                parent.querySelector('[aria-label*="Mark as Read"]')
              ) {
                allConversations.push(parent);
                break;
              }
              parent = parent.parentElement;
            }
          });
        }

        // Check if a conversation is muted (same logic as notifications-inject.ts)
        // Messenger shows a "bell with slash" SVG icon for muted conversations
        const isConversationMuted = (conversationEl: Element): boolean => {
          // PRIMARY DETECTION: Look for the mute bell icon SVG path
          // This path represents the "bell with slash" icon shown next to muted conversations
          const paths = Array.from(conversationEl.querySelectorAll("svg path"));
          for (const path of paths) {
            const d = path.getAttribute("d") || "";
            // Check for the specific mute icon path pattern
            // The mute bell SVG path starts with "M9.244 24.99" and contains "L26.867 7.366"
            if (d.startsWith("M9.244 24.99") || d.includes("L26.867 7.366")) {
              return true;
            }
          }

          // FALLBACK: Check aria-label/text indicators
          const textContent = conversationEl.textContent || "";
          const ariaLabel = conversationEl.getAttribute("aria-label") || "";
          const lowered = ariaLabel.toLowerCase();
          if (
            lowered.includes("muted") ||
            lowered.includes("notifications are off") ||
            lowered.includes("notifications off") ||
            textContent.includes("Notifications are off")
          ) {
            return true;
          }

          return false;
        };

        // Count unread conversations using the same logic as notifications-inject.ts
        let unreadCount = 0;
        const seenHrefs = new Set<string>();

        allConversations.forEach((conversationEl) => {
          // Check if this conversation is unread
          const isUnread = (() => {
            // PRIMARY CHECK: Look for "Unread message:" text
            const textContent = conversationEl.textContent || "";
            if (textContent.includes("Unread message:")) {
              return true;
            }

            // Check aria-label patterns
            const ariaLabel = conversationEl.getAttribute("aria-label") || "";
            if (
              ariaLabel.includes("Unread message") ||
              ariaLabel.toLowerCase().includes("unread")
            ) {
              return true;
            }

            // Look for the "Mark as Read" button which indicates unread
            const markAsRead = conversationEl.querySelector(
              '[aria-label="Mark as Read"]',
            );
            if (markAsRead) {
              return true;
            }

            // Check aria-label on child elements
            const childWithUnread = conversationEl.querySelector(
              '[aria-label*="unread"], [aria-label*="Unread"]',
            );
            if (childWithUnread) {
              return true;
            }

            return false;
          })();

          // Skip muted conversations - they shouldn't count toward unread badge (issue #14)
          if (isUnread && isConversationMuted(conversationEl)) {
            return; // Skip this conversation
          }

          if (isUnread) {
            // Try to get a unique identifier for this conversation to avoid double-counting
            const link = conversationEl.querySelector('a[href*="/t/"]');
            if (link) {
              const href = (link as HTMLAnchorElement).href;

              // Issue #22: Skip counting the currently viewed conversation as unread
              // when the window is focused - the user is actively reading it
              if (windowFocused && currentConversationPath) {
                try {
                  const conversationPath = new URL(href).pathname
                    .split(/[?#]/)[0]
                    .replace(/\/+$/, "");
                  if (conversationPath === currentConversationPath) {
                    // This is the conversation the user is currently viewing
                    // Don't count it as unread since they're actively looking at it
                    return; // Skip this conversation
                  }
                } catch {
                  // URL parsing failed, continue with counting
                }
              }

              if (!seenHrefs.has(href)) {
                seenHrefs.add(href);
                unreadCount++;
              }
            } else {
              // If no link found, count it anyway (might be a different structure)
              unreadCount++;
            }
          }
        });

        return unreadCount;
      } catch (_e) {
        // If DOM counting fails, return -1 to indicate we should rely on title
        return -1;
      }
    }

    const domObserver = new MutationObserver(() => {
      // Debounced counting to avoid performance issues
      debouncedCountUnread();
    });

    // Observe body for changes
    domObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["aria-label", "data-testid", "class"],
    });

    // Run initial DOM count check after a short delay to ensure DOM is fully loaded
    // This catches manually marked unread chats that might not be in the title
    setTimeout(() => {
      debouncedCountUnread();
    }, 2000); // Wait 2 seconds for Messenger to fully load

    // Also check when window becomes visible/focused (user clicks on conversation)
    // This makes badge updates faster when reading messages
    const handleVisibilityChange = () => {
      if (!document.hidden) {
        // Window is visible, check immediately
        debouncedCountUnread();
        schedulePendingClearRetry();
      }
    };

    const handleFocus = () => {
      // Window focused, check immediately
      debouncedCountUnread();
      schedulePendingClearRetry();
    };

    // Check when URL changes (user navigates to a conversation)
    // Messenger uses pushState for navigation, so we need to intercept it
    let lastUrl = window.location.href;
    const checkUrlChange = () => {
      const currentUrl = window.location.href;
      if (currentUrl !== lastUrl) {
        lastUrl = currentUrl;
        // URL changed (likely opened a conversation), check badge immediately
        debouncedCountUnread();
      }
    };

    // Intercept pushState and replaceState to catch SPA navigation
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;

    history.pushState = function (...args) {
      originalPushState.apply(history, args);
      setTimeout(checkUrlChange, 50); // Small delay to let DOM update
    };

    history.replaceState = function (...args) {
      originalReplaceState.apply(history, args);
      setTimeout(checkUrlChange, 50);
    };

    // Also listen for popstate (back/forward)
    window.addEventListener("popstate", () => {
      setTimeout(checkUrlChange, 50);
    });

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("focus", handleFocus);

    // Issue #22: More responsive badge updates when user is active in a conversation
    // When user interacts (clicks, types), trigger a badge recount after a short delay
    // This catches cases where Messenger marks a message as read after user interaction
    let activityTimeout: number | null = null;
    const handleUserActivity = () => {
      // Only trigger if we're in a conversation (URL contains /t/)
      const path = window.location.pathname;
      if (!path.includes("/t/")) return;

      // Debounce activity-based recounts to avoid spam
      if (activityTimeout !== null) {
        clearTimeout(activityTimeout);
      }
      activityTimeout = window.setTimeout(() => {
        debouncedCountUnread();
        activityTimeout = null;
      }, 500); // Wait 500ms after activity stops before recounting
    };

    // Listen for user interaction events that indicate they're reading/responding
    document.addEventListener("click", handleUserActivity, { passive: true });
    document.addEventListener("keydown", handleUserActivity, { passive: true });

    // Issue #38: Handle badge recount requests from the injected notifications script
    // When messages are marked as read in the active chat, trigger an immediate recount
    document.addEventListener(
      "electron-badge-recount-request",
      () => {
        console.log(
          "[BadgeMonitor] Recount requested from notifications script",
        );
        debouncedCountUnread();
      },
      { passive: true },
    );

    // Issue #27: Periodic recheck to catch cross-device read status changes
    // When messages are read on another device, the local DOM doesn't update automatically
    // This interval rechecks the DOM every 30 seconds to catch stale badge counts
    setInterval(() => {
      console.log("[BadgeMonitor] Periodic recheck triggered");
      debouncedCountUnread();
    }, 30000); // Recheck every 30 seconds
  }

  // Wait for DOM to be ready, then wait a bit more for electronAPI to be available
  function startMonitoring() {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => {
        // Wait a bit for contextBridge to complete
        setTimeout(monitorUnreadCount, 100);
      });
    } else {
      // Wait a bit for contextBridge to complete
      setTimeout(monitorUnreadCount, 100);
    }
  }

  startMonitoring();
})();

// Type definitions for TypeScript
declare global {
  interface Window {
    electronAPI: {
      showNotification: (data: {
        title: string;
        body: string;
        icon?: string;
        tag?: string;
        silent?: boolean;
      }) => void;
      sendMousePosition: (y: number) => void;
      updateUnreadCount: (count: number) => void;
      clearBadge: () => void;
      incomingCall: () => void;
      onNotificationAction: (
        callback: (action: string, data: any) => void,
      ) => void;
      testNotification: () => void;
    };
  }
}
