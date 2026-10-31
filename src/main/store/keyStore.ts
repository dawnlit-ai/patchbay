import { AGENT_KEY_VARIABLES, type AgentId, type AgentKeySource } from '@shared/settings';
import { agentKeysFile } from '../paths';
import { readJson, writeJson } from './jsonFile';
import { seal, unseal } from './sealed';

/**
 * The API keys of the agents reached with one rather than a CLI signed in on this
 * computer — Jev's — set in Settings and kept sealed in the app's data. Where none
 * is set, the agent's variable in Patchbay's environment stands in for it. The
 * windows are told where a key comes from, never what it is.
 */

/** Sealed keys, base64, by agent. */
type KeyFile = Partial<Record<AgentId, string>>;

function readAll(): KeyFile {
    const raw = readJson<unknown>(agentKeysFile(), {});
    return typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as KeyFile) : {};
}

function variableFor(agent: AgentId): string {
    const variable = AGENT_KEY_VARIABLES[agent];
    if (!variable) throw new Error(`${agent} takes no API key.`);
    return variable;
}

function store(agent: AgentId, sealed: string | null): void {
    const all = readAll();
    if (sealed === null) delete all[agent];
    else all[agent] = sealed;
    writeJson(agentKeysFile(), all);
}

/** Set the agent's key, or take it away with null, leaving its environment variable to stand in. */
export async function setAgentKey(agent: AgentId, key: string | null): Promise<void> {
    const variable = variableFor(agent);
    const value = key?.trim() ?? '';
    store(agent, value ? await seal(value, `Set ${variable} in Patchbay’s environment instead.`) : null);
}

/** Where the agent's key would come from now, without opening it. */
export function agentKeySource(agent: AgentId): AgentKeySource {
    const variable = variableFor(agent);
    if (typeof readAll()[agent] === 'string') return 'patchbay';
    return process.env[variable]?.trim() ? 'environment' : null;
}

/** The agent's key, opened, and where it came from. Null when there is none. */
export async function agentKey(agent: AgentId): Promise<{ value: string; from: string } | null> {
    const variable = variableFor(agent);
    const sealed = readAll()[agent];
    if (typeof sealed === 'string') {
        let opened: Awaited<ReturnType<typeof unseal>>;
        try {
            opened = await unseal(sealed);
        } catch {
            throw new Error(
                'The API key set in Settings → Agents could not be opened on this computer — set on another one, or under a key the system no longer has. Set it again.',
            );
        }
        // The system has a newer key: sealed again under it, for next time.
        if (opened.reseal) store(agent, await seal(opened.value, ''));
        return {value: opened.value, from: 'set in Patchbay'};
    }
    const fromEnvironment = process.env[variable]?.trim();
    return fromEnvironment ? {value: fromEnvironment, from: `from ${variable}`} : null;
}
