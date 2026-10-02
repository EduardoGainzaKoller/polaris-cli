import { z } from 'zod';
import { MAX_DELEGATION_RESULT_CHARS } from '../tools/limits.ts';

/**
 * What an agent run gives back to whoever delegated it — and the only thing:
 * the files it read, its searches and its reasoning stay in its own context.
 * The status is Polaris's, never the agent's: a run that was stopped or failed
 * says so here, whatever its text claims.
 */
export type DelegationStatus = 'completed' | 'partial' | 'failed' | 'cancelled';

export interface Finding {
  readonly statement: string;
  /** Read in a file, or reasoned from what was read. */
  readonly basis: 'observed' | 'inferred';
  readonly file?: string;
  /** `12-40`, when the agent gave one. */
  readonly lines?: string;
}

export interface DelegationResult {
  readonly agent: string;
  readonly status: DelegationStatus;
  readonly summary: string;
  readonly relevantFiles: readonly string[];
  readonly findings: readonly Finding[];
  readonly openQuestions: readonly string[];
  /** Why the run did not complete, when it did not. */
  readonly reason?: string;
  /** False when the agent's answer did not follow the contract and is kept as text. */
  readonly structured: boolean;
  readonly stats: {
    readonly durationMs: number;
    readonly toolCalls: number;
    /** Files the agent read, as Polaris saw them — not as the agent reports them. */
    readonly filesRead: number;
  };
}

/** What the agent is asked to end with. Polaris adds the status. */
export const RESULT_CONTRACT = [
  'End with your result as a single JSON object, and nothing else, in this shape:',
  '{"summary": "two or three sentences answering the task",',
  ' "relevantFiles": ["path/to/file", "..."],',
  ' "findings": [{"statement": "...", "basis": "observed" | "inferred", "file": "path", "lines": "12-40"}],',
  ' "openQuestions": ["what you could not determine"]}',
  '"file" and "lines" are optional. Keep it concise: findings, not file contents.',
].join('\n');

const text = (max: number) => z.string().trim().min(1).max(max);

const SCHEMA = z.object({
  summary: text(4_000),
  relevantFiles: z.array(text(500)).max(50).catch([]).default([]),
  findings: z
    .array(
      z.object({
        statement: text(2_000),
        basis: z.enum(['observed', 'inferred']).catch('inferred'),
        file: text(500).optional().catch(undefined),
        lines: z.coerce.string().trim().max(40).optional().catch(undefined),
      }),
    )
    .max(40)
    .catch([])
    .default([]),
  openQuestions: z.array(text(1_000)).max(20).catch([]).default([]),
});

type Parsed = z.infer<typeof SCHEMA>;

/**
 * Reads an agent's final answer. The whole answer as JSON first, then a
 * fenced ```json block, then a JSON object that ends the answer on lines of
 * its own — what a runtime that streams its progress notes as separate
 * messages (Codex) produces. Each candidate must parse and validate as a
 * whole; nothing is cut out of the middle of a sentence. Anything else is
 * kept as the summary rather than lost: an imperfect answer still carries
 * what the agent found.
 */
export function parseAnswer(answer: string): { parsed: Parsed | null } {
  const candidates = [answer.trim(), ...fencedBlocks(answer), ...trailingObjects(answer)];
  for (const candidate of candidates) {
    let json: unknown;
    try {
      json = JSON.parse(candidate);
    } catch {
      continue;
    }
    const result = SCHEMA.safeParse(json);
    if (result.success) return { parsed: result.data };
  }
  return { parsed: null };
}

/**
 * The answer's tail from each line that opens an object, nearest the end
 * first: `notes…\n\n{"summary": …}` yields `{"summary": …}`.
 */
function trailingObjects(text: string): string[] {
  const lines = text.trimEnd().split(/\r?\n/);
  const tails: string[] = [];
  for (let index = lines.length - 1; index > 0; index -= 1) {
    if (lines[index]?.trimStart().startsWith('{')) tails.push(lines.slice(index).join('\n'));
  }
  return tails;
}

/** Contents of fenced code blocks, last first: the result is the final one. */
function fencedBlocks(text: string): string[] {
  return [...text.matchAll(/```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```/g)]
    .map((match) => match[1] ?? '')
    .reverse();
}

export function fromAnswer(
  agent: string,
  answer: string,
  stats: DelegationResult['stats'],
  status: DelegationStatus = 'completed',
  reason?: string,
): DelegationResult {
  const { parsed } = parseAnswer(answer);
  const base = { agent, status, stats, ...(reason ? { reason } : {}) };
  if (parsed) {
    return {
      ...base,
      summary: parsed.summary,
      relevantFiles: parsed.relevantFiles,
      findings: parsed.findings.map((finding) => ({
        statement: finding.statement,
        basis: finding.basis,
        ...(finding.file ? { file: finding.file } : {}),
        ...(finding.lines ? { lines: finding.lines } : {}),
      })),
      openQuestions: parsed.openQuestions,
      structured: true,
    };
  }
  return {
    ...base,
    summary: answer.trim() || '(The agent returned no answer.)',
    relevantFiles: [],
    findings: [],
    openQuestions: [],
    structured: false,
  };
}

