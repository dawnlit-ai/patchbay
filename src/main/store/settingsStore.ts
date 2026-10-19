import { app } from 'electron';
import { settingsFile } from '../paths';
import { readJson, writeJson } from './jsonFile';
import { agentsInOrder, defaultSettings, type Settings } from '@shared/settings';

let cached: Settings | null = null;

export function getSettings(): Settings {
    // Merge over the defaults so a settings file written by an older version gains
    // new fields instead of leaving them undefined.
    if (cached) return cached;
    const stored = readJson<Partial<Settings>>(settingsFile(), {});
    cached = { ...defaultSettings(), ...stored, agents: agentsInOrder(stored.agents) };
    // Someone who downloaded a nightly wants the next one, until they choose otherwise.
    if (!stored.updateChannel && app.getVersion().includes('-nightly')) cached.updateChannel = 'nightly';
    return cached;
}

export function saveSettings(settings: Settings): Settings {
    cached = { ...defaultSettings(), ...settings, agents: agentsInOrder(settings.agents) };
    writeJson(settingsFile(), cached);
    return cached;
}
