import { settingsFile } from '../paths';
import { readJson, writeJson } from './jsonFile';
import { defaultSettings, type Settings } from '@shared/settings';

let cached: Settings | null = null;

export function getSettings(): Settings {
    // Merge over the defaults so a settings file written by an older version gains
    // new fields instead of leaving them undefined.
    if (cached) return cached;
    const { globalSkillsPath, ...stored } = readJson<Partial<Settings> & { globalSkillsPath?: string }>(
        settingsFile(),
        {},
    );
    cached = { ...defaultSettings(), ...stored };
    // Before the list, one linked folder took the workspace library's place.
    if (globalSkillsPath && !stored.globalSkillFolders) cached.globalSkillFolders = [globalSkillsPath];
    return cached;
}

export function saveSettings(settings: Settings): Settings {
    cached = { ...defaultSettings(), ...settings };
    writeJson(settingsFile(), cached);
    return cached;
}
