import { access, constants, readdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { configPath, polarisHome } from '../config/config.ts';
import { loadProjectContext } from '../context/project.ts';
import { SkillRegistry } from '../context/skills.ts';
import { redact } from '../core/logger.ts';
import { probe } from '../core/process.ts';
import { DEFAULT_PROFILE, toProfile } from '../permissions/policy.ts';
import { detectProviders, type ProviderCheck } from '../providers/detect.ts';
import { GitClient } from '../workspace/git.ts';
import { MIN_NODE_MAJOR, nodeSupported } from './node-check.ts';

/**
 * `polaris doctor`: what a bug report needs, and nothing that changes
 * anything. It opens no UI, writes no file (unless `--report` is asked for),
 * never touches the configuration, runs no project code and sends nothing to
 * a model: runtimes are asked only for their local version and sign-in status.
 */
export type Mark = 'ok' | 'warn' | 'fail' | 'info';

export interface DoctorLine {
  readonly mark: Mark;
  readonly text: string;
  readonly hint?: string;
}

export interface DoctorSection {
  readonly title: string;
  readonly lines: readonly DoctorLine[];
}

export interface DoctorResult {
  readonly sections: readonly DoctorSection[];
  /** True when something prevents Polaris from working at all. */
  readonly blocking: boolean;
  readonly summary: string;
}

export interface ConfigState {
  readonly path: string;
  readonly state: 'missing' | 'ok' | 'invalid';
  readonly detail?: string;
  readonly provider?: string;
  readonly permissions?: string;
}

export interface WorkspaceState {
  readonly accessible: boolean;
  readonly writable: boolean;
  readonly gitRoot: string | null;
  readonly projectFiles: readonly string[];
  readonly skills: number;
  readonly invalidSkills: number;
}

/** Everything the doctor reads, so a test can describe any machine. */
export interface DoctorEnvironment {
  readonly version: string;
  readonly node: string;
  readonly platform: string;
  readonly arch: string;
  readonly terminal: { readonly tty: boolean; readonly columns?: number; readonly term?: string };
  readonly cwd: string;
  providers(): Promise<ProviderCheck[]>;
  git(): Promise<string | null>;
  config(): Promise<ConfigState>;
  workspace(cwd: string): Promise<WorkspaceState>;
}

export async function runDoctor(env: DoctorEnvironment): Promise<DoctorResult> {
  const [providers, git, config, workspace] = await Promise.all([
    env.providers(),
    env.git(),
    env.config(),
    env.workspace(env.cwd),
  ]);
  const nodeOk = nodeSupported(env.node);
  const sections: DoctorSection[] = [];

  sections.push({
    title: 'Polaris',
    lines: [{ mark: 'ok', text: `version ${env.version} · Developer Preview` }],
  });

  sections.push({
    title: 'Runtime',
    lines: [
      nodeOk
        ? { mark: 'ok', text: `Node ${env.node}` }
        : {
            mark: 'fail',
            text: `Node ${env.node} — Polaris requires Node.js >= ${MIN_NODE_MAJOR}`,
            hint: `Install Node.js ${MIN_NODE_MAJOR} LTS or newer from https://nodejs.org`,
          },
      { mark: 'ok', text: `${env.platform} ${env.arch}` },
      env.terminal.tty
        ? {
            mark: 'ok',
            text: `interactive terminal${env.terminal.columns ? ` · ${env.terminal.columns} columns` : ''}${env.terminal.term ? ` · ${env.terminal.term}` : ''}`,
          }
        : {
            mark: 'info',
            text: 'not an interactive terminal — Polaris will use its line mode here',
          },
    ],
  });

  sections.push({
    title: 'Git',
    lines: [
      git
        ? { mark: 'ok', text: git }
        : {
            mark: 'warn',
            text: 'git not found',
            hint: 'Install Git: /diff, checkpoints and change tracking work best inside a repository.',
          },
    ],
  });

  const configured = config.provider ?? 'mock';
  sections.push({
    title: 'Providers',
    lines: providers.flatMap((check): DoctorLine[] => {
      const mark: Mark =
        check.status === 'available'
          ? 'ok'
          : check.status === 'unknown'
            ? 'info'
            : check.id === configured
              ? 'fail'
              : 'warn';
      const tag = check.id === configured ? '  (configured)' : '';
      return [
        {
          mark,
          text: `${check.label}${tag}: ${check.detail}`,
          ...(check.hint ? { hint: check.hint } : {}),
        },
      ];
    }),
  });

  const configLines: DoctorLine[] = [];
  if (config.state === 'missing') {
    configLines.push({
      mark: 'info',
      text: `${config.path} — not created yet (first run will set it up)`,
    });
  } else if (config.state === 'invalid') {
    configLines.push({
      mark: 'fail',
      text: `${config.path} — invalid: ${config.detail ?? 'unreadable'}`,
      hint: 'Fix the file, or delete it to run the first-time setup again.',
    });
  } else {
    configLines.push({ mark: 'ok', text: config.path });
    configLines.push({ mark: 'ok', text: `provider: ${configured}` });
  }
  configLines.push({
    mark: 'ok',
    text: `default permissions: ${config.permissions ?? DEFAULT_PROFILE}`,
  });
  sections.push({ title: 'Configuration', lines: configLines });

  const workspaceLines: DoctorLine[] = [];
  if (!workspace.accessible) {
    workspaceLines.push({
      mark: 'fail',
      text: `${env.cwd} — not accessible`,
      hint: 'Run Polaris from a directory you can read.',
    });
  } else {
    workspaceLines.push({ mark: 'ok', text: `${env.cwd} — accessible` });
    workspaceLines.push(
      workspace.writable
        ? { mark: 'ok', text: 'writable' }
        : { mark: 'warn', text: 'read-only for this user — edits will fail' },
    );
    workspaceLines.push(
      workspace.gitRoot
        ? { mark: 'ok', text: 'Git repository' }
        : {
            mark: 'warn',
            text: 'not a Git repository',
            hint: 'Using Git while testing Polaris is strongly recommended.',
          },
    );
    workspaceLines.push({
      mark: 'info',
      text:
        workspace.projectFiles.length > 0
          ? `POLARIS.md: ${workspace.projectFiles.join(', ')}`
          : 'no POLARIS.md',
    });
    workspaceLines.push({
      mark: workspace.invalidSkills > 0 ? 'warn' : 'info',
      text: `skills: ${workspace.skills} found${workspace.invalidSkills > 0 ? `, ${workspace.invalidSkills} invalid (see /skills)` : ''}`,
    });
  }
  sections.push({ title: 'Workspace', lines: workspaceLines });

  const configuredCheck = providers.find((check) => check.id === configured);
  const blocking = !nodeOk || config.state === 'invalid' || !workspace.accessible;
  const summary = blocking
    ? 'Polaris cannot run until the problems marked × are fixed.'
    : configuredCheck &&
        configuredCheck.status !== 'available' &&
        configuredCheck.status !== 'unknown'
      ? `Polaris can run, but the configured provider (${configured}) is not ready. Try another with --provider.`
      : 'Polaris appears ready.';
  return { sections, blocking, summary };
}

const MARKS: Record<Mark, string> = { ok: '✓', warn: '!', fail: '×', info: '○' };

export function formatDoctor(result: DoctorResult): string {
  const lines = ['Polaris Doctor', ''];
  for (const section of result.sections) {
    lines.push(section.title);
    for (const line of section.lines) {
      lines.push(`  ${MARKS[line.mark]} ${line.text}`);
      if (line.hint) lines.push(`      → ${line.hint}`);
    }
    lines.push('');
  }
  lines.push('Result', `  ${result.summary}`);
  return lines.join('\n');
}

// --------------------------------------------------------------- the machine

export function systemEnvironment(version: string, cwd = process.cwd()): DoctorEnvironment {
  return {
    version,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    terminal: {
      tty: process.stdout.isTTY === true && process.stdin.isTTY === true,
      ...(process.stdout.columns ? { columns: process.stdout.columns } : {}),
      ...(process.env.WT_SESSION
        ? { term: 'Windows Terminal' }
        : process.env.TERM
          ? { term: process.env.TERM }
          : {}),
    },
    cwd,
    providers: () => detectProviders(),
    git: async () => (await probe('git', ['--version']))?.stdout.trim() || null,
    config: readConfigState,
    workspace: inspectWorkspace,
  };
}

/** Reads the configuration without the loader's side effects or its errors. */
async function readConfigState(): Promise<ConfigState> {
  const path = configPath();
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { path, state: 'missing' };
    return { path, state: 'invalid', detail: (error as Error).message };
  }
  try {
    const parsed = JSON.parse(text.replace(/^﻿/, '')) as Record<string, unknown>;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { path, state: 'invalid', detail: 'expected a JSON object' };
    }
    const permissions =
      typeof parsed.permissions === 'string'
        ? (toProfile(parsed.permissions) ?? undefined)
        : undefined;
    return {
      path,
      state: 'ok',
      ...(typeof parsed.provider === 'string' ? { provider: parsed.provider } : {}),
      ...(permissions ? { permissions } : {}),
    };
  } catch (error) {
    return { path, state: 'invalid', detail: (error as Error).message };
  }
}

