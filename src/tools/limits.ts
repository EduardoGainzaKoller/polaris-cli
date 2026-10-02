/**
 * Every ceiling the repository tools enforce, in one place. They exist to keep
 * a single tool call from flooding the model's context or stalling Polaris.
 */

/** Largest file read or searched whole. Bigger files need a line range. */
export const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** Lines returned when `read_file` is called without a limit. */
export const DEFAULT_READ_LINES = 1000;

/** Hard cap on lines returned by a single `read_file` call. */
export const MAX_READ_LINES = 2000;

/** Lines longer than this are cut when shown to the model. */
export const MAX_LINE_CHARS = 2000;

/** Paths returned by one `glob_files` call. */
export const MAX_GLOB_RESULTS = 500;

/** Matching lines returned by one `grep_text` call. */
export const MAX_GREP_RESULTS = 200;

/** Upper bound on a search pattern, which also bounds regex compile cost. */
export const MAX_PATTERN_LENGTH = 500;

/** Bytes inspected to decide whether a file is binary. */
export const BINARY_SNIFF_BYTES = 8000;

/** Directories never walked: huge, and never what a question is about. */
export const ALWAYS_IGNORED = ['.git', 'node_modules'] as const;

/** Model round-trips allowed in one turn before Polaris stops the loop. */
export const MAX_TOOL_ROUNDS = 25;

/** Diff lines shown in an approval preview before it is cut. */
export const MAX_DIFF_LINES = 40;

/** Largest file `write_file` will create or replace. */
export const MAX_WRITE_BYTES = 5 * 1024 * 1024;

/** How long a command may run before Polaris terminates it. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;

/** Ceiling on a timeout the model may ask for. */
export const MAX_COMMAND_TIMEOUT_MS = 600_000;

/**
 * Characters of combined stdout/stderr returned to the model. The UI receives
 * the whole stream as it arrives; only what goes back into the context is cut,
 * because a test suite can easily produce megabytes.
 */
export const MAX_COMMAND_OUTPUT = 30_000;

/** Output lines kept from the start when a command's output is truncated. */
export const COMMAND_OUTPUT_HEAD_LINES = 60;

/** Output lines kept from the end — where a failure usually is. */
export const COMMAND_OUTPUT_TAIL_LINES = 120;

/**
 * Largest file a checkpoint copies. A bigger one is still tracked by size and
 * modification time, but cannot be restored, and a checkpoint that would need
 * to copy it refuses rather than pretending to protect it.
 */
export const MAX_SNAPSHOT_FILE_BYTES = 5 * 1024 * 1024;

/** Total bytes one session may copy into its checkpoint store. */
export const MAX_CHECKPOINT_STORE_BYTES = 256 * 1024 * 1024;

/** Diff lines `/diff` prints before cutting; the file list is never cut. */
export const MAX_SESSION_DIFF_LINES = 400;

/**
 * Largest POLARIS.md read. A bigger one is refused, never truncated: cutting a
 * file of instructions in half can change what it says.
 */
export const MAX_PROJECT_CONTEXT_BYTES = 64 * 1024;

/** Largest SKILL.md, refused rather than truncated for the same reason. */
export const MAX_SKILL_BYTES = 64 * 1024;

/** Largest skill reference file handed to the model in one piece. */
export const MAX_REFERENCE_BYTES = 128 * 1024;

/** Skills one conversation may load; a guard against a model loading everything. */
export const MAX_LOADED_SKILLS = 8;

/** Longest skill description kept for discovery. */
export const MAX_SKILL_DESCRIPTION = 1024;

/** Reference files listed for one skill. */
export const MAX_SKILL_REFERENCES = 50;

// ------------------------------------------------------------------ agents

/** Agents below the main agent. 1: an agent can never delegate again. */
export const MAX_DELEGATION_DEPTH = 1;

/** Child agents one parent may have running at once. */
export const MAX_ACTIVE_CHILDREN = 1;

/** Delegations in one user turn; a guard against a model delegating in a loop. */
export const MAX_DELEGATIONS_PER_TURN = 3;

/** Tool calls one agent run may make before it is stopped with what it has. */
export const AGENT_MAX_TOOL_CALLS = 40;

/** Wall time for one agent run. A budget, not an inactivity timeout. */
export const AGENT_MAX_RUNTIME_MS = 5 * 60_000;

/** Characters of an agent's result returned to its parent. */
export const MAX_DELEGATION_RESULT_CHARS = 8_000;

/** Characters of a delegated task and of the user's objective given to an agent. */
export const MAX_DELEGATED_TASK_CHARS = 4_000;
export const MAX_OBJECTIVE_CHARS = 2_000;
