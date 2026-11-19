import { app } from 'electron';
import { settingsFile } from '../paths';
import { readJson, writeJson } from './jsonFile';
import { isJevModel, type ModelChoice } from '@shared/flow';
import { agentsInOrder, defaultSettings, foldersOf, type Settings } from '@shared/settings';
import { isObject } from '@shared/util';

let cached: Settings | null = null;

/** Only the keys a Settings has: anything else in the file is ignored, and not written back. */
function known(stored: unknown): Partial<Settings> {
    if (!isObject(stored)) return {};
    const defaults = defaultSettings();
    return Object.fromEntries(Object.entries(stored).filter(([key]) => key in defaults)) as Partial<Settings>;
}

/**
 * Settings' fallback models as a file lists them: each naming a model, once.
 * Jev's go, since it answers a Categorizer's question and nothing else.
 */
export function fallbacksOf(stored: unknown): ModelChoice[] {
    const out: ModelChoice[] = [];
    for (const entry of Array.isArray(stored) ? stored : []) {
        if (!isObject(entry) || typeof entry.model !== 'string') continue;
        const model = entry.model.trim();
        if (!model || isJevModel(model) || out.some((m) => m.model === model)) continue;
        out.push({
            model,
            effort: typeof entry.effort === 'string' ? entry.effort : '',
            enabled: entry.enabled !== false,
        });
    }
    return out;
}

/** Settings over the defaults, so a field left out is never undefined, and each list read as a file lists it. */
function normalized(stored: Partial<Settings>): Settings {
    return {
        ...defaultSettings(),
        ...stored,
        agents: agentsInOrder(stored.agents),
        folders: foldersOf(stored.folders),
        fallbacks: fallbacksOf(stored.fallbacks),
        devToolsEnabled: stored.devToolsEnabled === true,
    };
}

export function getSettings(): Settings {
    if (cached) return cached;
    const stored = known(readJson<unknown>(settingsFile(), {}));
    cached = normalized(stored);
    // Someone who downloaded a nightly wants the next one, until they choose otherwise.
    if (!stored.updateChannel && app.getVersion().includes('-nightly')) cached.updateChannel = 'nightly';
    return cached;
}

export function saveSettings(settings: Settings): Settings {
    cached = normalized(known(settings));
    writeJson(settingsFile(), cached);
    return cached;
}
