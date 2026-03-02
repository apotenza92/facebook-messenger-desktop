// Notification injection script - injected into page context after load
// Uses DUAL detection: MutationObserver + Title-based (inspired by Caprine)
// Both run in parallel for maximum reliability regardless of window size

((window, notification) => {
  // Prevent double injection
  if ((window as any).__messengerDesktopInjected) {
    console.log('[Notif Dual] Already injected, skipping');
    return;
  }
  (window as any).__messengerDesktopInjected = true;

  const DEBUG = true;
  const notifications = new Map<number, any>();
  type PowerStateEvent = "suspend" | "resume" | "lock-screen" | "unlock-screen";
  type NotificationCandidate = {
    href: string;
    title: string;
    body: string;
    muted: boolean;
    unread: boolean;
  };
  type NotificationMatchResult = {
    matchedHref?: string;
    confidence: number;
    ambiguous: boolean;
    muted: boolean;
    reason: string;
  };
  type NotificationDeduper = {
    shouldSuppress: (href: string, nowMs?: number) => boolean;
  };
  type NotificationCallClassification = {
    isIncomingCall: boolean;
    reason: string;
    matchedPattern?: string;
  };
  type NotificationDecisionPolicyApi = {
    resolveNativeNotificationTarget: (
      payload: { title: string; body: string },
      unreadRows: NotificationCandidate[],
    ) => NotificationMatchResult;
    createNotificationDeduper: (ttlMs?: number) => NotificationDeduper;
    isLikelyGlobalFacebookNotification: (payload: {
      title: string;
      body: string;
    }) => boolean;
    classifyCallNotification: (payload: {
      title: string;
      body: string;
    }) => NotificationCallClassification;
  };

  type IncomingCallSignalPayload = {
    dedupeKey?: string;
    caller?: string;
    source?: string;
  };

  const normalizeIncomingCallKey = (raw: string): string =>
    String(raw)
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .replace(/[^a-z0-9 :/_\-.]/g, '')
      .trim()
      .slice(0, 180);

  const extractIncomingCallerName = (text: string): string | undefined => {
    const normalized = String(text || '').replace(/\s+/g, ' ').trim();
    if (!normalized) return undefined;

    const withWordBreaks = normalized.replace(/([a-z])([A-Z])/g, '$1 $2');

    const patterns = [
      /\b([^\n]{1,120}?)\s+is calling\b/i,
      /\bincoming\s+(?:video\s+|audio\s+)?call\s+from\s+([^\n]{1,120}?)(?:\.|$)/i,
      /\b([^\n]{1,120}?)\s+wants to\s+(?:video\s+)?call\b/i,
    ];

    const dedupeRepeatedWords = (input: string): string => {
      const words = input.split(' ').filter(Boolean);
      if (words.length < 2) return input;

      // Collapse adjacent duplicate words.
      const compact: string[] = [];
      for (const word of words) {
        if (compact.length === 0 || compact[compact.length - 1].toLowerCase() !== word.toLowerCase()) {
          compact.push(word);
        }
      }

      // Collapse repeated full name halves: "Michael Potenza Michael Potenza".
      if (compact.length % 2 === 0) {
        const half = compact.length / 2;
        const firstHalf = compact.slice(0, half).join(' ').toLowerCase();
        const secondHalf = compact.slice(half).join(' ').toLowerCase();
        if (firstHalf === secondHalf) {
          return compact.slice(0, half).join(' ');
        }
      }

      return compact.join(' ');
    };

    const sanitize = (input: string): string => {
      let value = String(input)
        .replace(/[|•·]+/g, ' ')
        .replace(/\b(incoming|video|audio|call|from|end-to-end encrypted|decline|accept|join|ignore|cancel|messenger|facebook)\b/gi, ' ')
        .replace(/^[:\-\s]+|[:\-\s]+$/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

      // Collapse immediate repeated chunks (e.g. "Michael PotenzaMichael Potenza")
      const repeatedChunk = value.match(/^(.{2,60}?)\1+$/i);
      if (repeatedChunk?.[1]) {
        value = repeatedChunk[1].trim();
      }

      // Collapse repeated phrase with separator (e.g. "Michael Potenza Michael Potenza")
      const repeatedPhrase = value.match(/^(.{2,60}?)\s+\1$/i);
      if (repeatedPhrase?.[1]) {
        value = repeatedPhrase[1].trim();
      }

      value = dedupeRepeatedWords(value);
      return value;
    };

    for (const sourceText of [withWordBreaks, normalized]) {
      for (const pattern of patterns) {
        const match = sourceText.match(pattern);
        const candidate = sanitize(match?.[1] || '');
        if (candidate.length >= 2) {
          const words = candidate.split(' ').filter(Boolean);
          return words.slice(0, 4).join(' ').slice(0, 80);
        }
      }

      let fallbackMatch: RegExpMatchArray | null = null;
      try {
        fallbackMatch = sourceText.match(
          /\b([\p{L}][\p{L}\p{M}'’.-]*(?:\s+[\p{L}][\p{L}\p{M}'’.-]*){0,3})\b/u,
        );
      } catch {
        fallbackMatch = sourceText.match(
          /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3})\b/,
        );
      }
      const fallbackCandidate = sanitize(fallbackMatch?.[1] || '');
      if (fallbackCandidate.length >= 2) {
        return fallbackCandidate.slice(0, 80);
      }
    }

    return undefined;
  };

  const signalIncomingCall = (payload: IncomingCallSignalPayload = {}) => {
    log('=== INCOMING CALL DETECTED - Bringing window to foreground ===', payload);
    window.postMessage({ type: 'electron-incoming-call', data: payload }, '*');
  };

  const signalIncomingCallEnded = (reason: string) => {
    log('=== INCOMING CALL ENDED/DECLINED DETECTED ===', { reason });
    window.postMessage({ type: 'electron-incoming-call-ended', data: { reason } }, '*');
  };

  // Selectors for Messenger's DOM structure (these may need updates as Messenger changes)
  const selectors = {
    // The navigation area containing the chat list
    sidebar: '[role="navigation"]:has([role="grid"])',
    // Alternative: the grid directly
    chatsGrid: '[role="grid"][aria-label="Chats"]',
    // Individual conversation row container
    conversationRow: '[role="row"], [role="listitem"]',
    // Link element within a conversation (contains href for deduplication)
    conversationLink: '[role="link"], a[href*="/t/"], a[href*="/e2ee/t/"]',
    // Text content elements in conversation preview
    conversationText: '[dir="auto"]',
    // The unread indicator (blue dot next to unread conversations)
    unreadIndicator:
      '[aria-label*="Mark as read" i], [aria-label*="Mark as Read"], [aria-label*="mark as read"], [aria-label*="Unread message" i]',
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
    } catch { /* intentionally empty */ }
  };

  const getNotificationDecisionPolicy = (): NotificationDecisionPolicyApi | null => {
    const policy = (window as any).__mdNotificationDecisionPolicy;
    if (
      policy &&
      typeof policy.resolveNativeNotificationTarget === 'function' &&
      typeof policy.createNotificationDeduper === 'function' &&
      typeof policy.isLikelyGlobalFacebookNotification === 'function' &&
      typeof policy.classifyCallNotification === 'function'
    ) {
      return policy as NotificationDecisionPolicyApi;
    }
    return null;
  };

  const classifyCallPayload = (
    title: string,
    body: string,
  ): NotificationCallClassification => {
    const policy = getNotificationDecisionPolicy();
    if (!policy) {
      return { isIncomingCall: false, reason: 'policy-unavailable' };
    }

    return policy.classifyCallNotification({
      title: String(title),
      body: String(body),
    });
  };

  const normalizeCallDedupeKey = (title: string, body: string): string => {
    const normalized = `${title} ${body}`
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 240);
    return `native:call:${normalized}`;
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
  const nativeConversationDeduper =
    getNotificationDecisionPolicy()?.createNotificationDeduper(4000) ?? null;

  const normalizeConversationKey = (raw: string): string => {
    if (raw.startsWith('native:')) {
      return raw;
    }

    try {
      const url = raw.startsWith('http://') || raw.startsWith('https://')
        ? new URL(raw)
        : new URL(raw, window.location.origin);
      const trimmedPath = (url.pathname || '/').replace(/\/+$/, '') || '/';
      const canonicalPath = trimmedPath
        .replace(/^\/messages\/e2ee\/t\//, '/t/')
        .replace(/^\/messages\/t\//, '/t/')
        .replace(/^\/e2ee\/t\//, '/t/');
      return canonicalPath;
    } catch {
      const withoutHashOrQuery = raw.split(/[?#]/)[0] || '/';
      const trimmed = withoutHashOrQuery.replace(/\/+$/, '') || '/';
      return trimmed
        .replace(/^\/messages\/e2ee\/t\//, '/t/')
        .replace(/^\/messages\/t\//, '/t/')
        .replace(/^\/e2ee\/t\//, '/t/');
    }
  };

  const buildIncomingCallDedupeKey = (rawRoute?: string): string => {
    const route = normalizeConversationKey(
      typeof rawRoute === 'string' && rawRoute.trim().length > 0
        ? rawRoute
        : (window.location.pathname || '/'),
    );
    return normalizeIncomingCallKey(`call:${route}`);
  };

  // Clear notification records for conversations that are no longer unread
  // This allows new notifications to be sent when new messages arrive in the same conversation
  const clearReadConversationRecords = () => {
    const sidebar = findSidebarElement();
    if (!sidebar) return;

    const rows = sidebar.querySelectorAll(selectors.conversationRow);
    const unreadHrefs = new Set<string>();
    // Collect all currently unread conversation hrefs
    rows.forEach((row) => {
      if (isConversationUnread(row)) {
        const linkEl =
          row.querySelector(selectors.conversationLink) ||
          row.closest(selectors.conversationLink);
        const href = linkEl?.getAttribute('href');
        if (href) {
          unreadHrefs.add(normalizeConversationKey(href));
        }
      }
    });

    // Remove records for conversations that are no longer unread
    for (const key of notifiedConversations.keys()) {
      // Check href-based keys against unread hrefs
      if (!unreadHrefs.has(key)) {
        log('Clearing notification record for read conversation', { href: key });
        notifiedConversations.delete(key);
      }
    }
  };

  // Check if we've already notified for this exact message
  const hasAlreadyNotified = (href: string, body: string): boolean => {
    const key = normalizeConversationKey(href);
    const existing = notifiedConversations.get(key);
    if (!existing) return false;
    // Already notified for this exact message content
    return existing.body === body;
  };

  const isMessagesNotificationRoute = (): boolean => {
    try {
      const pathname = window.location.pathname.toLowerCase();
      return (
        pathname === '/messages' ||
        pathname.startsWith('/messages/') ||
        pathname.startsWith('/t/') ||
        pathname.startsWith('/e2ee/t/')
      );
    } catch {
      return false;
    }
  };

  const canSendNotification = (): boolean => {
    // Keep notifications scoped to message surfaces only.
    return isMessagesNotificationRoute();
  };

  const recordNotification = (href: string, body: string) => {
    const key = normalizeConversationKey(href);
    notifiedConversations.set(key, { body });
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
  const sendNotification = (
    title: string,
    body: string,
    source: string,
    icon?: string,
    href?: string,
    callClassification?: NotificationCallClassification,
  ) => {
    log(`=== SENDING NOTIFICATION [${source}] ===`, { title, body: body.slice(0, 50), href });

    const callResult = callClassification || classifyCallPayload(title, body);
    let effectiveTitle = String(title);
    let effectiveBody = String(body);

    if (callResult.isIncomingCall) {
      const callKey = buildIncomingCallDedupeKey(href);
      const caller = extractIncomingCallerName(`${title} ${body}`);
      log('Notification classified as incoming call', {
        source,
        reason: callResult.reason,
        matchedPattern: callResult.matchedPattern,
        callKey,
        caller,
      });
      signalIncomingCall({
        dedupeKey: callKey,
        caller,
        source: `notification:${source}`,
      });

      effectiveTitle = 'Incoming call';
      effectiveBody = caller
        ? `${caller} is calling you on Messenger`
        : 'Someone is calling you on Messenger';
    }

    const notificationData = {
      title: effectiveTitle,
      body: effectiveBody,
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
    return normalizeConversationKey(path);
  };

  const isCurrentConversation = (href: string): boolean => {
    const currentPath = normalizePath(window.location.pathname);
    const targetPath = normalizePath(href);
    return currentPath === targetPath;
  };

  // ============================================================================
  // CONVERSATION EXTRACTION
  // ============================================================================

  // Extract the relative timestamp from a conversation element (e.g., "5m", "2h", "3d", "1w")
  // Returns null if no timestamp is found (meaning message just arrived)
  const extractTimestamp = (conversationEl: Element): string | null => {
    const textElements = conversationEl.querySelectorAll(selectors.conversationText);
    for (const el of Array.from(textElements)) {
      const text = el.textContent?.trim() || '';
      // Match relative timestamps: 1m, 5m, 2h, 3d, 1w, etc.
      if (/^\d+[mhdw]$/.test(text)) {
        return text;
      }
      // Also check for "Just now" or "now" text
      if (/^just now$/i.test(text) || text.toLowerCase() === 'now') {
        return 'now';
      }
    }
    return null;
  };

  // Check if a message is fresh enough to warrant a notification
  // Messages with NO timestamp, "now"/"just now", or "1m" should trigger notifications
  // This prevents notifications for old messages that appear when scrolling or after app restart
  const isMessageFresh = (conversationEl: Element): boolean => {
    const timestamp = extractTimestamp(conversationEl);
    // Notify if no timestamp (brand new), "now"/"just now", or within 1 minute
    const isFresh = timestamp === null || timestamp === 'now' || timestamp === '1m';
    if (!isFresh) {
      log('Message not fresh - has timestamp', { timestamp });
    }
    return isFresh;
  };

  // Check if a conversation element has an unread indicator
  const isConversationUnread = (conversationEl: Element): boolean => {
    // PRIMARY CHECK: Look for "Unread message:" text in the conversation
    // This is how Messenger marks unread conversations in the DOM
    const textContent = conversationEl.textContent || '';
    if (textContent.includes('Unread message:')) {
      return true;
    }

    // Check aria-label patterns (strictly "Unread message" to avoid false positives)
    const ariaLabel = (conversationEl.getAttribute('aria-label') || '').toLowerCase();
    if (ariaLabel.includes('unread message')) {
      return true;
    }

    // Look for the "Mark as Read" button which indicates unread
    const markAsRead = conversationEl.querySelector(selectors.unreadIndicator);
    if (markAsRead) {
      return true;
    }

    // Child unread indicator (strict variant)
    const childUnreadIndicator = conversationEl.querySelector('[aria-label*="Unread message" i]');
    if (childUnreadIndicator) {
      return true;
    }

    return false;
  };

  type MuteAnalysis = {
    isMuted: boolean;
    method: 'legacy-path' | 'svg-use' | 'a11y-label' | 'none';
    matchedPathSnippet?: string;
    matchedHref?: string;
    matchedPhrase?: string;
  };

  const analyzeMuteSignals = (conversationEl: Element): MuteAnalysis => {
    const paths = Array.from(conversationEl.querySelectorAll('svg path'));
    for (const path of paths) {
      const d = path.getAttribute('d') || '';
      if (
        d.startsWith('M9.244 24.99') ||
        d.includes('L26.867 7.366') ||
        d.startsWith('M29.676 7.746') ||
        d.includes('L6.293 28.29') ||
        d.startsWith('M2.5 6c0-.322') ||
        d.includes('8.296 8.296A3.001 3.001 0 0 1 5 12.5')
      ) {
        return {
          isMuted: true,
          method: 'legacy-path',
          matchedPathSnippet: d.slice(0, 140),
        };
      }
    }

    const iconUseNodes = Array.from(conversationEl.querySelectorAll('svg use'));
    for (const useNode of iconUseNodes) {
      const href = (
        useNode.getAttribute('href') || useNode.getAttribute('xlink:href') || ''
      ).toLowerCase();
      if (
        href.includes('mute') ||
        href.includes('muted') ||
        href.includes('notification_off') ||
        (href.includes('bell') && href.includes('slash'))
      ) {
        return {
          isMuted: true,
          method: 'svg-use',
          matchedHref: href,
        };
      }
    }

    const labelSources: string[] = [];
    const pushLabel = (value: string | null | undefined) => {
      const text = value?.trim();
      if (text) labelSources.push(text.toLowerCase());
    };

    pushLabel(conversationEl.textContent);
    pushLabel(conversationEl.getAttribute('aria-label'));
    pushLabel(conversationEl.getAttribute('title'));
    pushLabel(conversationEl.getAttribute('data-tooltip-content'));

    const metaNodes = conversationEl.querySelectorAll(
      '[aria-label], [title], [data-tooltip-content], [data-tooltip], img[alt]',
    );
    metaNodes.forEach((node) => {
      pushLabel(node.getAttribute('aria-label'));
      pushLabel(node.getAttribute('title'));
      pushLabel(node.getAttribute('data-tooltip-content'));
      pushLabel(node.getAttribute('data-tooltip'));
      if (node instanceof HTMLImageElement) {
        pushLabel(node.alt);
      }
    });

    const mutePhrases = [
      'muted',
      'notifications are off',
      'notifications off',
      'notification off',
      'unmute',
      'turn on notifications',
      'turn notifications on',
    ];

    const matchedPhrase = labelSources.find((text) =>
      mutePhrases.some((phrase) => text.includes(phrase)),
    );

    if (matchedPhrase) {
      return {
        isMuted: true,
        method: 'a11y-label',
        matchedPhrase,
      };
    }

    return {
      isMuted: false,
      method: 'none',
    };
  };

  // Detect whether a conversation is muted
  // Keep this heuristic broad because Facebook frequently changes sidebar icon markup.
  const isConversationMuted = (conversationEl: Element): boolean => {
    const analysis = analyzeMuteSignals(conversationEl);
    if (!analysis.isMuted) return false;

    log('Muted detected', {
      method: analysis.method,
      matchedPathSnippet: analysis.matchedPathSnippet,
      matchedHref: analysis.matchedHref,
      matchedPhrase: analysis.matchedPhrase,
    });

    return true;
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
    const sidebar = document.querySelector(selectors.sidebar);
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
      return;
    }

    if (type === 'electron-power-state') {
      const state = eventData?.state as PowerStateEvent | undefined;
      if (!state) return;

      log('Power state change received', { state, timestamp: eventData?.timestamp });

      if (state === 'resume' || state === 'unlock-screen') {
        startSettlingPeriod({
          reason: state,
          durationMs: RESUME_SETTLING_MS,
          includeFresh: false,
        });
      } else {
        isSettling = true;
      }
      return;
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

        const policy = getNotificationDecisionPolicy();
        if (!policy) {
          // Fail-closed if policy script is unavailable to avoid muted leaks.
          log('Native notification policy unavailable - suppressing', { title });
          return;
        }

        const nativePayload = {
          title: String(title),
          body: String(body),
        };
        const callClassification = policy.classifyCallNotification(nativePayload);
        if (callClassification.isIncomingCall) {
          const bodyStr = String(body).slice(0, 100);
          const callDedupeKey = normalizeCallDedupeKey(
            nativePayload.title,
            nativePayload.body,
          );
          if (hasAlreadyNotified(callDedupeKey, bodyStr)) {
            log('Native call notification deduplicated', {
              title,
              dedupeKey: callDedupeKey,
            });
            return;
          }
          if (nativeConversationDeduper?.shouldSuppress(callDedupeKey)) {
            log('Native call notification suppressed by TTL deduper', {
              title,
              dedupeKey: callDedupeKey,
            });
            return;
          }
          recordNotification(callDedupeKey, bodyStr);
          log('Native notification classified as incoming call - bypassing mute matching', {
            title,
            reason: callClassification.reason,
            matchedPattern: callClassification.matchedPattern,
          });
          sendNotification(
            nativePayload.title,
            nativePayload.body,
            'NATIVE_CALL',
            options?.icon as string,
            undefined,
            callClassification,
          );
          return;
        }

        // CRITICAL: Suppress non-call notifications during settling period AND initial startup
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

        if (!canSendNotification()) {
          log('Native notification skipped outside messages route', { title });
          return;
        }

        if (policy.isLikelyGlobalFacebookNotification(nativePayload)) {
          log('Native notification suppressed - non-message Facebook activity', {
            title,
            body,
          });
          return;
        }

        const bodyStr = String(body).slice(0, 100);
        const sidebar = findSidebarElement();
        if (!sidebar) {
          log('Native notification skipped - sidebar unavailable', { title });
          return;
        }

        const rows = Array.from(sidebar.querySelectorAll(selectors.conversationRow));
        const rowByHref = new Map<string, Element>();
        const conversationCandidates: NotificationCandidate[] = [];

        for (const row of rows) {
          const info = extractConversationInfo(row);
          if (!info) continue;

          const unread = isConversationUnread(row);
          const normalizedHref = normalizeConversationKey(info.href);
          rowByHref.set(normalizedHref, row);
          conversationCandidates.push({
            href: normalizedHref,
            title: info.title,
            body: info.body,
            muted: isConversationMuted(row),
            unread,
          });
        }

        const match = policy.resolveNativeNotificationTarget(
          { title: String(title), body: String(body) },
          conversationCandidates,
        );
        log('Native notification match', match);

        if (match.ambiguous || !match.matchedHref) {
          log('Native notification ambiguous - suppressing', {
            title,
            confidence: match.confidence,
            reason: match.reason,
          });
          return;
        }

        if (match.muted) {
          log('Native notification for muted conversation - skipping', {
            title,
            href: match.matchedHref,
          });
          return;
        }

        const normalizedHref = normalizeConversationKey(match.matchedHref);
        const matchedRow = rowByHref.get(normalizedHref);
        if (!matchedRow) {
          log('Native notification match had no unread row - suppressing', {
            title,
            href: normalizedHref,
          });
          return;
        }

        if (!isConversationUnread(matchedRow)) {
          log('Native notification matched read conversation - suppressing', {
            title,
            href: normalizedHref,
          });
          return;
        }

        if (!isMessageFresh(matchedRow)) {
          log('Native notification for old message - skipping (has timestamp)', {
            title,
            href: normalizedHref,
          });
          return;
        }

        if (hasAlreadyNotified(normalizedHref, bodyStr)) {
          log('Native notification deduplicated', { href: normalizedHref });
          return;
        }

        if (nativeConversationDeduper?.shouldSuppress(normalizedHref)) {
          log('Native notification suppressed by TTL deduper', {
            title,
            href: normalizedHref,
          });
          return;
        }

        recordNotification(normalizedHref, bodyStr);
        sendNotification(
          String(title),
          String(body),
          'NATIVE',
          options?.icon as string,
          normalizedHref,
        );
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
  // Re-enabled: on facebook.com/messages the native Notification constructor
  // pipeline is often not invoked, so MutationObserver is required for
  // notification delivery. Keep strict unread/mute/fresh checks to avoid
  // false positives.
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
  const RESUME_SETTLING_MS = 8000;
  let settlingToken = 0;
  let settlingTimeoutId: number | null = null;

  const startSettlingPeriod = (options: {
    reason: string;
    sidebar?: Element | null;
    durationMs: number;
    includeFresh?: boolean;
    rescan?: boolean;
  }): void => {
    const {
      reason,
      sidebar = findSidebarElement(),
      durationMs,
      includeFresh = true,
      rescan = true,
    } = options;

    settlingToken += 1;
    const token = settlingToken;

    if (settlingTimeoutId !== null) {
      clearTimeout(settlingTimeoutId);
      settlingTimeoutId = null;
    }

    isSettling = true;

    if (sidebar) {
      currentSidebarElement = sidebar;
      recordExistingConversations(sidebar, { includeFresh, reason });
    }

    settlingTimeoutId = window.setTimeout(() => {
      if (token !== settlingToken) {
        return;
      }

      if (rescan && currentSidebarElement) {
        recordExistingConversations(currentSidebarElement, { includeFresh, reason });
      }

      isSettling = false;
      settlingTimeoutId = null;
      log(`Settling period ended (${reason})`);
    }, durationMs);
  };

  type RecordExistingOptions = {
    includeFresh?: boolean;
    reason?: string;
  };

  // Scan and record all currently visible unread conversations (to avoid notifying on initial load)
  const recordExistingConversations = (
    sidebar: Element,
    options: RecordExistingOptions = {},
  ) => {
    const { includeFresh = true, reason } = options;
    const rows = sidebar.querySelectorAll(selectors.conversationRow);
    let recordedCount = 0;

    rows.forEach((row) => {
      if (isConversationUnread(row)) {
        if (!includeFresh && isMessageFresh(row)) {
          return;
        }
        const info = extractConversationInfo(row);
        if (info) {
          // Mark as already notified so we don't send notifications for these
          recordNotification(info.href, info.body);
          recordedCount++;
        }
      }
    });

    const freshnessLabel = includeFresh ? '' : ' (excluding fresh)';
    const reasonLabel = reason ? ` after ${reason}` : '';
    log(
      `Recorded ${recordedCount} existing unread conversations${freshnessLabel}${reasonLabel}`,
    );
  };

  const setupMutationObserver = () => {
    log('Setting up MutationObserver detection...');

    const processMutations = (mutationsList: MutationRecord[]) => {
      if (mutationsList.length === 0) return;

      // Skip if MutationObserver notifications are disabled
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
          log('Skipping mutation notification for muted conversation', {
            title: info.title,
            href: info.href,
          });
          continue;
        }

        // CRITICAL: Skip if message is not fresh (has a timestamp like "5m", "2h", "3d", "1w")
        // This is the primary fix for issue #13 - only notify for messages that JUST arrived
        // Old messages that appear when scrolling or after app restart will have timestamps
        if (!isMessageFresh(conversationRow)) {
          log('Skipping notification - message has timestamp, not brand new', {
            title: info.title,
            href: info.href,
          });
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
        startSettlingPeriod({
          reason: 'navigation',
          sidebar,
          durationMs: 3000,
        });
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
        startSettlingPeriod({
          reason: 'startup',
          sidebar,
          durationMs: 5000,
        });

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
  // CHAT READ DETECTION
  // ============================================================================
  // Detect when messages are read in the currently active chat
  // and trigger a badge/unread count recount
  
  // Debounce badge recount requests to avoid excessive updates
  let badgeRecountTimeout: number | null = null;
  const requestBadgeRecount = () => {
    if (badgeRecountTimeout !== null) {
      clearTimeout(badgeRecountTimeout);
    }
    badgeRecountTimeout = window.setTimeout(() => {
      log('Requesting badge recount due to chat activity');
      window.postMessage({ type: 'electron-recount-badge' }, '*');
      badgeRecountTimeout = null;
    }, 300); // Wait 300ms to batch multiple changes
  };

  // Listen for Enter key to detect message sending (which marks messages as read)
  document.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
      // Enter key pressed (likely sending a message)
      // Wait for the UI to update, then request badge recount
      setTimeout(requestBadgeRecount, 100);
    }
  }, true); // Use capture phase to detect before Messenger handles it

  // Also monitor sidebar for unread status changes (messages marked as read)
  const setupReadDetectionObserver = () => {
    const sidebar = findSidebarElement();
    if (!sidebar) {
      setTimeout(setupReadDetectionObserver, 1000);
      return;
    }

    // Observe the sidebar for changes to unread indicators
    const readObserver = new MutationObserver((mutations) => {
      // Check if any mutations might indicate messages were marked as read
      let mightHaveCleared = false;
      
      for (const mutation of mutations) {
        // Check for attribute changes (aria-label updates)
        if (mutation.type === 'attributes' && mutation.attributeName?.includes('aria')) {
          mightHaveCleared = true;
          break;
        }
        // Check for text content changes in conversation rows
        if (mutation.type === 'characterData') {
          const text = mutation.target.textContent || '';
          // If "Unread message:" text is being removed, it means the chat was marked as read
          if (!text.includes('Unread message:')) {
            mightHaveCleared = true;
            break;
          }
        }
      }

      if (mightHaveCleared) {
        requestBadgeRecount();
      }
    });

    readObserver.observe(sidebar, {
      characterData: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['aria-label', 'class'],
    });

    log('Read detection observer active');
  };

  // Start read detection after a delay to ensure sidebar is available
  setTimeout(setupReadDetectionObserver, 3000);

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
  } catch (_e) {
    log('Using fallback Notification override method');
  }

  // Start MutationObserver detection
  log('Starting MutationObserver notification detection...');
  setupMutationObserver();

  // ============================================================================
  // INCOMING CALL POPUP DETECTION
  // ============================================================================
  // Messenger shows an in-page popup for incoming calls with Answer/Decline buttons.
  // We observe DOM changes to detect when this popup appears and bring window to foreground.

  const setupCallPopupObserver = () => {
    log('Setting up call popup detection...');

    // Track if we've already signaled for the current call to avoid repeated signals
    let lastCallSignalTime = 0;
    const CALL_SIGNAL_DEBOUNCE_MS = 5000; // Don't signal more than once every 5 seconds
    // Throttle attribute-mutation checks — class changes fire constantly in React apps
    let lastAttributeScanTime = 0;
    const ATTRIBUTE_SCAN_THROTTLE_MS = 500;
    // Skip isCallPopupElement subtree-walks on large containers (direct child limit)
    const MAX_CALL_POPUP_CHILD_COUNT = 200;
    let hasActiveIncomingCallUi = false;

    const hasVisibleIncomingCallUi = (): boolean => {
      const hasVisibleAnswerControl = Array.from(
        document.querySelectorAll(
          '[aria-label*="Answer" i], [aria-label*="Accept call" i], [aria-label*="Join call" i], [aria-label*="Accept video call" i], [aria-label*="Accept audio call" i]',
        ),
      ).some((el) => isAriaVisible(el));
      const hasVisibleDeclineControl = Array.from(
        document.querySelectorAll(
          '[aria-label*="Decline" i], [aria-label*="Ignore call" i], [aria-label*="Decline call" i]',
        ),
      ).some((el) => isAriaVisible(el));
      return hasVisibleAnswerControl && hasVisibleDeclineControl;
    };

    // Selectors and patterns that indicate an incoming call popup.
    // Use CSS Selectors Level 4 case-insensitive flag (supported in Chromium 49+).
    // Messenger's call UI typically contains:
    // - "Answer" or "Accept" button
    // - "Decline" or "Ignore" button
    // - Video/audio call icons
    // - Caller's profile picture with calling animation
    const callPopupSelectors = [
      // Buttons with call-related aria-labels (case-insensitive)
      '[aria-label*="Answer" i]',
      '[aria-label*="Decline" i]',
      '[aria-label*="Accept call" i]',
      '[aria-label*="Ignore call" i]',
      '[aria-label*="Accept video call" i]',
      '[aria-label*="Accept audio call" i]',
      '[aria-label*="Join call" i]',
      '[aria-label*="Join video" i]',
      '[aria-label*="Join audio" i]',
      // data-testid patterns (kept narrow to avoid matching unrelated quiz/event UI)
      '[data-testid*="incoming"]',
      '[data-testid*="call"]',
    ];

    // Text patterns that indicate incoming call UI
    const callTextPatterns = [
      /incoming (video |audio )?call/i,
      /is calling/i,
      /calling you/i,
      /wants to (video )?call/i,
      /join (the )?(video |audio )?call/i,
      /video call (has )?started/i,
      /audio call (has )?started/i,
    ];

    const buildIncomingCallPayloadFromElement = (
      element: Element,
      source: string,
    ): IncomingCallSignalPayload => {
      const textSample = (element.textContent || '').replace(/\s+/g, ' ').trim();
      const caller = extractIncomingCallerName(textSample);
      const route = normalizeConversationKey(window.location.pathname || '/');
      const dedupeKey = buildIncomingCallDedupeKey(route);

      return {
        dedupeKey,
        caller,
        source,
      };
    };

    // Check if an element or its children contain call-related UI
    const isCallPopupElement = (element: Element): boolean => {
      // Check for call-related selectors
      for (const selector of callPopupSelectors) {
        try {
          if (element.matches?.(selector) && isAriaVisible(element)) {
            return true;
          }

          const matchedDescendants = element.querySelectorAll?.(selector);
          if (
            matchedDescendants &&
            Array.from(matchedDescendants).some((candidate) => isAriaVisible(candidate))
          ) {
            return true;
          }
        } catch {
          // Ignore invalid selector errors
        }
      }

      // Check text content for call patterns
      const textContent = element.textContent || '';
      for (const pattern of callTextPatterns) {
        if (pattern.test(textContent)) {
          // Make sure it's actually a call UI and not just a message about calls
          // Look for action buttons nearby
          const buttons = element.querySelectorAll('button, [role="button"]');
          for (const button of Array.from(buttons)) {
            if (!isAriaVisible(button)) continue;
            const buttonLabel = button.getAttribute('aria-label') || button.textContent || '';
            if (/answer|accept|decline|ignore|join|cancel/i.test(buttonLabel)) {
              return true;
            }
          }
        }
      }

      return false;
    };

    // Process added nodes to check for call popup
    const checkForCallPopup = (nodes: NodeList) => {
      const now = Date.now();
      if (now - lastCallSignalTime < CALL_SIGNAL_DEBOUNCE_MS) {
        return; // Debounce - don't check if we recently signaled
      }

      for (const node of Array.from(nodes)) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;

        const element = node as Element;

        // Check if this element or its descendants indicate a call popup
        if (isCallPopupElement(element)) {
          log('Call popup detected in DOM - bringing window to foreground');
          hasActiveIncomingCallUi = true;
          lastCallSignalTime = now;
          signalIncomingCall(
            buildIncomingCallPayloadFromElement(element, 'dom-node'),
          );
          return;
        }

        // Also check children for deeply nested call UI
        const descendants = element.querySelectorAll('*');
        for (const desc of Array.from(descendants)) {
          if (isCallPopupElement(desc)) {
            log('Call popup detected in descendant - bringing window to foreground');
            hasActiveIncomingCallUi = true;
            lastCallSignalTime = now;
            signalIncomingCall(
              buildIncomingCallPayloadFromElement(desc, 'dom-descendant'),
            );
            return;
          }
        }
      }
    };

    // Returns true when the element is not aria-hidden/hidden and is actually rendered.
    // Used to distinguish a visible call popup from pre-rendered hidden controls.
    const isAriaVisible = (el: Element | null): boolean => {
      if (!el) return false;
      if (el.closest('[aria-hidden="true"]') || el.closest('[hidden]')) {
        return false;
      }

      const target = el instanceof HTMLElement ? el : null;
      if (!target) return true;

      const style = window.getComputedStyle(target);
      if (
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        style.opacity === '0' ||
        style.pointerEvents === 'none'
      ) {
        return false;
      }

      const rect = target.getBoundingClientRect();
      if (rect.width < 4 || rect.height < 4) {
        return false;
      }

      return true;
    };

    // Observe the entire document for call popup additions AND attribute changes
    // (Facebook sometimes reveals a pre-rendered overlay by toggling CSS classes).
    const callObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
          checkForCallPopup(mutation.addedNodes);
        } else if (mutation.type === 'attributes') {
          const changedEl = mutation.target as Element;
          if (changedEl.nodeType !== Node.ELEMENT_NODE) continue;
          const now = Date.now();
          if (now - lastCallSignalTime < CALL_SIGNAL_DEBOUNCE_MS) continue;
          // Throttle: class changes fire constantly in React — check at most twice/sec
          if (now - lastAttributeScanTime < ATTRIBUTE_SCAN_THROTTLE_MS) continue;
          lastAttributeScanTime = now;
          // Skip large containers to bound the cost of querySelector subtree walks
          if (changedEl.childElementCount <= MAX_CALL_POPUP_CHILD_COUNT && isCallPopupElement(changedEl)) {
            log('Call popup detected via attribute change');
            hasActiveIncomingCallUi = true;
            lastCallSignalTime = now;
            signalIncomingCall(
              buildIncomingCallPayloadFromElement(changedEl, 'attribute-change'),
            );
          }
        }
      }
    });

    // Start observing after the page has settled (reduced from 3000ms)
    setTimeout(() => {
      callObserver.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'hidden', 'aria-hidden'],
      });
      log('Call popup observer active');

      // Periodic fallback scan when the window is not focused.
      // Catches call popups revealed via mechanisms the MutationObserver may miss
      // (e.g. React portals, CSS-only show/hide not involving new DOM nodes).
      // Requires BOTH an answer-type AND a decline-type element to be aria-visible
      // simultaneously to avoid false positives from unrelated UI elements.
      window.setInterval(() => {
        const now = Date.now();
        if (now - lastCallSignalTime < CALL_SIGNAL_DEBOUNCE_MS) return;
        if (isWindowFocused()) return;

        if (hasVisibleIncomingCallUi()) {
          log('Periodic scan: incoming call UI detected (Answer + Decline both visible)');
          hasActiveIncomingCallUi = true;
          lastCallSignalTime = now;
          signalIncomingCall({
            dedupeKey: buildIncomingCallDedupeKey(window.location.pathname || '/'),
            source: 'periodic-scan',
          });
        }
      }, 5000);

      // Fast end/decline detector: once an incoming call UI has been observed,
      // clear overlay hint quickly when Answer/Decline controls disappear.
      window.setInterval(() => {
        if (!hasActiveIncomingCallUi) return;
        if (hasVisibleIncomingCallUi()) return;

        hasActiveIncomingCallUi = false;
        signalIncomingCallEnded('controls-disappeared');
      }, 1000);
    }, 1000);
  };

  setupCallPopupObserver();

  // ============================================================================
  // KEYBOARD SHORTCUTS & QUICK SWITCHER
  // ============================================================================

  // Get all conversation rows from sidebar (raw, may include empty rows)
  const getAllConversationRows = (): Element[] => {
    const sidebar = findSidebarElement();
    if (!sidebar) return [];
    return Array.from(sidebar.querySelectorAll(selectors.conversationRow));
  };

  // Get only valid chat rows (rows with actual conversation links)
  const getValidChatRows = (): { row: Element; link: HTMLAnchorElement; threadId: string }[] => {
    const rows = getAllConversationRows();
    const valid: { row: Element; link: HTMLAnchorElement; threadId: string }[] = [];
    for (const row of rows) {
      const link = row.querySelector('a[href*="/t/"]') as HTMLAnchorElement | null;
      if (link) {
        const href = link.getAttribute('href') || '';
        const match = href.match(/\/t\/(\d+)/);
        if (match) {
          valid.push({ row, link, threadId: match[1] });
        }
      }
    }
    return valid;
  };

  // Click on a conversation link
  const clickConversation = (link: HTMLAnchorElement): void => {
    link.click();
  };

  // Navigate to nth chat (1-indexed)
  const navigateToChat = (index: number): void => {
    const chats = getValidChatRows();
    if (index >= 1 && index <= chats.length) {
      clickConversation(chats[index - 1].link);
      log(`Navigated to chat ${index}`);
    }
  };

  // Get currently active conversation index
  const getCurrentChatIndex = (): number => {
    const currentPath = window.location.pathname;
    const match = currentPath.match(/\/t\/(\d+)/);
    if (!match) return -1;
    const currentThreadId = match[1];
    
    const chats = getValidChatRows();
    for (let i = 0; i < chats.length; i++) {
      if (chats[i].threadId === currentThreadId) {
        return i;
      }
    }
    return -1;
  };

  // Navigate to previous chat (up in sidebar)
  const navigateToPrevChat = (): void => {
    const chats = getValidChatRows();
    if (chats.length === 0) {
      log('No conversation rows found');
      return;
    }
    
    const currentIndex = getCurrentChatIndex();
    const newIndex = currentIndex <= 0 ? chats.length - 1 : currentIndex - 1;
    log(`Prev chat: current=${currentIndex}, new=${newIndex}, total=${chats.length}`);
    clickConversation(chats[newIndex].link);
  };

  // Navigate to next chat (down in sidebar)
  const navigateToNextChat = (): void => {
    const chats = getValidChatRows();
    if (chats.length === 0) {
      log('No conversation rows found');
      return;
    }
    
    const currentIndex = getCurrentChatIndex();
    const newIndex = currentIndex >= chats.length - 1 ? 0 : currentIndex + 1;
    log(`Next chat: current=${currentIndex}, new=${newIndex}, total=${chats.length}`);
    clickConversation(chats[newIndex].link);
  };

  // ============================================================================
  // THEME DETECTION
  // ============================================================================

  interface ThemeColors {
    backdrop: string;
    background: string;
    backgroundHover: string;
    border: string;
    text: string;
    textSecondary: string;
    textMuted: string;
    kbd: string;
    shadow: string;
  }

  const darkTheme: ThemeColors = {
    backdrop: 'rgba(0, 0, 0, 0.7)',
    background: '#242526',
    backgroundHover: '#3a3b3c',
    border: '#3a3b3c',
    text: '#e4e6eb',
    textSecondary: '#ffffff',
    textMuted: '#8a8d91',
    kbd: '#3a3b3c',
    shadow: '0 8px 32px rgba(0,0,0,0.4)',
  };

  const lightTheme: ThemeColors = {
    backdrop: 'rgba(0, 0, 0, 0.4)',
    background: '#ffffff',
    backgroundHover: '#f0f2f5',
    border: '#dddfe2',
    text: '#050505',
    textSecondary: '#1c1e21',
    textMuted: '#65676b',
    kbd: '#e4e6eb',
    shadow: '0 8px 32px rgba(0,0,0,0.15)',
  };

  const detectTheme = (): ThemeColors => {
    // Check for Facebook's dark mode class
    if (document.documentElement.classList.contains('__fb-dark-mode') ||
        document.body.classList.contains('__fb-dark-mode')) {
      return darkTheme;
    }
    
    // Check for light mode class
    if (document.documentElement.classList.contains('__fb-light-mode') ||
        document.body.classList.contains('__fb-light-mode')) {
      return lightTheme;
    }
    
    // Fallback: detect by background color luminance
    const bg = window.getComputedStyle(document.body).backgroundColor;
    const match = bg.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
    if (match) {
      const [, r, g, b] = match.map(Number);
      const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      return luminance < 0.5 ? darkTheme : lightTheme;
    }
    
    // Default to dark theme
    return darkTheme;
  };

  // ============================================================================
  // KEYBOARD SHORTCUTS OVERLAY
  // ============================================================================

  let shortcutsOverlay: HTMLElement | null = null;

  // Detect if running on macOS (in renderer process)
  const isMacOS = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
  const modKey = isMacOS ? '⌘' : 'Ctrl';

  const getShortcutsHTML = (theme: ThemeColors): string => `
    <div style="
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: ${theme.backdrop};
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 999999;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    " data-shortcuts-backdrop>
      <div style="
        background: ${theme.background};
        border-radius: 12px;
        padding: 24px 32px;
        min-width: 380px;
        color: ${theme.text};
        box-shadow: ${theme.shadow};
      ">
        <h2 style="margin: 0 0 20px 0; font-size: 20px; font-weight: 600; color: ${theme.textSecondary};">
          Keyboard Shortcuts
        </h2>
        <div style="display: grid; gap: 12px;">
          <div style="border-bottom: 1px solid ${theme.border}; padding-bottom: 12px;">
            <div style="color: ${theme.textMuted}; font-size: 12px; text-transform: uppercase; margin-bottom: 8px;">Navigation</div>
            <div style="display: flex; justify-content: space-between; margin-bottom: 6px; gap: 24px;">
              <span>Jump to chat 1-9</span>
              <kbd style="background: ${theme.kbd}; padding: 2px 8px; border-radius: 4px; font-size: 12px; white-space: nowrap;">${modKey} + 1-9</kbd>
            </div>
            <div style="display: flex; justify-content: space-between; margin-bottom: 6px; gap: 24px;">
              <span>Previous chat</span>
              <kbd style="background: ${theme.kbd}; padding: 2px 8px; border-radius: 4px; font-size: 12px; white-space: nowrap;">${modKey} + Shift + [</kbd>
            </div>
            <div style="display: flex; justify-content: space-between; gap: 24px;">
              <span>Next chat</span>
              <kbd style="background: ${theme.kbd}; padding: 2px 8px; border-radius: 4px; font-size: 12px; white-space: nowrap;">${modKey} + Shift + ]</kbd>
            </div>
          </div>
          <div style="border-bottom: 1px solid ${theme.border}; padding-bottom: 12px;">
            <div style="color: ${theme.textMuted}; font-size: 12px; text-transform: uppercase; margin-bottom: 8px;">Quick Actions</div>
            <div style="display: flex; justify-content: space-between; margin-bottom: 6px; gap: 24px;">
              <span>Quick switcher</span>
              <kbd style="background: ${theme.kbd}; padding: 2px 8px; border-radius: 4px; font-size: 12px; white-space: nowrap;">${modKey} + O</kbd>
            </div>
            <div style="display: flex; justify-content: space-between; gap: 24px;">
              <span>Show this help</span>
              <kbd style="background: ${theme.kbd}; padding: 2px 8px; border-radius: 4px; font-size: 12px; white-space: nowrap;">${modKey} + /</kbd>
            </div>
          </div>
        </div>
        <div style="margin-top: 16px; text-align: center; color: ${theme.textMuted}; font-size: 13px;">
          Press <kbd style="background: ${theme.kbd}; padding: 2px 6px; border-radius: 4px; font-size: 11px;">Esc</kbd> or click outside to close
        </div>
      </div>
    </div>
  `;

  const showShortcutsOverlay = (): void => {
    if (shortcutsOverlay) {
      hideShortcutsOverlay();
      return;
    }
    
    const theme = detectTheme();
    const div = document.createElement('div');
    div.innerHTML = getShortcutsHTML(theme);
    shortcutsOverlay = div.firstElementChild as HTMLElement;
    document.body.appendChild(shortcutsOverlay);
    
    // Close on backdrop click
    shortcutsOverlay.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).hasAttribute('data-shortcuts-backdrop')) {
        hideShortcutsOverlay();
      }
    });
    
    log('Shortcuts overlay shown');
  };

  const hideShortcutsOverlay = (): void => {
    if (shortcutsOverlay) {
      shortcutsOverlay.remove();
      shortcutsOverlay = null;
      log('Shortcuts overlay hidden');
    }
  };

  // ============================================================================
  // NAME CACHE - Learn real names from conversation avatars
  // ============================================================================

  const NAME_CACHE_KEY = 'messenger-desktop-name-cache';
  type NameCache = Record<string, { realNames: string[]; updatedAt: number }>;

  const loadNameCache = (): NameCache => {
    try {
      const data = localStorage.getItem(NAME_CACHE_KEY);
      if (!data) return {};
      const parsed = JSON.parse(data);
      // Migrate old format (realName: string) to new format (realNames: string[])
      for (const key of Object.keys(parsed)) {
        if (typeof parsed[key].realName === 'string') {
          parsed[key] = { realNames: [parsed[key].realName], updatedAt: parsed[key].updatedAt };
        }
      }
      return parsed;
    } catch { return {}; }
  };

  const saveNameCache = (cache: NameCache): void => {
    try { localStorage.setItem(NAME_CACHE_KEY, JSON.stringify(cache)); } catch { /* ignore */ }
  };

  const nameCache = loadNameCache();

  // Extract all real names from avatar alts in current conversation
  const extractRealNamesFromConversation = (): string[] => {
    const mainArea = document.querySelector('[role="main"]');
    if (!mainArea) return [];

    const imgs = Array.from(mainArea.querySelectorAll('img[alt]'));
    const names: string[] = [];
    const seen: Record<string, boolean> = {};
    
    for (let i = 0; i < imgs.length; i++) {
      const alt = imgs[i].getAttribute('alt') || '';
      if (alt.length < 3 || alt.length > 50) continue;
      if (alt.startsWith('Seen by')) continue;
      if (alt.startsWith('Open ')) continue; // "Open photo" etc
      if (alt.startsWith('Original ')) continue; // "Original image"
      if (['GIF', 'Sticker', 'Photo', 'Video'].includes(alt)) continue;
      // Skip emoji-only alts
      if (/^[\p{Emoji}\s]+$/u.test(alt)) continue;
      
      if (!seen[alt]) {
        seen[alt] = true;
        names.push(alt);
      }
    }
    return names;
  };

  // Update cache when viewing a conversation
  const updateNameCache = (): void => {
    const match = window.location.pathname.match(/\/t\/(\d+)/);
    if (!match) return;
    const threadId = match[1];

    const realNames = extractRealNamesFromConversation();
    if (realNames.length === 0) return;

    // Check if different from what we have
    const existing = nameCache[threadId];
    const namesChanged = !existing || 
      existing.realNames.length !== realNames.length ||
      existing.realNames.some((n, i) => n !== realNames[i]);
    
    if (namesChanged) {
      nameCache[threadId] = { realNames, updatedAt: Date.now() };
      saveNameCache(nameCache);
      log(`Name cache: thread ${threadId} -> [${realNames.join(', ')}]`);
    }
  };

  // Monitor for conversation changes with retry for slow-loading conversations
  let lastCheckedPath = '';
  setInterval(() => {
    if (window.location.pathname !== lastCheckedPath) {
      lastCheckedPath = window.location.pathname;
      // Try multiple times as conversation may load slowly
      const tryExtract = (attempt: number) => {
        updateNameCache();
        // Retry up to 5 times if no names found yet (covers ~8 seconds total)
        const match = window.location.pathname.match(/\/t\/(\d+)/);
        if (match && attempt < 5) {
          const threadId = match[1];
          if (!nameCache[threadId] || nameCache[threadId].realNames.length === 0) {
            setTimeout(() => tryExtract(attempt + 1), 1500);
          }
        }
      };
      setTimeout(() => tryExtract(0), 500); // Initial delay shorter
    }
  }, 500);

  // ============================================================================
  // QUICK SWITCHER
  // ============================================================================

  let commandPaletteEl: HTMLElement | null = null;
  let paletteInputEl: HTMLInputElement | null = null;
  let paletteResultsEl: HTMLElement | null = null;
  let paletteSelectedIndex = 0;
  let paletteContacts: { name: string; realNames?: string[]; threadId?: string; row: Element }[] = [];

  // Simple fuzzy match: check if query chars appear in order
  const fuzzyMatch = (query: string, text: string): { match: boolean; score: number } => {
    const q = query.toLowerCase();
    const t = text.toLowerCase();
    
    if (t.includes(q)) {
      return { match: true, score: t.indexOf(q) === 0 ? 100 : 50 };
    }
    
    let qi = 0;
    let score = 0;
    for (let ti = 0; ti < t.length && qi < q.length; ti++) {
      if (t[ti] === q[qi]) {
        score += (ti === 0 || t[ti - 1] === ' ') ? 10 : 5;
        qi++;
      }
    }
    
    return { match: qi === q.length, score };
  };

  // Match against both nickname and real names (supports multiple for groups)
  const fuzzyMatchContact = (query: string, contact: { name: string; realNames?: string[] }): { match: boolean; score: number } => {
    const nicknameMatch = fuzzyMatch(query, contact.name);
    let bestScore = nicknameMatch.score;
    let matched = nicknameMatch.match;
    
    if (contact.realNames) {
      for (const realName of contact.realNames) {
        const realNameMatch = fuzzyMatch(query, realName);
        if (realNameMatch.match && realNameMatch.score > bestScore) {
          bestScore = realNameMatch.score + 10; // Boost real name matches
          matched = true;
        }
      }
    }
    return { match: matched, score: bestScore };
  };

  // Extract contacts from sidebar with cached real names
  const extractContacts = (): { name: string; realNames?: string[]; threadId?: string; row: Element }[] => {
    const rows = getAllConversationRows();
    const contacts: { name: string; realNames?: string[]; threadId?: string; row: Element }[] = [];
    
    for (const row of rows) {
      const info = extractConversationInfo(row);
      if (info?.title) {
        // Get thread ID from href
        const match = info.href.match(/\/t\/(\d+)/);
        const threadId = match ? match[1] : undefined;
        
        // Look up real names from cache
        const cached = threadId ? nameCache[threadId] : undefined;
        // Only include if at least one real name differs from the display name
        const realNames = cached?.realNames?.filter(n => n !== info.title);
        
        contacts.push({ 
          name: info.title, 
          realNames: realNames && realNames.length > 0 ? realNames : undefined, 
          threadId, 
          row 
        });
      }
    }
    
    return contacts;
  };

  const getPaletteStyles = (theme: ThemeColors): string => `
    position: fixed;
    top: 80px;
    left: 50%;
    transform: translateX(-50%);
    width: 400px;
    max-width: 90vw;
    background: ${theme.background};
    border-radius: 12px;
    box-shadow: ${theme.shadow};
    z-index: 999999;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    overflow: hidden;
  `;

  let currentPaletteTheme: ThemeColors = darkTheme;

  const showCommandPalette = (): void => {
    if (commandPaletteEl) {
      hideCommandPalette();
      return;
    }
    
    currentPaletteTheme = detectTheme();
    paletteContacts = extractContacts();
    paletteSelectedIndex = 0;
    
    const div = document.createElement('div');
    div.style.cssText = getPaletteStyles(currentPaletteTheme);
    div.innerHTML = `
      <div style="padding: 12px;">
        <input type="text" placeholder="Search conversations..." style="
          width: 100%;
          background: ${currentPaletteTheme.backgroundHover};
          border: none;
          border-radius: 8px;
          padding: 12px 16px;
          font-size: 15px;
          color: ${currentPaletteTheme.text};
          outline: none;
          box-sizing: border-box;
        " data-palette-input>
      </div>
      <div style="max-height: 320px; overflow-y: auto;" data-palette-results></div>
    `;
    
    commandPaletteEl = div;
    paletteInputEl = div.querySelector('[data-palette-input]') as HTMLInputElement;
    paletteResultsEl = div.querySelector('[data-palette-results]') as HTMLElement;
    
    document.body.appendChild(commandPaletteEl);
    paletteInputEl.focus();
    
    // Show all contacts initially
    updatePaletteResults('');
    
    // Handle input
    paletteInputEl.addEventListener('input', () => {
      paletteSelectedIndex = 0;
      updatePaletteResults(paletteInputEl!.value);
    });
    
    // Handle keyboard navigation
    paletteInputEl.addEventListener('keydown', (e) => {
      const items = paletteResultsEl?.querySelectorAll('[data-palette-item]') || [];
      
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        paletteSelectedIndex = Math.min(paletteSelectedIndex + 1, items.length - 1);
        updatePaletteSelection();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        paletteSelectedIndex = Math.max(paletteSelectedIndex - 1, 0);
        updatePaletteSelection();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        selectPaletteItem(paletteSelectedIndex);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        hideCommandPalette();
      }
    });
    
    log('Quick switcher shown');
  };

  const hideCommandPalette = (): void => {
    if (commandPaletteEl) {
      commandPaletteEl.remove();
      commandPaletteEl = null;
      paletteInputEl = null;
      paletteResultsEl = null;
      paletteContacts = [];
      log('Quick switcher hidden');
    }
  };

  const updatePaletteResults = (query: string): void => {
    if (!paletteResultsEl) return;
    
    let results: { name: string; realNames?: string[]; threadId?: string; row: Element; score: number }[];
    
    if (!query.trim()) {
      // Show first 10 contacts
      results = paletteContacts.slice(0, 10).map((c, i) => ({ ...c, score: 100 - i }));
    } else {
      // Fuzzy search - match against both nickname and real names
      results = paletteContacts
        .map(c => {
          const { match, score } = fuzzyMatchContact(query, c);
          return { ...c, score, match };
        })
        .filter(c => c.match)
        .sort((a, b) => b.score - a.score)
        .slice(0, 10);
    }
    
    if (results.length === 0) {
      paletteResultsEl.innerHTML = `
        <div style="padding: 24px; text-align: center; color: ${currentPaletteTheme.textMuted};">
          No conversations found
        </div>
      `;
      return;
    }
    
    // Format display name: show "Nickname (Real Name, Real Name, ...)" if different
    const formatDisplayName = (c: { name: string; realNames?: string[] }): string => {
      if (c.realNames && c.realNames.length > 0) {
        const namesStr = c.realNames.map(n => escapeHtml(n)).join(', ');
        return `${escapeHtml(c.name)} <span style="color: ${currentPaletteTheme.textMuted};">(${namesStr})</span>`;
      }
      return escapeHtml(c.name);
    };
    
    paletteResultsEl.innerHTML = results.map((r, i) => `
      <div data-palette-item="${i}" style="
        padding: 10px 16px;
        cursor: pointer;
        display: flex;
        align-items: center;
        gap: 12px;
        background: ${i === paletteSelectedIndex ? currentPaletteTheme.backgroundHover : 'transparent'};
        color: ${currentPaletteTheme.text};
      ">
        <div style="
          width: 36px;
          height: 36px;
          border-radius: 50%;
          background: #0084ff;
          display: flex;
          align-items: center;
          justify-content: center;
          font-weight: 600;
          font-size: 14px;
          color: white;
        ">${(r.realNames?.[0] || r.name).charAt(0).toUpperCase()}</div>
        <span style="font-size: 15px;">${formatDisplayName(r)}</span>
      </div>
    `).join('');
    
    // Add click handlers
    paletteResultsEl.querySelectorAll('[data-palette-item]').forEach((el) => {
      el.addEventListener('click', () => {
        const idx = parseInt(el.getAttribute('data-palette-item') || '0', 10);
        selectPaletteItem(idx);
      });
      el.addEventListener('mouseenter', () => {
        const idx = parseInt(el.getAttribute('data-palette-item') || '0', 10);
        paletteSelectedIndex = idx;
        updatePaletteSelection();
      });
    });
  };

  const updatePaletteSelection = (): void => {
    if (!paletteResultsEl) return;
    paletteResultsEl.querySelectorAll('[data-palette-item]').forEach((el, i) => {
      (el as HTMLElement).style.background = i === paletteSelectedIndex ? currentPaletteTheme.backgroundHover : 'transparent';
    });
  };

  const selectPaletteItem = (index: number): void => {
    const query = paletteInputEl?.value.trim() || '';
    let results: { name: string; realNames?: string[]; row: Element }[];
    
    if (!query) {
      results = paletteContacts.slice(0, 10);
    } else {
      // Use fuzzyMatchContact to match both nickname and real names (same as updatePaletteResults)
      results = paletteContacts
        .map(c => ({ ...c, ...fuzzyMatchContact(query, c) }))
        .filter(c => c.match)
        .sort((a, b) => b.score - a.score)
        .slice(0, 10);
    }
    
    if (results[index]) {
      const link = results[index].row.querySelector('a[href*="/t/"]') as HTMLAnchorElement | null;
      if (link) {
        clickConversation(link);
      }
      hideCommandPalette();
    }
  };

  // HTML escape helper
  const escapeHtml = (text: string): string => {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  };

  // ============================================================================
  // GLOBAL KEYBOARD LISTENER
  // ============================================================================

  document.addEventListener('keydown', (e: KeyboardEvent) => {
    const isMod = e.metaKey || e.ctrlKey;
    
    // Close overlays on Escape
    if (e.key === 'Escape') {
      if (shortcutsOverlay) {
        hideShortcutsOverlay();
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (commandPaletteEl) {
        hideCommandPalette();
        e.preventDefault();
        e.stopPropagation();
        return;
      }
    }
    
    // Don't handle shortcuts if typing in a form input (but allow contentEditable for chat nav)
    const target = e.target as HTMLElement;
    const isInFormInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA';
    
    // Allow palette keyboard nav
    if (commandPaletteEl && target === paletteInputEl) {
      return; // Let palette handle its own keyboard events
    }
    
    // Cmd/Ctrl + O → Quick switcher (works everywhere)
    if (isMod && !e.shiftKey && e.key.toLowerCase() === 'o') {
      e.preventDefault();
      e.stopPropagation();
      showCommandPalette();
      return;
    }
    
    // Cmd/Ctrl + / → Shortcuts help (works everywhere)
    if (isMod && e.key === '/') {
      e.preventDefault();
      e.stopPropagation();
      showShortcutsOverlay();
      return;
    }
    
    // Skip navigation shortcuts if in form input (but allow in contentEditable message box)
    if (isInFormInput) return;
    
    // Cmd/Ctrl + 1-9 → Jump to chat
    if (isMod && !e.shiftKey && e.key >= '1' && e.key <= '9') {
      e.preventDefault();
      e.stopPropagation();
      navigateToChat(parseInt(e.key, 10));
      return;
    }
    
    // Cmd/Ctrl + Shift + [ or { → Previous chat (use e.code for physical key)
    if (isMod && e.shiftKey && (e.code === 'BracketLeft' || e.key === '[' || e.key === '{')) {
      e.preventDefault();
      e.stopPropagation();
      navigateToPrevChat();
      return;
    }
    
    // Cmd/Ctrl + Shift + ] or } → Next chat (use e.code for physical key)
    if (isMod && e.shiftKey && (e.code === 'BracketRight' || e.key === ']' || e.key === '}')) {
      e.preventDefault();
      e.stopPropagation();
      navigateToNextChat();
      return;
    }
  }, true); // Use capture to get events before Messenger

  // Listen for menu-triggered shortcuts overlay
  document.addEventListener('show-keyboard-shortcuts', () => {
    showShortcutsOverlay();
  });

  log('Keyboard shortcuts initialized');

  log('Initialization complete');
})(window, Notification);
