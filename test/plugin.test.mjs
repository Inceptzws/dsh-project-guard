/**
 * Integration tests for the plugin entry point.
 *
 * These drive `apply()` with a mock Cordis context so the gate, the approval
 * answerer and the single-slot queue are exercised exactly as the Harness
 * calls them, without booting a profile.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { apply, inject, name } from '../index.js';

const CWD = '/Users/inception/Documents/deepseek-harness/default-workspace';
const PROJECT = '/Users/inception/Documents/deepseek-harness';

/** Build a mock context that records listeners and can dispose the plugin. */
function createContext(approvalOverride) {
  const listeners = new Map();
  const disposers = [];
  const effects = [];
  const approval = {
    effectivePolicy: () => approvalOverride ?? 'ask',
    setPolicy: () => {
      approval.setPolicyCalls = (approval.setPolicyCalls ?? 0) + 1;
    },
    setPolicyCalls: 0
  };
  const ctx = {
    logger: { info() {}, warn() {}, debug() {} },
    approval,
    get(service) {
      return service === 'approval' ? approval : undefined;
    },
    on(event, listener, options) {
      const entry = { listener, options };
      listeners.set(event, [...(listeners.get(event) ?? []), entry]);
      const off = () => {
        const bucket = listeners.get(event) ?? [];
        listeners.set(event, bucket.filter((item) => item !== entry));
      };
      disposers.push(off);
      return off;
    },
    effect(callback) {
      const iterator = callback();
      const yielded = [];
      let step = iterator.next();
      while (!step.done) {
        yielded.push(step.value);
        step = iterator.next();
      }
      effects.push(yielded);
      return () => {
        for (const dispose of [...yielded].reverse()) {
          if (typeof dispose === 'function') dispose();
        }
      };
    },
    listeners,
    dispose() {
      for (const dispose of [...disposers].reverse()) dispose();
    }
  };
  return ctx;
}

/** Return the registered listener for one event. */
function listenerFor(ctx, event) {
  const entries = ctx.listeners.get(event) ?? [];
  assert.equal(entries.length, 1, `expected exactly one ${event} listener`);
  return entries[0];
}

/** Build a fake tool execution record. */
function execution(toolName, args, callId = 'call-1') {
  const session = { header: { cwd: CWD } };
  return { callId, name: toolName, arguments: args, agent: { session } };
}

test('the plugin exports the ids the loader expects', () => {
  assert.equal(name, 'project-guard');
  assert.deepEqual(inject, ['tools', 'approval']);
});

test('in-project calls pass straight through', async () => {
  const ctx = createContext();
  apply(ctx, { projectRoots: [PROJECT] });
  const gate = listenerFor(ctx, 'tools/pre-execute');
  assert.equal(gate.options.prepend, true);

  let reached = false;
  const decision = await gate.listener(execution('write', { file_path: 'lib/x.js' }), async () => {
    reached = true;
    return { kind: 'allow' };
  });
  assert.equal(reached, true);
  assert.deepEqual(decision, { kind: 'allow' });
});

test('out-of-project calls ask, and in-project escalation is granted silently', async () => {
  const ctx = createContext();
  apply(ctx, { projectRoots: [PROJECT] });
  const gate = listenerFor(ctx, 'tools/pre-execute');
  const answerer = listenerFor(ctx, 'approval/request');
  assert.equal(answerer.options.prepend, true);

  // 1. An out-of-project write asks with a bilingual prompt.
  const outsideCall = execution('write', { file_path: '/etc/hosts' }, 'call-out');
  const decided = await gate.listener(outsideCall, async () => ({ kind: 'allow' }));
  assert.equal(decided.kind, 'ask');
  assert.equal(typeof decided.displayReason.en, 'string');
  assert.equal(typeof decided.displayReason.zh, 'string');

  // 2. The ask reaches the user through the interactive answerer exactly once.
  let humanPrompts = 0;
  const request = { agent: outsideCall.agent, toolName: 'write', callId: 'call-out', reason: decided.reason, displayReason: decided.displayReason };
  const outcome = await answerer.listener(request, async () => {
    humanPrompts += 1;
    return 'allowed-once';
  });
  assert.equal(outcome, 'allowed-once');
  assert.equal(humanPrompts, 1);

  // 3. The escalation the tool requests afterwards reuses that confirmation.
  const escalated = await answerer.listener(
    { ...request, reason: 'escalate sandbox to danger-full-access: needed for the operation' },
    async () => {
      humanPrompts += 1;
      return 'allowed-once';
    }
  );
  assert.equal(escalated, 'allowed-once');
  assert.equal(humanPrompts, 1, 'the confirmed call must not prompt twice');

  // 4. An in-project call never prompts for its escalation.
  const insideCall = execution('bash', { command: 'pnpm install' }, 'call-in');
  let allowed = false;
  await gate.listener(insideCall, async () => {
    allowed = true;
    return { kind: 'allow' };
  });
  assert.equal(allowed, true);
  const inProject = await answerer.listener(
    { agent: insideCall.agent, toolName: 'bash', callId: 'call-in', reason: 'escalate sandbox to danger-full-access: install' },
    async () => {
      humanPrompts += 1;
      return 'allowed-once';
    }
  );
  assert.equal(inProject, 'allowed-once');
  assert.equal(humanPrompts, 1);
});

