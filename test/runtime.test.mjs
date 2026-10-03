/**
 * Tests for the shell reader and the single-slot approval queue.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { argumentsOf, parseShellCommand, programOf } from '../lib/shell-parse.js';
import { createApprovalQueue } from '../lib/approval-queue.js';

test('segments and programs are read across separators', () => {
  const parsed = parseShellCommand('ls -la && cat a.txt | grep x; pnpm install');
  assert.deepEqual(parsed.segments.map((segment) => programOf(segment)), ['ls', 'cat', 'grep', 'pnpm']);
  assert.deepEqual(argumentsOf(parsed.segments[3]), ['install']);
});

test('environment assignments are not treated as programs', () => {
  const parsed = parseShellCommand('FOO=1 BAR=2 node script.js');
  assert.equal(programOf(parsed.segments[0]), 'node');
  assert.deepEqual(argumentsOf(parsed.segments[0]), ['script.js']);
});

test('quoted text stays one word and quotes are removed', () => {
  const parsed = parseShellCommand('echo "hello world" \'single quoted\'');
  assert.deepEqual(argumentsOf(parsed.segments[0]), ['hello world', 'single quoted']);
});

test('redirections are collected as paths, file descriptors are not', () => {
  const parsed = parseShellCommand('node build.js > out.log 2>&1 < input.json');
  assert.ok(parsed.paths.includes('out.log'));
  assert.ok(parsed.paths.includes('input.json'));
  assert.ok(!parsed.paths.includes('&1'));
  assert.ok(!parsed.paths.includes('2'));
});

test('well-formed heredoc bodies are skipped', () => {
  const parsed = parseShellCommand("cat > note.txt <<'EOF'\nrm -rf /\n/etc/passwd\nEOF\n");
  assert.equal(parsed.segments.length, 1);
  assert.equal(programOf(parsed.segments[0]), 'cat');
  assert.ok(parsed.paths.includes('note.txt'));
  assert.ok(!parsed.paths.includes('/etc/passwd'));
  assert.ok(!parsed.paths.some((entry) => entry === '/'));
});

test('command substitution and inline interpreters are flagged', () => {
  assert.equal(parseShellCommand('echo $(date)').substitutions, true);
  assert.equal(parseShellCommand('echo `date`').substitutions, true);
  assert.equal(parseShellCommand('bash -c "ls"').uncertain, true);
  assert.equal(parseShellCommand('python3 -c "print(1)"').uncertain, true);
  assert.equal(parseShellCommand('node -e "1"').uncertain, true);
  assert.equal(parseShellCommand('node script.js').uncertain, false);
});

test('unbalanced quotes are reported', () => {
  assert.equal(parseShellCommand('echo "oops').unbalanced, true);
  assert.equal(parseShellCommand("echo 'oops").unbalanced, true);
  assert.equal(parseShellCommand('echo "fine"').unbalanced, false);
});

test('one approval slot is granted at a time', async () => {
  const queue = createApprovalQueue(true);
  const order = [];
  const run = async (name) => {
    const granted = await queue.acquire(undefined, false);
    assert.equal(granted, true);
    try {
      order.push(`start:${name}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push(`end:${name}`);
    } finally {
      queue.release();
    }
  };
  await Promise.all([run('a'), run('b'), run('c')]);
  assert.deepEqual(order, ['start:a', 'end:a', 'start:b', 'end:b', 'start:c', 'end:c']);
});

test('waiting system requests take the slot before ordinary ones', async () => {
  const queue = createApprovalQueue(true);
  const order = [];
  const holder = await queue.acquire(undefined, false);
  assert.equal(holder, true);

  const run = async (name, priority) => {
    const granted = await queue.acquire(undefined, priority);
    assert.equal(granted, true);
    try {
      order.push(name);
    } finally {
      queue.release();
    }
  };

  const both = Promise.all([run('ordinary', false), run('system', true)]);
  queue.release(); // frees the artificial holder; the system waiter should win
  await both;

  assert.deepEqual(order, ['system', 'ordinary']);
});

test('an aborted request never takes the slot', async () => {
  const queue = createApprovalQueue(false);
  const first = await queue.acquire(undefined, false);
  assert.equal(first, true);
  const controller = new AbortController();
  const pending = queue.acquire(controller.signal, false);
  controller.abort();
  assert.equal(await pending, false);
  assert.equal(queue.size, 0);
  queue.release();
});

test('drain releases every waiter when the plugin unloads', async () => {
  const queue = createApprovalQueue(false);
  await queue.acquire(undefined, false);
  const waiting = queue.acquire(undefined, false);
  queue.drain();
  assert.equal(await waiting, true);
  assert.equal(queue.size, 0);
});
