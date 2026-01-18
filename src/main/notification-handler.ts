import { Notification, nativeImage, BrowserWindow } from 'electron';

export interface NotificationData {
  title: string;
  body: string;
  icon?: string;
  tag?: string;
  silent?: boolean;
  requireInteraction?: boolean;
  href?: string; // Conversation URL for click-to-navigate
}

export class NotificationHandler {
  private activeNotifications: Map<string, Notification> = new Map();
  private getMainWindow: () => BrowserWindow | null;
  private appDisplayName: string;

  constructor(getMainWindow: () => BrowserWindow | null, appDisplayName: string = 'Messenger') {
    this.getMainWindow = getMainWindow;
    this.appDisplayName = appDisplayName;
  }

  showNotification(data: NotificationData): void {
    if (!Notification.isSupported()) {
      console.warn('[NotificationHandler] Notifications are not supported on this system');
      return;
    }

    console.log('[NotificationHandler] Showing notification:', { title: data.title, body: data.body, href: data.href });

    const notificationOptions: Electron.NotificationConstructorOptions = {
      title: data.title,
      body: data.body,
      silent: data.silent || false,
    };

    if (data.icon) {
      try {
        notificationOptions.icon = nativeImage.createFromDataURL(data.icon);
      } catch (e) {
        // If data URL is invalid, try as file path
        try {
          notificationOptions.icon = nativeImage.createFromPath(data.icon);
        } catch (e2) {
          // Ignore icon errors
        }
      }
    }

    const notification = new Notification(notificationOptions);

    // Handle notification click - navigate to the conversation
    notification.on('click', () => {
      const mainWindow = this.getMainWindow();
      const targetWindow = mainWindow || BrowserWindow.getAllWindows()[0];
      
      if (targetWindow) {
        targetWindow.show();
        targetWindow.focus();
        
        // Navigate to the conversation if href is provided
        if (data.href) {
          // Build full URL from the path (handle both relative and absolute hrefs)
          const conversationUrl = data.href.startsWith('http')
            ? data.href
            : `https://www.messenger.com${data.href}`;
          console.log('[NotificationHandler] Navigating to conversation:', conversationUrl);
          const targetPath = new URL(conversationUrl).pathname.replace(/\/+$/, '') || '/';

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

          targetWindow.webContents.executeJavaScript(navigationScript, true).catch((err) => {
            console.warn('[NotificationHandler] Failed to navigate to conversation', err);
          });
        }
      }
    });

    // Handle notification close
    notification.on('close', () => {
      if (data.tag) {
        this.activeNotifications.delete(data.tag);
      }
    });

    // Show the notification
    notification.show();

    // Store notification if it has a tag
    if (data.tag) {
      this.activeNotifications.set(data.tag, notification);
    }
  }

  showTrayNotification(): void {
    if (!Notification.isSupported()) {
      return;
    }

    const notification = new Notification({
      title: this.appDisplayName,
      body: `${this.appDisplayName} is running in the background. Click the tray icon to open.`,
      silent: true,
    });

    notification.show();
  }

  closeNotification(tag: string): void {
    const notification = this.activeNotifications.get(tag);
    if (notification) {
      notification.close();
      this.activeNotifications.delete(tag);
    }
  }

  closeAllNotifications(): void {
    this.activeNotifications.forEach((notification) => {
      notification.close();
    });
    this.activeNotifications.clear();
  }
}

