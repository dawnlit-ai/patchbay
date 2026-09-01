/**
 * The single contract between renderer and main. The preload builds `window.api`
 * from this shape, so a channel that changes here fails to compile on both sides
 * rather than going quiet at runtime.
 */

import type { Flow } from './flow';
import type { EmailEnvelope, Run, RunSummary } from './trace';
import type { AboutInfo, EngineStatus, Settings, SkillDetail, SkillScope, SkillSummary, } from './settings';

export interface InboxFolderOption {
    folderPath: string;
    /** Path relative to the Inbox — what a trigger stores. */
    relativePath: string;
    name: string;
    depth: number;
    itemCount: number;
}

export interface Api {
    flows: {
        list(): Promise<Flow[]>;
        get(id: string): Promise<Flow | null>;
        save(flow: Flow): Promise<Flow>;
        create(name: string): Promise<Flow>;
        remove(id: string): Promise<void>;
        /** Ask for a flow file, then add what it holds to the library as a new flow. */
        pickAndImport(): Promise<Flow | null>;
        /**
         * Ask where to put it, then write the flow there — its skill library
         * included, so the file runs wherever it lands. Resolves to the path.
         */
        pickAndExport(flow: Flow): Promise<string | null>;
        /** Whether closing the window right now would throw canvas edits away. */
        setUnsaved(unsaved: boolean): Promise<void>;
    };
    settings: {
        get(): Promise<Settings>;
        save(settings: Settings): Promise<Settings>;
    };
    outlook: {
        accounts(): Promise<string[]>;
        folders(account: string): Promise<InboxFolderOption[]>;
        /** Recent mail, for picking a message to test a flow against. */
        recent(account: string, folder: string, limit: number): Promise<EmailEnvelope[]>;
    };
    /**
     * Two libraries: one global to the install, one belonging to the flow. Every
     * call says which it means, and `flowId` is read only for the flow's own.
     */
    skills: {
        /** Both at once, each entry carrying the scope it came from. */
        list(flowId: string): Promise<SkillSummary[]>;
        get(scope: SkillScope, flowId: string, name: string): Promise<SkillDetail | null>;
        save(scope: SkillScope, flowId: string, name: string, content: string): Promise<SkillSummary>;
        remove(scope: SkillScope, flowId: string, name: string): Promise<void>;
        /**
         * Take it out of one library and put it in the other, overwriting a skill of
         * the same name there. The caller asks first, and repairs the ticks.
         */
        move(from: SkillScope, to: SkillScope, flowId: string, name: string): Promise<SkillSummary>;
        /** Copy SKILL.md folders in from a directory on disk. Returns names imported. */
        importFrom(scope: SkillScope, flowId: string, dir: string): Promise<string[]>;
        /** Ask the user for a folder, then import from it. */
        pickAndImport(
            scope: SkillScope,
            flowId: string,
        ): Promise<{ dir: string; imported: string[] } | null>;
    };
    engine: {
        start(): Promise<EngineStatus>;
        stop(): Promise<EngineStatus>;
        status(): Promise<EngineStatus>;
        /**
         * Run one flow against one specific email, ignoring the watermark. The run
         * starts at the named trigger, since a flow may hold more than one.
         */
        testRun(flowId: string, nodeId: string, email: EmailEnvelope): Promise<string>;
        cancel(runId: string): Promise<void>;
    };
    /**
     * The app draws its own title bar, so minimise, maximise and close have to be
     * asked for rather than handed to the frame.
     */
    window: {
        minimize(): Promise<void>;
        /** Maximise, or restore if already maximised. */
        toggleMaximize(): Promise<void>;
        close(): Promise<void>;
        isMaximized(): Promise<boolean>;
    };
    runs: {
        list(limit: number): Promise<RunSummary[]>;
        get(id: string): Promise<Run | null>;
        clear(): Promise<void>;
        revealFolder(): Promise<void>;
    };
    /** Push channels. Each returns its own unsubscribe. */
    on: {
        runUpdated(cb: (run: Run) => void): () => void;
        engineStatus(cb: (status: EngineStatus) => void): () => void;
        /** Whether the window is maximised, so the button can offer the opposite. */
        windowMaximized(cb: (maximized: boolean) => void): () => void;
    };

    about(): Promise<AboutInfo>;

    /**
     * Deliberately takes no URL: main owns the destination, so the renderer
     * cannot ask the OS to open an arbitrary address.
     */
    openDeveloperSite(): Promise<void>;
}

export const IPC = {
    about: 'app:about',
    openDeveloperSite: 'app:openDeveloperSite',

    flowsList: 'flows:list',
    flowsGet: 'flows:get',
    flowsSave: 'flows:save',
    flowsCreate: 'flows:create',
    flowsRemove: 'flows:remove',
    flowsPickAndImport: 'flows:pickAndImport',
    flowsPickAndExport: 'flows:pickAndExport',
    flowsSetUnsaved: 'flows:setUnsaved',

    settingsGet: 'settings:get',
    settingsSave: 'settings:save',

    outlookAccounts: 'outlook:accounts',
    outlookFolders: 'outlook:folders',
    outlookRecent: 'outlook:recent',

    skillsList: 'skills:list',
    skillsGet: 'skills:get',
    skillsSave: 'skills:save',
    skillsRemove: 'skills:remove',
    skillsMove: 'skills:move',
    skillsImportFrom: 'skills:importFrom',
    skillsPickAndImport: 'skills:pickAndImport',

    engineStart: 'engine:start',
    engineStop: 'engine:stop',
    engineStatus: 'engine:status',
    engineTestRun: 'engine:testRun',
    engineCancel: 'engine:cancel',

    windowMinimize: 'window:minimize',
    windowToggleMaximize: 'window:toggleMaximize',
    windowClose: 'window:close',
    windowIsMaximized: 'window:isMaximized',

    runsList: 'runs:list',
    runsGet: 'runs:get',
    runsClear: 'runs:clear',
    runsReveal: 'runs:reveal',

    // main → renderer
    evtRunUpdated: 'evt:runUpdated',
    evtEngineStatus: 'evt:engineStatus',
    evtWindowMaximized: 'evt:windowMaximized',
} as const;
