// Notification injection script - injected into page context after load
// Uses DUAL detection: MutationObserver + Title-based (inspired by Caprine)
// Both run in parallel for maximum reliability regardless of window size

((window, notification) => {
  const DEBUG = true;
  const notifications = new Map<number, any>();

  // Selectors for Messenger's DOM structure (these may need updates as Messenger changes)
  const selectors = {
    // The navigation area containing the chat list
    sidebar: '[role="navigation"]:has([role="grid"])',
    // Alternative: the grid directly
    chatsGrid: '[role="grid"][aria-label="Chats"]',
    // Individual conversation row container
    conversationRow: '[role="row"]',
    // Link element within a conversation (contains href for deduplication)
    conversationLink: '[role="link"]',
    // Text content elements in conversation preview
    conversationText: '[dir="auto"]',
    // The unread indicator (blue dot next to unread conversations)
    unreadIndicator: '[aria-label="Mark as Read"]',
  };

  const log = (message: string, payload?: any) => {
    if (!DEBUG) return;
    try {
      console.log(`[Notif Dual] ${message}`, payload || '');
      window.postMessage(
        {
          type: 'electron-fallback-log',
          data: { event: message, payload },
        },
        '*',
      );
    } catch (_) {}
  };

  // ============================================================================
  // SHARED STATE - used by both MutationObserver and Title-based detection
  // ============================================================================

  // Track notified conversations by href - stores the last message body we notified for
  // Records are cleared when:
  // 1. The conversation is marked as read (via clearReadConversationRecords)
  // 2. The app restarts (Map is in-memory only)
  // No time-based expiry needed - memory usage is negligible (~400 bytes per conversation)
  // Fixes issue #13: users getting repeated notifications for weeks-old unread messages.
  const notifiedConversations = new Map<string, { body: string }>();

  // Clear notification records for conversations that are no longer unread
  // This allows new notifications to be sent when new messages arrive in the same conversation
  const clearReadConversationRecords = () => {
    const sidebar = findSidebarElement();
    if (!sidebar) return;

    const rows = sidebar.querySelectorAll(selectors.conversationRow);
    const unreadHrefs = new Set<string>();
    const unreadTitles = new Set<string>();

    // Collect all currently unread conversation hrefs and titles
    rows.forEach((row) => {
      if (isConversationUnread(row)) {
        const linkEl =
          row.querySelector(selectors.conversationLink) ||
          row.closest(selectors.conversationLink);
        const href = linkEl?.getAttribute('href');
        if (href) {
          unreadHrefs.add(href);
        }
        // Also collect titles for native notification key matching
        const info = extractConversationInfo(row);
        if (info?.title) {
          unreadTitles.add(info.title);
        }
      }
    });

    // Remove records for conversations that are no longer unread
    for (const key of notifiedConversations.keys()) {
      if (key.startsWith('native:')) {
        // For native notification keys (format: "native:SenderName"), check if
        // the sender still has unread messages
        const title = key.slice(7); // Remove "native:" prefix
        if (!unreadTitles.has(title)) {
          log('Clearing native notification record for read conversation', { title });
          notifiedConversations.delete(key);
        }
      } else {
        // For href-based keys (from MutationObserver), check against unread hrefs
        if (!unreadHrefs.has(key)) {
          log('Clearing notification record for read conversation', { href: key });
          notifiedConversations.delete(key);
        }
      }
    }
  };

  // Check if we've already notified for this exact message
  const hasAlreadyNotified = (href: string, body: string): boolean => {
    const existing = notifiedConversations.get(href);
    if (!existing) return false;
    // Already notified for this exact message content
    return existing.body === body;
  };

  const canSendNotification = (): boolean => {
    // No global rate limit
    return true;
  };

  const recordNotification = (href: string, body: string) => {
    notifiedConversations.set(href, { body });
  };

  // ============================================================================
  // UTILITY FUNCTIONS
  // ============================================================================

  // Generate text from a node, handling emojis
  const generateStringFromNode = (element: Element | null): string | undefined => {
    if (!element) return undefined;
    const cloneElement = element.cloneNode(true) as Element;
    const images = Array.from(cloneElement.querySelectorAll('img'));
    for (const image of images) {
      let emojiString = image.alt;
      if (emojiString === '(Y)' || emojiString === '(y)') {
        emojiString = '👍';
      }
      image.parentElement?.replaceWith(document.createTextNode(emojiString || ''));
    }
    return cloneElement.textContent?.trim() || undefined;
  };

  // Send notification via bridge or postMessage
  const sendNotification = (title: string, body: string, source: string, icon?: string, href?: string) => {
    log(`=== SENDING NOTIFICATION [${source}] ===`, { title, body: body.slice(0, 50), href });

    const notificationData = {
      title: String(title),
      body: String(body),
      id: Date.now() + Math.random(),
      icon,
      silent: false,
      href, // Include conversation URL for click-to-navigate
    };

    if ((window as any).__electronNotificationBridge) {
      try {
        (window as any).__electronNotificationBridge(notificationData);
        log('Notification sent via bridge');
      } catch (err) {
        log('Bridge call failed', { error: String(err) });
      }
    } else {
      log('Bridge not available, using postMessage');
      window.postMessage({ type: 'notification', data: notificationData }, '*');
    }
  };

  // Check if window is focused (notifications should be skipped if focused)
  const isWindowFocused = (): boolean => {
    return document.hasFocus() && document.visibilityState === 'visible';
  };

  const normalizePath = (path: string): string => {
    const withoutHashOrQuery = path.split(/[?#]/)[0];
    const trimmed = withoutHashOrQuery.replace(/\/+$/, '');
    return trimmed === '' ? '/' : trimmed;
  };

  const isCurrentConversation = (href: string): boolean => {
    const currentPath = normalizePath(window.location.pathname);
    const targetPath = normalizePath(href);
    return currentPath === targetPath;
  };

  // ============================================================================
  // CONVERSATION EXTRACTION
  // ============================================================================

  // Check if a conversation element has an unread indicator
  const isConversationUnread = (conversationEl: Element): boolean => {
    // PRIMARY CHECK: Look for "Unread message:" text in the conversation
    // This is how Messenger marks unread conversations in the DOM
    const textContent = conversationEl.textContent || '';
    if (textContent.includes('Unread message:')) {
      return true;
    }

    // Check aria-label patterns (the row element often has full text including "Unread message:")
    const ariaLabel = conversationEl.getAttribute('aria-label') || '';
    if (ariaLabel.includes('Unread message') || ariaLabel.toLowerCase().includes('unread')) {
      return true;
    }

    // Look for the "Mark as Read" button which indicates unread
    const markAsRead = conversationEl.querySelector(selectors.unreadIndicator);
    if (markAsRead) {
      return true;
    }

    // Check aria-label on child elements
    const childWithUnread = conversationEl.querySelector('[aria-label*="unread"], [aria-label*="Unread"]');
    if (childWithUnread) {
      return true;
    }

    return false;
  };

  // Detect whether a conversation is muted
  // Messenger shows a "bell with slash" SVG icon for muted conversations in the sidebar
  // The mute icon SVG has a path starting with "M9.244 24.99" (bell with diagonal slash)
  const isConversationMuted = (conversationEl: Element): boolean => {
    // PRIMARY DETECTION: Look for the mute bell icon SVG path
    // This path represents the "bell with slash" icon shown next to muted conversations
    // Path pattern: "M9.244 24.99..." - this is the diagonal slash through the bell
    const paths = Array.from(conversationEl.querySelectorAll('svg path'));
    for (const path of paths) {
      const d = path.getAttribute('d') || '';
      // Check for the specific mute icon path pattern
      // The mute bell SVG path starts with "M9.244 24.99" and contains "L26.867 7.366"
      if (d.startsWith('M9.244 24.99') || d.includes('L26.867 7.366')) {
        log('Muted detected via SVG mute bell path');
        return true;
      }
    }

    // FALLBACK: Check aria-label/text indicators (less reliable)
    const textContent = conversationEl.textContent || '';
    const ariaLabel = conversationEl.getAttribute('aria-label') || '';
    const lowered = ariaLabel.toLowerCase();
    if (
      lowered.includes('muted') ||
      lowered.includes('notifications are off') ||
      lowered.includes('notifications off') ||
      textContent.includes('Notifications are off')
    ) {
      log('Muted detected via aria-label/text', { ariaLabel: ariaLabel.slice(0, 100) });
      return true;
    }

    return false;
  };

  // Extract conversation info from a conversation element
  const extractConversationInfo = (
    conversationEl: Element,
    verbose = false,
  ): { title: string; body: string; href: string; icon?: string } | null => {
    // Find the link element to get the href (used for deduplication)
    const linkEl =
      conversationEl.querySelector(selectors.conversationLink) ||
      conversationEl.closest(selectors.conversationLink);
    const href = linkEl?.getAttribute('href');
    
    if (!href) {
      return null;
    }

    // Find all text elements
    const textElements = conversationEl.querySelectorAll(selectors.conversationText);
    
    if (textElements.length < 1) {
      return null;
    }

    const texts: string[] = [];
    textElements.forEach((el) => {
      const text = generateStringFromNode(el);
      if (text && text.length > 0) {
        // Filter out timestamps and metadata
        if (!/^\d+[mhdw]$/.test(text) && text !== '·' && text !== 'Unread message:') {
          texts.push(text);
        }
      }
    });

    const title = texts[0] || '';
    const body = texts[1] || 'New message';

    if (!title) {
      return null;
    }

    // Try to get the avatar icon
    const imgEl = conversationEl.querySelector('img');
    const icon = imgEl?.src;

    if (verbose) {
      log('extractConversationInfo', { title, body: body.slice(0, 30), href });
    }

    return { title, body, href, icon };
  };

  // Find sidebar or chat grid element
  const findSidebarElement = (): Element | null => {
    // Try primary selector
    let sidebar = document.querySelector(selectors.sidebar);
    if (sidebar) return sidebar;

    // Try finding grid and getting its navigation parent
    const grid = document.querySelector(selectors.chatsGrid);
    if (grid) {
      const navParent = grid.closest('[role="navigation"]');
      if (navParent) return navParent;
      return grid; // Use grid directly if no nav parent
    }

    return null;
  };

  // ============================================================================
  // NATIVE NOTIFICATION INTERCEPTION
  // ============================================================================

  // Handle events sent from the browser process (via preload)
  window.addEventListener('message', ({ data }: MessageEvent) => {
    if (!data || typeof data !== 'object') return;

    const { type, data: eventData } = data as { type: string; data: any };

    if (type === 'notification-callback') {
      const { callbackName, id } = eventData;
      const notification = notifications.get(id);
      if (!notification) return;

      if (notification[callbackName]) {
        notification[callbackName]();
      }

      if (callbackName === 'onclose') {
        notifications.delete(id);
      }
    }
  });

  let counter = 1;

  // Augmented Notification class that forwards to Electron
  const augmentedNotification = Object.assign(
    class {
      private readonly _id: number;

      constructor(title: string, options?: NotificationOptions) {
        // Handle React props in title and body
        let { body } = options || {};
        const bodyProperties = (body as any)?.props;
        body = bodyProperties ? bodyProperties.content?.[0] : options?.body || '';

        const titleProperties = (title as any)?.props;
        title = titleProperties ? titleProperties.content?.[0] : title || '';

        this._id = counter++;
        notifications.set(this._id, this as any);

        log('=== NATIVE NOTIFICATION INTERCEPTED ===', { id: this._id, title, body });

        // CRITICAL: Suppress notifications during settling period AND initial startup
        // Messenger often fires batched notifications for old messages when the app loads
        const timeSinceStart = Date.now() - appStartTime;
        if (isSettling || timeSinceStart < NATIVE_NOTIFICATION_SUPPRESS_MS) {
          log('Native notification suppressed - app still settling', {
            isSettling,
            timeSinceStart,
            threshold: NATIVE_NOTIFICATION_SUPPRESS_MS,
          });
          return;
        }

        // Use title as key for deduplication (title is usually the sender name)
        const key = `native:${title}`;
        const bodyStr = String(body).slice(0, 100);

        if (!hasAlreadyNotified(key, bodyStr) && canSendNotification()) {
          recordNotification(key, bodyStr);
          
          // Try to find the conversation href from the sidebar based on the notification title
          // This enables click-to-navigate for native notifications
          let href: string | undefined;
          const sidebar = findSidebarElement();
          if (sidebar) {
            const rows = Array.from(sidebar.querySelectorAll(selectors.conversationRow));
            for (const row of rows) {
              if (isConversationUnread(row)) {
                const info = extractConversationInfo(row);
                if (info && info.title === title) {
                  href = info.href;
                  log('Found href for native notification', { title, href });
                  break;
                }
              }
            }
            // If no exact match, try partial match (title might be truncated)
            if (!href) {
              for (const row of rows) {
                if (isConversationUnread(row)) {
                  const info = extractConversationInfo(row);
                  if (info && (info.title.includes(String(title)) || String(title).includes(info.title))) {
                    href = info.href;
                    log('Found href via partial match for native notification', { title, infoTitle: info.title, href });
                    break;
                  }
                }
              }
            }
          }
          
          sendNotification(String(title), String(body), 'NATIVE', options?.icon as string, href);
        } else {
          log('Native notification deduplicated', { key });
        }
      }

      close(): void {}

      addEventListener(event: string, listener: EventListener | null): void {
        if (!listener) return;
        if (!(this as any).listeners) {
          (this as any).listeners = new Map();
        }
        if (!(this as any).listeners.has(event)) {
          (this as any).listeners.set(event, []);
        }
        (this as any).listeners.get(event).push(listener);
      }

      removeEventListener(event: string, listener: EventListener | null): void {
        if (!listener || !(this as any).listeners) return;
        const listeners = (this as any).listeners.get(event);
        if (listeners) {
          const index = listeners.indexOf(listener);
          if (index > -1) {
            listeners.splice(index, 1);
          }
        }
      }

      static requestPermission(): Promise<NotificationPermission> {
        return Promise.resolve('granted');
      }

      static get permission(): NotificationPermission {
        return 'granted';
      }

      static set permission(_value: NotificationPermission) {
        // no-op
      }
    },
    notification,
  );

  // ============================================================================
  // DETECTION METHOD 1: MutationObserver on sidebar
  // ============================================================================
  const ENABLE_MUTATION_OBSERVER_NOTIFICATIONS = true;

  // Track whether we're in the initial settling period (no notifications during this time)
  // This applies to BOTH MutationObserver and native notification interception
  let isSettling = true;
  // Track the current sidebar element to detect navigation changes
  let currentSidebarElement: Element | null = null;
  // Track app startup time - used to suppress old notifications
  const appStartTime = Date.now();
  // How long after app start to suppress native notifications (longer than settling period)
  // This accounts for Messenger batching old notification delivery on load
  const NATIVE_NOTIFICATION_SUPPRESS_MS = 8000;

  // Scan and record all currently visible unread conversations (to avoid notifying on initial load)
  const recordExistingConversations = (sidebar: Element) => {
    const rows = sidebar.querySelectorAll(selectors.conversationRow);
    let recordedCount = 0;
    
    rows.forEach((row) => {
      if (isConversationUnread(row)) {
        const info = extractConversationInfo(row);
        if (info) {
          // Mark as already notified so we don't send notifications for these
          recordNotification(info.href, info.body);
          recordedCount++;
        }
      }
    });
    
    log(`Recorded ${recordedCount} existing unread conversations (will not notify for these)`);
  };

  const setupMutationObserver = () => {
    log('Setting up MutationObserver detection...');

    const processMutations = (mutationsList: MutationRecord[]) => {
      if (mutationsList.length === 0) return;

      // Skip if MutationObserver notifications are disabled
      // (disabled because sidebar rows don't contain mute status - see comment above)
      if (!ENABLE_MUTATION_OBSERVER_NOTIFICATIONS) {
        return;
      }

      // Don't send notifications during the settling period
      if (isSettling) {
        log('Skipping notifications - still in settling period');
        return;
      }

      // Global rate limit
      if (!canSendNotification()) {
        return;
      }

      clearReadConversationRecords();

      const alreadyProcessed = new Set<string>();

      // Process mutations in reverse order (newest first)
      for (const mutation of [...mutationsList].reverse()) {
        let target = mutation.target as Element;
        if (target.nodeType === Node.TEXT_NODE) {
          target = target.parentElement as Element;
        }
        if (!target) continue;

        // Walk up to find the conversation row
        const conversationRow = target.closest(selectors.conversationRow);
        if (!conversationRow) continue;

        // Extract info to get href for deduplication
        const info = extractConversationInfo(conversationRow);
        if (!info) continue;

        // Skip if already processed in this batch
        if (alreadyProcessed.has(info.href)) continue;
        alreadyProcessed.add(info.href);

        // Skip if this is the currently open conversation while window is focused
        if (isCurrentConversation(info.href) && isWindowFocused()) {
          continue;
        }

        // Check if this conversation is unread
        if (!isConversationUnread(conversationRow)) {
          continue;
        }

        // Skip muted conversations
        if (isConversationMuted(conversationRow)) {
          continue;
        }

        // Check if we've already notified for this exact message
        if (hasAlreadyNotified(info.href, info.body)) {
          continue;
        }

        recordNotification(info.href, info.body);
        log('Sending notification from MutationObserver', {
          title: info.title,
          body: info.body.slice(0, 50),
          href: info.href,
        });

        sendNotification(info.title, info.body, 'MUTATION', info.icon, info.href);
        // Only send one notification per mutation batch
        break;
      }
    };

    // Handle navigation changes - when sidebar changes, we need to re-settle
    const handleNavigationChange = () => {
      const sidebar = findSidebarElement();
      
      // Check if sidebar has changed (navigation to different section)
      if (sidebar && sidebar !== currentSidebarElement) {
        log('Navigation detected - sidebar changed, entering settling period');
        isSettling = true;
        currentSidebarElement = sidebar;
        
        // Record all existing conversations in the new view
        recordExistingConversations(sidebar);
        
        // End settling period after the page stabilizes
        setTimeout(() => {
          // Re-scan to catch any conversations that loaded after initial scan
          if (currentSidebarElement) {
            recordExistingConversations(currentSidebarElement);
          }
          isSettling = false;
          log('Settling period ended - now accepting notifications');
        }, 3000);
      }
    };

    // Watch for URL changes (SPA navigation)
    let lastUrl = window.location.href;
    const urlObserver = new MutationObserver(() => {
      if (window.location.href !== lastUrl) {
        log('URL changed', { from: lastUrl, to: window.location.href });
        lastUrl = window.location.href;
        // Give the page time to render, then handle navigation
        setTimeout(handleNavigationChange, 1000);
      }
    });
    
    urlObserver.observe(document.body, { childList: true, subtree: true });

    // Wait for sidebar to be available, then observe
    const startObserving = () => {
      const sidebar = findSidebarElement();

      if (sidebar) {
        log('MutationObserver: Found sidebar, starting observation', { tagName: sidebar.tagName });
        currentSidebarElement = sidebar;

        // CRITICAL: Record all existing conversations BEFORE enabling notifications
        // This prevents notifications for messages that were already there on load
        recordExistingConversations(sidebar);

        const observer = new MutationObserver(processMutations);
        observer.observe(sidebar, {
          characterData: true,
          subtree: true,
          childList: true,
          attributes: true,
          attributeFilter: ['src', 'alt', 'aria-label', 'class'],
        });

        // End the settling period after giving the page time to fully load
        // This accounts for lazy-loaded conversations and dynamic content
        setTimeout(() => {
          // Do one more scan to catch any late-loading conversations
          recordExistingConversations(sidebar);
          isSettling = false;
          log('MutationObserver: Settling period ended, now accepting notifications');
        }, 5000);

        log('MutationObserver: Active (in settling period)');
      } else {
        log('MutationObserver: Sidebar not found, will retry...');
        // Retry in a few seconds
        setTimeout(startObserving, 3000);
      }
    };

    // Start after page settles
    setTimeout(startObserving, 2000);
  };

  // ============================================================================
  // FOCUS/VISIBILITY HANDLERS
  // ============================================================================

  // When the window regains focus, clear notification records for conversations
  // that have been read. This allows new notifications to be sent for new messages.
  const handleWindowFocus = () => {
    log('Window focused - clearing read conversation records');
    // Small delay to allow Messenger's UI to update the read status
    setTimeout(() => {
      clearReadConversationRecords();
    }, 500);
  };

  window.addEventListener('focus', handleWindowFocus);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      handleWindowFocus();
    }
  });

  // ============================================================================
  // INITIALIZATION
  // ============================================================================

  // Override window.Notification
  Object.assign(window, { Notification: augmentedNotification });

  try {
    Object.defineProperty(window, 'Notification', {
      value: augmentedNotification,
      writable: false,
      configurable: false,
      enumerable: true,
    });
    log('Notification API overridden successfully');
  } catch (e) {
    log('Using fallback Notification override method');
  }

  // Start MutationObserver detection
  log('Starting MutationObserver notification detection...');
  setupMutationObserver();
  log('Initialization complete');
})(window, Notification);
