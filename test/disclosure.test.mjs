/**
 * Tests for the consequence-disclosure layer: the six rule families of
 * *Decision-Relevant Consequence Disclosure in Complex Computing Systems*.
 *
 * Covered here: the rule set's schema and completeness, the action normalizer,
 * predicate evaluation with a declared scope, relevance selection with budget
 * and threshold, both rendering modes, and the observed-vs-predicted verdicts
 * that feed the calibration records.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { normalizeAction } from '../lib/action.js';
import { normalizeConfig } from '../lib/classify.js';
import { renderPreview, renderReport } from '../lib/disclosure.js';
import { createDisclosureEngine } from '../lib/engine.js';
import { createInterestProfile } from '../lib/interest.js';
import { analyzeAction, loadRuleSet, readRuleSet } from '../lib/rules.js';
import { effectiveLoss, selectConsequences } from '../lib/select.js';
import { createCollectors, parseDuration } from '../lib/state.js';

const CWD = '/tmp/pg-test-workspace';

/** Run a short command in a test workspace. */
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `${command} ${args.join(' ')} failed: ${result.stderr}`);
  return result;
}
const ruleSet = readRuleSet();

/** A fake collector table with fixed answers, so unit tests stay deterministic. */
function fakeCollectors(answers = {}) {
  const scopes = { 'vcs.uncommitted': 'fake scope', 'backup.exists': 'fake scope' };
  const table = { scopes, projectRoots: [CWD] };
  for (const [name, answer] of Object.entries(answers)) {
    table[name] = () => answer;
  }
  return table;
}

test('the shipped rule set is valid and every family is represented', () => {
  assert.deepEqual(ruleSet.problems, []);
  assert.ok(ruleSet.rules.length >= 15, `expected a substantial rule set, got ${ruleSet.rules.length}`);
  const ids = ruleSet.rules.map((rule) => rule.id);
  assert.equal(new Set(ids).size, ids.length, 'rule ids must be unique');
  for (const rule of ruleSet.rules) {
    assert.ok(['high', 'medium', 'low'].includes(rule.consequence.severity), `${rule.id} severity`);
    assert.ok(['low', 'medium', 'high'].includes(rule.consequence.recoverability), `${rule.id} recoverability`);
    assert.equal(typeof rule.disclosure.life, 'string');
  }
  const types = new Set(ruleSet.rules.map((rule) => rule.action.type));
  for (const expected of ['fs.delete', 'fs.overwrite', 'process.kill', 'network.change', 'network.egress', 'service.change', 'package.install', 'resource.exhaust', 'disk.change', 'power.change', 'agent.spawn']) {
    assert.ok(types.has(expected), `rule set covers ${expected}`);
  }
});

test('loadRuleSet reports schema problems instead of throwing', () => {
  const broken = loadRuleSet('version: 1\nrules:\n  - id: X\n    action: {type: fs.delete}\n');
  assert.ok(broken.problems.some((problem) => problem.includes('consequence')));
});

