import type { Dirent } from 'node:fs';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  BINARY_SNIFF_BYTES,
  MAX_REFERENCE_BYTES,
  MAX_SKILL_BYTES,
  MAX_SKILL_DESCRIPTION,
  MAX_SKILL_REFERENCES,
} from '../tools/limits.ts';
import { resolveInWorkspace } from '../tools/workspace.ts';

/**
 * Skills: reusable instructions for a kind of task, with optional reference
 * files. A skill is knowledge, not capability — it registers no tool, runs no
 * code and cannot change a permission; it only tells the model how to use
 * what Polaris already offers.
 *
 *   <workspace>/.polaris/skills/<name>/SKILL.md        project scope
 *   ~/.polaris/skills/<name>/SKILL.md                  user scope
 *
 * Discovery keeps only the frontmatter's name and description. The body is
 * read when the skill is loaded, and a reference when it is asked for.
 */
export type SkillScope = 'project' | 'user';

export interface SkillMetadata {
  readonly name: string;
  readonly description: string;
  readonly scope: SkillScope;
  /** Absolute path of the skill's directory. */
  readonly directory: string;
  /** How to show where it came from: `.polaris/skills/x` or `~/.polaris/skills/x`. */
  readonly display: string;
  /** A user skill of the same name that this project skill hides. */
  readonly overrides?: string;
}

export interface InvalidSkill {
  readonly name: string;
  readonly scope: SkillScope;
  readonly display: string;
  readonly error: string;
}

export interface Skill {
  readonly metadata: SkillMetadata;
  /** The body of SKILL.md, without its frontmatter. */
  readonly instructions: string;
  /** Reference files, relative to the skill directory: `references/x.md`. */
  readonly references: readonly string[];
}

export class SkillError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillError';
  }
}

export interface SkillRoots {
  readonly project: string;
  readonly user: string;
}

/** Lowercase kebab case: no dots, no slashes, nothing that could name a path. */
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_NAME = 64;
export const SKILL_FILE = 'SKILL.md';

export class SkillRegistry {
  readonly #skills: ReadonlyMap<string, SkillMetadata>;
  readonly #invalid: readonly InvalidSkill[];

  private constructor(skills: Map<string, SkillMetadata>, invalid: InvalidSkill[]) {
    this.#skills = skills;
    this.#invalid = invalid;
  }

  static empty(): SkillRegistry {
    return new SkillRegistry(new Map(), []);
  }

  /** Finds every skill in both scopes. A missing directory is simply no skills. */
  static async discover(roots: SkillRoots): Promise<SkillRegistry> {
    const invalid: InvalidSkill[] = [];
    const user = await scan(roots.user, 'user', invalid);
    const project = await scan(roots.project, 'project', invalid);
    const skills = new Map<string, SkillMetadata>();
    for (const skill of user) skills.set(skill.name, skill);
    // Project beats user, whole: the two are never merged.
    for (const skill of project) {
      const hidden = skills.get(skill.name);
      skills.set(skill.name, hidden ? { ...skill, overrides: hidden.display } : skill);
    }
    return new SkillRegistry(skills, invalid);
  }

