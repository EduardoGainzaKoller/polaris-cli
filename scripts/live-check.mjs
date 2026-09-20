#!/usr/bin/env node
/**
 * Opt-in live check against a real runtime. It is NOT part of `npm test`: it
 * costs quota and needs a signed-in Codex or Claude.
 *
 *   npm run check:codex
 *   npm run check:claude -- workspace-write deny
 *
 * It never touches this repository. Every run builds a throwaway fixture in
 * the system temp directory, hashes every file before and after, and prints
 * exactly what changed — so "nothing was modified" is a measurement rather
 * than a hope.
 */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { PolarisApp } from '../dist/core/app.js';
import { claudeProvider } from '../dist/providers/claude/index.js';
import { codexProvider } from '../dist/providers/codex/index.js';
import { registerProvider } from '../dist/providers/provider.js';

registerProvider(codexProvider);
registerProvider(claudeProvider);

const [provider = 'codex', permissions = 'ask', answer = 'allow'] = process.argv.slice(2);
if (!['allow', 'deny'].includes(answer)) {
  console.error('The third argument must be "allow" or "deny".');
  process.exit(2);
}

const workspace = await mkdtemp(join(tmpdir(), 'polaris-live-'));
await mkdir(join(workspace, 'src'), { recursive: true });
await writeFile(join(workspace, 'package.json'), '{\n  "name": "live-fixture"\n}\n');
await writeFile(
  join(workspace, 'src', 'user.ts'),
  'export function createUser(name) {\n  return { name };\n}\n',
);

async function snapshot(dir) {
  const out = {};
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const full = join(entry.parentPath ?? entry.path, entry.name);
    const digest = createHash('sha256').update(await readFile(full)).digest('hex');
    out[relative(dir, full).replaceAll('\\', '/')] = digest.slice(0, 12);
  }
  return out;
}

const before = await snapshot(workspace);

const app = new PolarisApp({ cwd: workspace, config: { provider, permissions } });
await app.start();
console.log(`provider ${provider} · model ${app.state.model} · permissions ${permissions}`);
console.log(`runtime  ${app.state.access?.runtime} · sandboxed ${app.state.access?.sandboxed === true}\n`);

const asked = [];
app.subscribe((state) => {
  const request = state.approval;
  if (!request) return;
  const key = `${request.title} :: ${request.target}`;
  if (asked.at(-1) === key) return;
  asked.push(key);
  console.log(`--- permission required -------------------------------`);
  console.log(`${request.title}  ${request.target}`);
  for (const fact of request.facts ?? []) console.log(`  ${fact}`);
  if (request.reason) console.log(`  reason: ${request.reason}`);
  if (request.diff) console.log(request.diff.split('\n').slice(0, 12).join('\n'));
  console.log(`--- answering ${answer} --------------------------------\n`);
  queueMicrotask(() => app.resolveApproval(answer));
});

const prompt =
  process.env.POLARIS_LIVE_PROMPT ??
  'Add a validation to createUser in src/user.ts so it throws when name is empty, ' +
    'then run "node -e \\"console.log(1)\\"" to check node works. Keep it short.';
console.log(`> ${prompt}\n`);
await app.submit(prompt);

console.log('--- tool calls ----------------------------------------');
for (const message of app.state.messages) {
  if (message.role !== 'tool') continue;
  const { name, target, detail } = message.tool ?? {};
  console.log(`${message.state.padEnd(10)} ${name} ${target} · ${detail ?? ''}`);
}

const after = await snapshot(workspace);
console.log('\n--- workspace changes ---------------------------------');
const paths = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
const changes = paths.filter((path) => before[path] !== after[path]);
for (const path of changes) {
  const how = !before[path] ? 'created ' : !after[path] ? 'deleted ' : 'modified';
  console.log(`${how} ${path}`);
}
if (changes.length === 0) console.log('(nothing changed)');

console.log(`\napprovals asked: ${asked.length}`);
for (const one of asked) console.log(`  ${one}`);
console.log(`status: ${app.state.status}`);
console.log(`fixture: ${workspace}`);

await app.close();
// A denied run that changed a file is the one outcome that must never happen.
process.exit(answer === 'deny' && changes.length > 0 ? 1 : 0);
