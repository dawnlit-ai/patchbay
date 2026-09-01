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
    flows: {
        list: () => ipcRenderer.invoke(IPC.flowsList),
        get: (id) => ipcRenderer.invoke(IPC.flowsGet, id),
        save: (flow) => ipcRenderer.invoke(IPC.flowsSave, flow),
        create: (name) => ipcRenderer.invoke(IPC.flowsCreate, name),
        remove: (id) => ipcRenderer.invoke(IPC.flowsRemove, id),
        pickAndImport: () => ipcRenderer.invoke(IPC.flowsPickAndImport),
        pickAndExport: (flow) => ipcRenderer.invoke(IPC.flowsPickAndExport, flow),
        setUnsaved: (unsaved) => ipcRenderer.invoke(IPC.flowsSetUnsaved, unsaved),
    },
    settings: {
        get: () => ipcRenderer.invoke(IPC.settingsGet),
        save: (settings) => ipcRenderer.invoke(IPC.settingsSave, settings),
    },
    outlook: {
        accounts: () => ipcRenderer.invoke(IPC.outlookAccounts),
        folders: (account) => ipcRenderer.invoke(IPC.outlookFolders, account),
        recent: (account, folder, limit) => ipcRenderer.invoke(IPC.outlookRecent, account, folder, limit),
    },
    skills: {
        list: () => ipcRenderer.invoke(IPC.skillsList),
        get: (name) => ipcRenderer.invoke(IPC.skillsGet, name),
        save: (name, content) => ipcRenderer.invoke(IPC.skillsSave, name, content),
        remove: (name) => ipcRenderer.invoke(IPC.skillsRemove, name),
        importFrom: (dir) => ipcRenderer.invoke(IPC.skillsImportFrom, dir),
        pickAndImport: () => ipcRenderer.invoke(IPC.skillsPickAndImport),
    },
    engine: {
        start: () => ipcRenderer.invoke(IPC.engineStart),
        stop: () => ipcRenderer.invoke(IPC.engineStop),
        status: () => ipcRenderer.invoke(IPC.engineStatus),
        testRun: (flowId, email) => ipcRenderer.invoke(IPC.engineTestRun, flowId, email),
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
    },
};

contextBridge.exposeInMainWorld('api', api);
