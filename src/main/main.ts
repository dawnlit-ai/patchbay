import { app, BrowserWindow } from 'electron';
import { join } from 'node:path';
import { registerIpc, getWatcher } from './ipc';
import { ensureStarterSkill } from './store/skillStore';
import { workspaceRoot } from './paths';

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1560,
    height: 980,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#0b1020',
    title: 'Email Flow Studio',
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    void win.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    void win.loadFile(join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
  }
}

void app.whenReady().then(() => {
  workspaceRoot();
  ensureStarterSkill();
  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // Watching a mailbox is a foreground activity here: closing the window stops
  // the poller rather than leaving runs firing with nothing to show them in.
  getWatcher().stop();
  if (process.platform !== 'darwin') app.quit();
});
