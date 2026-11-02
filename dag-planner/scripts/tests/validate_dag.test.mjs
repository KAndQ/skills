import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { stringify, parseDocument } from 'yaml';
import { validateDirectory } from '../validate_dag.mjs';
import { assessContext } from '../context-policy.mjs';
import { assessContext as workerContext } from '../../../dag-worker/scripts/context-policy.mjs';

const run = promisify(execFile);
const DAG_ID = '20261101-context-fixture';
const validator = fileURLToPath(new URL('../validate_dag.mjs', import.meta.url));

function observation({ source = 'host', confidence = 'verified', dimension = 'remaining', tokens = 9000,
  minimum = [11000, 13000], optimization = true } = {}) {
  return { constraints: [{ dimension, tokens, source, confidence, evidence: 'Synthetic current-capacity fixture, not model telemetry' }],
    minimum_required_tokens: { [dimension]: minimum }, optimization_attempts: optimization ? ['Read only necessary symbols and retain verification/delivery'] : [],
    evidence: 'Supported minimum fixture after checking necessary inputs and remaining delivery' };
}

function budget(components = {}) {
  const parts = {
    fixed_instructions: [4000, 6000], source_reading: [4000, 6000], dependency_inputs: [2000, 3000],
    tool_output: [1000, 2000], working: [5000, 6000], delivery: [1000, 1000], ...components,
  };
  const peak = [0, 1].map(index => Object.values(parts).reduce((sum, pair) => sum + pair[index], 0));
  return {
    model_context_tokens: 128000, target_tokens: 24000, soft_limit_tokens: 32000,
    hard_limit_tokens: 48000, reserve_tokens: 16000,
    estimate: { confidence: 'low', basis: 'Synthetic bounded-source estimate, not telemetry', components: parts,
      peak_tokens: peak, cumulative_tokens: peak.map(value => value * 3) },
  };
}

function task(id, options = {}) {
  const deps = options.depends_on ?? [];
  const data = {
    dag_id: DAG_ID, id, title: `${id} result`, status: 'PLANNED', type: 'implementation', goal: `${id} observable result`,
    depends_on: deps, parallel_group: `P${Number(id.slice(1))}`, agent_role: 'implementer', reasoning_requirement: 'medium',
    execution_mode: 'same_workspace', read_scope: ['AGENTS.md'],
    write_scope: [`src/${id}.txt`, `.dag/${DAG_ID}/tasks/${id}-task.md`],
    inputs: deps.map(from => ({ from, output: 'result', location: `repository:src/${from}.txt` })),
    outputs: [{ name: 'result', location: `repository:src/${id}.txt`, contract: 'A versioned result with verification' }],
    acceptance_criteria: ['AC1: behavior', 'AC2: failure path'], verification: ['Run deterministic assertions'],
    risks: [], forbidden_changes: [], ...options,
  };
  return { data, report: 'Existing evidence: deterministic check and snapshot reference.\n', extra: '' };
}

function request(id, revision = 1) {
  return {
    blocker_code: 'CONTEXT_BUDGET_EXCEEDED', task_id: id, dag_revision: revision, reason: 'Source expansion exceeds hard limit',
    context_observation: { current_peak_tokens: null, projected_peak_tokens: [44000, 56000], remaining_work_tokens: [12000, 18000], evidence: 'Estimated from selected modules, not telemetry' },
    attempted_reductions: ['Read symbols only and bound tool output'],
    checkpoint: { baseline: 'snapshot:checkpoint-v1', artifacts: [{ location: 'snapshot:checkpoint-v1/partial.patch', verification: 'One unit check passed; full acceptance pending' }],
      completed_acceptance: [], pending_acceptance: ['AC1: behavior', 'AC2: failure path'], resume_notes: 'Keep partial patch and failing case' },
    proposed_split: [
      { key: 'left', goal: 'First observable behavior', depends_on: [], read_scope: ['src/left.txt'], write_scope: ['src/left.txt'], outputs: ['left_result'], acceptance_criteria: ['AC1: behavior'] },
      { key: 'right', goal: 'Second observable behavior', depends_on: ['left'], read_scope: ['src/right.txt'], write_scope: ['src/right.txt'], outputs: ['right_result'], acceptance_criteria: ['AC2: failure path'] },
    ],
  };
}

function resolution(replacements = ['T004', 'T005']) {
  return { request_revision: 1, applied_revision: 2, coordinator_ack: 'Coordinator confirms persisted checkpoint and stopped Worker',
    replacement_tasks: replacements, checkpoint_refs: ['snapshot:checkpoint-v1/partial.patch'], acceptance_mapping: [
      { original: 'AC1: behavior', covered_by: [replacements[0]] },
      { original: 'AC2: failure path', covered_by: [replacements.at(-1)] },
    ] };
}

