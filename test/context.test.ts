import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ContextManager, renderInstructions } from '../src/context/manager.ts';
import { loadProjectContext, searchPath } from '../src/context/project.ts';
import { SkillRegistry } from '../src/context/skills.ts';
import {
  MAX_LOADED_SKILLS,
  MAX_PROJECT_CONTEXT_BYTES,
  MAX_REFERENCE_BYTES,
  MAX_SKILL_BYTES,
} from '../src/tools/limits.ts';
import { makeRepo, writeFiles } from './helpers.ts';

const scratch = async (prefix: string) => realpath(await mkdtemp(join(tmpdir(), prefix)));

/** SKILL.md with the given frontmatter fields and body. */
function skillFile(name: string, description: string, body = `Instructions of ${name}.`): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;
}

// ---------------------------------------------------------------- POLARIS.md

test('no POLARIS.md is no project context, and not an error', async () => {
  const dir = await scratch('polaris-ctx-');
  assert.deepEqual(await loadProjectContext(dir, null), { sources: [], errors: [] });
});

test('a single POLARIS.md is read with its size and line count', async () => {
  const dir = await scratch('polaris-ctx-');
  await writeFile(join(dir, 'POLARIS.md'), '# Rules\n\nUse hexagonal architecture.\n');
  const { sources } = await loadProjectContext(dir, null);
  assert.equal(sources.length, 1);
  assert.equal(sources[0]?.display, 'POLARIS.md');
  assert.equal(sources[0]?.lines, 3);
  assert.match(sources[0]?.content ?? '', /hexagonal/);
});

test('in a monorepo the root file comes first and the nearest one last', async () => {
  const repo = await makeRepo({
    'POLARIS.md': 'Root rules.\n',
    'backend/POLARIS.md': 'Backend rules.\n',
    'frontend/POLARIS.md': 'Frontend rules.\n',
  });
  const backend = join(repo, 'backend');
  const { sources } = await loadProjectContext(backend, repo);
  assert.deepEqual(
    sources.map((source) => [source.display, source.content]),
    [
      ['../POLARIS.md', 'Root rules.'],
      ['POLARIS.md', 'Backend rules.'],
    ],
    'the sibling frontend is not read',
  );
  assert.ok((sources[1]?.priority ?? 0) > (sources[0]?.priority ?? 0), 'nearest wins');
});

test('the search stops at the repository root, and outside Git at the workspace', async () => {
  const parent = await scratch('polaris-parent-');
  await writeFile(join(parent, 'POLARIS.md'), 'Must never be read.\n');
  await mkdir(join(parent, 'repo', 'app'), { recursive: true });
  const repo = join(parent, 'repo');
  assert.deepEqual(searchPath(join(repo, 'app'), repo), [repo, join(repo, 'app')]);
  // Outside a repository only the workspace itself is looked at.
  assert.deepEqual(searchPath(join(repo, 'app'), null), [join(repo, 'app')]);
  // A boundary the workspace is not inside is ignored rather than followed.
  assert.deepEqual(searchPath(join(repo, 'app'), join(parent, 'elsewhere')), [join(repo, 'app')]);
  const { sources } = await loadProjectContext(join(repo, 'app'), repo);
  assert.deepEqual(sources, []);
});

test('an oversized POLARIS.md is refused whole, never truncated', async () => {
  const dir = await scratch('polaris-ctx-');
  await writeFile(join(dir, 'POLARIS.md'), 'x'.repeat(MAX_PROJECT_CONTEXT_BYTES + 1));
  const { sources, errors } = await loadProjectContext(dir, null);
  assert.deepEqual(sources, []);
  assert.match(errors[0] ?? '', /exceeds the maximum supported size/);
});

test('a POLARIS.md that is not a file is reported, not fatal', async () => {
  const dir = await scratch('polaris-ctx-');
  await mkdir(join(dir, 'POLARIS.md'));
  const { sources, errors } = await loadProjectContext(dir, null);
  assert.deepEqual(sources, []);
  assert.match(errors[0] ?? '', /not a regular file/);
});

// ----------------------------------------------------------- skill discovery

