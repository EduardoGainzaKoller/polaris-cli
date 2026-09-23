import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { debug } from '../core/logger.ts';
import { diffStat, newFileDiff, unifiedDiff } from '../tools/diff.ts';
import {
  BINARY_SNIFF_BYTES,
  MAX_CHECKPOINT_STORE_BYTES,
  MAX_SNAPSHOT_FILE_BYTES,
} from '../tools/limits.ts';
import { resolveInWorkspace } from '../tools/workspace.ts';
import { writeAtomically } from '../tools/write-file.ts';
import { type GitChange, GitClient } from './git.ts';

/**
 * Knows which changes in the workspace are Polaris's.
 *
 * The rule is time, not tools: what changes while a turn is running is
 * Polaris's, whichever runtime or command did it; what changes while Polaris
 * is idle is the user's. The tracker is told which of the two is happening
 * (`reconcile('polaris' | 'user')`) and compares the workspace against a
 * baseline taken when the session started:
 *
 * - with Git, the baseline is the HEAD commit plus a copy of every file that
 *   was already dirty or untracked — so a file the user had modified is
 *   restored to *their* version, never to HEAD;
 * - without Git, it is whatever the file tools announced before touching a
 *   file, captured just before the change.
 *
 * Checkpoints copy only files Polaris has changed, into a temporary store
 * that belongs to the session. Nothing here ever runs a Git command that
 * writes, and nothing restores a file the user changed after Polaris did.
 */

/** Hash of "no file here", distinct from the hash of an empty file. */
export const ABSENT = 'absent';

/** One state of one file, and where its bytes can be read back from. */
interface Version {
  readonly hash: string;
  /**
   * `store`: copied into the checkpoint store. `git`: the baseline commit.
   * `absent`: no file. `lost`: known only by fingerprint (too large, or not a
   * regular file) — it can be recognised but never restored.
   */
  readonly source: 'store' | 'git' | 'absent' | 'lost';
}

export type ChangeKind = 'created' | 'modified' | 'deleted';

export interface FileChange {
  /** Workspace-relative, forward slashes. */
  readonly path: string;
  readonly kind: ChangeKind;
  /** The user had changes in this file before Polaris touched it. */
  readonly preexisting: boolean;
  /** No file tool said it would change it: a command, build or test did. */
  readonly unexpected: boolean;
  /** Changed outside Polaris after Polaris last wrote it; never restored. */
  readonly external: boolean;
}

export interface PreexistingChange {
  readonly path: string;
  readonly change: GitChange | 'changed';
}

export interface Checkpoint {
  readonly id: string;
  readonly label: string;
  readonly at: Date;
  /** Files Polaris had changed at the time; every other file was at its baseline. */
  readonly states: ReadonlyMap<string, Version>;
}

export interface FileDiff {
  readonly path: string;
  readonly kind: ChangeKind;
  readonly added: number;
  readonly removed: number;
  /** Unified diff, or a sentence when there is nothing printable to show. */
  readonly text: string;
}

export interface UndoPlan {
  readonly checkpoint: Checkpoint;
  readonly restore: readonly Restore[];
  readonly skipped: readonly Skipped[];
}

interface Restore {
  readonly path: string;
  /** What the file must still be when the restore runs. */
  readonly expect: string;
  readonly to: Version;
}

export interface Skipped {
  readonly path: string;
  readonly reason: string;
}

export interface UndoResult {
  readonly checkpoint: Checkpoint;
  readonly restored: readonly string[];
  readonly skipped: readonly Skipped[];
}

export interface WorkspaceGit {
  readonly root: string;
  readonly branch: string | null;
  readonly head: string | null;
}

export class CheckpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CheckpointError';
  }
}

export class ChangeTracker {
  readonly cwd: string;
  readonly #git: GitClient | null;
  readonly #store = new SnapshotStore();
  /** The commit the baseline was taken at; later commits do not move it. */
  #baseHead: string | null = null;
  #branch: string | null = null;
  #head: string | null = null;

