import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { Api } from '@shared/ipc';
import { IPC } from '@shared/ipc';

/**
 * The renderer gets exactly this object and nothing else. Every method is a thin
 * pass-through, so the shape in shared/ipc.ts is the whole contract.
 */

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
    const listener = (_event: IpcRendererEvent, payload: T): void => cb(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
}

const api: Api = {
    about: () => ipcRenderer.invoke(IPC.about),
    openDeveloperSite: () => ipcRenderer.invoke(IPC.openDeveloperSite),
    copyText: (text) => ipcRenderer.invoke(IPC.copyText, text),
    flows: {
        list: () => ipcRenderer.invoke(IPC.flowsList),
        get: (id) => ipcRenderer.invoke(IPC.flowsGet, id),
        save: (flow) => ipcRenderer.invoke(IPC.flowsSave, flow),
        create: (name) => ipcRenderer.invoke(IPC.flowsCreate, name),
        duplicate: (flow, name) => ipcRenderer.invoke(IPC.flowsDuplicate, flow, name),
        remove: (id) => ipcRenderer.invoke(IPC.flowsRemove, id),
        pickAndImport: () => ipcRenderer.invoke(IPC.flowsPickAndImport),
        pickAndExport: (flow) => ipcRenderer.invoke(IPC.flowsPickAndExport, flow),
    },
    settings: {
        get: () => ipcRenderer.invoke(IPC.settingsGet),
        save: (settings) => ipcRenderer.invoke(IPC.settingsSave, settings),
    },
    agentControl: {
        status: () => ipcRenderer.invoke(IPC.agentControlStatus),
        regenerateToken: () => ipcRenderer.invoke(IPC.agentControlRegenerateToken),
    },
    outlook: {
        accounts: () => ipcRenderer.invoke(IPC.outlookAccounts),
        folders: (account) => ipcRenderer.invoke(IPC.outlookFolders, account),
        recent: (account, folder, limit) => ipcRenderer.invoke(IPC.outlookRecent, account, folder, limit),
    },
    skills: {
        list: (flowId) => ipcRenderer.invoke(IPC.skillsList, flowId),
        get: (scope, flowId, name) => ipcRenderer.invoke(IPC.skillsGet, scope, flowId, name),
        save: (scope, flowId, name, content) =>
            ipcRenderer.invoke(IPC.skillsSave, scope, flowId, name, content),
        remove: (scope, flowId, name) => ipcRenderer.invoke(IPC.skillsRemove, scope, flowId, name),
        move: (from, to, flowId, name) => ipcRenderer.invoke(IPC.skillsMove, from, to, flowId, name),
        importFrom: (scope, flowId, dir) => ipcRenderer.invoke(IPC.skillsImportFrom, scope, flowId, dir),
        pickAndImport: (scope, flowId) => ipcRenderer.invoke(IPC.skillsPickAndImport, scope, flowId),
    },
    engine: {
        start: () => ipcRenderer.invoke(IPC.engineStart),
        stop: () => ipcRenderer.invoke(IPC.engineStop),
        status: () => ipcRenderer.invoke(IPC.engineStatus),
        testRun: (flowId, nodeId, email) => ipcRenderer.invoke(IPC.engineTestRun, flowId, nodeId, email),
        cancel: (runId) => ipcRenderer.invoke(IPC.engineCancel, runId),
    },
    window: {
        minimize: () => ipcRenderer.invoke(IPC.windowMinimize),
        toggleMaximize: () => ipcRenderer.invoke(IPC.windowToggleMaximize),
        close: () => ipcRenderer.invoke(IPC.windowClose),
        isMaximized: () => ipcRenderer.invoke(IPC.windowIsMaximized),
    },
    runs: {
        list: (limit) => ipcRenderer.invoke(IPC.runsList, limit),
        get: (id) => ipcRenderer.invoke(IPC.runsGet, id),
        clear: () => ipcRenderer.invoke(IPC.runsClear),
        revealFolder: () => ipcRenderer.invoke(IPC.runsReveal),
    },
    on: {
        runUpdated: (cb) => subscribe(IPC.evtRunUpdated, cb),
        engineStatus: (cb) => subscribe(IPC.evtEngineStatus, cb),
        windowMaximized: (cb) => subscribe(IPC.evtWindowMaximized, cb),
        agentControl: (cb) => subscribe(IPC.evtAgentControl, cb),
        workspaceChanged: (cb) => subscribe(IPC.evtWorkspaceChanged, cb),
    },
};

contextBridge.exposeInMainWorld('api', api);
