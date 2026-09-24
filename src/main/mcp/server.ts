import { app } from 'electron';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { AgentControlStatus } from '@shared/settings';
import { getSettings, saveSettings } from '../store/settingsStore';
import { type AgentHost, INSTRUCTIONS, registerAgentTools } from './tools';
import { log } from '../log';

/**
 * Patchbay's own MCP server, which an agent connects to in order to drive the app.
 * Off by default. When on, it listens on loopback only, requires the bearer token
 * shown in Settings, and refuses any request with a foreign `Host` or any `Origin`
 * (the two headers a browser page cannot forge). Stateless: each request gets a
 * fresh server and transport.
 */

export const MCP_PATH = '/mcp';

/** The name the tools arrive under in a client: `mcp__patchbay__list_flows`. */
export const SERVER_NAME = 'patchbay';

const LOOPBACK = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];

function deny(res: ServerResponse, status: number, message: string): void {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: message }));
}

/** An agent's input can carry a whole SKILL.md; the console keeps the start of it. */
const MAX_ARGS_CHARS = 2_000;

/** Logs every agent tool call, and why any failed, to the console. */
function logToolCalls(server: McpServer): void {
    const register = server.registerTool.bind(server) as (name: string, config: unknown, cb: unknown) => unknown;
    const logged = (name: string, config: { inputSchema?: unknown }, cb: (...args: unknown[]) => unknown): unknown =>
        register(name, config, async (...args: unknown[]) => {
            // A tool without an input schema is handed the request itself, token
            // included, so that is never logged.
            const input = config.inputSchema ? JSON.stringify(args[0] ?? {}) : '{}';
            const detail = input === '{}' ? undefined : input.slice(0, MAX_ARGS_CHARS);
            try {
                const result = await cb(...args);
                log.info('agent', `Called ${name}`, { detail });
                return result;
            } catch (e) {
                log.warn('agent', `${name} failed: ${e instanceof Error ? e.message : String(e)}`, { detail });
                throw e;
            }
        });
    server.registerTool = logged as unknown as typeof server.registerTool;
}

/** Same length or not, compared in the same time. */
function tokenMatches(expected: string, offered: string): boolean {
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(offered, 'utf8');
    return a.length === b.length && timingSafeEqual(a, b);
}

export class AgentControl {
    private http: Server | null = null;
    /** The port actually bound, which is only known once listening has begun. */
    private port = 0;
    private lastError?: string;
    private lastRequestAt?: string;

    constructor(
        private readonly host: AgentHost,
        /** Called whenever the status changes, so the window can show it. */
        private readonly onStatus: () => void,
    ) {
    }

    status(): AgentControlStatus {
        const settings = getSettings().agentControl;
        const running = this.http !== null && this.port !== 0;
        return {
            enabled: settings.enabled,
            running,
            url: running ? `http://127.0.0.1:${this.port}${MCP_PATH}` : '',
            token: settings.token,
            lastError: this.lastError,
            lastRequestAt: this.lastRequestAt,
        };
    }

    /** Bring the listener in line with the settings. Listening starts asynchronously; the status event says when. */
    apply(): AgentControlStatus {
        const settings = getSettings().agentControl;
        if (!settings.enabled) {
            this.stop();
            // A complaint about a port belongs to a server someone wanted running.
            this.lastError = undefined;
            this.onStatus();
            return this.status();
        }
        if (settings.port < 1024 || settings.port > 65_535 || !Number.isInteger(settings.port)) {
            this.stop();
            this.lastError = `Port ${settings.port} is not one this app can listen on. Choose between 1024 and 65535.`;
            this.onStatus();
            return this.status();
        }
        if (this.http && this.port === settings.port) return this.status();

        this.stop();
        // Minted on the way up rather than at install time, so a workspace that
        // never switches this on never holds a credential for it.
        if (!settings.token) {
            saveSettings({
                ...getSettings(),
                agentControl: { ...settings, token: randomBytes(24).toString('hex') },
            });
        }
        this.listen(settings.port);
        return this.status();
    }

