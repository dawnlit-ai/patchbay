import { createAgents } from './agents';
import { log } from './log';
import { getSettings } from './store/settingsStore';

/** The agents as this app hosts them: their binaries and order from Settings, warnings into the app's log. */
export const agents = createAgents({
    claudeExecutable: () => getSettings().claudeExecutablePath.trim() || undefined,
    agyExecutable: () => getSettings().agyExecutablePath.trim() || undefined,
    agents: () => getSettings().agents,
    warn: (message, detail) => log.warn('run', message, { detail }),
});
