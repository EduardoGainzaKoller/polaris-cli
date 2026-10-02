import type { Capability, PermissionProfile } from '../permissions/policy.ts';
import { AGENT_MAX_RUNTIME_MS, AGENT_MAX_TOOL_CALLS } from '../tools/limits.ts';

/**
 * A Polaris agent: a model given a role, a ceiling on what it may do and a
 * rule for what it starts knowing. This definition is the source of truth.
 * Each provider adapter turns it into its own runtime's mechanism — a new
 * Claude query, a new Codex thread, a new Messages API conversation — and
 * none of them can widen it.
 *
 * What an agent never inherits has no switch here: the parent's
 * conversation, its tool results and the skills it loaded stay with it.
 */
export interface AgentDefinition {
  /** kebab-case. */
  readonly name: string;
  /** What the main agent reads to decide whether to delegate. Never the instructions. */
  readonly description: string;
  /** The agent's role, given to the agent itself and only when it runs. */
  readonly instructions: string;
  /** The most the agent may ever do, whatever the parent may. */
  readonly capabilities: readonly Capability[];
  /** The widest profile it runs under; a narrower parent narrows it further. */
  readonly permissions: PermissionProfile;
  readonly context: ContextPolicy;
  /** The parent's. An agent with a provider or model of its own comes later. */
  readonly provider: 'inherit';
  readonly model: 'inherit';
  readonly budget: AgentBudget;
}

export interface ContextPolicy {
  /** POLARIS.md: shared repository instructions, which are not conversation. */
  readonly project: boolean;
  /** The skill catalog, so the agent can load a skill into its own run. */
  readonly skillCatalog: boolean;
  /** Skills loaded into the run before it starts. */
  readonly skills: readonly string[];
}

export interface AgentBudget {
  /** Tool calls before the run is stopped and returns what it has. */
  readonly maxToolCalls: number;
  readonly maxRuntimeMs: number;
}

export const REPOSITORY_EXPLORER: AgentDefinition = {
  name: 'repository-explorer',
  description:
    'Explore and understand the repository to answer a focused architectural or implementation ' +
    'question. Inspects code, locates the relevant components and returns concise, ' +
    'evidence-backed findings. Read-only.',
  instructions: [
    'You are repository-explorer, the repository exploration specialist of Polaris. You were',
    'given one task by the main agent, and your final message goes back to it, not to a person.',
    '',
    'You are read-only: you can read, list and search files, nothing else. Do not propose code',
    'changes unless they explain a finding, and never claim to have changed anything.',
    '',
    'Work efficiently: start broad (a glob or a search), narrow quickly, and read only the files',
    'that matter to the task. Do not read the whole repository. Use one simple search or read per',
    'step and never write scripts. A focused task usually needs fewer than 15 tool calls; stop',
    'searching as soon as you can answer. Write no progress notes: your only message is the result.',
    '',
    'Prefer concrete evidence from the code. Keep three things apart: what you observed in a',
    'file (basis "observed", with the file and, when useful, the lines), what you reasonably',
    'inferred from it (basis "inferred"), and what you could not determine (an open question).',
    'Never present an inference as something you read.',
  ].join('\n'),
  capabilities: ['read'],
  permissions: 'read-only',
  context: { project: true, skillCatalog: true, skills: [] },
  provider: 'inherit',
  model: 'inherit',
  budget: { maxToolCalls: AGENT_MAX_TOOL_CALLS, maxRuntimeMs: AGENT_MAX_RUNTIME_MS },
};

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The agents Polaris can delegate to. Programmatic for now; no files are read. */
export class AgentRegistry {
  readonly #agents: ReadonlyMap<string, AgentDefinition>;

  constructor(definitions: readonly AgentDefinition[]) {
    const agents = new Map<string, AgentDefinition>();
    for (const definition of definitions) {
      if (!NAME.test(definition.name)) {
        throw new Error(`Agent name "${definition.name}" must be kebab-case.`);
      }
      if (agents.has(definition.name)) {
        throw new Error(`Agent "${definition.name}" is defined twice.`);
      }
      agents.set(definition.name, definition);
    }
    this.#agents = agents;
  }

  static builtin(): AgentRegistry {
    return new AgentRegistry([REPOSITORY_EXPLORER]);
  }

  get(name: string): AgentDefinition | undefined {
    return this.#agents.get(name);
  }

  list(): AgentDefinition[] {
    return [...this.#agents.values()];
  }
}

/** Human tool names for a capability ceiling, for /agents. */
export function toolNames(capabilities: readonly Capability[]): string[] {
  const names: Record<Capability, string[]> = {
    read: ['Read', 'Glob', 'Grep'],
    write: ['Write'],
    edit: ['Edit'],
    command: ['Run'],
  };
  return capabilities.flatMap((capability) => names[capability]);
}
