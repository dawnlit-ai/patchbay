/**
 * The single contract between renderer and main. The preload builds `window.api`
 * from this shape, so a channel that changes here fails to compile on both sides
 * rather than going quiet at runtime.
 */

import type { Flow } from './flow';
import type { EmailEnvelope, Run, RunSummary } from './trace';
import type { AboutInfo, EngineStatus, Settings, SkillDetail, SkillSummary } from './settings';

export interface InboxFolderOption {
  folderPath: string;
  /** Path relative to the Inbox — what a trigger stores. */
  relativePath: string;
  name: string;
  depth: number;
  itemCount: number;
}

export interface Api {
  /**
   * Product identity. `openDeveloperSite` deliberately takes no URL — the main
   * process owns the destination, so the renderer cannot ask the OS to open an
   * arbitrary address.
   */
  about(): Promise<AboutInfo>;
  openDeveloperSite(): Promise<void>;
  flows: {
    list(): Promise<Flow[]>;
    get(id: string): Promise<Flow | null>;
    save(flow: Flow): Promise<Flow>;
    create(name: string): Promise<Flow>;
    remove(id: string): Promise<void>;
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
  skills: {
    list(): Promise<SkillSummary[]>;
    get(name: string): Promise<SkillDetail | null>;
    save(name: string, content: string): Promise<SkillSummary>;
    remove(name: string): Promise<void>;
    /** Copy SKILL.md folders in from a directory on disk. Returns names imported. */
    importFrom(dir: string): Promise<string[]>;
    /** Ask the user for a folder, then import from it. */
    pickAndImport(): Promise<{ dir: string; imported: string[] } | null>;
  };
  engine: {
    start(): Promise<EngineStatus>;
    stop(): Promise<EngineStatus>;
    status(): Promise<EngineStatus>;
    /** Run one flow against one specific email, ignoring the watermark. */
    testRun(flowId: string, email: EmailEnvelope): Promise<string>;
    cancel(runId: string): Promise<void>;
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
  };
}

export const IPC = {
  about: 'app:about',
  openDeveloperSite: 'app:openDeveloperSite',

  flowsList: 'flows:list',
  flowsGet: 'flows:get',
  flowsSave: 'flows:save',
  flowsCreate: 'flows:create',
  flowsRemove: 'flows:remove',

  settingsGet: 'settings:get',
  settingsSave: 'settings:save',

  outlookAccounts: 'outlook:accounts',
  outlookFolders: 'outlook:folders',
  outlookRecent: 'outlook:recent',

  skillsList: 'skills:list',
  skillsGet: 'skills:get',
  skillsSave: 'skills:save',
  skillsRemove: 'skills:remove',
  skillsImportFrom: 'skills:importFrom',
  skillsPickAndImport: 'skills:pickAndImport',

  engineStart: 'engine:start',
  engineStop: 'engine:stop',
  engineStatus: 'engine:status',
  engineTestRun: 'engine:testRun',
  engineCancel: 'engine:cancel',

  runsList: 'runs:list',
  runsGet: 'runs:get',
  runsClear: 'runs:clear',
  runsReveal: 'runs:reveal',

  // main → renderer
  evtRunUpdated: 'evt:runUpdated',
  evtEngineStatus: 'evt:engineStatus',
} as const;