test('the action normalizer types tool calls without knowing any agent', () => {
  const cases = [
    ['bash', { command: 'rm -rf build' }, 'fs.delete'],
    ['bash', { command: 'rm notes.txt' }, 'fs.delete'],
    ['bash', { command: 'mv a.txt b.txt' }, 'fs.move'],
    ['bash', { command: 'echo hi > out.txt' }, 'fs.overwrite'],
    ['bash', { command: 'sed -i "" s/a/b/ file.txt' }, 'fs.overwrite'],
    ['bash', { command: 'killall Safari' }, 'process.kill'],
    ['bash', { command: 'curl https://example.com' }, 'network.egress'],
    ['bash', { command: 'git push origin main' }, 'network.egress'],
    ['bash', { command: 'networksetup -setairportpower en0 off' }, 'network.change'],
    ['bash', { command: 'brew install jq' }, 'package.install'],
    ['bash', { command: 'npm install -g typescript' }, 'package.install'],
    ['bash', { command: 'dd if=/dev/zero of=big.img bs=1m' }, 'resource.exhaust'],
    ['bash', { command: 'mkfs.ext4 /dev/disk2' }, 'disk.change'],
    ['bash', { command: 'shutdown -h now' }, 'power.change'],
    ['bash', { command: 'pkill -f "DeepSeek Harness"' }, 'session.kill'],
    ['bash', { command: 'node -e "x()"' }, 'exec.uninspectable'],
    ['write', { file_path: 'lib/a.js', content: 'x' }, 'fs.overwrite'],
    ['read', { file_path: 'lib/a.js' }, 'fs.read'],
    ['subagent', { prompt: 'x' }, 'agent.spawn'],
    ['run_code', { code: 'x' }, 'exec.uninspectable'],
    ['plugin_manager', { action: 'list_plugins' }, 'config.change']
  ];
  for (const [tool, args, expected] of cases) {
    assert.equal(normalizeAction({ tool, args, cwd: CWD }).type, expected, `${tool} ${JSON.stringify(args)}`);
  }
});

test('a rule fires only when its declared state predicates hold', () => {
  const action = normalizeAction({ tool: 'bash', args: { command: 'rm notes.txt' }, cwd: CWD });
  const interest = createInterestProfile({ config: normalizeConfig({}), cwd: CWD });

  const dirty = analyzeAction(
    { ruleSet, collectors: fakeCollectors({ 'vcs.uncommitted': { value: true, confidence: 0.9, detail: 'dirty' }, 'backup.exists': { value: false, confidence: 0.7, detail: 'no backup' } }), interest },
    action
  );
  assert.deepEqual(dirty.consequences.map((entry) => entry.ruleId), ['R-FILE-DEL-01']);
  assert.match(dirty.consequences[0].interest.item, /notes\.txt/, '${target} must be substituted');
  assert.match(dirty.consequences[0].options[0].loss, /notes\.txt/);

  const clean = analyzeAction(
    { ruleSet, collectors: fakeCollectors({ 'vcs.uncommitted': { value: false, fingerprint: '', confidence: 0.9, detail: 'clean' }, 'backup.exists': { value: false, confidence: 0.7, detail: 'no backup' }, 'path.is_build_artifact': { value: false, fingerprint: 'generated:no', confidence: 0.8, detail: 'not generated output' } }), interest },
    action
  );
  assert.deepEqual(clean.consequences.map((entry) => entry.ruleId), ['R-FILE-DEL-02']);
});

test('an undecidable predicate leaves the rule unfired and is reported as coverage', () => {
  const action = normalizeAction({ tool: 'bash', args: { command: 'rm notes.txt' }, cwd: CWD });
  const interest = createInterestProfile({ config: normalizeConfig({}), cwd: CWD });
  const result = analyzeAction(
    { ruleSet, collectors: fakeCollectors({ 'vcs.uncommitted': { value: null, confidence: 0, detail: 'not a repository' } }), interest },
    action
  );
  assert.deepEqual(result.consequences, []);
  assert.ok(result.undecided.some((entry) => entry.includes('R-FILE-DEL-01')), 'undecided predicate is reported');
});

test('effective loss follows (1 - ρ)L + r', () => {
  assert.ok(effectiveLoss({ severity: 'high', recoverability: 'low' }) > effectiveLoss({ severity: 'high', recoverability: 'high' }));
  assert.ok(effectiveLoss({ severity: 'medium', recoverability: 'medium' }) < effectiveLoss({ severity: 'high', recoverability: 'medium' }));
});

