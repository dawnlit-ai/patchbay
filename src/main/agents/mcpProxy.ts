import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
    CallToolRequestSchema,
    GetPromptRequestSchema,
    ListPromptsRequestSchema,
    ListResourcesRequestSchema,
    ListResourceTemplatesRequestSchema,
    ListToolsRequestSchema,
    ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { errorMessage } from '@shared/util';
import { unquoteKeys } from './quotedKeys';
import { withToolPath } from './toolPath';
import type { AgentMcpServer } from './types';

/**
 * One of a run's MCP servers, run by this app and served on to an agent CLI by a
 * server of its own that passes each request through. On the way, a tool call's
 * arguments lose the quotes the model wrote inside any key, as Gemini 4 does, which
 * the CLI hands on as they are. It offers what the server offers — its tools, its
 * resources, its prompts — under the server's own name and instructions.
 */

/**
 * How long a tool call is waited for: a tool writing to OneDrive or reading a
 * large workbook can take minutes, and the SDK's own minute is shorter than that.
 */
const CALL_TIMEOUT_MS = 10 * 60_000;

/** The last thing a server said on stderr, to name why it did not start. */
const lastLine = (said: string): string => said.trim().split('\n').at(-1)?.trim() ?? '';

/** Connected to the server as a client, the server started first where this app starts it. */
async function connect(name: string, server: Exclude<AgentMcpServer, {
    type: 'sse'
}>, defaultCwd: string): Promise<Client> {
    const client = new Client({name: 'patchbay', version: '1.0.0'});
    let transport: Transport;
    let said = '';
    if (server.type === 'sdk') {
        const [mine, theirs] = InMemoryTransport.createLinkedPair();
        await server.instance.connect(theirs);
        transport = mine;
    } else if (server.type === 'http') {
        transport = new StreamableHTTPClientTransport(new URL(server.url), {requestInit: {headers: server.headers ?? {}}});
    } else {
        // The environment the agent would have started it with: this app's, with the
        // folders tools install to on the PATH, and the server's own on top.
        const env = Object.fromEntries(
            Object.entries(withToolPath({...process.env, ...server.env})).filter((e): e is [string, string] => e[1] !== undefined),
        );
        const stdio = new StdioClientTransport({
            command: server.command,
            args: server.args ?? [],
            cwd: server.cwd ?? defaultCwd,
            env,
            stderr: 'pipe',
        });
        stdio.stderr?.on('data', (chunk: Buffer) => (said = (said + chunk.toString('utf8')).slice(-4000)));
        transport = stdio;
    }
    try {
        await client.connect(transport);
    } catch (e) {
        await client.close().catch(() => undefined);
        const why = lastLine(said);
        throw new Error(`MCP server "${name}" did not start: ${errorMessage(e)}${why ? ` (it said: ${why})` : ''}`);
    }
    return client;
}

export interface ProxiedServer {
    /** The server to serve to the agent CLI. */
    server: Server;

    /** Disconnects from the server, which stops it where this app started it. */
    close(): Promise<void>;
}

/**
 * `upstream`, started or reached now, and a server that passes requests on to it.
 * `onUnquoted` hears of each tool call whose arguments lost quotes, with the keys.
 */
export async function proxyServer(
    name: string,
    upstream: Exclude<AgentMcpServer, { type: 'sse' }>,
    defaultCwd: string,
    onUnquoted: (tool: string, keys: string[]) => void,
): Promise<ProxiedServer> {
    const client = await connect(name, upstream, defaultCwd);
    const offers = client.getServerCapabilities() ?? {};
    const info = client.getServerVersion();
    const instructions = client.getInstructions();
    const server = new Server(
        {name: info?.name ?? name, version: info?.version ?? '0.0.0'},
        {
            capabilities: {
                ...(offers.tools ? {tools: {}} : {}),
                ...(offers.resources ? {resources: {}} : {}),
                ...(offers.prompts ? {prompts: {}} : {}),
            },
            ...(instructions ? {instructions} : {}),
        },
    );
    if (offers.tools) {
        server.setRequestHandler(ListToolsRequestSchema, (request, {signal}) => client.listTools(request.params, {signal}));
        server.setRequestHandler(CallToolRequestSchema, async (request, {signal}) => {
            const {value, unquoted} = unquoteKeys(request.params.arguments ?? {});
            if (unquoted.length > 0) onUnquoted(request.params.name, unquoted);
            return client.callTool({...request.params, arguments: value as Record<string, unknown>}, undefined, {
                signal,
                timeout: CALL_TIMEOUT_MS,
                resetTimeoutOnProgress: true,
            });
        });
    }
    if (offers.resources) {
        server.setRequestHandler(ListResourcesRequestSchema, (request, {signal}) => client.listResources(request.params, {signal}));
        server.setRequestHandler(ListResourceTemplatesRequestSchema, (request, {signal}) => client.listResourceTemplates(request.params, {signal}));
        server.setRequestHandler(ReadResourceRequestSchema, (request, {signal}) => client.readResource(request.params, {signal}));
    }
    if (offers.prompts) {
        server.setRequestHandler(ListPromptsRequestSchema, (request, {signal}) => client.listPrompts(request.params, {signal}));
        server.setRequestHandler(GetPromptRequestSchema, (request, {signal}) => client.getPrompt(request.params, {signal}));
    }
    return {server, close: () => client.close()};
}
