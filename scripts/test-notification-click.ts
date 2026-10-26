const Module = require('module');

const TARGET_PATH = '/messages/t/123456';

const assert = (condition: boolean, message: string) => {
  if (!condition) {
    throw new Error(message);
  }
};

const createMockElectron = () => {
  const notificationHandlers: { click?: () => void; action?: () => void; close?: () => void } = {};
  const createdNotifications: MockNotification[] = [];

  class MockNotification {
    options: any;

    static isSupported() {
      return true;
    }

    constructor(options: any) {
      this.options = options;
      createdNotifications.push(this);
      return this;
    }

    on(event: string, handler: () => void) {
      if (event === 'click') notificationHandlers.click = handler;
      if (event === 'action') notificationHandlers.action = handler;
      if (event === 'close') notificationHandlers.close = handler;
      return this;
    }

    emit(event: string) {
      if (event === 'click' && notificationHandlers.click) notificationHandlers.click();
      if (event === 'action' && notificationHandlers.action) notificationHandlers.action();
      if (event === 'close' && notificationHandlers.close) notificationHandlers.close();
      return true;
    }

    show() {
      if (notificationHandlers.action) {
        notificationHandlers.action();
        return;
      }
      if (notificationHandlers.click) notificationHandlers.click();
    }

    close() {
      if (notificationHandlers.close) notificationHandlers.close();
    }
  }

  class MockBrowserWindow {
    private views: any[];
    public webContents: any;
    private shown = false;
    private focused = false;

    constructor(views: any[], webContents: any) {
      this.views = views;
      this.webContents = webContents;
    }

    show() {
      this.shown = true;
    }

    focus() {
      this.focused = true;
    }

    getBrowserViews() {
      return this.views;
    }

    static getAllWindows() {
      return [] as any[];
    }
  }

  return {
    Notification: MockNotification,
    BrowserWindow: MockBrowserWindow,
    createdNotifications,
    nativeImage: {
      createFromDataURL: (data: string) => ({ source: 'renderer', data }) as any,
      createFromPath: (path: string) => ({ source: 'default', path }) as any,
    },
  };
};

const installElectronMock = (mockElectron: any) => {
  const originalLoad = Module._load;
  Module._load = function (request: string, parent: any, isMain: boolean) {
    if (request === 'electron') {
      return mockElectron;
    }
    return originalLoad.call(this, request, parent, isMain);
  };
};