test('destructive system commands are denied with structured detail', async () => {
  const ctx = createContext();
  apply(ctx, { projectRoots: [PROJECT] });
  const gate = listenerFor(ctx, 'tools/pre-execute');
  const decision = await gate.listener(execution('bash', { command: 'networksetup -setairportpower en0 off' }), async () => ({ kind: 'allow' }));
  assert.equal(decision.kind, 'deny');
  assert.equal(decision.info.name, 'ProjectGuardDeniedError');
  assert.equal(decision.info.code, 'NETWORK_OFF');
});

test('only one confirmation is outstanding at a time', async () => {
  const ctx = createContext();
  apply(ctx, { projectRoots: [PROJECT] });
  const gate = listenerFor(ctx, 'tools/pre-execute');
  const answerer = listenerFor(ctx, 'approval/request');

  const calls = ['a', 'b', 'c'];
  const agents = new Map();
  for (const id of calls) {
    const call = execution('bash', { command: `cat /etc/${id}` }, id);
    agents.set(id, call.agent);
    await gate.listener(call, async () => ({ kind: 'allow' }));
  }

  let live = 0;
  let peak = 0;
  const order = [];
  const prompt = async (id) => answerer.listener(
    { agent: agents.get(id), toolName: 'bash', callId: id, reason: 'outside' },
    async () => {
      live += 1;
      peak = Math.max(peak, live);
      order.push(`open:${id}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      live -= 1;
      order.push(`close:${id}`);
      return 'allowed-once';
    }
  );

  await Promise.all(calls.map((id) => prompt(id)));
  assert.equal(peak, 1, 'no two confirmations may overlap');
  assert.deepEqual(order, ['open:a', 'close:a', 'open:b', 'close:b', 'open:c', 'close:c']);
});

test('an approval is switched to the ask policy when it was never', async () => {
  const ctx = createContext('never');
  apply(ctx, { projectRoots: [PROJECT], enforceAskPolicy: true });
  const gate = listenerFor(ctx, 'tools/pre-execute');
  await gate.listener(execution('bash', { command: 'ls' }), async () => ({ kind: 'allow' }));
  assert.equal(ctx.approval.setPolicyCalls, 1);
});

test('the ask policy is left alone when it is already ask', async () => {
  const ctx = createContext('ask');
  apply(ctx, { projectRoots: [PROJECT] });
  const gate = listenerFor(ctx, 'tools/pre-execute');
  await gate.listener(execution('bash', { command: 'ls' }), async () => ({ kind: 'allow' }));
  assert.equal(ctx.approval.setPolicyCalls, 0);
});

test('a disabled plugin registers nothing', () => {
  const ctx = createContext();
  apply(ctx, { enabled: false });
  assert.equal((ctx.listeners.get('tools/pre-execute') ?? []).length, 0);
});

test('records are dropped once the call has a result', async () => {
  const ctx = createContext();
  apply(ctx, { projectRoots: [PROJECT] });
  const gate = listenerFor(ctx, 'tools/pre-execute');
  const answerer = listenerFor(ctx, 'approval/request');
  const results = listenerFor(ctx, 'tools/result');

  const call = execution('bash', { command: 'cat /etc/hosts' }, 'call-x');
  await gate.listener(call, async () => ({ kind: 'allow' }));
  results.listener(call, { isError: false });

  // With the record gone the request is treated as unknown and still asks.
  let prompted = false;
  const outcome = await answerer.listener(
    { agent: call.agent, toolName: 'bash', callId: 'call-x', reason: 'escalate sandbox to danger-full-access: x' },
    async () => {
      prompted = true;
      return 'rejected';
    }
  );
  assert.equal(outcome, 'rejected');
  assert.equal(prompted, true);
});

test('unload drops queued confirmations instead of hanging them', async () => {
  const ctx = createContext();
  const dispose = apply(ctx, { projectRoots: [PROJECT] });
  void dispose;
  const gate = listenerFor(ctx, 'tools/pre-execute');
  const answerer = listenerFor(ctx, 'approval/request');
  const call = execution('bash', { command: 'cat /etc/hosts' }, 'call-q');
  await gate.listener(call, async () => ({ kind: 'allow' }));

  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const first = answerer.listener({ agent: call.agent, toolName: 'bash', callId: 'call-q', reason: 'outside' }, async () => {
    await held;
    return 'allowed-once';
  });
  const second = answerer.listener({ agent: call.agent, toolName: 'bash', callId: 'call-q', reason: 'outside' }, async () => 'allowed-once');
  await new Promise((resolve) => setTimeout(resolve, 1));
  release();
  assert.equal(await first, 'allowed-once');
  assert.equal(await second, 'allowed-once');
});
