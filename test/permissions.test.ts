import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../src/config/config.ts';
import { DENIED_BY_USER, PermissionGate } from '../src/permissions/gate.ts';
import {
  DEFAULT_PROFILE,
  evaluate,
  isAvailable,
  LARGE_OVERWRITE_LINES,
  MASS_CHANGE_FILES,
  type Operation,
  type PermissionProfile,
  toProfile,
} from '../src/permissions/policy.ts';
import { classifyCommand } from '../src/permissions/risk.ts';
import { parseCommand } from '../src/permissions/shell.ts';
import { ANALYSIS, authorizeTask, task } from '../src/permissions/task.ts';

// ---------------------------------------------------------- task authorisation

const scope = (request: string, previous = null as ReturnType<typeof authorizeTask> | null) => {
  const authorised = authorizeTask(request, previous);
  return { intent: authorised.intent, modify: authorised.modifyWorkspace };
};

test('analysis and explanation requests authorise reading, never editing', () => {
  for (const request of [
    'Analyze this service',
    'Analiza cómo funciona UserService.',
    'Explain this class',
    'Explícame qué hace esta clase.',
    'Look at this function',
    'Mira esta función.',
    'How would you implement caching here?',
    '¿Cómo implementarías la validación?',
    'Dime qué archivos están modificados y enséñame el diff.',
  ]) {
    assert.equal(scope(request).modify, false, request);
  }
  assert.equal(scope('Explain this class').intent, 'explanation');
  assert.equal(scope('Analyze this service').intent, 'analysis');
});

test('requests to change code authorise ordinary edits, and say which kind', () => {
  const cases: Array<[string, string]> = [
    ['Implement this function', 'implementation'],
    ['Implementa esta función.', 'implementation'],
    ['Fix this bug', 'bugfix'],
    ['Corrige este bug.', 'bugfix'],
    ['Refactor this class', 'refactor'],
    ['Refactoriza esta clase.', 'refactor'],
    ['Add tests', 'testing'],
    ['Crea los tests.', 'testing'],
    ['Añade validación a createUser.', 'implementation'],
    ['Actualiza este endpoint.', 'implementation'],
    ['Renombra este componente.', 'refactor'],
    ['Please update the README', 'implementation'],
    ['Can you fix the failing test?', 'bugfix'],
    ['Quiero que implementes el login.', 'implementation'],
    ['Implement this function and add the necessary tests.', 'testing'],
  ];
  for (const [request, intent] of cases) {
    assert.deepEqual(scope(request), { intent, modify: true }, request);
  }
});

test('a negation wins over a change verb', () => {
  assert.equal(scope("Review the auth module but don't change anything").modify, false);
  assert.equal(scope('Revisa el módulo, sin modificar nada.').modify, false);
});

test('a follow-up continues the task; a new request replaces it', () => {
  const implement = authorizeTask('Implementa createUser.', null);
  const next = authorizeTask('Sigue.', implement);
  assert.equal(next.modifyWorkspace, true);
  assert.equal(next.continued, true);
  assert.equal(next.intent, 'implementation');

  // A new, different request is a new task: the previous scope does not linger.
  const explain = authorizeTask('Explícame Spring Security.', next);
  assert.equal(explain.modifyWorkspace, false);
  assert.equal(explain.continued, false);

  // Looking first, then asking for the fix, authorises the fix then.
  const look = authorizeTask('Mira esta función.', null);
  assert.equal(look.modifyWorkspace, false);
  assert.equal(authorizeTask('Corrígela.', look).modifyWorkspace, true);
  // A continuation with nothing to continue is only a reading.
  assert.equal(authorizeTask('ok', null).modifyWorkspace, false);
});

test('nothing in the task shape grants running project code yet', () => {
  assert.equal(authorizeTask('Implement X and run the tests', null).executeProjectCode, false);
});

// ------------------------------------------------------------------- commands

const risk = (command: string) => classifyCommand(command).risk;

test('safe Git inspection is safe, with its options checked one by one', () => {
  for (const command of [
    'git status',
    'git status --short',
    'git status --porcelain',
    'git status --porcelain=v2',
    'git diff',
    'git diff --cached',
    'git diff --stat',
    'git diff --name-only HEAD~1',
    'git log --oneline',
    'git log -n5 --oneline',
    'git show HEAD',
    'git branch --show-current',
    'git rev-parse --show-toplevel',
    'git ls-files',
    'git --no-pager diff',
    '"C:\\Program Files\\Git\\bin\\git.exe" status',
  ]) {
    assert.equal(risk(command), 'safe', command);
  }
  for (const command of [
    'git diff --output=patch.txt',
    'git diff --ext-diff',
    'git branch new-feature',
    'git log ../../elsewhere',
    'git diff /etc/passwd',
  ]) {
    assert.equal(risk(command), 'sensitive', command);
  }
});

