import { Notification, nativeImage, BrowserWindow } from 'electron';
import { isMessagesRoute, toMessagesUrl } from './url-policy';
import {
  buildIncomingCallNotificationBody,
} from '../shared/incoming-call-evidence';
import {
  classifyCallNotification,
  classifyGroupManagementNotification,
  isLikelyGlobalFacebookNotification,
} from '../shared/notification-activity-policy';

export interface NotificationData {
  title: string;
  body: string;
  icon?: string;
  tag?: string;
  silent?: boolean;
  requireInteraction?: boolean;
  href?: string; // Conversation URL for click-to-navigate
  sourceKind: NotificationSourceKind;
  sourceLabel: string;
  provenanceReason?: string;
}

export type NotificationSourceKind =
  | "facebook"
  | "messenger-message"
  | "incoming-call"
  | "app-owned";

const NOTIFICATION_SOURCE_KINDS = new Set<NotificationSourceKind>([
  "facebook",
  "messenger-message",
  "incoming-call",
  "app-owned",
]);

export interface NotificationSoundDecision {
  silent: boolean;
  reasons?: string[];
}

export interface NotificationDisplayBoundaryDecision {
  suppress: boolean;
  reason: string | null;
  normalizedData: NotificationData;
}

export interface NotificationCleanupSummary {
  reason: string;
  activeBefore: number;
  closedCount: number;
  activeAfter: number;
  closed: Array<{
    key: string;
    title: string;
    href?: string;
    ageMs: number;
  }>;
}

export type NotificationSoundDecisionResolver = (
  data: NotificationData,
) => NotificationSoundDecision | null | undefined;

export type NotificationIconPathResolver = () => string | null | undefined;

function normalizeNotificationBodyText(value: string): string {
  const body = String(value || "").replace(/\s+/g, " ").trim();
  if (!body) return "";

  if (/^\(?icon for this message\)?$/i.test(body)) {
    return "";
  }

  if (body === "(Y)" || body === "(y)") {
    return "👍";
  }

  return body;
}

export function resolveNotificationDisplayBoundary(
  data: NotificationData,
): NotificationDisplayBoundaryDecision {
  const normalizedTitle = String(data.title || "").trim();
  const normalizedBody = normalizeNotificationBodyText(data.body || "");
  const activityPayload = {
    title: normalizedTitle,
    body: normalizedBody,
  };
  if (!NOTIFICATION_SOURCE_KINDS.has(data.sourceKind)) {
    return {
      suppress: true,
      reason: "display-boundary-missing-source-kind",
      normalizedData: {
        ...data,
        title: normalizedTitle,
        body: activityPayload.body,
      },
    };
  }

  if (!String(data.sourceLabel || "").trim()) {
    return {
      suppress: true,
      reason: "display-boundary-missing-source-label",
      normalizedData: {
        ...data,
        title: normalizedTitle,
        body: activityPayload.body,
      },
    };
  }

  if (data.sourceKind === "facebook") {
    return {
      suppress: true,
      reason: "display-boundary-unproven-facebook-source",
      normalizedData: {
        ...data,
        title: normalizedTitle,
        body: activityPayload.body,
      },
    };
  }

  if (
    data.sourceKind === "app-owned" ||
    data.sourceKind === "incoming-call"
  ) {
    const callClassification = classifyCallNotification(activityPayload);
    return {
      suppress: false,
      reason: null,
      normalizedData: {
        ...data,
        title: normalizedTitle,
        body: callClassification.isIncomingCall
          ? buildIncomingCallNotificationBody({ body: normalizedBody })
          : activityPayload.body,
      },
    };
  }

  const callClassification = classifyCallNotification(activityPayload);
  if (callClassification.shouldSuppressNotification) {
    return {
      suppress: true,
      reason: "display-boundary-call-history-activity",
      normalizedData: {
        ...data,
        title: normalizedTitle,
        body: activityPayload.body,
      },
    };
  }
  if (classifyGroupManagementNotification(activityPayload).isGroupManagement) {
    return {
      suppress: true,
      reason: "display-boundary-group-management-activity",
      normalizedData: {
        ...data,
        title: normalizedTitle,
        body: activityPayload.body,
      },
    };
  }

  if (isLikelyGlobalFacebookNotification(activityPayload)) {
    return {
      suppress: true,
      reason: "display-boundary-shared-global-activity",
      normalizedData: {
        ...data,
        title: normalizedTitle,
        body: activityPayload.body,
      },
    };
  }

  const displayBody =
    callClassification.isIncomingCall
      ? buildIncomingCallNotificationBody({ body: normalizedBody })
      : normalizedBody;

  return {
    suppress: false,
    reason: null,
    normalizedData: {
      ...data,
      title: normalizedTitle,
      body: displayBody,
    },
  };
}

