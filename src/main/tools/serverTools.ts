import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { McpServerTool } from '@shared/settings';
import { withToolPath } from '../agents/toolPath';
import { requireServer, type UsableServer } from '../store/mcpStore';

/**
 * The tools one of the workspace's servers offers, asked of the server itself,
 * so a Processor can be handed the few it needs rather than all of them. A
 * server is asked only once it has been allowed.
 */

/** How long a listing is reused. Starting a server costs seconds; its tools rarely change. */
const TTL_MS = 10 * 60_000;
const TIMEOUT_MS = 30_000;

const listed = new Map<string, { at: number; tools: Promise<McpServerTool[]> }>();

function transportFor(launch: UsableServer['launch']): Transport {
    if (launch.type === 'http' || launch.type === 'sse') {
        const url = new URL(launch.url);
        const requestInit = launch.headers ? {headers: launch.headers} : undefined;
        return launch.type === 'http'
            ? new StreamableHTTPClientTransport(url, {requestInit})
            : new SSEClientTransport(url, {requestInit});
    }
    return new StdioClientTransport({
        command: launch.command,
        args: launch.args ?? [],
        // Laid over the transport's own environment, which carries this app's PATH.
        env: withToolPath(launch.env ?? {}),
        cwd: launch.cwd,
        stderr: 'ignore',
    });
}

async function ask(launch: UsableServer['launch']): Promise<McpServerTool[]> {
    const client = new Client({name: 'patchbay', version: '1.0.0'});
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`it did not answer within ${TIMEOUT_MS / 1000} seconds`)), TIMEOUT_MS);
    });
    try {
        await Promise.race([client.connect(transportFor(launch)), timeout]);
        const {tools} = await Promise.race([client.listTools(), timeout]);
        return tools
            .map((t) => ({name: t.name, description: t.description ?? ''}))
            .sort((a, b) => a.name.localeCompare(b.name));
    } catch (e) {
        if (launch.type === 'stdio' && (e as NodeJS.ErrnoException)?.code === 'ENOENT') {
            if (process.platform !== 'win32' && /^cmd(?:\.exe)?$/i.test(launch.command.trim())) {
                throw new Error(
                    `"${launch.command}" is a Windows command interpreter; use the program name directly (such as npx or node) on this system`,
                );
            }
            throw new Error(`could not find "${launch.command}" on PATH`);
        }
        throw e;
    } finally {
        clearTimeout(timer);
        await client.close().catch(() => undefined);
    }
}

export function listServerTools(server: string): Promise<McpServerTool[]> {
    let launch: UsableServer['launch'];
    try {
        launch = requireServer(server).launch;
    } catch (e) {
        return Promise.reject(e instanceof Error ? e : new Error(String(e)));
    }
    // Keyed by how the server is started, so editing its file asks again.
    const key = JSON.stringify(launch);
    const hit = listed.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.tools;
    const entry = {at: Date.now(), tools: ask(launch)};
    listed.set(key, entry);
    // A failure is not kept: the next look should try the server again.
    entry.tools.catch(() => {
        if (listed.get(key) === entry) listed.delete(key);
    });
    return entry.tools;
}
