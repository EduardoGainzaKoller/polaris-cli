import { isAbsolute } from 'node:path';
import { executableName, parseCommand } from './shell.ts';

/**
 * What running one command would cross, by explicit rules — no scores, no
 * guessing. The rule for anything not recognised is simple: it is not safe.
 *
 *   safe       → the profile may allow it without asking
 *   sensitive  → a person decides
 *   forbidden  → nobody can approve it (decided by the hard constraints)
 *
 * Only Git inspection with a known subcommand and known options is safe. A
 * command is never matched as a substring: `git status && rm -rf x` is a
 * compound line, and compound lines are never safe.
 */
export type Risk = 'safe' | 'sensitive' | 'forbidden';

export type RiskCategory =
  | 'inspection'
  | 'project-code'
  | 'dependencies'
  | 'network'
  | 'git-write'
  | 'git-destructive'
  | 'git-context'
  | 'delete'
  | 'composition'
  | 'nested-shell'
  | 'interpreter'
  | 'environment'
  | 'outside-workspace'
  | 'unknown';

export interface Classification {
  readonly risk: Risk;
  readonly category: RiskCategory;
  /** One sentence the approval card shows under "Reason". */
  readonly reason: string;
  /** Can lose work that cannot be recovered: said louder on the card. */
  readonly high?: boolean;
}

const sensitive = (category: RiskCategory, reason: string, high = false): Classification => ({
  risk: 'sensitive',
  category,
  reason,
  ...(high ? { high: true } : {}),
});

export function classifyCommand(command: string): Classification {
  const parsed = parseCommand(command.trim());
  if (!parsed || parsed.argv.length === 0) {
    return sensitive('unknown', 'Could not be parsed safely.');
  }
  if (parsed.composite) {
    return sensitive(
      'composition',
      'Combines several commands, pipes or redirections; Polaris never approves those by itself.',
    );
  }
  if (parsed.env.length > 0) {
    return sensitive('environment', 'Sets environment variables for the command.');
  }
  const [first = '', ...args] = parsed.argv;
  const name = executableName(first);

  if (name === 'git') return classifyGit(args);
  if (SHELLS.has(name)) {
    return sensitive('nested-shell', 'Starts a shell whose script Polaris does not inspect.');
  }
  if (NETWORK.has(name)) return sensitive('network', 'Accesses the network.');
  if (DELETE.has(name)) {
    const recursive = args.some((arg) => /^(-[a-z]*r[a-z]*|-recurse|\/s)$/i.test(arg));
    return sensitive(
      'delete',
      recursive ? 'Deletes files recursively.' : 'Deletes files.',
      recursive,
    );
  }
  const dependencies = dependencyChange(name, args);
  if (dependencies) return dependencies;
  if (PROJECT_TOOLS.has(name)) return sensitive('project-code', 'Executes project code.');
  if (INTERPRETERS.has(name)) {
    return sensitive('interpreter', 'Runs code with an interpreter, which can do anything.');
  }
  if (name === 'pwd' && args.length === 0) {
    return { risk: 'safe', category: 'inspection', reason: 'Prints the working directory.' };
  }
  return sensitive('unknown', 'Not a command Polaris recognises as safe.');
}

// ------------------------------------------------------------------ Git

interface GitRule {
  /** Exact options allowed. */
  readonly flags: readonly string[];
  /** Options allowed with any value after these prefixes, e.g. `--format=`. */
  readonly prefixes?: readonly string[];
  /** Whether words that are not options (revisions, paths) are allowed. */
  readonly operands: boolean;
}

const COMMON_OUTPUT = ['--no-color', '--color=never', '--no-ext-diff', '--no-textconv'];

/**
 * Inspection only, each with the options it may take. An option not listed
 * here — `--output=file`, `--ext-diff`, `-c` — makes the command sensitive,
 * however harmless the subcommand.
 */
