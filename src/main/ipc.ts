import { app, BrowserWindow, clipboard, dialog, ipcMain, shell, type WebContents } from 'electron';
import { type InboxFolderOption, IPC, type OpenWhere, type OutlookDrag, type WorkspaceChange } from '@shared/ipc';
import { type Flow, type MailScope, triggerConfig } from '@shared/flow';
import type { EmailEnvelope, Run } from '@shared/trace';
import type { AboutInfo, Settings, SkillScope } from '@shared/settings';
import * as flowStore from './store/flowStore';
import * as skillStore from './store/skillStore';
import * as traceStore from './store/traceStore';
import { getSettings, saveSettings } from './store/settingsStore';
import * as outlook from './outlook/bridge';
import { listModels } from './claude/runner';
import { Watcher } from './engine/watcher';
import { AgentControl } from './mcp/server';
import { logsDir, runsDir, workspaceRoot } from './paths';
import { openFlow, openFlows, showSettings, showWelcome } from './windows';
import { clearLog, logEntries, onLogged } from './log';

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
        },
        () => broadcast(IPC.evtAgentControl, agentControl?.status()),
    );
    return agentControl;
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
    handleWrite({ flows: true, skills: false }, channel, fn);
}

/**
 * A canvas save, refused if something else wrote the flow since the edit was
 * made. Tracked per sending window, so a window's own earlier saves don't count.
 */
