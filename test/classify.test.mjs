/**
 * Behavioural tests for the project guard policy engine.
 *
 * The suite pins the three promises the plugin makes: in-project work runs
 * silently, everything else asks, and machine- or session-destroying actions are
 * refused. Run with `node --test test/`.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createPolicy } from '../lib/classify.js';

const CWD = '/Users/inception/Documents/deepseek-harness/default-workspace';
const PROJECT = '/Users/inception/Documents/deepseek-harness';

const policy = createPolicy({ projectRoots: [PROJECT] });

/** Classify one call against the shared policy. */
const decide = (tool, args, cwd = CWD) => policy.classify({ tool, args, cwd });

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

test('file tools inside the project are auto-approved', () => {
  expectKind('write', { file_path: 'lib/new.js', content: 'x' }, 'allow');
  expectKind('write', { file_path: `${CWD}/lib/new.js`, content: 'x' }, 'allow');
  expectKind('edit', { file_path: 'lib/classify.js', old_string: 'a', new_string: 'b' }, 'allow');
  expectKind('read', { file_path: 'package.json' }, 'allow');
  expectKind('read', { file_path: `${PROJECT}/lunasilk/README.md` }, 'allow');
  expectKind('read_image', { file_path: 'docs/shot.png' }, 'allow');
  expectKind('glob', { pattern: '**/*.ts', path: 'src' }, 'allow');
  expectKind('grep', { pattern: 'foo', path: PROJECT }, 'allow');
});

test('file tools that leave the project ask the user', () => {
  expectKind('write', { file_path: '/etc/hosts', content: 'x' }, 'ask');
  expectKind('write', { file_path: '/Applications/Something.app/x', content: 'x' }, 'ask');
  expectKind('edit', { file_path: `${CWD}/../../other-project/a.js` }, 'ask');
  expectKind('read', { file_path: '/Applications/DeepSeek Harness.app/x' }, 'ask');
  expectKind('read', { file_path: '~/Library/Preferences/x.plist' }, 'ask');
  expectKind('write', { file_path: '~/.zshrc', content: 'x' }, 'ask');
});

test('read-only extra roots never grant writes', () => {
  const scoped = createPolicy({ projectRoots: [PROJECT], readOnlyRoots: ['/Applications/DeepSeek Harness.app'] });
  assert.equal(scoped.classify({ tool: 'read', args: { file_path: '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar' }, cwd: CWD }).kind, 'allow');
  assert.equal(scoped.classify({ tool: 'write', args: { file_path: '/Applications/DeepSeek Harness.app/x' }, cwd: CWD }).kind, 'ask');
});

test('ordinary project commands run silently', () => {
  expectKind('bash', { command: 'pnpm install' }, 'allow');
  expectKind('bash', { command: 'npm run build' }, 'allow');
  expectKind('bash', { command: 'node --test test/classify.test.mjs' }, 'allow');
  expectKind('bash', { command: 'rm -rf node_modules && pnpm install' }, 'allow');
  expectKind('bash', { command: 'git add -A && git commit -m "x"' }, 'allow');
  expectKind('bash', { command: 'mkdir -p build && cp a.txt build/a.txt' }, 'allow');
  expectKind('bash', { command: 'cat package.json | grep name' }, 'allow');
  expectKind('bash', { command: 'echo done > /tmp/guard-scratch.txt' }, 'allow');
  expectKind('bash', { command: 'ls -la' }, 'allow');
});

test('system commands always ask', () => {
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
    'system_profiler SPHardwareDataType',
    'lsof -i',
    'ps aux',
    'kill 4321',
    'killall SomeApp',
    'pkill -f helper',
    'brew install jq',
    'pip install requests',
    'osascript -e "tell application \\"Finder\\" to activate"',
    'open -a Safari',
    'xargs rm'
  ]) {
    expectKind('bash', { command }, 'ask');
  }
});

test('network and external effects ask', () => {
  for (const command of [
    'curl https://example.com',
    'wget https://example.com/x.tgz',
    'ssh host uptime',
    'scp file host:/tmp',
    'git push origin main',
    'git pull',
    'gh pr list',
    'aws s3 ls',
    'docker ps',
    'kubectl get pods',
    'npx some-cli --yes',
    'npm publish',
    'npm cache clean --force',
    'npm install -g typescript'
  ]) {
    expectKind('bash', { command }, 'ask');
  }
});

test('paths outside the project ask even when the program is ordinary', () => {
  expectKind('bash', { command: 'cat /etc/hosts' }, 'ask');
  expectKind('bash', { command: 'echo x > /usr/local/etc/x.conf' }, 'ask');
  expectKind('bash', { command: 'rm -rf ../../other-project' }, 'ask');
  expectKind('bash', { command: 'cd ~/Library && ls' }, 'ask');
  expectKind('bash', { command: 'git -C /opt/other status' }, 'ask');
  expectKind('bash', { command: 'chmod -R 777 /' }, 'ask');
  expectKind('bash', { command: 'find / -name "*.log" -delete' }, 'ask');
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
  assert.equal(relaxed.classify({ tool: 'bash', args: { command: 'shutdown -h now' }, cwd: CWD }).kind, 'ask');
});