const SAFE_GIT: Record<string, GitRule> = {
  status: {
    flags: ['--short', '-s', '--porcelain', '--branch', '-b', '-z', '--long', '--ignored'],
    prefixes: ['--porcelain=', '--untracked-files=', '-u'],
    operands: true,
  },
  diff: {
    flags: [
      '--cached',
      '--staged',
      '--stat',
      '--name-only',
      '--name-status',
      '--numstat',
      '--shortstat',
      '--summary',
      '--patch',
      '-p',
      '-w',
      '--ignore-all-space',
      '--ignore-space-change',
      '--minimal',
      '--',
      ...COMMON_OUTPUT,
    ],
    prefixes: ['-U', '--unified=', '--stat='],
    operands: true,
  },
  log: {
    flags: [
      '--oneline',
      '--stat',
      '--graph',
      '--decorate',
      '--no-decorate',
      '--name-only',
      '--name-status',
      '--abbrev-commit',
      '--patch',
      '-p',
      '--all',
      '--reverse',
      '--',
      ...COMMON_OUTPUT,
    ],
    prefixes: ['-n', '--max-count=', '--format=', '--pretty=', '--since=', '--until=', '--author='],
    operands: true,
  },
  show: {
    flags: [
      '--stat',
      '--name-only',
      '--name-status',
      '--oneline',
      '--no-patch',
      '-s',
      ...COMMON_OUTPUT,
    ],
    prefixes: ['--format=', '--pretty='],
    operands: true,
  },
  'rev-parse': {
    flags: [
      '--show-toplevel',
      '--show-prefix',
      '--abbrev-ref',
      '--short',
      '--verify',
      '--is-inside-work-tree',
      '--git-dir',
    ],
    operands: true,
  },
  branch: {
    flags: [
      '--show-current',
      '--list',
      '-a',
      '--all',
      '-r',
      '--remotes',
      '-v',
      '-vv',
      ...COMMON_OUTPUT,
    ],
    // `git branch name` creates one, so bare words are not inspection.
    operands: false,
  },
  'ls-files': {
    flags: [
      '-m',
      '--modified',
      '-o',
      '--others',
      '-d',
      '--deleted',
      '-c',
      '--cached',
      '-s',
      '--stage',
      '--exclude-standard',
      '-z',
      '--',
    ],
    operands: true,
  },
};

const NETWORK_GIT = new Set(['push', 'pull', 'fetch', 'clone', 'ls-remote', 'submodule']);

function classifyGit(args: readonly string[]): Classification {
  // Options before the subcommand change which repository, work tree or
  // configuration Git uses: `-C ../..`, `--git-dir`, `-c core.pager=…`.
  let index = 0;
  while (index < args.length && (args[index] as string).startsWith('-')) {
    if (args[index] !== '--no-pager') {
      return sensitive('git-context', 'Changes which repository or configuration Git uses.');
    }
    index += 1;
  }
  const subcommand = args[index];
  const rest = args.slice(index + 1);
  if (!subcommand) return sensitive('unknown', 'Not a Git command Polaris recognises as safe.');

  const rule = SAFE_GIT[subcommand];
  if (rule) {
    const unsafe = rest.find((arg) => !gitArgumentAllowed(rule, arg));
    if (!unsafe) return { risk: 'safe', category: 'inspection', reason: 'Safe Git inspection.' };
    return sensitive(
      'git-write',
      `Uses an option Polaris does not recognise as read-only: ${unsafe}`,
    );
  }
  if (NETWORK_GIT.has(subcommand)) {
    const force = rest.some((arg) =>
      /^(-f|--force|--force-with-lease.*|--mirror|--delete)$/.test(arg),
    );
    return sensitive(
      'network',
      force ? 'Contacts a remote and can overwrite its history.' : 'Contacts a remote repository.',
      force,
    );
  }
  if (isDestructiveGit(subcommand, rest)) {
    return sensitive('git-destructive', 'Can permanently discard uncommitted work.', true);
  }
  return sensitive('git-write', 'Modifies the Git repository.');
}

