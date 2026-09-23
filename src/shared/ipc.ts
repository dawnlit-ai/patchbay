/**
 * The single contract between renderer and main. The preload builds `window.api`
 * from this shape, so a channel that changes here fails to compile on both sides
 * rather than going quiet at runtime.
 */

import type { Flow, MailScope } from './flow';
import type { EmailEnvelope, Run, RunSummary } from './trace';
import type { LogEntry } from './log';
import type {
    AboutInfo,
    AgentControlStatus,
    EngineStatus,
    Settings,
    SkillDetail,
    SkillScope,
    SkillSummary,
} from './settings';

/**
 * What an agent driving the app through its MCP server changed on disk, so the
 * window re-reads that and not the rest.
 */
export interface WorkspaceChange {
    flows: boolean;
    skills: boolean;
}

/**
 * Which canvas a flow opens on when one is already up: the window last used,
 * whose flow it replaces, or a second window beside it.
 */
export type OpenWhere = 'current' | 'new';

/**
 * A flow and the directory it sits in — what the welcome window lists. The
 * folder is the user's to rename; the id inside the flow is not.
 */
export interface FlowEntry {
    flow: Flow;
    /** The directory's own name, under `flows/`. */
    folder: string;
    /** Absolute path to it — shown as the project location, and opened from there. */
    path: string;
}

/**
 * What saving a canvas's edit came to: written, or refused because the flow was
 * written by something else after the edit was made — `current` is the flow as
 * it now stands, or null once it has been deleted.
 */
export type SaveOutcome = { saved: Flow } | { current: Flow | null };

export interface InboxFolderOption {
    folderPath: string;
    /** Path relative to the Inbox — what a trigger stores. */
    relativePath: string;
    name: string;
    depth: number;
    itemCount: number;
}

/**
 * What a drag from outside the app carried when it was dropped on a trigger. An
 * email dragged out of Outlook arrives as a `.msg` copy named after its subject,
 * plus a line of text naming it — no id, so this is evidence to check the
 * email selected in Outlook against, not a way to find one.
 */
export interface OutlookDrag {
    text: string;
    fileNames: string[];
    /** The formats on offer, kept for the console when a drop is refused. */
    types: string[];
}

export interface Api {
    flows: {
        /** Every flow with the directory it lives in — what both windows list. */
        entries(): Promise<FlowEntry[]>;
        get(id: string): Promise<Flow | null>;
        /**
         * Write an edit made to the version `flow.updatedAt` names. Refused, not
         * written, when anything but this window has written the flow since.
         */
        save(flow: Flow): Promise<SaveOutcome>;
        create(name: string): Promise<Flow>;
        /**
         * Copy a flow into a new one of its own — the flow as it stands on screen,
         * and the skill library belonging to the flow it came from.
         */
        duplicate(flow: Flow, name: string): Promise<Flow>;
        /**
         * Change the flow's name only, leaving the graph on disk as it stands. Its
         * own call because the other window is told about it, which an ordinary
         * canvas save — one of many, and only ever about the flow on screen — is not.
         */
        rename(flowId: string, name: string): Promise<Flow>;
        remove(id: string): Promise<void>;
        /**
         * Rename the flow's directory. The flow's id is untouched, so runs already
         * recorded and the watcher's marks go on pointing at it — only the path
         * moves. Refused while a run is in flight, since that directory is its cwd.
         */
        setFolder(flowId: string, folder: string): Promise<FlowEntry>;
        /** Show the flow's directory in the file manager. */
        revealFolder(flowId: string): Promise<void>;
        /** Ask for a flow file, then add what it holds to the library as a new flow. */
        pickAndImport(): Promise<Flow | null>;
    };
    settings: {
        get(): Promise<Settings>;
        save(settings: Settings): Promise<Settings>;
    };
    /**
     * The app's own MCP server. Switching it on and choosing its port are ordinary
     * settings, saved like any other; these two are what only the server knows.
     */
    agentControl: {
        status(): Promise<AgentControlStatus>;
        /** A new token, taking the old one out of use. */
        regenerateToken(): Promise<AgentControlStatus>;
    };
    outlook: {
        accounts(): Promise<string[]>;
        folders(account: string): Promise<InboxFolderOption[]>;
        /** Recent mail where a trigger looks, newest first, for picking a message to test a flow against. */
        recent(scope: MailScope, days: number, limit: number): Promise<EmailEnvelope[]>;
        /**
         * The email dragged out of Outlook onto a trigger, found in that trigger's
         * mailbox. Refused, with the reason, when the drop doesn't match the email
         * selected in Outlook or the email lives in another mailbox.
         */
        dragged(account: string, drag: OutlookDrag): Promise<EmailEnvelope>;
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
        /**
         * Put this flow on a canvas. `where` decides between the canvas last used
         * and a second one; with no canvas open at all it is a new one either way,
         * and a flow already on one raises that window rather than opening it
         * twice. The welcome window closes behind it, having done its job.
         */
        openFlow(flowId: string, where?: OpenWhere): Promise<void>;
        /**
         * The flow on each canvas window, the one last used first. Empty when the
         * welcome window is alone — which is what makes opening one a question
         * worth asking, or not.
         */
        openFlows(): Promise<string[]>;
        /** Bring the welcome window up — the list of flows, and what to do with one. */
        showWelcome(): Promise<void>;
        /** Bring the settings window up, opening it if it is not already. */
        showSettings(): Promise<void>;
    };
    runs: {
        list(limit: number): Promise<RunSummary[]>;
        get(id: string): Promise<Run | null>;
        clear(): Promise<void>;
        revealFolder(): Promise<void>;
    };
    /** The console: what the app did outside any one run. */
    log: {
        /** What main still holds, oldest first. New entries arrive on `on.logged`. */
        list(): Promise<LogEntry[]>;
        /** Empties what the window is shown. The day's file keeps every line. */
        clear(): Promise<void>;
        revealFolder(): Promise<void>;
    };
    /** Push channels. Each returns its own unsubscribe. */
    on: {
        runUpdated(cb: (run: Run) => void): () => void;
        engineStatus(cb: (status: EngineStatus) => void): () => void;
        /** Whether the window is maximised, so the button can offer the opposite. */
        windowMaximized(cb: (maximized: boolean) => void): () => void;
        /** The welcome window chose a flow, and this window is the one to show it. */
        openFlow(cb: (flowId: string) => void): () => void;
        agentControl(cb: (status: AgentControlStatus) => void): () => void;
        /** An agent wrote to the workspace; what is on screen is now behind it. */
        workspaceChanged(cb: (change: WorkspaceChange) => void): () => void;
        logged(cb: (entry: LogEntry) => void): () => void;
    };