test('relevance selection respects budget, threshold and the coverage line', () => {
  const interest = createInterestProfile({ config: normalizeConfig({}), cwd: CWD });
  const consequences = [
    { ruleId: 'A', severity: 'high', recoverability: 'low', confidence: 0.9, nonObviousness: 0.9, interest: interest.item('data_work', 'x'), options: [], disclosure: { life: 'a' } },
    { ruleId: 'B', severity: 'low', recoverability: 'high', confidence: 0.2, nonObviousness: 0.2, interest: interest.item('privacy', 'y'), options: [], disclosure: { life: 'b' } }
  ];
  const selection = selectConsequences({ consequences, interest, budget: 1, threshold: 0.15, checkedScope: ['vcs.uncommitted'], undecided: ['R-X: git unavailable'] });
  assert.equal(selection.selected.length, 1);
  assert.equal(selection.selected[0].ruleId, 'A');
  assert.equal(selection.coverage.checked[0], 'vcs.uncommitted');
  assert.equal(selection.coverage.unverified[0], 'R-X: git unavailable');
  assert.equal(selection.coverage.dropped, 1);
  assert.ok(selection.selected[0].score > 0);

  const below = selectConsequences({ consequences, interest, budget: 3, threshold: 0.99, checkedScope: [] });
  assert.equal(below.selected.length, 0, 'an action below τ produces no disclosure');
});

test('preview renders the paper 5.3 fields in both languages', () => {
  const analysis = {
    action: { type: 'fs.delete', target: 'notes.txt' },
    selected: [{
      ruleId: 'R-FILE-DEL-01',
      severity: 'high',
      recoverability: 'low',
      confidence: 0.9,
      evidence: ['uncommitted modifications found'],
      interest: { dimension: 'data_work', item: 'uncommitted work in notes.txt', weight: 1 },
      options: [{ id: 'execute', loss: 'the work' }, { id: 'reject', loss: 'the step' }],
      disclosure: { life: 'This file holds changes you have not saved elsewhere.', lifeZh: '这个文件里有你还没别处保存的改动。', technical: 'dirty in vcs', technicalZh: '版本控制中已修改' }
    }],
    coverage: { checked: ['vcs.uncommitted'], unverified: [] }
  };
  const zh = renderPreview(analysis, { lang: 'zh' });
  assert.match(zh, /决策前披露/);
  assert.match(zh, /fs\.delete → notes\.txt/);
  assert.match(zh, /这个文件里有你还没别处保存的改动/);
  assert.match(zh, /严重度/);
  assert.match(zh, /选项/);
  assert.match(zh, /已检查/);
  const en = renderPreview(analysis, { lang: 'en' });
  assert.match(en, /Preview/);
  assert.match(en, /This file holds changes/);
  assert.equal(renderPreview({ action: analysis.action, selected: [], coverage: analysis.coverage }), undefined, 'nothing relevant means no disclosure');
});

test('report renders match, false alarm and unpredicted change', () => {
  const base = {
    action: { type: 'fs.delete', target: 'notes.txt' },
    coverage: { checked: ['vcs.uncommitted'], unverified: [] },
    recordPath: '/tmp/reports.jsonl',
    recover: 'git checkout -- notes.txt'
  };
  const consequence = {
    ruleId: 'R-FILE-DEL-01',
    severity: 'high',
    recoverability: 'low',
    confidence: 0.9,
    interest: { dimension: 'data_work', item: 'work', weight: 1 },
    options: [],
    disclosure: { life: 'loss', lifeZh: '损失' }
  };
  const matched = renderReport({ ...base, selected: [consequence], observed: [{ ...consequence, verdict: 'match' }] }, { lang: 'zh' });
  assert.match(matched, /执行后披露/);
  assert.match(matched, /1 命中/);
  assert.match(matched, /你现在可以/);

  const falseAlarm = renderReport({ ...base, selected: [consequence], observed: [{ ...consequence, verdict: 'falseAlarm' }] }, { lang: 'zh' });
  assert.equal(falseAlarm, undefined, 'a prediction that did not come true says nothing');

  const miss = renderReport({
    ...base,
    selected: [consequence],
    observed: [
      { ...consequence, verdict: 'falseAlarm' },
      { ruleId: 'observed-without-prediction', disclosure: { life: 'unpredicted', lifeZh: '未预测的变化' }, verdict: 'miss' }
    ]
  }, { lang: 'zh' });
  assert.match(miss, /1 未预测到/);
});

