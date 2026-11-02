#!/usr/bin/env node
// A read-only preflight helper. It never executes Task verification commands.
import path from 'node:path';
import { readFile, readdir, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { parseMarkdown, contractHash, contractErrors, scopeAllows, containedPath, artifactPath, stringList } from './guards.mjs';
import { assessContext } from './context-policy.mjs';

const exec = promisify(execFile);
const git = async (root, ...args) => (await exec('git', ['-C', root, ...args], { env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, maxBuffer: 4 * 1024 * 1024 })).stdout.trimEnd();
const exists = async file => { try { await stat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
const read = async file => parseMarkdown(await readFile(file, 'utf8'));
const fold = value => process.platform === 'win32' ? value.toLowerCase() : value;
const slug = value => value.trim().toLowerCase().replace(/[^\p{L}\p{N}_\-\s]/gu, '').replace(/\s/g, '-');

function dirtyEntries(porcelain) {
  const records = porcelain.split('\0').filter(Boolean), entries = [];
  for (let index = 0; index < records.length; index++) {
    const record = records[index], kind = record.slice(0, 2), file = record.slice(3);
    entries.push({ kind, path: file });
    if (/[RC]/.test(kind)) entries.push({ kind, path: records[++index] });
  }
  return entries;
}

export async function preflight(taskPath, { revision, resume = false, paths = [], readPaths = [], contextObservation } = {}) {
  const errors = [], warnings = [];
  const fail = (code, message) => errors.push({ code, message });
  const warn = (code, message) => warnings.push({ code, message });
  const result = { errors, warnings, no_op: false };
  try {
    if (!taskPath || /[*?]/.test(taskPath) || !path.basename(taskPath).match(/^T(?!000)\d{3}-[^/\\]+\.md$/)) throw new Error('Specify exactly one existing Txxx-slug.md file');
    const file = path.resolve(taskPath);
    const root = await git(path.dirname(file), 'rev-parse', '--show-toplevel');
    const relative = path.relative(root, file).replace(/\\/g, '/');
    const match = /^\.dag\/([^/]+)\/tasks\/(T\d{3})-[^/]+\.md$/.exec(relative);
    if (!match || !await containedPath(root, file)) throw new Error('Task must be inside the repository .dag/<dag-id>/tasks directory');
    const document = await read(file), task = document.data;
    errors.push(...contractErrors(document));
    if (errors.length) return result;
    if (task.id !== match[2] || task.dag_id !== match[1]) fail('TASK_IDENTITY', 'Task ID/dag_id must match the filename and directory');
    const names = await readdir(path.dirname(file));
    if (names.filter(name => name.startsWith(`${task.id}-`) && name.endsWith('.md')).length !== 1) fail('TASK_AMBIGUOUS', 'Multiple files share the selected Task ID');
    const dagFile = path.resolve(path.dirname(file), '../DAG.md');
    if (!await containedPath(root, dagFile)) throw new Error('DAG metadata escapes repository');
    const dag = await read(dagFile);
    if (dag.data.dag_id !== task.dag_id || !Number.isSafeInteger(dag.data.revision) || dag.data.revision < 1) fail('DAG_IDENTITY', 'Invalid DAG identity or revision');
    result.task_id = task.id; result.dag_id = task.dag_id; result.revision = dag.data.revision;
    result.contract_sha256 = contractHash(document);
    if (revision !== undefined && revision !== dag.data.revision) fail('REVISION_MISMATCH', 'Expected DAG revision differs from current revision');
    const head = await git(root, 'rev-parse', '--verify', 'HEAD');
    const branch = await git(root, 'rev-parse', '--abbrev-ref', 'HEAD');
    const dirty = dirtyEntries(await git(root, 'status', '--porcelain=v1', '-z', '--untracked-files=all'));
    result.baseline = { head, branch, dirty_at_start: dirty };
    if (task.status === 'DONE') { result.no_op = true; warn('ALREADY_DONE', 'Return the existing handoff without writing or rerunning'); return result; }
    if (task.status === 'SUPERSEDED') { fail('TASK_SUPERSEDED', 'Do not run or select a replacement automatically'); return result; }
    if (!['CONFIRMED', 'IN_PROGRESS'].includes(dag.data.status)) fail('DAG_NOT_EXECUTABLE', `DAG status ${dag.data.status} requires Coordinator review`);
    if (['IN_PROGRESS', 'BLOCKED', 'FAILED'].includes(task.status)) {
      if (!resume) fail('RESUME_REQUIRED', 'Explicit recovery and prior handoff are required');
      else warn('RESUME_HANDOFF_REVIEW', 'Verify the original Session stopped, checkpoint ownership and blocker recovery before writing');
    }
    for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']) {
      const location = path.resolve(root, await git(root, 'rev-parse', '--git-path', marker));
      if (await exists(location)) fail('GIT_OPERATION_IN_PROGRESS', `Unfinished Git operation: ${marker}`);
    }
    if (dirty.some(item => ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(item.kind))) fail('GIT_CONFLICT', 'Unmerged paths must be resolved externally');
    const gitDir = path.resolve(root, await git(root, 'rev-parse', '--git-dir'));
    const commonDir = path.resolve(root, await git(root, 'rev-parse', '--git-common-dir'));
    if (task.execution_mode === 'isolated_worktree' && fold(gitDir) === fold(commonDir)) fail('WORKTREE_REQUIRED', 'Task requires an assigned isolated linked worktree');
    if (task.execution_mode === 'integration') warn('INTEGRATION_REVIEW', 'Verify named artifacts, common baseline, integration order and side effects');
    for (const item of dirty) {
      if (await scopeAllows(task, root, file, item.path)) {
        if (!resume) fail('DIRTY_SCOPE', `Preexisting changes inside write_scope require an ownership handoff: ${item.path}`);
        else warn('DIRTY_SCOPE_REVIEW', `Compare this existing change with Checkpoint hashes/patch; resume is not overwrite permission: ${item.path}`);
      }
    }
    if (!await scopeAllows(task, root, file, relative)) fail('TASK_REPORT_SCOPE', 'Own Task document must be in write_scope for status/report maintenance');
    for (const pattern of [...task.read_scope, ...task.write_scope]) {
      const normalized = path.posix.normalize(pattern.replace(/\\/g, '/'));
      if (path.posix.isAbsolute(normalized) || path.win32.isAbsolute(pattern) || normalized === '..' || normalized.startsWith('../')) fail('SCOPE_PATTERN', 'Scope patterns must stay repository-relative');
    }
    for (const candidate of paths) if (!await scopeAllows(task, root, file, candidate)) fail('WRITE_SCOPE_EXCEEDED', `Write is outside permitted scope: ${candidate}`);
    for (const candidate of readPaths) if (!await scopeAllows(task, root, file, candidate, 'read')) fail('READ_SCOPE_EXCEEDED', `Read is outside permitted scope: ${candidate}`);
    if (new Set(task.depends_on).size !== task.depends_on.length || task.depends_on.includes(task.id)) fail('DEPENDENCY_ID', 'Duplicate or self dependency');
    const producers = new Map();
    for (const id of task.depends_on) {
      const files = names.filter(name => name.startsWith(`${id}-`) && name.endsWith('.md'));
      if (!/^T(?!000)\d{3}$/.test(id) || files.length !== 1) { fail('DEPENDENCY_MISSING', `Dependency ${id} is missing or ambiguous`); continue; }
      const dependencyFile = path.join(path.dirname(file), files[0]);
      if (!await containedPath(root, dependencyFile)) { fail('DEPENDENCY_LOCATION', `Dependency ${id} escapes repository`); continue; }
      const producer = await read(dependencyFile);
      if (producer.data.id !== id || producer.data.dag_id !== task.dag_id || producer.data.status !== 'DONE') fail('DEPENDENCY_NOT_DONE', `Dependency ${id} must be DONE with matching identity`);
      producers.set(id, { ...producer, file: dependencyFile });
      if (!task.inputs.some(input => input.from === id)) fail('DEPENDENCY_UNCONSUMED', `No input consumed from ${id}`);
    }
    for (const input of task.inputs) {
      const located = artifactPath(input.location, file, root);
      if (input.from !== undefined) {
        if (!task.depends_on.includes(input.from)) fail('INPUT_DEPENDENCY', 'Input producer must be declared in depends_on');
        const producer = producers.get(input.from);
        const output = Array.isArray(producer?.data.outputs) ? producer.data.outputs.find(item => item?.name === input.output) : undefined;
        if (!output) fail('DEPENDENCY_OUTPUT', `Missing output ${input.from}.${input.output}`);
        else {
          const origin = artifactPath(output.location, producer.file, root);
          if (!origin || !located || fold(origin.file) !== fold(located.file)) fail('DEPENDENCY_VERSION_LOCATION', 'Input location must match the declared producer artifact');
        }
      }
      if (!located) { fail('EXTERNAL_ARTIFACT_REVIEW', 'Coordinator must make non-file artifact locations available and verify their version'); continue; }
      if (!await containedPath(root, located.file)) { fail('ARTIFACT_ESCAPE', 'Dependency artifact escapes repository'); continue; }
      if (!await exists(located.file)) { fail('DEPENDENCY_ARTIFACT_MISSING', `Required artifact is missing: ${input.location}`); continue; }
      if (located.anchor) {
        const text = await readFile(located.file, 'utf8');
        const headings = [...text.matchAll(/^#+\s+(.+)$/gm)].map(item => slug(item[1]));
        if (!headings.includes(located.anchor)) fail('DEPENDENCY_ANCHOR_MISSING', `Missing artifact section #${located.anchor}`);
      }
    }
    if (contextObservation?.task_id !== undefined && contextObservation.task_id !== task.id || contextObservation?.dag_revision !== undefined && contextObservation.dag_revision !== dag.data.revision) {
      fail('CONTEXT_OBSERVATION_BASELINE', 'Runtime context evidence must match this Task and current DAG revision');
    } else {
      const context = assessContext(task, contextObservation);
      result.context_action = context.action;
      for (const item of context.errors) fail(item.code, item.message);
      for (const item of context.warnings) warn(item.code, item.message);
      if (context.blocked) fail('CONTEXT_BUDGET_EXCEEDED', 'Real capacity or explicit resource limits are insufficient after supported context optimization; save Checkpoint and Split Request');
    }
    warn('SEMANTIC_PREFLIGHT_REVIEW', 'Verify dependency content/version/evidence, host context limits, repository instructions and exclusive ownership; these are not proven by file existence');
    return result;
  } catch (error) {
    fail('READ_OR_PARSE', error.message);
    return { ...result, read_failure: true };
  }
}

async function main() {
  const args = process.argv.slice(2), task = args.shift(), options = { paths: [], readPaths: [] };
  while (args.length) {
    const flag = args.shift();
    if (flag === '--resume') options.resume = true;
    else if (['--revision', '--path', '--read-path', '--context-observation'].includes(flag) && args.length && !args[0].startsWith('--')) {
      const value = args.shift();
      if (flag === '--revision') { options.revision = Number(value); if (!Number.isSafeInteger(options.revision) || options.revision < 1) throw new Error('revision must be a positive integer'); }
      else if (flag === '--context-observation') options.contextObservation = JSON.parse(await readFile(value, 'utf8'));
      else options[flag === '--path' ? 'paths' : 'readPaths'].push(value);
    } else throw new Error('Usage: check_task.mjs <one-task-file> [--revision N] [--resume] [--path file] [--read-path file] [--context-observation JSON-file]');
  }
  const result = await preflight(task, options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.read_failure ? 2 : result.errors.length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 2; });
}