test('Git that writes, contacts a remote or destroys work always asks', () => {
  for (const command of [
    'git add .',
    'git commit -m x',
    'git checkout main',
    'git switch main',
    'git stash',
    'git merge main',
    'git rebase main',
    'git cherry-pick abc',
    'git revert abc',
    'git tag v1',
  ]) {
    assert.equal(risk(command), 'sensitive', command);
  }
  for (const command of ['git push', 'git pull', 'git fetch']) {
    assert.equal(classifyCommand(command).category, 'network', command);
  }
  for (const command of [
    'git reset --hard',
    'git clean -fd',
    'git restore .',
    'git checkout -- .',
    'git push --force',
  ]) {
    const classification = classifyCommand(command);
    assert.equal(classification.risk, 'sensitive', command);
    assert.equal(classification.high, true, `${command} is high risk`);
  }
});

test('options that change Git’s repository or configuration are never auto-approved', () => {
  for (const command of [
    'git -C ../../ status',
    'git --git-dir=/tmp/x status',
    'git --work-tree=/ status',
    'git -c core.pager=evil status',
  ]) {
    assert.equal(classifyCommand(command).category, 'git-context', command);
  }
});

test('compound shell lines are never safe, however innocent the first part', () => {
  for (const command of [
    'git status && echo x',
    'git status || rm -rf .',
    'git status; rm file',
    'git status | something',
    'git status > file',
    'git status < input',
    'git status & other',
    'git status $(rm -rf /)',
    'git status `rm -rf /`',
    'git status "$(whoami)"',
    'git status\nrm file',
  ]) {
    const classification = classifyCommand(command);
    assert.equal(classification.risk, 'sensitive', JSON.stringify(command));
    assert.equal(classification.category, 'composition', JSON.stringify(command));
  }
  // Quoted metacharacters are just text.
  assert.equal(parseCommand("git log --format='%h | %s'")?.composite, false);
  assert.equal(parseCommand('git status "unclosed'), null);
});

test('project code, interpreters, nested shells, installs, network and deletion ask', () => {
  const cases: Array<[string, string]> = [
    ['npm test', 'project-code'],
    ['npm run build', 'project-code'],
    ['npm run lint', 'project-code'],
    ['./gradlew test', 'project-code'],
    ['gradlew.bat build', 'project-code'],
    ['mvn test', 'project-code'],
    ['pytest', 'project-code'],
    ['cargo test', 'project-code'],
    ['go test ./...', 'project-code'],
    ['python script.py', 'interpreter'],
    ['node script.js', 'interpreter'],
    ['bash -c "ls"', 'nested-shell'],
    ['cmd /c dir', 'nested-shell'],
    ['powershell -Command Get-ChildItem', 'nested-shell'],
    ['npm install', 'dependencies'],
    ['npm install zod', 'dependencies'],
    ['pnpm add zod', 'dependencies'],
    ['yarn add zod', 'dependencies'],
    ['pip install requests', 'dependencies'],
    ['poetry add requests', 'dependencies'],
    ['curl https://example.com', 'network'],
    ['wget https://example.com', 'network'],
    ['ssh host', 'network'],
    ['rm file.txt', 'delete'],
    ['NODE_OPTIONS=--require=evil.js npm test', 'environment'],
    ['GIT_EXTERNAL_DIFF=evil git diff', 'environment'],
    ['some-unknown-tool --flag', 'unknown'],
    ['make deploy-prod', 'project-code'],
  ];
  for (const [command, category] of cases) {
    const classification = classifyCommand(command);
    assert.equal(classification.risk, 'sensitive', command);
    assert.equal(classification.category, category, command);
  }
  assert.equal(classifyCommand('rm -rf build').high, true);
  assert.equal(
    classifyCommand('npm install zod').reason,
    'May modify dependencies, run install scripts and access the network.',
  );
  assert.equal(classifyCommand('./gradlew test').reason, 'Executes project code.');
});

// --------------------------------------------------------------------- policy

const NONE = { editedFiles: 0, touchesNewFile: true, broadChangeApproved: false };
const IMPLEMENT = task('implementation', true);
const decide = (
  operation: Operation,
  profile: PermissionProfile = 'smart',
  authorised = IMPLEMENT,
) => evaluate(operation, profile, authorised, NONE).decision;
const edit = (path: string): Operation => ({ capability: 'edit', target: path, paths: [path] });
const run = (command: string): Operation => ({ capability: 'command', target: command, command });

