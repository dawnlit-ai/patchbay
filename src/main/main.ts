import { app, Menu } from 'electron';
import { VelopackApp } from 'velopack';
import { getAgentControl, getTray, getUpdates, getWatcher, registerIpc } from './ipc';
import { showAll, showWelcome } from './windows';
import { currentWorkspace, dataRoot } from './paths';
import { log } from './log';
import { offerApplicationsFolder } from './updates';

// Before anything else: Velopack starts the app with its own arguments around an
// install or update, and expects it to do its part and exit.
VelopackApp.build().run();

// One Patchbay at a time: two would watch the same mailboxes, and draft and send
// from the same email twice. Opened again — easily done while it sits in the
// tray — it brings the running one's windows back instead, and this one goes.
if (app.requestSingleInstanceLock()) {
    start();
} else {
    console.info('Patchbay is already running, so its windows were brought back instead.');
    app.quit();
}

function start(): void {
    app.on('second-instance', () => void app.whenReady().then(() => showAll()));

    void app.whenReady().then(() => {
        // Nothing in the default menu applies to this app.
        Menu.setApplicationMenu(null);
        log.info('app', `Patchbay ${app.getVersion()} started`, {
            detail: `data: ${dataRoot()}\nworkspace: ${currentWorkspace() ?? '(none open)'}`,
        });
        registerIpc();
        // Listens only if the settings say so; a settings edit is what turns it on.
        getAgentControl().apply();
        // Before the first window, so one minimised has somewhere to go.
        getTray().apply();
        // The start page, every launch: a canvas needs a flow chosen first, and a workspace before that.
        showWelcome();
        getUpdates().start();
        void offerApplicationsFolder();

        app.on('activate', (_event, hasVisibleWindows) => {
            if (hasVisibleWindows) return;
            // The Dock's icon, as the tray's: what was hidden comes back, or the start page with nothing open.
            showAll();
            // With no tray icon, the control server stopped with the last window; a window is back, so restart it.
            getAgentControl().apply();
        });
    });

    app.on('window-all-closed', () => {
        // The tray icon keeps Patchbay running, watching and finishing its runs, until its menu quits it.
        if (getTray().holdOpen()) return;
        // No window, no poller and no agent server.
        getWatcher().stopAll();
        getAgentControl().stop();
        if (process.platform !== 'darwin') app.quit();
    });
}
