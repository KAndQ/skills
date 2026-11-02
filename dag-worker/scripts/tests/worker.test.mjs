import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stringify, parseDocument } from 'yaml';
import { preflight } from '../check_task.mjs';
import { parseMarkdown, scopeAllows, auditTaskEdit, assessOutcome } from '../guards.mjs';
import { assessContext } from '../context-policy.mjs';

const exec = promisify(execFile);
const checker = fileURLToPath(new URL('../check_task.mjs', import.meta.url));
const DAG = '20261101-worker-example';
const ownPath = `.dag/${DAG}/tasks/T002-result.md`;
const git = async (root, ...args) => exec('git', ['-C', root, ...args]);
const passed = { command: 'deterministic check', cwd: '.', result: 'PASS', exit_code: 0, required: true };
const deliverable = { checks: [passed], outputsPersisted: true, acceptanceComplete: true, handoffPersisted: true };
const human = { step: 'Inspect result', expected: 'Result matches the data', owner: 'Downstream verifier', completion_gate: false, confirmed: false };

function observation({ source = 'host', confidence = 'verified', tokens = 9000, minimum = [11000, 13000], optimization = true } = {}) {
  return { constraints: [{ dimension: 'remaining', tokens, source, confidence, evidence: 'Synthetic current resource evidence, not actual model telemetry' }],
    minimum_required_tokens: { remaining: minimum }, optimization_attempts: optimization ? ['Loaded only essential interfaces and retained verification/delivery'] : [],
    evidence: 'Synthetic supported remaining-work lower bound' };
}

function task(id, options = {}) {
  const current = id === 'T002';
  return {
    dag_id: DAG, id, title: `${id} fixture`, goal: 'One observable result', status: current ? 'READY' : 'DONE', type: 'implementation',
    depends_on: current ? ['T001'] : [], parallel_group: current ? 'P2' : 'P1', agent_role: 'implementer', reasoning_requirement: 'medium', execution_mode: 'same_workspace',
    read_scope: ['src/dep.txt', 'src/result.txt', 'tests/result.test.mjs'],
    write_scope: current ? ['src/result.txt', 'tests/result.test.mjs', ownPath] : ['src/dep.txt', `.dag/${DAG}/tasks/T001-dependency.md`],
    inputs: current ? [{ from: 'T001', output: 'dependency', location: 'repository:src/dep.txt' }] : [],
    outputs: [{ name: current ? 'result' : 'dependency', location: current ? 'repository:src/result.txt' : 'repository:src/dep.txt', contract: 'Versioned result and deterministic evidence' }],
    acceptance_criteria: ['Observable result and failure behavior'], verification: ['Run the declared deterministic checks'], risks: [], forbidden_changes: [], ...options,
  };
}

function markdown(data, report = 'Existing evidence and artifact references.\n') {
  return `---\n${stringify(data)}---\n\n# Goal\nOne observable result.\n\n# Required Changes\nOnly update the declared result.\n\n${data.context_budget || data.context_management ? '# Context Loading Plan\nRead interfaces, then bounded symbols. Expand within scope when dependencies emerge; retain evidence and checkpoint on rising risk.\n\n' : ''}# Expected Outputs\n${report}\n# Risks\nNo additional risk.\n`;
}

function budget(oversized = false) {
  const components = { fixed_instructions: [4000, 6000], source_reading: oversized ? [30000, 40000] : [4000, 6000], dependency_inputs: [2000, 3000], tool_output: [1000, 2000], working: [5000, 6000], delivery: [1000, 1000] };
  const peak = [0, 1].map(index => Object.values(components).reduce((sum, pair) => sum + pair[index], 0));
  return { model_context_tokens: 128000, target_tokens: 24000, soft_limit_tokens: 32000, hard_limit_tokens: 48000, reserve_tokens: 16000,
    estimate: { confidence: 'low', basis: 'Synthetic bounded-source estimate, not telemetry', components, peak_tokens: peak, cumulative_tokens: peak.map(value => value * 3) } };
}

