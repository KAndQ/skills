#!/usr/bin/env node
// Read-only contract checks. Semantic review and scheduling remain external.
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';
import { assessContext, contextObservationErrors } from './context-policy.mjs';

const STATUSES = new Set(['PLANNED', 'READY', 'BLOCKED', 'IN_PROGRESS', 'DONE', 'FAILED', 'SUPERSEDED']);
const DAG_STATUSES = new Set(['DRAFT', 'CONFIRMED', 'IN_PROGRESS', 'BLOCKED', 'DONE', 'SUPERSEDED']);
const CONTEXT_CODE = 'CONTEXT_BUDGET_EXCEEDED';
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const strings = value => Array.isArray(value) && value.every(nonempty);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const equal = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}

function yamlObject(text) {
  const doc = parseDocument(text, { uniqueKeys: true });
  if (doc.errors.length) throw new Error(doc.errors.map(error => error.message).join('; '));
  const data = doc.toJS({ maxAliasCount: 100 });
  if (!isObject(data)) throw new Error('Expected a YAML mapping');
  return data;
}

async function document(file) {
  const text = (await readFile(file, 'utf8')).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(text);
  if (!match) throw new Error(`${file}: missing YAML front matter`);
  return { file, data: yamlObject(match[1]), body: text.slice(match[0].length) };
}

function section(body, heading, level) {
  const start = new RegExp(`^${'#'.repeat(level)} ${heading}[ \\t]*$`, 'm').exec(body);
  if (!start) return null;
  const rest = body.slice(start.index + start[0].length).replace(/^\n/, '');
  const end = new RegExp(`^#{1,${level}} `, 'm').exec(rest);
  return end ? rest.slice(0, end.index) : rest;
}

