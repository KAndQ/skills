import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parseDocument } from 'yaml';
import { validateContext, assessContext } from './context-policy.mjs';

export const STATUSES = ['PLANNED', 'READY', 'IN_PROGRESS', 'DONE', 'BLOCKED', 'FAILED', 'SUPERSEDED'];
export const textValue = value => typeof value === 'string' && value.trim().length > 0;
export const stringList = value => Array.isArray(value) && value.every(textValue);
export const mapping = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const tokenRange = value => Array.isArray(value) && value.length === 2 && value.every(v => Number.isSafeInteger(v) && v >= 0) && value[0] <= value[1];
const fold = value => process.platform === 'win32' ? value.toLowerCase() : value;
const slashes = value => value.replace(/\\/g, '/');
const same = (left, right) => JSON.stringify(sort(left)) === JSON.stringify(sort(right));
function sort(value) {
  if (Array.isArray(value)) return value.map(sort);
  return mapping(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sort(value[key])])) : value;
}

export function parseMarkdown(text) {
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(normalized);
  if (!match) throw new Error('Missing YAML front matter');
  const yaml = parseDocument(match[1], { uniqueKeys: true });
  if (yaml.errors.length) throw new Error(yaml.errors.map(error => error.message).join('; '));
  const data = yaml.toJS({ maxAliasCount: 100 });
  if (!mapping(data)) throw new Error('Front matter must be a mapping');
  return { data, body: normalized.slice(match[0].length), text: normalized };
}

function reportParts(body) {
  const match = /^# Expected Outputs[ \t]*\n/m.exec(body);
  if (!match) return null;
  const start = match.index + match[0].length;
  const end = /^# /m.exec(body.slice(start));
  const finish = end ? start + end.index : body.length;
  return { prefix: body.slice(0, start), report: body.slice(start, finish), suffix: body.slice(finish) };
}

export function contractHash(document) {
  const { status, ...data } = document.data;
  const parts = reportParts(document.body);
  const body = parts ? parts.prefix + parts.suffix : document.body;
  return createHash('sha256').update(JSON.stringify(sort(data)) + '\n' + body).digest('hex');
}

export function contractErrors(document) {
  const errors = [];
  const task = document.data;
  const fail = (code, message) => errors.push({ code, message });
  for (const key of ['id', 'dag_id', 'title', 'goal', 'parallel_group', 'agent_role']) {
    if (!textValue(task[key])) fail('TASK_SCHEMA', `${key} must be a nonempty string`);
  }
  if (!/^T(?!000)\d{3}$/.test(task.id)) fail('TASK_ID', 'Expected T001..T999');
  if (!STATUSES.includes(task.status)) fail('TASK_STATUS', 'Unknown Task status');
  if (!['analysis', 'research', 'design', 'implementation', 'test', 'validation', 'integration', 'documentation', 'migration', 'build', 'review'].includes(task.type)) fail('TASK_TYPE', 'Unknown Task type');
  if (!['low', 'medium', 'high'].includes(task.reasoning_requirement)) fail('TASK_REASONING', 'Unknown reasoning_requirement');
  if (!['readonly', 'same_workspace', 'isolated_worktree', 'integration'].includes(task.execution_mode)) fail('TASK_MODE', 'Unknown execution_mode');
  for (const key of ['depends_on', 'read_scope', 'write_scope', 'acceptance_criteria', 'verification', 'risks', 'forbidden_changes']) {
    if (!stringList(task[key])) fail('TASK_SCHEMA', `${key} must be a string array`);
  }
  if (!Array.isArray(task.inputs) || !task.inputs.every(input => mapping(input) && textValue(input.location) &&
    (textValue(input.from) ? textValue(input.output) : textValue(input.source)))) fail('TASK_INPUTS', 'Inputs need location and producer/output or external source');
  if (!Array.isArray(task.outputs) || !task.outputs.every(output => mapping(output) && ['name', 'location', 'contract'].every(key => textValue(output[key])))) fail('TASK_OUTPUTS', 'Outputs need name/location/contract');
  if (Array.isArray(task.outputs) && new Set(task.outputs.map(output => output?.name)).size !== task.outputs.length) fail('TASK_OUTPUTS', 'Duplicate output names');
  if (!reportParts(document.body)) fail('TASK_REPORT_SECTION', 'Missing Expected Outputs section');
  errors.push(...validateContext(task).errors);
  if ((task.context_budget !== undefined || task.context_management !== undefined) && !/^# Context Loading Plan[ \t]*$/m.test(document.body)) fail('CONTEXT_LOADING_PLAN', 'Context metadata requires a dynamic Context Loading Plan');
  return errors;
}

export function artifactPath(location, taskFile, root) {
  const [file, anchor] = location.split('#');
  if (!file.startsWith('repository:') && /^[a-z][a-z\d+.-]*:/i.test(file)) return null;
  return { file: file.startsWith('repository:') ? path.resolve(root, file.slice(11)) : path.resolve(path.dirname(taskFile), file || path.basename(taskFile)), anchor };
}

async function actualPath(candidate) {
  let cursor = candidate;
  const tail = [];
  while (true) {
    try {
      return path.join(await realpath(cursor), ...tail);
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code) || path.dirname(cursor) === cursor) return null;
      tail.unshift(path.basename(cursor)); cursor = path.dirname(cursor);
    }
  }
}

