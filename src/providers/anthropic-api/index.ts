import Anthropic from '@anthropic-ai/sdk';
import {
  LOAD_SKILL,
  LOAD_SKILL_DESCRIPTION,
  READ_REFERENCE_DESCRIPTION,
  READ_SKILL_REFERENCE,
} from '../../context/manager.ts';
import { PolarisError } from '../../core/errors.ts';
import { debug } from '../../core/logger.ts';
import { COMPLETION_GUIDANCE } from '../../core/verification.ts';
import type { PermissionProfile } from '../../permissions/policy.ts';
import { AUTONOMY_GUIDANCE, PERMISSION_PROFILES } from '../../permissions/policy.ts';
import { streamOutput, toolFinished, toolResultText, toolStarted } from '../../tools/events.ts';
import { MAX_TOOL_ROUNDS } from '../../tools/limits.ts';
import { createRegistry, polarisAccess } from '../../tools/registry.ts';
import type {
  ModelEvent,
  ModelProvider,
  ModelSession,
  ProviderSessionOptions,
} from '../provider.ts';
import { toPolarisError } from './errors.ts';
import { UsageTracker } from './usage.ts';

/** Single place to change what Polaris talks to by default. */
export const DEFAULT_MODEL = 'claude-opus-5';

/** Answers are streamed, so a long one never hits the SDK's HTTP timeout. */
const MAX_TOKENS = 32_000;

/**
 * `medium` keeps time-to-first-token short for conversational use; /effort
 * changes it per request, so a switch never costs the conversation. Thinking is
 * left at the model default (adaptive) — Polaris cannot render thinking yet.
 */
const DEFAULT_EFFORT = 'medium';

/** The `output_config.effort` levels of current Claude models. */
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
type Effort = (typeof EFFORTS)[number];

/**
 * The prompt states the policy the tools already enforce. It exists so the
 * model plans sensibly — proposing an edit it is not allowed to make wastes a
 * turn — not as the enforcement itself, which is the registry and the gate.
 */
function systemPrompt(profile: PermissionProfile): string {
  const shared = [
    'You are Polaris, a coding assistant running inside an interactive terminal CLI.',
    'Answer in plain text: the terminal does not render Markdown yet.',
    'You can inspect the workspace with read_file, glob_files and grep_text. Paths are',
    'relative to the workspace root. Look at the code before answering questions about it.',
  ];
  if (profile === 'read-only') {
    return [
      ...shared,
      'Your access is read-only: you cannot create, edit, move or delete files, or run commands.',
      'If asked to change something, say so and describe the change instead.',
    ].join(' ');
  }
  return [
    ...shared,
    'You can also change the workspace with write_file and edit_file, and run commands with',
    'run_command. Everything stays inside the workspace root. Prefer edit_file over write_file',
    'for a change to part of a file, and always read a file before editing it, because oldText',
    'must match exactly.',
    AUTONOMY_GUIDANCE,
    'A non-zero exit code from run_command is information, not a failure of the tool — read',
    'the output and decide what to do next.',
    COMPLETION_GUIDANCE,
  ].join(' ');
}

const SKILL_TOOLS: Anthropic.Tool[] = [
  {
    name: LOAD_SKILL,
    description: LOAD_SKILL_DESCRIPTION,
    input_schema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'The skill name, as listed.' } },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: READ_SKILL_REFERENCE,
    description: READ_REFERENCE_DESCRIPTION,
    input_schema: {
      type: 'object',
      properties: {
        skill: { type: 'string', description: 'A loaded skill.' },
        path: { type: 'string', description: 'A reference path it lists, e.g. references/x.md.' },
      },
      required: ['skill', 'path'],
      additionalProperties: false,
    },
  },
];

/**
 * Polaris owns the agent loop here, because the Messages API is stateless:
 * stream a response, run the tools it asks for, send the results back, repeat.
 * The SDK's Tool Runner would hide the per-call events the UI renders, so the
 * loop is written out — it is short.
 */
