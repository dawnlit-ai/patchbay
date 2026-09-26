import { app, Menu } from 'electron';
import { getAgentControl, getWatcher, registerIpc } from './ipc';
import { seedGlobalLibrary } from './store/skillStore';
import { anyWindowOpen, showWelcome } from './windows';
import { workspaceRoot } from './paths';
import { log } from './log';

void app.whenReady().then(() => {
    // Nothing in the default menu applies to this app.
    Menu.setApplicationMenu(null);
    log.info('app', `Patchbay ${app.getVersion()} started`, { detail: `workspace: ${workspaceRoot()}` });
    const seeded = seedGlobalLibrary();
    if (seeded.length > 0) log.info('app', `Seeded the global skill library: ${seeded.join(', ')}`);
    registerIpc();
    // Listens only if the workspace says so; a settings edit is what turns it on.
    getAgentControl().apply();
    // The start page, every launch: which flow you want is a question, and the
    // canvas cannot be drawn until it has an answer.
    showWelcome();

    app.on('activate', () => {
        if (anyWindowOpen()) return;
        showWelcome();
        // The control server stopped with the last window, on the grounds that an
        // app with nothing on screen is not one to drive; a window is back, so it is.
        getAgentControl().apply();
    });
});

app.on('window-all-closed', () => {
    // No window, no poller and no agent server.
    getWatcher().stopAll();
    getAgentControl().stop();
    if (process.platform !== 'darwin') app.quit();
});
