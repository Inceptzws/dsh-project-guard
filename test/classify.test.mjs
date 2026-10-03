/**
 * Behavioural tests for the project guard policy engine.
 *
 * The contract under test:
 *
 * 1. Work that stays inside the workspace does not involve the guard at all —
 *    the sandbox already confines it.
 * 2. The guard engages only for the *extra* permission a call asks for: an
 *    escalation beyond the session mode, or any call while the session itself
 *    runs at full permission.
 * 3. When it engages it allows what cannot disturb the machine or another
 *    program (reads, network, temp and package caches, project work), asks
 *    before a system change or a write outside the project, and refuses the
 *    actions that would damage the machine or cut the session.
 *
 * Run with `node --test test/*.test.mjs`.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createPolicy } from '../lib/classify.js';

const CWD = '/Users/inception/Documents/deepseek-harness/default-workspace';
const PROJECT = '/Users/inception/Documents/deepseek-harness';

const policy = createPolicy({ projectRoots: [PROJECT] });

/** Classify one call the way a full-permission session would. */
const decide = (tool, args, cwd = CWD, mode = 'danger-full-access') => policy.classify({ tool, args, cwd, mode });

/** Assert the decision kind for one call. */
const expectKind = (tool, args, kind, cwd = CWD) => {
  const decision = decide(tool, args, cwd);
  assert.equal(
    decision.kind,
    kind,
    `${tool} ${JSON.stringify(args)}: expected ${kind}, got ${decision.kind} (${decision.code})`
  );
  return decision;
};

test('work inside the workspace never involves the guard', () => {
  const inWorkspace = policy.classify({ tool: 'write', args: { file_path: 'lib/a.js', content: 'x' }, cwd: CWD, mode: 'workspace-write' });
  assert.equal(inWorkspace.engage, false);
  assert.equal(inWorkspace.kind, 'allow');

  const shell = policy.classify({ tool: 'bash', args: { command: 'pnpm install' }, cwd: CWD, mode: 'workspace-write' });
  assert.equal(shell.engage, false);

  const read = policy.classify({ tool: 'read', args: { file_path: '/etc/hosts' }, cwd: CWD, mode: 'workspace-write' });
  assert.equal(read.engage, false);
});

test('the guard engages for an escalation request and for a full-permission session', () => {
  const escalation = policy.classify({
    tool: 'write',
    args: { file_path: 'lib/a.js', content: 'x', sandbox_permissions: 'danger-full-access', justification: 'x' },
    cwd: CWD,
    mode: 'workspace-write'
  });
  assert.equal(escalation.engage, true);

  for (const tool of ['bash', 'write', 'subagent']) {
    const full = policy.classify({ tool, args: {}, cwd: CWD, mode: 'danger-full-access' });
    assert.equal(full.engage, true, `${tool} must be gated in a full-permission session`);
  }
});

test('reads are allowed wherever they point', () => {
  expectKind('read', { file_path: '/etc/hosts' }, 'allow');
  expectKind('read', { file_path: '~/.zshrc' }, 'allow');
  expectKind('read_image', { file_path: '/Applications/DeepSeek Harness.app/icon.png' }, 'allow');
  expectKind('glob', { pattern: '**/*.ts', path: '/opt/other' }, 'allow');
  expectKind('grep', { pattern: 'x', path: '/usr/local' }, 'allow');
  expectKind('bash', { command: 'cat /etc/hosts' }, 'allow');
  expectKind('bash', { command: 'ls -la /usr/local/bin' }, 'allow');
});

test('network and uploads need no confirmation', () => {
  for (const command of [
    'curl https://example.com',
    'wget https://example.com/x.tgz',
    'ssh host uptime',
    'scp file host:/tmp',
    'rsync -a build/ host:/srv',
    'git push origin main',
    'git pull',
    'gh pr list',
    'aws s3 cp build/x.zip s3://bucket/',
    'docker pull node:24',
    'npx some-cli --yes',
    'npm publish',
    'npm cache clean --force'
  ]) {
    expectKind('bash', { command }, 'allow');
  }
});

