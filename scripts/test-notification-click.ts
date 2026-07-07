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

  console.log('PASS Notification click handler targets content webContents on macOS');
};

try {
  runTest();
} catch (error) {
  console.error('FAIL Notification click test failed:', error);
  process.exit(1);
}