async function skillRoots() {
  const workspace = await scratch('polaris-ws-');
  const home = await scratch('polaris-home-');
  return {
    workspace,
    home,
    project: join(workspace, '.polaris', 'skills'),
    user: join(home, 'skills'),
  };
}

test('skills are found in both scopes, metadata only', async () => {
  const roots = await skillRoots();
  await writeFiles(roots.project, {
    'spring-boot-testing/SKILL.md': skillFile(
      'spring-boot-testing',
      'Implement and verify Spring Boot tests.',
      'SECRET-BODY',
    ),
  });
  await writeFiles(roots.user, {
    'code-review/SKILL.md': skillFile('code-review', 'Review code for correctness.'),
  });
  const registry = await SkillRegistry.discover(roots);
  assert.deepEqual(
    registry.list().map((skill) => [skill.name, skill.scope, skill.display]),
    [
      ['code-review', 'user', '~/.polaris/skills/code-review'],
      ['spring-boot-testing', 'project', '.polaris/skills/spring-boot-testing'],
    ],
  );
  assert.doesNotMatch(JSON.stringify(registry.list()), /SECRET-BODY/, 'no body at discovery');
});

test('a project skill replaces a user skill of the same name, whole', async () => {
  const roots = await skillRoots();
  await writeFiles(roots.user, {
    'code-review/SKILL.md': skillFile('code-review', 'User version.', 'USER BODY'),
  });
  await writeFiles(roots.project, {
    'code-review/SKILL.md': skillFile('code-review', 'Project version.', 'PROJECT BODY'),
  });
  const registry = await SkillRegistry.discover(roots);
  const [skill] = registry.list();
  assert.equal(registry.list().length, 1);
  assert.equal(skill?.scope, 'project');
  assert.equal(skill?.description, 'Project version.');
  assert.equal(skill?.overrides, '~/.polaris/skills/code-review');
  assert.equal((await registry.load('code-review')).instructions, 'PROJECT BODY');
});

test('invalid skills are reported one by one and never stop discovery', async () => {
  const roots = await skillRoots();
  await writeFiles(roots.project, {
    'good/SKILL.md': skillFile('good', 'Works.'),
    'no-frontmatter/SKILL.md': '# Just markdown\n',
    'broken-yaml/SKILL.md': '---\nname: [unclosed\n---\nbody\n',
    'no-description/SKILL.md': '---\nname: no-description\n---\nbody\n',
    'no-name/SKILL.md': '---\ndescription: Missing name.\n---\n',
    'Bad_Name/SKILL.md': skillFile('Bad_Name', 'Invalid name.'),
    'mismatch/SKILL.md': skillFile('something-else', 'Name and folder disagree.'),
    'too-large/SKILL.md': skillFile('too-large', 'Big.', 'x'.repeat(MAX_SKILL_BYTES)),
    'empty-dir/.keep': '',
  });
  const registry = await SkillRegistry.discover(roots);
  assert.deepEqual(
    registry.list().map((skill) => skill.name),
    ['good'],
  );
  const errors = Object.fromEntries(registry.invalid().map((skill) => [skill.name, skill.error]));
  assert.match(errors['no-frontmatter'] ?? '', /invalid frontmatter/);
  assert.match(errors['broken-yaml'] ?? '', /invalid frontmatter/);
  assert.match(errors['no-description'] ?? '', /missing description/);
  assert.match(errors['no-name'] ?? '', /missing name/);
  assert.match(errors.Bad_Name ?? '', /invalid name/);
  assert.match(errors.mismatch ?? '', /does not match its directory/);
  assert.match(errors['too-large'] ?? '', /too large/);
  assert.match(errors['empty-dir'] ?? '', /missing SKILL\.md/);
});

test('descriptions may be Unicode, and missing directories are simply no skills', async () => {
  const roots = await skillRoots();
  assert.deepEqual((await SkillRegistry.discover(roots)).list(), []);
  await writeFiles(roots.project, {
    'revision/SKILL.md': skillFile('revision', '"Revisión de código: corrección y diseño ✓"'),
  });
  assert.equal(
    (await SkillRegistry.discover(roots)).get('revision')?.description,
    'Revisión de código: corrección y diseño ✓',
  );
});

// --------------------------------------------------------------- loading