function gitArgumentAllowed(rule: GitRule, arg: string): boolean {
  if (arg.startsWith('-')) {
    return (
      rule.flags.includes(arg) || (rule.prefixes ?? []).some((prefix) => arg.startsWith(prefix))
    );
  }
  if (!rule.operands) return false;
  // A revision or a path inside the workspace; nothing reaching outside it.
  return !isAbsolute(arg) && !/(^|[\\/])\.\.([\\/]|$)/.test(arg);
}

function isDestructiveGit(subcommand: string, args: readonly string[]): boolean {
  switch (subcommand) {
    case 'reset':
      return args.some((arg) => arg === '--hard' || arg === '--merge' || arg === '--keep');
    case 'clean':
      return args.some((arg) => /^-[a-z]*f/i.test(arg) || arg === '--force');
    case 'restore':
      return true;
    case 'checkout':
      return args.includes('--') || args.includes('.') || args.includes('-f');
    case 'stash':
      return args[0] === 'drop' || args[0] === 'clear';
    case 'branch':
      return args.includes('-D');
    default:
      return false;
  }
}

// ------------------------------------------------------------- the rest

const SHELLS = new Set([
  'bash',
  'sh',
  'zsh',
  'fish',
  'dash',
  'ksh',
  'cmd',
  'powershell',
  'pwsh',
  'wsl',
]);

const NETWORK = new Set([
  'curl',
  'wget',
  'ssh',
  'scp',
  'sftp',
  'ftp',
  'rsync',
  'nc',
  'ncat',
  'netcat',
  'telnet',
  'http',
  'iwr',
  'irm',
  'invoke-webrequest',
  'invoke-restmethod',
]);

const DELETE = new Set([
  'rm',
  'rmdir',
  'del',
  'erase',
  'rd',
  'remove-item',
  'ri',
  'unlink',
  'shred',
]);

const PROJECT_TOOLS = new Set([
  'npm',
  'pnpm',
  'yarn',
  'bun',
  'npx',
  'pnpx',
  'gradle',
  'gradlew',
  'mvn',
  'mvnw',
  'cargo',
  'go',
  'dotnet',
  'make',
  'cmake',
  'ctest',
  'pytest',
  'tox',
  'nox',
  'jest',
  'vitest',
  'mocha',
  'tsc',
  'deno',
  'rake',
  'bundle',
  'composer',
  'swift',
  'sbt',
  'ant',
]);

const INTERPRETERS = new Set([
  'node',
  'python',
  'python3',
  'py',
  'ruby',
  'perl',
  'php',
  'java',
  'lua',
  'rscript',
  'groovy',
]);

const INSTALL_SUBCOMMANDS = new Set([
  'install',
  'i',
  'add',
  'uninstall',
  'remove',
  'rm',
  'un',
  'update',
  'up',
  'upgrade',
  'ci',
  'link',
]);

const DEPENDENCIES = 'May modify dependencies, run install scripts and access the network.';

function dependencyChange(name: string, args: readonly string[]): Classification | null {
  const [subcommand = ''] = args.filter((arg) => !arg.startsWith('-'));
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(name)) {
    // A bare `yarn` installs; so does `npm i`.
    if (INSTALL_SUBCOMMANDS.has(subcommand) || (name === 'yarn' && args.length === 0)) {
      return sensitive('dependencies', DEPENDENCIES);
    }
    return null;
  }
  if (
    ['pip', 'pip3', 'uv', 'poetry', 'pipx', 'conda', 'gem', 'brew', 'choco', 'winget'].includes(
      name,
    )
  ) {
    return sensitive('dependencies', DEPENDENCIES);
  }
  if ((name === 'cargo' || name === 'dotnet') && subcommand === 'add') {
    return sensitive('dependencies', DEPENDENCIES);
  }
  if (name === 'go' && (subcommand === 'get' || subcommand === 'install')) {
    return sensitive('dependencies', DEPENDENCIES);
  }
  return null;
}