  list(): SkillMetadata[] {
    return [...this.#skills.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  invalid(): readonly InvalidSkill[] {
    return this.#invalid;
  }

  get(name: string): SkillMetadata | undefined {
    return this.#skills.get(name);
  }

  /** Reads the whole skill. SKILL.md is re-read, so an edit since discovery is seen. */
  async load(name: string): Promise<Skill> {
    const metadata = this.#skills.get(name);
    if (!metadata) throw new SkillError(`No skill named "${name}".`);
    const { body } = await readSkillFile(metadata.directory, name);
    return {
      metadata,
      instructions: body,
      references: await listReferences(metadata.directory),
    };
  }

  /**
   * One reference file of one skill. The path is resolved inside the skill's
   * `references/` directory with the same real-path check the workspace uses,
   * so `..`, absolute paths and links pointing out are all refused.
   */
  async reference(name: string, path: string): Promise<string> {
    const metadata = this.#skills.get(name);
    if (!metadata) throw new SkillError(`No skill named "${name}".`);
    const inside = path.replaceAll('\\', '/').replace(/^(\.\/)?references\//, '');
    let file: string;
    try {
      file = await resolveInWorkspace(join(metadata.directory, 'references'), inside);
    } catch {
      throw new SkillError(`${path} is not a reference of ${name}.`);
    }
    const info = await lstat(file).catch(() => null);
    if (!info?.isFile()) throw new SkillError(`${name} has no reference ${path}.`);
    if (info.size > MAX_REFERENCE_BYTES) {
      throw new SkillError(`Reference ${path} is too large to load (${info.size} bytes).`);
    }
    const content = await readFile(file);
    if (content.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
      throw new SkillError(`Reference ${path} is a binary file.`);
    }
    return content.toString('utf8');
  }
}

async function scan(root: string, scope: SkillScope, invalid: InvalidSkill[]) {
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: SkillMetadata[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    // One level only, real directories only: a link could lead anywhere.
    if (!entry.isDirectory()) continue;
    const directory = join(root, entry.name);
    const display = displayOf(scope, entry.name);
    try {
      const { name, description } = await readSkillFile(directory, entry.name);
      found.push({ name, description, scope, directory, display });
    } catch (error) {
      invalid.push({ name: entry.name, scope, display, error: (error as Error).message });
    }
  }
  return found;
}

/** Parses and validates SKILL.md. Every problem is a sentence, never a crash. */
async function readSkillFile(
  directory: string,
  folder: string,
): Promise<{ name: string; description: string; body: string }> {
  const path = join(directory, SKILL_FILE);
  const info = await lstat(path).catch(() => null);
  if (!info) throw new SkillError('missing SKILL.md');
  if (!info.isFile()) throw new SkillError('SKILL.md is not a regular file');
  if (info.size > MAX_SKILL_BYTES) {
    throw new SkillError(`SKILL.md is too large to load (over ${MAX_SKILL_BYTES / 1024} KB)`);
  }
  const text = (await readFile(path, 'utf8')).replace(/^﻿/, '');
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!match) throw new SkillError('invalid frontmatter: SKILL.md must start with a --- block');

  let data: unknown;
  try {
    data = parseYaml(match[1] ?? '');
  } catch (error) {
    throw new SkillError(`invalid frontmatter: ${(error as Error).message.split('\n')[0]}`);
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new SkillError('invalid frontmatter: expected name and description');
  }
  const { name, description } = data as Record<string, unknown>;
  if (typeof name !== 'string' || name.trim() === '') throw new SkillError('missing name');
  if (!NAME.test(name) || name.length > MAX_NAME) {
    throw new SkillError(`invalid name "${name}": use lowercase-kebab-case`);
  }
  // The folder is the identity; a name that disagrees with it is ambiguous.
  if (name !== folder) {
    throw new SkillError(`name "${name}" does not match its directory "${folder}"`);
  }
  if (typeof description !== 'string' || description.trim() === '') {
    throw new SkillError('missing description');
  }
  if (description.length > MAX_SKILL_DESCRIPTION) {
    throw new SkillError(`description is longer than ${MAX_SKILL_DESCRIPTION} characters`);
  }
  return {
    name,
    description: description.trim().replace(/\s+/g, ' '),
    body: text.slice(match[0].length).trim(),
  };
}

/** Files under `references/`, listed but never read here. */
async function listReferences(directory: string): Promise<string[]> {
  const root = join(directory, 'references');
  const found: string[] = [];
  const pending = [root];
  while (pending.length > 0 && found.length < MAX_SKILL_REFERENCES) {
    const current = pending.shift() as string;
    let entries: Dirent[];
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) found.push(relative(directory, path).split(sep).join('/'));
    }
  }
  return found.slice(0, MAX_SKILL_REFERENCES);
}

function displayOf(scope: SkillScope, name: string): string {
  return scope === 'project' ? `.polaris/skills/${name}` : `~/.polaris/skills/${name}`;
}
