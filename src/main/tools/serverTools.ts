import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { McpServerTool } from '@shared/settings';
import { getSettings } from '../store/settingsStore';

/**
 * The tools one of the servers in Settings offers, asked of the server itself,
 * so a Processor can be handed the few it needs rather than all of them.
 */

/** How long a listing is reused. Starting a server costs seconds; its tools rarely change. */
const TTL_MS = 10 * 60_000;
const TIMEOUT_MS = 30_000;

const listed = new Map<string, { at: number; tools: Promise<McpServerTool[]> }>();

async function ask(command: string, args: string[]): Promise<McpServerTool[]> {
    const client = new Client({name: 'patchbay', version: '1.0.0'});
    const transport = new StdioClientTransport({command, args, stderr: 'ignore'});
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`it did not answer within ${TIMEOUT_MS / 1000} seconds`)), TIMEOUT_MS);
    });
    try {
        await Promise.race([client.connect(transport), timeout]);
        const {tools} = await Promise.race([client.listTools(), timeout]);
        return tools
            .map((t) => ({name: t.name, description: t.description ?? ''}))
            .sort((a, b) => a.name.localeCompare(b.name));
    } finally {
        clearTimeout(timer);
        await client.close().catch(() => undefined);
    }
}

export function listServerTools(server: string): Promise<McpServerTool[]> {
    const setting = getSettings().mcpServers.find((s) => s.name === server);
    if (!setting) return Promise.reject(new Error(`There is no MCP server "${server}" in Settings.`));
    // Keyed by how the server is started, so editing it in Settings asks again.
    const key = JSON.stringify([setting.command, setting.args]);
    const hit = listed.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.tools;
    const entry = {at: Date.now(), tools: ask(setting.command, setting.args)};
    listed.set(key, entry);
    // A failure is not kept: the next look should try the server again.
    entry.tools.catch(() => {
        if (listed.get(key) === entry) listed.delete(key);
    });
    return entry.tools;
}