const runTest = () => {
  const mockElectron = createMockElectron();
  installElectronMock(mockElectron);

  const { NotificationHandler } = require('../src/main/notification-handler');

  const executedOn: string[] = [];
  const contentWebContents = {
    getURL: () => 'https://www.facebook.com/messages/t/123456',
    executeJavaScript: (script: string) => {
      executedOn.push('content');
      assert(script.includes(TARGET_PATH), 'Expected navigation script to include target path');
      return Promise.resolve('clicked-link');
    },
  };

  const overlayWebContents = {
    getURL: () => 'file:///overlay.html',
    executeJavaScript: (_script: string) => {
      executedOn.push('overlay');
      return Promise.resolve('clicked-link');
    },
  };

  const mainWebContents = {
    executeJavaScript: (_script: string) => {
      executedOn.push('main');
      return Promise.resolve('clicked-link');
    },
  };

  const contentView = { webContents: contentWebContents };
  const overlayView = { webContents: overlayWebContents };
  const mainWindow = new mockElectron.BrowserWindow([contentView, overlayView], mainWebContents);

  const handler = new NotificationHandler(() => mainWindow, 'Messenger-Test');

  handler.showNotification({
    title: 'Test Notification',
    body: 'Navigate to chat',
    href: TARGET_PATH,
    sourceKind: 'messenger-message',
    sourceLabel: 'notification-click-test',
    provenanceReason: 'test-thread-proof',
  });

  assert(executedOn.includes('content'), 'Expected navigation to run in content webContents');
  assert(!executedOn.includes('main'), 'Did not expect navigation to run in main webContents');

  const defaultIconPath = '/tmp/messenger-app-icon.png';
  const avatarIcon = 'data:image/png;base64,avatar';
  const iconHandler = new NotificationHandler(
    () => null,
    'Messenger-Test',
    undefined,
    undefined,
    () => defaultIconPath,
  );

  iconHandler.showNotification({
    title: 'Account A',
    body: 'New message',
    icon: avatarIcon,
    href: TARGET_PATH,
    sourceKind: 'messenger-message',
    sourceLabel: 'notification-icon-test',
    provenanceReason: 'test-thread-proof',
  });
  const messengerIcon = mockElectron.createdNotifications.at(-1)?.options.icon;
  assert(
    messengerIcon?.source === 'renderer' && messengerIcon?.data === avatarIcon,
    'Expected Messenger message notifications to prefer the renderer-provided contact icon',
  );

  iconHandler.showNotification({
    title: 'Messenger-Test',
    body: 'Download complete',
    icon: avatarIcon,
    sourceKind: 'app-owned',
    sourceLabel: 'notification-icon-test-app-owned',
    provenanceReason: 'test-app-owned',
  });
  const appOwnedIcon = mockElectron.createdNotifications.at(-1)?.options.icon;
  assert(
    appOwnedIcon?.source === 'default' && appOwnedIcon?.path === defaultIconPath,
    'Expected app-owned notifications to keep preferring the resolved app icon',
  );

  iconHandler.showNotification({
    title: 'Account B',
    body: 'New message',
    href: TARGET_PATH,
    sourceKind: 'messenger-message',
    sourceLabel: 'notification-icon-test-fallback',
    provenanceReason: 'test-thread-proof',
  });
  const fallbackIcon = mockElectron.createdNotifications.at(-1)?.options.icon;
  assert(
    fallbackIcon?.source === 'default' && fallbackIcon?.path === defaultIconPath,
    'Expected Messenger message notifications without a contact icon to fall back to the resolved app icon',
  );

  // Electron 42 on macOS emits `failed` (not `error`) when the OS refuses a
  // notification, e.g. for unsigned builds. It must not throw, must drop the
  // active record, and must leave later notifications working.
  const { EventEmitter } = require('events');
  class FailingNotification extends EventEmitter {
    options: any;
    shown = 0;
    constructor(options: any) {
      super();
      this.options = options;
    }
    show() {
      this.shown += 1;
      this.emit('failed', {}, 'Notifications are not allowed for this application');
    }
    close() {
      this.emit('close');
    }
  }
  const failingNotifications: FailingNotification[] = [];
  const failingHandler = new NotificationHandler(
    () => null,
    'Messenger-Test',
    (options: any) => {
      const notification = new FailingNotification(options);
      failingNotifications.push(notification);
      return notification as any;
    },
  );
  const originalWarn = console.warn;
  const warnings: unknown[][] = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  let firstShown: boolean;
  let secondShown: boolean;
  try {
    firstShown = failingHandler.showNotification({
      title: 'Account A',
      body: 'New message',
      tag: 'failed-1',
      href: TARGET_PATH,
      sourceKind: 'messenger-message',
      sourceLabel: 'notification-failed-test',
      provenanceReason: 'test-thread-proof',
    });
    secondShown = failingHandler.showNotification({
      title: 'Account B',
      body: 'Another message',
      tag: 'failed-2',
      href: TARGET_PATH,
      sourceKind: 'messenger-message',
      sourceLabel: 'notification-failed-test',
      provenanceReason: 'test-thread-proof',
    });
  } finally {
    console.warn = originalWarn;
  }
  assert(
    firstShown && secondShown && failingNotifications.length === 2,
    'Expected each notification to be attempted even after an earlier one failed',
  );
  assert(
    failingNotifications.every((notification) => notification.shown === 1),
    'Expected each failing notification to be shown exactly once',
  );
  assert(
    (failingHandler as any).activeNotifications.size === 0,
    'Expected failed notifications to be removed from the active set',
  );
  assert(
    warnings.filter((args) => args[0] === '[NotificationHandler] Notification failed').length === 2,
    'Expected each failed notification to be logged',
  );
  const cleanup = failingHandler.closeActiveNotifications('test-after-failed', {
    includeIncomingCalls: true,
  });
  assert(cleanup.closedCount === 0, 'Expected no stale records to close after failures');

  console.log('PASS Notification click handler targets content webContents on macOS');
  console.log('PASS Failed native notifications are logged and dropped without breaking later ones');
};

try {
  runTest();
} catch (error) {
  console.error('FAIL Notification click test failed:', error);
  process.exit(1);
}