test('generated output does not count as unrecoverable loss', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pg-artifact-'));
  try {
    const collectors = createCollectors({ home: tmpdir(), cwd: dir, projectRoots: [dir], insideProject: () => true });
    assert.equal(collectors['path.is_build_artifact']('node_modules/left-pad/index.js').value, true);
    assert.equal(collectors['path.is_build_artifact']('dist/bundle.js').value, true);
    assert.equal(collectors['path.is_build_artifact']('build.log').value, true);
    assert.equal(collectors['path.is_build_artifact']('src/main.js').value, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('only material consequences earn an unsolicited report', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'pg-quiet-'));
  try {
    const policy = { config: normalizeConfig({ projectRoots: [workspace], includeSessionCwd: false }), rootsFor: () => [workspace] };
    const engine = createDisclosureEngine({ policy });
    const session = { header: { cwd: workspace } };
    // process.kill is medium severity: a preview, but no unsolicited report.
    const medium = engine.analyze({ tool: 'bash', args: { command: 'killall Safari' }, cwd: workspace, session });
    assert.ok(medium.selected.length > 0, 'the preview still exists');
    assert.ok(medium.selected.every((entry) => entry.severity !== 'high'));
    assert.equal(engine.report({ analysis: medium, cwd: workspace, session }), undefined);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('parseDuration understands the schema shorthand', () => {
  assert.equal(parseDuration('7d'), 7 * 86_400_000);
  assert.equal(parseDuration('30m'), 30 * 60_000);
  assert.equal(parseDuration(500), 500);
  assert.equal(parseDuration('nonsense'), undefined);
});

test('collectors declare their scope and answer from the real workspace', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pg-state-'));
  try {
    const collectors = createCollectors({ home: tmpdir(), cwd: dir, projectRoots: [dir], insideProject: () => true });
    const untracked = collectors['vcs.uncommitted']('file.txt');
    assert.equal(untracked.value, null, 'a directory outside version control is unknown, not false');
    assert.match(collectors.scopes['vcs.uncommitted'], /version control/);

    writeFileSync(join(dir, 'a.txt'), 'x');
    assert.equal(collectors['path.exists']('a.txt').value, true);
    assert.equal(collectors['path.exists']('missing.txt').value, false);
    assert.equal(collectors['backup.exists']('a.txt').value, false);
    writeFileSync(join(dir, 'a.txt.bak'), 'x');
    assert.equal(collectors['backup.exists']('a.txt').value, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the engine end to end: preview, execution, report and record', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'pg-engine-'));
  try {
    const policy = { config: normalizeConfig({ projectRoots: [workspace], includeSessionCwd: false }), rootsFor: () => [workspace] };
    const engine = createDisclosureEngine({ policy });
    const session = { header: { cwd: workspace, id: 'test-session' } };
    const cwd = workspace;

    // A plain overwrite of a file that is not in version control produces
    // nothing: no state, no consequence, no disclosure.
    const quiet = engine.analyze({ tool: 'write', args: { file_path: 'a.txt', content: 'x' }, cwd, session });
    assert.equal(quiet.selected.length, 0);

    // A catastrophic action is disclosed even when no state can be collected.
    const catastrophe = engine.analyze({ tool: 'bash', args: { command: 'mkfs.ext4 /dev/disk2' }, cwd, session });
    assert.ok(catastrophe.selected.length > 0, 'the destructive action is disclosed');
    assert.match(engine.preview(catastrophe, 'zh'), /决策前披露/);
    assert.equal(engine.report({ analysis: catastrophe, cwd, session }), undefined, 'nothing changed, so nothing is reported');

    // The real case: uncommitted work is destroyed. Preview, then a report that
    // says the prediction came true, plus one JSONL calibration record.
    run('git', ['init', '-q', '.'], workspace);
    run('git', ['config', 'user.email', 'guard@test'], workspace);
    run('git', ['config', 'user.name', 'guard'], workspace);
    writeFileSync(join(workspace, 'notes.txt'), 'committed\n');
    run('git', ['add', '.'], workspace);
    run('git', ['commit', '-qm', 'init'], workspace);
    writeFileSync(join(workspace, 'notes.txt'), 'committed\nunsaved\n');

    const loss = engine.analyze({ tool: 'bash', args: { command: 'rm notes.txt' }, cwd, session });
    assert.deepEqual(loss.selected.map((entry) => entry.ruleId), ['R-FILE-DEL-01']);
    assert.match(engine.preview(loss, 'zh'), /notes\.txt/);

    rmSync(join(workspace, 'notes.txt'));
    const built = engine.report({ analysis: loss, cwd, session, sessionId: 'test-session' });
    assert.ok(built !== undefined, 'the loss is reported');
    assert.match(built.rendered, /1 命中/);
    const line = readFileSync(built.recordPath, 'utf8').trim().split('\n').at(-1);
    const record = JSON.parse(line);
    assert.equal(record.session, 'test-session');
    assert.deepEqual(record.observed, [{ ruleId: 'R-FILE-DEL-01', verdict: 'match' }]);
    assert.ok(record.predicted.length > 0);
    assert.ok(record.coverage.weights.length > 0);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('generated output does not count as unrecoverable loss', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pg-artifact-'));
  try {
    const collectors = createCollectors({ home: tmpdir(), cwd: dir, projectRoots: [dir], insideProject: () => true });
    assert.equal(collectors['path.is_build_artifact']('node_modules/left-pad/index.js').value, true);
    assert.equal(collectors['path.is_build_artifact']('dist/bundle.js').value, true);
    assert.equal(collectors['path.is_build_artifact']('build.log').value, true);
    assert.equal(collectors['path.is_build_artifact']('src/main.js').value, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('only material consequences earn an unsolicited report', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'pg-quiet-'));
  try {
    const policy = { config: normalizeConfig({ projectRoots: [workspace], includeSessionCwd: false }), rootsFor: () => [workspace] };
    const engine = createDisclosureEngine({ policy });
    const session = { header: { cwd: workspace } };
    // process.kill is medium severity: a preview, but no unsolicited report.
    const medium = engine.analyze({ tool: 'bash', args: { command: 'killall Safari' }, cwd: workspace, session });
    assert.ok(medium.selected.length > 0, 'the preview still exists');
    assert.ok(medium.selected.every((entry) => entry.severity !== 'high'));
    assert.equal(engine.report({ analysis: medium, cwd: workspace, session }), undefined);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('parseDuration understands the schema shorthand', () => {
  assert.equal(parseDuration('7d'), 7 * 86_400_000);
  assert.equal(parseDuration('30m'), 30 * 60_000);
  assert.equal(parseDuration(500), 500);
  assert.equal(parseDuration('nonsense'), undefined);
});

test('collectors declare their scope and answer from the real workspace', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pg-state-'));
  try {
    const collectors = createCollectors({ home: tmpdir(), cwd: dir, projectRoots: [dir], insideProject: () => true });
    const untracked = collectors['vcs.uncommitted']('file.txt');
    assert.equal(untracked.value, null, 'a directory outside version control is unknown, not false');
    assert.match(collectors.scopes['vcs.uncommitted'], /version control/);

    writeFileSync(join(dir, 'a.txt'), 'x');
    assert.equal(collectors['path.exists']('a.txt').value, true);
    assert.equal(collectors['path.exists']('missing.txt').value, false);
    assert.equal(collectors['backup.exists']('a.txt').value, false);
    writeFileSync(join(dir, 'a.txt.bak'), 'x');
    assert.equal(collectors['backup.exists']('a.txt').value, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

