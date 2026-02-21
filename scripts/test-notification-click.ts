const Module = require('module');

const TARGET_PATH = '/messages/t/123456';

const assert = (condition: boolean, message: string) => {
  if (!condition) {
    throw new Error(message);
  }
};

const createMockElectron = () => {
  const notificationHandlers: { click?: () => void; action?: () => void; close?: () => void } = {};

  class MockNotification {
    static isSupported() {
      return true;
    }

    constructor(_options: any) {
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
    nativeImage: {
      createFromDataURL: (_data: string) => ({}) as any,
      createFromPath: (_path: string) => ({}) as any,
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
  });

  assert(executedOn.includes('content'), 'Expected navigation to run in content webContents');
  assert(!executedOn.includes('main'), 'Did not expect navigation to run in main webContents');
  console.log('PASS Notification click handler targets content webContents on macOS');
};

try {
  runTest();
} catch (error) {
  console.error('FAIL Notification click test failed:', error);
  process.exit(1);
}
