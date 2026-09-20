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
