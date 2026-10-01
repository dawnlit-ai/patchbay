import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

/**
 * A run's in-process MCP servers, served over HTTP on loopback for an agent CLI
 * that cannot be handed a server object. Each is reachable only under a path its
 * run alone is told, and only while that run lasts.
 */

const served = new Map<string, StreamableHTTPServerTransport>();
let listening: Promise<number> | null = null;

function listen(): Promise<number> {
    listening ??= new Promise((resolve, reject) => {
        const http = createServer((req, res) => {
            const transport = served.get((req.url ?? '').split('?')[0] ?? '');
            // A local browser page can post to loopback, but cannot leave its Origin off.
            if (!transport || req.headers.origin !== undefined) {
                res.writeHead(404).end();
                return;
            }
            void transport.handleRequest(req, res);
        });
        http.on('error', (e) => {
            listening = null;
            reject(e);
        });
        http.listen(0, '127.0.0.1', () => resolve((http.address() as AddressInfo).port));
        // Nothing to wait for once the app is quitting: the runs it serves are gone too.
        http.unref();
    });
    return listening;
}

export async function serveOnLoopback(server: McpServer): Promise<{ url: string; close(): Promise<void> }> {
    const port = await listen();
    const path = `/mcp/${randomBytes(24).toString('hex')}`;
    // One session: the server object is this run's, and the CLI holds one connection for the run.
    const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomBytes(16).toString('hex'),
        enableJsonResponse: true,
    });
    await server.connect(transport);
    served.set(path, transport);
    return {
        url: `http://127.0.0.1:${port}${path}`,
        close: async () => {
            served.delete(path);
            await server.close();
        },
    };
}