function handleCanvasSave(): void {
    const known = new Set<number>();
    const save = readable((writer: string, flow: Flow) => flowStore.saveFlowFrom(writer, flow));
    ipcMain.handle(IPC.flowsSave, (event, flow: Flow) => {
        const { id } = event.sender;
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

/** One canonical destination, so no renderer input reaches shell.openExternal. */
const DEVELOPER_URL = 'https://github.com/dawnlit-ai';

const FLOW_FILTERS = [
    { name: 'Patchbay flow', extensions: ['json'] },
    { name: 'All files', extensions: ['*'] },
];

export function registerIpc(): void {
    handle(
        IPC.about,
        (): AboutInfo => ({
            name: 'Patchbay',
            version: app.getVersion(),
            developer: 'Dawnlit',
            license: 'AGPL-3.0-or-later',
            workspace: workspaceRoot(),
        }),
    );
    handle(IPC.openDeveloperSite, () => shell.openExternal(DEVELOPER_URL));
    handle(IPC.revealWorkspace, () => shell.openPath(workspaceRoot()));
    handle(IPC.copyText, (text: string) => clipboard.writeText(text));

    handle(IPC.flowsEntries, () => flowStore.listFlowEntries());
    handleCanvasSave();
    handleFlowWrite(IPC.flowsCreate, (name: string) => flowStore.createFlow(name));
    handleFlowWrite(IPC.flowsDuplicate, (flow: Flow, name: string) => flowStore.duplicateFlow(flow, name));
    handleFlowWrite(IPC.flowsRename, (id: string, name: string) => flowStore.renameFlow(id, name));
    handleFlowWrite(IPC.flowsRemove, (id: string) => {
        // The same reason a folder rename is refused mid-run: the directory going
        // is the one that run is working in.
        getWatcher().clearForRemoval(id);
        flowStore.removeFlow(id);
    });
    handleFlowWrite(IPC.flowsSetFolder, (id: string, folder: string) => {
        // The folder is the cwd of this flow's runs; moving it mid-run would pull
        // it out from under the agent.
        if (getWatcher().isFlowRunning(id)) {
            throw new Error(
                'A run of this flow is in progress. That folder is the directory it is running in, so it cannot be renamed until the run finishes.',
            );
        }
        return flowStore.setFlowFolder(id, folder);
    });
    handle(IPC.flowsReveal, (id: string) => shell.openPath(flowStore.flowLocation(id)));
    handleFlowWrite(IPC.flowsPickAndImport, async () => {
        const picked = await dialog.showOpenDialog({
            title: 'Open a flow',
            filters: FLOW_FILTERS,
            properties: ['openFile'],
        });
        const path = picked.filePaths[0];
        if (picked.canceled || !path) return null;
        return flowStore.importFlowFile(path);
    });
    handle(IPC.settingsGet, () => getSettings());
    handle(IPC.settingsSave, (settings: Settings) => {
        // Keep the stored token and skill folders: a panel opened before a regeneration
        // or a folder change would send the old ones back.
        const { globalSkillFolders, agentControl } = getSettings();
        const saved = saveSettings({
            ...settings,
            globalSkillFolders,
            agentControl: { ...settings.agentControl, token: agentControl.token },
        });
        // Switching the agent-control server on, off, or onto another port is an
        // ordinary settings edit; this is what carries it out.
        getAgentControl().apply();
        return saved;
    });

    handle(IPC.agentControlStatus, () => getAgentControl().status());
    handle(IPC.agentControlRegenerateToken, () => getAgentControl().regenerateToken());

    handle(IPC.outlookAccounts, () => outlook.getAccounts());
    handle(IPC.outlookFolders, (account: string): Promise<InboxFolderOption[]> =>
        outlook.listFolders(account),
    );
    handle(IPC.outlookRecent, (scope: MailScope, days: number, limit: number) =>
        outlook.readScope(scope, days, limit),
    );
    handle(IPC.outlookDragged, (account: string, drag: OutlookDrag) => outlook.readDragged(account, drag));
    handle(IPC.outlookSelected, (account: string) => outlook.readSelected(account));

    handle(IPC.claudeModels, () => listModels());

    handle(IPC.skillsList, (flowId: string) => skillStore.listAllSkills(flowId));
    handle(IPC.skillsGet, (scope: SkillScope, flowId: string, name: string) =>
        skillStore.getSkill(scope, flowId, name),
    );
    handle(IPC.skillsSave, (scope: SkillScope, flowId: string, name: string, content: string) =>
        skillStore.saveSkill(scope, flowId, name, content),
    );
    handle(IPC.skillsRemove, (scope: SkillScope, flowId: string, name: string) =>
        skillStore.removeSkill(scope, flowId, name),
    );
    handle(IPC.skillsMove, (from: SkillScope, to: SkillScope, flowId: string, name: string) =>
        skillStore.moveSkill(from, to, flowId, name),
    );
    handle(IPC.skillsPickAndImport, async (scope: SkillScope, flowId: string) => {
        const picked = await dialog.showOpenDialog({
            title:
                scope === 'global'
                    ? 'Choose SKILL.md files to add to every flow'
                    : 'Choose SKILL.md files to add to this flow',
            filters: [{ name: 'Skills', extensions: ['md'] }],
            properties: ['openFile', 'multiSelections'],
        });
        if (picked.canceled || picked.filePaths.length === 0) return null;
        return skillStore.importSkillFiles(scope, flowId, picked.filePaths);
    });
    handle(IPC.skillsFolders, () => skillStore.globalShelf());
    // Every flow's global skills change at once, so every window re-reads them.
    handleWrite({ flows: false, skills: true }, IPC.skillsSetFolders, (paths: string[]) =>
        skillStore.setGlobalFolders(paths),
    );
    handle(IPC.skillsPickFolder, async () => {
        const picked = await dialog.showOpenDialog({
            title: 'Choose a folder of skills to link for every flow to use in place',
            properties: ['openDirectory'],
        });
        return picked.canceled ? null : (picked.filePaths[0] ?? null);
    });
    handle(IPC.skillsRevealFolder, async (path: string) => {
        // openPath reports failure as a message rather than throwing: the folder may be gone.
        const failure = await shell.openPath(skillStore.globalFolderPath(path));
        if (failure) throw new Error(failure);
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

    handle(IPC.runsList, (limit: number) => traceStore.listRuns(limit));
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