test('an implementation task: routine work goes ahead, boundaries ask', () => {
  assert.equal(decide({ capability: 'read', target: 'a.ts' }), 'allow');
  assert.equal(decide(edit('src/a.ts')), 'allow');
  assert.equal(
    decide({ capability: 'write', target: 'test/a.test.ts', paths: ['test/a.test.ts'] }),
    'allow',
  );
  assert.equal(decide(run('git status')), 'allow');
  assert.equal(decide(run('git diff')), 'allow');
  for (const command of [
    'npm test',
    'npm install zod',
    'curl https://x',
    'git push',
    'git reset --hard',
  ]) {
    assert.equal(decide(run(command)), 'ask', command);
  }
});

test('an analysis task asks before an edit it did not ask for', () => {
  const decision = evaluate(edit('src/Service.java'), 'smart', ANALYSIS, NONE);
  assert.equal(decision.decision, 'ask');
  assert.match(decision.reason, /did not ask for changes/);
  assert.equal(decide(run('git diff'), 'smart', ANALYSIS), 'allow');
});

test('read-only stays strict, whatever the task says', () => {
  assert.equal(decide(edit('src/a.ts'), 'read-only'), 'deny');
  assert.equal(decide(run('git status'), 'read-only'), 'allow');
  assert.equal(decide(run('npm test'), 'read-only'), 'deny');
  assert.equal(decide(run('mystery'), 'read-only'), 'deny');
  assert.equal(isAvailable('read-only', 'edit'), false);
  assert.equal(isAvailable('read-only', 'command'), true, 'safe inspection is still reading');
});

test('workspace-write allows edits even for analysis, but still classifies commands', () => {
  assert.equal(decide(edit('src/a.ts'), 'workspace-write', ANALYSIS), 'allow');
  assert.equal(decide(run('npm test'), 'workspace-write'), 'ask');
  assert.equal(decide(run('git status'), 'workspace-write'), 'allow');
});

test('an unusually broad change and a large overwrite ask, even when authorised', () => {
  const broad = evaluate(edit('src/z.ts'), 'smart', IMPLEMENT, {
    editedFiles: MASS_CHANGE_FILES,
    touchesNewFile: true,
    broadChangeApproved: false,
  });
  assert.equal(broad.decision, 'ask');
  assert.equal(broad.category, 'broad-change');
  // Files already part of the change are not the broadening.
  assert.equal(
    evaluate(edit('src/a.ts'), 'smart', IMPLEMENT, {
      editedFiles: MASS_CHANGE_FILES,
      touchesNewFile: false,
      broadChangeApproved: false,
    }).decision,
    'allow',
  );
  assert.equal(
    decide({
      capability: 'write',
      target: 'big.ts',
      paths: ['big.ts'],
      replacesLines: LARGE_OVERWRITE_LINES,
    }),
    'ask',
  );
});

test('smart is the default, and v0.6’s ask is read as smart', async () => {
  assert.equal(DEFAULT_PROFILE, 'smart');
  assert.equal(toProfile('ask'), 'smart');
  assert.equal(toProfile('full-access'), null);
  assert.equal(toProfile('yolo'), null);
  // An existing config file that says "ask" keeps working.
  const home = process.env.POLARIS_HOME as string;
  await writeFile(
    join(home, 'config.json'),
    JSON.stringify({ provider: 'mock', permissions: 'ask' }),
  );
  assert.equal((await loadConfig()).permissions, 'smart');
});

// ----------------------------------------------------------------------- gate