  /** The state of every file the tracker knows, as the session found it. */
  readonly #baseline = new Map<string, Version>();
  /** Files the user had changed before or between Polaris's turns. */
  readonly #preexisting = new Map<string, GitChange | 'changed'>();
  /** Files Polaris changed → the hash it last left them with. */
  readonly #owned = new Map<string, string>();
  /** Hash of every known file at the last look. */
  readonly #seen = new Map<string, string>();
  readonly #external = new Set<string>();
  readonly #announced = new Set<string>();
  #checkpoints: Checkpoint[] = [];
  #sequence = 0;
  /** Every public operation runs after the previous one: they share state. */
  #queue: Promise<unknown> = Promise.resolve();

  private constructor(cwd: string, git: GitClient | null) {
    this.cwd = cwd;
    this.#git = git;
  }

  /** Detects the repository and takes the session baseline. Never throws. */
  static async start(cwd: string): Promise<ChangeTracker> {
    const tracker = new ChangeTracker(cwd, await GitClient.open(cwd));
    try {
      await tracker.#takeBaseline();
    } catch (error) {
      debug('changes', 'baseline failed', error);
    }
    return tracker;
  }

  get git(): WorkspaceGit | null {
    return this.#git ? { root: this.#git.root, branch: this.#branch, head: this.#head } : null;
  }

  get checkpoints(): readonly Checkpoint[] {
    return this.#checkpoints;
  }

  /**
   * Files a tool is about to change. Their current content becomes their
   * original, unless a better one is known: the baseline copy, or the file
   * at the baseline commit. This is what lets undo work for gitignored files
   * and outside Git, where nothing else would remember the original.
   */
  capture(paths: readonly string[]): Promise<void> {
    return this.#serial(async () => {
      for (const input of paths) {
        const path = this.#local(input);
        if (!path) continue;
        this.#announced.add(path);
        if (this.#baseline.has(path)) continue;
        const original = (await this.#fromHead(path)) ?? (await this.#snapshot(path));
        this.#baseline.set(path, original);
        this.#seen.set(path, original.hash);
      }
    });
  }

