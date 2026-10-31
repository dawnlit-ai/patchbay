import { app } from 'electron';
import { settingsFile } from '../paths';
import { readJson, writeJson } from './jsonFile';
import { agentsInOrder, defaultSettings, type Settings } from '@shared/settings';

let cached: Settings | null = null;

/**
 * Only the settings this version has. One an older version kept is dropped,
 * such as the MCP servers Settings once held, env values and headers with them.
 */
function known(stored: unknown): Partial<Settings> {
    if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return {};
    const defaults = defaultSettings();
    return Object.fromEntries(Object.entries(stored).filter(([key]) => key in defaults)) as Partial<Settings>;
}

export function getSettings(): Settings {
    // Merge over the defaults so a settings file written by an older version gains
    // new fields instead of leaving them undefined.
    if (cached) return cached;
    const raw = readJson<unknown>(settingsFile(), {});
    const stored = known(raw);
    cached = {...defaultSettings(), ...stored, agents: agentsInOrder(stored.agents)};
    // Someone who downloaded a nightly wants the next one, until they choose otherwise.
    if (!stored.updateChannel && app.getVersion().includes('-nightly')) cached.updateChannel = 'nightly';
    // What was dropped may have held a secret: it leaves the file now, not at the next save.
    if (typeof raw === 'object' && raw !== null && Object.keys(raw).length > Object.keys(stored).length) {
        writeJson(settingsFile(), stored);
    }
    return cached;
}

export function saveSettings(settings: Settings): Settings {
    cached = {...defaultSettings(), ...known(settings), agents: agentsInOrder(settings.agents)};
    writeJson(settingsFile(), cached);
    return cached;
}