async function workspaceWithEscape() {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'polaris-gate-')));
  const outside = await realpath(await mkdtemp(join(tmpdir(), 'polaris-outside-')));
  await mkdir(join(workspace, 'src'));
  await symlink(
    outside,
    join(workspace, 'escape'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  return { workspace, outside };
}

function gateFor(workspace: string, profile: PermissionProfile = 'smart') {
  const gate = new PermissionGate(profile, { workspace });
  const asked: string[] = [];
  gate.onApproval(async (request) => {
    asked.push(`${request.title} ${request.target} · ${request.reason}`);
    return 'allow';
  });
  return { gate, asked };
}

const CARD = (target: string) => ({ title: 'Edit', target });

test('implement and add tests: six routine operations, zero approvals', async () => {
  const { workspace } = await workspaceWithEscape();
  const { gate, asked } = gateFor(workspace);
  gate.beginTask(authorizeTask('Implement this function and add the necessary tests.', null));
  const operations: Operation[] = [
    { capability: 'read', target: 'src/a.ts', paths: ['src/a.ts'] },
    edit('src/a.ts'),
    { capability: 'write', target: 'src/b.test.ts', paths: ['src/b.test.ts'] },
    edit('src/b.test.ts'),
    edit('src/a.ts'),
    run('git diff'),
  ];
  for (const operation of operations) {
    const verdict = await gate.authorize(operation, CARD(operation.target));
    assert.equal(verdict.allowed, true, operation.target);
  }
  assert.deepEqual(asked, [], 'not one approval');

  // Then a boundary: running the tests asks, once, and says why.
  await gate.authorize(run('./gradlew test'), { title: 'Run command', target: './gradlew test' });
  assert.deepEqual(asked, ['Run command ./gradlew test · Executes project code.']);
});

test('the workspace boundary is denied outright — no approval can open it', async () => {
  const { workspace, outside } = await workspaceWithEscape();
  const { gate, asked } = gateFor(workspace, 'workspace-write');
  gate.beginTask(IMPLEMENT);
  for (const operation of [
    edit('../../secret.txt'),
    { capability: 'write', target: 'x', paths: [join(outside, 'x.txt')] } as Operation,
    edit('escape/owned.txt'),
    {
      capability: 'command',
      target: 'git status',
      command: 'git status',
      cwd: outside,
    } as Operation,
    { capability: 'edit', target: 'x', paths: ['src/x.ts'], grantRoot: outside } as Operation,
  ]) {
    const verdict = await gate.authorize(operation, CARD(operation.target));
    assert.equal(verdict.allowed, false, operation.target);
    assert.equal(verdict.decision?.risk, 'forbidden', operation.target);
  }
  assert.deepEqual(asked, [], 'never put to the user');
});

test('an operation refused once in a task is not asked again in that task', async () => {
  const { workspace } = await workspaceWithEscape();
  const gate = new PermissionGate('smart', { workspace });
  let asked = 0;
  gate.onApproval(async () => {
    asked += 1;
    return 'deny';
  });
  gate.beginTask(IMPLEMENT);
  const first = await gate.authorize(run('npm test'), CARD('npm test'));
  const second = await gate.authorize(run('npm test'), CARD('npm test'));
  assert.equal(first.allowed, false);
  assert.equal(first.allowed === false && first.reason, DENIED_BY_USER);
  assert.equal(second.allowed, false);
  assert.equal(asked, 1, 'asked once');
  // A new task may ask again.
  gate.beginTask(task('testing', true));
  await gate.authorize(run('npm test'), CARD('npm test'));
  assert.equal(asked, 2);
});

test('the model cannot widen the task: only a user request sets it', async () => {
  const { workspace } = await workspaceWithEscape();
  const { gate, asked } = gateFor(workspace);
  gate.beginTask(authorizeTask('Analyze UserService.', null));
  // Whatever the model writes in its reply never reaches beginTask; the next
  // edit is judged against the user's analysis request.
  await gate.authorize(edit('src/UserService.java'), CARD('src/UserService.java'));
  assert.equal(asked.length, 1);
  assert.match(asked[0] ?? '', /did not ask for changes/);
});

test('a high-risk operation says so on the card', async () => {
  const { workspace } = await workspaceWithEscape();
  const gate = new PermissionGate('smart', { workspace });
  let high: boolean | undefined;
  gate.onApproval(async (request) => {
    high = request.high;
    return 'deny';
  });
  await gate.authorize(run('git reset --hard'), CARD('git reset --hard'));
  assert.equal(high, true);
});

test('without a way to ask, an ask is a denial and nothing is written', async () => {
  const { workspace } = await workspaceWithEscape();
  const gate = new PermissionGate('smart', { workspace });
  const verdict = await gate.authorize(run('npm test'), CARD('npm test'));
  assert.equal(verdict.allowed, false);
  assert.match(verdict.allowed ? '' : verdict.reason, /No approval surface/);
  assert.equal(
    await readFile(join(workspace, 'src', 'nothing'), 'utf8').catch(() => 'absent'),
    'absent',
  );
});

test('plain read-only inspection inside the workspace is safe; reaching outside is not', () => {
  for (const command of [
    'ls -la',
    'ls src',
    'dir',
    'pwd',
    'cat package.json',
    'head -n 20 src/a.ts',
    'wc -l src/a.ts',
    'echo done',
  ]) {
    assert.equal(risk(command), 'safe', command);
  }
  for (const command of [
    'cat /etc/passwd',
    'cat ../../secret.txt',
    'type ..\\..\\secret.txt',
    'cat C:\\Users\\me\\.ssh\\id_rsa',
    'find . -delete',
    'ls; rm -rf src',
    'cat a > b',
  ]) {
    assert.equal(risk(command), 'sensitive', command);
  }
});
