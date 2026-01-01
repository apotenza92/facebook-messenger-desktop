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

  constructor(getMainWindow: () => BrowserWindow | null) {
    this.getMainWindow = getMainWindow;
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
          // Build full URL from the path
          const conversationUrl = `https://www.messenger.com${data.href}`;
          console.log('[NotificationHandler] Navigating to conversation:', conversationUrl);
          const escapedUrl = conversationUrl.replace(/'/g, "\\'");
          const targetPath = new URL(conversationUrl).pathname.replace(/\/+$/, '') || '/';

          // Prefer in-app navigation by simulating a click on the matching link.
          // Fallback to location change if we cannot find the link.
          targetWindow.webContents
            .executeJavaScript(
              `
                (function() {
                  const targetPath = '${targetPath}';
                  const normalized = (p) => {
                    const withoutHashOrQuery = p.split(/[?#]/)[0];
                    const trimmed = withoutHashOrQuery.replace(/\\/+\$/, '');
                    return trimmed === '' ? '/' : trimmed;
                  };

                  if (normalized(window.location.pathname) === normalized(targetPath)) {
                    return 'already-there';
                  }

                  const links = Array.from(document.querySelectorAll('a[href]'));
                  const match = links.find((a) => {
                    try {
                      return normalized(new URL(a.href, window.location.origin).pathname) === normalized(targetPath);
                    } catch (_) {
                      return false;
                    }
                  });

                  if (match) {
                    match.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true }));
                    return 'clicked-link';
                  }

                  window.location.href = '${escapedUrl}';
                  return 'navigated-location';
                })();
              `,
              true,
            )
            .catch((err) => {
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
      title: 'Messenger',
      body: 'Messenger is running in the background. Click the tray icon to open.',
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