  /**
   * Looks at the workspace and attributes what changed since the last look.
   * Returns the paths that changed on Polaris's account.
   */
  reconcile(owner: 'polaris' | 'user'): Promise<string[]> {
    return this.#serial(async () => {
      const status = this.#git ? await this.#git.status() : null;
      if (status) {
        this.#branch = status.branch;
        this.#head = status.head;
      }
      const untracked = new Set(
        status?.entries.filter((entry) => entry.change === 'untracked').map((entry) => entry.path),
      );
      const candidates = new Set<string>([
        ...(status?.entries.flatMap((entry) =>
          entry.from ? [entry.path, entry.from] : [entry.path],
        ) ?? []),
        ...this.#baseline.keys(),
        ...this.#owned.keys(),
      ]);

      const changed: string[] = [];
      for (const path of candidates) {
        let base = this.#baseline.get(path);
        if (!base) {
          // First sighting of a file that was clean at the baseline: its
          // original is the baseline commit's, or nothing if it is new.
          base = untracked.has(path) ? ABSENT_VERSION : await this.#atBaseCommit(path);
          this.#baseline.set(path, base);
        }
        const now = await fingerprint(this.#absolute(path));
        const last = this.#seen.get(path) ?? base.hash;
        if (now.hash === last) continue;
        this.#seen.set(path, now.hash);

        if (owner === 'polaris') {
          this.#owned.set(path, now.hash);
          changed.push(path);
        } else if (this.#owned.has(path)) {
          // Polaris changed it, then someone else did. Undo will leave it be.
          this.#external.add(path);
        } else {
          // The user's own change, made while Polaris was idle: it becomes
          // part of the baseline, exactly like a change made before startup.
          this.#baseline.set(path, await this.#snapshot(path, now));
          this.#preexisting.set(path, now.hash === ABSENT ? 'deleted' : 'changed');
        }
      }
      return changed;
    });
  }

  /** What Polaris changed this session, as of the last reconcile. */
  changes(): FileChange[] {
    const changes: FileChange[] = [];
    for (const path of this.#owned.keys()) {
      const base = this.#baseline.get(path);
      const now = this.#seen.get(path);
      if (!base || now === undefined || now === base.hash) continue;
      changes.push({
        path,
        kind: base.hash === ABSENT ? 'created' : now === ABSENT ? 'deleted' : 'modified',
        preexisting: this.#preexisting.has(path),
        unexpected: !this.#announced.has(path),
        external: this.#external.has(path),
      });
    }
    return changes.sort((a, b) => a.path.localeCompare(b.path));
  }

  /** Changes that were the user's, excluding files Polaris has changed since. */
  preexisting(): PreexistingChange[] {
    const mine = new Set(this.changes().map((change) => change.path));
    return [...this.#preexisting]
      .filter(([path]) => !mine.has(path))
      .map(([path, change]) => ({ path, change }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  /** The diff of one session change, against the file's original. */
  diff(change: FileChange): Promise<FileDiff> {
    return this.#serial(async () => {
      const base = this.#baseline.get(change.path) ?? ABSENT_VERSION;
      const { kind, path } = change;
      if (base.source === 'lost') {
        return {
          path,
          kind,
          added: 0,
          removed: 0,
          text: 'Original not kept (too large or not a regular file).',
        };
      }
      const before = await this.#read(path, base);
      const after = kind === 'deleted' ? null : await readIfFile(this.#absolute(path));
      if ((before && isBinary(before)) || (after && isBinary(after))) {
        return { path, kind, added: 0, removed: 0, text: 'Binary file changed.' };
      }
      const old = before?.toString('utf8') ?? '';
      const next = after?.toString('utf8') ?? '';
      const { added, removed } = diffStat(old, next);
      const text =
        kind === 'created'
          ? newFileDiff(next)
          : kind === 'deleted'
            ? old
                .replace(/\n$/, '')
                .split('\n')
                .map((line) => `-${line}`)
                .join('\n')
            : unifiedDiff(path, old, next);
      return { path, kind, added, removed, text };
    });
  }

  /**
   * Copies every file Polaris has changed. Refuses — rather than creating a
   * checkpoint that silently cannot restore something — when a file is too
   * large to copy or the store is full.
   */
  checkpoint(label?: string): Promise<Checkpoint> {
    return this.#serial(async () => {
      const states = new Map<string, Version>();
      for (const change of this.changes()) {
        const version = await this.#snapshot(change.path);
        if (version.source === 'lost') {
          throw new CheckpointError(
            `Cannot checkpoint ${change.path}: it is larger than ${MAX_SNAPSHOT_FILE_BYTES / 1024 / 1024} MB, not a regular file, or the checkpoint store is full.`,
          );
        }
        states.set(change.path, version);
      }
      const checkpoint: Checkpoint = {
        id: `cp-${++this.#sequence}`,
        label: label?.trim() || `after ${plural(states.size, 'change')}`,
        at: new Date(),
        states,
      };
      this.#checkpoints.push(checkpoint);
      return checkpoint;
    });
  }

  /**
   * What undoing to a checkpoint would do. Without an id: the latest
   * checkpoint with anything to undo, falling back towards the session start.
   * Changes nothing on disk.
   */
  planUndo(id?: string): Promise<UndoPlan> {
    return this.#serial(async () => {
      let index = id
        ? this.#checkpoints.findIndex((checkpoint) => checkpoint.id === id)
        : this.#checkpoints.length - 1;
      if (index < 0) throw new CheckpointError(`No checkpoint named ${id}.`);
      let plan = this.#plan(index);
      while (!id && index > 0 && plan.restore.length === 0 && plan.skipped.length === 0) {
        index -= 1;
        plan = this.#plan(index);
      }
      return plan;
    });
  }

  /**
   * Restores what the plan listed. Each file is checked again first: if it
   * changed since the plan was made — the user saved it while reading the
   * confirmation — it is skipped, not overwritten. Every write is atomic and
   * goes through the same workspace boundary as a tool's.
   */
  undo(plan: UndoPlan): Promise<UndoResult> {
    return this.#serial(async () => {
      const restored: string[] = [];
      const skipped: Skipped[] = [...plan.skipped];
      for (const item of plan.restore) {
        try {
          const file = await resolveInWorkspace(this.cwd, item.path);
          const now = await fingerprint(file);
          if (now.hash !== item.expect) {
            skipped.push({ path: item.path, reason: 'changed while the undo was being confirmed' });
            continue;
          }
          if (item.to.hash === ABSENT) {
            if (now.hash !== ABSENT) await unlink(file);
          } else {
            const content = await this.#read(item.path, item.to);
            if (!content || sha256(content) !== item.to.hash) {
              skipped.push({ path: item.path, reason: 'its saved copy could not be read back' });
              continue;
            }
            await mkdir(dirname(file), { recursive: true });
            await writeAtomically(file, content);
          }
          this.#seen.set(item.path, item.to.hash);
          this.#owned.set(item.path, item.to.hash);
          restored.push(item.path);
        } catch (error) {
          skipped.push({ path: item.path, reason: (error as Error).message });
        }
      }
      // Later checkpoints describe a future that no longer exists.
      const index = this.#checkpoints.indexOf(plan.checkpoint);
      if (index >= 0) this.#checkpoints = this.#checkpoints.slice(0, index + 1);
      return { checkpoint: plan.checkpoint, restored, skipped };
    });
  }

  /** Removes the session's copies. The tracker must not be used afterwards. */
  async dispose(): Promise<void> {
    await this.#queue.catch(() => undefined);
    await this.#store.dispose();
  }

  #plan(index: number): UndoPlan {
    const checkpoint = this.#checkpoints[index] as Checkpoint;
    const paths = new Set<string>(this.#owned.keys());
    for (const later of this.#checkpoints.slice(index)) {
      for (const path of later.states.keys()) paths.add(path);
    }
    const restore: Restore[] = [];
    const skipped: Skipped[] = [];
    for (const path of [...paths].sort()) {
      const want = checkpoint.states.get(path) ?? this.#baseline.get(path);
      const now = this.#seen.get(path);
      if (!want || now === undefined || now === want.hash) continue;
      if (this.#external.has(path)) {
        skipped.push({ path, reason: 'file changed outside Polaris after it was last written' });
      } else if (want.source === 'lost') {
        skipped.push({ path, reason: 'its earlier version was too large to keep' });
      } else {
        restore.push({ path, expect: now, to: want });
      }
    }
    return { checkpoint, restore, skipped };
  }

  async #takeBaseline(): Promise<void> {
    this.#checkpoints = [
      { id: `cp-${++this.#sequence}`, label: 'session start', at: new Date(), states: new Map() },
    ];
    if (!this.#git) return;
    const status = await this.#git.status();
    this.#baseHead = status.head;
    this.#branch = status.branch;
    this.#head = status.head;
    for (const entry of status.entries) {
      const version = await this.#snapshot(entry.path);
      this.#baseline.set(entry.path, version);
      this.#seen.set(entry.path, version.hash);
      this.#preexisting.set(entry.path, entry.change);
      if (entry.from) {
        // The old side of a rename no longer exists in the working tree.
        this.#baseline.set(entry.from, ABSENT_VERSION);
        this.#seen.set(entry.from, ABSENT);
      }
    }
  }

  /** The file as it is now, copied into the store when it can be. */
  async #snapshot(path: string, known?: Fingerprint): Promise<Version> {
    const now = known?.content !== undefined ? known : await fingerprint(this.#absolute(path));
    if (now.hash === ABSENT) return ABSENT_VERSION;
    if (!now.content) return { hash: now.hash, source: 'lost' };
    const kept = await this.#store.put(now.hash, now.content);
    return { hash: now.hash, source: kept ? 'store' : 'lost' };
  }

  /** The file at the baseline commit, when it was tracked there. */
  async #fromHead(path: string): Promise<Version | null> {
    if (!this.#git || !this.#baseHead) return null;
    const version = await this.#atBaseCommit(path);
    return version.hash === ABSENT ? null : version;
  }

  async #atBaseCommit(path: string): Promise<Version> {
    if (!this.#git || !this.#baseHead) return ABSENT_VERSION;
    try {
      const content = await this.#git.fileAt(this.#baseHead, path);
      return content ? { hash: sha256(content), source: 'git' } : ABSENT_VERSION;
    } catch (error) {
      debug('changes', 'no original for', path, error);
      return { hash: 'unknown', source: 'lost' };
    }
  }

  async #read(path: string, version: Version): Promise<Buffer | null> {
    if (version.source === 'absent') return null;
    if (version.source === 'store') return this.#store.get(version.hash);
    if (version.source === 'git' && this.#git && this.#baseHead) {
      return this.#git.fileAt(this.#baseHead, path);
    }
    throw new CheckpointError(`No copy of ${path} was kept.`);
  }

  /** Workspace-relative with forward slashes, or null for anything outside it. */
  #local(input: string): string | null {
    const absolute = isAbsolute(input) ? input : resolve(this.cwd, input);
    const path = relative(this.cwd, absolute);
    if (path === '' || path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path))
      return null;
    return path.split(sep).join('/');
  }

  #absolute(path: string): string {
    return join(this.cwd, path);
  }

  #serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(work, work);
    this.#queue = next.catch(() => undefined);
    return next;
  }
}

