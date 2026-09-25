/**
 * Just enough shell to classify a command line safely — deliberately not a
 * shell parser. It splits words and quotes, and it refuses: anything that
 * composes commands, redirects, substitutes or cannot be read unambiguously
 * comes back marked, so the classifier can ask instead of guessing.
 */
export interface ParsedCommand {
  /** The words, quotes removed. */
  readonly argv: readonly string[];
  /** `A=b cmd`: variables set for the command. */
  readonly env: readonly string[];
  /** `&&`, `||`, `;`, `|`, `&`, `<`, `>`, `` ` ``, `$(…)`, newlines. */
  readonly composite: boolean;
}

/** null when the line cannot be split with confidence, e.g. an unclosed quote. */
export function parseCommand(line: string): ParsedCommand | null {
  const words: string[] = [];
  let current = '';
  let started = false;
  let quote: '"' | "'" | null = null;
  let composite = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index] as string;
    const next = line[index + 1];
    if (quote === "'") {
      if (char === "'") quote = null;
      else current += char;
      continue;
    }
    if (quote === '"') {
      if (char === '"') quote = null;
      else {
        // Substitution still happens inside double quotes.
        if (char === '`' || (char === '$' && next === '(')) composite = true;
        current += char;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
      continue;
    }
    if (/[|&;<>`\n\r]/.test(char) || (char === '$' && next === '(')) {
      composite = true;
      // Keep splitting so the first command can still be named in a reason.
      if (started) words.push(current);
      current = '';
      started = false;
      continue;
    }
    if (char === ' ' || char === '\t') {
      if (started) words.push(current);
      current = '';
      started = false;
      continue;
    }
    current += char;
    started = true;
  }
  if (quote) return null;
  if (started) words.push(current);

  const env: string[] = [];
  while (words.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0] as string)) {
    env.push(words.shift() as string);
  }
  return { argv: words, env, composite };
}

/** `C:\\tools\\git.exe` → `git`; `./gradlew` → `gradlew`. */
export function executableName(word: string): string {
  const base = word.replaceAll('\\', '/').split('/').pop() ?? word;
  return base.toLowerCase().replace(/\.(exe|cmd|bat|ps1|sh)$/, '');
}