type ActiveNotificationRecord = {
  notification: Notification;
  key: string;
  title: string;
  body: string;
  href?: string;
  createdAt: number;
  isIncomingCall: boolean;
};

export class NotificationHandler {
  private activeNotifications: Map<string, ActiveNotificationRecord> = new Map();
  private getMainWindow: () => BrowserWindow | null;
  private appDisplayName: string;
  private createNotification: (options: Electron.NotificationConstructorOptions) => Notification;
  private resolveSoundDecision?: NotificationSoundDecisionResolver;
  private resolveDefaultIconPath?: NotificationIconPathResolver;
  private recordTestNotification(normalizedData: NotificationData): void {
    const enabled =
      process.env.MESSENGER_TEST_CAPTURE_NOTIFICATIONS === '1' ||
      process.env.MESSENGER_TEST_CAPTURE_NOTIFICATIONS === 'true';
    if (!enabled) return;

    const target = globalThis as typeof globalThis & {
      __mdNotificationEvents?: Array<Record<string, unknown>>;
    };
    if (!Array.isArray(target.__mdNotificationEvents)) {
      target.__mdNotificationEvents = [];
    }

    target.__mdNotificationEvents.push({
      timestamp: Date.now(),
      title: normalizedData.title,
      body: normalizedData.body,
      tag: normalizedData.tag,
      href: normalizedData.href,
      silent: normalizedData.silent === true,
      requireInteraction: normalizedData.requireInteraction === true,
      sourceKind: normalizedData.sourceKind,
      sourceLabel: normalizedData.sourceLabel,
      provenanceReason: normalizedData.provenanceReason,
    });
  }

  constructor(
    getMainWindow: () => BrowserWindow | null,
    appDisplayName: string = 'Messenger',
    createNotification: (options: Electron.NotificationConstructorOptions) => Notification = (options) =>
      new Notification(options),
    resolveSoundDecision?: NotificationSoundDecisionResolver,
    resolveDefaultIconPath?: NotificationIconPathResolver,
  ) {
    this.getMainWindow = getMainWindow;
    this.appDisplayName = appDisplayName;
    this.createNotification = createNotification;
    this.resolveSoundDecision = resolveSoundDecision;
    this.resolveDefaultIconPath = resolveDefaultIconPath;
  }