test('writes inside the project, temp and caches are allowed', () => {
  expectKind('write', { file_path: 'lib/a.js', content: 'x' }, 'allow');
  expectKind('edit', { file_path: `${PROJECT}/lunasilk/x.js`, old_string: 'a', new_string: 'b' }, 'allow');
  expectKind('bash', { command: 'echo hi > /tmp/guard-scratch.txt' }, 'allow');
  expectKind('bash', { command: 'echo cache > ~/.npm/_logs/x.log' }, 'allow');
  expectKind('bash', { command: 'echo c > ~/Library/Caches/thing.txt' }, 'allow');
  expectKind('bash', { command: 'rm -rf node_modules && mkdir -p build' }, 'allow');
});

test('writes outside the project ask', () => {
  expectKind('write', { file_path: '/etc/hosts', content: 'x' }, 'ask');
  expectKind('edit', { file_path: `${CWD}/../../other-project/a.js` }, 'ask');
  expectKind('write', { file_path: '~/.zshrc', content: 'x' }, 'ask');
  expectKind('bash', { command: 'echo x > /usr/local/etc/x.conf' }, 'ask');
  expectKind('bash', { command: 'rm -rf ../../other-project' }, 'ask');
  expectKind('bash', { command: 'cp a.txt ~/Desktop/a.txt' }, 'ask');
  expectKind('bash', { command: 'chmod -R 777 /' }, 'ask');
  expectKind('bash', { command: 'find / -name "*.log" -delete' }, 'ask');
  expectKind('bash', { command: 'tee /etc/motd < a.txt' }, 'ask');
});

test('system changes ask', () => {
  for (const command of [
    'sudo ls /',
    'launchctl list',
    'defaults write com.apple.dock tilesize -int 1',
    'systemsetup -settimezone UTC',
    'scutil --set HostName x',
    'networksetup -listallnetworkservices',
    'ifconfig en0',
    'pmset -a sleep 0',
    'softwareupdate --list',
    'diskutil list',
    'sysctl -a',
    'kill 4321',
    'killall SomeApp',
    'pkill -f helper',
    'brew install jq',
    'pip install requests',
    'osascript -e "tell application \\"Finder\\" to activate"',
    'open -a Safari',
    'xargs rm',
    'crontab -l',
    'npm install -g typescript',
    'git config --global user.name x'
  ]) {
    expectKind('bash', { command }, 'ask');
  }
});

test('read-only system probes are allowed', () => {
  for (const command of ['ps aux', 'sw_vers', 'uname -a', 'lsof -i', 'system_profiler SPHardwareDataType', 'uptime', 'hostname']) {
    expectKind('bash', { command }, 'allow');
  }
});

test('uninspectable commands ask instead of guessing', () => {
  expectKind('bash', { command: 'node -e "require(\'fs\').rmSync(\'/\',{recursive:true})"' }, 'ask');
  expectKind('bash', { command: 'python3 -c "import shutil; shutil.rmtree(\'/\')"' }, 'ask');
  expectKind('bash', { command: '$(which rm) -rf build' }, 'ask');
  expectKind('bash', { command: 'eval "rm -rf build"' }, 'ask');
  expectKind('bash', { command: 'rm $TARGET' }, 'ask');
  expectKind('bash', { command: 'cd $HOME' }, 'ask');
  expectKind('bash', { command: 'echo "unterminated' }, 'ask');
});

test('resource exhaustion asks when it could starve other programs', () => {
  expectKind('bash', { command: 'dd if=/dev/zero of=big.img bs=1m' }, 'ask');
  expectKind('bash', { command: 'yes > big.txt' }, 'ask');
  expectKind('bash', { command: 'cat /dev/zero > big.bin' }, 'ask');
  expectKind('bash', { command: 'while true; do echo x >> log.txt; done' }, 'ask');
  expectKind('bash', { command: 'stress --cpu 8' }, 'ask');
  expectKind('bash', { command: 'python3 -m http.server 8080' }, 'ask');
});