async function inspectWorkspace(cwd: string): Promise<WorkspaceState> {
  try {
    await readdir(cwd);
  } catch {
    return {
      accessible: false,
      writable: false,
      gitRoot: null,
      projectFiles: [],
      skills: 0,
      invalidSkills: 0,
    };
  }
  const writable = await access(cwd, constants.W_OK).then(
    () => true,
    () => false,
  );
  const git = await GitClient.open(cwd);
  const project = await loadProjectContext(cwd, git?.root ?? null);
  const skills = await SkillRegistry.discover({
    project: join(cwd, '.polaris', 'skills'),
    user: join(polarisHome(), 'skills'),
  });
  return {
    accessible: true,
    writable,
    gitRoot: git?.root ?? null,
    projectFiles: project.sources.map((source) => source.display),
    skills: skills.list().length,
    invalidSkills: skills.invalid().length,
  };
}

// ---------------------------------------------------------------- the report

/** What `--report` puts in the file, said before it is written. */
export const REPORT_CONTENTS = [
  'The report contains: the Polaris, Node and OS versions, the doctor checks above,',
  'the shape of your configuration (provider and permission profile; it holds no',
  'secrets), and error lines from your most recent session log. Your home directory',
  'is shown as ~ and credentials are redacted. It holds no source code and no',
  'conversation. It is saved locally; nothing is sent anywhere.',
].join('\n');