function report(task) { return section(task.body, 'Expected Outputs', 1) ?? ''; }
function contract(task) {
  const { status, ...data } = task.data;
  const body = task.body.replace(/^# Expected Outputs[ \t]*\n[\s\S]*?(?=^# |$(?![\s\S]))/m, '');
  return { data, body };
}

function executionFields(task) {
  const { status, title, ...data } = task.data;
  return data;
}

async function load(directory) {
  const dag = await document(path.join(directory, 'DAG.md'));
  const names = (await readdir(path.join(directory, 'tasks'))).filter(name => name.endsWith('.md')).sort();
  const tasks = await Promise.all(names.map(name => document(path.join(directory, 'tasks', name))));
  return { directory: path.resolve(directory), dag, tasks };
}

function checkGraph(nodes, dependencies, error, label) {
  const state = new Map();
  function visit(id) {
    if (state.get(id) === 1) { error('DEPENDENCY_CYCLE', label, `Cycle includes ${id}`); return; }
    if (state.has(id)) return;
    state.set(id, 1);
    for (const dep of dependencies(id)) if (nodes.has(dep)) visit(dep);
    state.set(id, 2);
  }
  for (const id of nodes) visit(id);
}

function checkBudget(task, error, warn, observation, revision) {
  const { id, status } = task.data;
  observation ??= task.recoveryObservation;
  if (observation?.task_id !== undefined && observation.task_id !== id || observation?.dag_revision !== undefined && observation.dag_revision !== revision) {
    error('CONTEXT_OBSERVATION_BASELINE', id, 'Runtime observation must match the selected Task and current DAG revision');
    return;
  }
  const result = assessContext(task.data, observation);
  for (const item of result.errors) error(item.code, id, item.message);
  for (const item of result.warnings) warn(item.code, id, item.message);
  if ((task.data.context_budget !== undefined || task.data.context_management !== undefined) && !nonempty(section(task.body, 'Context Loading Plan', 1))) {
    error('CONTEXT_LOADING_PLAN', id, 'Context metadata requires a dynamic Context Loading Plan');
  }
  if (result.blocked) {
    if (['DONE', 'SUPERSEDED'].includes(status) || (status === 'BLOCKED' && task.request)) warn('CONTEXT_CAPACITY_HISTORY', id, 'Preserve historical status/evidence and the pending Checkpoint/Split Request');
    else error(CONTEXT_CODE, id, 'Supported minimum needs or a verified host failure establish insufficient real capacity after optimization');
  }
}

function structuredReport(task, heading, error) {
  task.reportCache ??= new Map();
  if (task.reportCache.has(heading)) return task.reportCache.get(heading);
  // Append-only reporting can contain multiple rounds; the latest request wins.
  const body = report(task);
  const headers = [...body.matchAll(new RegExp(`^### ${heading}[ \\t]*$`, 'gm'))];
  if (!headers.length) { task.reportCache.set(heading, null); return null; }
  const content = section(body.slice(headers.at(-1).index), heading, 3);
  try {
    const match = /^```ya?ml[ \t]*\n([\s\S]*?)\n```/m.exec(content);
    if (!match) throw new Error('Expected a fenced YAML mapping');
    const value = yamlObject(match[1]);
    task.reportCache.set(heading, value);
    return value;
  } catch (reason) { task.reportCache.set(heading, null); error('SPLIT_REPORT_YAML', task.data.id, `${heading}: ${reason.message}`); return null; }
}

function historicalRequestResolved(task, request, revision, error) {
  if (!['READY', 'IN_PROGRESS', 'DONE', 'FAILED'].includes(task.data.status)) return false;
  const resolution = structuredReport(task, 'Split Resolution', error);
  if (resolution?.request_revision === request.dag_revision && integer(resolution.applied_revision) &&
    resolution.applied_revision > request.dag_revision && resolution.applied_revision <= revision && nonempty(resolution.coordinator_ack)) return true;
  const body = report(task);
  if (body.lastIndexOf('### Execution Report') <= body.lastIndexOf('### Split Request')) return false;
  const execution = structuredReport(task, 'Execution Report', error);
  if (!execution || execution.task_id !== task.data.id || execution.dag_id !== task.data.dag_id || execution.dag_revision !== revision ||
    execution.task_status !== task.data.status || !nonempty(execution.run_id) ||
    !nonempty(request.checkpoint?.baseline) || execution.recovery?.from_checkpoint !== request.checkpoint.baseline ||
    !nonempty(execution.recovery?.coordinator_ack) || !Array.isArray(execution.blockers) ||
    execution.blockers.some(item => !isObject(item) || item.code === CONTEXT_CODE) ||
    !isObject(execution.context_observation) || !nonempty(execution.context_observation.evidence)) return false;
  const context = assessContext(task.data, execution.context_observation);
  if (context.errors.length || context.blocked) return false;
  task.recoveryObservation = execution.context_observation;
  return true;
}

function checkRequest(task, revision, error) {
  const request = structuredReport(task, 'Split Request', error);
  if (!request) return null;
  const { id, status } = task.data;
  if (request.blocker_code !== CONTEXT_CODE || request.task_id !== id || !integer(request.dag_revision) ||
    request.dag_revision < 1 || request.dag_revision > revision || !nonempty(request.reason) ||
    (!['BLOCKED', 'SUPERSEDED'].includes(status) && !historicalRequestResolved(task, request, revision, error))) error('SPLIT_REQUEST', id, 'Request must bind a blocked task or retain a matching resolution/acknowledged recovery report');
  const observation = request.context_observation;
  if (!isObject(observation) || contextObservationErrors(observation).length || !nonempty(observation.evidence)) {
    error('SPLIT_OBSERVATION', id, 'Require valid observed/estimated/unknown values and substantive evidence; Token ranges are optional');
  }
  if (!strings(request.attempted_reductions) || !request.attempted_reductions.length) error('SPLIT_REDUCTIONS', id, 'Record attempted loading reductions');
  const checkpoint = request.checkpoint;
  if (!isObject(checkpoint) || !nonempty(checkpoint.baseline) || !Array.isArray(checkpoint.artifacts) ||
    !checkpoint.artifacts.every(item => isObject(item) && nonempty(item.location) && nonempty(item.verification)) ||
    !strings(checkpoint.completed_acceptance) || !strings(checkpoint.pending_acceptance) || !checkpoint.pending_acceptance.length ||
    !nonempty(checkpoint.resume_notes)) error('SPLIT_CHECKPOINT', id, 'Checkpoint needs baseline, artifacts, completed/pending acceptance and resume notes');
  const proposals = request.proposed_split;
  if (!Array.isArray(proposals) || !proposals.every(item => isObject(item) && nonempty(item.key) && nonempty(item.goal) &&
    strings(item.depends_on) && strings(item.read_scope) && strings(item.write_scope) &&
    strings(item.outputs) && item.outputs.length && strings(item.acceptance_criteria) && item.acceptance_criteria.length)) {
    error('SPLIT_PROPOSAL', id, 'Proposals need keys, local dependencies, scopes, outputs and acceptance');
  } else {
    const keys = new Set(proposals.map(item => item.key));
    if (keys.size !== proposals.length || proposals.some(item => item.depends_on.some(dep => !keys.has(dep)))) {
      error('SPLIT_PROPOSAL', id, 'Proposal keys must be unique and local dependencies must exist');
    }
    checkGraph(keys, key => proposals.find(item => item.key === key).depends_on, error, id);
  }
  return request;
}

function checkResolution(task, tasks, revision, error) {
  const resolution = structuredReport(task, 'Split Resolution', error);
  if (!resolution) return null;
  const request = task.request;
  // An earlier resolution stays in the audit trail after a later request.
  if (request && integer(resolution.request_revision) && resolution.request_revision < request.dag_revision &&
    integer(resolution.applied_revision) && resolution.applied_revision <= request.dag_revision) return null;
  const { id } = task.data;
  const replacements = strings(resolution.replacement_tasks) ? resolution.replacement_tasks : [];
  if (!request || resolution.request_revision !== request.dag_revision || !integer(resolution.applied_revision) ||
    resolution.applied_revision <= resolution.request_revision || resolution.applied_revision > revision ||
    !nonempty(resolution.coordinator_ack) || !strings(resolution.replacement_tasks) || !resolution.replacement_tasks.length ||
    new Set(replacements).size !== replacements.length ||
    replacements.some(key => key === id || !tasks.has(key) || tasks.get(key).data.status === 'SUPERSEDED')) {
    error('SPLIT_RESOLUTION', id, 'Require matching request, newer revision, handoff acknowledgement and active replacement tasks');
  }
  const artifacts = request?.checkpoint?.artifacts;
  const refs = Array.isArray(artifacts) ? artifacts.map(item => item?.location) : [];
  if (!refs.length && request?.checkpoint) refs.push(request.checkpoint.baseline);
  if (!strings(resolution.checkpoint_refs) || !resolution.checkpoint_refs.length || refs.some(ref => !resolution.checkpoint_refs.includes(ref))) {
    error('SPLIT_CHECKPOINT_LOST', id, 'Resolution must retain every checkpoint artifact or the empty-checkpoint baseline');
  }
  const mapping = Array.isArray(resolution.acceptance_mapping) ? resolution.acceptance_mapping : [];
  const criteria = strings(task.data.acceptance_criteria) ? task.data.acceptance_criteria : [];
  const allowed = new Set([...replacements, ...(task.data.status === 'SUPERSEDED' ? [] : [id])]);
  if (!mapping.length || !mapping.every(item => isObject(item) && nonempty(item.original) &&
    strings(item.covered_by) && item.covered_by.length && item.covered_by.every(key => allowed.has(key) && tasks.has(key))) ||
    criteria.some(criterion => !mapping.some(item => item?.original === criterion)) ||
    !mapping.some(item => strings(item?.covered_by) && item.covered_by.some(key => key !== id))) {
    error('SPLIT_ACCEPTANCE_GAP', id, 'Map every original acceptance criterion to existing responsible replacement/residual tasks');
  }
  return resolution;
}

function locationKey(location, task, directory) {
  const file = location.split('#')[0];
  // A standard DAG lives at <repository>/.dag/<dag-id>.
  const base = file.startsWith('repository:') ? path.resolve(directory, '..', '..') : path.dirname(task.file);
  const normalized = path.resolve(base, file.replace(/^repository:/, '')).replace(/\\/g, '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function inspect(snapshot, error, warn, contextObservations = {}) {
  const { dag, tasks: documents, directory } = snapshot;
  if (dag.data.dag_id !== path.basename(directory)) error('DAG_ID', 'DAG', 'dag_id must match its stable directory');
  if (!DAG_STATUSES.has(dag.data.status)) error('DAG_STATUS', 'DAG', 'Invalid DAG status');
  if (!integer(dag.data.revision) || dag.data.revision < 1) error('DAG_REVISION', 'DAG', 'revision must be a positive integer');
  const tasks = new Map();
  for (const task of documents) {
    const data = task.data;
    if (!/^T(?!000)\d{3}$/.test(data.id) || !path.basename(task.file).startsWith(`${data.id}-`) || tasks.has(data.id)) {
      error('TASK_ID', data.id, 'IDs must be unique T001..T999 and match filenames');
    }
    if (data.dag_id !== dag.data.dag_id) error('TASK_DAG_ID', data.id, 'Task belongs to a different DAG');
    if (!STATUSES.has(data.status)) error('TASK_STATUS', data.id, 'Invalid task status');
    for (const key of ['title', 'goal', 'type', 'parallel_group', 'agent_role', 'reasoning_requirement', 'execution_mode']) {
      if (!nonempty(data[key])) error('TASK_SCHEMA', data.id, `${key} must be a nonempty string`);
    }
    for (const key of ['depends_on', 'read_scope', 'write_scope', 'acceptance_criteria', 'verification', 'risks', 'forbidden_changes']) {
      if (!strings(data[key])) error('TASK_SCHEMA', data.id, `${key} must be a string array`);
    }
    if (!Array.isArray(data.inputs) || !Array.isArray(data.outputs) || !data.outputs.every(output => isObject(output) &&
      nonempty(output.name) && nonempty(output.location) && nonempty(output.contract))) error('TASK_SCHEMA', data.id, 'Require inputs and named output contracts');
    if (Array.isArray(data.outputs) && new Set(data.outputs.map(item => item?.name)).size !== data.outputs.length) error('OUTPUT_DUPLICATE', data.id, 'Output names must be unique');
    tasks.set(data.id, task);
  }
  for (const task of tasks.values()) task.request = checkRequest(task, dag.data.revision, error);
  for (const task of tasks.values()) {
    const { id, depends_on: declared } = task.data;
    const deps = strings(declared) ? declared : [];
    if (new Set(deps).size !== deps.length) error('DEPENDENCY_DUPLICATE', id, 'Dependency IDs must be unique');
    for (const dep of deps) {
      if (!tasks.has(dep)) error('DEPENDENCY_MISSING', id, `Unknown dependency ${dep}`);
      else if (task.data.status !== 'SUPERSEDED' && tasks.get(dep).data.status === 'SUPERSEDED') error('DEPENDENCY_SUPERSEDED', id, `Active dependency ${dep} is superseded`);
      if (dep === id) error('DEPENDENCY_SELF', id, 'Task depends on itself');
    }
    const inputs = Array.isArray(task.data.inputs) ? task.data.inputs : [];
    for (const input of inputs) {
      if (!isObject(input) || !nonempty(input.location)) { error('INPUT_SCHEMA', id, 'Input needs a location'); continue; }
      if (input.from === undefined) {
        if (!nonempty(input.source)) error('INPUT_SCHEMA', id, 'External input needs source rather than a fake task ID');
        continue;
      }
      if (!deps.includes(input.from)) error('INPUT_DEPENDENCY', id, `Input ${input.from} must be declared in depends_on`);
      const producer = tasks.get(input.from);
      const output = Array.isArray(producer?.data.outputs) ? producer.data.outputs.find(item => item?.name === input.output) : undefined;
      if (!output) error('INPUT_OUTPUT', id, `Unknown output ${input.from}.${input.output}`);
      else if (nonempty(output.location) && locationKey(input.location, task, directory) !== locationKey(output.location, producer, directory)) {
        error('INPUT_LOCATION', id, `Input location does not match ${input.from}.${input.output}`);
      }
    }
    for (const dep of deps) if (!inputs.some(input => input?.from === dep)) error('DEPENDENCY_UNCONSUMED', id, `No declared input consumed from ${dep}`);
    task.resolution = checkResolution(task, tasks, dag.data.revision, error);
    checkBudget(task, error, warn, contextObservations[id], dag.data.revision);
  }
  const active = new Set([...tasks.keys()].filter(id => tasks.get(id).data.status !== 'SUPERSEDED'));
  checkGraph(active, id => strings(tasks.get(id).data.depends_on) ? tasks.get(id).data.depends_on : [], error, 'DAG');
  return tasks;
}

function descendants(changed, taskMaps) {
  const affected = new Set(changed);
  let grew;
  do {
    grew = false;
    for (const tasks of taskMaps) for (const [id, task] of tasks) {
      if (!affected.has(id) && (task.data.depends_on ?? []).some(dep => affected.has(dep))) { affected.add(id); grew = true; }
    }
  } while (grew);
  return affected;
}

function protect(before, after, tasks, error, warn) {
  const previous = new Map(before.tasks.map(task => [task.data.id, task]));
  if (before.dag.data.dag_id !== after.dag.data.dag_id) error('STATE_DAG_ID', 'DAG', 'Replanning must preserve dag_id');
  if (before.dag.data.status !== after.dag.data.status) error('STATE_DAG_STATUS', 'DAG', 'Planner must preserve real DAG execution status');
  const oldRevision = before.dag.data.revision;
  const newRevision = after.dag.data.revision;
  if (newRevision < oldRevision) error('STATE_REVISION', 'DAG', 'revision cannot decrease');
  const maxId = Math.max(0, ...[...previous.keys()].map(id => Number(id.slice(1))));
  const changed = new Set();
  for (const [id, task] of tasks) {
    const old = previous.get(id);
    if (!old) {
      changed.add(id);
      if (Number(id.slice(1)) <= maxId) error('STATE_ID_REUSE', id, 'Allocate IDs after the historical maximum');
      if (task.data.status !== 'PLANNED') error('STATE_NEW_TASK', id, 'New task must start PLANNED');
    } else {
      const executionChanged = !equal(executionFields(old), executionFields(task));
      if (executionChanged || (task.data.status === 'SUPERSEDED' && old.data.status !== 'SUPERSEDED')) changed.add(id);
      if (!executionChanged && !equal(contract(old), contract(task))) {
        warn('CONTRACT_TEXT_REVIEW', id, 'Review text/title changes for execution semantics; pure editorial changes need no revision');
      }
    }
  }
  for (const [id, old] of previous) if (!tasks.has(id)) { changed.add(id); error('STATE_TASK_DELETED', id, 'Keep historical task files/IDs'); }
  if (changed.size && newRevision <= oldRevision) error('STATE_REVISION', 'DAG', 'Execution contract changes require a newer revision');
  const affected = descendants(changed, [previous, tasks]);
  for (const [id, old] of previous) {
    const current = tasks.get(id);
    if (!current) continue;
    const oldStatus = old.data.status;
    const next = current.data.status;
    if (!report(current).includes(report(old).trim())) error('STATE_REPORT_LOST', id, 'Preserve existing reports and evidence');
    if (oldStatus === 'DONE' && (!equal(old.data, current.data) || old.body !== current.body)) error('STATE_DONE_CHANGED', id, 'Keep completed contracts/results; add repair tasks');
    if (oldStatus === 'SUPERSEDED' && (!equal(old.data, current.data) || old.body !== current.body)) error('STATE_HISTORY_CHANGED', id, 'Preserve superseded history');
    if (oldStatus === 'IN_PROGRESS' && (affected.has(id) || !equal(old.data, current.data) || old.body !== current.body)) {
      error('STATE_RUNNING_CHANGED', id, 'Coordinator must stop and hand off affected running tasks before applying revision');
    }
    if (oldStatus === 'READY' && affected.has(id) && !['PLANNED', 'SUPERSEDED'].includes(next)) error('STATE_READY_STALE', id, 'Invalidate READY for the affected downstream closure');
    if (next !== oldStatus) {
      const contextSplit = Boolean(old.request || current.request);
      const splitAcknowledged = current.resolution && old.request && current.resolution.request_revision === old.request.dag_revision &&
        current.resolution.applied_revision === newRevision && old.request.dag_revision === oldRevision;
      const superseding = next === 'SUPERSEDED' && ['PLANNED', 'READY', 'BLOCKED', 'FAILED'].includes(oldStatus) &&
        newRevision > oldRevision && (!contextSplit || splitAcknowledged);
      if (superseding) {
        if (!equal(contract(old), contract(current))) error('STATE_SUPERSEDED_CONTRACT', id, 'Keep original contract when superseding');
        if (!contextSplit) warn('STATE_SUPERSESSION_REVIEW', id, 'Existing non-context supersession rules apply; review replacement explanation');
      } else if (!(oldStatus === 'READY' && next === 'PLANNED' && affected.has(id))) {
        error('STATE_RESET', id, `Planner cannot reset ${oldStatus} to ${next} without an acknowledged split`);
      }
    }
    if (current.resolution && !equal(current.resolution, old.resolution)) {
      if (newRevision <= oldRevision || current.resolution.applied_revision !== newRevision) error('STATE_REVISION', id, 'Applying a split requires the current newer revision');
      if (!old.request || old.request.dag_revision !== oldRevision || current.resolution.request_revision !== old.request.dag_revision) {
        error('STATE_SPLIT_REQUEST', id, 'Review a stale request and persist an updated request before applying a split');
      }
      if (current.resolution.replacement_tasks.some(key => previous.has(key))) error('STATE_SPLIT_IDS', id, 'Split replacements must be newly allocated tasks');
      if ((old.data.acceptance_criteria ?? []).some(criterion => !current.resolution.acceptance_mapping.some(item => item.original === criterion))) {
        error('STATE_SPLIT_ACCEPTANCE_LOST', id, 'Map the pre-revision acceptance contract, including completed criteria');
      }
    }
  }
}

export async function validateDirectory(directory, { before: beforeDirectory, contextObservations = {} } = {}) {
  const errors = [], warnings = [];
  const error = (code, task, message) => errors.push({ code, task, message });
  const warn = (code, task, message) => warnings.push({ code, task, message });
  let snapshot, before;
  try { snapshot = await load(directory); if (beforeDirectory) before = await load(beforeDirectory); }
  catch (reason) { error('READ_OR_YAML', 'DAG', reason.message); return { errors, warnings, readFailure: true }; }
  if (!isObject(contextObservations)) { error('CONTEXT_OBSERVATIONS', 'DAG', 'contextObservations must map Task IDs to current evidence'); contextObservations = {}; }
  const tasks = inspect(snapshot, error, warn, contextObservations);
  for (const id of Object.keys(contextObservations)) if (!tasks.has(id)) error('CONTEXT_OBSERVATION_TASK', id, 'Runtime context evidence targets an unknown Task');
  if (before) {
    // Parse previous report records without revalidating historical scheduling decisions.
    for (const task of before.tasks) {
      task.request = structuredReport(task, 'Split Request', error);
      task.resolution = structuredReport(task, 'Split Resolution', error);
    }
    if (!errors.length) protect(before, snapshot, tasks, error, warn);
    else warn('STATE_GUARD_NOT_RUN', 'DAG', 'Fix current contract errors before checking snapshot protection');
  } else warn('STATE_GUARD_NOT_RUN', 'DAG', 'No --before snapshot: execution state/revision protection was not checked');
  return { errors, warnings, taskCount: tasks.size };
}

async function main() {
  const args = process.argv.slice(2);
  const directory = args.shift(), options = {};
  if (!directory || directory.startsWith('-')) throw new Error('Specify one DAG directory');
  while (args.length) {
    const flag = args.shift();
    if (!['--before', '--context-observations'].includes(flag) || !args.length || args[0].startsWith('--')) throw new Error('Usage: validate_dag.mjs <dag-directory> [--before directory] [--context-observations JSON-file]');
    const value = args.shift();
    if (flag === '--before') options.before = value;
    else options.contextObservations = JSON.parse(await readFile(value, 'utf8'));
  }
  const result = await validateDirectory(directory, options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.readFailure ? 2 : result.errors.length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(reason => { process.stderr.write(`${reason.stack}\n`); process.exitCode = 2; });
}