    about(): Promise<AboutInfo>;

    /** Show the workspace — flows, skills, runs and logs — in the file manager. */
    revealWorkspace(): Promise<void>;

    /** Put text on the clipboard — a token is not something to retype. */
    copyText(text: string): Promise<void>;

    /**
     * Deliberately takes no URL: main owns the destination, so the renderer
     * cannot ask the OS to open an arbitrary address.
     */
    openDeveloperSite(): Promise<void>;
}

export const IPC = {
    about: 'app:about',
    openDeveloperSite: 'app:openDeveloperSite',
    revealWorkspace: 'app:revealWorkspace',
    copyText: 'app:copyText',

    flowsEntries: 'flows:entries',
    flowsGet: 'flows:get',
    flowsSave: 'flows:save',
    flowsCreate: 'flows:create',
    flowsDuplicate: 'flows:duplicate',
    flowsRename: 'flows:rename',
    flowsRemove: 'flows:remove',
    flowsSetFolder: 'flows:setFolder',
    flowsReveal: 'flows:reveal',
    flowsPickAndImport: 'flows:pickAndImport',

    settingsGet: 'settings:get',
    settingsSave: 'settings:save',

    agentControlStatus: 'agentControl:status',
    agentControlRegenerateToken: 'agentControl:regenerateToken',

    outlookAccounts: 'outlook:accounts',
    outlookFolders: 'outlook:folders',
    outlookRecent: 'outlook:recent',
    outlookDragged: 'outlook:dragged',

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
    windowOpenFlow: 'window:openFlow',
    windowOpenFlows: 'window:openFlows',
    windowShowWelcome: 'window:showWelcome',
    windowShowSettings: 'window:showSettings',

    runsList: 'runs:list',
    runsGet: 'runs:get',
    runsClear: 'runs:clear',
    runsReveal: 'runs:reveal',

    logList: 'log:list',
    logClear: 'log:clear',
    logReveal: 'log:reveal',

    // main → renderer
    evtRunUpdated: 'evt:runUpdated',
    evtEngineStatus: 'evt:engineStatus',
    evtWindowMaximized: 'evt:windowMaximized',
    evtOpenFlow: 'evt:openFlow',
    evtAgentControl: 'evt:agentControl',
    evtWorkspaceChanged: 'evt:workspaceChanged',
    evtLogged: 'evt:logged',
} as const;