test('in-project sandbox escalation stays silent, out-of-project escalation asks', () => {
  expectKind('bash', { command: 'pnpm install', sandbox_permissions: 'danger-full-access', justification: 'x' }, 'allow');
  expectKind('write', { file_path: 'lib/x.js', content: 'x', sandbox_permissions: 'danger-full-access', justification: 'x' }, 'allow');
  expectKind('write', { file_path: '/etc/x', content: 'x', sandbox_permissions: 'danger-full-access', justification: 'x' }, 'ask');
  expectKind('bash', { command: 'ls', workdir: '/tmp' }, 'allow');
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
  assert.equal(sessionOnly.classify({ tool: 'write', args: { file_path: 'a.txt', content: 'x' }, cwd: CWD }).kind, 'allow');
  assert.equal(sessionOnly.classify({ tool: 'write', args: { file_path: '/etc/a', content: 'x' }, cwd: CWD }).kind, 'ask');

  const projectOnly = createPolicy({ includeSessionCwd: false, projectRoots: [PROJECT] });
  assert.equal(projectOnly.classify({ tool: 'write', args: { file_path: 'a.txt', content: 'x' }, cwd: '/elsewhere/project' }).kind, 'ask');
  assert.equal(projectOnly.classify({ tool: 'write', args: { file_path: `${PROJECT}/a.txt`, content: 'x' }, cwd: '/elsewhere/project' }).kind, 'allow');
});

test('user configuration can widen and narrow the policy', () => {
  const widened = createPolicy({ projectRoots: [PROJECT], allowTools: ['some_mcp_tool'] });
  assert.equal(widened.classify({ tool: 'some_mcp_tool', args: {}, cwd: CWD }).kind, 'allow');

  const narrowed = createPolicy({ projectRoots: [PROJECT], askTools: ['present'] });
  assert.equal(narrowed.classify({ tool: 'present', args: {}, cwd: CWD }).kind, 'ask');

  const denied = createPolicy({ projectRoots: [PROJECT], denyTools: ['subagent'] });
  assert.equal(denied.classify({ tool: 'subagent', args: {}, cwd: CWD }).kind, 'deny');

  const patterns = createPolicy({ projectRoots: [PROJECT], extraAskPatterns: ['deploy-now'] });
  assert.equal(patterns.classify({ tool: 'bash', args: { command: 'echo deploy-now' }, cwd: CWD }).kind, 'ask');
});

test('project roots accept a leading tilde', () => {
  const tilde = createPolicy({ projectRoots: ['~/Documents/deepseek-harness'], includeSessionCwd: false });
  const home = process.env.HOME;
  assert.equal(tilde.classify({ tool: 'write', args: { file_path: `${home}/Documents/deepseek-harness/x.txt`, content: 'x' }, cwd: '/elsewhere' }).kind, 'allow');
  assert.equal(tilde.classify({ tool: 'write', args: { file_path: `${home}/Documents/other/x.txt`, content: 'x' }, cwd: '/elsewhere' }).kind, 'ask');
});

test('remote project roots resolve against symlinks, not just text', () => {
  const decision = decide('write', { file_path: `${PROJECT}/lunasilk/x.txt`, content: 'x' });
  assert.equal(decision.kind, 'allow');
  assert.equal(decision.scope, 'project');
});

test('every verdict carries a bilingual display reason', () => {
  const decision = decide('bash', { command: 'curl https://example.com' });
  assert.equal(typeof decision.displayReason.en, 'string');
  assert.equal(typeof decision.displayReason.zh, 'string');
  assert.ok(decision.displayReason.zh.length > 0);
  assert.equal(decision.system, true);
});

test('every confirmation carries an adverse-outcome analysis', () => {
  const decision = decide('bash', { command: 'curl https://example.com' });
  assert.equal(decision.impact.level, 'medium');
  assert.ok(decision.impact.zh.length > 0);
  assert.ok(decision.impact.en.length > 0);
});

test('the analysis rates the consequences a user must weigh', () => {
  const levels = {
    'network interface down': ['bash', { command: 'ifconfig en0 down' }, 'high'],
    'power off': ['bash', { command: 'reboot' }, 'high'],
    'unbounded write': ['bash', { command: 'dd if=/dev/zero of=./big.img' }, 'high'],
    'disk allocation': ['bash', { command: 'fallocate -l 10g ./big.img' }, 'high'],
    'privileged command': ['bash', { command: 'sudo true' }, 'high'],
    'network egress': ['bash', { command: 'ssh host uptime' }, 'medium'],
    'global install': ['bash', { command: 'npm install -g typescript' }, 'medium'],
    'path outside project': ['write', { file_path: '/etc/hosts', content: 'x' }, 'medium'],
    'remote git': ['bash', { command: 'git push origin main' }, 'medium'],
    'port binding': ['bash', { command: 'python3 -m http.server 8080' }, 'medium'],
    'read-only system probe': ['bash', { command: 'sw_vers' }, 'low'],
    'uninspectable code': ['bash', { command: 'node -e "x"' }, 'unknown'],
    'unknown tool': ['mystery_tool', {}, 'unknown']
  };
  for (const [label, [tool, args, expected]] of Object.entries(levels)) {
    const decision = decide(tool, args);
    assert.equal(decision.kind === 'allow' ? 'allow' : decision.kind, decision.kind);
    assert.equal(decision.impact?.level, expected, `${label}: expected ${expected}, got ${decision.impact?.level}`);
  }
});

test('the analysis names the specific risk of the program being run', () => {
  const network = decide('bash', { command: 'defaults write com.apple.dock tilesize -int 1' });
  assert.match(network.impact.zh, /偏好设置/);
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

  // The same text as an actual command is still refused.
  assert.equal(decide('bash', { command: 'rm -rf /' }).kind, 'deny');
  assert.equal(decide('bash', { command: "bash -c 'rm -rf /'" }).kind, 'deny');
});
