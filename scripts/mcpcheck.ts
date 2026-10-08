/**
 * Smoke test for the agent-control MCP server, under Electron against a throwaway
 * temp workspace. Calls neither Outlook nor Claude, so it is free to run.
 *
 *   npm run mcpcheck
 */
import { app } from 'electron';
import {
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
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { EngineStatus } from '../src/shared/settings';

/** Not the default port: a check should not fight the app if it is running. */
const PORT = 8799;
const TOKEN = 'mcpcheck-token';

const workspace = mkdtempSync(join(tmpdir(), 'patchbay-mcpcheck-'));
app.setPath('userData', workspace);

let failures = 0;

function check(what: string, ok: boolean, detail = ''): void {
    if (!ok) failures += 1;
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${what}${detail ? ` — ${detail}` : ''}`);
}

async function main(): Promise<void> {
    // Imported here rather than at the top, so the workspace above is already
    // redirected by the time anything resolves a path inside it.
    const { getSettings, saveSettings } = await import('../src/main/store/settingsStore');
    const { AgentControl } = await import('../src/main/mcp/server');
    const { Watcher } = await import('../src/main/engine/watcher');
    const { duplicateFlow, getFlow, openFlowFile, saveFlowFrom } = await import('../src/main/store/flowStore');
    const { flowDir } = await import('../src/main/paths');
    const { createSkill, globalPluginFor, listAllSkills, locateSkill, missingSkills } = await import(
        '../src/main/store/skillStore'
        );
    const { stopWatchingSkills, watchSkills } = await import('../src/main/store/skillWatch');

    console.log('workspace:', workspace);
    saveSettings({ ...getSettings(), agentControl: { enabled: true, port: PORT, token: TOKEN } });

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
        headers: { 'content-type': 'application/json', authorization: 'Bearer wrong' },
        body: '{}',
    });
    check('a wrong token is refused', refused.status === 401, `HTTP ${refused.status}`);

    const client = new Client({ name: 'mcpcheck', version: '1.0.0' });
    await client.connect(
        new StreamableHTTPClientTransport(new URL(status.url), {
            requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
        }),
    );

    const { tools } = await client.listTools();
    check(`${tools.length} tools listed`, tools.length > 0);

    /** Calls a tool and returns its text, failing the check if it errored. */
    const call = async (name: string, args: Record<string, unknown> = {}): Promise<string> => {
        const result = await client.callTool({ name, arguments: args });
        const text = (result.content as { type: string; text?: string }[])
            .map((part) => part.text ?? `[${part.type}]`)
            .join('\n');
        check(name, result.isError !== true, result.isError ? text.slice(0, 200) : '');
        return text;
    };

    const flowId = (JSON.parse(await call('create_flow', { name: 'Wired by an agent' })) as { id: string }).id;
    const idOf = async (kind: string, name?: string): Promise<string> =>
        (JSON.parse(await call('add_node', { flowId, kind, ...(name ? { name } : {}) })) as { id: string }).id;

    const trigger = await idOf('trigger.outlook', 'Pre-alerts');
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
                { id: 'pre-alert', label: 'Pre-alert', description: 'A shipment pre-alert with an HBL.' },
                { id: 'rate', label: 'Rate quote', description: 'A trucking company quoting a lane.' },
            ],
            bodyMaxChars: 'not a number',
        },
    });
    check('a bad value falls back to its default', patched.includes('"bodyMaxChars": 8000'));

    // Terminals do nothing to the email, so actions written the way an older file kept them are dropped.
    const ending = await call('update_node', {
        flowId,
        nodeId: done,
        config: { disposition: 'needs-review', actions: [{ type: 'move', folder: 'Processed' }] },
    });
    const ended = (JSON.parse(ending) as { node: { config: Record<string, unknown> } }).node.config;
    check(
        'a terminal keeps its disposition and drops any actions',
        ended.disposition === 'needs-review' && !('actions' in ended),
        JSON.stringify(ended),
    );

    const step = await call('add_node', { flowId, kind: 'processor' });
    check(
        'a new processor starts with no server tools and no file-system access',
        step.includes('"mcpTools": []') && step.includes('"allowFileSystem": false'),
    );
    const widened = await call('update_node', {
        flowId,
        nodeId: (JSON.parse(step) as { id: string }).id,
        config: { mcpTools: 'mcp__everything' },
    });
    check('a tool list of the wrong type narrows to nothing', widened.includes('"mcpTools": []'));

    const pull = await call('add_node', { flowId, kind: 'extractor' });
    const puller = (JSON.parse(pull) as { id: string }).id;
    check(
        'a new extractor starts with no skills, inputs or server tools',
        pull.includes('"skills": []') && pull.includes('"inputs": []') && pull.includes('"mcpTools": []'),
    );
    const reading = await call('update_node', {
        flowId,
        nodeId: puller,
        config: { inputs: ['placement'], mcpTools: ['mcp__logistics__lookup'] },
    });
    check(
        'an extractor keeps the slots and server tools it names',
        reading.includes('"placement"') && reading.includes('"mcp__logistics__lookup"'),
    );

    // An Extractor reading a slot no path fills is flagged, as a Processor is.
    const lone = (JSON.parse(await call('create_flow', { name: 'Extractor reads too much' })) as { id: string }).id;
    const loneTrigger = (JSON.parse(await call('add_node', { flowId: lone, kind: 'trigger.outlook' })) as {
        id: string
    }).id;
    const lonePuller = (JSON.parse(await call('add_node', { flowId: lone, kind: 'extractor' })) as { id: string }).id;
    await call('update_node', { flowId: lone, nodeId: lonePuller, config: { inputs: ['placement'] } });
    await call('connect', { flowId: lone, from: loneTrigger, port: 'out', to: lonePuller });
    check(
        'an extractor reading a slot no path fills is flagged',
        (await call('get_flow', { flowId: lone })).includes('reads \\"placement\\", but not every path here fills it'),
    );
    await call('delete_flow', { flowId: lone });

    await call('connect', { flowId, from: trigger, port: 'out', to: sorter });
    await call('connect', { flowId, from: sorter, port: 'cat:pre-alert', to: done });

    const wrongPort = await client.callTool({
        name: 'connect',
        arguments: { flowId, from: trigger, port: 'nonsense', to: done },
    });
    check('a port that does not exist is refused', wrongPort.isError === true);

    // Dropping the category takes the edge that left its port with it.
    const dropped = await call('update_node', {
        flowId,
        nodeId: sorter,
        config: { categories: [{ id: 'rate', label: 'Rate quote', description: 'A rate reply.' }] },
    });
    check('an edge left hanging is dropped and reported', dropped.includes('"droppedEdges": 1'));

    await call('write_skill', {
        scope: 'flow',
        flowId,
        name: 'check-skill',
        content: '---\nname: check-skill\ndescription: A skill written over MCP.\n---\n\nDo the thing.\n',
    });
    check(
        'the skill is in the flow’s library',
        (await call('list_skills', { flowId })).includes('check-skill'),
    );

    // A skill is a folder, not a file: what sits beside SKILL.md has to come too.
    const shelf = mkdtempSync(join(tmpdir(), 'patchbay-mcpcheck-skills-'));
    for (const name of ['alpha', 'beta']) {
        mkdirSync(join(shelf, name, 'references'), { recursive: true });
        writeFileSync(
            join(shelf, name, 'SKILL.md'),
            `---\nname: ${name}\ndescription: Imported over MCP.\n---\n\nRead references/notes.md.\n`,
        );
        writeFileSync(join(shelf, name, 'references', 'notes.md'), 'A file beside the SKILL.md.\n');
    }
    const imported = JSON.parse(
        await call('import_skills', { scope: 'flow', flowId, dir: shelf, names: ['alpha', 'nope'] }),
    ) as { imported: string[]; notFound?: string[] };
    check(
        'only the named skill is imported, and a missing one is named',
        imported.imported.join() === 'alpha' && imported.notFound?.join() === 'nope',
    );
    const flowPath =
        (JSON.parse(await call('list_flows')) as {
            id: string;
            path: string
        }[]).find((f) => f.id === flowId)?.path ?? '';
    check(
        'the files beside SKILL.md come with it',
        existsSync(join(flowPath, '.claude', 'skills', 'alpha', 'references', 'notes.md')),
    );
    const itself = await client.callTool({
        name: 'import_skills',
        arguments: { scope: 'flow', flowId, dir: join(shelf, 'alpha') },
    });
    check('a skill folder passed as the shelf is refused', itself.isError === true);
    const relative = await client.callTool({ name: 'import_skills', arguments: { scope: 'global', dir: 'skills' } });
    check('a relative folder is refused', relative.isError === true);

    // Moving a skill changes how it is ticked, so the flow's Processors and
    // Extractors follow it, and a skill leaving the shelf names every other flow
    // it leaves behind.
    const worker = await idOf('processor');
    await call('update_node', { flowId, nodeId: worker, config: { skills: ['alpha'] } });
    await call('update_node', { flowId, nodeId: puller, config: { skills: ['alpha'] } });
    const up = JSON.parse(await call('move_skill', { flowId, name: 'alpha', to: 'global' })) as {
        repointedNodes: string[];
    };
    check(
        'moving a skill re-points this flow’s ticks',
        up.repointedNodes.includes(worker) &&
        up.repointedNodes.includes(puller) &&
        (await call('get_flow', { flowId })).includes('"global:alpha"'),
    );
    const other = (JSON.parse(await call('create_flow', { name: 'Also ticks alpha' })) as { id: string }).id;
    const otherWorker = (JSON.parse(await call('add_node', { flowId: other, kind: 'processor' })) as { id: string }).id;
    await call('update_node', { flowId: other, nodeId: otherWorker, config: { skills: ['global:alpha'] } });
    const down = JSON.parse(await call('move_skill', { flowId, name: 'alpha', to: 'flow' })) as {
        stillTickedBy?: { id: string }[];
    };
    check(
        'a skill leaving the shelf names the flows it strands',
        down.stillTickedBy?.some((f) => f.id === other) === true,
    );
    await call('delete_flow', { flowId: other });

    // The global shelf reads the linked folders in place, then the workspace's own.
    // The first to hold a name has the copy in use, a write goes over that copy or
    // into the workspace, and a run gets a copy of just the ticked skills as a plugin.
    const writeSkill = (dir: string, name: string, description: string): void => {
        mkdirSync(join(dir, name), { recursive: true });
        writeFileSync(join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n`);
    };
    const upper = mkdtempSync(join(tmpdir(), 'patchbay-mcpcheck-upper-'));
    const lower = mkdtempSync(join(tmpdir(), 'patchbay-mcpcheck-lower-'));
    writeSkill(upper, 'gamma', 'Upper.');
    writeSkill(lower, 'gamma', 'Lower.');
    writeSkill(lower, 'epsilon', 'Lower only.');
    const own = join(workspace, 'workspace', 'global', 'skills');
    writeSkill(own, 'gamma', 'Stale copy in the workspace.');
    type Shelf = { folder: string; skills: string[]; shadowed?: string[] }[];
    const folders = JSON.parse(
        await call('set_global_skill_folders', { folders: [upper, lower] }),
    ) as Shelf;
    check(
        'the higher folder wins a name two folders share',
        folders[0]?.skills.join() === 'gamma' &&
        folders[1]?.skills.join() === 'epsilon' &&
        folders[1]?.shadowed?.join() === 'gamma' &&
        folders[2]?.folder === 'app workspace' &&
        folders[2]?.shadowed?.includes('gamma') === true,
        JSON.stringify(folders),
    );
    const offered = listAllSkills(flowId).filter((s) => s.scope === 'global');
    check(
        'the library offers each name once, from where it is in use',
        offered.filter((s) => s.name === 'gamma').length === 1 &&
        offered.find((s) => s.name === 'gamma')?.folder === upper,
    );
    await call('write_skill', {
        scope: 'global',
        name: 'delta',
        content: '---\nname: delta\ndescription: New.\n---\n',
    });
    check(
        'a new skill is saved in the workspace, not a linked folder',
        existsSync(join(own, 'delta', 'SKILL.md')) && !existsSync(join(upper, 'delta')),
    );
    await call('write_skill', {
        scope: 'global',
        name: 'epsilon',
        content: '---\nname: epsilon\ndescription: Edited.\n---\n',
    });
    check(
        'an edit goes over the copy in use, wherever it is',
        !existsSync(join(upper, 'epsilon')) && readFileSync(join(lower, 'epsilon', 'SKILL.md'), 'utf8').includes('Edited.'),
    );
    const plugin = globalPluginFor(['gamma', 'epsilon', 'missing']);
    check(
        'a run gets only the ticked skills, each from where it is in use, as a plugin',
        existsSync(join(plugin.path, '.claude-plugin', 'plugin.json')) &&
        readFileSync(join(plugin.path, 'skills', 'gamma', 'SKILL.md'), 'utf8').includes('Upper.') &&
        existsSync(join(plugin.path, 'skills', 'epsilon', 'SKILL.md')) &&
        !existsSync(join(plugin.path, 'skills', 'delta')),
    );
    plugin.dispose();
    check(
        'the run’s copy goes, and the folders stay',
        !existsSync(plugin.path) && existsSync(join(upper, 'gamma', 'SKILL.md')),
    );
    // Under Electron, rmSync follows a junction and empties its target.
    const outside = mkdtempSync(join(tmpdir(), 'patchbay-mcpcheck-outside-'));
    writeFileSync(join(outside, 'keep.md'), 'Not the skill’s to delete.\n');
    writeSkill(upper, 'zeta', 'Linked.');
    symlinkSync(outside, join(upper, 'zeta', 'shared'), 'junction');
    await call('delete_skill', { scope: 'global', name: 'zeta' });
    check(
        'deleting a skill removes a link inside it, not what it points at',
        !existsSync(join(upper, 'zeta')) && existsSync(join(outside, 'keep.md')),
    );
    await call('delete_skill', { scope: 'global', name: 'gamma' });
    check(
        'deleting the copy in use lets the one below take over',
        !existsSync(join(upper, 'gamma')) &&
        listAllSkills(flowId).find((s) => s.scope === 'global' && s.name === 'gamma')?.folder === lower,
    );
    const skillAsFolder = await client.callTool({
        name: 'set_global_skill_folders',
        arguments: { folders: [join(lower, 'gamma')] },
    });
    check('a skill folder is refused as a library folder', skillAsFolder.isError === true);

    // Skills are edited and deleted in other apps while this one runs. Their folders
    // are watched — a linked one, and a flow's library but not the rest of its
    // folder — and what went is refused by name, not failed on.
    let heard = 0;
    watchSkills(() => {
        heard += 1;
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
        'a skill saved in a linked folder is heard',
        await heardAfter(() =>
            writeFileSync(join(lower, 'epsilon', 'SKILL.md'), '---\nname: epsilon\ndescription: Saved elsewhere.\n---\n'),
        ),
    );
    check(
        'a skill saved in a flow’s library is heard',
        await heardAfter(() =>
            writeFileSync(join(flowPath, '.claude', 'skills', 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: Saved elsewhere.\n---\n'),
        ),
    );
    check(
        'a file beside a flow’s graph is not',
        !(await heardAfter(() => writeFileSync(join(flowPath, 'scratch.txt'), 'Not a skill.\n'))),
    );
    check(
        'a skill deleted in a linked folder is heard',
        await heardAfter(() => rmSync(join(lower, 'epsilon'), { recursive: true })),
    );
    stopWatchingSkills();
    let refusedByName = '';
    try {
        locateSkill('global', '', 'epsilon');
    } catch (e) {
        refusedByName = (e as Error).message;
    }
    check('opening a skill deleted elsewhere is refused by name', refusedByName.includes('“epsilon” is no longer'));
    check(
        'a tick naming a skill deleted elsewhere is found',
        missingSkills(flowId, ['alpha', 'global:delta', 'global:epsilon']).join() === 'global:epsilon',
    );
    mkdirSync(join(lower, 'hollow', 'SKILL.md'), { recursive: true });
    let listed: string[] = [];
    try {
        listed = listAllSkills(flowId).map((s) => s.name);
    } catch {
        // Checked below.
    }
    check('a skill that cannot be read is left out of the list, not failing it', listed.includes('delta') && !listed.includes('hollow'));
    let replaced = true;
    try {
        createSkill('global', '', 'delta', '---\nname: delta\ndescription: Would replace.\n---\n');
    } catch {
        replaced = false;
    }
    check(
        'creating a skill does not replace one of that name',
        !replaced && readFileSync(join(own, 'delta', 'SKILL.md'), 'utf8').includes('New.'),
    );
    const unlinked = JSON.parse(await call('set_global_skill_folders', { folders: [] })) as Shelf;
    check(
        'unlinking them all leaves the workspace’s own skills',
        unlinked.length === 1 &&
        unlinked[0]?.skills.includes('gamma') === true &&
        unlinked[0]?.skills.includes('delta') === true &&
        !unlinked[0]?.skills.includes('epsilon'),
        JSON.stringify(unlinked),
    );

    // A run has an id from the moment it is queued. A trigger wired to nothing
    // ends its path at once, so these runs touch neither Outlook nor Claude; two
    // of one flow queued together means the second waits for the first.
    const lane = (JSON.parse(await call('create_flow', { name: 'Queue check' })) as { id: string }).id;
    const start = (JSON.parse(await call('add_node', { flowId: lane, kind: 'trigger.outlook' })) as { id: string }).id;
    const email = {
        ref: { entryId: 'mcpcheck', storeId: 'mcpcheck', account: 'check@example.com', folderPath: '' },
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
    check('the run ahead of it still ran', (await call('get_run', { runId: first })).includes('"status": "completed"'));
    check('list_runs has it', (await call('list_runs', { flowId: lane })).includes(first));
    check(
        'cancel_run says when there is nothing to cancel',
        (await call('cancel_run', { runId: second })).includes('Nothing to cancel'),
    );

    // A step whose skill was deleted since it was ticked stops at its error port,
    // naming the skill, before Claude is asked anything.
    const stranded = (JSON.parse(await call('create_flow', { name: 'Lost skill check' })) as { id: string }).id;
    const inbox = (JSON.parse(await call('add_node', { flowId: stranded, kind: 'trigger.outlook' })) as {
        id: string
    }).id;
    const orphan = (JSON.parse(await call('add_node', { flowId: stranded, kind: 'processor' })) as { id: string }).id;
    await call('update_node', { flowId: stranded, nodeId: orphan, config: { skills: ['global:epsilon'] } });
    await call('connect', { flowId: stranded, from: inbox, port: 'out', to: orphan });
    const lostRun = watcher.enqueueManual(stranded, inbox, email);
    for (let i = 0; i < 50 && watcher.status().activeRunIds.length > 0; i++) {
        await new Promise((r) => setTimeout(r, 50));
    }
    const lostTrace = await call('get_run', { runId: lostRun });
    check(
        'a step ticking a skill deleted since leaves by its error port, naming it',
        lostTrace.includes('“global:epsilon” is ticked but no longer in the library'),
    );
    await call('delete_flow', { flowId: stranded });

    // A canvas saves against the version it last read. Its own saves move that
    // on; anyone else's write means its edit was made to a flow no longer there.
    const loaded = getFlow(lane);
    if (!loaded) throw new Error('the queue check flow is missing');
    const once = saveFlowFrom('canvas', { ...loaded, name: 'Edited once' });
    const twice = saveFlowFrom('canvas', { ...loaded, name: 'Edited twice' });
    check('a canvas saving twice from one read is not refused by its own save', 'saved' in once && 'saved' in twice);
    await call('rename_flow', { flowId: lane, name: 'Renamed by an agent' });
    const overtaken = saveFlowFrom('canvas', { ...loaded, name: 'Edited a third time' });
    check(
        'a canvas edit made before an agent’s write is refused, and handed what is there',
        'current' in overtaken && overtaken.current?.name === 'Renamed by an agent',
    );
    check('the agent’s write stands', getFlow(lane)?.name === 'Renamed by an agent');
    const reread = getFlow(lane);
    check(
        'an edit to the flow as it now stands is saved',
        reread !== null && 'saved' in saveFlowFrom('canvas', { ...reread, name: 'Edited after reading' }),
    );
    const laneFolder = join(workspace, 'workspace', 'flows', lane);
    await call('delete_flow', { flowId: lane });
    const late = reread ? saveFlowFrom('canvas', { ...reread, name: 'Too late' }) : null;
    // What a canvas still showing the flow does next: refresh its skill list.
    listAllSkills(lane);
    check(
        'a save to a deleted flow, or a look at its skills, does not bring it back',
        late !== null && 'current' in late && late.current === null && getFlow(lane) === null && !existsSync(laneFolder),
    );

    // A flow file opened from elsewhere is used where it is: listed, saved back to,
    // run in its own folder, and never copied into the workspace.
    const elsewhere = mkdtempSync(join(tmpdir(), 'patchbay-mcpcheck-elsewhere-'));
    const sent = join(elsewhere, 'sent.json');
    writeFileSync(
        sent,
        JSON.stringify({
            name: 'Sent over',
            note: 'not the app’s',
            nodes: [],
            edges: [],
            skills: [{ name: 'carried', content: '---\nname: carried\ndescription: Came in the file.\n---\n' }],
        }),
    );
    const opened = openFlowFile(sent);
    const onDisk = (): Record<string, unknown> => JSON.parse(readFileSync(sent, 'utf8')) as Record<string, unknown>;
    check('a flow file opened without an id is given one, in the file', onDisk().id === opened.id);
    check('its folder is where its runs work', flowDir(opened.id) === elsewhere);
    check(
        'and nothing is copied into the workspace',
        !readdirSync(join(workspace, 'workspace', 'flows')).some((folder) => folder.startsWith('sent')),
    );
    check(
        'the skills it carries are written beside it',
        existsSync(join(elsewhere, '.claude', 'skills', 'carried', 'SKILL.md')),
    );
    watchSkills(() => {
        heard += 1;
    });
    check(
        'and one saved there later is heard',
        await heardAfter(() =>
            writeFileSync(
                join(elsewhere, '.claude', 'skills', 'carried', 'SKILL.md'),
                '---\nname: carried\ndescription: Saved elsewhere.\n---\n',
            ),
        ),
    );
    // Released before the folder is moved about and deleted below.
    stopWatchingSkills();
    const listedOpen = (JSON.parse(await call('list_flows')) as { id: string; file: string; inPlace: boolean }[]).find(
        (entry) => entry.id === opened.id,
    );
    check('list_flows names its file, opened in place', listedOpen?.file === sent && listedOpen.inPlace);
    await call('rename_flow', { flowId: opened.id, name: 'Renamed where it is' });
    check(
        'an edit is saved to that file, keeping what else it holds',
        onDisk().name === 'Renamed where it is' && onDisk().note === 'not the app’s',
    );
    check('opening it again is the same flow', openFlowFile(sent).id === opened.id);
    const copied = join(elsewhere, 'copied.json');
    copyFileSync(sent, copied);
    const copy = openFlowFile(copied);
    check('a copy of a listed file gets an id of its own', copy.id !== opened.id && onDisk().id === opened.id);
    const moved = join(elsewhere, 'moved.json');
    renameSync(sent, moved);
    check('a moved file keeps its id, so its runs follow it', openFlowFile(moved).id === opened.id);
    const removed = await call('delete_flow', { flowId: opened.id });
    check(
        'deleting a flow opened in place only takes it off the list',
        removed.includes('Removed') && existsSync(moved) && getFlow(opened.id) === null,
    );
    await call('delete_flow', { flowId: copy.id });
    check('nor does it touch its folder', existsSync(copied) && existsSync(join(elsewhere, '.claude', 'skills')));

    // A new flow given a location gets a folder of its own there, and is kept in place.
    const location = join(elsewhere, 'not', 'yet');
    const made = async (): Promise<string> =>
        (JSON.parse(await call('create_flow', { name: 'Made here', location })) as { id: string }).id;
    const madeFirst = await made();
    const madeSecond = await made();
    check(
        'a flow made in a location gets a folder of its own, made if missing',
        flowDir(madeFirst) === join(location, 'made-here') && existsSync(join(location, 'made-here', 'flow.json')),
    );
    check('a second of the same name is numbered past it', flowDir(madeSecond) === join(location, 'made-here-2'));
    const listedMade = (JSON.parse(await call('list_flows')) as { id: string; inPlace: boolean }[]).find(
        (entry) => entry.id === madeFirst,
    );
    check('and is listed as kept in place', listedMade?.inPlace === true);
    const relativeMade = await client.callTool({
        name: 'create_flow',
        arguments: { name: 'Nowhere', location: 'flows' }
    });
    check('a location that is not a full path is refused', relativeMade.isError === true);
    createSkill('flow', madeFirst, 'kept', '---\nname: kept\ndescription: Its own.\n---\n');
    const original = getFlow(madeFirst);
    const duplicate = original ? duplicateFlow(original, 'Made here', location) : null;
    check(
        'a duplicate goes in a folder of its own in the location, with the original’s skills',
        duplicate !== null &&
        flowDir(duplicate.id) === join(location, 'made-here-3') &&
        existsSync(join(location, 'made-here-3', '.claude', 'skills', 'kept', 'SKILL.md')),
    );
    await call('delete_flow', { flowId: madeFirst });
    await call('delete_flow', { flowId: madeSecond });
    if (duplicate) await call('delete_flow', { flowId: duplicate.id });
    rmSync(elsewhere, { recursive: true, force: true });

    // The console: what the app did outside any one run, this session's and a day's.
    check(
        'the console shows an agent’s calls',
        (await call('get_console', { source: 'agent' })).includes('Called create_flow'),
    );
    const now = new Date();
    const pad = (n: number): string => String(n).padStart(2, '0');
    const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    check(
        'a day’s file reads back',
        (await call('get_console', { day: today, source: 'run' })).includes('Cancelled before it started'),
    );
    const notADay = await client.callTool({ name: 'get_console', arguments: { day: 'yesterday' } });
    check('a day that is not a date is refused', notADay.isError === true);

    const settings = await call('get_settings');
    check('the token is withheld', settings.includes('(withheld)') && !settings.includes(TOKEN));

    // Refused before any poll, so Outlook is never reached.
    const unwatchable = await client.callTool({ name: 'start_watching', arguments: { flowId } });
    check('a flow whose trigger names no mailbox is not switched on', unwatchable.isError === true);
    check('nothing is being watched', (JSON.parse(await call('get_status')) as EngineStatus).flowIds.length === 0);
    await call('list_runs', { limit: 3 });
    await call('get_flow', { flowId });
    await call('delete_flow', { flowId });

    const missing = await client.callTool({ name: 'get_flow', arguments: { flowId: 'gone' } });
    check('a missing flow comes back as a readable error', missing.isError === true);
    check('and asking after it leaves no folder behind', !existsSync(join(workspace, 'workspace', 'flows', 'gone')));

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
