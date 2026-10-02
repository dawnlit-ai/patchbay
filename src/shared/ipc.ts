/** The one contract between renderer and main; the preload builds `window.api` from it. */

import type { Flow, MailScope } from './flow';
import type { EmailEnvelope, Run, RunSummary } from './trace';
import type { LogEntry } from './log';
import type {
    AboutInfo,
    AgentControlStatus,
    EngineStatus,
    GlobalSkillFolder,
    McpServerTool,
    Settings,
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
    /** The directory's own name: under `flows/`, or wherever a file opened in place sits. */
    folder: string;
    /** Absolute path to it. */
    path: string;
    /** The flow file itself. */
    file: string;
    /**
     * Opened from elsewhere on disk and saved back there. Its folder is the user's,
     * so the app neither renames nor deletes it.
     */
    inPlace: boolean;
}

/**
 * A canvas save: written, or refused because something else wrote the flow since.
 * `current` is the flow as it now stands, or null once deleted.
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

/** A model the Claude account offers, as Claude Code's own model picker lists it. */
export interface ModelOption {
    /** What a node stores and the run is started with — often an alias, such as `opus`. */
    value: string;
    /** The model that alias stands for today, e.g. `claude-opus-5-5`. */
    resolvedModel?: string;
    displayName: string;
    description: string;
    /** The effort levels this model takes, as Claude Code lists them. Empty when it takes none. */
    effortLevels: string[];
    /** The model has no default level, as agy's Gemini models have none: a node on it names one. */
    effortRequired?: boolean;
}

/**
 * What an external drag dropped on a trigger carried. Outlook gives a `.msg`
 * named after the subject and some text, but no id, so this only confirms the
 * email selected in Outlook.
 */
export interface OutlookDrag {
    text: string;
    fileNames: string[];
    /** The formats on offer, kept for the console when a drop is refused. */
    types: string[];
}

