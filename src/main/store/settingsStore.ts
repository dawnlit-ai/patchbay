import { settingsFile } from '../paths';
import { readJson, writeJson } from './jsonFile';
import { defaultSettings, type Settings } from '@shared/settings';

let cached: Settings | null = null;

export function getSettings(): Settings {
    if (!cached) {
        // Merge over the defaults so a settings file written by an older version
        // gains new fields instead of leaving them undefined.
        cached = { ...defaultSettings(), ...readJson<Partial<Settings>>(settingsFile(), {}) };
    }
    return cached;
}

export function saveSettings(settings: Settings): Settings {
    cached = { ...defaultSettings(), ...settings };
    writeJson(settingsFile(), cached);
    return cached;
}
