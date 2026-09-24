import { app, BrowserWindow, clipboard, dialog, ipcMain, shell, type WebContents } from 'electron';
import { type InboxFolderOption, IPC, type OpenWhere, type OutlookDrag } from '@shared/ipc';
import type { Flow, MailScope } from '@shared/flow';
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

/**
 * The app's own MCP server. It drives the same watcher and the same stores the
 * window does — an agent is another hand on the same workspace, not a second
 * copy of it — so a flow it writes is announced here for the window to re-read.
 */
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

/**
 * A write that changes which flows exist, or where one lives. Two windows show
 * the same workspace now — the start page and the canvas — so whichever did not
 * make the change is told to re-read it, exactly as both are told about an
 * agent's writes. The window that asked already has the answer in its reply.
 */
function handleFlowWrite<T extends unknown[], R>(channel: string, fn: (...args: T) => R | Promise<R>): void {
    const run = readable(fn);
    ipcMain.handle(channel, async (event, ...args) => {
        const result = await run(...(args as T));
        broadcast(IPC.evtWorkspaceChanged, { flows: true, skills: false }, event.sender);
        return result;
    });
}

/**
 * A canvas's save, checked against whatever else wrote the flow since the edit
 * was made. Which window sent it is part of the question — its own earlier saves
 * are not somebody else's write — so this one handler reads the sender, and lets
 * go of what it knows about a window once that window is gone.
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
            developerUrl: DEVELOPER_URL,
            license: 'AGPL-3.0-or-later',
            workspace: workspaceRoot(),
        }),
    );
    handle(IPC.openDeveloperSite, () => shell.openExternal(DEVELOPER_URL));
    handle(IPC.revealWorkspace, () => shell.openPath(workspaceRoot()));
    handle(IPC.copyText, (text: string) => clipboard.writeText(text));

    handle(IPC.flowsEntries, () => flowStore.listFlowEntries());
    handle(IPC.flowsGet, (id: string) => flowStore.getFlow(id));
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
        // The directory being renamed is the working directory of anything running
        // in it. Moving it mid-run pulls the ground out from under an agent that
        // is writing files there, so the answer is "not now" rather than "sorry".
        // Only this flow's own runs count: another flow's is in another directory.
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
        // The token is minted here and only ever shown in the window, so the stored
        // one stands whatever comes back: a panel open since before a regeneration
        // holds the old one, and saving it would put a replaced token back in use.
        const { token } = getSettings().agentControl;
        const saved = saveSettings({ ...settings, agentControl: { ...settings.agentControl, token } });
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
    handle(IPC.skillsImportFrom, (scope: SkillScope, flowId: string, dir: string) =>
        skillStore.importSkillsFrom(scope, flowId, dir),
    );
    handle(IPC.skillsPickAndImport, async (scope: SkillScope, flowId: string) => {
        const picked = await dialog.showOpenDialog({
            title:
                scope === 'global'
                    ? 'Choose a folder of skills to add to every flow'
                    : 'Choose a folder of skills to add to this flow',
            properties: ['openDirectory'],
        });
        const dir = picked.filePaths[0];
        if (picked.canceled || !dir) return null;
        return { dir, imported: skillStore.importSkillsFrom(scope, flowId, dir) };
    });

    handle(IPC.engineStart, () => getWatcher().start());
    handle(IPC.engineStop, () => getWatcher().stop());
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
    handle(IPC.runsReveal, () => shell.openPath(runsDir()));

    handle(IPC.logList, () => logEntries());
    handle(IPC.logClear, () => clearLog());
    handle(IPC.logReveal, () => shell.openPath(logsDir()));
    onLogged((entry) => broadcast(IPC.evtLogged, entry));
}
