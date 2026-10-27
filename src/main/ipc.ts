import { app, BrowserWindow, clipboard, dialog, ipcMain, shell, type WebContents } from 'electron';
import { execFile } from 'node:child_process';
import {
    type InboxFolderOption,
    IPC,
    type OpenWhere,
    type OutlookDrag,
    type WorkspaceChange,
    type WorkspaceInfo,
} from '@shared/ipc';
import { type Flow, type MailScope, triggerConfig } from '@shared/flow';
import type { EmailEnvelope, Run } from '@shared/trace';
import type { AboutInfo, Settings } from '@shared/settings';
import * as flowStore from './store/flowStore';
import * as skillStore from './store/skillStore';
import * as workspaceStore from './store/workspaceStore';
import { rewatch, watchSkills } from './store/skillWatch';
import * as traceStore from './store/traceStore';
import { getSettings, saveSettings } from './store/settingsStore';
import * as outlook from './outlook/bridge';
import { agents } from './agentHost';
import { listServerTools } from './tools/serverTools';
import { Watcher } from './engine/watcher';
import { AgentControl } from './mcp/server';
import { dataRoot, logsDir, runsDir, workspaceRoot } from './paths';
import { closeCanvases, openFlow, openFlows, showSettings, showWelcome } from './windows';
import { clearLog, logEntries, onLogged } from './log';
import { Updates } from './updates';

let watcher: Watcher | null = null;

function broadcast(channel: string, payload: unknown, except?: WebContents): void {
    for (const win of BrowserWindow.getAllWindows()) {
        if (win.isDestroyed() || win.webContents === except) continue;
        win.webContents.send(channel, payload);
    }
}

export function getWatcher(): Watcher {
    watcher ??= new Watcher(
        (run: Run) => broadcast(IPC.evtRunUpdated, run),
        () => broadcast(IPC.evtEngineStatus, watcher?.status()),
    );
    return watcher;
}

let agentControl: AgentControl | null = null;

/** The app's own MCP server, on the same watcher and stores as the window; its writes are broadcast. */
export function getAgentControl(): AgentControl {
    agentControl ??= new AgentControl(
        {
            watcher: () => getWatcher(),
            changed: (change) => broadcast(IPC.evtWorkspaceChanged, change),
            modelsOffered: () => agents.listModels(),
        },
        () => broadcast(IPC.evtAgentControl, agentControl?.status()),
    );
    return agentControl;
}

let updates: Updates | null = null;

/** The updater, which holds off a restart while the watcher has runs in hand. */
export function getUpdates(): Updates {
    updates ??= new Updates(
        {
            busy: () => {
                const status = getWatcher().status();
                return status.activeRunIds.length > 0 || status.queuedRunIds.length > 0;
            },
        },
        () => broadcast(IPC.evtUpdateStatus, updates?.status()),
    );
    return updates;
}

/**
 * Wraps a handler so a thrown error crosses the IPC boundary as a readable
 * message rather than Electron's internal invoke stack trace.
 */
function readable<T extends unknown[], R>(fn: (...args: T) => R | Promise<R>) {
    return async (...args: T): Promise<R> => {
        try {
            return await fn(...args);
        } catch (e) {
            throw new Error(e instanceof Error ? e.message : String(e));
        }
    };
}

function handle<T extends unknown[], R>(channel: string, fn: (...args: T) => R | Promise<R>): void {
    const run = readable(fn);
    ipcMain.handle(channel, (_event, ...args) => run(...(args as T)));
}

/** A write other windows have to see: each of them is told to re-read what it changed. */
function handleWrite<T extends unknown[], R>(
    change: WorkspaceChange,
    channel: string,
    fn: (...args: T) => R | Promise<R>,
): void {
    const run = readable(fn);
    ipcMain.handle(channel, async (event, ...args) => {
        const result = await run(...(args as T));
        broadcast(IPC.evtWorkspaceChanged, change, event.sender);
        return result;
    });
}

/** A write that changes which flows exist or where one lives. */
function handleFlowWrite<T extends unknown[], R>(channel: string, fn: (...args: T) => R | Promise<R>): void {
    handleWrite({flows: true, skills: false}, channel, fn);
}