export interface Api {
    flows: {
        entries(): Promise<FlowEntry[]>;
        /**
         * Write an edit made to the version `flow.updatedAt` names. Refused, not
         * written, when anything but this window has written the flow since.
         */
        save(flow: Flow): Promise<SaveOutcome>;
        /**
         * Make a flow in a folder of its own, named after it, inside `location`, and
         * remember `location` for the next one.
         */
        create(name: string, location: string): Promise<Flow>;
        /** The folder New flow and Duplicate offer: the last one used, else one in Documents. */
        location(): Promise<string>;
        /** Ask for a folder to put a new flow's folder in, starting from `current`. Null if cancelled. */
        pickLocation(current: string): Promise<string | null>;
        /**
         * Copy a flow into a new one in a folder of its own inside `location` — the flow
         * as it stands on screen, and the skill library belonging to the flow it came
         * from — and remember `location` for the next one.
         */
        duplicate(flow: Flow, name: string, location: string): Promise<Flow>;
        /** Rename the flow, leaving its graph as stored. Its own call so other windows are told. */
        rename(flowId: string, name: string): Promise<Flow>;
        /** Delete a flow made here; one opened in place is only taken off the list. */
        remove(id: string): Promise<void>;
        /**
         * Rename the flow's directory; its id is untouched. Refused while a run of it is
         * in flight, and for a flow opened in place.
         */
        setFolder(flowId: string, folder: string): Promise<FlowEntry>;
        revealFolder(flowId: string): Promise<void>;
        /** Ask for a flow file, then open it where it is: listed, and saved back to that file. */
        pickAndOpen(): Promise<Flow | null>;
    };
    settings: {
        get(): Promise<Settings>;
        save(settings: Settings): Promise<Settings>;
        /** The tools one of the MCP servers in Settings offers, asked of the server. */
        serverTools(server: string): Promise<McpServerTool[]>;
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
         * The email dragged out of Outlook onto a trigger. Refused if it doesn't match
         * Outlook's selection or lives in another mailbox.
         */
        dragged(account: string, drag: OutlookDrag): Promise<EmailEnvelope>;
        /** The email selected in Outlook, for a trigger. Refused if it lives in another mailbox. */
        selected(account: string): Promise<EmailEnvelope>;
    };
    claude: {
        /**
         * The models the Claude login offers now, asked of Claude Code rather than written into the app,
         * then the Gemini models agy offers.
         */
        models(): Promise<ModelOption[]>;
    };
    /**
     * Two libraries: one global to the install, one belonging to the flow. Every
     * call says which it means, and `flowId` is read only for the flow's own.
     */
    skills: {
        /** Both at once, each entry carrying the scope it came from. */
        list(flowId: string): Promise<SkillSummary[]>;
        /** Write a new SKILL.md. Refused when the library already holds that name. */
        create(scope: SkillScope, flowId: string, name: string, content: string): Promise<SkillSummary>;
        /**
         * Open the SKILL.md in the system's app for `.md` files; the save is picked up
         * by watching the folder. Refused when the skill has gone since the list was read.
         */
        open(scope: SkillScope, flowId: string, name: string): Promise<void>;
        /** Show the skill's folder in the file manager. */
        reveal(scope: SkillScope, flowId: string, name: string): Promise<void>;
        remove(scope: SkillScope, flowId: string, name: string): Promise<void>;
        /**
         * Take it out of one library and put it in the other, overwriting a skill of
         * the same name there. The caller asks first, and repairs the ticks.
         */
        move(from: SkillScope, to: SkillScope, flowId: string, name: string): Promise<SkillSummary>;
        /** Ask the user for SKILL.md files, then copy each one's skill into the library. */
        pickAndImport(
            scope: SkillScope,
            flowId: string,
        ): Promise<{ imported: string[]; skipped: string[] } | null>;
        /** The folders the global library reads, highest first, with what each holds. */
        folders(): Promise<GlobalSkillFolder[]>;
        /** Replace the linked folders, highest first. */
        setFolders(paths: string[]): Promise<GlobalSkillFolder[]>;
        /** Ask the user for a folder to link. Only asks: linking it is `setFolders`. */
        pickFolder(): Promise<string | null>;
        revealFolder(path: string): Promise<void>;
    };
    engine: {
        /** Watching is switched on and off per flow. */
        start(flowId: string): Promise<EngineStatus>;
        stop(flowId: string): Promise<EngineStatus>;
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
        toggleMaximize(): Promise<void>;
        close(): Promise<void>;
        isMaximized(): Promise<boolean>;
        /**
         * Put this flow on the last-used canvas or a new one, or raise the window
         * already showing it. Closes the welcome window.
         */
        openFlow(flowId: string, where?: OpenWhere): Promise<void>;
        /** The flow on each canvas window, most recently used first. */
        openFlows(): Promise<string[]>;
        showWelcome(): Promise<void>;
        showSettings(): Promise<void>;
    };
    runs: {
        list(limit: number): Promise<RunSummary[]>;
        get(id: string): Promise<Run | null>;
        clear(): Promise<void>;
        /** One run, with its trace and saved files. Refused while it is in progress. */
        remove(id: string): Promise<void>;
        /**
         * Put a run's email through its flow again, from the trigger it came in by,
         * found again in Outlook if it has been filed since. Resolves to the new run's id.
         */
        rerun(id: string): Promise<string>;
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
    flowsSave: 'flows:save',
    flowsCreate: 'flows:create',
    flowsLocation: 'flows:location',
    flowsPickLocation: 'flows:pickLocation',
    flowsDuplicate: 'flows:duplicate',
    flowsRename: 'flows:rename',
    flowsRemove: 'flows:remove',
    flowsSetFolder: 'flows:setFolder',
    flowsReveal: 'flows:reveal',
    flowsPickAndOpen: 'flows:pickAndOpen',

    settingsGet: 'settings:get',
    settingsSave: 'settings:save',
    settingsServerTools: 'settings:serverTools',

    agentControlStatus: 'agentControl:status',
    agentControlRegenerateToken: 'agentControl:regenerateToken',

    outlookAccounts: 'outlook:accounts',
    outlookFolders: 'outlook:folders',
    outlookRecent: 'outlook:recent',
    outlookDragged: 'outlook:dragged',
    outlookSelected: 'outlook:selected',

    claudeModels: 'claude:models',

    skillsList: 'skills:list',
    skillsCreate: 'skills:create',
    skillsOpen: 'skills:open',
    skillsReveal: 'skills:reveal',
    skillsRemove: 'skills:remove',
    skillsMove: 'skills:move',
    skillsPickAndImport: 'skills:pickAndImport',
    skillsFolders: 'skills:folders',
    skillsSetFolders: 'skills:setFolders',
    skillsPickFolder: 'skills:pickFolder',
    skillsRevealFolder: 'skills:revealFolder',

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
    runsRemove: 'runs:remove',
    runsRerun: 'runs:rerun',
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
