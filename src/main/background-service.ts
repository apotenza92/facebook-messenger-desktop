import { BrowserWindow } from 'electron';
import { MESSAGES_HOME_URL } from './url-policy';

export class BackgroundService {
  private hiddenWindow: BrowserWindow | null = null;

  /**
   * Creates a hidden window that can run in the background
   * to maintain WebSocket connections and receive notifications
   */
  createHiddenWindow(): void {
    if (this.hiddenWindow) {
      return;
    }

    this.hiddenWindow = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: require('path').join(__dirname, '../preload/preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    this.hiddenWindow.loadURL(MESSAGES_HOME_URL);

    this.hiddenWindow.on('closed', () => {
      this.hiddenWindow = null;
    });
  }

  /**
   * Closes the hidden window
   */
  closeHiddenWindow(): void {
    if (this.hiddenWindow) {
      this.hiddenWindow.close();
      this.hiddenWindow = null;
    }
  }

  /**
   * Checks if the background service is active
   */
  isActive(): boolean {
    return this.hiddenWindow !== null;
  }
}
