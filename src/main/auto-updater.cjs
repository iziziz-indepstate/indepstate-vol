const { autoUpdater } = require('electron-updater');

function startAutoUpdater() {
  try {
    autoUpdater.autoDownload = true;
    autoUpdater.allowPrerelease = false;
  } catch (err) {
    console.error('[auto-updater] setup failed', err);
  }

  autoUpdater.on('error', (err) => {
    console.error('[auto-updater]', err);
  });

  autoUpdater.on('update-downloaded', () => {
    try {
      autoUpdater.quitAndInstall();
    } catch (err) {
      console.error('[auto-updater] install failed', err);
    }
  });

  try {
    autoUpdater.checkForUpdatesAndNotify();
  } catch (err) {
    console.error('[auto-updater] check failed', err);
  }

  return autoUpdater;
}

module.exports = { startAutoUpdater };
