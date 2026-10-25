// Desktop shell: one window showing docs/index.html (the same app the phone uses).
const { app, BrowserWindow, shell } = require('electron');
const path = require('path');

if (!app.requestSingleInstanceLock()) app.quit();

let win;
function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 820,
    minWidth: 380,
    minHeight: 500,
    title: 'המחברות שלי',
    icon: path.join(__dirname, '..', 'docs', 'icons', 'icon-512.png'),
    backgroundColor: '#e6ebf1',
    autoHideMenuBar: true,
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true }
  });
  win.setMenu(null);
  win.loadFile(path.join(__dirname, '..', 'docs', 'index.html'));
  win.once('ready-to-show', () => win.show());
  win.on('page-title-updated', e => e.preventDefault());
  // any web link opens in the normal browser, not inside the app
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
}

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
