import { spawn } from 'node:child_process';

/**
 * The little Git that Polaris needs: where the repository is, what is dirty,
 * and what a file looked like at a commit. Every call is read-only, takes an
 * argument array (never a shell string) and asks for machine-readable output,
 * so nothing depends on the user's language or on quoting.
 *
 * There is deliberately no add, commit, checkout, restore, reset, stash or
 * clean here. Polaris observes the repository; it does not operate it.
 */

export type GitChange = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflicted';

export interface GitEntry {
  /** Relative to the workspace (not the repository root), with forward slashes. */
  readonly path: string;
  readonly change: GitChange;
  /** True when the index holds part of the change. */
  readonly staged: boolean;
  /** For a rename Git detected, the old workspace-relative path. */
  readonly from?: string;
}

export interface GitStatus {
  /** null when HEAD is detached. */
  readonly branch: string | null;
  /** Full commit id, or null in a repository with no commits yet. */
  readonly head: string | null;
  readonly entries: readonly GitEntry[];
}

export class GitClient {
  /** The repository root, as Git reports it. Informational only: never a permission. */
  readonly root: string;
  /** The workspace's path inside the repository, e.g. `backend/`, or '' at the root. */
  readonly prefix: string;
  readonly #cwd: string;

  private constructor(cwd: string, root: string, prefix: string) {
    this.#cwd = cwd;
    this.root = root;
    this.prefix = prefix;
  }

  /** null when `cwd` is not inside a repository, or Git is not installed. */
  static async open(cwd: string): Promise<GitClient | null> {
    try {
      const result = await git(cwd, ['rev-parse', '--show-toplevel', '--show-prefix']);
      if (result.code !== 0) return null;
      const [root = '', prefix = ''] = result.stdout.toString('utf8').split(/\r?\n/);
      return root ? new GitClient(cwd, root, prefix) : null;
    } catch {
      return null;
    }
  }

  /**
   * Porcelain v2 with NUL separators: the one status format that is stable
   * across Git versions and locales and survives spaces, quotes and Unicode in
   * paths. Limited to the workspace (`-- .`), so a dirty sibling directory in
   * the same repository is not Polaris's business.
   */
  async status(): Promise<GitStatus> {
    const result = await git(this.#cwd, [
      'status',
      '--porcelain=v2',
      '-z',
      '--branch',
      '--untracked-files=all',
      '--',
      '.',
    ]);
    if (result.code !== 0) throw new Error(`git status failed: ${result.stderr.trim()}`);
    return parseStatus(result.stdout.toString('utf8'), this.prefix);
  }

  /**
   * A file's content at `commit`, converted exactly as a checkout would write
   * it (`--filters`: line endings, smudge filters) — otherwise every Windows
   * file under `core.autocrlf` would look entirely rewritten. null when the
   * file did not exist there. Throws for entries that are not regular files
   * (symlinks, submodules), which Polaris never restores.
   */
  async fileAt(commit: string, path: string): Promise<Buffer | null> {
    const inRepo = `${this.prefix}${path}`;
    const listed = await git(this.#cwd, ['ls-tree', '--full-tree', '-z', commit, '--', inRepo]);
    if (listed.code !== 0) throw new Error(`git ls-tree failed: ${listed.stderr.trim()}`);
    const entry = listed.stdout.toString('utf8').split('\0')[0] ?? '';
    if (entry === '') return null;
    const mode = entry.split(' ')[0];
    if (mode !== '100644' && mode !== '100755') {
      throw new Error(`${path} is not a regular file in ${commit.slice(0, 7)}.`);
    }
    const blob = await git(this.#cwd, ['cat-file', '--filters', `${commit}:${inRepo}`]);
    if (blob.code !== 0) throw new Error(`git cat-file failed: ${blob.stderr.trim()}`);
    return blob.stdout;
  }
}

/** Parses `git status --porcelain=v2 -z --branch` into workspace-relative entries. */
export function parseStatus(output: string, prefix = ''): GitStatus {
  const tokens = output.split('\0');
  const entries: GitEntry[] = [];
  let branch: string | null = null;
  let head: string | null = null;
  // Paths come relative to the repository root; the workspace may be below it.
  const local = (path: string): string | null =>
    path.startsWith(prefix) ? path.slice(prefix.length) : null;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? '';
    if (token.startsWith('# branch.oid ')) {
      const oid = token.slice('# branch.oid '.length);
      head = oid === '(initial)' ? null : oid;
      continue;
    }
    if (token.startsWith('# branch.head ')) {
      const name = token.slice('# branch.head '.length);
      branch = name === '(detached)' ? null : name;
      continue;
    }
    const kind = token[0];
    if (kind === '?') {
      const path = local(token.slice(2));
      if (path) entries.push({ path, change: 'untracked', staged: false });
      continue;
    }
    if (kind !== '1' && kind !== '2' && kind !== 'u') continue;

    // The path is everything after a fixed number of space-separated fields,
    // so a path containing spaces is still read whole.
    const fields = token.split(' ');
    const xy = fields[1] ?? '..';
    const skip = kind === '1' ? 8 : kind === '2' ? 9 : 10;
    const path = local(fields.slice(skip).join(' '));
    // A rename carries its original path as the next NUL-separated token.
    const original = kind === '2' ? local(tokens[++index] ?? '') : null;
    if (!path) continue;

    const staged = xy[0] !== '.';
    const change: GitChange =
      kind === 'u'
        ? 'conflicted'
        : kind === '2'
          ? 'renamed'
          : xy.includes('D')
            ? 'deleted'
            : xy[0] === 'A'
              ? 'added'
              : 'modified';
    entries.push({ path, change, staged, ...(original ? { from: original } : {}) });
  }
  return { branch, head, entries };
}

interface GitResult {
  readonly code: number;
  readonly stdout: Buffer;
  readonly stderr: string;
}

function git(cwd: string, args: readonly string[]): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-c', 'core.quotepath=off', ...args], {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        // `git status` refreshes the index when it can, which is a write.
        // Optional locks off keeps it a pure read, and never contends with
        // the user's own Git running at the same time.
        GIT_OPTIONAL_LOCKS: '0',
        GIT_TERMINAL_PROMPT: '0',
      },
    });
    const out: Buffer[] = [];
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout: Buffer.concat(out), stderr }));
  });
}