/**
 * Writes a sanitised report next to where Polaris was run and returns its path.
 * The user reads it and decides whether to share it.
 */
export async function writeReport(
  doctorText: string,
  directory: string,
  now = new Date(),
): Promise<string> {
  const errors = await recentErrors();
  const body = [
    doctorText,
    '',
    'Recent errors (latest session log)',
    ...(errors.length > 0 ? errors.map((line) => `  ${line}`) : ['  none']),
    '',
  ].join('\n');
  const path = join(directory, `polaris-report-${now.toISOString().slice(0, 10)}.txt`);
  await writeFile(path, sanitize(body), 'utf8');
  return path;
}

/** Home directory as ~, credentials redacted. */
export function sanitize(text: string, home = homedir()): string {
  const escaped = home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return redact(text.replace(new RegExp(escaped, 'gi'), '~'));
}

async function recentErrors(): Promise<string[]> {
  const directory = join(polarisHome(), 'logs');
  try {
    const names = (await readdir(directory))
      .filter((name) => /^polaris-.*\.log$/.test(name))
      .sort();
    const latest = names.at(-1);
    if (!latest) return [];
    const text = await readFile(join(directory, latest), 'utf8');
    return text
      .split(/\r?\n/)
      .filter((line) => /\] (error|crash|provider) /.test(line))
      .slice(-15)
      .map((line) => line.slice(0, 300));
  } catch {
    return [];
  }
}