const block = (heading, value) => `\n### ${heading}\n\n\`\`\`yaml\n${stringify(value)}\`\`\`\n`;

async function workspace(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'dag-planner-test-'));
  // root is the absolute, OS-created test directory, never a caller-supplied path.
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function writeGraph(root, tasks, { revision = 1, status = 'CONFIRMED' } = {}) {
  const directory = path.join(root, '.dag', DAG_ID);
  await mkdir(path.join(directory, 'tasks'), { recursive: true });
  await writeFile(path.join(directory, 'DAG.md'), `---\n${stringify({ dag_id: DAG_ID, title: 'Context test', status, revision, related_dags: [] })}---\n\n# Goal\nSynthetic fixture only.\n`);
  for (const item of tasks) {
    const loading = item.data.context_budget || item.data.context_management ? '# Context Loading Plan\nRead instructions, versioned inputs, then selected symbols. Expand within scope on new dependencies; retain evidence and checkpoint on growing risk.\n\n' : '';
    const body = `# Execution Instruction\nOnly perform this task.\n\n# Goal\n${item.data.goal}\n\n${loading}# Expected Outputs\n${item.report}\n# Risks\nNo additional risk.\n${item.extra}`;
    await writeFile(path.join(directory, 'tasks', `${item.data.id}-task.md`), `---\n${stringify(item.data)}---\n\n${body}`);
  }
  return directory;
}

const codes = result => result.errors.map(error => error.code);
const passes = result => assert.deepEqual(result.errors, [], JSON.stringify(result.errors));

async function dynamicFixture(t) {
  const root = await workspace(t);
  const first = task('T001', { status: 'DONE' });
  const parent = task('T002', { status: 'BLOCKED', depends_on: ['T001'], context_budget: budget({ source_reading: [30000, 40000] }) });
  parent.report += block('Split Request', request('T002'));
  const downstream = task('T003', { status: 'READY', depends_on: ['T002'] });
  const oldTasks = [first, parent, downstream];
  const before = await writeGraph(path.join(root, 'before'), oldTasks, { status: 'IN_PROGRESS' });
  const afterTasks = structuredClone(oldTasks);
  afterTasks[1].data.status = 'SUPERSEDED';
  afterTasks[1].report += block('Split Resolution', resolution());
  afterTasks[2] = task('T003', { depends_on: ['T005'], context_budget: budget() });
  const left = task('T004', { depends_on: ['T001'], context_budget: budget() });
  left.data.inputs.push({ source: 'Checkpoint from T002 revision 1, verified by Coordinator', location: 'snapshot:checkpoint-v1/partial.patch' });
  afterTasks.push(left, task('T005', { depends_on: ['T004'], context_budget: budget() }));
  const afterRoot = path.join(root, 'after');
  const after = await writeGraph(afterRoot, afterTasks, { revision: 2, status: 'IN_PROGRESS' });
  return { before, after, afterRoot, afterTasks };
}

test('normal bounded task separates cumulative consumption from peak capacity', async t => {
  const root = await workspace(t);
  const data = budget();
  data.estimate.cumulative_tokens = [240000, 800000];
  const directory = await writeGraph(root, [task('T001', { context_budget: data })]);
  passes(await validateDirectory(directory));
});

test('budget from the maintained reference is accepted as an actual contract', async t => {
  const root = await workspace(t);
  const reference = await readFile(new URL('../../references/context-planning.md', import.meta.url), 'utf8');
  const yaml = /```yaml\n([\s\S]*?)\n```/.exec(reference)[1];
  const data = parseDocument(yaml).toJS().context_management;
  assert.equal(data.mode, 'adaptive');
  passes(await validateDirectory(await writeGraph(root, [task('T001', { context_management: data })])));
});

test('documented request and resolution work together as a real incremental revision', async t => {
  const root = await workspace(t);
  const reference = await readFile(new URL('../../references/execution-protocol.md', import.meta.url), 'utf8');
  const examples = [...reference.matchAll(/```yaml\n([\s\S]*?)\n```/g)].map(match => parseDocument(match[1]).toJS());
  const [splitRequest, splitResolution] = examples;
  const parent = task('T002', { status: 'BLOCKED', acceptance_criteria: splitResolution.acceptance_mapping.map(item => item.original),
    context_budget: budget({ source_reading: [30000, 40000] }) });
  parent.report += block('Split Request', splitRequest);
  const before = await writeGraph(path.join(root, 'before'), [parent], { revision: 3 });
  parent.data.status = 'SUPERSEDED';
  parent.report += block('Split Resolution', splitResolution);
  const children = splitResolution.replacement_tasks.map(id => task(id, { context_budget: budget() }));
  const after = await writeGraph(path.join(root, 'after'), [parent, ...children], { revision: 4 });
  passes(await validateDirectory(after, { before }));
});

