/** The one contract between renderer and main; the preload builds `window.api` from it. */

import type { Flow, MailScope } from './flow';
import type { EmailEnvelope, Run, RunSummary } from './trace';
import type { LogEntry } from './log';
import type {
    AboutInfo,
    AgentControlStatus,
    EngineStatus,
    McpServerTool,
    Settings,
    SkillSummary,
    UpdateStatus,
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
 * A folder holding flows and the skills they share: `flows/<name>.json` and
 * `skills/<name>/SKILL.md`. One is open at a time, and its folder is where every
 * one of its runs works.
 */
export interface WorkspaceInfo {
    /** The folder's own name, which is what the workspace is called. */
    name: string;
    /** Absolute path to it. */
    path: string;
    /** Gone since it was last open: renamed, deleted, or on a drive not plugged in. */
    missing: boolean;
}

/**
 * A flow and its file in the workspace's `flows` folder — what the welcome window
 * lists. The file is the user's to rename; the id inside the flow is not.
 */
export interface FlowEntry {
    flow: Flow;
    /** Absolute path to the flow file. */
    file: string;
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

/** A model Claude Code or agy offers, as its own model list names it. */
export interface ModelOption {
    /** What a node stores and the run is started with — often an alias, such as `opus`. */
    value: string;
    /** The model that alias stands for today, e.g. `claude-opus-5-5`. */
    resolvedModel?: string;
    displayName: string;
    description: string;
    /** The effort levels this model takes, as Claude Code lists them. Empty when it takes none. */
    effortLevels: string[];
    /** The model has no default level, as agy's models have none: a node on it names one. */
    effortRequired?: boolean;
}

/** One of a plan's usage limits, as the agent reports it. */
export interface UsageWindow {
    /** What the limit covers, e.g. "5-hour session" or "Gemini · week". */
    label: string;
    /** How much of it is used, 0–100. */
    percentUsed: number;
    /** When it resets, as an ISO time. Null when the agent does not say. */
    resetsAt: string | null;
}

/** How one agent stands, as Settings → Agents shows it: found, which version, and signed in. */
export interface AgentStatus {
    /** `claude` or `agy`. */
    id: string;
    name: string;
    /** The binary a run starts. Empty when none was found. */
    executable: string;
    /** What it says its version is. Null when it did not say. */
    version: string | null;
    /** Found and signed in, so a node on one of its models can run. */
    ready: boolean;
    /** Who it is signed in as, or what is in the way. */
    detail: string;
    /** The plan's limits and how much of each is used. Empty when the agent reports none, as for an API key. */
    usage: UsageWindow[];
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
    /**
     * Which workspace is open, and switching to another. A switch is refused while a
     * run is under way; otherwise it stops watching every flow and closes every canvas.
     */
    workspace: {
        /** Null when none is open: the first launch, or the last one's folder has gone. */
        current(): Promise<WorkspaceInfo | null>;
        /** Workspaces opened before, the last one first, the open one included. */
        recent(): Promise<WorkspaceInfo[]>;
        /** Open a folder as the workspace. Its `flows` and `skills` folders are made when first written. */
        open(path: string): Promise<WorkspaceInfo>;
        /** Ask for a folder, then open it. Null if cancelled. */
        pickAndOpen(): Promise<WorkspaceInfo | null>;
        /**
         * Make a folder named after it inside `location`, with a starter skill, open
         * it, and remember `location` for the next one.
         */
        create(name: string, location: string): Promise<WorkspaceInfo>;
        /** The folder New workspace offers: the last one used, else one in Documents. */
        location(): Promise<string>;
        /** Ask for a folder to put a new workspace in, starting from `current`. Null if cancelled. */
        pickLocation(current: string): Promise<string | null>;
        /** Take one off the recent list. Its folder is untouched. */
        forget(path: string): Promise<WorkspaceInfo[]>;
        /** Show the open workspace's folder in the file manager. */
        reveal(): Promise<void>;
    };
    flows: {
        /** The open workspace's flows. */
        entries(): Promise<FlowEntry[]>;
        /**
         * Write an edit made to the version `flow.updatedAt` names. Refused, not
         * written, when anything but this window has written the flow since.
         */
        save(flow: Flow): Promise<SaveOutcome>;
        /** Make a flow in the workspace, in a file named after it. */
        create(name: string): Promise<Flow>;
        /** Copy a flow — as it stands on screen, unsaved edits included — into a new one in the workspace. */
        duplicate(flow: Flow, name: string): Promise<Flow>;
        /** Rename the flow, leaving its graph as stored. Its own call so other windows are told. */
        rename(flowId: string, name: string): Promise<Flow>;
        /** Delete the flow's file. The skills it ticks stay: they are the workspace's. */
        remove(id: string): Promise<void>;
        /** Rename the flow's file, within `flows`; its id is untouched. */
        setFileName(flowId: string, fileName: string): Promise<FlowEntry>;
        /** Show the flow's file in the file manager. */
        reveal(flowId: string): Promise<void>;
        /**
         * Ask for a flow file, then copy it into the workspace, with any skills it
         * carries that the workspace does not have yet. Null if cancelled.
         */
        pickAndImport(): Promise<Flow | null>;
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
    /** The channel is an ordinary setting; these are what only the updater knows. */
    updates: {
        status(): Promise<UpdateStatus>;
        /** Look now rather than on the timer, and download what turns up. */
        check(): Promise<UpdateStatus>;
        /** Quit and come back on the downloaded version. Refused while a run is under way. */
        restart(): Promise<void>;
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
    agents: {
        /**
         * The models the Claude login offers now, asked of Claude Code rather than written into the app,
         * then the models agy offers.
         */
        models(): Promise<ModelOption[]>;
        /** One agent's version, sign-in and usage, asked of it now: `claude` or `agy`. */
        status(id: string): Promise<AgentStatus>;
        /** What the last check of that agent found this session, shown while the next runs. */
        lastStatus(id: string): Promise<AgentStatus | null>;
    };
    /** The open workspace's one library, in its `skills` folder, which every flow in it shares. */
    skills: {
        list(): Promise<SkillSummary[]>;
        /** Write a new SKILL.md. Refused when the library already holds that name. */
        create(name: string, content: string): Promise<SkillSummary>;
        /**
         * Open the SKILL.md in the system's app for `.md` files; the save is picked up
         * by watching the folder. Refused when the skill has gone since the list was read.
         */
        open(name: string): Promise<void>;
        /** Show the skill's folder in the file manager. */
        reveal(name: string): Promise<void>;
        remove(name: string): Promise<void>;
        /** Ask the user for SKILL.md files, then copy each one's skill into the library. */
        pickAndImport(): Promise<{ imported: string[]; skipped: string[] } | null>;
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
    /** The open workspace's runs. */
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
        updateStatus(cb: (status: UpdateStatus) => void): () => void;
        /** An agent wrote to the workspace; what is on screen is now behind it. */
        workspaceChanged(cb: (change: WorkspaceChange) => void): () => void;
        logged(cb: (entry: LogEntry) => void): () => void;
    };

    about(): Promise<AboutInfo>;

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
    copyText: 'app:copyText',

    workspaceCurrent: 'workspace:current',
    workspaceRecent: 'workspace:recent',
    workspaceOpen: 'workspace:open',
    workspacePickAndOpen: 'workspace:pickAndOpen',
    workspaceCreate: 'workspace:create',
    workspaceLocation: 'workspace:location',
    workspacePickLocation: 'workspace:pickLocation',
    workspaceForget: 'workspace:forget',
    workspaceReveal: 'workspace:reveal',

    flowsEntries: 'flows:entries',
    flowsSave: 'flows:save',
    flowsCreate: 'flows:create',
    flowsDuplicate: 'flows:duplicate',
    flowsRename: 'flows:rename',
    flowsRemove: 'flows:remove',
    flowsSetFileName: 'flows:setFileName',
    flowsReveal: 'flows:reveal',
    flowsPickAndImport: 'flows:pickAndImport',

    settingsGet: 'settings:get',
    settingsSave: 'settings:save',
    settingsServerTools: 'settings:serverTools',

    agentControlStatus: 'agentControl:status',
    agentControlRegenerateToken: 'agentControl:regenerateToken',

    updatesStatus: 'updates:status',
    updatesCheck: 'updates:check',
    updatesRestart: 'updates:restart',

    outlookAccounts: 'outlook:accounts',
    outlookFolders: 'outlook:folders',
    outlookRecent: 'outlook:recent',
    outlookDragged: 'outlook:dragged',
    outlookSelected: 'outlook:selected',

    agentsModels: 'agents:models',
    agentsStatus: 'agents:status',
    agentsLastStatus: 'agents:lastStatus',

    skillsList: 'skills:list',
    skillsCreate: 'skills:create',
    skillsOpen: 'skills:open',
    skillsReveal: 'skills:reveal',
    skillsRemove: 'skills:remove',
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
    evtUpdateStatus: 'evt:updateStatus',
    evtWorkspaceChanged: 'evt:workspaceChanged',
    evtLogged: 'evt:logged',
} as const;