export const anthropicApiProvider: ModelProvider = {
  id: 'anthropic-api',
  supports: PERMISSION_PROFILES,
  async createSession(options: ProviderSessionOptions): Promise<ModelSession> {
    // Credentials are resolved by the SDK itself (ANTHROPIC_API_KEY,
    // ANTHROPIC_AUTH_TOKEN, or an `ant auth login` profile). Polaris never
    // reads credential files or reuses another tool's tokens.
    let client: Anthropic;
    try {
      client = new Anthropic();
    } catch (error) {
      throw toPolarisError(error);
    }

    const model = options.model ?? DEFAULT_MODEL;
    const registry = createRegistry(options.permissions, options.gate);
    const prompt = systemPrompt(options.permissions);
    const usage = new UsageTracker();
    const context = options.context;
    const tools: Anthropic.Tool[] = [
      ...registry.list().map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: { ...tool.inputSchema, required: [...tool.inputSchema.required] },
      })),
      // Not workspace tools: they ask Polaris's context manager for a skill,
      // which is why they never reach the registry or the permission gate.
      ...(context?.hasSkills ? SKILL_TOOLS : []),
    ];
    // Rendered for every request, so a skill loaded mid-turn, a reloaded
    // POLARIS.md or an unloaded skill is what the very next request sees.
    const system = () =>
      [prompt, context?.instructions({ canLoad: true })].filter(Boolean).join('\n\n');
    // The conversation lives here and is replayed every request. This is the
    // only place in Polaris that knows Anthropic's message shape.
    const messages: Anthropic.MessageParam[] = [];
    let effort: Effort = asEffort(options.effort ?? DEFAULT_EFFORT);

    return {
      model,
      access: polarisAccess(options.permissions),
      liveInstructions: true,
      get effort() {
        return effort;
      },
      async efforts() {
        return [...EFFORTS];
      },
      async setEffort(level) {
        effort = asEffort(level);
      },
      async *send(input, signal): AsyncIterable<ModelEvent> {
        signal?.throwIfAborted();
        messages.push({ role: 'user', content: input });

        let settled = false;
        let partial = '';
        try {
          yield { type: 'message-start' };

          for (let round = 1; ; round += 1) {
            if (round > MAX_TOOL_ROUNDS) {
              throw new PolarisError(
                `Stopped after ${MAX_TOOL_ROUNDS} tool rounds without a final answer.`,
              );
            }

            partial = '';
            // A request is in flight: after a tool round this is "waiting for
            // the model" again, not the tool still running.
            options.activity?.waiting('model');
            const stream = client.messages.stream(
              {
                model,
                max_tokens: MAX_TOKENS,
                system: system(),
                output_config: { effort },
                tools,
                messages,
              },
              signal ? { signal } : {},
            );
            for await (const event of stream) {
              options.activity?.pulse();
              if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
                partial += event.delta.text;
                yield { type: 'text-delta', text: event.delta.text };
              }
            }
            const message = await stream.finalMessage();
            // Tokens come from the message; the ceilings come from the
            // response headers, which is the only place the API states them.
            usage.record(model, message.usage);
            usage.recordHeaders(stream.response);
            // The full content goes back into history — tool_use blocks included —
            // so the next request sees exactly what the model produced.
            messages.push({ role: 'assistant', content: message.content });
            partial = '';

            const calls = message.content.filter(
              (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
            );
            if (message.stop_reason !== 'tool_use' || calls.length === 0) break;

            // One at a time, and in the order the model asked. Read-only calls
            // could run in parallel, but a mutating one cannot: two approvals
            // open at once is a UI nobody can answer, and two writes racing on
            // one file is worse. Ordering costs a little latency and buys a
            // transcript that matches what actually happened.
            const results: Array<{ text: string; error: boolean }> = [];
            for (const call of calls) {
              // Skill requests are answered by the context manager, which
              // reports them to the UI itself; they are not tool activity.
              if (context && (call.name === LOAD_SKILL || call.name === READ_SKILL_REFERENCE)) {
                const input = (call.input ?? {}) as Record<string, unknown>;
                const reply =
                  call.name === LOAD_SKILL
                    ? await context.loadSkill(String(input.name ?? ''), { inline: false })
                    : await context.readReference(
                        String(input.skill ?? ''),
                        String(input.path ?? ''),
                      );
                results.push({ text: reply.text, error: !reply.ok });
                continue;
              }
              yield toolStarted(registry, call.id, call.name, call.input);
              // A long test run prints as it goes, not all at once at the end.
              const result = yield* streamOutput(call.id, (onOutput) =>
                registry.execute(call.name, call.input, {
                  cwd: options.cwd,
                  ...(signal ? { signal } : {}),
                  onOutput,
                }),
              );
              results.push({ text: toolResultText(result), error: !result.ok });
              yield toolFinished(call.id, result);
            }
            // Every result in a single user message, errors included: splitting
            // them, or dropping failures, degrades the model's tool use.
            messages.push({
              role: 'user',
              content: results.map((result, index) => ({
                type: 'tool_result',
                tool_use_id: (calls[index] as Anthropic.ToolUseBlock).id,
                content: result.text,
                ...(result.error ? { is_error: true } : {}),
              })),
            });
          }

          settled = true;
          yield { type: 'message-end' };
        } catch (error) {
          if (signal?.aborted || error instanceof PolarisError) throw error;
          throw toPolarisError(error);
        } finally {
          if (!settled) repairHistory(messages, partial);
          debug('anthropic', 'turn finished, history entries', messages.length);
        }
      },
      async listModels() {
        const page = await client.models.list({ limit: 50 });
        return page.data.map((entry) => entry.id);
      },
      async usage() {
        const models = usage.models;
        if (models.length === 0 && usage.limits.length === 0) return null;
        return {
          models,
          limits: usage.limits,
          // The Messages API prices nothing in its responses, and a cost
          // computed from a price list Polaris carries would be a guess
          // presented as a number.
          note: 'Tokens counted by Polaris for this session. The API reports no cost.',
        };
      },
      async close() {
        messages.length = 0;
      },
    };
  },
};

/**
 * A turn that stopped early must still leave a history the API accepts on the
 * next request. A `tool_use` without its `tool_result` is rejected, so pending
 * calls are answered as cancelled; a partially streamed answer is kept, because
 * the user already read it.
 */
function repairHistory(messages: Anthropic.MessageParam[], partial: string): void {
  const last = messages.at(-1);
  if (last?.role === 'assistant' && Array.isArray(last.content)) {
    const pending = last.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
    );
    if (pending.length > 0) {
      messages.push({
        role: 'user',
        content: pending.map((block) => ({
          type: 'tool_result',
          tool_use_id: block.id,
          content: 'Cancelled before the tool finished.',
          is_error: true,
        })),
      });
      return;
    }
  }
  if (partial.length > 0) messages.push({ role: 'assistant', content: partial });
}

function asEffort(level: string): Effort {
  if ((EFFORTS as readonly string[]).includes(level)) return level as Effort;
  throw new PolarisError(`Unknown effort "${level}". Use one of: ${EFFORTS.join(', ')}.`);
}
