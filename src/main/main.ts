import { app, Menu } from 'electron';
import { getAgentControl, getWatcher, registerIpc } from './ipc';
import { adoptFolderNames, migrateToFlowDirectories } from './store/flowStore';
import { seedGlobalLibrary } from './store/skillStore';
import { anyWindowOpen, showWelcome } from './windows';
import { workspaceRoot } from './paths';
import { log } from './log';

void app.whenReady().then(() => {
    // Nothing in the default File/Edit/View/Window menu belongs to this app, so it
    // goes on every platform: off the window on Windows and Linux, out of the system
    // bar on macOS.
    Menu.setApplicationMenu(null);
    log.info('app', `Patchbay ${app.getVersion()} started`, { detail: `workspace: ${workspaceRoot()}` });
    // Flows used to be loose files sharing one library; a workspace written before
    // that changed is rearranged here, once, before anything reads it.
    const migrated = migrateToFlowDirectories();
    if (migrated.length > 0) log.info('app', `Gave ${migrated.length} flow(s) a directory of their own`);
    // And those directories used to be named by the flow's id, which is a UUID and
    // no kind of answer to "where is this flow kept?".
    const renamed = adoptFolderNames();
    if (renamed.length > 0) log.info('app', `Named ${renamed.length} flow folder(s) after their flow`, {
        detail: renamed.join(', '),
    });
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
    // Watching is a foreground activity here: no window, no poller. The same goes
    // for the agent-control server — an app with nothing on screen is not one an
    // agent should still be able to drive.
    getWatcher().stop();
    getAgentControl().stop();
    if (process.platform !== 'darwin') app.quit();
});