/** A run that produced no answer: failed, cancelled, or stopped with nothing to say. */
export function emptyResult(
  agent: string,
  status: DelegationStatus,
  reason: string,
  stats: DelegationResult['stats'],
  relevantFiles: readonly string[] = [],
): DelegationResult {
  return {
    agent,
    status,
    reason,
    summary: reason,
    relevantFiles,
    findings: [],
    openQuestions: [],
    structured: false,
    stats,
  };
}

/**
 * The result as the parent model reads it: the status first, so a partial or
 * failed run can never pass for a successful one, and cut to a fixed size
 * with the cut stated.
 */
export function renderResult(result: DelegationResult, max = MAX_DELEGATION_RESULT_CHARS): string {
  const lines = [
    `<delegation_result agent="${result.agent}" status="${result.status}">`,
    ...(result.reason && result.reason !== result.summary ? [`Reason: ${result.reason}`] : []),
    ...(result.structured
      ? []
      : ['(The agent did not return a structured result; its answer follows.)']),
    `Summary: ${result.summary}`,
  ];
  if (result.relevantFiles.length > 0) {
    lines.push('Relevant files:', ...result.relevantFiles.map((file) => `- ${file}`));
  }
  if (result.findings.length > 0) {
    lines.push(
      'Findings:',
      ...result.findings.map((finding) => {
        const where = finding.file
          ? ` (${finding.file}${finding.lines ? `:${finding.lines}` : ''})`
          : '';
        return `- [${finding.basis}] ${finding.statement}${where}`;
      }),
    );
  }
  if (result.openQuestions.length > 0) {
    lines.push('Open questions:', ...result.openQuestions.map((question) => `- ${question}`));
  }
  lines.push(
    `Run: ${count(result.stats.toolCalls, 'tool call')}, ${count(result.stats.filesRead, 'file')} read, ${(result.stats.durationMs / 1000).toFixed(1)}s.`,
  );
  const close = '</delegation_result>';
  const body = lines.join('\n');
  if (body.length + close.length + 1 <= max) return `${body}\n${close}`;
  const note = `\n[Result truncated by Polaris: ${body.length} characters, limit ${max}.]\n${close}`;
  return body.slice(0, Math.max(0, max - note.length)) + note;
}

/** The whole result, for a person: what /agent prints. */
export function resultReport(result: DelegationResult): string {
  const seconds = `${(result.stats.durationMs / 1000).toFixed(1)}s`;
  const head = `  ${result.agent} · ${result.status} · ${seconds} · ${count(result.stats.toolCalls, 'tool call')} · ${count(result.stats.filesRead, 'file')} read`;
  if (result.status === 'failed' || result.status === 'cancelled') {
    return [head, '', `  ${result.reason ?? result.summary}`].join('\n');
  }
  const lines = [head, ''];
  if (result.status === 'partial' && result.reason) lines.push(`  Partial: ${result.reason}`, '');
  lines.push('  Summary', ...indent(result.summary));
  if (result.relevantFiles.length > 0) {
    lines.push('', '  Relevant files', ...result.relevantFiles.map((file) => `    - ${file}`));
  }
  if (result.findings.length > 0) {
    lines.push(
      '',
      '  Findings',
      ...result.findings.map((finding) => {
        const where = finding.file
          ? ` (${finding.file}${finding.lines ? `:${finding.lines}` : ''})`
          : '';
        return `    - [${finding.basis}] ${finding.statement}${where}`;
      }),
    );
  }
  if (result.openQuestions.length > 0) {
    lines.push(
      '',
      '  Open questions',
      ...result.openQuestions.map((question) => `    - ${question}`),
    );
  }
  if (!result.structured) lines.push('', '  (The agent did not return a structured result.)');
  lines.push('', '  Shown to you only: the main agent did not receive this result.');
  return lines.join('\n');
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

function indent(text: string): string[] {
  return text.split('\n').map((line) => `    ${line}`);
}

/** One line for the transcript: `6 files inspected · 4 findings`. */
export function resultLine(result: DelegationResult): string {
  if (result.status === 'failed' || result.status === 'cancelled') {
    return result.reason ?? result.status;
  }
  const files = result.stats.filesRead;
  const parts = [
    `${files} ${files === 1 ? 'file' : 'files'} inspected`,
    ...(result.structured
      ? [`${result.findings.length} ${result.findings.length === 1 ? 'finding' : 'findings'}`]
      : ['unstructured answer']),
  ];
  if (result.status === 'partial') parts.push(`partial: ${result.reason ?? 'stopped early'}`);
  return parts.join(' · ');
}