/**
 * Make another folder the open workspace. Refused while a run is under way or
 * waiting: it works in the workspace's folder, with its skills. Otherwise every
 * flow stops being watched and every canvas closes, since they are the old
 * workspace's. Opening the one already open changes nothing.
 */
function switchWorkspace(path: string | null, open: () => WorkspaceInfo): WorkspaceInfo {
    if (path !== null && workspaceStore.isCurrentWorkspace(path)) return open();
    const watcher = getWatcher();
    const {activeRunIds, queuedRunIds} = watcher.status();
    if (activeRunIds.length > 0 || queuedRunIds.length > 0) {
        throw new Error(
            'Runs of this workspace’s flows are under way or waiting. Let them finish, or cancel them, before opening another workspace.',
        );
    }
    // First, so a folder that has gone leaves everything as it was.
    const opened = open();
    watcher.stopAll();
    closeCanvases();
    rewatch();
    broadcast(IPC.evtWorkspaceChanged, {flows: true, skills: true});
    return opened;
}

/**
 * A canvas save, refused if something else wrote the flow since the edit was
 * made. Tracked per sending window, so a window's own earlier saves don't count.
 */
function handleCanvasSave(): void {
    const known = new Set<number>();
    const save = readable((writer: string, flow: Flow) => flowStore.saveFlowFrom(writer, flow));
    ipcMain.handle(IPC.flowsSave, (event, flow: Flow) => {
        const {id} = event.sender;
        if (!known.has(id)) {
            known.add(id);
            event.sender.once('destroyed', () => {
                known.delete(id);
                flowStore.forgetWriter(String(id));
            });
        }
        return save(String(id), flow);
    });
}

/**
 * Acts on the window the call came from rather than whichever one holds focus, so
 * a title-bar button always moves the bar that was clicked.
 */
function handleWindow(channel: string, fn: (win: BrowserWindow) => void): void {
    ipcMain.handle(channel, (event) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (win && !win.isDestroyed()) fn(win);
    });
}

/**
 * Open a file in the app the system gives files of its kind. With none set,
 * Windows asks which (Chromium's own fallback) and macOS takes its text editor.
 */
async function openInEditor(file: string): Promise<void> {
    const failure = await shell.openPath(file);
    if (!failure) return;
    if (process.platform === 'darwin') {
        const opened = await new Promise<boolean>((resolve) => execFile('open', ['-t', file], (e) => resolve(!e)));
        if (opened) return;
    }
    throw new Error(`Could not open ${file}: ${failure}`);
}

/** One canonical destination, so no renderer input reaches shell.openExternal. */
const DEVELOPER_URL = 'https://github.com/dawnlit-ai';

function requireFlow(id: string): Flow {
    const flow = flowStore.getFlow(id);
    if (!flow) throw new Error('That flow is no longer in the workspace.');
    return flow;
}

const FLOW_FILTERS = [
    {name: 'Patchbay flow', extensions: ['json']},
    {name: 'All files', extensions: ['*']},
];

