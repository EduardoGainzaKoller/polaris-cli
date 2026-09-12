# Polaris

An interactive CLI for working with coding agents. You run `polaris` once and keep a
conversation going, instead of firing one-shot commands.

```text
  ✦ Polaris

  ~/projects/example
  mock/echo

❯ hola

Polaris:
You said: hola

❯ /status

  cwd       ~/projects/example
  provider  mock
  model     echo
  turns     2
  session   active

❯ /exit

Goodbye.
```

## Requirements

Node.js >= 22.6 (24 recommended). Polaris has **zero runtime dependencies**.

## Install (local development)

```bash
npm install
npm run build
npm link
```

`npm link` creates a global symlink to this folder, so the `polaris` command on your
PATH points at your working copy. Rebuild (`npm run build`) and the global command picks
the change up immediately. Remove it later with `npm unlink -g polaris`.

Then, from any project:

```bash
cd ~/projects/example
polaris
```

While developing you can skip the build — Node runs the TypeScript sources directly:

```bash
npm run dev
```

## Commands

| Command | Description |
| --- | --- |
| `/help` | Show available commands |
| `/status` | Show cwd, provider, model and turn count |
| `/clear` | Clear the terminal (session state is kept) |
| `/exit` | Exit Polaris (`exit`, `quit`, `/q` also work) |

Flags: `--provider <id>`, `--model <id>`, `--debug`, `--version`, `--help`.

### Ctrl+C

* While the model is answering, Ctrl+C cancels **that turn only**.
* While typing, Ctrl+C discards the current line and arms an exit.
* Ctrl+C again on an empty line — or Ctrl+D — exits cleanly.

## Configuration

Optional, and only read at startup:

```jsonc
// ~/.polaris/config.json
{ "provider": "mock", "model": "echo" }
```

A missing or malformed file is not an error; Polaris falls back to defaults (and explains
why under `--debug`). `POLARIS_HOME` overrides the directory.

## Architecture

```text
src/
  main.ts              entry point: flags, config, error boundary
  cli/
    repl.ts            input loop, prompt, Ctrl+C policy
    commands/          command registry + built-ins (no if/else chain)
  core/
    session.ts         cwd, transcript, model session lifecycle
    errors.ts          PolarisError = message safe to show the user
    logger.ts          debug logging, always to stderr
  providers/
    provider.ts        ModelProvider / ModelSession contracts + registry
    mock/              offline echo provider
  config/config.ts     ~/.polaris/config.json
  ui/                  everything the user sees (output + colors)
```

Three rules keep this able to grow:

1. **The core never imports a vendor SDK.** It only knows `ModelProvider` /
   `ModelSession`. Adding `providers/openai/` or `providers/anthropic/` is a new folder
   plus one `registerProvider()` call — future auth uses official APIs/SDKs only, never
   another tool's internal credentials.
2. **Commands are data, not control flow.** A command is `{ name, summary, run }`
   registered in a map, so `/model`, `/plan`, `/review` are additive.
3. **User output and debug logging are separate channels** (`ui/` on stdout,
   `logger.ts` on stderr), so technical logs never pollute the conversation.

Agent tooling (filesystem, shell, git), streaming, permissions and context management are
deliberately *not* here yet; `Session` is the seam where they will attach.

## Scripts

```bash
npm run dev        # run from source, no build
npm run build      # tsc -> dist/
npm run typecheck  # tsc --noEmit
npm test           # node:test
npm run lint       # biome
npm run format     # biome --write
```
