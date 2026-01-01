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
  const notifiedConversations = new Map<string, { body: string; time: number }>();
  const NOTIFICATION_EXPIRY_MS = 600000; // Forget after 10 minutes

  const cleanupNotifiedConversations = () => {
    const now = Date.now();
    for (const [key, data] of notifiedConversations.entries()) {
      if (now - data.time > NOTIFICATION_EXPIRY_MS) {
        notifiedConversations.delete(key);
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
    const now = Date.now();
    notifiedConversations.set(href, { body, time: now });
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

        // Use title as key for deduplication (title is usually the sender name)
        const key = `native:${title}`;
        const bodyStr = String(body).slice(0, 100);

        if (!hasAlreadyNotified(key, bodyStr) && canSendNotification()) {
          recordNotification(key, bodyStr);
          sendNotification(String(title), String(body), 'NATIVE', options?.icon as string);
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

  const setupMutationObserver = () => {
    log('Setting up MutationObserver detection...');

    const processMutations = (mutationsList: MutationRecord[]) => {
      if (mutationsList.length === 0) return;

      // Global rate limit
      if (!canSendNotification()) {
        return;
      }

      cleanupNotifiedConversations();

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

    // Wait for sidebar to be available, then observe
    const startObserving = () => {
      const sidebar = findSidebarElement();

      if (sidebar) {
        log('MutationObserver: Found sidebar, starting observation', { tagName: sidebar.tagName });

        const observer = new MutationObserver(processMutations);
        observer.observe(sidebar, {
          characterData: true,
          subtree: true,
          childList: true,
          attributes: true,
          attributeFilter: ['src', 'alt', 'aria-label', 'class'],
        });

        log('MutationObserver: Active');
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