export async function containedPath(root, candidate) {
  const resolvedRoot = await realpath(root), actual = await actualPath(candidate);
  if (!actual) return false;
  const relative = path.relative(fold(resolvedRoot), fold(actual));
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function matches(relative, patterns) {
  return patterns.some(pattern => {
    const glob = fold(path.posix.normalize(slashes(pattern).replace(/^\.\//, '')));
    const target = fold(relative);
    if (glob.endsWith('/')) return target === glob.slice(0, -1) || target.startsWith(glob);
    return path.posix.matchesGlob(target, glob);
  });
}

export async function scopeAllows(task, root, taskFile, candidate, operation = 'write') {
  if (!textValue(candidate) || candidate.includes('\0') || path.posix.isAbsolute(slashes(candidate)) || path.win32.isAbsolute(candidate)) return false;
  const absolute = path.resolve(root, slashes(candidate));
  const relative = slashes(path.relative(root, absolute));
  if (!relative || relative === '..' || relative.startsWith('../') || !await containedPath(root, absolute)) return false;
  const resolvedRoot = await realpath(root), actual = await actualPath(absolute);
  const actualRelative = slashes(path.relative(resolvedRoot, actual));
  if (fold(actualRelative) !== fold(relative) && !await scopeAllows(task, resolvedRoot,
    path.join(resolvedRoot, path.relative(root, taskFile)), actualRelative, operation)) return false;
  const own = fold(relative) === fold(slashes(path.relative(root, taskFile)));
  if (fold(relative) === '.git' || fold(relative).startsWith('.git/')) return false;
  if (operation === 'read') {
    const metadata = [`${'.dag'}/${task.dag_id}/DAG.md`, `.dag/${task.dag_id}/CONTEXT.md`];
    const dependencyDoc = (task.depends_on ?? []).some(id => relative.startsWith(`.dag/${task.dag_id}/tasks/${id}-`) && relative.endsWith('.md'));
    const input = (task.inputs ?? []).some(item => {
      const located = artifactPath(item.location, taskFile, root);
      return located && fold(located.file) === fold(absolute);
    });
    return own || path.basename(relative).toLowerCase() === 'agents.md' || dependencyDoc || metadata.some(file => fold(file) === fold(relative)) || input || matches(relative, task.read_scope ?? []);
  }
  if (fold(relative) === '.dag') return false;
  if (!matches(relative, task.write_scope ?? [])) return false;
  const declaredConclusion = (task.outputs ?? []).some(output => {
    const located = artifactPath(output.location, taskFile, root);
    return located && fold(located.file) === fold(absolute) && fold(relative).startsWith(fold(`.dag/${task.dag_id}/research/${task.id}-`)) && fold(relative).endsWith('.md');
  });
  const declaredResult = (task.outputs ?? []).some(output => {
    const located = artifactPath(output.location, taskFile, root);
    return located && fold(located.file) === fold(absolute) && fold(relative) === fold(`.dag/${task.dag_id}/results/${task.id}.md`);
  });
  if (relative.toLowerCase().startsWith('.dag/') && !own && !declaredConclusion && !declaredResult) return false;
  if (task.execution_mode === 'readonly' && !own && !declaredConclusion && !declaredResult) return false;
  return true;
}

export function auditTaskEdit(beforeText, afterText, { resumeAuthorized = false } = {}) {
  const before = parseMarkdown(beforeText), after = parseMarkdown(afterText);
  const errors = [];
  const original = before.data.status, next = after.data.status;
  if (contractHash(before) !== contractHash(after)) errors.push('TASK_CONTRACT_CHANGED');
  const previousReport = reportParts(before.body), currentReport = reportParts(after.body);
  if (!previousReport || !currentReport || !currentReport.report.startsWith(previousReport.report.trimEnd())) errors.push('TASK_HISTORY_LOST');
  if (['DONE', 'SUPERSEDED'].includes(original) && before.text !== after.text) errors.push('TASK_TERMINAL_CHANGED');
  const transitions = { PLANNED: ['READY', 'BLOCKED'], READY: ['IN_PROGRESS', 'BLOCKED'], IN_PROGRESS: ['DONE', 'BLOCKED', 'FAILED'], BLOCKED: resumeAuthorized ? ['READY'] : [], FAILED: resumeAuthorized ? ['READY'] : [] };
  if (next !== original && !(transitions[original] ?? []).includes(next)) errors.push('TASK_TRANSITION');
  return errors;
}

export function assessOutcome({ checks = [], manual = [], requiredChecksExpected = 0, outputsPersisted = false,
  acceptanceComplete = false, handoffPersisted = false, blockers = [], interrupted = false, executionFailed = false,
  contextTask = {}, contextObservation, contextExceeded = false } = {}) {
  const context = assessContext(contextTask, contextObservation);
  const shortage = context.blocked && context.errors.length === 0;
  const required = checks.filter(check => check.required !== false);
  const pendingManual = manual.filter(item => item.confirmed !== true);
  const hasPass = checks.some(check => check.result === 'PASS');
  const failed = executionFailed || required.some(check => check.result === 'FAIL' || (Number.isInteger(check.exit_code) && check.exit_code !== 0));
  const notRun = required.some(check => check.result !== 'PASS' || check.exit_code !== 0) || required.length < requiredChecksExpected;
  let verification = failed ? 'FAIL' : notRun ? null : pendingManual.length ? hasPass ? 'PARTIAL' : 'MANUAL_VERIFICATION_REQUIRED' : checks.length || manual.length ? 'PASS' : null;
  const otherBlocker = blockers.find(item => item.code !== 'CONTEXT_BUDGET_EXCEEDED');
  let blocker = shortage ? 'CONTEXT_BUDGET_EXCEEDED' : context.errors.length ? 'CONTEXT_SCHEMA_INVALID' : interrupted ? 'INTERRUPTED' : otherBlocker ? otherBlocker.code ?? 'PRECONDITION_MISSING' : null;
  const incompleteManual = pendingManual.some(item => !['step', 'expected', 'owner'].every(key => textValue(item[key])));
  if (!blocker && !failed) blocker = notRun ? 'VERIFICATION_NOT_RUN' : incompleteManual ? 'MANUAL_HANDOFF_INCOMPLETE' : pendingManual.some(item => item.completion_gate === true) ? 'MANUAL_CONFIRMATION_REQUIRED' :
    !outputsPersisted || !acceptanceComplete || !handoffPersisted ? 'DELIVERY_INCOMPLETE' : verification === null ? 'VERIFICATION_MISSING' : null;
  return { status: shortage ? 'BLOCKED' : failed ? 'FAILED' : blocker ? 'BLOCKED' : 'DONE', verification_result: verification,
    blocker_code: blocker, split_request_required: shortage,
    ...(!shortage && (contextExceeded || blockers.some(item => item.code === 'CONTEXT_BUDGET_EXCEEDED')) ? { context_review_required: true } : {}) };
}