    /** A new token, taking the old one out of use. Any agent holding it is cut off. */
    regenerateToken(): AgentControlStatus {
        const settings = getSettings();
        saveSettings({
            ...settings,
            agentControl: { ...settings.agentControl, token: randomBytes(24).toString('hex') },
        });
        log.info('agent', 'Issued a new token; the old one no longer works');
        this.onStatus();
        return this.status();
    }

    stop(): void {
        if (!this.http) return;
        this.http.close();
        // Anything mid-request keeps the process alive otherwise: an agent holding
        // a connection open should not outlive the window it was driving.
        this.http.closeAllConnections();
        this.http = null;
        this.port = 0;
        this.lastError = undefined;
        log.info('agent', 'Stopped listening');
        this.onStatus();
    }

    private listen(port: number): void {
        const http = createServer((req, res) => void this.handle(req, res));
        http.on('error', (error: NodeJS.ErrnoException) => {
            this.http = null;
            this.port = 0;
            this.lastError =
                error.code === 'EADDRINUSE'
                    ? `Port ${port} is already in use on this machine. Choose another one.`
                    : error.message;
            log.error('agent', `Could not listen: ${this.lastError}`);
            this.onStatus();
        });
        http.listen(port, '127.0.0.1', () => {
            this.port = port;
            this.lastError = undefined;
            log.info('agent', `Listening on http://127.0.0.1:${port}${MCP_PATH}`);
            this.onStatus();
        });
        this.http = http;
    }

    /** A local browser page can post to loopback, but cannot forge `Host` or drop `Origin`. */
    private fromThisApp(req: IncomingMessage): boolean {
        if (!LOOPBACK.includes(req.socket.remoteAddress ?? '')) return false;
        const hosts = [`127.0.0.1:${this.port}`, `localhost:${this.port}`, `[::1]:${this.port}`];
        if (!hosts.includes((req.headers.host ?? '').toLowerCase())) return false;
        const origin = req.headers.origin;
        return origin === undefined || hosts.some((host) => origin === `http://${host}`);
    }

    private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
        this.lastRequestAt = new Date().toISOString();
        const { token } = getSettings().agentControl;
        const path = (req.url ?? '/').split('?')[0];
        // A refusal is the one outcome the agent sees and the person does not, so
        // the console gets it too.
        const refuse = (status: number, message: string): void => {
            const { host = '(none)', origin = '(none)' } = req.headers;
            log.warn('agent', `Refused ${req.method ?? 'a request'} ${path} (${status}): ${message}`, {
                detail: `from ${req.socket.remoteAddress ?? 'unknown'} · Host ${host} · Origin ${origin}`,
            });
            deny(res, status, message);
        };

        if (!this.fromThisApp(req)) {
            refuse(403, 'Patchbay answers requests from this machine only.');
        } else if (path !== MCP_PATH) {
            refuse(404, `Nothing here. Patchbay's MCP endpoint is ${MCP_PATH}.`);
        } else if (!token || !tokenMatches(token, /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '')) {
            refuse(401, 'Missing or wrong token. Settings → Agent control shows the one this install expects.');
        } else {
            await this.serve(req, res);
        }
        this.onStatus();
    }

    private async serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const server = new McpServer(
            { name: SERVER_NAME, version: app.getVersion() },
            { instructions: INSTRUCTIONS },
        );
        logToolCalls(server);
        registerAgentTools(server, this.host);

        const transport = new StreamableHTTPServerTransport({
            // Stateless: every request carries what it needs, so restarting the app
            // does not strand a session, and two agents do not share one.
            sessionIdGenerator: undefined,
            enableJsonResponse: true,
        });
        res.on('close', () => {
            void transport.close();
            void server.close();
        });

        try {
            await server.connect(transport);
            await transport.handleRequest(req, res);
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            this.lastError = message;
            log.error('agent', `A request failed: ${message}`);
            if (!res.headersSent) deny(res, 500, message);
            else res.end();
        }
    }
}
