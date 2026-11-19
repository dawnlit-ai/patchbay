/**
 * Smoke test for the agent-control MCP server, under Electron against throwaway
 * app data and workspaces in the temp folder. Calls neither Outlook nor Claude,
 * so it is free to run.
 *
 *   npm run mcpcheck
 */
import { app } from 'electron';
import {
    chmodSync,
    copyFileSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    renameSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { crc32, inflateRawSync } from 'node:zlib';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type {
    DraftOutcome,
    FlowNode,
    MoveEmailOutcome,
    SendOutcome,
    SwitchConfig,
    SwitchOutcome
} from '../src/shared/flow';
import type { WorkspaceChange } from '../src/shared/ipc';
import type { EngineStatus } from '../src/shared/settings';
import type { EmailEnvelope } from '../src/shared/trace';

/** Not the default port: a check should not fight the app if it is running. */
const PORT = 8799;
const TOKEN = 'mcpcheck-token';

const data = mkdtempSync(join(tmpdir(), 'patchbay-mcpcheck-'));
app.setPath('userData', data);
// Its own name, so the key the values set for servers are sealed with is its own
// Keychain item ("Patchbay mcpcheck Safe Storage"), not the app's.
app.setName('Patchbay mcpcheck');

let failures = 0;

function check(what: string, ok: boolean, detail = ''): void {
    if (!ok) failures += 1;
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${what}${detail ? ` — ${detail}` : ''}`);
}

async function main(): Promise<void> {
    // Imported here rather than at the top, so the app data above is already
    // redirected by the time anything resolves a path inside it.
    const {getSettings, saveSettings} = await import('../src/main/store/settingsStore');
    const {AgentControl} = await import('../src/main/mcp/server');
    const {Watcher} = await import('../src/main/engine/watcher');
    const {duplicateFlow, getFlow, importFlowFile, saveFlowFrom, setFlowFileName} = await import(
        '../src/main/store/flowStore'
        );
    const {
        createSkill,
        listSkills,
        locateSkill,
        missingSkills,
        skillTools,
        withoutAllowedTools,
        workspaceSkillPlugin,
    } = await import('../src/main/store/skillStore');
    const {nodeTools} = await import('../src/shared/settings');
    const {stopWatchingFolders, watchFolders} = await import('../src/main/store/folderWatch');
    const {listMcpServers, requireServer, setServerSecret, setServerTrust, usableServers} = await import(
        '../src/main/store/mcpStore'
        );
    const {withToolPath} = await import('../src/main/agents/toolPath');
    const {createReadme, createWorkspace, openWorkspace, readReadme} = await import('../src/main/store/workspaceStore');
    const {exportWorkspace} = await import('../src/main/store/exportStore');

    console.log('app data:', data);
    saveSettings({...getSettings(), agentControl: {enabled: true, port: PORT, token: TOKEN}});

    const watcher = new Watcher(
        () => {
        },
        () => {
        },
    );
    const control = new AgentControl(
        {
            watcher: () => watcher,
            changed: () => {
            },
        },
        () => {
        },
    );

    control.apply();
    for (let i = 0; i < 50 && !control.status().running; i++) await new Promise((r) => setTimeout(r, 100));
    const status = control.status();
    check('listening', status.running, status.lastError ?? status.url);
    if (!status.running) throw new Error('nothing to test against');

    const refused = await fetch(status.url, {
        method: 'POST',
        headers: {'content-type': 'application/json', authorization: 'Bearer wrong'},
        body: '{}',
    });
    check('a wrong token is refused', refused.status === 401, `HTTP ${refused.status}`);

    const client = new Client({name: 'mcpcheck', version: '1.0.0'});
    await client.connect(
        new StreamableHTTPClientTransport(new URL(status.url), {
            requestInit: {headers: {authorization: `Bearer ${TOKEN}`}},
        }),
    );

    const {tools} = await client.listTools();
    check(`${tools.length} tools listed`, tools.length > 0);
    check('the status names the agent that called', control.status().lastRequestBy === 'mcpcheck');

    /** Calls a tool and returns its text, failing the check if it errored. */
    const call = async (name: string, args: Record<string, unknown> = {}): Promise<string> => {
        const result = await client.callTool({name, arguments: args});
        const text = (result.content as { type: string; text?: string }[])
            .map((part) => part.text ?? `[${part.type}]`)
            .join('\n');
        check(name, result.isError !== true, result.isError ? text.slice(0, 200) : '');
        return text;
    };

    const none = await client.callTool({name: 'list_flows', arguments: {}});
    check(
        'with no workspace open, a tool says so',
        none.isError === true && JSON.stringify(none.content).includes('No workspace is open'),
    );

    // A new workspace is a folder of its own in the location, with a flows folder
    // and a starter skill, and becomes the open one.
    const home = mkdtempSync(join(tmpdir(), 'patchbay-mcpcheck-home-'));
    const root = createWorkspace('Checked workspace', home).path;
    console.log('workspace:', root);
    check(
        'a new workspace gets a folder named after it, a flows folder and a starter skill',
        root === join(home, 'checked-workspace') &&
        existsSync(join(root, 'flows')) &&
        existsSync(join(root, 'skills', 'summarize-and-file', 'SKILL.md')),
    );
    check('a second of the same name is numbered past it', createWorkspace('Checked workspace', home).path === join(home, 'checked-workspace-2'));
    openWorkspace(root);
    check('get_workspace names the one open', (JSON.parse(await call('get_workspace')) as {
        path: string
    }).path === root);

    const flowId = (JSON.parse(await call('create_flow', {name: 'Wired by an agent'})) as { id: string }).id;
    check(
        'a new flow is a file in the workspace’s flows folder, named after it',
        (JSON.parse(await call('list_flows')) as { id: string; file: string }[]).find((f) => f.id === flowId)?.file ===
        join(root, 'flows', 'wired-by-an-agent.json'),
    );
    const idOf = async (kind: string, name?: string): Promise<string> =>
        (JSON.parse(await call('add_node', {flowId, kind, ...(name ? {name} : {})})) as { id: string }).id;

    const trigger = await idOf('trigger.outlook', 'Invoices');
    const sorter = await idOf('categorizer');
    const done = await idOf('terminal');

    // A patch of two real fields and one of the wrong type: the good ones stick,
    // and the bad one falls back to its default rather than reaching a run.
    const patched = await call('update_node', {
        flowId,
        nodeId: sorter,
        name: 'Sort',
        config: {
            categories: [
                {id: 'invoice', label: 'Invoice', description: 'A supplier invoice asking to be paid.'},
                {id: 'support', label: 'Support', description: 'A customer asking for help with an order.'},
            ],
            bodyMaxChars: 'not a number',
        },
    });
    check('a bad value falls back to its default', patched.includes('"bodyMaxChars": 8000'));

    const ending = await call('update_node', {
        flowId,
        nodeId: done,
        config: {disposition: 'needs-review'},
    });
    check('a terminal records its disposition', ending.includes('"disposition": "needs-review"'));

    const step = await call('add_node', {flowId, kind: 'processor'});
    check(
        'a new processor starts with no server tools, no folders and no shell',
        step.includes('"mcpTools": []') && step.includes('"folders": []') && step.includes('"allowShell": false') &&
        !step.includes('filesAnywhere'),
    );
    const widened = await call('update_node', {
        flowId,
        nodeId: (JSON.parse(step) as { id: string }).id,
        config: {mcpTools: 'mcp__everything'},
    });
    check('a tool list of the wrong type narrows to nothing', widened.includes('"mcpTools": []'));

    const pull = await call('add_node', {flowId, kind: 'extractor'});
    const puller = (JSON.parse(pull) as { id: string }).id;
    check(
        'a new extractor starts with no skills, inputs or server tools',
        pull.includes('"skills": []') && pull.includes('"inputs": []') && pull.includes('"mcpTools": []'),
    );
    const reading = await call('update_node', {
        flowId,
        nodeId: puller,
        config: {inputs: ['order'], mcpTools: ['mcp__crm__lookup']},
    });
    check(
        'an extractor keeps the slots and server tools it names',
        reading.includes('"order"') && reading.includes('"mcp__crm__lookup"'),
    );

    // An Extractor reading a slot no path fills is flagged, as a Processor is.
    const lone = (JSON.parse(await call('create_flow', {name: 'Extractor reads too much'})) as { id: string }).id;
    const loneTrigger = (JSON.parse(await call('add_node', {flowId: lone, kind: 'trigger.outlook'})) as {
        id: string
    }).id;
    const lonePuller = (JSON.parse(await call('add_node', {flowId: lone, kind: 'extractor'})) as { id: string }).id;
    await call('update_node', {flowId: lone, nodeId: lonePuller, config: {inputs: ['order']}});
    await call('connect', {flowId: lone, from: loneTrigger, port: 'out', to: lonePuller});
    check(
        'an extractor reading a slot no path fills is flagged',
        (await call('get_flow', {flowId: lone})).includes('reads \\"order\\", but not every path here fills it'),
    );
    await call('delete_flow', {flowId: lone});

    await call('connect', {flowId, from: trigger, port: 'out', to: sorter});
    await call('connect', {flowId, from: sorter, port: 'cat:invoice', to: done});

    const wrongPort = await client.callTool({
        name: 'connect',
        arguments: {flowId, from: trigger, port: 'nonsense', to: done},
    });
    check('a port that does not exist is refused', wrongPort.isError === true);

    // Dropping the category takes the edge that left its port with it.
    const dropped = await call('update_node', {
        flowId,
        nodeId: sorter,
        config: {categories: [{id: 'support', label: 'Support', description: 'A request for help.'}]},
    });
    check('an edge left hanging is dropped and reported', dropped.includes('"droppedEdges": 1'));

    // A schema named once is the workspace's: a file in its schemas folder, which a
    // node in any flow can pick, and which a rename carries through every flow
    // naming it.
    const schemaFile = (name: string): string => join(root, 'schemas', `${name}.json`);
    const fileOf = async (id: string): Promise<string> =>
        readFileSync(
            (JSON.parse(await call('list_flows')) as {
                id: string;
                file: string
            }[]).find((f) => f.id === id)?.file ?? '',
            'utf8',
        );
    const settingsShape = {type: 'object', properties: {output_dir: {type: 'string'}}, required: ['output_dir']};
    await call('set_schema', {name: 'Settings', schema: settingsShape});
    await call('set_schema', {
        name: 'Shipment',
        schema: {
            type: 'object',
            properties: {bl_no: {type: 'string'}, settings: {$ref: '#/schemas/Settings', description: 'Its own.'}},
            required: ['bl_no', 'settings'],
        },
    });
    check(
        'a named schema is a file in the workspace’s schemas folder',
        existsSync(schemaFile('Settings')) && existsSync(schemaFile('Shipment')),
    );
    const shipmentRef = {$ref: '#/schemas/Shipment'};
    await call('update_node', {flowId, nodeId: puller, config: {schema: shipmentRef}});
    const sharer = (JSON.parse(await call('create_flow', {name: 'Shares a schema'})) as { id: string }).id;
    const secondIn = (JSON.parse(await call('add_node', {flowId: sharer, kind: 'trigger.outlook'})) as {
        id: string
    }).id;
    const secondPuller = (JSON.parse(await call('add_node', {flowId: sharer, kind: 'extractor'})) as { id: string }).id;
    await call('update_node', {flowId: sharer, nodeId: secondPuller, config: {schema: shipmentRef}});
    await call('connect', {flowId: sharer, from: secondIn, port: 'out', to: secondPuller});
    const usedBy = (listing: string, name: string): number | undefined =>
        (JSON.parse(listing) as { name: string; usedBy: unknown[] }[]).find((s) => s.name === name)?.usedBy.length;
    const listing = await call('list_schemas');
    check(
        'a node in any flow can use one, and through it the schemas it holds',
        usedBy(listing, 'Shipment') === 2 && usedBy(listing, 'Settings') === 2,
    );
    check('and the flow is fine with it', !(await call('get_flow', {flowId: sharer})).includes('cannot be used'));
    const caseOnly = await client.callTool({name: 'set_schema', arguments: {name: 'shipment', schema: settingsShape}});
    check('a name that differs only in case is refused', caseOnly.isError === true);
    await call('rename_schema', {name: 'Settings', to: 'Config'});
    check(
        'renaming one renames its file, and the schemas holding it follow',
        !existsSync(schemaFile('Settings')) && readFileSync(schemaFile('Shipment'), 'utf8').includes('#/schemas/Config'),
    );
    await call('rename_schema', {name: 'Shipment', to: 'Cargo'});
    check(
        'and so does every flow naming it',
        (await fileOf(flowId)).includes('#/schemas/Cargo') &&
        (await fileOf(sharer)).includes('#/schemas/Cargo') &&
        !(await fileOf(sharer)).includes('#/schemas/Shipment'),
    );
    // No node keeps a schema of its own, so there is nowhere a copy of a deleted one
    // could go: deleting one is refused while anything names it.
    const refusal = async (name: string): Promise<string | null> => {
        const result = await client.callTool({name: 'delete_schema', arguments: {name}});
        return result.isError === true ? JSON.stringify(result.content) : null;
    };
    const heldBy = await refusal('Config');
    check(
        'a schema another is built from is not deleted, and the refusal names it',
        heldBy !== null && heldBy.includes('the schema Cargo') && existsSync(schemaFile('Config')),
    );
    const namedBy = await refusal('Cargo');
    check(
        'nor one a node names, and the refusal names the flow and the node',
        namedBy !== null && namedBy.includes('Shares a schema') && existsSync(schemaFile('Cargo')),
    );
    await call('update_node', {flowId: sharer, nodeId: secondPuller, config: {schema: {}}});
    await call('update_node', {flowId, nodeId: puller, config: {schema: {}}});
    await call('delete_schema', {name: 'Cargo'});
    await call('delete_schema', {name: 'Config'});
    check('once nothing names it, it goes', !existsSync(schemaFile('Cargo')) && !existsSync(schemaFile('Config')));
    check(
        'a node naming no schema is flagged',
        (await call('get_flow', {flowId: sharer})).includes('has no schema yet'),
    );
    const ownShape = await client.callTool({
        name: 'update_node',
        arguments: {flowId: sharer, nodeId: secondPuller, config: {schema: settingsShape}},
    });
    check(
        'an agent cannot give a node a schema of its own',
        ownShape.isError === true && JSON.stringify(ownShape.content).includes('never holds a schema of its own'),
    );
    await call('update_node', {flowId: sharer, nodeId: secondPuller, config: {schema: {$ref: '#/schemas/Nope'}}});
    check(
        'a node naming a schema the workspace lacks is flagged',
        (await call('get_flow', {flowId: sharer})).includes('the workspace has no schema \\"Nope\\"'),
    );
    await call('delete_flow', {flowId: sharer});

    await call('write_skill', {
        name: 'check-skill',
        content: '---\nname: check-skill\ndescription: A skill written over MCP.\n---\n\nDo the thing.\n',
    });
    check(
        'the skill is in the workspace’s library',
        (await call('list_skills')).includes('check-skill') && existsSync(join(root, 'skills', 'check-skill', 'SKILL.md')),
    );

    // A skill is a folder, not a file: what sits beside SKILL.md has to come too.
    const shelf = mkdtempSync(join(tmpdir(), 'patchbay-mcpcheck-skills-'));
    for (const name of ['alpha', 'beta']) {
        mkdirSync(join(shelf, name, 'references'), {recursive: true});
        writeFileSync(
            join(shelf, name, 'SKILL.md'),
            `---\nname: ${name}\ndescription: Imported over MCP.\n---\n\nRead references/notes.md.\n`,
        );
        writeFileSync(join(shelf, name, 'references', 'notes.md'), 'A file beside the SKILL.md.\n');
    }
    const imported = JSON.parse(await call('import_skills', {dir: shelf, names: ['alpha', 'nope']})) as {
        imported: string[];
        notFound?: string[];
    };
    check(
        'only the named skill is imported, and a missing one is named',
        imported.imported.join() === 'alpha' && imported.notFound?.join() === 'nope',
    );
    check(
        'the files beside SKILL.md come with it',
        existsSync(join(root, 'skills', 'alpha', 'references', 'notes.md')),
    );
    const itself = await client.callTool({name: 'import_skills', arguments: {dir: join(shelf, 'alpha')}});
    check('a skill folder passed as the shelf is refused', itself.isError === true);
    const relative = await client.callTool({name: 'import_skills', arguments: {dir: 'skills'}});
    check('a relative folder is refused', relative.isError === true);

    // Every flow ticks the one library by name.
    const worker = await idOf('processor');
    await call('update_node', {flowId, nodeId: worker, config: {skills: ['alpha']}});
    const other = (JSON.parse(await call('create_flow', {name: 'Also ticks alpha'})) as { id: string }).id;
    const otherWorker = (JSON.parse(await call('add_node', {flowId: other, kind: 'processor'})) as { id: string }).id;
    await call('update_node', {flowId: other, nodeId: otherWorker, config: {skills: ['alpha']}});
    const gone = await call('delete_skill', {name: 'alpha'});
    check(
        'deleting a skill names every flow still ticking it',
        gone.includes('Wired by an agent') && gone.includes('Also ticks alpha'),
        gone,
    );
    await call('delete_flow', {flowId: other});
    await call('import_skills', {dir: shelf, names: ['alpha']});

    // A run gets a copy of every skill in the workspace, whatever its node ticks, as a plugin.
    const plugin = workspaceSkillPlugin();
    const everySkill = listSkills().map((s) => s.name);
    check(
        'a run gets every skill in the workspace, folder and all, as a plugin',
        plugin !== null &&
        existsSync(join(plugin.path, '.claude-plugin', 'plugin.json')) &&
        existsSync(join(plugin.path, 'skills', 'alpha', 'references', 'notes.md')) &&
        everySkill.every((name) => existsSync(join(plugin.path, 'skills', name, 'SKILL.md'))) &&
        JSON.stringify(plugin.names) === JSON.stringify(everySkill) &&
        readdirSync(join(plugin.path, 'skills')).length === everySkill.length,
        plugin?.names.join(', '),
    );
    if (!plugin) throw new Error('no plugin to check');
    plugin.dispose();
    check(
        'the run’s copy goes, and the library stays',
        !existsSync(plugin.path) && existsSync(join(root, 'skills', 'alpha', 'SKILL.md')),
    );

    // A skill's allowed-tools hand a node that ticks it the workspace server tools named there, and nothing else.
    const same = (a: string[], b: string[]): boolean => JSON.stringify(a) === JSON.stringify(b);
    const inline = skillTools(
        '---\nname: x\nallowed-tools: mcp__crm__lookup, mcp__crm__log Bash(git add:*), Read\ndescription: d\n---\n',
    );
    check(
        'allowed-tools on one line grants its server tools, and leaves built-in ones out whole',
        same(inline.tools, ['mcp__crm__lookup', 'mcp__crm__log']) && same(inline.ungranted, ['Bash(git add:*)', 'Read']),
        JSON.stringify(inline),
    );
    const asList =
        '---\r\nname: x\r\nallowed-tools:\r\n  - "mcp__crm__*"\r\n\r\n  - mcp__email__read_email\r\ndescription: after\r\n---\r\nBody.\r\n';
    const fromList = skillTools(asList);
    check(
        'allowed-tools as a list grants a whole server for `__*`, and never the email’s own tools',
        same(fromList.tools, ['mcp__crm']) && same(fromList.ungranted, ['mcp__email__read_email']),
        JSON.stringify(fromList),
    );
    check(
        'allowed-tools in brackets is read as a list',
        same(skillTools('---\nallowed-tools: [mcp__a__x mcp__a__y]\n---\n').tools, ['mcp__a__x', 'mcp__a__y']),
    );
    check(
        'a skill with no allowed-tools grants nothing',
        same(skillTools('---\nname: x\ndescription: d\n---\n').tools, []),
    );
    check(
        'taking allowed-tools out keeps the rest of the file, line endings and all',
        withoutAllowedTools(asList) === '---\r\nname: x\r\ndescription: after\r\n---\r\nBody.\r\n',
        JSON.stringify(withoutAllowedTools(asList)),
    );
    const plain = '---\nname: x\ndescription: d\n---\nallowed-tools: in the body\n';
    check('a skill with none is left as it is, body and all', withoutAllowedTools(plain) === plain);

    createSkill(
        'granting',
        '---\nname: granting\ndescription: Grants.\nallowed-tools: mcp__crm__lookup, WebFetch\n---\n\nLook it up.\n',
    );
    const granting = listSkills().find((s) => s.name === 'granting');
    check(
        'the library lists what a skill grants, and what it names but does not',
        same(granting?.tools ?? [], ['mcp__crm__lookup']) && same(granting?.ungranted ?? [], ['WebFetch']),
        JSON.stringify(granting),
    );
    const library = listSkills();
    check(
        'a node is handed its own ticks and what its ticked skills grant, each once',
        same(nodeTools({skills: ['granting'], mcpTools: ['mcp__crm__log', 'mcp__crm__lookup']}, library), [
            'mcp__crm__log',
            'mcp__crm__lookup',
        ]) && same(nodeTools({skills: ['alpha', 'granting'], mcpTools: []}, library), ['mcp__crm__lookup']),
    );
    check(
        'a skill the node does not tick grants it nothing',
        same(nodeTools({skills: ['alpha'], mcpTools: []}, library), []),
    );
    const granted = workspaceSkillPlugin();
    const copied = granted ? readFileSync(join(granted.path, 'skills', 'granting', 'SKILL.md'), 'utf8') : '';
    granted?.dispose();
    check(
        'the run’s copy has no allowed-tools for the agent to grant itself, and the library keeps it',
        copied.includes('description: Grants.') &&
        !copied.includes('allowed-tools') &&
        readFileSync(join(root, 'skills', 'granting', 'SKILL.md'), 'utf8').includes('allowed-tools'),
        JSON.stringify(copied),
    );
    await call('delete_skill', {name: 'granting'});

    // Under Electron, rmSync follows a junction and empties its target.
    const outside = mkdtempSync(join(tmpdir(), 'patchbay-mcpcheck-outside-'));
    writeFileSync(join(outside, 'keep.md'), 'Not the skill’s to delete.\n');
    await call('write_skill', {name: 'zeta', content: '---\nname: zeta\ndescription: Linked.\n---\n'});
    symlinkSync(outside, join(root, 'skills', 'zeta', 'shared'), 'junction');
    await call('delete_skill', {name: 'zeta'});
    check(
        'deleting a skill removes a link inside it, not what it points at',
        !existsSync(join(root, 'skills', 'zeta')) && existsSync(join(outside, 'keep.md')),
    );

    // Skills are edited and deleted in other apps while this one runs. The library
    // is watched, but not the rest of the workspace, and what went is refused by
    // name, not failed on.
    let heard = 0;
    let lastHeard: WorkspaceChange | null = null;
    watchFolders((change) => {
        heard += 1;
        lastHeard = change;
    });
    const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
    const heardAfter = async (act: () => void): Promise<boolean> => {
        await pause(500);
        const before = heard;
        act();
        for (let i = 0; i < 30 && heard === before; i++) await pause(100);
        return heard > before;
    };
    check(
        'a skill saved in the library is heard',
        await heardAfter(() =>
            writeFileSync(join(root, 'skills', 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: Saved elsewhere.\n---\n'),
        ),
    );
    check(
        'a file elsewhere in the workspace is not',
        !(await heardAfter(() => writeFileSync(join(root, 'scratch.txt'), 'Not a skill.\n'))),
    );
    check(
        'a skill deleted in the library is heard',
        await heardAfter(() => rmSync(join(root, 'skills', 'check-skill'), {recursive: true})),
    );
    // So are schemas, and what is heard says which.
    check(
        'a schema saved in its folder is heard, as a schema',
        (await heardAfter(() => writeFileSync(schemaFile('Kept'), JSON.stringify({type: 'object', properties: {}})))) &&
        (lastHeard as WorkspaceChange | null)?.schemas === true,
    );
    // And the files other tools keep MCP servers in, at the top of the workspace
    // or in a folder of theirs that did not exist when watching began.
    check(
        'a .mcp.json saved at the top of the workspace is heard, as MCP',
        (await heardAfter(() => writeFileSync(join(root, '.mcp.json'), '{"mcpServers": {}}\n'))) &&
        (lastHeard as WorkspaceChange | null)?.mcp === true,
    );
    mkdirSync(join(root, '.vscode'));
    check(
        'and a .vscode/mcp.json, in a folder made after watching began',
        await heardAfter(() => writeFileSync(join(root, '.vscode', 'mcp.json'), '{"servers": {}}\n')),
    );
    stopWatchingFolders();
    rmSync(join(root, '.mcp.json'));
    rmSync(join(root, '.vscode'), {recursive: true});
    let refusedByName = '';
    try {
        locateSkill('check-skill');
    } catch (e) {
        refusedByName = (e as Error).message;
    }
    check('opening a skill deleted elsewhere is refused by name', refusedByName.includes('“check-skill” is no longer'));
    check(
        'a tick naming a skill deleted elsewhere is found',
        missingSkills(['alpha', 'check-skill']).join() === 'check-skill',
    );
    mkdirSync(join(root, 'skills', 'hollow', 'SKILL.md'), {recursive: true});
    let listed: string[] = [];
    try {
        listed = listSkills().map((s) => s.name);
    } catch {
        // Checked below.
    }
    check('a skill that cannot be read is left out of the list, not failing it', listed.includes('alpha') && !listed.includes('hollow'));
    let replaced = true;
    try {
        createSkill('alpha', '---\nname: alpha\ndescription: Would replace.\n---\n');
    } catch {
        replaced = false;
    }
    check(
        'creating a skill does not replace one of that name',
        !replaced && readFileSync(join(root, 'skills', 'alpha', 'SKILL.md'), 'utf8').includes('Saved elsewhere.'),
    );

    // A run has an id from the moment it is queued. A trigger wired to nothing
    // ends its path at once, so these runs touch neither Outlook nor Claude; two
    // of one flow queued together means the second waits for the first.
    const lane = (JSON.parse(await call('create_flow', {name: 'Queue check'})) as { id: string }).id;
    const start = (JSON.parse(await call('add_node', {flowId: lane, kind: 'trigger.outlook'})) as { id: string }).id;
    const email = {
        ref: {entryId: 'mcpcheck', storeId: 'mcpcheck', account: 'check@example.com', folderPath: ''},
        subject: 'Queue check',
        senderName: 'mcpcheck',
        senderEmail: 'check@example.com',
        receivedTime: new Date().toISOString(),
        bodyPreview: '',
        attachmentNames: [],
    };
    const first = watcher.enqueueManual(lane, start, email);
    const second = watcher.enqueueManual(lane, start, email);
    check(
        'a run behind another of its flow is queued, and says why',
        watcher.queued().find((q) => q.runId === second)?.waitingFor.includes('this flow') === true,
    );
    let refusedMidRun = false;
    try {
        watcher.clearForRemoval(lane);
    } catch {
        refusedMidRun = true;
    }
    check('a flow is not cleared for deleting while a run of it is under way', refusedMidRun);
    check('a queued run can be cancelled', watcher.cancel(second) === 'dequeued' && watcher.queued().length === 0);
    check('cancelling it again finds nothing', watcher.cancel(second) === 'unknown');
    for (let i = 0; i < 50 && watcher.status().activeRunIds.length > 0; i++) {
        await new Promise((r) => setTimeout(r, 50));
    }
    check('the run ahead of it still ran', (await call('get_run', {runId: first})).includes('"status": "completed"'));
    check('list_runs has it', (await call('list_runs', {flowId: lane})).includes(first));
    check(
        'cancel_run says when there is nothing to cancel',
        (await call('cancel_run', {runId: second})).includes('Nothing to cancel'),
    );

    // A step whose skill was deleted since it was ticked stops at its error port,
    // naming the skill, before Claude is asked anything.
    const stranded = (JSON.parse(await call('create_flow', {name: 'Lost skill check'})) as { id: string }).id;
    const inbox = (JSON.parse(await call('add_node', {flowId: stranded, kind: 'trigger.outlook'})) as {
        id: string
    }).id;
    const orphan = (JSON.parse(await call('add_node', {flowId: stranded, kind: 'processor'})) as { id: string }).id;
    await call('update_node', {flowId: stranded, nodeId: orphan, config: {skills: ['check-skill']}});
    await call('connect', {flowId: stranded, from: inbox, port: 'out', to: orphan});
    const lostRun = watcher.enqueueManual(stranded, inbox, email);
    for (let i = 0; i < 50 && watcher.status().activeRunIds.length > 0; i++) {
        await new Promise((r) => setTimeout(r, 50));
    }
    const lostTrace = await call('get_run', {runId: lostRun});
    check(
        'a step ticking a skill deleted since leaves by its error port, naming it',
        lostTrace.includes('“check-skill” is ticked but no longer in the workspace'),
    );
    await call('delete_flow', {flowId: stranded});

    // A canvas saves against the version it last read. Its own saves move that
    // on; anyone else's write means its edit was made to a flow no longer there.
    const loaded = getFlow(lane);
    if (!loaded) throw new Error('the queue check flow is missing');
    const once = saveFlowFrom('canvas', {...loaded, name: 'Edited once'});
    const twice = saveFlowFrom('canvas', {...loaded, name: 'Edited twice'});
    check('a canvas saving twice from one read is not refused by its own save', 'saved' in once && 'saved' in twice);
    await call('rename_flow', {flowId: lane, name: 'Renamed by an agent'});
    const overtaken = saveFlowFrom('canvas', {...loaded, name: 'Edited a third time'});
    check(
        'a canvas edit made before an agent’s write is refused, and handed what is there',
        'current' in overtaken && overtaken.current?.name === 'Renamed by an agent',
    );
    check('the agent’s write stands', getFlow(lane)?.name === 'Renamed by an agent');
    const reread = getFlow(lane);
    check(
        'an edit to the flow as it now stands is saved',
        reread !== null && 'saved' in saveFlowFrom('canvas', {...reread, name: 'Edited after reading'}),
    );
    const laneFile = join(root, 'flows', 'queue-check.json');
    check('a renamed flow keeps its file', existsSync(laneFile));
    await call('delete_flow', {flowId: lane});
    const late = reread ? saveFlowFrom('canvas', {...reread, name: 'Too late'}) : null;
    // What a canvas still showing the flow does next: refresh its skill list.
    listSkills();
    check(
        'a save to a deleted flow, or a look at the skills, does not bring it back',
        late !== null && 'current' in late && late.current === null && getFlow(lane) === null && !existsSync(laneFile),
    );

    // A flow file written by hand, with no updatedAt: each read is the same
    // version, so a canvas edit to it is saved rather than refused as overtaken.
    const byHandFile = join(root, 'flows', 'by-hand.json');
    writeFileSync(byHandFile, JSON.stringify({id: 'by-hand', name: 'By hand', nodes: [], edges: []}));
    const firstRead = getFlow('by-hand');
    await new Promise((r) => setTimeout(r, 20));
    const secondRead = getFlow('by-hand');
    check(
        'a flow file with no updatedAt reads as the same version each time',
        firstRead !== null && firstRead.updatedAt === secondRead?.updatedAt,
    );
    const byHandSave = firstRead ? saveFlowFrom('canvas', {...firstRead, name: 'Edited on the canvas'}) : null;
    check(
        'and a canvas edit to it is saved',
        byHandSave !== null && 'saved' in byHandSave && getFlow('by-hand')?.name === 'Edited on the canvas',
    );
    rmSync(byHandFile);

    // A flow file from elsewhere is copied in, as a file of its own named after the flow.
    const elsewhere = mkdtempSync(join(tmpdir(), 'patchbay-mcpcheck-elsewhere-'));
    const sent = join(elsewhere, 'sent.json');
    writeFileSync(
        sent,
        JSON.stringify({
            name: 'Sent over',
            nodes: [],
            edges: [],
        }),
    );
    const brought = importFlowFile(sent);
    const sentOver = join(root, 'flows', 'sent-over.json');
    check('an imported flow is copied into flows, named after it', existsSync(sentOver) && getFlow(brought.id)?.name === 'Sent over');
    check('and the file it came from is left as it was', !('id' in (JSON.parse(readFileSync(sent, 'utf8')) as object)));
    check(
        'importing it again is another flow, in a file numbered past the first',
        importFlowFile(sent).id !== brought.id && existsSync(join(root, 'flows', 'sent-over-2.json')),
    );
    const withId = join(elsewhere, 'with-id.json');
    copyFileSync(sentOver, withId);
    check('a file carrying an id this workspace has gets one of its own', importFlowFile(withId).id !== brought.id);
    check('importing a file already listed is that flow', importFlowFile(sentOver).id === brought.id);
    const byHand = join(root, 'flows', 'zz-copied-by-hand.json');
    copyFileSync(sentOver, byHand);
    const adopted = importFlowFile(byHand);
    check(
        'a copy made by hand in flows gets an id of its own, where it is',
        adopted.id !== brought.id &&
        (JSON.parse(readFileSync(byHand, 'utf8')) as { id: string }).id === adopted.id &&
        readdirSync(join(root, 'flows')).length === 5,
        readdirSync(join(root, 'flows')).join(', '),
    );

    // Its file can be renamed, and its id, and so its runs, stay with it.
    setFlowFileName(brought.id, 'Renamed by hand');
    check(
        'renaming a flow’s file keeps its id',
        existsSync(join(root, 'flows', 'renamed-by-hand.json')) && !existsSync(sentOver) && getFlow(brought.id) !== null,
    );
    let clashed = false;
    try {
        setFlowFileName(adopted.id, 'renamed-by-hand');
    } catch {
        clashed = true;
    }
    check('a file name another flow has is refused', clashed);
    const original = getFlow(brought.id);
    const duplicate = original ? duplicateFlow(original, 'Sent over') : null;
    check(
        'a duplicate is a flow of its own, in a file of its own',
        duplicate !== null && duplicate.id !== brought.id && existsSync(sentOver),
    );
    for (const id of [brought.id, adopted.id, duplicate?.id]) if (id) await call('delete_flow', {flowId: id});
    check('deleting flows leaves the skills', existsSync(join(root, 'skills', 'alpha', 'SKILL.md')));
    rmSync(elsewhere, {recursive: true, force: true});

    // One workspace is open at a time, and each has its own flows, skills and runs.
    const away = mkdtempSync(join(tmpdir(), 'patchbay-mcpcheck-away-'));
    openWorkspace(away);
    check(
        'another workspace lists only its own flows, skills and schemas',
        (JSON.parse(await call('list_flows')) as unknown[]).length === 0 &&
        (JSON.parse(await call('list_skills')) as unknown[]).length === 0 &&
        (JSON.parse(await call('list_schemas')) as unknown[]).length === 0,
    );
    check('and only its own runs', !(await call('list_runs', {limit: 50})).includes(first));
    check('a run there gets no skills: none come from the other workspace, or from anywhere else', workspaceSkillPlugin() === null);
    check('and looking writes nothing into its folder', readdirSync(away).length === 0);
    openWorkspace(root);
    check(
        'coming back finds them where they were',
        (await call('list_runs', {limit: 50})).includes(first) && (await call('list_flows')).includes(flowId),
    );
    rmSync(away, {recursive: true, force: true});

    // A README is optional, at the top of the workspace, started from a template, and found in whatever case it is spelled.
    const readmeOf = async (): Promise<string | null> =>
        (JSON.parse(await call('get_workspace')) as { readme: string | null }).readme;
    check('a workspace has no README until one is written', readReadme() === null && (await readmeOf()) === null);
    const readme = createReadme();
    const started = readReadme()?.content ?? '';
    check(
        'a README starts from a template naming the workspace and its flows',
        readme === join(root, 'README.md') &&
        started.startsWith('# checked-workspace\n') &&
        started.includes('**Wired by an agent**'),
    );
    check('get_workspace points an agent at it', (await readmeOf()) === readme);
    let rewritten = false;
    try {
        createReadme();
        rewritten = true;
    } catch {
        // Refused, as it should be.
    }
    check('a second is refused rather than written over the first', !rewritten && readReadme()?.content === started);
    renameSync(readme, join(root, 'readme.md'));
    check('one spelled in lower case is found too', readReadme()?.path === join(root, 'readme.md'));
    renameSync(join(root, 'readme.md'), join(root, 'notes.md'));
    writeFileSync(join(root, 'flows', 'README.md'), '# The flows folder’s own\n');
    check('a README inside the flows folder is not the workspace’s', readReadme() === null);
    rmSync(join(root, 'flows', 'README.md'));

    // An export is a zip of what Patchbay reads in the workspace, .patchbay/export in place of its namesakes, and the
    // files a server it hands out starts — not the rest of a folder that may be a whole repository.
    const shared = createWorkspace('Shared out', home).path;
    const put = (path: string, text: string): void => {
        mkdirSync(join(shared, dirname(path)), {recursive: true});
        writeFileSync(join(shared, path), text);
    };
    put('flows/inbox.json', '{"id": "inbox"}\n');
    put('flows/.DS_Store', 'the Finder’s');
    put('skills/triage/SKILL.md', '---\nname: triage\ndescription: Sorts tickets.\n---\n');
    put('skills/triage/scripts/run.sh', '#!/bin/sh\necho sorted\n');
    if (process.platform !== 'win32') chmodSync(join(shared, 'skills/triage/scripts/run.sh'), 0o755);
    put('schemas/Ticket.json', '{"type": "object"}\n');
    put('README.md', '# For us\n');
    put('.mcp.json', JSON.stringify({
        mcpServers: {
            tickets: {
                command: 'node',
                args: ['--import', 'tsx', 'src/server.ts']
            }
        }
    }));
    put('src/server.ts', 'the source');
    put('node_modules/tsx/index.js', 'a dependency');
    put('notes.txt', 'the repository’s');
    put('config/shared.json', '{}');
    put('.env', 'TOKEN=not-for-them');
    put('.vscode/mcp.json', '{ "servers": { "helper": { "command": "python3", "args": ["tools/helper.py"], }, }, }\n');
    put('.vscode/settings.json', '{}');
    put('tools/helper.py', 'print("helped")\n');
    const handedOut = JSON.stringify({
        mcpServers: {
            tickets: {
                command: 'node',
                args: ['launch.cjs', '--config=${workspaceFolder}/config/shared.json', '--env-file=.env', 'node_modules/tsx/index.js'],
            },
        },
    });
    put('.patchbay/export/.mcp.json', handedOut);
    put('.patchbay/export/launch.cjs', 'require(installedCopy);\n');
    put('.patchbay/export/Readme.md', '# For them\n');

    /** Each file in a zip, by name, read back through its central directory and checked against its CRC. */
    const unzipped = (file: string): Map<string, { data: Buffer; mode: number }> => {
        const bytes = readFileSync(file);
        const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
        const files = new Map<string, { data: Buffer; mode: number }>();
        let at = bytes.readUInt32LE(end + 16);
        for (let i = 0; i < bytes.readUInt16LE(end + 10); i++) {
            if (bytes.readUInt32LE(at) !== 0x02014b50) throw new Error(`no directory entry at ${at}`);
            const nameLength = bytes.readUInt16LE(at + 28);
            const name = bytes.toString('utf8', at + 46, at + 46 + nameLength);
            const local = bytes.readUInt32LE(at + 42);
            const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
            const body = bytes.subarray(start, start + bytes.readUInt32LE(at + 20));
            const data = bytes.readUInt16LE(at + 10) === 8 ? inflateRawSync(body) : Buffer.from(body);
            if (crc32(data) !== bytes.readUInt32LE(at + 16) || data.length !== bytes.readUInt32LE(at + 24)) {
                throw new Error(`${name} does not read back as written`);
            }
            files.set(name, {data, mode: bytes.readUInt32LE(at + 38) >>> 16});
            at += 46 + nameLength + bytes.readUInt16LE(at + 30) + bytes.readUInt16LE(at + 32);
        }
        return files;
    };
    const exported = exportWorkspace(join(home, 'shared-out.zip'));
    const inZip = unzipped(exported);
    const names = [...inZip.keys()];
    const text = (path: string): string | undefined => inZip.get(`shared-out/${path}`)?.data.toString('utf8');
    check(
        'an export is a zip of one folder named after the workspace’s, every file reading back as it was',
        exported === join(home, 'shared-out.zip') &&
        names.every((n) => n.startsWith('shared-out/')) &&
        text('flows/inbox.json') === '{"id": "inbox"}\n',
    );
    check(
        'it holds the flows, skills (with what is beside them), schemas and every MCP server file',
        ['flows/inbox.json', 'skills/triage/SKILL.md', 'skills/triage/scripts/run.sh', 'schemas/Ticket.json', '.vscode/mcp.json']
            .every((path) => text(path) !== undefined),
    );
    check(
        'a file in .patchbay/export goes in place of its namesake, whatever its case, or beside the rest',
        text('.mcp.json') === handedOut && text('Readme.md') === '# For them\n' && text('README.md') === undefined &&
        text('launch.cjs') === 'require(installedCopy);\n' && !names.some((n) => n.includes('.patchbay')),
    );
    check(
        'a file a server it hands out starts goes too, a flag’s value and ${workspaceFolder} included',
        text('config/shared.json') === '{}' && text('tools/helper.py') === 'print("helped")\n',
    );
    check(
        'but not a .env file, nor one inside node_modules, nor what only the workspace’s own servers start',
        text('.env') === undefined && text('node_modules/tsx/index.js') === undefined && text('src/server.ts') === undefined,
    );
    check(
        'nor the rest of the folder, nor the Finder’s files, nor anything left beside the zip',
        text('notes.txt') === undefined && text('.vscode/settings.json') === undefined &&
        !names.some((n) => n.endsWith('.DS_Store')) &&
        readdirSync(home).every((entry) => !entry.endsWith('.part')),
    );
    if (process.platform !== 'win32') {
        check('a script stays runnable', ((inZip.get('shared-out/skills/triage/scripts/run.sh')?.mode ?? 0) & 0o111) !== 0);
    }
    writeFileSync(join(home, 'shared-out.zip'), 'an older export');
    check('exporting again writes over the last', unzipped(exportWorkspace(join(home, 'shared-out.zip'))).size === inZip.size);
    openWorkspace(root);

    // The console: what the app did outside any one run, this session's and a day's.
    check(
        'the console shows an agent’s calls',
        (await call('get_console', {source: 'agent'})).includes('Called create_flow'),
    );
    const now = new Date();
    const pad = (n: number): string => String(n).padStart(2, '0');
    const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    check(
        'a day’s file reads back',
        (await call('get_console', {day: today, source: 'run'})).includes('Cancelled before it started'),
    );
    const notADay = await client.callTool({name: 'get_console', arguments: {day: 'yesterday'}});
    check('a day that is not a date is refused', notADay.isError === true);

    const settings = await call('get_settings');
    check('the token is withheld', settings.includes('(withheld)') && !settings.includes(TOKEN));

    // Workspace MCP server auto-detection, precedence and trust.
    process.env.PATCHBAY_MCPCHECK_TOKEN = TOKEN;
    writeFileSync(
        join(root, '.mcp.json'),
        JSON.stringify({
            mcpServers: {
                loopback: {
                    type: 'http',
                    url: `http://127.0.0.1:${PORT}/mcp`,
                    headers: {Authorization: 'Bearer ${PATCHBAY_MCPCHECK_TOKEN:-none}'},
                },
                local: {
                    command: 'node',
                    args: ['${workspaceFolder}/server.js', '${PATCHBAY_UNSET_DEFAULT:---ok}'],
                },
                email: {command: 'node', args: ['taken.js']},
                missingEnv: {command: 'node', args: ['${PATCHBAY_NEVER_SET}']},
            },
        }),
    );
    mkdirSync(join(root, '.vscode'), {recursive: true});
    writeFileSync(
        join(root, '.vscode', 'mcp.json'),
        `{
            // VS Code's own shape, with comments and a trailing comma.
            "servers": {
                "local": { "command": "node", "args": ["shadowed.js"], },
                "vscodeOnly": { "command": "npx", "args": ["-y", "some-mcp"], },
            },
        }`,
    );
    const detected = listMcpServers();
    const byName = (name: string) => detected.servers.filter((s) => s.name === name);
    check(
        '.mcp.json and .vscode/mcp.json are both read, including JSONC comments and trailing commas',
        byName('loopback')[0]?.state === 'new' && byName('vscodeOnly')[0]?.state === 'new',
    );
    check(
        '.mcp.json takes precedence over .vscode/mcp.json for the same server name',
        byName('local')[0]?.source === '.mcp.json' &&
        byName('local')[0]?.state === 'new' &&
        byName('local')[1]?.source === '.vscode/mcp.json' &&
        byName('local')[1]?.state === 'shadowed',
    );
    check('reserved server name "email" is flagged as invalid', byName('email')[0]?.state === 'invalid');
    check(
        'a variable with no value leaves the server to be allowed, saying which it is missing',
        byName('missingEnv')[0]?.state === 'new' &&
        JSON.stringify(byName('missingEnv')[0]?.variables) === '[{"name":"PATCHBAY_NEVER_SET","source":"missing"}]',
    );
    check('untrusted workspace servers are not usable until allowed', usableServers().size === 0);
    const beforeTrust = await client.callTool({name: 'list_server_tools', arguments: {server: 'loopback'}});
    check('list_server_tools refuses a workspace server that has not been allowed', beforeTrust.isError === true);

    setServerTrust('loopback', true);
    setServerTrust('local', true);
    const localLaunch = (await requireServer('local')).launch;
    check(
        'allowing a workspace server expands ${workspaceFolder} and ${VAR:-default} and sets cwd to the workspace',
        localLaunch?.type === 'stdio' &&
        localLaunch.args?.[0] === `${root}/server.js` &&
        localLaunch.args?.[1] === '--ok' &&
        localLaunch.cwd === root,
    );
    const loopbackTools = await call('list_server_tools', {server: 'loopback'});
    check(
        'an allowed HTTP workspace server with expanded Authorization header lists its tools',
        loopbackTools.includes('mcp__loopback__list_flows'),
    );

    // Editing .mcp.json invalidates the approval until allowed again.
    writeFileSync(
        join(root, '.mcp.json'),
        JSON.stringify({
            mcpServers: {
                loopback: {type: 'http', url: `http://127.0.0.1:${PORT}/mcp`},
                local: {command: 'node', args: ['different.js']},
            },
        }),
    );
    const afterEdit = listMcpServers();
    check(
        'changing a server command in .mcp.json requires allowing it again',
        afterEdit.servers.find((s) => s.name === 'local' && s.source === '.mcp.json')?.state === 'changed' &&
        !usableServers().has('local'),
    );
    setServerTrust('local', false);
    check(
        'blocking a workspace server records it as blocked',
        listMcpServers().servers.find((s) => s.name === 'local' && s.source === '.mcp.json')?.state === 'blocked',
    );
    const settingsWithWorkspace = await call('get_settings');
    check(
        'get_settings lists workspace MCP servers without exposing header values',
        settingsWithWorkspace.includes('"workspaceMcpServers"') && !settingsWithWorkspace.includes(TOKEN),
    );

    // A ticked server no run can be handed says what stands in its way: a node
    // that ticks it stops at its error port with that.
    const whyRefused = (name: string): Promise<string> =>
        requireServer(name).then(
            () => '',
            (e: unknown) => (e instanceof Error ? e.message : String(e)),
        );
    check('a server defined nowhere is refused by name', (await whyRefused('nowhere')).includes('no MCP server "nowhere"'));
    check('a blocked workspace server is refused as not allowed', (await whyRefused('local')).includes('not allowed'));
    check('one never allowed says it has not been', (await whyRefused('vscodeOnly')).includes('has not been allowed'));

    // The same two as before, so what was decided about them stands, and one more by address.
    writeFileSync(
        join(root, '.mcp.json'),
        JSON.stringify({
            mcpServers: {
                loopback: {type: 'http', url: `http://127.0.0.1:${PORT}/mcp`},
                local: {command: 'node', args: ['different.js']},
                remote: {
                    type: 'http',
                    url: `http://127.0.0.1:${PORT}/mcp`,
                    headers: {Authorization: 'Bearer ${PATCHBAY_MCPCHECK_TOKEN}'},
                },
            },
        }),
    );
    setServerTrust('remote', true);
    const remote = (await requireServer('remote')).launch;
    check(
        'an HTTP workspace server is handed over by address, with its headers filled in',
        remote?.type === 'http' && remote.url.endsWith(`:${PORT}/mcp`) && remote.headers?.Authorization === `Bearer ${TOKEN}`,
    );
    check(
        'and lists its tools',
        (await call('list_server_tools', {server: 'remote'})).includes('mcp__remote__list_flows'),
    );
    const settingsWithHeaders = await call('get_settings');
    check(
        'get_settings names its header but withholds the value',
        settingsWithHeaders.includes('"Authorization"') && !settingsWithHeaders.includes(TOKEN),
    );

    // Settings holds no servers of its own. One an older settings file kept, with
    // the secret in its env, leaves the file, and no run can be handed it.
    const {settingsFile} = await import('../src/main/paths');
    saveSettings({
        ...getSettings(),
        mcpServers: [{name: 'old', command: 'node', args: [], env: {OLD_TOKEN: 'mcpcheck-old-secret'}, enabled: true}],
    } as ReturnType<typeof getSettings>);
    const onDisk = readFileSync(settingsFile(), 'utf8');
    check(
        'a server an older Settings kept is dropped from the file, its env values with it',
        !onDisk.includes('mcpServers') && !onDisk.includes('mcpcheck-old-secret') && !('mcpServers' in getSettings()),
    );
    check('and is not a server a node can be handed', (await whyRefused('old')).includes('no MCP server "old"'));

    // Values set for one server: sealed in the app's data, handed to that server
    // alone, ahead of the environment, and never listed.
    const {mcpSecretsFile} = await import('../src/main/paths');
    delete process.env.PATCHBAY_MCPCHECK_VALUE;
    writeFileSync(
        join(root, '.mcp.json'),
        JSON.stringify({
            mcpServers: {
                sealed: {
                    type: 'http',
                    url: `http://127.0.0.1:${PORT}/mcp`,
                    headers: {Authorization: 'Bearer ${PATCHBAY_MCPCHECK_VALUE}'},
                },
                neighbour: {command: 'node', args: ['n.js', '${PATCHBAY_MCPCHECK_VALUE}']},
            },
        }),
    );
    writeFileSync(
        join(root, '.vscode', 'mcp.json'),
        JSON.stringify({
            inputs: [{type: 'promptString', id: 'api-key', description: 'The CRM key', password: true}],
            servers: {prompted: {command: 'node', args: ['p.js'], env: {KEY: '${input:api-key}'}}},
        }),
    );
    const variablesOf = (name: string) => listMcpServers().servers.find((s) => s.name === name)?.variables ?? [];
    setServerTrust('sealed', true);
    setServerTrust('neighbour', true);
    setServerTrust('prompted', true);
    check(
        'an allowed server missing a value is not usable, and says which value and where to set it',
        !usableServers().has('sealed') &&
        (await whyRefused('sealed')).includes('needs a value for PATCHBAY_MCPCHECK_VALUE') &&
        (await whyRefused('sealed')).includes('MCP tab'),
    );
    check(
        "VS Code's ${input:…} is a value to set, with its description",
        JSON.stringify(variablesOf('prompted')) === '[{"name":"input:api-key","source":"missing","description":"The CRM key"}]',
    );
    const refusedUnused = await setServerSecret('sealed', 'NOT_USED', 'x').then(() => false, () => true);
    check('a value its definition does not look up is refused', refusedUnused);

    await setServerSecret('sealed', 'PATCHBAY_MCPCHECK_VALUE', TOKEN);
    await setServerSecret('prompted', 'input:api-key', 'mcpcheck-crm-key');
    const sealedFile = readFileSync(mcpSecretsFile(), 'utf8');
    check('a value set is sealed: the file in the app data holds none of it', !sealedFile.includes(TOKEN) && !sealedFile.includes('mcpcheck-crm-key'));
    check(
        'the listing says it is set, and nothing more',
        variablesOf('sealed')[0]?.source === 'set' && !JSON.stringify(listMcpServers()).includes(TOKEN),
    );
    const sealed = (await requireServer('sealed')).launch;
    check(
        'starting it opens the value into its header',
        usableServers().has('sealed') && sealed.type === 'http' && sealed.headers?.Authorization === `Bearer ${TOKEN}`,
    );
    check(
        'and a server reached with it lists its tools',
        (await call('list_server_tools', {server: 'sealed'})).includes('mcp__sealed__list_flows'),
    );
    check(
        'a value set for one server is not another’s, though both name it',
        variablesOf('neighbour')[0]?.source === 'missing' && (await whyRefused('neighbour')).includes('needs a value'),
    );
    const prompted = (await requireServer('prompted')).launch;
    check('an ${input:…} is filled from the value set for it', prompted.type === 'stdio' && prompted.env?.KEY === 'mcpcheck-crm-key');
    check('get_settings does not give a value set for a server', !(await call('get_settings')).includes(TOKEN));

    process.env.PATCHBAY_MCPCHECK_VALUE = 'from-the-environment';
    const ahead = (await requireServer('sealed')).launch;
    const neighbour = (await requireServer('neighbour')).launch;
    check(
        'a value set comes before the environment, which fills in the server it was not set for',
        ahead.type === 'http' && ahead.headers?.Authorization === `Bearer ${TOKEN}` &&
        neighbour.type === 'stdio' && neighbour.args?.[1] === 'from-the-environment' &&
        variablesOf('neighbour')[0]?.source === 'environment',
    );
    await setServerSecret('sealed', 'PATCHBAY_MCPCHECK_VALUE', null);
    const cleared = (await requireServer('sealed')).launch;
    check(
        'cleared, it is left to the environment, and leaves the file',
        cleared.type === 'http' && cleared.headers?.Authorization === 'Bearer from-the-environment' &&
        variablesOf('sealed')[0]?.source === 'environment' &&
        !readFileSync(mcpSecretsFile(), 'utf8').includes('"sealed"'),
    );
    delete process.env.PATCHBAY_MCPCHECK_VALUE;

    // Opened from the Finder, the app has launchd's PATH: what starts a server —
    // the listing above, or the agent a run hands it to — gets the folders npx,
    // uvx and node are installed in as well.
    if (process.platform !== 'win32') {
        const launchd = '/usr/bin:/bin:/usr/sbin:/sbin';
        const extended = withToolPath({PATH: launchd, HOME: '/home/check'});
        check(
            'a launchd PATH gains Homebrew’s and ~/.local/bin after its own, the rest of the environment kept',
            extended.PATH?.startsWith(`${launchd}:`) === true &&
            extended.PATH.split(':').includes('/opt/homebrew/bin') &&
            extended.PATH.split(':').includes('/usr/local/bin') &&
            extended.HOME === '/home/check',
        );
        check('and one that has them all is left as it is', withToolPath({PATH: extended.PATH}).PATH === extended.PATH);
    }

    // A Switch decides with no model: each rule is checked on the canvas against
    // the schema of the slot it reads, and the first that matches picks the route.
    const {decideSwitch, parseFlow} = await import('../src/shared/flow');
    await call('set_schema', {
        name: 'Verdict',
        schema: {
            type: 'object',
            properties: {
                reply: {type: 'string', enum: ['quote', 'no-quote', 'offer']},
                seen: {type: 'boolean'},
                answering: {type: 'object', properties: {kind: {type: 'string'}}, required: ['kind']},
            },
            required: ['reply', 'seen', 'answering'],
        },
    });
    const thanks = (JSON.parse(await call('create_flow', {name: 'Thanks by rule'})) as { id: string }).id;
    const addNode = async (kind: string): Promise<{ id: string; text: string }> => {
        const text = await call('add_node', {flowId: thanks, kind});
        return {id: (JSON.parse(text) as { id: string }).id, text};
    };
    const wire = (from: string, port: string, to: string) => call('connect', {flowId: thanks, from, port, to});
    const thanksIn = (await addNode('trigger.outlook')).id;
    const reader = (await addNode('extractor')).id;
    await call('update_node', {
        flowId: thanks,
        nodeId: reader,
        config: {output: 'verdict', schema: {$ref: '#/schemas/Verdict'}},
    });
    const switchAdded = await addNode('switch');
    const switcher = switchAdded.id;
    check(
        'a new switch has a port for each route, and one for otherwise',
        switchAdded.text.includes('"port": "route:a"') && switchAdded.text.includes('"port": "route:b"') &&
        switchAdded.text.includes('"port": "otherwise"'),
    );
    const parked = (await addNode('terminal')).id;
    await wire(thanksIn, 'out', reader);
    await wire(reader, 'valid', switcher);
    await wire(switcher, 'route:a', parked);
    await call('update_node', {
        flowId: thanks,
        nodeId: switcher,
        config: {
            rules: [
                {field: 'verdict.seen', equals: 'yes', route: 'a'},
                {field: 'verdict.replly', equals: 'offer', route: 'a'},
                {field: 'verdict.reply', equals: 'offr', route: 'a'},
                {field: 'verdict.answering', equals: 'thanks', route: 'a'},
                {field: 'order.id', equals: '1', route: 'a'},
                {field: 'verdict.reply', equals: 'quote', route: 'gone'},
            ],
        },
    });
    type Issue = { nodeId: string; severity: string; message: string };
    const issuesOf = async (nodeId: string): Promise<Issue[]> =>
        (JSON.parse(await call('get_flow', {flowId: thanks})) as { slotIssues: Issue[] }).slotIssues.filter(
            (i) => i.nodeId === nodeId,
        );
    const flaggedWith = (issues: Issue[], severity: string, text: string) =>
        issues.some((i) => i.severity === severity && i.message.includes(text));
    const switchIssues = await issuesOf(switcher);
    check('a yes / no compared with anything but true or false is flagged',
        flaggedWith(switchIssues, 'error', 'verdict.seen is "yes", which it never is'));
    check('a field the slot’s schema lacks is flagged',
        flaggedWith(switchIssues, 'error', 'reads verdict.replly, but Verdict has no field replly'));
    check('a value outside a field’s list is flagged',
        flaggedWith(switchIssues, 'error', 'verdict.reply is "offr", which it never is'));
    check('a group compared as one value is flagged',
        flaggedWith(switchIssues, 'error', 'reads verdict.answering, which is a group of fields'));
    check('a slot no path fills is flagged as any read is',
        flaggedWith(switchIssues, 'error', 'reads "order", but not every path here fills it'));
    check('a rule sent down a route the switch lacks is flagged',
        flaggedWith(switchIssues, 'error', 'rule 6 leads nowhere'));
    check('a route no rule leads to is pointed out, but does not stop the flow',
        flaggedWith(switchIssues, 'warning', 'leads to Route B'));

    const rerouted = JSON.parse(
        await call('update_node', {
            flowId: thanks,
            nodeId: switcher,
            config: {
                routes: [
                    {id: 'quote', label: 'Quote'},
                    {id: 'noquote', label: 'No quote'},
                    {id: 'skip', label: 'Skip'},
                ],
                rules: [
                    {field: 'verdict.seen', equals: 'true', route: 'skip'},
                    {field: 'verdict.reply', equals: 'offer', route: 'skip'},
                    {field: 'verdict.answering.kind', equals: 'thanks', route: 'skip'},
                    {field: 'verdict.reply', equals: 'quote', route: 'quote'},
                    {field: 'verdict.reply', equals: 'no-quote', route: 'noquote'},
                ],
                output: 'ack',
            },
        }),
    ) as { node: { config: SwitchConfig; outputs: { port: string }[] }; droppedEdges: number };
    check(
        'renaming its routes moves its ports, and drops the edge left on the old one',
        rerouted.droppedEdges === 1 &&
        rerouted.node.outputs.map((o) => o.port).join(',') === 'route:quote,route:noquote,route:skip,otherwise',
    );
    check('a switch whose rules fit, and whose routes each have one, is not flagged',
        (await issuesOf(switcher)).length === 0);

    const routes = rerouted.node.config;
    const verdict = (reply: string, seen: boolean, kind = 'request') => ({verdict: {reply, seen, answering: {kind}}});
    const routed = (slots: Record<string, unknown>) => decideSwitch(routes, slots);
    check('the first rule that matches picks the route', routed(verdict('quote', true)).port === 'route:skip');
    check('a later rule picks it when the ones above miss', routed(verdict('quote', false)).port === 'route:quote');
    check('several rules can lead to one route', routed(verdict('offer', false)).port === 'route:skip');
    check('a path into a group is followed', routed(verdict('quote', false, 'thanks')).port === 'route:skip');
    const unmatched = routed({});
    check('an email no rule matches leaves by otherwise, saying so',
        unmatched.port === 'otherwise' && unmatched.why === 'no rule matched');

    // A Create email per reply behind it, and the routes meeting again after them.
    const createAdded = await addNode('create-email');
    const quoter = createAdded.id;
    check(
        'a new create email drafts, or finds its draft already made, and fills its slot either way',
        createAdded.text.includes('"port": "drafted"') && createAdded.text.includes('"port": "skipped"') &&
        createAdded.text.includes('"output": "draft"'),
    );
    const noQuoter = (await addNode('create-email')).id;
    const judge = (await addNode('switch')).id;
    await wire(switcher, 'route:quote', quoter);
    await wire(switcher, 'route:noquote', noQuoter);
    check('a create email with no template is flagged',
        flaggedWith(await issuesOf(quoter), 'error', 'has no template yet'));
    await call('update_node', {flowId: thanks, nodeId: quoter, config: {template: 'RateReply', section: 'QUOTE'}});
    await call('update_node', {flowId: thanks, nodeId: noQuoter, config: {template: 'RateReply', section: 'NOQUOTE'}});
    check('one with a template is not', (await issuesOf(quoter)).length === 0);
    for (const [from, port] of [
        [switcher, 'route:skip'],
        [switcher, 'otherwise'],
        [quoter, 'drafted'],
        [quoter, 'skipped'],
        [noQuoter, 'drafted'],
        [noQuoter, 'skipped'],
    ] as const) {
        await wire(from, port, judge);
    }
    await call('update_node', {
        flowId: thanks,
        nodeId: judge,
        config: {
            rules: [
                {field: 'ack.route', equals: 'Qoute', route: 'a'},
                {field: 'draft.drafted', equals: 'true', route: 'b'},
            ],
        },
    });
    const met = (JSON.parse(await call('get_flow', {flowId: thanks})) as {
        nodes: { id: string; slotsOnArrival?: string[] }[];
    }).nodes.find((n) => n.id === judge)?.slotsOnArrival ?? [];
    check('where its routes meet again, the switch’s slot is there, and a create email’s is not',
        met.includes('ack') && !met.includes('draft'));
    const judged = await issuesOf(judge);
    check('a later rule on the route it took is checked against its routes',
        flaggedWith(judged, 'error', 'ack.route is "Qoute", which it never is: it is one of "Quote", "No quote", "Skip", "Otherwise"'));
    check('and one on a draft only some of the routes made is flagged',
        flaggedWith(judged, 'error', 'reads "draft", but not every path here fills it'));

    // Run as the engine runs them: neither reaches a model, and Outlook is
    // reached only by a draft, which none of these makes.
    const {executeNode} = await import('../src/main/engine/nodes');
    const {findReply, recordReply} = await import('../src/main/store/replyStore');
    const answered: EmailEnvelope = {
        ref: {
            entryId: 'E1',
            storeId: '',
            account: 'nobody@example.invalid',
            folderPath: '\\\\nobody@example.invalid\\Inbox'
        },
        subject: 'RE: Drayage Rate Request - Mobile, AL',
        senderName: 'Jo',
        senderEmail: 'jo@carrier.example',
        receivedTime: '2026-11-14 09:30',
        bodyPreview: '',
        attachmentNames: [],
    };
    const runNode = (node: FlowNode, slots: Record<string, unknown>, trigger: 'poll' | 'manual' = 'poll') =>
        executeNode({
            runId: 'check-run',
            flowId: thanks,
            node,
            schemas: {},
            email: answered,
            trigger,
            data: slots,
            scratchDir: join(data, 'node-check'),
            signal: new AbortController().signal,
            onEvent: () => {
            },
            onLive: () => {
            },
        });
    const saved = (id: string) => getFlow(thanks)?.nodes.find((n) => n.id === id);
    const switchNode = saved(switcher);
    if (switchNode?.config.kind === 'switch') {
        const went = await runNode(switchNode, verdict('quote', false));
        const ack = went.provided?.ack as SwitchOutcome | undefined;
        check(
            'a switch leaves by the route its rule picked, says which rule, and fills its slot with both',
            went.outPort === 'route:quote' && went.summary === 'Quote — rule 4: verdict.reply is "quote"' && !went.error &&
            ack?.route === 'Quote' && ack.why === 'rule 4: verdict.reply is "quote"',
        );
        const fellThrough = await runNode(switchNode, {});
        check('leaving by otherwise fills it too',
            fellThrough.outPort === 'otherwise' && (fellThrough.provided?.ack as SwitchOutcome | undefined)?.route === 'Otherwise');
        const config = switchNode.config;
        const orphaned = await runNode(
            {...switchNode, config: {...config, routes: config.routes.filter((r) => r.id !== 'quote')}},
            verdict('quote', false),
        );
        check(
            'a rule leading to a route since removed stops the run rather than guessing',
            orphaned.outPort === null && orphaned.error?.includes('leads to no route') === true,
        );
    } else {
        check('a switch leaves by the route its rule picked, says which rule, and fills its slot with both', false,
            'the switch was not saved');
    }

    // One reply per email from a flow, whichever of its Create email nodes drafts it.
    recordReply({
        at: '2026-11-14T15:31:00.000Z',
        mode: 'reply',
        runId: 'earlier-run',
        flowId: thanks,
        nodeId: quoter,
        account: answered.ref.account,
        draftEntryId: 'D1',
        to: 'jo@carrier.example',
        subject: answered.subject,
        template: 'RateReply',
        section: 'QUOTE',
        // A sender's address in another case is the same sender.
        email: {senderEmail: 'JO@Carrier.example', receivedTime: answered.receivedTime, subject: answered.subject},
    });
    const sameEmail = {
        senderEmail: answered.senderEmail,
        receivedTime: answered.receivedTime,
        subject: answered.subject
    };
    check('a drafted reply is found again by its email', findReply(thanks, sameEmail)?.draftEntryId === 'D1');
    check('and only by its own flow', findReply('another-flow', sameEmail) === undefined);
    const noQuoteNode = saved(noQuoter);
    if (noQuoteNode?.config.kind === 'create-email') {
        const again = await runNode(noQuoteNode, {});
        const draft = again.provided?.draft as DraftOutcome | undefined;
        check(
            'an email already replied to gets no second draft, from another of the flow’s nodes either',
            again.outPort === 'skipped' && draft?.drafted === false && draft.draftEntryId === '' &&
            draft.why.includes('another node of this flow') && draft.why.includes('earlier-run'),
        );
        const blank = await runNode({...noQuoteNode, config: {...noQuoteNode.config, template: ''}}, {});
        check('one with no template leaves by error, drafting nothing',
            blank.outPort === 'error' && blank.error?.includes('no template yet') === true);
    } else {
        check('an email already replied to gets no second draft, from another of the flow’s nodes either', false,
            'the create email was not saved');
    }

    // A new email: its own To, Cc and Subject, and the template's placeholders
    // filled from fields, all checked against the slots that reach it.
    const {fieldRefs, fillFields} = await import('../src/shared/flow');
    const {findNewEmail} = await import('../src/main/store/replyStore');
    const notifier = (await addNode('create-email')).id;
    await wire(judge, 'route:b', notifier);
    await call('update_node', {
        flowId: thanks,
        nodeId: notifier,
        config: {
            mode: 'new',
            template: 'Notice',
            to: '',
            cc: '{{verdict}}; {{order.id}}',
            subject: '',
            placeholders: [
                {name: 'REPLY', field: 'verdict.reply'},
                {name: 'bad name!', field: 'verdict.seen'},
                {name: 'SIGNATURE', field: 'verdict.seen'},
                {name: 'reply', field: 'verdict.answering'},
                {name: 'NOPE', field: 'verdict.nope'},
                {name: 'EMPTY', field: ''},
            ],
        },
    });
    const noticed = await issuesOf(notifier);
    check('a new email to no one is flagged', flaggedWith(noticed, 'error', 'writes a new email to no one'));
    check('and one with no subject', flaggedWith(noticed, 'error', 'writes a new email with no subject'));
    check('braces that name no field are flagged',
        flaggedWith(noticed, 'error', 'Cc has {{verdict}}, which names no field'));
    check('a field in Cc from a slot no path fills is flagged as any read is',
        flaggedWith(noticed, 'error', 'reads "order", but not every path here fills it'));
    check('a placeholder name no template can hold is flagged',
        flaggedWith(noticed, 'error', 'placeholder 2, “bad name!”, is no name a template can hold'));
    check('filling {{SIGNATURE}} is left to the signature',
        flaggedWith(noticed, 'error', 'fills {{SIGNATURE}}, which is the signature’s'));
    check('a placeholder filled twice is flagged, whatever its case',
        flaggedWith(noticed, 'error', 'fills {{reply}} a second time'));
    check('a group written in as one value is flagged',
        flaggedWith(noticed, 'error', 'writes in verdict.answering, which is a group of fields'));
    check('a field the slot’s schema lacks is flagged',
        flaggedWith(noticed, 'error', 'writes in verdict.nope, but Verdict has no field nope'));
    check('a placeholder filled from nothing is flagged', flaggedWith(noticed, 'error', 'fills {{EMPTY}} from nothing'));
    await call('update_node', {
        flowId: thanks,
        nodeId: notifier,
        config: {
            to: 'ops@example.com; {{verdict.reply}}',
            cc: '',
            subject: 'Verdict: {{ verdict.reply }}',
            placeholders: [
                {name: 'REPLY', field: 'verdict.reply'},
                {name: 'KIND', field: 'verdict.answering.kind'},
            ],
        },
    });
    check('a new email whose fields all fit is not flagged', (await issuesOf(notifier)).length === 0);
    const filledIn = fillFields('Verdict: {{ verdict.reply }}, {{verdict.seen}}', verdict('quote', false));
    check('fields in braces are written in as text', filledIn === 'Verdict: quote, false');
    check('and found as written', fieldRefs('a {{ x.y }} b {{z}}').join(',') === 'x.y,z');

    const notifierNode = saved(notifier);
    if (notifierNode?.config.kind === 'create-email') {
        const missing = await runNode(notifierNode, {verdict: {reply: 'quote', seen: false}});
        check(
            'a placeholder whose field holds nothing leaves by error, drafting nothing',
            missing.outPort === 'error' &&
            missing.error?.includes('{{KIND}} is filled from verdict.answering.kind, which holds no value') === true,
        );
        const nobody = await runNode(
            {...notifierNode, config: {...notifierNode.config, to: '{{verdict.reply}}'}},
            verdict('', false),
        );
        check('a To that comes to no one once filled in leaves by error, drafting nothing',
            nobody.outPort === 'error' && nobody.error?.includes('To came to no one') === true);

        recordReply({
            at: '2026-11-14T15:32:00.000Z',
            mode: 'new',
            runId: 'notice-run',
            flowId: thanks,
            nodeId: notifier,
            account: answered.ref.account,
            draftEntryId: 'N1',
            to: 'ops@example.com; quote',
            subject: 'Verdict: quote',
            template: 'Notice',
            section: '',
            email: sameEmail,
        });
        check('a new email is found again by the node that drafted it',
            findNewEmail(thanks, notifier, sameEmail)?.draftEntryId === 'N1');
        check('and by no other node, nor taken for one by a node that drafted a reply',
            findNewEmail(thanks, quoter, sameEmail) === undefined && findNewEmail(thanks, noQuoter, sameEmail) === undefined);
        check('nor is it the flow’s reply to the email', findReply(thanks, sameEmail)?.draftEntryId === 'D1');
        const again = await runNode(notifierNode, verdict('quote', false, 'request'));
        check('the node drafts no second new email about the email',
            again.outPort === 'skipped' && (again.provided?.draft as DraftOutcome | undefined)?.why.includes(
                'a new email about this email was already drafted') === true);
    } else {
        check('a placeholder whose field holds nothing leaves by error, drafting nothing', false,
            'the create email was not saved');
    }

    // A Send node: picks draft slots, starts with sending off, never sends on a
    // test run or an earlier run's draft, and never sends the same draft twice.
    const {checkSlots, draftSlots} = await import('../src/shared/flow');
    const {findSend, recordSend} = await import('../src/main/store/sendStore');
    await call('update_node', {flowId: thanks, nodeId: notifier, config: {output: 'notice'}});
    const sendAdded = await addNode('send');
    const sender = sendAdded.id;
    check(
        'a new send node has sent, held and error ports, starts with sending off, and fills its slot on every port',
        sendAdded.text.includes('"port": "sent"') && sendAdded.text.includes('"port": "held"') &&
        sendAdded.text.includes('"sending": false') && sendAdded.text.includes('"output": "sent"'),
    );
    await wire(notifier, 'drafted', sender);
    await wire(notifier, 'skipped', sender);
    check('a send node with no draft slots ticked is flagged',
        flaggedWith(await issuesOf(sender), 'error', 'sends nothing: tick the draft slots'));
    await call('update_node', {
        flowId: thanks,
        nodeId: sender,
        config: {drafts: ['verdict', 'unfilled']},
    });
    const sendFlagged = await issuesOf(sender);
    check('a ticked slot that holds something other than a draft is flagged',
        flaggedWith(sendFlagged, 'error', 'verdict holds a Verdict, not a Create email’s draft'));
    check('and a ticked slot not every path fills is flagged as any read is',
        flaggedWith(sendFlagged, 'error', 'reads "unfilled", but not every path here fills it'));
    await call('update_node', {
        flowId: thanks,
        nodeId: sender,
        config: {drafts: ['notice']},
    });
    check('a send node whose ticked slots are drafts on every path is not flagged',
        (await issuesOf(sender)).length === 0);
    const flowNow = getFlow(thanks);
    const arrivingAtSend = flowNow ? checkSlots(flowNow, {}).available.get(sender) : undefined;
    check('draftSlots offers only the draft slots that reach the node',
        draftSlots(arrivingAtSend).join(',') === 'notice');

    const senderNode = saved(sender);
    if (senderNode?.config.kind === 'send') {
        const freshDraft: DraftOutcome = {
            drafted: true,
            section: '',
            to: 'ops@example.com',
            draftEntryId: 'N1',
            why: 'drafted from template Notice',
        };
        const skippedDraft: DraftOutcome = {
            drafted: false,
            section: '',
            to: '',
            draftEntryId: '',
            why: 'already drafted by an earlier run',
        };
        const unconfigured = await runNode({
            ...senderNode,
            config: {...senderNode.config, drafts: []}
        }, {notice: freshDraft});
        check('a send node with no draft slots leaves by error and still fills its output slot',
            unconfigured.outPort === 'error' &&
            (unconfigured.provided?.sent as SendOutcome | undefined)?.why.includes('sends nothing') === true);

        const heldOff = await runNode(senderNode, {notice: freshDraft}, 'poll');
        const heldOffSlot = heldOff.provided?.sent as SendOutcome | undefined;
        check(
            'with sending off, a polled run leaves by held and lists who it would have sent to',
            heldOff.outPort === 'held' &&
            heldOffSlot?.held.join(',') === 'ops@example.com' &&
            heldOffSlot.sent.length === 0 &&
            heldOffSlot.why.includes('sending is off on this node; would have sent to ops@example.com'),
        );

        const liveSender: FlowNode = {...senderNode, config: {...senderNode.config, sending: true}};
        const heldManual = await runNode(liveSender, {notice: freshDraft}, 'manual');
        const heldManualSlot = heldManual.provided?.sent as SendOutcome | undefined;
        check(
            'a test run never sends, even when sending is on',
            heldManual.outPort === 'held' &&
            heldManualSlot?.held.join(',') === 'ops@example.com' &&
            heldManualSlot.why.includes('a test run never sends; would have sent to ops@example.com'),
        );

        const nothingFromEarlier = await runNode(liveSender, {notice: skippedDraft}, 'poll');
        const nothingSlot = nothingFromEarlier.provided?.sent as SendOutcome | undefined;
        check(
            'a slot whose create email left by already drafted is passed over, leaving by held',
            nothingFromEarlier.outPort === 'held' &&
            nothingSlot?.sent.length === 0 &&
            nothingSlot?.held.length === 0 &&
            nothingSlot?.why === 'Sent nothing: this run drafted nothing to send',
        );

        const idless = await runNode(liveSender, {notice: {...freshDraft, draftEntryId: ''}}, 'poll');
        const idlessSlot = idless.provided?.sent as SendOutcome | undefined;
        check(
            'a draft Outlook gave no id leaves by error rather than going unnoticed',
            idless.outPort === 'error' &&
            idlessSlot?.failed[0]?.to === 'ops@example.com' &&
            idlessSlot.failed[0].why.includes('no id it could be told apart by'),
        );

        recordSend({
            at: '2026-11-14T15:33:00.000Z',
            runId: 'earlier-send-run',
            flowId: thanks,
            nodeId: sender,
            account: answered.ref.account,
            draftEntryId: 'N1',
            slot: 'notice',
            to: 'ops@example.com',
            email: sameEmail,
        });
        check('a recorded send is found again by its mailbox and draft id, case-insensitively',
            findSend('NOBODY@example.invalid', 'N1')?.runId === 'earlier-send-run' &&
            findSend('other@example.invalid', 'N1') === undefined);
        const alreadySent = await runNode(liveSender, {notice: freshDraft}, 'poll');
        const alreadySentSlot = alreadySent.provided?.sent as SendOutcome | undefined;
        check(
            'a draft already sent is refused rather than sent a second time',
            alreadySent.outPort === 'error' &&
            alreadySentSlot?.failed[0]?.why.includes('was already sent') === true &&
            alreadySentSlot.failed[0].why.includes('earlier-send-run'),
        );
    } else {
        check('with sending off, a polled run leaves by held and lists who it would have sent to', false,
            'the send node was not saved');
    }

    // A Move email node: files into a folder, checks fields in braces against the
    // slots that reach it, and stops before Outlook when a field is missing or blank.
    const moveAdded = await addNode('move-email');
    const mover = moveAdded.id;
    check(
        'a new move email has moved and error ports, and starts with no folder and no output slot',
        moveAdded.text.includes('"port": "moved"') && moveAdded.text.includes('"port": "error"') &&
        moveAdded.text.includes('"folder": ""') && moveAdded.text.includes('"output": ""'),
    );
    await wire(sender, 'sent', mover);
    await wire(sender, 'held', mover);
    check('a move email with no folder is flagged',
        flaggedWith(await issuesOf(mover), 'error', 'has no folder yet'));
    await call('update_node', {
        flowId: thanks,
        nodeId: mover,
        config: {folder: '///'},
    });
    check('a folder of only slashes is flagged',
        flaggedWith(await issuesOf(mover), 'error', 'names no folder'));
    await call('update_node', {
        flowId: thanks,
        nodeId: mover,
        config: {folder: 'Processed/{{verdict}}/{{verdict.answering}}/{{verdict.nope}}/{{order.id}}'},
    });
    const moveFlagged = await issuesOf(mover);
    check('braces in folder that name no field are flagged',
        flaggedWith(moveFlagged, 'error', 'folder has {{verdict}}, which names no field'));
    check('a group written into folder is flagged',
        flaggedWith(moveFlagged, 'error', 'writes in verdict.answering, which is a group of fields'));
    check('a field the slot’s schema lacks is flagged on a move email',
        flaggedWith(moveFlagged, 'error', 'writes in verdict.nope, but Verdict has no field nope'));
    check('a slot not every path fills is flagged as any read is on a move email',
        flaggedWith(moveFlagged, 'error', 'reads "order", but not every path here fills it'));
    await call('update_node', {
        flowId: thanks,
        nodeId: mover,
        config: {folder: 'Processed/{{verdict.reply}}', output: 'filing'},
    });
    check('a move email whose folder and fields fit is not flagged', (await issuesOf(mover)).length === 0);

    const moverNode = saved(mover);
    if (moverNode?.config.kind === 'move-email') {
        const noFolder = await runNode({
            ...moverNode,
            config: {...moverNode.config, folder: ''}
        }, verdict('quote', false));
        const noFolderSlot = noFolder.provided?.filing as MoveEmailOutcome | undefined;
        check(
            'a move email with no folder leaves by error, moving nothing, and fills its output slot when named',
            noFolder.outPort === 'error' && noFolderSlot?.moved === false &&
            noFolderSlot.why.includes('has no folder yet'),
        );
        const missingField = await runNode(
            {...moverNode, config: {...moverNode.config, folder: 'Processed/{{verdict.answering.kind}}'}},
            {verdict: {reply: 'quote', seen: false}},
        );
        check(
            'a move email whose field holds nothing leaves by error, moving nothing',
            missingField.outPort === 'error' &&
            missingField.error?.includes('verdict.answering.kind holds no value to write in') === true,
        );
        const blankField = await runNode(moverNode, verdict('   ', false));
        check(
            'a move email whose field is blank leaves by error rather than filing into the parent folder',
            blankField.outPort === 'error' &&
            blankField.error?.includes('verdict.reply holds no value to write in') === true,
        );
    } else {
        check('a move email with no folder leaves by error, moving nothing, and fills its output slot when named', false,
            'the move email node was not saved');
    }

    // A flow file written by hand: routes keep their ids, a repeat gets a new one,
    // and a list left empty stays empty.
    const handWritten = parseFlow(
        {
            nodes: [
                {
                    id: 's1',
                    kind: 'switch',
                    config: {
                        routes: [{id: 'x', label: 'X'}, {id: 'x', label: 'Also X'}, {label: 'Unnamed'}],
                        rules: [{field: ' verdict.reply ', equals: 'quote', route: 'x'}],
                        output: 'email',
                    },
                },
                {id: 's2', kind: 'switch', config: {routes: []}},
                {id: 's3', kind: 'switch'},
            ],
        },
        'hand',
        'Hand',
    );
    const [s1, s2, s3] = handWritten.nodes.map((n) => (n.config.kind === 'switch' ? n.config : null));
    check(
        'a hand-written switch’s routes keep distinct ids, and its rules their route',
        s1?.routes.map((r) => r.id).join(',') === 'x,x-2,r3' && s1.rules[0]?.route === 'x' &&
        s1.rules[0]?.field === 'verdict.reply',
    );
    check('and an output slot it cannot have fills nothing', s1?.output === '');
    check('a switch with its routes left empty keeps none, and one with no list gets the defaults',
        s2?.routes.length === 0 && s3?.routes.length === 2);

    // A Processor no longer drafts or moves: one whose flow still ticks either is
    // flagged until each is unticked, and the old boxes are not written back.
    const retiredAdded = await addNode('processor');
    const retiring = retiredAdded.id;
    check('a new processor has no retired tools', !retiredAdded.text.includes('retiredTools'));
    await wire(mover, 'moved', retiring);
    const oldBoxes = await call('update_node', {
        flowId: thanks,
        nodeId: retiring,
        config: {allowDraftReply: true, allowMoveEmail: true},
    });
    check(
        'a processor’s old draft and move boxes, ticked, become retired tools and are not written back',
        oldBoxes.includes('"retiredTools": [') && oldBoxes.includes('"draft_reply"') &&
        oldBoxes.includes('"move_email"') && !oldBoxes.includes('allowDraftReply') && !oldBoxes.includes('allowMoveEmail'),
    );
    const retiredFlagged = await issuesOf(retiring);
    check('a processor still drafting is flagged, pointing to a Create email',
        flaggedWith(retiredFlagged, 'error', '“Leave a reply as an unsent draft” ticked, which a Processor no longer does. Put a Create email'));
    check('a processor still moving the email is flagged, pointing to a Move email',
        flaggedWith(retiredFlagged, 'error', '“Move the email to another folder” ticked, which a Processor no longer does. Put a Move email'));
    await call('update_node', {flowId: thanks, nodeId: retiring, config: {retiredTools: ['move_email']}});
    const halfCleared = await issuesOf(retiring);
    check('unticking one retired tool clears its flag alone',
        !flaggedWith(halfCleared, 'error', 'unsent draft') && flaggedWith(halfCleared, 'error', 'Move the email'));
    const unticked = await call('update_node', {flowId: thanks, nodeId: retiring, config: {retiredTools: []}});
    check('unticking the last clears the flag, and the node no longer carries the list',
        (await issuesOf(retiring)).length === 0 && !unticked.includes('retiredTools'));

    // Before Settings → Folders, one box gave a Processor files anywhere and the shell.
    const oldAccess = await call('update_node', {flowId: thanks, nodeId: retiring, config: {allowFileSystem: true}});
    check(
        'a processor’s old file-system box, ticked, becomes files anywhere and the shell, and is not written back',
        oldAccess.includes('"filesAnywhere": true') && oldAccess.includes('"allowShell": true') &&
        !oldAccess.includes('allowFileSystem'),
    );
    check('a processor with files anywhere is warned about, pointing to Settings → Folders',
        flaggedWith(await issuesOf(retiring), 'warning', '“Read and write files anywhere” ticked, from before a node picked its folders. Add the folders it needs in Settings → Folders'));
    const narrowed = await call('update_node', {
        flowId: thanks,
        nodeId: retiring,
        config: {filesAnywhere: false, allowShell: false, folders: [{folder: 'Invoices', access: 'write'}]},
    });
    check(
        'unticking files anywhere clears the warning, and the node keeps the folders it ticks instead',
        (await issuesOf(retiring)).length === 0 && !narrowed.includes('filesAnywhere') &&
        narrowed.includes('"allowShell": false') && narrowed.includes('"folder": "Invoices"') &&
        narrowed.includes('"access": "write"'),
    );
    const folderFile = parseFlow(
        {
            nodes: [
                {
                    id: 'p1',
                    kind: 'processor',
                    config: {
                        folders: ['Invoices', {folder: 'INVOICES', access: 'write'}, {
                            folder: ' Prices ',
                            access: 'write'
                        },
                            {folder: 'Notes', access: 'admin'}, {folder: ''}, 7],
                    },
                },
                {id: 'p2', kind: 'processor', config: {allowFileSystem: false}},
            ],
        },
        'folders',
        'Folders',
    );
    const [f1, f2] = folderFile.nodes.map((n) => (n.config.kind === 'processor' ? n.config : null));
    check(
        'a flow file’s folders keep each name once, trimmed, with read for an access it does not know',
        JSON.stringify(f1?.folders) ===
        JSON.stringify([{folder: 'Invoices', access: 'read'}, {folder: 'Prices', access: 'write'}, {
            folder: 'Notes',
            access: 'read'
        }]),
    );
    check('an old file-system box left unticked gives neither files anywhere nor the shell',
        f2 !== null && f2 !== undefined && !('filesAnywhere' in f2) && f2.allowShell === false && f2.folders.length === 0);
    const oldFile = parseFlow(
        {
            nodes: [
                {id: 'p1', kind: 'processor', config: {allowDraftReply: true, allowMoveEmail: false}},
                {id: 'p2', kind: 'processor', config: {retiredTools: ['move_email', 'send_mail', 'move_email']}},
                {id: 'p3', kind: 'processor', config: {allowDraftReply: false}},
            ],
        },
        'old',
        'Old',
    );
    const [p1, p2, p3] = oldFile.nodes.map((n) => (n.config.kind === 'processor' ? n.config : null));
    check(
        'a flow file from before keeps what its processors ticked as retired tools, each once and only known ones',
        p1?.retiredTools?.join(',') === 'draft_reply' && p2?.retiredTools?.join(',') === 'move_email' &&
        p3 !== null && p3 !== undefined && !('retiredTools' in p3),
    );

    await call('delete_flow', {flowId: thanks});
    await call('delete_schema', {name: 'Verdict'});

    // Refused before any poll, so Outlook is never reached.
    const unwatchable = await client.callTool({name: 'start_watching', arguments: {flowId}});
    check('a flow whose trigger names no mailbox is not switched on', unwatchable.isError === true);
    check('nothing is being watched', (JSON.parse(await call('get_status')) as EngineStatus).flowIds.length === 0);
    await call('list_runs', {limit: 3});
    await call('get_flow', {flowId});
    await call('delete_flow', {flowId});

    const missing = await client.callTool({name: 'get_flow', arguments: {flowId: 'gone'}});
    check('a missing flow comes back as a readable error', missing.isError === true);
    check('and asking after it leaves no file behind', !existsSync(join(root, 'flows', 'gone.json')));

    await client.close();
    control.stop();

    console.log(failures === 0 ? 'MCPCHECK OK' : `MCPCHECK FAILED — ${failures} check(s)`);
    app.exit(failures === 0 ? 0 : 1);
}

void app.whenReady().then(() =>
    main().catch((e: unknown) => {
        console.error('MCPCHECK FAILED:', e instanceof Error ? e.stack : e);
        app.exit(1);
    }),
);