const ABSENT_VERSION: Version = { hash: ABSENT, source: 'absent' };

interface Fingerprint {
  readonly hash: string;
  /** The bytes, when the file is small enough to keep. */
  readonly content?: Buffer;
}

/**
 * A file's identity. Regular files up to the snapshot limit are hashed;
 * larger ones are identified by size and modification time. A symlink is
 * never followed — reading through one could copy a file from outside the
 * workspace into a checkpoint — and is identified as such.
 */
async function fingerprint(file: string): Promise<Fingerprint> {
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(file);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { hash: ABSENT };
    throw error;
  }
  if (!info.isFile()) return { hash: `special:${info.isSymbolicLink() ? 'link' : 'other'}` };
  if (info.size > MAX_SNAPSHOT_FILE_BYTES) return { hash: `large:${info.size}:${info.mtimeMs}` };
  const content = await readFile(file);
  return { hash: sha256(content), content };
}

async function readIfFile(file: string): Promise<Buffer | null> {
  const found = await fingerprint(file);
  return found.content ?? null;
}

function sha256(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

function isBinary(content: Buffer): boolean {
  return content.subarray(0, BINARY_SNIFF_BYTES).includes(0);
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * Content-addressed copies in a temporary directory that belongs to one
 * session: created on the first copy, deleted when the session ends, and
 * capped so a model rewriting a huge file cannot fill the disk.
 */
class SnapshotStore {
  #directory: Promise<string> | null = null;
  #bytes = 0;
  readonly #kept = new Set<string>();

  /** False when the copy would exceed the store's budget. */
  async put(hash: string, content: Buffer): Promise<boolean> {
    if (this.#kept.has(hash)) return true;
    if (this.#bytes + content.length > MAX_CHECKPOINT_STORE_BYTES) return false;
    this.#directory ??= mkdtemp(join(tmpdir(), 'polaris-checkpoints-'));
    await writeFile(join(await this.#directory, hash), content);
    this.#kept.add(hash);
    this.#bytes += content.length;
    return true;
  }

  async get(hash: string): Promise<Buffer> {
    if (!this.#directory || !this.#kept.has(hash)) throw new CheckpointError('Snapshot missing.');
    return readFile(join(await this.#directory, hash));
  }

  async dispose(): Promise<void> {
    if (!this.#directory) return;
    const directory = await this.#directory;
    this.#directory = null;
    this.#kept.clear();
    await rm(directory, { recursive: true, force: true }).catch((error: unknown) =>
      debug('changes', 'could not remove', directory, error),
    );
  }
}
