import { contextBridge, ipcRenderer } from 'electron';

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  // Notification API override (legacy - kept for compatibility)
  showNotification: (data: {
    title: string;
    body: string;
    icon?: string;
    tag?: string;
    silent?: boolean;
  }) => {
    ipcRenderer.send('show-notification', data);
  },
  
  // Unread count updates
  updateUnreadCount: (count: number) => {
    ipcRenderer.send('update-unread-count', count);
  },
  
  // Clear badge
  clearBadge: () => {
    ipcRenderer.send('clear-badge');
  },
  
  // Notification actions
  onNotificationAction: (callback: (action: string, data: any) => void) => {
    ipcRenderer.on('notification-action-handler', (event, action, data) => {
      callback(action, data);
    });
  },
  
  // Test notification (for testing)
  testNotification: () => {
    ipcRenderer.send('test-notification');
  },
});

// Listen for notification events from the injected script
// The injected script dispatches custom events that we can catch
// We need to inject a listener into the page context that forwards to us
(function setupNotificationBridge() {
  // Inject a script into the page context to listen for custom events
  // and forward them to the preload context via a message
  const bridgeScript = `
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
  window.addEventListener('message', (event: MessageEvent) => {
    // Only process messages from the same origin (our injected script)
    if (event.data && typeof event.data === 'object') {
      // Handle both 'electron-notification' (from bridge) and 'notification' (from fallback)
      if (event.data.type === 'electron-notification' || event.data.type === 'notification') {
        const data = event.data.data;
        try {
          console.log('[Preload Bridge] Received electron-notification', {
            title: data?.title,
            hasIcon: Boolean(data?.icon),
            tag: data?.tag,
            id: data?.id,
          });
        } catch (_) {}
        
        // Convert icon if it's a data URL
        if (data.icon) {
          const image = new Image();
          image.crossOrigin = 'anonymous';
          
          image.addEventListener('load', () => {
            const canvas = document.createElement('canvas');
            const context = canvas.getContext('2d');
            if (context) {
              canvas.width = image.width;
              canvas.height = image.height;
              context.drawImage(image, 0, 0);
              
              const iconDataUrl = canvas.toDataURL();
              ipcRenderer.send('show-notification', {
                title: data.title,
                body: data.body,
                icon: iconDataUrl,
                tag: data.tag,
                silent: data.silent,
                id: data.id,
                href: data.href, // Pass conversation URL for click navigation
              });
              try {
                console.log('[Preload Bridge] Sent notification with icon to main', { id: data.id, title: data.title, href: data.href });
              } catch (_) {}
            }
          });
          
          image.addEventListener('error', () => {
            // If image loading fails, send without icon
            ipcRenderer.send('show-notification', {
              title: data.title,
              body: data.body,
              tag: data.tag,
              silent: data.silent,
              id: data.id,
              href: data.href, // Pass conversation URL for click navigation
            });
            try {
              console.warn('[Preload Bridge] Icon load failed, sent without icon', { id: data.id, title: data.title, href: data.href });
            } catch (_) {}
          });
          
          image.src = data.icon;
        } else {
          // No icon, send directly
          ipcRenderer.send('show-notification', {
            title: data.title,
            body: data.body,
            tag: data.tag,
            silent: data.silent,
            id: data.id,
            href: data.href, // Pass conversation URL for click navigation
          });
          try {
            console.log('[Preload Bridge] Sent notification without icon to main', { id: data.id, title: data.title, href: data.href });
          } catch (_) {}
        }
      } else if (event.data.type === 'electron-fallback-log') {
        try {
          ipcRenderer.send('log-fallback', event.data.data);
        } catch (_) {}
      }
    }
  });
})();

// Legacy Notification override (kept as fallback, but main injection happens after page load)
// This must happen immediately and be non-configurable to prevent messenger.com from overriding it
(function() {
  'use strict';

  // Store original Notification constructor if it exists
  const OriginalNotification = window.Notification;

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
        this.body = this.options.body || '';

        console.log('[Notification Override] Creating notification:', { title, body: this.body, tag: this.tag });

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
          console.warn('[Notification Override] electronAPI not available yet');
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
        return Promise.resolve('granted');
      }

      static get permission(): NotificationPermission {
        return 'granted';
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
    const existingDescriptor = Object.getOwnPropertyDescriptor(window, 'Notification');
    if (existingDescriptor && existingDescriptor.configurable) {
      delete (window as any).Notification;
    }
    
    Object.defineProperty(window, 'Notification', {
      value: ElectronNotification,
      writable: false,
      configurable: false,
      enumerable: true,
    });

    // Note: We don't need to define the prototype property - it's already
    // read-only on class constructors and cannot be reassigned

    console.log('[Notification Override] Successfully overridden Notification API');
  } catch (e) {
    // If defineProperty fails, we can't safely assign a class constructor directly
    // as it may cause prototype errors. Log the error and continue.
    console.error('[Notification Override] Failed to override Notification API:', e);
    console.warn('[Notification Override] Notifications may not work correctly');
  }

  // Continuously monitor and re-override if messenger.com tries to change it
  let overrideCheckInterval: number | null = null;
  
  function ensureOverride() {
    // Check if Notification was changed by comparing constructor name or instance
    const currentNotification = (window as any).Notification;
    
    // If it's already our notification, don't do anything
    if (currentNotification === ElectronNotification) {
      return;
    }
    
    // Check if it has our class name
    if (currentNotification && currentNotification.name === 'ElectronNotification') {
      return;
    }
    
    // Only try to override if it's actually different
    console.log('[Notification Override] Detected Notification was changed, re-overriding...');
    
    // Check if the property is configurable
    const descriptor = Object.getOwnPropertyDescriptor(window, 'Notification');
    if (descriptor && !descriptor.configurable) {
      // If it's non-configurable and not ours, we can't change it
      // This shouldn't happen if our initial override worked, but handle it gracefully
      console.warn('[Notification Override] Cannot override - property is non-configurable');
      return;
    }
    
    try {
      // If property exists and is configurable, delete it first to avoid conflicts
      if (descriptor && descriptor.configurable) {
        delete (window as any).Notification;
      }
      
      Object.defineProperty(window, 'Notification', {
        value: ElectronNotification,
        writable: false,
        configurable: false,
        enumerable: true,
      });
    } catch (e) {
      // If defineProperty fails completely, log the error but don't try direct assignment
      // Direct assignment of class constructors can cause prototype errors
      console.warn('[Notification Override] Failed to re-override:', e);
    }
  }

  // Check periodically to ensure override stays in place (every 2 seconds)
  overrideCheckInterval = window.setInterval(ensureOverride, 2000);

  // Also override when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      ensureOverride();
    });
  } else {
    ensureOverride();
  }

  // Monitor page title for unread count
  function monitorUnreadCount() {
    let lastTitle = document.title;
    let unreadCount = 0;

    // Parse unread count from title (e.g., "(5) Messenger")
    function parseUnreadCount(title: string): number {
      const match = title.match(/^\((\d+)\)/);
      return match ? parseInt(match[1], 10) : 0;
    }

    // Check initial title
    unreadCount = parseUnreadCount(lastTitle);
    if ((window as any).electronAPI && unreadCount > 0) {
      (window as any).electronAPI.updateUnreadCount(unreadCount);
    }

    // Monitor title changes
    const titleObserver = new MutationObserver(() => {
      if (document.title !== lastTitle) {
        lastTitle = document.title;
        const newCount = parseUnreadCount(lastTitle);
        if (newCount !== unreadCount) {
          unreadCount = newCount;
          if ((window as any).electronAPI) {
            (window as any).electronAPI.updateUnreadCount(unreadCount);
          }
        }
      }
    });

    // Observe title element
    titleObserver.observe(document.querySelector('title') || document.head, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    // Also monitor for unread indicators in the DOM
    // This is a fallback if title doesn't change
    const domObserver = new MutationObserver(() => {
      // Look for common unread indicators
      const unreadSelectors = [
        '[aria-label*="unread"]',
        '[data-testid*="unread"]',
        '.unread',
        '[class*="Unread"]',
      ];

      let foundCount = 0;
      unreadSelectors.forEach((selector) => {
        try {
          const elements = document.querySelectorAll(selector);
          // Try to extract count from elements
          elements.forEach((el: Element) => {
            const text = el.textContent || '';
            const match = text.match(/(\d+)/);
            if (match) {
              foundCount = Math.max(foundCount, parseInt(match[1], 10));
            }
          });
        } catch (e) {
          // Ignore selector errors
        }
      });

      // Use DOM count if it's different from title count
      if (foundCount > 0 && foundCount !== unreadCount) {
        unreadCount = foundCount;
        if ((window as any).electronAPI) {
          (window as any).electronAPI.updateUnreadCount(unreadCount);
        }
      }
    });

    // Observe body for changes
    domObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['aria-label', 'data-testid', 'class'],
    });
  }

  // Wait for DOM to be ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', monitorUnreadCount);
  } else {
    monitorUnreadCount();
  }
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
      updateUnreadCount: (count: number) => void;
      clearBadge: () => void;
      onNotificationAction: (callback: (action: string, data: any) => void) => void;
      testNotification: () => void;
    };
  }
}