  showNotification(data: NotificationData): boolean {
    if (!Notification.isSupported()) {
      console.warn('[NotificationHandler] Notifications are not supported on this system');
      return false;
    }

    console.log('[NotificationHandler] Showing notification:', {
      title: data.title,
      body: data.body,
      href: data.href,
      sourceKind: data.sourceKind,
      sourceLabel: data.sourceLabel,
      provenanceReason: data.provenanceReason,
    });

    const displayBoundary = resolveNotificationDisplayBoundary(data);
    if (displayBoundary.suppress) {
      console.log('[NotificationHandler] Suppressed non-message notification at display boundary', {
        reason: displayBoundary.reason,
        payload: displayBoundary.normalizedData,
      });
      return false;
    }

    const normalizedData = displayBoundary.normalizedData;

    const requestedSilent = normalizedData.silent === true;
    const soundDecision = this.resolveSoundDecision
      ? this.resolveSoundDecision(normalizedData)
      : null;
    const effectiveSilent = soundDecision?.silent ?? requestedSilent;

    if (!requestedSilent && effectiveSilent && soundDecision?.reasons?.length) {
      console.log('[NotificationHandler] Suppressing notification sound', {
        title: normalizedData.title,
        reasons: soundDecision.reasons,
      });
    }

    const notificationOptions: Electron.NotificationConstructorOptions = {
      title: normalizedData.title,
      body: normalizedData.body,
      silent: effectiveSilent,
      ...(normalizedData.requireInteraction === true
        ? { timeoutType: 'never' as const }
        : {}),
    };

    const defaultIconPath = this.resolveDefaultIconPath?.();
    if (defaultIconPath) {
      try {
        notificationOptions.icon = nativeImage.createFromPath(defaultIconPath);
      } catch (_e) {
        // Fall through to a renderer-provided icon if the packaged icon cannot load.
      }
    }

    if (!notificationOptions.icon && data.icon) {
      try {
        notificationOptions.icon = nativeImage.createFromDataURL(data.icon);
      } catch (_e) {
        // If data URL is invalid, try as file path
        try {
          notificationOptions.icon = nativeImage.createFromPath(data.icon);
        } catch (_e2) {
          // Ignore icon errors
        }
      }
    }

    const notification = this.createNotification(notificationOptions);
    const notificationKey = data.tag || `untagged-${Date.now()}-${Math.random()}`;
    const createdAt = Date.now();
    const activeRecord: ActiveNotificationRecord = {
      notification,
      key: notificationKey,
      title: normalizedData.title,
      body: normalizedData.body,
      href: normalizedData.href,
      createdAt,
      isIncomingCall: classifyCallNotification({
        title: normalizedData.title,
        body: normalizedData.body,
      }).isIncomingCall,
    };

    notification.on('show', () => {
      console.log('[NotificationHandler] Notification shown', {
        key: notificationKey,
        title: normalizedData.title,
        href: normalizedData.href,
      });
    });
    notification.on('failed', (_event: unknown, error: string) => {
      console.warn('[NotificationHandler] Notification failed', {
        key: notificationKey,
        title: normalizedData.title,
        href: normalizedData.href,
        error,
      });
      this.activeNotifications.delete(notificationKey);
    });

    // Handle notification click - navigate to the conversation
    notification.on('click', () => {
      console.log('[NotificationHandler] Notification clicked', {
        key: notificationKey,
        title: normalizedData.title,
        href: normalizedData.href,
      });
      const mainWindow = this.getMainWindow();
      const targetWindow = mainWindow || BrowserWindow.getAllWindows()[0];

      if (targetWindow) {
        targetWindow.show();
        targetWindow.focus();
        
        // Navigate to the conversation if href is provided
        if (data.href) {
          // Build a canonical facebook.com/messages URL from relative or absolute href.
          const conversationUrl = toMessagesUrl(data.href);
          console.log('[NotificationHandler] Navigating to conversation:', conversationUrl);
          const targetPath = new URL(conversationUrl).pathname.replace(/\/+$/, '') || '/';
          const targetWebContents = (() => {
            const views = targetWindow.getBrowserViews();
            if (views.length === 1) {
              return views[0].webContents;
            }
            for (const view of views) {
              const url = view.webContents.getURL();
              if (isMessagesRoute(url)) {
                return view.webContents;
              }
            }
            return views[0]?.webContents || targetWindow.webContents;
          })();

          // Navigation script with retry logic for when sidebar isn't rendered yet
          const navigationScript = `
            (function() {
              const targetPath = '${targetPath}';
              const normalized = (p) => {
                const withoutHashOrQuery = p.split(/[?#]/)[0];
                const trimmed = withoutHashOrQuery.replace(/\\/+$/, '');
                return trimmed === '' ? '/' : trimmed;
              };

              const tryNavigate = () => {
                if (normalized(window.location.pathname) === normalized(targetPath)) {
                  return 'already-there';
                }

                // Search for links including role="link" elements (Messenger uses these)
                const links = Array.from(document.querySelectorAll('a[href], [role="link"][href], [href]'));
                const match = links.find((el) => {
                  try {
                    const href = el.getAttribute('href');
                    if (!href) return false;
                    return normalized(new URL(href, window.location.origin).pathname) === normalized(targetPath);
                  } catch (_) {
                    return false;
                  }
                });

                if (match) {
                  // Use pointer events + click for better compatibility with Messenger's handlers
                  match.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
                  match.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true }));
                  if (match.click) match.click();
                  return 'clicked-link';
                }

                return null; // Not found yet
              };

              // Try immediately
              const immediateResult = tryNavigate();
              if (immediateResult) return immediateResult;

              // Retry with exponential backoff (sidebar may not be rendered yet)
              let retries = 0;
              const maxRetries = 8;
              const retry = () => {
                retries++;
                const result = tryNavigate();
                if (result) return;
                if (retries < maxRetries) {
                  setTimeout(retry, 250 * Math.min(retries, 4));
                } else {
                  // Final fallback: direct navigation
                  window.location.assign('${targetPath}');
                }
              };
              setTimeout(retry, 250);
              return 'retrying';
            })();
          `;

          targetWebContents.executeJavaScript(navigationScript, true).catch((err) => {
            console.warn('[NotificationHandler] Failed to navigate to conversation', err);
          });
        }
      }
    });
    notification.on('action', () => {
      console.log('[NotificationHandler] Notification action invoked', {
        key: notificationKey,
        title: normalizedData.title,
        href: normalizedData.href,
      });
      notification.emit('click');
    });

    // Handle notification close
    notification.on('close', () => {
      console.log('[NotificationHandler] Notification closed', {
        key: notificationKey,
        title: normalizedData.title,
        href: normalizedData.href,
      });
      this.activeNotifications.delete(notificationKey);
    });

    this.activeNotifications.set(notificationKey, activeRecord);

    // Show the notification
    notification.show();
    this.recordTestNotification(normalizedData);

    return true;
  }

