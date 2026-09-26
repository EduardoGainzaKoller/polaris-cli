// Packs Polaris, installs the tarball into a throwaway project and runs the
// installed `polaris` command, the way a tester would get it. Offline apart
// from `npm install` fetching dependencies; never touches a real provider,
// the real ~/.polaris, or the repository.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = new URL('..', import.meta.url);
const repo = decodeURIComponent(root.pathname).replace(/^\/([A-Za-z]:)/, '$1');
const { version } = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
const work = mkdtempSync(join(tmpdir(), 'polaris-package-'));
const failures = [];

/** Runs a command through the platform shell (npm is a .cmd on Windows); arguments are ours. */
function sh(command, options = {}) {
  const result = spawnSync(command, {
    shell: true,
    encoding: 'utf8',
    ...options,
    env: { ...process.env, ...options.env },
  });
  return { code: result.status ?? 1, out: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

function check(name, ok, detail = '') {
  console.log(`${ok ? '✓' : '×'} ${name}`);
  if (!ok) failures.push(`${name}${detail ? `\n${detail}` : ''}`);
}

try {
  // 1–2. Build and pack (prepack builds from a clean dist/).
  const packed = sh(`npm pack --json --pack-destination "${work}"`, { cwd: repo });
  // Lifecycle output (the build) surrounds the JSON; take just the array.
  const json = packed.out.slice(packed.out.indexOf('[\n'), packed.out.lastIndexOf('\n]') + 2);
  const manifest = JSON.parse(json)[0];
  const files = manifest.files.map((file) => file.path);
  console.log(`packed ${manifest.filename}: ${files.length} files, ${manifest.size} bytes`);

  const forbidden = files.filter(
    (path) =>
      /^(src|test|scripts|node_modules)\//.test(path) ||
      /(^|\/)\.env|\.log$|\.map$|\.tsbuildinfo$|polaris-report|checkpoint/i.test(path),
  );
  check('the package holds only the build, docs and metadata', forbidden.length === 0, forbidden.join('\n'));
  check('the package has an executable entry point', files.includes('dist/bin.js'));
  check('README and LICENSE ship with it', files.includes('README.md') && files.includes('LICENSE'));

  // 3. Install the tarball into a fresh project.
  const project = join(work, 'project');
  const home = join(work, 'home');
  mkdirSync(project);
  mkdirSync(home);
  writeFileSync(join(project, 'package.json'), '{ "name": "polaris-smoke", "private": true }\n');
  const installed = sh(`npm install --no-audit --no-fund "${join(work, manifest.filename)}"`, {
    cwd: project,
  });
  check('the tarball installs', installed.code === 0, installed.out);

  const env = { POLARIS_HOME: home, NO_COLOR: '1' };
  // The shim npm created for the `bin` entry, exactly what a user's PATH would run.
  const bin = join(project, 'node_modules', '.bin', process.platform === 'win32' ? 'polaris.cmd' : 'polaris');
  check('npm created the polaris command', existsSync(bin));
  const polaris = (args, input) =>
    sh(`"${bin}" ${args}`, { cwd: project, env, ...(input ? { input } : {}) });

  // 4–5. Version and help, without a terminal and without starting anything.
  const shown = polaris('--version');
  check('polaris --version', shown.code === 0 && shown.out.trim() === `Polaris ${version}`, shown.out);
  const help = polaris('--help');
  check('polaris --help', help.code === 0 && help.out.includes('Usage:') && help.out.includes('doctor'), help.out);

  // Doctor: runs, and changes nothing.
  const doctor = polaris('doctor');
  check('polaris doctor', doctor.out.includes('Polaris Doctor') && doctor.out.includes('Result'), doctor.out);
  check('doctor does not create a configuration', !existsSync(join(home, 'config.json')));

  // 6. A whole session with the offline mock, in line mode.
  const session = polaris('--provider mock', 'hello from the package\n/exit\n');
  check('a mock session runs end to end', session.code === 0 && session.out.includes('You said: hello from the package'), session.out);
} catch (error) {
  failures.push(String(error?.stack ?? error));
} finally {
  // 7. Clean up.
  rmSync(work, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\n${failures.length} package check(s) failed:\n\n${failures.join('\n\n')}`);
  process.exit(1);
}
console.log('\nPackage smoke test passed.');