test('machine- and session-destroying actions are refused', () => {
  for (const command of [
    'rm -rf /',
    "bash -c 'rm -rf /'",
    'rm -rf ~',
    'rm -rf $HOME',
    'mkfs.ext4 /dev/disk2',
    'dd if=/dev/zero of=/dev/disk2',
    'diskutil eraseDisk JHFS+ x /dev/disk2',
    'shutdown -h now',
    'reboot',
    'networksetup -setairportpower en0 off',
    'ifconfig en0 down',
    'pfctl -d',
    'killall WindowServer',
    'kill -9 1',
    'pkill -f "DeepSeek Harness"',
    ':(){ :|:& };:'
  ]) {
    expectKind('bash', { command }, 'deny');
  }
});

test('hard protection can be downgraded to a confirmation', () => {
  const relaxed = createPolicy({ projectRoots: [PROJECT], protectSessionAndSystem: false });
  assert.equal(relaxed.classify({ tool: 'bash', args: { command: 'shutdown -h now' }, cwd: CWD, mode: 'danger-full-access' }).kind, 'ask');
});

test('an extra permission for in-project work is granted, one for the outside is not', () => {
  const inside = decide('write', { file_path: 'lib/x.js', content: 'x', sandbox_permissions: 'danger-full-access', justification: 'x' });
  assert.equal(inside.kind, 'allow');
  const outside = decide('write', { file_path: '/etc/x', content: 'x', sandbox_permissions: 'danger-full-access', justification: 'x' });
  assert.equal(outside.kind, 'ask');
  expectKind('bash', { command: 'pnpm install', sandbox_permissions: 'danger-full-access', justification: 'x' }, 'allow');
  expectKind('bash', { command: 'brew install jq', sandbox_permissions: 'danger-full-access', justification: 'x' }, 'ask');
  expectKind('bash', { command: 'ls', workdir: '/etc' }, 'ask');
});

test('neutral tools are allowed and orchestration tools ask', () => {
  for (const tool of ['todo_write', 'ask_user_question', 'present', 'skill', 'job_output', 'web_search', 'web_fetch', 'cordis_inspect_query']) {
    expectKind(tool, {}, 'allow');
  }
  for (const tool of ['subagent', 'workflow', 'spawn_teammate', 'send_message', 'plugin_manager', 'schedule_create', 'run_code']) {
    expectKind(tool, {}, 'ask');
  }
  expectKind('some_mcp_tool', { a: 1 }, 'ask');
});

test('the session workspace is a root by default and can be dropped', () => {
  const sessionOnly = createPolicy({});
  assert.equal(sessionOnly.classify({ tool: 'write', args: { file_path: 'a.txt', content: 'x' }, cwd: CWD, mode: 'danger-full-access' }).kind, 'allow');
  assert.equal(sessionOnly.classify({ tool: 'write', args: { file_path: '/etc/a', content: 'x' }, cwd: CWD, mode: 'danger-full-access' }).kind, 'ask');
});

test('user configuration can widen and narrow the policy', () => {
  const widened = createPolicy({ projectRoots: [PROJECT], allowTools: ['some_mcp_tool'] });
  assert.equal(widened.classify({ tool: 'some_mcp_tool', args: {}, cwd: CWD, mode: 'danger-full-access' }).kind, 'allow');

  const narrowed = createPolicy({ projectRoots: [PROJECT], askTools: ['present'] });
  assert.equal(narrowed.classify({ tool: 'present', args: {}, cwd: CWD, mode: 'danger-full-access' }).kind, 'ask');

  const denied = createPolicy({ projectRoots: [PROJECT], denyTools: ['subagent'] });
  assert.equal(denied.classify({ tool: 'subagent', args: {}, cwd: CWD, mode: 'danger-full-access' }).kind, 'deny');

  const patterns = createPolicy({ projectRoots: [PROJECT], extraAskPatterns: ['deploy-now'] });
  assert.equal(patterns.classify({ tool: 'bash', args: { command: 'echo deploy-now' }, cwd: CWD, mode: 'danger-full-access' }).kind, 'ask');

  const caches = createPolicy({ projectRoots: [PROJECT], cacheRoots: ['~/my-cache'] });
  assert.equal(caches.classify({ tool: 'write', args: { file_path: '~/my-cache/a', content: 'x' }, cwd: CWD, mode: 'danger-full-access' }).kind, 'allow');
  assert.equal(caches.classify({ tool: 'write', args: { file_path: '~/.npm/a', content: 'x' }, cwd: CWD, mode: 'danger-full-access' }).kind, 'ask');
});

