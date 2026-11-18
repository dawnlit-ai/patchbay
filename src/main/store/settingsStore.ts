import { app } from 'electron';
import { settingsFile } from '../paths';
import { readJson, writeJson } from './jsonFile';
import { agentsInOrder, defaultSettings, type Settings } from '@shared/settings';
import { isObject } from '@shared/util';

let cached: Settings | null = null;

/** Only the keys a Settings has: anything else in the file is ignored, and not written back. */
function known(stored: unknown): Partial<Settings> {
    if (!isObject(stored)) return {};
    const defaults = defaultSettings();
    return Object.fromEntries(Object.entries(stored).filter(([key]) => key in defaults)) as Partial<Settings>;
}

export function getSettings(): Settings {
    if (cached) return cached;
    // Over the defaults, so a field the file leaves out is never undefined.
    const stored = known(readJson<unknown>(settingsFile(), {}));
    cached = {...defaultSettings(), ...stored, agents: agentsInOrder(stored.agents)};
    // Someone who downloaded a nightly wants the next one, until they choose otherwise.
    if (!stored.updateChannel && app.getVersion().includes('-nightly')) cached.updateChannel = 'nightly';
    return cached;
}

export function saveSettings(settings: Settings): Settings {
    cached = {...defaultSettings(), ...known(settings), agents: agentsInOrder(settings.agents)};
    writeJson(settingsFile(), cached);
    return cached;
}
