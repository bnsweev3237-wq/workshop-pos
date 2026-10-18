const path = require('path');
const { app, BrowserWindow, Menu } = require('electron');

// Must be set before the server module (and anything it requires) loads, since the database
// and session-secret files are opened at require time, keyed off this env var.
process.env.WORKSHOP_DATA_DIR = path.join(app.getPath('userData'), 'data');

const { startServer } = require('../server');

const PREFERRED_PORT = 4100;
let mainWindow = null;
let serverPort = null;

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { role: 'editMenu' }, // keeps Cut/Copy/Paste/Undo working with their normal shortcuts
    { role: 'viewMenu' }, // Reload + zoom + dev tools, handy if something needs troubleshooting
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 860,
    minWidth: 820,
    minHeight: 600,
    backgroundColor: '#f4f1ec',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.loadURL(`http://localhost:${serverPort}`);
  mainWindow.on('closed', () => { mainWindow = null; });
}

async function boot() {
  try {
    ({ port: serverPort } = await startServer(PREFERRED_PORT));
  } catch (err) {
    // Preferred port taken (e.g. a previous instance didn't exit cleanly) — fall back to
    // whatever free port the OS hands us rather than refusing to start.
    ({ port: serverPort } = await startServer(0));
  }
  buildMenu();
  createWindow();
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
  app.whenReady().then(boot);
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
}