  showTrayNotification(): void {
    this.showNotification({
      title: this.appDisplayName,
      body: `${this.appDisplayName} is running in the background. Click the tray icon to open.`,
      silent: true,
      sourceKind: "app-owned",
      sourceLabel: "tray-background-notification",
      provenanceReason: "tray-background-state",
    });
  }

  closeNotification(tag: string): void {
    const record = this.activeNotifications.get(tag);
    if (record) {
      record.notification.close();
      this.activeNotifications.delete(tag);
    }
  }

  closeActiveNotifications(
    reason = 'manual-cleanup',
    options: { includeIncomingCalls?: boolean; minAgeMs?: number } = {},
  ): NotificationCleanupSummary {
    const now = Date.now();
    const activeBefore = this.activeNotifications.size;
    const closed: NotificationCleanupSummary['closed'] = [];
    const includeIncomingCalls = options.includeIncomingCalls === true;
    const minAgeMs = Math.max(0, Math.floor(options.minAgeMs ?? 0));

    this.activeNotifications.forEach((record, key) => {
      const ageMs = Math.max(0, now - record.createdAt);
      if (record.isIncomingCall && !includeIncomingCalls) {
        return;
      }
      if (minAgeMs > 0 && ageMs < minAgeMs) {
        return;
      }
      try {
        record.notification.close();
      } catch (error) {
        console.warn('[NotificationHandler] Failed to close active notification', {
          key,
          reason,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      closed.push({
        key,
        title: record.title,
        href: record.href,
        ageMs,
      });
      this.activeNotifications.delete(key);
    });

    const summary: NotificationCleanupSummary = {
      reason,
      activeBefore,
      closedCount: closed.length,
      activeAfter: this.activeNotifications.size,
      closed,
    };

    console.log('[NotificationHandler] Closed active notifications', summary);
    return summary;
  }

  closeAllNotifications(): void {
    this.closeActiveNotifications('close-all', { includeIncomingCalls: true });
  }
}