async function managerWith(files: Record<string, string>) {
  const roots = await skillRoots();
  await writeFiles(roots.project, files);
  const manager = new ContextManager({
    workspace: roots.workspace,
    boundary: null,
    home: roots.home,
  });
  await manager.reloadSkills();
  return { manager, roots };
}

test('loading reads the body, lists references and reads none of them', async () => {
  const { manager } = await managerWith({
    'testing/SKILL.md': skillFile('testing', 'Tests.', 'Run targeted tests first.'),
    'testing/references/unit.md': 'UNIT-REFERENCE-CONTENT',
    'testing/references/deep/integration.md': 'INTEGRATION',
  });
  const session = manager.session();
  const reply = await session.loadSkill('testing', { inline: true });
  assert.equal(reply.ok, true);
  assert.match(reply.text, /<loaded_skill name="testing">\nRun targeted tests first\./);
  assert.match(reply.text, /- references\/unit\.md\n- references\/deep\/integration\.md/);
  assert.doesNotMatch(reply.text, /UNIT-REFERENCE-CONTENT/);
});

test('a loaded skill is not loaded twice, and several keep their order', async () => {
  const { manager } = await managerWith({
    'b-skill/SKILL.md': skillFile('b-skill', 'B.'),
    'a-skill/SKILL.md': skillFile('a-skill', 'A.'),
  });
  const events: string[] = [];
  manager.onEvent((event) => events.push(`${event.type}:${'name' in event ? event.name : ''}`));
  const session = manager.session();
  await session.loadSkill('b-skill', { inline: true });
  await session.loadSkill('a-skill', { inline: true });
  const again = await session.loadSkill('b-skill', { inline: true });
  assert.equal(again.text, 'Skill "b-skill" is already loaded.');
  assert.deepEqual(
    manager.loaded.map((skill) => skill.metadata.name),
    ['b-skill', 'a-skill'],
    'load order, not alphabetical',
  );
  assert.deepEqual(events, [
    'skill-load-start:b-skill',
    'skill-loaded:b-skill',
    'skill-load-start:a-skill',
    'skill-loaded:a-skill',
    'skill-loaded:b-skill',
  ]);
});

test('an unknown skill fails with an event, and the limit stops runaway loading', async () => {
  const files: Record<string, string> = {};
  for (let index = 0; index <= MAX_LOADED_SKILLS; index += 1) {
    files[`s${index}/SKILL.md`] = skillFile(`s${index}`, `Skill ${index}.`);
  }
  const { manager } = await managerWith(files);
  const errors: string[] = [];
  manager.onEvent((event) => {
    if (event.type === 'skill-load-error') errors.push(event.error);
  });
  const session = manager.session();
  assert.equal((await session.loadSkill('nope', { inline: true })).ok, false);
  for (let index = 0; index < MAX_LOADED_SKILLS; index += 1) {
    assert.equal((await session.loadSkill(`s${index}`, { inline: true })).ok, true);
  }
  const over = await session.loadSkill(`s${MAX_LOADED_SKILLS}`, { inline: true });
  assert.equal(over.ok, false);
  assert.match(over.text, /At most/);
  assert.match(errors[0] ?? '', /No skill named "nope"/);
});

