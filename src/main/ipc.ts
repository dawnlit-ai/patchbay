import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { type InboxFolderOption, IPC } from '@shared/ipc';
import type { Flow } from '@shared/flow';
import type { EmailEnvelope, Run } from '@shared/trace';
import type { AboutInfo, Settings } from '@shared/settings';
import * as flowStore from './store/flowStore';
import * as skillStore from './store/skillStore';
import * as traceStore from './store/traceStore';
import { getSettings, saveSettings } from './store/settingsStore';
import * as outlook from './outlook/bridge';
import { Watcher } from './engine/watcher';
import { runsDir } from './paths';

let watcher: Watcher | null = null;

function broadcast(channel: string, payload: unknown): void {
    for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send(channel, payload);
    }
}

export function getWatcher(): Watcher {
    watcher ??= new Watcher(
        (run: Run) => broadcast(IPC.evtRunUpdated, run),
        () => broadcast(IPC.evtEngineStatus, watcher?.status()),
    );
    return watcher;
}

/**
 * Wraps a handler so a thrown error crosses the IPC boundary as a readable
 * message rather than Electron's internal invoke stack trace.
 */
function handle<T extends unknown[], R>(
    channel: string,
    fn: (...args: T) => R | Promise<R>,
): void {
    ipcMain.handle(channel, async (_event, ...args) => {
        try {
            return await fn(...(args as T));
        } catch (e) {
            throw new Error(e instanceof Error ? e.message : String(e));
        }
    });
}

/** One canonical destination, so no renderer input reaches shell.openExternal. */
const DEVELOPER_URL = 'https://github.com/dawnlit-ai';

/** How far back the "Test run…" picker looks for a message to choose from. */
const RECENT_LOOKBACK_DAYS = 7;

export function registerIpc(): void {
    handle(
        IPC.about,
        (): AboutInfo => ({
            name: 'Patchbay',
            version: app.getVersion(),
            developer: 'Dawnlit',
            developerUrl: DEVELOPER_URL,
            license: 'AGPL-3.0-or-later',
        }),
    );
    handle(IPC.openDeveloperSite, () => shell.openExternal(DEVELOPER_URL));

    handle(IPC.flowsList, () => flowStore.listFlows());
    handle(IPC.flowsGet, (id: string) => flowStore.getFlow(id));
    handle(IPC.flowsSave, (flow: Flow) => flowStore.saveFlow(flow));
    handle(IPC.flowsCreate, (name: string) => flowStore.createFlow(name));
    handle(IPC.flowsRemove, (id: string) => flowStore.removeFlow(id));

    handle(IPC.settingsGet, () => getSettings());
    handle(IPC.settingsSave, (settings: Settings) => saveSettings(settings));

    handle(IPC.outlookAccounts, () => outlook.getAccounts());
    handle(IPC.outlookFolders, (account: string): Promise<InboxFolderOption[]> =>
        outlook.listFolders(account),
    );
    handle(IPC.outlookRecent, (account: string, folder: string, limit: number) =>
        outlook.readInbox(account, folder, RECENT_LOOKBACK_DAYS, limit),
    );

    handle(IPC.skillsList, () => skillStore.listSkills());
    handle(IPC.skillsGet, (name: string) => skillStore.getSkill(name));
    handle(IPC.skillsSave, (name: string, content: string) => skillStore.saveSkill(name, content));
    handle(IPC.skillsRemove, (name: string) => skillStore.removeSkill(name));
    handle(IPC.skillsImportFrom, (dir: string) => skillStore.importSkillsFrom(dir));
    handle(IPC.skillsPickAndImport, async () => {
        const picked = await dialog.showOpenDialog({
            title: 'Choose a folder containing skill directories',
            properties: ['openDirectory'],
        });
        const dir = picked.filePaths[0];
        if (picked.canceled || !dir) return null;
        return { dir, imported: skillStore.importSkillsFrom(dir) };
    });

    handle(IPC.engineStart, () => getWatcher().start());
    handle(IPC.engineStop, () => getWatcher().stop());
    handle(IPC.engineStatus, () => getWatcher().status());
    handle(IPC.engineTestRun, (flowId: string, email: EmailEnvelope) => {
        getWatcher().enqueueManual(flowId, email);
        return 'queued';
    });
    handle(IPC.engineCancel, (runId: string) => getWatcher().cancel(runId));

    handle(IPC.runsList, (limit: number) => traceStore.listRuns(limit));
    handle(IPC.runsGet, (id: string) => traceStore.getRun(id));
    handle(IPC.runsClear, () => traceStore.clearRuns());
    handle(IPC.runsReveal, () => shell.openPath(runsDir()));
}
