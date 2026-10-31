import { createAgents } from './agents';
import { log } from './log';
import { agentKey } from './store/keyStore';
import { getSettings } from './store/settingsStore';

/** The agents as this app hosts them: their binaries, keys and order from Settings, warnings into the app's log. */
export const agents = createAgents({
    claudeExecutable: () => getSettings().claudeExecutablePath.trim() || undefined,
    agyExecutable: () => getSettings().agyExecutablePath.trim() || undefined,
    jevKey: () => agentKey('jev'),
    agents: () => getSettings().agents,
    warn: (message, detail) => log.warn('run', message, {detail}),
});
