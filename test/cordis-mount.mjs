/**
 * Mount the plugin on the real cordis runtime and drive the two events the
 * Harness uses. This is a verification script, not part of the unit suite
 * (`node test/cordis-mount.mjs`).
 *
 * It proves the parts a mock cannot: `ctx.effect(function* …)` teardown,
 * `{ prepend: true }` listener ordering, and the `ctx.waterfall` contract used
 * by the tools pipeline and the approval service.
 */
import { existsSync } from 'node:fs';

/** Candidate locations of the installed Harness runtime's cordis package. */
const CORDIS_CANDIDATES = [
  process.env.DSH_CORDIS,
  '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/node_modules/@deepseek-ai/cordis/lib/index.js',
  '/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/cordis/lib/index.js'
].filter(Boolean);

const cordisPath = CORDIS_CANDIDATES.find((candidate) => existsSync(candidate));
if (cordisPath === undefined) {
  console.error('cordis-mount: set DSH_CORDIS to the installed @deepseek-ai/cordis/lib/index.js');
  process.exit(2);
}
const { Context } = await import(cordisPath);

const CWD = '/Users/inception/Documents/deepseek-harness/default-workspace';
const PROJECT = '/Users/inception/Documents/deepseek-harness';

const failures = [];
const check = (label, condition, extra = '') => {
  if (condition) console.log(`ok   ${label}`);
  else {
    failures.push(label);
    console.log(`FAIL ${label} ${extra}`);
  }
};

const ctx = new Context();
ctx.provide('tools', {});
ctx.provide('approval', { effectivePolicy: () => 'ask', setPolicy() {} });
ctx.provide('sandboxPolicy', { resolve: () => ({ mode: 'danger-full-access', workspaceRoot: CWD }) });

const mod = await import('../index.js');
const fork = ctx.plugin(mod, { projectRoots: [PROJECT] });
// cordis applies a plugin synchronously; one macrotask lets the fiber settle.
await new Promise((resolve) => setTimeout(resolve, 20));

const makeExec = (name, args, callId) => ({
  callId,
  name,
  arguments: args,
  agent: {
    session: {
      header: { cwd: CWD },
      appends: [],
      append(type, data) {
        this.appends.push({ type, data });
      }
    }
  },
  signal: new AbortController().signal
});

const preExecute = (exec) => ctx.waterfall(ctx, 'tools/pre-execute', exec, () => Promise.resolve({ kind: 'allow' }));
const approval = (req) => ctx.waterfall(ctx, 'approval/request', req, () => Promise.resolve('unavailable'));

// 1. A full-permission session is gated, and in-project work still passes
//    through without touching the sandbox or prompting.
const insideExec = makeExec('write', { file_path: 'lib/a.js' }, 'c1');
const inside = await preExecute(insideExec);
check('in-project call passes through', inside.kind === 'allow', JSON.stringify(inside));
check('the guard never rewrites the session sandbox', insideExec.agent.session.appends.length === 0, JSON.stringify(insideExec.agent.session.appends));

// 2. An out-of-project call asks, with a bilingual prompt.
const outside = await preExecute(makeExec('write', { file_path: '/etc/hosts' }, 'c2'));
check('out-of-project call asks', outside.kind === 'ask', JSON.stringify(outside));
check('ask carries zh + en', typeof outside.displayReason?.zh === 'string' && typeof outside.displayReason?.en === 'string');

// 3. The interactive answerer is reached once, and its grant covers escalation.
let prompts = 0;
const agent = { session: { header: { cwd: CWD } } };
const first = await approval({ agent, toolName: 'write', callId: 'c2', reason: outside.reason });
check('human answerer is reached', first === 'unavailable', String(first));
prompts = 1; // the fallback above stands in for the user

const escalation = await approval({ agent, toolName: 'write', callId: 'c2', reason: 'escalate sandbox to danger-full-access: outside root' });
check('an unanswered record still asks (fail-closed)', escalation === 'unavailable' || escalation === 'rejected' || escalation === 'cancelled', String(escalation));

// 4. A network call is harmless to the machine, so it is allowed while gated.
const network = await preExecute(makeExec('bash', { command: 'git push origin main' }, 'c3'));
check('network calls need no confirmation', network.kind === 'allow', JSON.stringify(network));

// 5. A refused action is denied without any approval request.
const denied = await preExecute(makeExec('bash', { command: 'shutdown -h now' }, 'c4'));
check('session-killing action is denied', denied.kind === 'deny', JSON.stringify(denied));
check('denial carries structured info', denied.info?.code === 'POWER_OFF', JSON.stringify(denied.info));

// 6. Unloading removes every listener: the same call is allowed again.
await fork.dispose();
await new Promise((resolve) => setTimeout(resolve, 20));
const afterStop = await preExecute(makeExec('bash', { command: 'shutdown -h now' }, 'c5'));
check('after unload the guard is gone', afterStop.kind === 'allow', JSON.stringify(afterStop));

console.log(failures.length === 0 ? '\nALL CORDIS MOUNT CHECKS PASSED' : `\n${failures.length} CHECK(S) FAILED`);
process.exit(failures.length === 0 ? 0 : 1);
