import { app, Menu } from 'electron';
import { VelopackApp } from 'velopack';
import { getAgentControl, getUpdates, getWatcher, registerIpc } from './ipc';
import { anyWindowOpen, showWelcome } from './windows';
import { currentWorkspace, dataRoot } from './paths';
import { adoptOpenWorkspaceSchemas } from './store/workspaceStore';
import { log } from './log';
import { offerApplicationsFolder } from './updates';

// Before anything else: Velopack starts the app with its own arguments around an
// install or update, and expects it to do its part and exit.
VelopackApp.build().run();

void app.whenReady().then(() => {
    // Nothing in the default menu applies to this app.
    Menu.setApplicationMenu(null);
    log.info('app', `Patchbay ${app.getVersion()} started`, {
        detail: `data: ${dataRoot()}\nworkspace: ${currentWorkspace() ?? '(none open)'}`,
    });
    if (currentWorkspace()) adoptOpenWorkspaceSchemas();
    registerIpc();
    // Listens only if the settings say so; a settings edit is what turns it on.
    getAgentControl().apply();
    // The start page, every launch: a canvas needs a flow chosen first, and a workspace before that.
    showWelcome();
    getUpdates().start();
    void offerApplicationsFolder();

    app.on('activate', () => {
        if (anyWindowOpen()) return;
        showWelcome();
        // The control server stopped with the last window; a window is back, so restart it.
        getAgentControl().apply();
    });
});

app.on('window-all-closed', () => {
    // No window, no poller and no agent server.
    getWatcher().stopAll();
    getAgentControl().stop();
    if (process.platform !== 'darwin') app.quit();
});