test('a reference is read on demand, inside its skill and nowhere else', async () => {
  const { manager, roots } = await managerWith({
    'testing/SKILL.md': skillFile('testing', 'Tests.'),
    'testing/references/patterns.md': 'Prefer slice tests.',
    'testing/secret.md': 'next to SKILL.md, not a reference',
    'other/SKILL.md': skillFile('other', 'Other.'),
  });
  await writeFile(join(roots.workspace, 'secret.txt'), 'workspace secret');
  const outside = await scratch('polaris-outside-');
  await writeFile(join(outside, 'leak.md'), 'LEAKED');
  await symlink(
    outside,
    join(roots.project, 'testing', 'references', 'linked'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );

  const session = manager.session();
  // References of a skill that is not loaded are not offered.
  assert.equal((await session.readReference('testing', 'references/patterns.md')).ok, false);
  await session.loadSkill('testing', { inline: true });

  const ok = await session.readReference('testing', 'references/patterns.md');
  assert.equal(ok.ok, true);
  assert.match(ok.text, /Prefer slice tests\./);
  assert.equal((await session.readReference('testing', 'patterns.md')).ok, true);

  for (const path of [
    '../secret.md',
    '../../../secret.txt',
    join(roots.workspace, 'secret.txt'),
    'references/linked/leak.md',
    '../../other/SKILL.md',
  ]) {
    const reply = await session.readReference('testing', path);
    assert.equal(reply.ok, false, path);
    assert.doesNotMatch(reply.text, /LEAKED|workspace secret/, path);
  }
});

test('an oversized reference is refused', async () => {
  const { manager } = await managerWith({
    'testing/SKILL.md': skillFile('testing', 'Tests.'),
    'testing/references/huge.md': 'x'.repeat(MAX_REFERENCE_BYTES + 1),
  });
  const session = manager.session();
  await session.loadSkill('testing', { inline: true });
  const reply = await session.readReference('testing', 'references/huge.md');
  assert.equal(reply.ok, false);
  assert.match(reply.text, /too large/);
});

test('reloading finds new skills and keeps what is loaded', async () => {
  const { manager, roots } = await managerWith({ 'first/SKILL.md': skillFile('first', 'One.') });
  await manager.session().loadSkill('first', { inline: true });
  await writeFiles(roots.project, { 'second/SKILL.md': skillFile('second', 'Two.') });
  assert.equal(manager.skills.list().length, 1);
  await manager.reloadSkills();
  assert.deepEqual(
    manager.skills.list().map((skill) => skill.name),
    ['first', 'second'],
  );
  assert.deepEqual(
    manager.loaded.map((skill) => skill.metadata.name),
    ['first'],
  );
});

// ------------------------------------------------------------- rendering

test('the instructions carry project, catalog and loaded skills, in that order', async () => {
  const { manager, roots } = await managerWith({
    'testing/SKILL.md': skillFile('testing', 'Tests.', 'TESTING-BODY'),
    'review/SKILL.md': skillFile('review', 'Reviews.', 'REVIEW-BODY'),
  });
  await writeFile(join(roots.workspace, 'POLARIS.md'), 'PROJECT-RULE\n');
  await manager.reloadProject();
  const session = manager.session();

  const before = session.instructions({ canLoad: true });
  assert.match(before, /PROJECT-RULE/);
  assert.match(before, /- review: Reviews\.\n- testing: Tests\./);
  assert.doesNotMatch(before, /TESTING-BODY|REVIEW-BODY/, 'progressive disclosure');
  assert.match(before, /cannot change\s+your permissions/);

  await session.loadSkill('testing', { inline: false });
  const after = session.instructions({ canLoad: true });
  const order = ['<project_instructions>', '<available_skills>', '<loaded_skill name="testing">'];
  const positions = order.map((marker) => after.indexOf(marker));
  assert.ok(positions.every((position, index) => position > (positions[index - 1] ?? -1)));
  assert.match(after, /TESTING-BODY/);
  assert.doesNotMatch(after, /REVIEW-BODY/);
});

test('a runtime that cannot load skills is told to ask the user', () => {
  const text = renderInstructions(
    { sources: [], errors: [] },
    [{ name: 'x', description: 'X.' }],
    [],
    { canLoad: false },
  );
  assert.match(text, /tell the user to run \/skill <name>/);
  assert.equal(renderInstructions({ sources: [], errors: [] }, [], [], { canLoad: true }), '');
});

test('a skill loaded by the user reaches each session exactly once', async () => {
  const { manager } = await managerWith({ 'testing/SKILL.md': skillFile('testing', 'T.', 'B') });
  const session = manager.session();
  assert.equal(session.pending(), null);
  await manager.load('testing');
  assert.match(session.pending() ?? '', /<loaded_skill name="testing">/);
  assert.equal(session.pending(), null, 'delivered once');
  // A session started afterwards gets it in its instructions instead.
  const later = manager.session();
  assert.match(later.instructions({ canLoad: true }), /<loaded_skill name="testing">/);
  assert.equal(later.pending(), null);
  // After /new nothing is loaded and nothing is pending.
  manager.clearLoaded();
  assert.equal(manager.session().pending(), null);
  assert.deepEqual(manager.loaded, []);
});