async function temp(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'dag-worker-test-'));
  // Remove only this absolute OS-created fixture directory after its Git processes finish.
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function commit(root) {
  await git(root, 'add', '.');
  await git(root, '-c', 'user.name=Skill Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'Record fixture');
}

async function fixture(t, { selected = {}, producer = {}, revision = 3, dagStatus = 'CONFIRMED' } = {}) {
  const outer = await temp(t), root = path.join(outer, 'repo');
  await mkdir(path.join(root, `.dag/${DAG}/tasks`), { recursive: true });
  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(path.join(root, 'tests'), { recursive: true });
  await git(root, '-c', 'init.defaultBranch=main', 'init', '--quiet');
  const data = task('T002', selected), dep = task('T001', producer);
  const file = path.join(root, ownPath), dagFile = path.join(root, `.dag/${DAG}/DAG.md`);
  await writeFile(file, markdown(data));
  await writeFile(path.join(root, `.dag/${DAG}/tasks/T001-dependency.md`), markdown(dep));
  await writeFile(dagFile, `---\n${stringify({ dag_id: DAG, title: 'Fixture', status: dagStatus, revision, related_dags: [] })}---\n\n# Goal\nSynthetic only.\n`);
  await writeFile(path.join(root, 'src/dep.txt'), 'Versioned dependency fixture\n');
  await writeFile(path.join(root, 'src/result.txt'), 'Existing baseline result\n');
  await writeFile(path.join(root, 'AGENTS.md'), 'Use only the explicit Task scope.\n');
  await commit(root);
  return { outer, root, file, dagFile, data, dep, save: async () => { await writeFile(file, markdown(data)); await commit(root); } };
}

const codes = result => result.errors.map(error => error.code);
const succeeds = result => assert.deepEqual(result.errors, [], JSON.stringify(result.errors));

test('normal preflight pins revision and Git baseline without changing any file', async t => {
  const fixtureData = await fixture(t, { selected: { context_budget: budget() } });
  const before = await readFile(fixtureData.file);
  const result = await preflight(fixtureData.file, { revision: 3, paths: ['src/result.txt'] });
  succeeds(result);
  assert.equal(result.revision, 3);
  assert.match(result.contract_sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(result.baseline.dirty_at_start, []);
  assert.deepEqual(await readFile(fixtureData.file), before);
  assert.equal((await git(fixtureData.root, 'status', '--porcelain')).stdout, '');
});

test('normal completion uses an actual deterministic command result and requires persisted handoff', async t => {
  const { root } = await fixture(t);
  const actual = await exec(process.execPath, ['-e', "require('node:assert/strict').equal(2 + 2, 4)"], { cwd: root });
  assert.equal(actual.stderr, '');
  assert.deepEqual(assessOutcome({ ...deliverable, checks: [{ ...passed, exit_code: 0 }] }), { status: 'DONE', verification_result: 'PASS', blocker_code: null, split_request_required: false });
  assert.equal(assessOutcome({ ...deliverable, handoffPersisted: false }).status, 'BLOCKED');
});

test('missing, non-DONE and superseded dependencies stop preflight', async t => {
  for (const status of ['PLANNED', 'BLOCKED', 'SUPERSEDED']) {
    const data = await fixture(t, { producer: { status } });
    assert.ok(codes(await preflight(data.file)).includes('DEPENDENCY_NOT_DONE'));
  }
  const data = await fixture(t);
  await rm(path.join(data.root, `.dag/${DAG}/tasks/T001-dependency.md`));
  assert.ok(codes(await preflight(data.file)).includes('DEPENDENCY_MISSING'));
});

test('missing artifact and wrong named output are rejected', async t => {
  const data = await fixture(t);
  await rm(path.join(data.root, 'src/dep.txt'));
  assert.ok(codes(await preflight(data.file)).includes('DEPENDENCY_ARTIFACT_MISSING'));
  data.data.inputs[0].output = 'not_produced';
  await data.save();
  assert.ok(codes(await preflight(data.file)).includes('DEPENDENCY_OUTPUT'));
});

test('dependency report anchors must exist and remote artifacts require review', async t => {
  const data = await fixture(t);
  data.data.inputs.push({ source: 'external snapshot', location: 'snapshot:fixture/partial.patch' });
  data.data.inputs.push({ from: 'T001', output: 'dependency', location: 'repository:src/dep.txt#missing' });
  await data.save();
  const result = await preflight(data.file);
  assert.ok(codes(result).includes('DEPENDENCY_ANCHOR_MISSING'));
  assert.ok(codes(result).includes('EXTERNAL_ARTIFACT_REVIEW'));
});

test('revision mismatch and unconfirmed DAG stop before editing', async t => {
  const data = await fixture(t, { dagStatus: 'DRAFT' });
  const result = await preflight(data.file, { revision: 2 });
  assert.ok(codes(result).includes('REVISION_MISMATCH'));
  assert.ok(codes(result).includes('DAG_NOT_EXECUTABLE'));
});

test('one explicit file is required and duplicate IDs are rejected', async t => {
  const data = await fixture(t);
  assert.equal((await preflight(path.dirname(data.file))).read_failure, true);
  assert.equal((await preflight(data.file.replace('T002-result', 'T002-*'))).read_failure, true);
  await writeFile(path.join(path.dirname(data.file), 'T002-other.md'), markdown(data.data));
  assert.ok(codes(await preflight(data.file)).includes('TASK_AMBIGUOUS'));
});

test('legacy Task remains valid without budget, revision field or Loading Plan', async t => {
  const data = await fixture(t, { selected: { status: 'PLANNED' } });
  const result = await preflight(data.file);
  succeeds(result);
  assert.ok(result.warnings.some(warning => warning.code === 'CONTEXT_INFORMATION_UNKNOWN'));
  assert.equal(parseMarkdown(await readFile(data.file, 'utf8')).data.status, 'PLANNED');
});

test('only supported actual context shortage blocks; legacy forecasts and boolean hints need review', async t => {
  const data = await fixture(t, { selected: { context_budget: budget(true) } });
  const forecast = await preflight(data.file);
  succeeds(forecast);
  assert.ok(forecast.warnings.some(item => item.code === 'CONTEXT_ESTIMATE_REVIEW'));
  assert.ok(codes(await preflight(data.file, { contextObservation: observation() })).includes('CONTEXT_BUDGET_EXCEEDED'));
  const result = assessOutcome({ ...deliverable, contextTask: data.data, contextObservation: observation() });
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.blocker_code, 'CONTEXT_BUDGET_EXCEEDED');
  assert.equal(result.split_request_required, true);
  const both = assessOutcome({ ...deliverable, contextObservation: observation(), checks: [{ ...passed, result: 'FAIL', exit_code: 1 }] });
  assert.equal(both.status, 'BLOCKED');
  assert.equal(both.verification_result, 'FAIL');
  const hint = assessOutcome({ ...deliverable, contextExceeded: true });
  assert.equal(hint.status, 'DONE');
  assert.equal(hint.context_review_required, true);
});

test('done dependency with manual handoff remaining is accepted when its artifact is available', async t => {
  const data = await fixture(t);
  await writeFile(path.join(data.root, `.dag/${DAG}/tasks/T001-dependency.md`), markdown(data.dep, 'Automated checks passed; manual handoff recorded.\n\n### Verification Result\nPARTIAL\n'));
  await commit(data.root);
  succeeds(await preflight(data.file));
});

test('malformed budget and repeated YAML keys fail without writing a status', async t => {
  const data = await fixture(t, { selected: { context_budget: budget() } });
  data.data.context_budget.model_context_tokens = true;
  await data.save();
  assert.ok(codes(await preflight(data.file)).includes('CONTEXT_LIMITS'));
  const original = await readFile(data.file, 'utf8');
  await writeFile(data.file, original.replace('status: READY', 'status: READY\nstatus: DONE'));
  assert.equal((await preflight(data.file)).read_failure, true);
});

test('candidate writes, directory globs, traversal and rename destinations obey scope', async t => {
  const data = await fixture(t);
  const result = await preflight(data.file, { paths: ['src/result.txt', 'src/sibling.txt', '../escape.txt'] });
  assert.equal(codes(result).filter(code => code === 'WRITE_SCOPE_EXCEEDED').length, 2);
  const wide = { ...data.data, write_scope: ['src/**', ownPath] };
  assert.equal(await scopeAllows(wide, data.root, data.file, 'src/new/nested.txt'), true);
  assert.equal(await scopeAllows(wide, data.root, data.file, 'other/renamed.txt'), false);
});

test('overbroad glob never authorizes shared DAG, context, sibling Task or Git metadata', async t => {
  const data = await fixture(t);
  const wide = { ...data.data, write_scope: ['**', '.dag', '.dag/**'] };
  for (const candidate of ['.dag', `.dag/${DAG}/DAG.md`, `.dag/${DAG}/CONTEXT.md`, `.dag/${DAG}/tasks/T001-dependency.md`, '.git/config']) {
    assert.equal(await scopeAllows(wide, data.root, data.file, candidate), false, candidate);
  }
  assert.equal(await scopeAllows(wide, data.root, data.file, ownPath), true);
});

test('symlink and junction escape cannot bypass either repository or module ownership', async t => {
  const data = await fixture(t);
  await mkdir(path.join(data.outer, 'outside'));
  await mkdir(path.join(data.root, 'private'));
  await symlink(path.join(data.outer, 'outside'), path.join(data.root, 'src/external'), process.platform === 'win32' ? 'junction' : 'dir');
  await symlink(path.join(data.root, 'private'), path.join(data.root, 'src/internal'), process.platform === 'win32' ? 'junction' : 'dir');
  const wide = { ...data.data, write_scope: ['src/**', ownPath] };
  assert.equal(await scopeAllows(wide, data.root, data.file, 'src/external/new.txt'), false);
  assert.equal(await scopeAllows(wide, data.root, data.file, 'src/internal/new.txt'), false);
});

test('readonly mode permits own report/research and denies business writes', async t => {
  const data = await fixture(t);
  const conclusion = `.dag/${DAG}/research/T002-conclusion.md`;
  const selected = { ...data.data, execution_mode: 'readonly', write_scope: ['**', '.dag/**'], outputs: [{ name: 'conclusion', location: `repository:${conclusion}`, contract: 'Persisted findings' }] };
  assert.equal(await scopeAllows(selected, data.root, data.file, ownPath), true);
  assert.equal(await scopeAllows(selected, data.root, data.file, conclusion), true);
  assert.equal(await scopeAllows(selected, data.root, data.file, 'src/result.txt'), false);
  assert.equal(await scopeAllows(selected, data.root, data.file, `.dag/${DAG}/research/T001-other.md`), false);
});

test('read_scope allows necessary direct inputs but does not grant arbitrary source reads', async t => {
  const data = await fixture(t);
  succeeds(await preflight(data.file, { readPaths: ['src/dep.txt', 'AGENTS.md', `.dag/${DAG}/DAG.md`] }));
  assert.ok(codes(await preflight(data.file, { readPaths: ['src/unrelated.txt'] })).includes('READ_SCOPE_EXCEEDED'));
});

test('unrelated dirty files are preserved and scoped dirty files need ownership review', async t => {
  const data = await fixture(t);
  await writeFile(path.join(data.root, 'notes.txt'), 'User-owned preexisting change');
  succeeds(await preflight(data.file));
  await writeFile(path.join(data.root, 'src/result.txt'), 'Existing in-scope change');
  assert.ok(codes(await preflight(data.file)).includes('DIRTY_SCOPE'));
  const resumed = await preflight(data.file, { resume: true });
  succeeds(resumed);
  assert.ok(resumed.warnings.some(warning => warning.code === 'DIRTY_SCOPE_REVIEW'));
  assert.equal(await readFile(path.join(data.root, 'notes.txt'), 'utf8'), 'User-owned preexisting change');
});

test('interrupted/running recovery requires explicit handoff rather than resetting state', async t => {
  const data = await fixture(t, { selected: { status: 'IN_PROGRESS' } });
  assert.ok(codes(await preflight(data.file)).includes('RESUME_REQUIRED'));
  const resumed = await preflight(data.file, { resume: true });
  succeeds(resumed);
  assert.ok(resumed.warnings.some(warning => warning.code === 'RESUME_HANDOFF_REVIEW'));
  assert.equal(assessOutcome({ interrupted: true }).status, 'BLOCKED');
  assert.equal(parseMarkdown(await readFile(data.file, 'utf8')).data.status, 'IN_PROGRESS');
});

test('DONE is a no-op and SUPERSEDED does not select its replacement', async t => {
  const done = await fixture(t, { selected: { status: 'DONE' } });
  const before = await readFile(done.file);
  assert.equal((await preflight(done.file)).no_op, true);
  assert.deepEqual(await readFile(done.file), before);
  const old = await fixture(t, { selected: { status: 'SUPERSEDED' } });
  assert.ok(codes(await preflight(old.file)).includes('TASK_SUPERSEDED'));
});

test('isolated_worktree mode rejects primary checkout and accepts an actual fixture worktree', async t => {
  const data = await fixture(t, { selected: { execution_mode: 'isolated_worktree' } });
  assert.ok(codes(await preflight(data.file)).includes('WORKTREE_REQUIRED'));
  const linked = path.join(data.outer, 'linked');
  await git(data.root, 'worktree', 'add', '--quiet', '-b', 'fixture-worker', linked);
  succeeds(await preflight(path.join(linked, ownPath)));
});

test('actual failed test is FAILED/FAIL while unavailable checks are BLOCKED without a fake result', async t => {
  const { root } = await fixture(t);
  const failed = await exec(process.execPath, ['-e', 'process.exit(1)'], { cwd: root }).catch(error => error);
  assert.equal(failed.code, 1);
  assert.equal(assessOutcome({ ...deliverable, checks: [{ ...passed, result: 'FAIL', exit_code: failed.code }] }).status, 'FAILED');
  assert.equal(assessOutcome({ ...deliverable, checks: [{ ...passed, result: 'FAIL', exit_code: failed.code }] }).verification_result, 'FAIL');
  const unavailable = assessOutcome({ ...deliverable, checks: [{ ...passed, result: 'NOT_RUN', exit_code: null }] });
  assert.equal(unavailable.status, 'BLOCKED');
  assert.equal(unavailable.verification_result, null);
  assert.equal(assessOutcome({ ...deliverable, checks: [], requiredChecksExpected: 1, manual: [human] }).status, 'BLOCKED');
  assert.equal(assessOutcome({ ...deliverable, checks: [{ ...passed, exit_code: 1 }] }).status, 'FAILED');
});

test('Git operation markers and missing own report scope block preflight', async t => {
  const data = await fixture(t);
  const head = (await git(data.root, 'rev-parse', 'HEAD')).stdout.trim();
  await writeFile(path.join(data.root, '.git/MERGE_HEAD'), `${head}\n`);
  assert.ok(codes(await preflight(data.file)).includes('GIT_OPERATION_IN_PROGRESS'));
  await rm(path.join(data.root, '.git/MERGE_HEAD'));
  data.data.write_scope = ['src/result.txt'];
  await data.save();
  assert.ok(codes(await preflight(data.file)).includes('TASK_REPORT_SCOPE'));
});

test('Windows-equivalent scope paths remain equivalent', { skip: process.platform !== 'win32' }, async t => {
  const data = await fixture(t);
  assert.equal(await scopeAllows(data.data, data.root, data.file, 'SRC/RESULT.TXT'), true);
  assert.equal(await scopeAllows(data.data, data.root, data.file, ownPath.toUpperCase()), true);
});

test('manual handoff permits DONE/PARTIAL, but explicit manual gate requires BLOCKED', () => {
  assert.equal(assessOutcome({ ...deliverable, manual: [human] }).status, 'DONE');
  assert.equal(assessOutcome({ ...deliverable, manual: [human] }).verification_result, 'PARTIAL');
  assert.equal(assessOutcome({ ...deliverable, manual: [{ ...human, completion_gate: true }] }).status, 'BLOCKED');
  assert.equal(assessOutcome({ ...deliverable, checks: [], manual: [human] }).verification_result, 'MANUAL_VERIFICATION_REQUIRED');
  assert.equal(assessOutcome({ ...deliverable, manual: [{ ...human, owner: '' }] }).status, 'BLOCKED');
});

test('task edit audit preserves contract, existing reports and legal lifecycle', () => {
  const data = task('T002', { status: 'IN_PROGRESS' });
  const before = markdown(data);
  const after = markdown({ ...data, status: 'DONE' }, 'Existing evidence and artifact references.\n\n### Execution Report\nPersisted evidence.\n');
  assert.deepEqual(auditTaskEdit(before, after), []);
  assert.ok(auditTaskEdit(before, markdown({ ...data, write_scope: ['**'] })).includes('TASK_CONTRACT_CHANGED'));
  assert.ok(auditTaskEdit(before, markdown(data, 'Old evidence deleted')).includes('TASK_HISTORY_LOST'));
  const blocked = markdown({ ...data, status: 'BLOCKED' });
  assert.ok(auditTaskEdit(blocked, markdown({ ...data, status: 'READY' })).includes('TASK_TRANSITION'));
  assert.deepEqual(auditTaskEdit(blocked, markdown({ ...data, status: 'READY' }), { resumeAuthorized: true }), []);
  const done = markdown({ ...data, status: 'DONE' });
  assert.ok(auditTaskEdit(done, markdown({ ...data, status: 'PLANNED' })).includes('TASK_TERMINAL_CHANGED'));
});

test('documented execution report obeys the completion boundary', async () => {
  const text = await readFile(new URL('../../references/reporting-recovery.md', import.meta.url), 'utf8');
  const report = parseDocument(/```yaml\n([\s\S]*?)\n```/.exec(text)[1]).toJS();
  const result = assessOutcome({ checks: report.automated_verification, manual: report.manual_verification, outputsPersisted: true, acceptanceComplete: true, handoffPersisted: true });
  assert.equal(result.status, report.task_status);
  assert.equal(result.verification_result, report.verification_result);
  assert.equal(report.context_observation.current_peak_tokens, null);
});

test('documented Split Request is accepted by the existing Planner validator', async t => {
  const data = await fixture(t, { selected: { status: 'BLOCKED', context_budget: budget(true) } });
  const reference = await readFile(new URL('../../references/reporting-recovery.md', import.meta.url), 'utf8');
  const examples = [...reference.matchAll(/```yaml\n([\s\S]*?)\n```/g)];
  const request = parseDocument(examples[1][1]).toJS();
  assert.equal(assessContext(data.data, request.context_observation).blocked, true);
  assert.equal(assessOutcome({ ...deliverable, contextTask: data.data, contextObservation: request.context_observation }).split_request_required, true);
  const report = `Existing evidence and artifact references.\n\n### Split Request\n\n\`\`\`yaml\n${stringify(request)}\`\`\`\n`;
  await writeFile(data.file, markdown(data.data, report));
  // Copy the real validator without changing its source; resolve only its parser
  // dependency to this Skill's installation so the test does not install into Planner.
  const plannerFile = new URL('../../../dag-planner/scripts/validate_dag.mjs', import.meta.url);
  const source = (await readFile(plannerFile, 'utf8')).replace("from 'yaml'", `from '${import.meta.resolve('yaml')}'`);
  const copied = path.join(data.outer, 'planner-validator.mjs');
  await writeFile(copied, source);
  await writeFile(path.join(data.outer, 'context-policy.mjs'), await readFile(new URL('../context-policy.mjs', import.meta.url), 'utf8'));
  const { validateDirectory } = await import(pathToFileURL(copied));
  succeeds(await validateDirectory(path.dirname(path.dirname(data.file))));
});

test('new task with qualitative adaptive metadata requires no numerical budget or telemetry', async t => {
  const data = await fixture(t, { selected: { context_management: { mode: 'adaptive', estimate: { confidence: 'unknown',
    basis: 'Investigate coupling through selected symbols', components: { source_reading: { tokens: null, basis: 'Read interfaces before callees' } }, peak_tokens: null, cumulative_tokens: null } } } });
  const result = await preflight(data.file);
  succeeds(result);
  assert.ok(result.warnings.some(item => item.code === 'CONTEXT_OBSERVATION_UNKNOWN'));
});

test('in-progress reads can grow inside the original scope without changing the contract or hitting legacy thresholds', async t => {
  const data = await fixture(t, { selected: { status: 'IN_PROGRESS', read_scope: ['src/**'], context_budget: budget(true) } });
  await writeFile(path.join(data.root, 'src/additional.txt'), 'New necessary caller context');
  await commit(data.root);
  const original = await readFile(data.file, 'utf8');
  const first = await preflight(data.file, { resume: true, readPaths: ['src/dep.txt'] });
  const expanded = await preflight(data.file, { resume: true, readPaths: ['src/dep.txt', 'src/additional.txt'] });
  succeeds(first); succeeds(expanded);
  assert.equal(first.contract_sha256, expanded.contract_sha256);
  assert.deepEqual(auditTaskEdit(original, markdown(data.data, 'Existing evidence and artifact references.\n\nExpanded within read_scope after a new caller was found.\n')), []);
  assert.ok(codes(await preflight(data.file, { resume: true, readPaths: ['outside/module.txt'] })).includes('READ_SCOPE_EXCEEDED'));
});

test('verified capacity and explicit user limits remain binding even if legacy configuration is inflated', async t => {
  const data = await fixture(t, { selected: { context_budget: budget(true) } });
  data.data.context_budget.model_context_tokens = 9999999; data.data.context_budget.hard_limit_tokens = 999999;
  await data.save();
  for (const evidence of [observation(), observation({ source: 'user', confidence: 'explicit' })]) {
    assert.ok(codes(await preflight(data.file, { contextObservation: evidence })).includes('CONTEXT_BUDGET_EXCEEDED'));
  }
  succeeds(await preflight(data.file, { contextObservation: observation({ source: 'planner', confidence: 'estimated' }) }));
});

test('upper-bound risk without proven minimum failure or optimization does not establish shortage', async t => {
  const data = await fixture(t);
  succeeds(await preflight(data.file, { contextObservation: observation({ minimum: [7000, 13000] }) }));
  const result = await preflight(data.file, { contextObservation: observation({ optimization: false }) });
  succeeds(result);
  assert.ok(result.warnings.some(item => item.code === 'CONTEXT_OPTIMIZATION_REQUIRED'));
});

test('verified host failure without token numbers produces BLOCKED and preserves checkpoint evidence', async t => {
  const data = await fixture(t);
  const proof = { current_peak_tokens: null, projected_peak_tokens: null, remaining_work_tokens: null,
    capacity_signal: { source: 'host', confidence: 'verified', code: 'RESOURCE_UNAVAILABLE', evidence: 'Synthetic current host refusal' },
    optimization_attempts: ['Reduced loading and staged verification'], evidence: 'Still cannot finish the remaining delivery safely' };
  assert.ok(codes(await preflight(data.file, { contextObservation: proof })).includes('CONTEXT_BUDGET_EXCEEDED'));
  const decision = assessOutcome({ ...deliverable, contextObservation: proof });
  assert.equal(decision.status, 'BLOCKED'); assert.equal(decision.split_request_required, true);
  const original = await readFile(data.file, 'utf8');
  const running = markdown({ ...data.data, status: 'IN_PROGRESS' });
  assert.deepEqual(auditTaskEdit(original, running), []);
  const report = 'Existing evidence and artifact references.\n\n### Checkpoint\nPreserve baseline, changes, outputs and remaining acceptance.\n';
  assert.deepEqual(auditTaskEdit(running, markdown({ ...data.data, status: 'BLOCKED' }, report)), []);
});

test('explicit legacy provenance is enforced without forcing migration', async t => {
  const legacy = budget();
  legacy.hard_limit_tokens = 9000;
  legacy.provenance = { hard_limit_tokens: { source: 'user', confidence: 'explicit', dimension: 'remaining', evidence: 'Synthetic explicit cap' } };
  const data = await fixture(t, { selected: { context_budget: legacy } });
  const proof = observation(); proof.constraints = [];
  assert.ok(codes(await preflight(data.file, { contextObservation: proof })).includes('CONTEXT_BUDGET_EXCEEDED'));
});

test('current context observations are baseline-bound and can be supplied through the read-only CLI', async t => {
  const data = await fixture(t);
  const stale = { ...observation(), task_id: 'T002', dag_revision: 2 };
  assert.ok(codes(await preflight(data.file, { contextObservation: stale })).includes('CONTEXT_OBSERVATION_BASELINE'));
  const input = path.join(data.outer, 'current-context.json');
  await writeFile(input, JSON.stringify({ ...observation(), task_id: 'T002', dag_revision: 3 }));
  await assert.rejects(exec(process.execPath, [checker, data.file, '--context-observation', input]), error => error.code === 1);
  assert.equal(assessContext({}, observation({ tokens: 16000 })).blocked, false);
});

test('untrusted context blocker labels cannot bypass evidence checks in outcome assessment', () => {
  const decision = assessOutcome({ ...deliverable, blockers: [{ code: 'CONTEXT_BUDGET_EXCEEDED' }] });
  assert.equal(decision.status, 'DONE'); assert.equal(decision.context_review_required, true);
  assert.equal(assessOutcome({ ...deliverable, blockers: [{ code: 'DEPENDENCY_MISSING' }] }).status, 'BLOCKED');
});

test('CLI checks scope without invoking verification commands or mutating the selected Task', async t => {
  const data = await fixture(t);
  data.data.verification = ['DO NOT EXECUTE THIS SENTINEL'];
  await data.save();
  const before = await readFile(data.file);
  const output = await exec(process.execPath, [checker, data.file, '--revision', '3']);
  succeeds(JSON.parse(output.stdout));
  assert.deepEqual(await readFile(data.file), before);
  await assert.rejects(exec(process.execPath, [checker, data.file, '--path', 'src/other.txt']), error => error.code === 1);
  await assert.rejects(exec(process.execPath, [checker, data.file, '--revision', 'invalid']), error => error.code === 2);
  assert.equal((await readdir(path.join(data.root, 'src'))).includes('other.txt'), false);
});
