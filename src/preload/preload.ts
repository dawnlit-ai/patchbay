import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { Api } from '@shared/ipc';
import { IPC } from '@shared/ipc';

/**
 * The renderer gets exactly this object and nothing else. Every method is a thin
 * pass-through, so the shape in shared/ipc.ts is the whole contract.
 */

/**
 * `ipcRenderer.invoke` with Electron's "Error invoking remote method '…': Error: "
 * prefix stripped, so the window shows the message main wrote.
 */
const call: typeof ipcRenderer.invoke = async (channel, ...args) => {
    try {
        return await ipcRenderer.invoke(channel, ...args);
    } catch (e) {
        const raw = e instanceof Error ? e.message : String(e);
        throw new Error(raw.replace(/^Error invoking remote method '[^']*': (?:Error: )?/, ''));
    }
};

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
    const listener = (_event: IpcRendererEvent, payload: T): void => cb(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
}

const api: Api = {
    about: () => call(IPC.about),
    openDeveloperSite: () => call(IPC.openDeveloperSite),
    revealWorkspace: () => call(IPC.revealWorkspace),
    copyText: (text) => call(IPC.copyText, text),
    flows: {
        entries: () => call(IPC.flowsEntries),
        save: (flow) => call(IPC.flowsSave, flow),
        create: (name) => call(IPC.flowsCreate, name),
        duplicate: (flow, name) => call(IPC.flowsDuplicate, flow, name),
        rename: (flowId, name) => call(IPC.flowsRename, flowId, name),
        remove: (id) => call(IPC.flowsRemove, id),
        setFolder: (flowId, folder) => call(IPC.flowsSetFolder, flowId, folder),
        revealFolder: (flowId) => call(IPC.flowsReveal, flowId),
        pickAndImport: () => call(IPC.flowsPickAndImport),
    },
    settings: {
        get: () => call(IPC.settingsGet),
        save: (settings) => call(IPC.settingsSave, settings),
    },
    agentControl: {
        status: () => call(IPC.agentControlStatus),
        regenerateToken: () => call(IPC.agentControlRegenerateToken),
    },
    outlook: {
        accounts: () => call(IPC.outlookAccounts),
        folders: (account) => call(IPC.outlookFolders, account),
        recent: (scope, days, limit) => call(IPC.outlookRecent, scope, days, limit),
        dragged: (account, drag) => call(IPC.outlookDragged, account, drag),
        selected: (account) => call(IPC.outlookSelected, account),
    },
    claude: {
        models: () => call(IPC.claudeModels),
    },
    skills: {
        list: (flowId) => call(IPC.skillsList, flowId),
        get: (scope, flowId, name) => call(IPC.skillsGet, scope, flowId, name),
        save: (scope, flowId, name, content) =>
            call(IPC.skillsSave, scope, flowId, name, content),
        remove: (scope, flowId, name) => call(IPC.skillsRemove, scope, flowId, name),
        move: (from, to, flowId, name) => call(IPC.skillsMove, from, to, flowId, name),
        pickAndImport: (scope, flowId) => call(IPC.skillsPickAndImport, scope, flowId),
        folders: () => call(IPC.skillsFolders),
        setFolders: (paths) => call(IPC.skillsSetFolders, paths),
        pickFolder: () => call(IPC.skillsPickFolder),
        revealFolder: (path) => call(IPC.skillsRevealFolder, path),
    },
    engine: {
        start: (flowId) => call(IPC.engineStart, flowId),
        stop: (flowId) => call(IPC.engineStop, flowId),
        status: () => call(IPC.engineStatus),
        testRun: (flowId, nodeId, email) => call(IPC.engineTestRun, flowId, nodeId, email),
        cancel: (runId) => call(IPC.engineCancel, runId),
    },
    window: {
        minimize: () => call(IPC.windowMinimize),
        toggleMaximize: () => call(IPC.windowToggleMaximize),
        close: () => call(IPC.windowClose),
        isMaximized: () => call(IPC.windowIsMaximized),
        openFlow: (flowId, where) => call(IPC.windowOpenFlow, flowId, where),
        openFlows: () => call(IPC.windowOpenFlows),
        showWelcome: () => call(IPC.windowShowWelcome),
        showSettings: () => call(IPC.windowShowSettings),
    },
    runs: {
        list: (limit) => call(IPC.runsList, limit),
        get: (id) => call(IPC.runsGet, id),
        clear: () => call(IPC.runsClear),
        revealFolder: () => call(IPC.runsReveal),
    },
    log: {
        list: () => call(IPC.logList),
        clear: () => call(IPC.logClear),
        revealFolder: () => call(IPC.logReveal),
    },
    on: {
        runUpdated: (cb) => subscribe(IPC.evtRunUpdated, cb),
        engineStatus: (cb) => subscribe(IPC.evtEngineStatus, cb),
        windowMaximized: (cb) => subscribe(IPC.evtWindowMaximized, cb),
        openFlow: (cb) => subscribe(IPC.evtOpenFlow, cb),
        agentControl: (cb) => subscribe(IPC.evtAgentControl, cb),
        workspaceChanged: (cb) => subscribe(IPC.evtWorkspaceChanged, cb),
        logged: (cb) => subscribe(IPC.evtLogged, cb),
    },
};

contextBridge.exposeInMainWorld('api', api);