export function registerIpc(): void {
    handle(
        IPC.about,
        (): AboutInfo => ({
            name: 'Patchbay',
            version: app.getVersion(),
            developer: 'Dawnlit',
            license: 'AGPL-3.0-or-later',
            dataDir: dataRoot(),
        }),
    );
    handle(IPC.openDeveloperSite, () => shell.openExternal(DEVELOPER_URL));
    handle(IPC.copyText, (text: string) => clipboard.writeText(text));

    handle(IPC.workspaceCurrent, () => workspaceStore.currentWorkspaceInfo());
    handle(IPC.workspaceRecent, () => workspaceStore.recentWorkspaces());
    handle(IPC.workspaceOpen, (path: string) => switchWorkspace(path, () => workspaceStore.openWorkspace(path)));
    handle(IPC.workspacePickAndOpen, async () => {
        const picked = await dialog.showOpenDialog({
            title: 'Open a folder as the workspace',
            defaultPath: workspaceStore.currentWorkspaceInfo()?.path ?? workspaceStore.workspaceLocation(),
            properties: ['openDirectory', 'createDirectory'],
        });
        const path = picked.filePaths[0];
        if (picked.canceled || !path) return null;
        return switchWorkspace(path, () => workspaceStore.openWorkspace(path));
    });
    handle(IPC.workspaceCreate, (name: string, location: string) =>
        switchWorkspace(null, () => workspaceStore.createWorkspace(name, location)),
    );
    handle(IPC.workspaceLocation, () => workspaceStore.workspaceLocation());
    handle(IPC.workspacePickLocation, async (current: string) => {
        const picked = await dialog.showOpenDialog({
            title: 'Choose where the workspace’s folder goes',
            defaultPath: current || workspaceStore.workspaceLocation(),
            properties: ['openDirectory', 'createDirectory', 'promptToCreate'],
        });
        return picked.canceled ? null : (picked.filePaths[0] ?? null);
    });
    handle(IPC.workspaceForget, (path: string) => workspaceStore.forgetWorkspace(path));
    handle(IPC.workspaceReveal, async () => {
        // openPath reports failure as a message rather than throwing: the folder may be gone.
        const failure = await shell.openPath(workspaceRoot());
        if (failure) throw new Error(failure);
    });

    handle(IPC.flowsEntries, () => (workspaceStore.currentWorkspaceInfo() ? flowStore.listFlowEntries() : []));
    handleCanvasSave();
    handleFlowWrite(IPC.flowsCreate, (name: string) => flowStore.createFlow(name));
    handleFlowWrite(IPC.flowsDuplicate, (source: Flow, name: string) => flowStore.duplicateFlow(source, name));
    handleFlowWrite(IPC.flowsRename, (id: string, name: string) => flowStore.renameFlow(id, name));
    handleFlowWrite(IPC.flowsRemove, (id: string) => {
        getWatcher().clearForRemoval(id);
        flowStore.removeFlow(id);
    });
    handleFlowWrite(IPC.flowsSetFileName, (id: string, fileName: string) => flowStore.setFlowFileName(id, fileName));
    handle(IPC.flowsReveal, (id: string) => shell.showItemInFolder(flowStore.entryFor(requireFlow(id)).file));
    handleFlowWrite(IPC.flowsPickAndImport, async () => {
        const picked = await dialog.showOpenDialog({
            title: 'Import a flow into this workspace',
            filters: FLOW_FILTERS,
            properties: ['openFile'],
        });
        const path = picked.filePaths[0];
        if (picked.canceled || !path) return null;
        return flowStore.importFlowFile(path);
    });
    handle(IPC.settingsGet, () => getSettings());
    handle(IPC.settingsServerTools, (server: string) => listServerTools(server));
    handle(IPC.settingsSave, (settings: Settings) => {
        // Keep the stored token: a panel opened before a regeneration would send the old one back.
        const {agentControl, updateChannel} = getSettings();
        const saved = saveSettings({
            ...settings,
            agentControl: {...settings.agentControl, token: agentControl.token},
        });
        // Carries out a change to the agent-control server's switch or port.
        getAgentControl().apply();
        if (saved.updateChannel !== updateChannel) getUpdates().channelChanged();
        return saved;
    });

    handle(IPC.agentControlStatus, () => getAgentControl().status());
    handle(IPC.agentControlRegenerateToken, () => getAgentControl().regenerateToken());

    handle(IPC.updatesStatus, () => getUpdates().status());
    handle(IPC.updatesCheck, () => getUpdates().check());
    handle(IPC.updatesRestart, () => getUpdates().restart());

    handle(IPC.outlookAccounts, () => outlook.getAccounts());
    handle(IPC.outlookFolders, (account: string): Promise<InboxFolderOption[]> =>
        outlook.listFolders(account),
    );
    handle(IPC.outlookRecent, (scope: MailScope, days: number, limit: number) =>
        outlook.readScope(scope, days, limit),
    );
    handle(IPC.outlookDragged, (account: string, drag: OutlookDrag) => outlook.readDragged(account, drag));
    handle(IPC.outlookSelected, (account: string) => outlook.readSelected(account));

    // Each switched-on agent's, in the order Settings lists them; none from one not installed.
    handle(IPC.agentsModels, () => agents.listModels());
    handle(IPC.agentsStatus, (id: string) => agents.status(id));
    handle(IPC.agentsLastStatus, (id: string) => agents.lastStatus(id));

    // Skills are edited in other apps, so main watches their folders and every
    // window re-reads its list on a change, whoever made it.
    watchSkills(() => broadcast(IPC.evtWorkspaceChanged, {flows: false, skills: true}));
    handle(IPC.skillsList, () => {
        if (!workspaceStore.currentWorkspaceInfo()) return [];
        rewatch();
        return skillStore.listSkills();
    });
    handle(IPC.skillsCreate, (name: string, content: string) => {
        const created = skillStore.createSkill(name, content);
        // The library's folder may be new, and only a folder that is there can be watched.
        rewatch();
        return created;
    });
    handle(IPC.skillsOpen, (name: string) => openInEditor(skillStore.locateSkill(name)));
    handle(IPC.skillsReveal, (name: string) => shell.showItemInFolder(skillStore.locateSkill(name)));
    handle(IPC.skillsRemove, (name: string) => skillStore.removeSkill(name));
    handle(IPC.skillsPickAndImport, async () => {
        const picked = await dialog.showOpenDialog({
            title: 'Choose SKILL.md files to add to this workspace',
            filters: [{name: 'Skills', extensions: ['md']}],
            properties: ['openFile', 'multiSelections'],
        });
        if (picked.canceled || picked.filePaths.length === 0) return null;
        const result = skillStore.importSkillFiles(picked.filePaths);
        rewatch();
        return result;
    });

    handle(IPC.engineStart, (flowId: string) => getWatcher().start(flowId));
    handle(IPC.engineStop, (flowId: string) => getWatcher().stop(flowId));
    handle(IPC.engineStatus, () => getWatcher().status());
    handle(IPC.engineTestRun, (flowId: string, nodeId: string, email: EmailEnvelope) =>
        getWatcher().enqueueManual(flowId, nodeId, email),
    );
    handle(IPC.engineCancel, (runId: string) => getWatcher().cancel(runId));

    handleWindow(IPC.windowMinimize, (win) => win.minimize());
    handleWindow(IPC.windowToggleMaximize, (win) => {
        if (win.isMaximized()) win.unmaximize();
        else win.maximize();
    });
    handleWindow(IPC.windowClose, (win) => win.close());
    handle(IPC.windowOpenFlow, (flowId: string, where?: OpenWhere) => openFlow(flowId, where));
    handle(IPC.windowOpenFlows, () => openFlows());
    handle(IPC.windowShowWelcome, () => showWelcome());
    handle(IPC.windowShowSettings, () => showSettings());
    ipcMain.handle(
        IPC.windowIsMaximized,
        (event) => BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false,
    );

    handle(IPC.runsList, (limit: number) => (workspaceStore.currentWorkspaceInfo() ? traceStore.listRuns(limit) : []));
    handle(IPC.runsGet, (id: string) => traceStore.getRun(id));
    handle(IPC.runsClear, () => traceStore.clearRuns());
    handle(IPC.runsRemove, (id: string) => {
        if (getWatcher().isRunPending(id)) {
            throw new Error('That run is still in progress. Cancel it, or let it finish, before deleting it.');
        }
        traceStore.removeRun(id);
    });
    handle(IPC.runsRerun, async (id: string) => {
        const run = traceStore.getRun(id);
        if (!run) throw new Error('That run is no longer stored.');
        const flow = flowStore.getFlow(run.flowId);
        if (!flow) throw new Error(`“${run.flowName}”, the flow it ran in, has been deleted.`);
        const trigger = flow.nodes.find((n) => n.id === run.path[0]);
        if (!trigger || !triggerConfig(trigger)) {
            throw new Error(`The trigger it came in by is no longer in “${flow.name}”.`);
        }
        return getWatcher().enqueueManual(flow.id, trigger.id, await outlook.refind(run.email));
    });
    handle(IPC.runsReveal, () => shell.openPath(runsDir()));

    handle(IPC.logList, () => logEntries());
    handle(IPC.logClear, () => clearLog());
    handle(IPC.logReveal, () => shell.openPath(logsDir()));
    onLogged((entry) => broadcast(IPC.evtLogged, entry));
}
