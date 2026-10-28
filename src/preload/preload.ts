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
    copyText: (text) => call(IPC.copyText, text),
    workspace: {
        current: () => call(IPC.workspaceCurrent),
        recent: () => call(IPC.workspaceRecent),
        open: (path) => call(IPC.workspaceOpen, path),
        pickAndOpen: () => call(IPC.workspacePickAndOpen),
        create: (name, location) => call(IPC.workspaceCreate, name, location),
        location: () => call(IPC.workspaceLocation),
        pickLocation: (current) => call(IPC.workspacePickLocation, current),
        forget: (path) => call(IPC.workspaceForget, path),
        reveal: () => call(IPC.workspaceReveal),
        readme: () => call(IPC.workspaceReadme),
        createReadme: () => call(IPC.workspaceCreateReadme),
        editReadme: () => call(IPC.workspaceEditReadme),
    },
    flows: {
        entries: () => call(IPC.flowsEntries),
        save: (flow) => call(IPC.flowsSave, flow),
        create: (name) => call(IPC.flowsCreate, name),
        duplicate: (flow, name) => call(IPC.flowsDuplicate, flow, name),
        rename: (flowId, name) => call(IPC.flowsRename, flowId, name),
        remove: (id) => call(IPC.flowsRemove, id),
        setFileName: (flowId, fileName) => call(IPC.flowsSetFileName, flowId, fileName),
        reveal: (flowId) => call(IPC.flowsReveal, flowId),
        pickAndImport: () => call(IPC.flowsPickAndImport),
    },
    settings: {
        get: () => call(IPC.settingsGet),
        save: (settings) => call(IPC.settingsSave, settings),
        servers: () => call(IPC.settingsServers),
        serverTools: async (server) => {
            const res = (await call(IPC.settingsServerTools, server)) as {
                tools?: Awaited<ReturnType<Api['settings']['serverTools']>>;
                error?: string;
            };
            if (res.error !== undefined) throw new Error(res.error);
            return res.tools ?? [];
        },
        trustServer: (server, allowed) => call(IPC.settingsTrustServer, server, allowed),
        openMcpFile: (source) => call(IPC.settingsOpenMcpFile, source),
        revealMcpFile: (source) => call(IPC.settingsRevealMcpFile, source),
        createMcpFile: () => call(IPC.settingsCreateMcpFile),
    },
    agentControl: {
        status: () => call(IPC.agentControlStatus),
        regenerateToken: () => call(IPC.agentControlRegenerateToken),
    },
    updates: {
        status: () => call(IPC.updatesStatus),
        check: () => call(IPC.updatesCheck),
        restart: () => call(IPC.updatesRestart),
    },
    outlook: {
        accounts: () => call(IPC.outlookAccounts),
        folders: (account) => call(IPC.outlookFolders, account),
        recent: (scope, days, limit) => call(IPC.outlookRecent, scope, days, limit),
        dragged: (account, drag) => call(IPC.outlookDragged, account, drag),
        selected: (account) => call(IPC.outlookSelected, account),
    },
    agents: {
        models: () => call(IPC.agentsModels),
        status: (id) => call(IPC.agentsStatus, id),
        lastStatus: (id) => call(IPC.agentsLastStatus, id),
    },
    skills: {
        list: () => call(IPC.skillsList),
        create: (name, content) => call(IPC.skillsCreate, name, content),
        open: (name) => call(IPC.skillsOpen, name),
        reveal: (name) => call(IPC.skillsReveal, name),
        remove: (name) => call(IPC.skillsRemove, name),
        pickAndImport: () => call(IPC.skillsPickAndImport),
    },
    schemas: {
        list: () => call(IPC.schemasList),
        create: (name, schema) => call(IPC.schemasCreate, name, schema),
        save: (name, schema) => call(IPC.schemasSave, name, schema),
        rename: (from, to) => call(IPC.schemasRename, from, to),
        remove: (name) => call(IPC.schemasRemove, name),
        open: (name) => call(IPC.schemasOpen, name),
        reveal: (name) => call(IPC.schemasReveal, name),
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
        remove: (id) => call(IPC.runsRemove, id),
        rerun: (id) => call(IPC.runsRerun, id),
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
        updateStatus: (cb) => subscribe(IPC.evtUpdateStatus, cb),
        workspaceChanged: (cb) => subscribe(IPC.evtWorkspaceChanged, cb),
        logged: (cb) => subscribe(IPC.evtLogged, cb),
    },
};

contextBridge.exposeInMainWorld('api', api);