test('project roots accept a leading tilde', () => {
  const tilde = createPolicy({ projectRoots: ['~/Documents/deepseek-harness'], includeSessionCwd: false });
  const home = process.env.HOME;
  assert.equal(tilde.classify({ tool: 'write', args: { file_path: `${home}/Documents/deepseek-harness/x.txt`, content: 'x' }, cwd: '/elsewhere', mode: 'danger-full-access' }).kind, 'allow');
  assert.equal(tilde.classify({ tool: 'write', args: { file_path: `${home}/Documents/other/x.txt`, content: 'x' }, cwd: '/elsewhere', mode: 'danger-full-access' }).kind, 'ask');
});

test('remote project roots resolve against symlinks, not just text', () => {
  const decision = decide('write', { file_path: `${PROJECT}/lunasilk/x.txt`, content: 'x' });
  assert.equal(decision.kind, 'allow');
  assert.equal(decision.scope, 'project');
});

test('every confirmation carries an adverse-outcome analysis', () => {
  const decision = decide('bash', { command: 'brew install jq' });
  assert.equal(decision.impact.level, 'medium');
  assert.ok(decision.impact.zh.length > 0);
  assert.ok(decision.impact.en.length > 0);
  assert.equal(decision.system, true);
});

test('the analysis rates the consequences a user must weigh', () => {
  const levels = {
    'network interface down': ['bash', { command: 'ifconfig en0 down' }, 'high'],
    'power off': ['bash', { command: 'reboot' }, 'high'],
    'unbounded write': ['bash', { command: 'dd if=/dev/zero of=./big.img' }, 'high'],
    'disk allocation': ['bash', { command: 'fallocate -l 10g ./big.img' }, 'high'],
    'privileged command': ['bash', { command: 'sudo true' }, 'high'],
    'global install': ['bash', { command: 'npm install -g typescript' }, 'medium'],
    'write outside project': ['write', { file_path: '/etc/hosts', content: 'x' }, 'medium'],
    'port binding': ['bash', { command: 'python3 -m http.server 8080' }, 'medium'],
    'uninspectable code': ['bash', { command: 'node -e "x"' }, 'unknown'],
    'unknown tool': ['mystery_tool', {}, 'unknown']
  };
  for (const [label, [tool, args, expected]] of Object.entries(levels)) {
    const decision = decide(tool, args);
    assert.equal(decision.impact?.level, expected, `${label}: expected ${expected}, got ${decision.impact?.level}`);
  }
});

test('the analysis names the specific risk of the program being run', () => {
  const preferences = decide('bash', { command: 'defaults write com.apple.dock tilesize -int 1' });
  assert.match(preferences.impact.zh, /偏好设置/);
  const kill = decide('bash', { command: 'pkill -f helper' });
  assert.match(kill.impact.zh, /终止进程/);
  const registry = decide('bash', { command: 'brew install jq' });
  assert.match(registry.impact.zh, /全局/);
});

test('heredoc content is data, not a command to refuse', () => {
  const documented = [
    'cat > notes.md <<\'EOF\'',
    'rm -rf /',
    'networksetup -setairportpower en0 off',
    'EOF',
    ''
  ].join('\n');
  const decision = decide('bash', { command: documented });
  assert.equal(decision.kind, 'allow', `heredoc body must not deny the call (got ${decision.code})`);

  assert.equal(decide('bash', { command: 'rm -rf /' }).kind, 'deny');
  assert.equal(decide('bash', { command: "bash -c 'rm -rf /'" }).kind, 'deny');
});