test('legacy estimated excess does not prevent READY without proven capacity failure', async t => {
  const directory = await writeGraph(await workspace(t), [task('T001', { status: 'READY', context_budget: budget({ source_reading: [30000, 40000] }) })]);
  const result = await validateDirectory(directory);
  passes(result);
  assert.ok(result.warnings.some(item => item.code === 'CONTEXT_ESTIMATE_REVIEW'));
});

test('optimizing selected source loading makes the same task fit without splitting', async t => {
  const root = await workspace(t);
  const item = task('T001', { context_budget: budget({ source_reading: [30000, 40000] }) });
  const directory = await writeGraph(root, [item]);
  passes(await validateDirectory(directory));
  item.data.context_budget = budget();
  await writeGraph(root, [item]);
  passes(await validateDirectory(directory));
});

test('BLOCKED oversized request retains checkpoint and avoids a new status enum', async t => {
  const item = task('T001', { status: 'BLOCKED', context_budget: budget({ source_reading: [30000, 40000] }) });
  item.report += block('Split Request', request('T001'));
  const result = await validateDirectory(await writeGraph(await workspace(t), [item]));
  passes(result);
  assert.ok(result.warnings.some(warning => warning.code === 'LEGACY_CONTEXT_ADVISORY'));
});

test('context blocker code cannot be substituted for task status', async t => {
  const directory = await writeGraph(await workspace(t), [task('T001', { status: 'CONTEXT_BUDGET_EXCEEDED' })]);
  assert.ok(codes(await validateDirectory(directory)).includes('TASK_STATUS'));
});

for (const [name, mutate, expected] of [
  ['inconsistent peak', data => { data.estimate.peak_tokens[1]++; }, 'CONTEXT_PEAK_SUM'],
  ['cumulative below peak', data => { data.estimate.cumulative_tokens = [1, 2]; }, 'CONTEXT_CUMULATIVE'],
  ['reversed interval', data => { data.estimate.components.working = [8000, 1000]; }, 'CONTEXT_ESTIMATE'],
  ['boolean limit', data => { data.target_tokens = true; }, 'CONTEXT_LIMITS'],
]) test(`reject ${name}`, async t => {
  const data = budget(); mutate(data);
  assert.ok(codes(await validateDirectory(await writeGraph(await workspace(t), [task('T001', { context_budget: data })]))).includes(expected));
});

test('legacy soft-limit excess is advisory', async t => {
  const result = await validateDirectory(await writeGraph(await workspace(t), [task('T001', { context_budget: budget({ source_reading: [10000, 20000] }) })]));
  passes(result);
  assert.ok(result.warnings.some(warning => warning.code === 'CONTEXT_ESTIMATE_REVIEW'));
});

