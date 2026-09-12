import type { Command } from './types.ts';

export class CommandRegistry {
  #commands = new Map<string, Command>();
  #aliases = new Map<string, string>();

  register(...commands: Command[]): this {
    for (const command of commands) {
      this.#commands.set(command.name, command);
      for (const alias of command.aliases ?? []) this.#aliases.set(alias, command.name);
    }
    return this;
  }

  get(name: string): Command | undefined {
    return this.#commands.get(this.#aliases.get(name) ?? name);
  }

  /** Sorted for stable `/help` output. */
  list(): Command[] {
    return [...this.#commands.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
}