test('context extension requires a loading plan', async t => {
  const directory = await writeGraph(await workspace(t), [task('T001', { context_budget: budget() })]);
  const file = path.join(directory, 'tasks/T001-task.md');
  const contents = await readFile(file, 'utf8');
  await writeFile(file, contents.replace(/# Context Loading Plan\n[\s\S]*?(?=# Expected Outputs)/, ''));
  assert.ok(codes(await validateDirectory(directory)).includes('CONTEXT_LOADING_PLAN'));
});

for (const [name, tasks, expected] of [
  ['missing dependency', [task('T001', { depends_on: ['T999'] })], 'DEPENDENCY_MISSING'],
  ['cycle', [task('T001', { depends_on: ['T002'] }), task('T002', { depends_on: ['T001'] })], 'DEPENDENCY_CYCLE'],
  ['self dependency', [task('T001', { depends_on: ['T001'] })], 'DEPENDENCY_SELF'],
  ['superseded dependency', [task('T001', { status: 'SUPERSEDED' }), task('T002', { depends_on: ['T001'] })], 'DEPENDENCY_SUPERSEDED'],
]) test(`reject ${name}`, async t => {
  assert.ok(codes(await validateDirectory(await writeGraph(await workspace(t), tasks))).includes(expected));
});

test('wrong producer output and mismatched artifact path are rejected', async t => {
  const root = await workspace(t);
  const items = [task('T001'), task('T002', { depends_on: ['T001'] })];
  items[1].data.inputs[0].output = 'missing';
  let directory = await writeGraph(root, items);
  assert.ok(codes(await validateDirectory(directory)).includes('INPUT_OUTPUT'));
  items[1].data.inputs[0].output = 'result';
  items[1].data.inputs[0].location = 'repository:wrong.txt';
  directory = await writeGraph(root, items);
  assert.ok(codes(await validateDirectory(directory)).includes('INPUT_LOCATION'));
});

test('legacy DAG remains valid and is not rewritten', async t => {
  const items = [task('T001', { status: 'DONE' }), task('T002', { depends_on: ['T001'] })];
  const directory = await writeGraph(await workspace(t), items);
  const file = path.join(directory, 'tasks/T001-task.md');
  const original = await readFile(file);
  const result = await validateDirectory(directory);
  passes(result);
  assert.ok(result.warnings.some(warning => warning.code === 'CONTEXT_INFORMATION_UNKNOWN'));
  assert.deepEqual(await readFile(file), original);
});

test('pure editorial title/body changes do not force an execution revision or migrate legacy fields', async t => {
  const root = await workspace(t);
  const item = task('T001');
  const before = await writeGraph(path.join(root, 'before'), [item]);
  item.data.title = 'Clearer display title';
  item.extra = '\nEditorial clarification without changing behavior.\n';
  const after = await writeGraph(path.join(root, 'after'), [item]);
  const result = await validateDirectory(after, { before });
  passes(result);
  assert.ok(result.warnings.some(warning => warning.code === 'CONTRACT_TEXT_REVIEW'));
});

test('materially replanned task needs no numeric budget and preserves its status', async t => {
  const root = await workspace(t);
  const item = task('T001', { status: 'BLOCKED' });
  const before = await writeGraph(path.join(root, 'before'), [item]);
  item.data.goal = 'New acceptance behavior';
  const after = await writeGraph(path.join(root, 'after'), [item], { revision: 2 });
  const result = await validateDirectory(after, { before });
  passes(result);
  assert.ok(!codes(result).includes('STATE_RESET'));
});

test('acknowledged dynamic split preserves evidence, rewires dependencies and assigns fresh planned IDs', async t => {
  const fixture = await dynamicFixture(t);
  passes(await validateDirectory(fixture.after, { before: fixture.before }));
  assert.equal((await readdir(path.join(fixture.after, 'tasks'))).length, 5);
});

test('replacement and integration tasks use proven capacity rather than estimated thresholds', async t => {
  const fixture = await dynamicFixture(t);
  for (const index of [3, 4]) {
    const item = fixture.afterTasks[index];
    const previous = structuredClone(item.data);
    item.data.context_budget = budget({ source_reading: [30000, 40000] });
    if (index === 4) item.data.type = 'integration';
    await writeGraph(fixture.afterRoot, fixture.afterTasks, { revision: 2, status: 'IN_PROGRESS' });
    passes(await validateDirectory(fixture.after, { before: fixture.before }));
    assert.ok(codes(await validateDirectory(fixture.after, { before: fixture.before, contextObservations: { [item.data.id]: observation() } })).includes('CONTEXT_BUDGET_EXCEEDED'));
    item.data = previous;
  }
});

for (const [name, mutate, expected] of [
  ['checkpoint reference removed', value => { value.checkpoint_refs = ['snapshot:unrelated']; }, 'SPLIT_CHECKPOINT_LOST'],
  ['acceptance mapping incomplete', value => { value.acceptance_mapping.pop(); }, 'SPLIT_ACCEPTANCE_GAP'],
  ['coordinator acknowledgement missing', value => { value.coordinator_ack = ''; }, 'SPLIT_RESOLUTION'],
  ['stale request revision', value => { value.request_revision = 0; }, 'SPLIT_RESOLUTION'],
]) test(`reject split with ${name}`, async t => {
  const fixture = await dynamicFixture(t);
  const value = resolution(); mutate(value);
  fixture.afterTasks[1].report = fixture.afterTasks[1].report.replace(/\n### Split Resolution[\s\S]*/, '') + block('Split Resolution', value);
  await writeGraph(fixture.afterRoot, fixture.afterTasks, { revision: 2, status: 'IN_PROGRESS' });
  assert.ok(codes(await validateDirectory(fixture.after, { before: fixture.before })).includes(expected));
});

test('proposed local split dependencies cannot cycle', async t => {
  const item = task('T001', { status: 'BLOCKED' });
  const value = request('T001'); value.proposed_split[0].depends_on = ['right'];
  item.report += block('Split Request', value);
  assert.ok(codes(await validateDirectory(await writeGraph(await workspace(t), [item]))).includes('DEPENDENCY_CYCLE'));
});

test('residual parent stays BLOCKED and can depend on a newly estimated child without a cycle', async t => {
  const fixture = await dynamicFixture(t);
  const parent = fixture.afterTasks[1];
  parent.data.status = 'BLOCKED';
  parent.data.depends_on = ['T004'];
  parent.data.inputs = [{ from: 'T004', output: 'result', location: 'repository:src/T004.txt' }];
  parent.data.context_budget = budget();
  const value = resolution(['T004']);
  value.acceptance_mapping[1].covered_by = ['T002'];
  parent.report = parent.report.replace(/\n### Split Resolution[\s\S]*/, '') + block('Split Resolution', value);
  fixture.afterTasks[2] = task('T003', { depends_on: ['T002'] });
  fixture.afterTasks.pop();
  // Write to a fresh directory so the removed synthetic T005 is not retained.
  const root = await workspace(t);
  const after = await writeGraph(root, fixture.afterTasks, { revision: 2, status: 'IN_PROGRESS' });
  passes(await validateDirectory(after, { before: fixture.before }));
});

test('new request retains earlier resolved history without replaying it', async t => {
  const root = await workspace(t);
  const parent = task('T001', { status: 'BLOCKED', context_budget: budget({ source_reading: [30000, 40000] }) });
  const historical = resolution(['T002']);
  parent.report += block('Split Request', request('T001', 1)) + block('Split Resolution', historical);
  parent.report += block('Split Request', request('T001', 3));
  const child = task('T002', { context_budget: budget() });
  const before = await writeGraph(path.join(root, 'before'), [parent, child], { revision: 3 });
  passes(await validateDirectory(before));
  parent.data.status = 'SUPERSEDED';
  const after = await writeGraph(path.join(root, 'after'), [parent, child], { revision: 4 });
  assert.ok(codes(await validateDirectory(after, { before })).includes('STATE_RESET'));
});

test('malformed request and resolution shapes report errors without crashing', async t => {
  const root = await workspace(t);
  for (const mutate of [
    value => { value.replacement_tasks = null; },
    value => { value.replacement_tasks = {}; },
    value => { value.acceptance_mapping = [null]; },
    value => { value.acceptance_mapping = [{ original: 'AC1: behavior', covered_by: 3 }]; },
    value => { value.checkpoint_refs = {}; },
  ]) {
    const parent = task('T001', { status: 'BLOCKED' });
    const value = resolution(['T002']); mutate(value);
    parent.report += block('Split Request', request('T001')) + block('Split Resolution', value);
    const directory = await writeGraph(root, [parent, task('T002', { context_budget: budget() })], { revision: 2 });
    assert.ok((await validateDirectory(directory)).errors.length);
  }
});

test('ordinary non-context supersession remains compatible with existing update rules', async t => {
  const root = await workspace(t);
  const parent = task('T001');
  const before = await writeGraph(path.join(root, 'before'), [parent]);
  parent.data.status = 'SUPERSEDED';
  parent.report += '\nReplaced by T002; existing output evidence retained.\n';
  const after = await writeGraph(path.join(root, 'after'), [parent, task('T002', { context_budget: budget() })], { revision: 2 });
  passes(await validateDirectory(after, { before }));
});

test('residual split cannot silently discard the original acceptance contract', async t => {
  const fixture = await dynamicFixture(t);
  const parent = fixture.afterTasks[1];
  parent.data.status = 'BLOCKED';
  parent.data.acceptance_criteria.pop();
  const value = resolution(); value.acceptance_mapping.pop();
  parent.report = parent.report.replace(/\n### Split Resolution[\s\S]*/, '') + block('Split Resolution', value);
  await writeGraph(fixture.afterRoot, fixture.afterTasks, { revision: 2, status: 'IN_PROGRESS' });
  assert.ok(codes(await validateDirectory(fixture.after, { before: fixture.before })).includes('STATE_SPLIT_ACCEPTANCE_LOST'));
});

test('state guard refuses DONE reset and report loss', async t => {
  const root = await workspace(t);
  const item = task('T001', { status: 'DONE' });
  const before = await writeGraph(path.join(root, 'before'), [item]);
  item.data.status = 'PLANNED'; item.report = 'Overwritten evidence';
  const after = await writeGraph(path.join(root, 'after'), [item]);
  const result = await validateDirectory(after, { before });
  for (const expected of ['STATE_RESET', 'STATE_REPORT_LOST', 'STATE_DONE_CHANGED']) assert.ok(codes(result).includes(expected));
});

test('state guard refuses BLOCKED and FAILED reset without resolution', async t => {
  const root = await workspace(t);
  const items = [task('T001', { status: 'BLOCKED' }), task('T002', { status: 'FAILED' })];
  const before = await writeGraph(path.join(root, 'before'), items);
  for (const item of items) item.data.status = 'PLANNED';
  const after = await writeGraph(path.join(root, 'after'), items);
  assert.equal(codes(await validateDirectory(after, { before })).filter(code => code === 'STATE_RESET').length, 2);
});

test('running task and running downstream contracts cannot be silently replanned', async t => {
  const root = await workspace(t);
  const items = [task('T001'), task('T002', { status: 'IN_PROGRESS', depends_on: ['T001'] })];
  const before = await writeGraph(path.join(root, 'before'), items, { status: 'IN_PROGRESS' });
  items[0].data.goal = 'Changed upstream contract';
  const after = await writeGraph(path.join(root, 'after'), items, { status: 'IN_PROGRESS', revision: 2 });
  assert.ok(codes(await validateDirectory(after, { before })).includes('STATE_RUNNING_CHANGED'));
});

test('split invalidates transitive READY descendants', async t => {
  const fixture = await dynamicFixture(t);
  fixture.afterTasks[2].data.status = 'READY';
  await writeGraph(fixture.afterRoot, fixture.afterTasks, { revision: 2, status: 'IN_PROGRESS' });
  assert.ok(codes(await validateDirectory(fixture.after, { before: fixture.before })).includes('STATE_READY_STALE'));
});

test('execution changes require revision increase and preserve DAG status', async t => {
  const root = await workspace(t);
  const items = [task('T001')];
  const before = await writeGraph(path.join(root, 'before'), items, { status: 'IN_PROGRESS' });
  items[0].data.context_budget = budget();
  const after = await writeGraph(path.join(root, 'after'), items);
  const result = await validateDirectory(after, { before });
  assert.ok(codes(result).includes('STATE_REVISION'));
  assert.ok(codes(result).includes('STATE_DAG_STATUS'));
});

test('history cannot be deleted or IDs filled below historical maximum', async t => {
  const root = await workspace(t);
  const before = await writeGraph(path.join(root, 'before'), [task('T001'), task('T003')]);
  const after = await writeGraph(path.join(root, 'after'), [task('T001'), task('T002')], { revision: 2 });
  const result = await validateDirectory(after, { before });
  assert.ok(codes(result).includes('STATE_TASK_DELETED'));
  assert.ok(codes(result).includes('STATE_ID_REUSE'));
});

test('new task cannot start in READY even when its estimate fits', async t => {
  const root = await workspace(t);
  const before = await writeGraph(path.join(root, 'before'), [task('T001')]);
  const after = await writeGraph(path.join(root, 'after'), [task('T001'), task('T002', { status: 'READY', context_budget: budget() })], { revision: 2 });
  assert.ok(codes(await validateDirectory(after, { before })).includes('STATE_NEW_TASK'));
});

test('duplicate YAML keys fail parsing rather than replacing state', async t => {
  const directory = await writeGraph(await workspace(t), [task('T001')]);
  const file = path.join(directory, 'tasks/T001-task.md');
  const contents = await readFile(file, 'utf8');
  await writeFile(file, contents.replace('status: PLANNED', 'status: PLANNED\nstatus: DONE'));
  assert.ok(codes(await validateDirectory(directory)).includes('READ_OR_YAML'));
});

test('CLI is read-only, reports omitted state guard, and uses distinct error exit codes', async t => {
  const directory = await writeGraph(await workspace(t), [task('T001')]);
  const file = path.join(directory, 'tasks/T001-task.md');
  const before = await readFile(file);
  const result = await run(process.execPath, [validator, directory]);
  assert.ok(JSON.parse(result.stdout).warnings.some(warning => warning.code === 'STATE_GUARD_NOT_RUN'));
  assert.deepEqual(await readFile(file), before);
  await assert.rejects(run(process.execPath, [validator, directory, '--unexpected']), reason => reason.code === 2);
  await assert.rejects(run(process.execPath, [validator, path.join(directory, 'missing')]), reason => reason.code === 2);
  await writeGraph(path.resolve(directory, '../..'), [task('T001', { context_budget: budget({ source_reading: [30000, 40000] }) })]);
  const observationsFile = path.resolve(directory, '../../context-observations.json');
  await writeFile(observationsFile, JSON.stringify({ T001: observation() }));
  await assert.rejects(run(process.execPath, [validator, directory, '--context-observations', observationsFile]), reason => reason.code === 1);
});

test('new tasks can omit every context field without weakening revision or lifecycle checks', async t => {
  const root = await workspace(t);
  const before = await writeGraph(path.join(root, 'before'), [task('T001')]);
  const after = await writeGraph(path.join(root, 'after'), [task('T001'), task('T002')], { revision: 2 });
  passes(await validateDirectory(after, { before }));
});

for (const strategy of ['single-result selective read', 'interface-first staged read', 'coupled-state phased verification']) {
  test(`qualitative dynamic plan supports ${strategy} without telemetry`, async t => {
    const item = task('T001', { context_management: { mode: 'adaptive', estimate: { confidence: 'unknown', basis: strategy,
      components: { source_reading: { tokens: null, basis: strategy, risk: 'Reassess dependencies and remaining work' } }, peak_tokens: null, cumulative_tokens: null } } });
    passes(await validateDirectory(await writeGraph(await workspace(t), [item])));
  });
}

test('legacy partial budgets and unknown costs are legal while numeric types stay strict', async t => {
  const data = budget();
  delete data.target_tokens; delete data.soft_limit_tokens; delete data.hard_limit_tokens; delete data.reserve_tokens;
  data.estimate.components.source_reading = null;
  data.estimate.peak_tokens = null; data.estimate.cumulative_tokens = null;
  passes(await validateDirectory(await writeGraph(await workspace(t), [task('T001', { context_budget: data })])));
});

test('legacy hint ordering and reserve arithmetic are not universal capacity rules', async t => {
  const data = budget(); data.target_tokens = 99000; data.reserve_tokens = 1000000;
  const result = await validateDirectory(await writeGraph(await workspace(t), [task('T001', { context_budget: data })]));
  passes(result);
  assert.ok(result.warnings.some(item => item.code === 'LEGACY_CONTEXT_ADVISORY'));
});

for (const capacity of [
  { source: 'model', confidence: 'verified', dimension: 'context' },
  { source: 'host', confidence: 'verified', dimension: 'input' },
  { source: 'host', confidence: 'verified', dimension: 'output' },
  { source: 'user', confidence: 'explicit', dimension: 'context' },
  { source: 'platform', confidence: 'explicit', dimension: 'cumulative' },
]) test(`supported ${capacity.source} ${capacity.dimension} constraint is binding after optimization`, async t => {
  const directory = await writeGraph(await workspace(t), [task('T001')]);
  const result = await validateDirectory(directory, { contextObservations: { T001: observation(capacity) } });
  assert.ok(codes(result).includes('CONTEXT_BUDGET_EXCEEDED'));
});

test('verified limit with ambiguous demand or no optimization is reviewed rather than falsely declared impossible', async t => {
  const directory = await writeGraph(await workspace(t), [task('T001')]);
  passes(await validateDirectory(directory, { contextObservations: { T001: observation({ minimum: [7000, 13000] }) } }));
  const result = await validateDirectory(directory, { contextObservations: { T001: observation({ optimization: false }) } });
  passes(result);
  assert.ok(result.warnings.some(item => item.code === 'CONTEXT_OPTIMIZATION_REQUIRED'));
});

test('planner estimates and missing provenance cannot impersonate physical limits', async t => {
  const directory = await writeGraph(await workspace(t), [task('T001')]);
  for (const confidence of ['estimated', 'unknown']) passes(await validateDirectory(directory, { contextObservations: { T001: observation({ source: 'planner', confidence }) } }));
});

test('explicit legacy provenance remains binding and inflated hints cannot bypass verified limits', () => {
  const legacy = budget();
  legacy.hard_limit_tokens = 9000;
  legacy.provenance = { hard_limit_tokens: { source: 'user', confidence: 'explicit', dimension: 'remaining', evidence: 'Synthetic explicit user cap' } };
  const proof = observation();
  assert.equal(assessContext({ context_budget: legacy }, { ...proof, constraints: [] }).blocked, true);
  const inflated = budget(); inflated.hard_limit_tokens = 1000000; inflated.model_context_tokens = 2000000;
  assert.equal(assessContext({ context_budget: inflated }, proof).blocked, true);
});

test('verified user headroom needs real remaining capacity and cannot be treated as a maximum', () => {
  const proof = observation({ tokens: 14000, minimum: [11000, 13000] });
  proof.constraints.push({ dimension: 'headroom', tokens: 4000, source: 'user', confidence: 'explicit', evidence: 'Synthetic required delivery margin' });
  assert.equal(assessContext({}, proof).blocked, true);
});

test('unavailable telemetry can still report a verified current host failure with an intact checkpoint', async t => {
  const value = request('T001');
  value.context_observation = { current_peak_tokens: null, projected_peak_tokens: null, remaining_work_tokens: null,
    capacity_signal: { source: 'host', confidence: 'verified', code: 'CONTEXT_EXHAUSTED', evidence: 'Synthetic current host failure' },
    optimization_attempts: ['Reduced reads and kept essential verification'], evidence: 'Necessary remaining delivery cannot be completed in this Session' };
  const item = task('T001', { status: 'BLOCKED' }); item.report += block('Split Request', value);
  passes(await validateDirectory(await writeGraph(await workspace(t), [item])));
  assert.equal(assessContext({}, value.context_observation).blocked, true);
});

test('current evidence can change with recovery while speculative compression never counts as released history', () => {
  const proof = observation(); proof.estimated_reclaimed_tokens = 100000;
  assert.equal(assessContext({ context_management: { mode: 'adaptive', capabilities: { history_release: 'unknown' } } }, proof).blocked, true);
  assert.equal(assessContext({}, observation({ tokens: 16000 })).blocked, false);
});

test('Planner and Worker use byte-identical policy and identical decisions', async () => {
  assert.equal(await readFile(new URL('../context-policy.mjs', import.meta.url), 'utf8'), await readFile(new URL('../../../dag-worker/scripts/context-policy.mjs', import.meta.url), 'utf8'));
  for (const sample of [{}, observation(), observation({ source: 'planner', confidence: 'estimated' }), observation({ tokens: 20000 })]) {
    assert.deepEqual(assessContext({ context_budget: budget() }, sample), workerContext({ context_budget: budget() }, sample));
  }
});

test('unknown evidence and known capacity with unknown demand stay explicit review cases', async t => {
  const taskData = { context_budget: { model_context_tokens: null, provenance: { model_context_tokens: { source: 'host', confidence: 'unknown', evidence: null } } },
    context_management: { mode: 'adaptive', estimate: { basis: null, peak_tokens: null }, constraints: [
    { dimension: 'context', tokens: null, source: 'unknown', confidence: 'unknown', evidence: null },
  ] } };
  passes(await validateDirectory(await writeGraph(await workspace(t), [task('T001', taskData)])));
  const proof = observation(); delete proof.minimum_required_tokens;
  const decision = assessContext({}, proof);
  assert.equal(decision.blocked, false);
  assert.ok(decision.warnings.some(item => item.code === 'CONTEXT_CAPACITY_REVIEW'));
});

test('context evidence cannot silently target the wrong Task', async t => {
  const directory = await writeGraph(await workspace(t), [task('T001')]);
  assert.ok(codes(await validateDirectory(directory, { contextObservations: { T099: observation() } })).includes('CONTEXT_OBSERVATION_TASK'));
});

test('same-Task Session recovery preserves the historical request without inventing split children', async t => {
  const root = await workspace(t), submitted = request('T001');
  for (const status of ['READY', 'IN_PROGRESS', 'DONE']) {
    const item = task('T001', { status });
    item.report += block('Split Request', submitted) + block('Execution Report', {
      task_id: 'T001', dag_id: DAG_ID, dag_revision: 1, task_status: status, run_id: `recovered-${status}`,
      recovery: { from_checkpoint: submitted.checkpoint.baseline, coordinator_ack: 'Fixture: original Session stopped and prior blocker cleared' },
      blockers: [], context_observation: { ...observation({ tokens: 16000 }), evidence: 'Fixture current Session can retain necessary input and remaining delivery' },
    });
    passes(await validateDirectory(await writeGraph(root, [item])));
  }
  assert.equal((await readdir(path.join(root, '.dag', DAG_ID, 'tasks'))).length, 1);
});

test('unresolved requests cannot be hidden by an unacknowledged recovery report', async t => {
  const item = task('T001', { status: 'IN_PROGRESS' }), submitted = request('T001');
  item.report += block('Split Request', submitted) + block('Execution Report', {
    task_id: 'T001', dag_id: DAG_ID, dag_revision: 1, task_status: 'IN_PROGRESS', run_id: 'unacknowledged',
    recovery: { from_checkpoint: submitted.checkpoint.baseline }, blockers: [], context_observation: observation({ tokens: 16000 }),
  });
  assert.ok(codes(await validateDirectory(await writeGraph(await workspace(t), [item]))).includes('SPLIT_REQUEST'));
});
