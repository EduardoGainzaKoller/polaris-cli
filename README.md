# Polaris

An interactive CLI for working with coding agents. You run `polaris` once and keep a
conversation going, instead of firing one-shot commands. Answers stream token by token
and Ctrl+C cancels a single turn without killing the session.

```text
  ✦ Polaris

  ~/projects/example
  anthropic · claude-opus-5

❯ Hola, me llamo Eduardo

Hola Eduardo, ¿en qué puedo ayudarte?

❯ ¿Cómo me llamo?

Te llamas Eduardo.

❯ /exit

Goodbye.
```

## Requirements

Node.js >= 22.6 (24 recommended). One runtime dependency: the official
`@anthropic-ai/sdk`.

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

## Providers

| Provider | Flag | What it does |
| --- | --- | --- |
| `mock` (default) | `polaris --provider mock` | Offline echo provider. No credentials, no network. |
| `anthropic` | `polaris --provider anthropic` | Real conversation with Claude, streamed. |

`mock` is the default on purpose: starting on `anthropic` would greet anyone without
credentials with an error on their first message. Make Claude your default by putting
`{"provider": "anthropic"}` in `~/.polaris/config.json`.

### Authentication

Polaris does not handle credentials itself — the official SDK resolves them, in this
order: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, then a profile created by the
`ant auth login` CLI. Polaris never reads credential files and never reuses tokens
belonging to another tool.

```bash
# PowerShell
$env:ANTHROPIC_API_KEY = "sk-ant-..."

# bash
export ANTHROPIC_API_KEY="sk-ant-..."
```

Get a key at <https://console.anthropic.com/>. Keys, tokens and headers are never
printed, not even under `--debug`.

### Model

Defaults to `claude-opus-5` (one constant, in `src/providers/anthropic/index.ts`).
Override per run with `polaris --model claude-sonnet-5`, or permanently with
`{"model": "..."}` in `~/.polaris/config.json`. `/status` shows what is in use.

## Commands

| Command | Description |
| --- | --- |
| `/help` | Show available commands |
| `/status` | Show cwd, provider, model and turn count |
| `/clear` | Clear the terminal (session state is kept) |
| `/exit` | Exit Polaris (`exit`, `quit`, `/q` also work) |

Flags: `--provider <id>`, `--model <id>`, `--debug`, `--version`, `--help`.

### Ctrl+C

* While Claude is answering, Ctrl+C cancels **that turn only** — the conversation stays
  open and keeps the partial answer as context.
* While typing, Ctrl+C discards the current line and arms an exit.
* Ctrl+C again on an empty line — or Ctrl+D — exits cleanly.

## Configuration

Optional, and only read at startup:

```jsonc
// ~/.polaris/config.json
{ "provider": "anthropic", "model": "claude-opus-5" }
```

A missing or malformed file is not an error; Polaris falls back to defaults (and explains
why under `--debug`). `POLARIS_HOME` overrides the directory.

## Architecture

```text
src/
  main.ts              entry point: flags, config, provider registration, error boundary
  cli/
    repl.ts            input loop, prompt, Ctrl+C policy
    commands/          command registry + built-ins (no if/else chain)
  core/
    session.ts         cwd, transcript, turn lifecycle
    errors.ts          PolarisError = message safe to show the user
    logger.ts          debug logging, always to stderr
  providers/
    provider.ts        ModelProvider / ModelSession / ModelEvent + registry
    mock/              offline echo provider (streams, like the real one)
    anthropic/         Claude via @anthropic-ai/sdk — the only file that imports it
  config/config.ts     ~/.polaris/config.json
  ui/
    output.ts          banner, tables, errors
    stream.ts          renders a model stream as continuous text
```

The data flow for one turn:

```text
REPL → Session → ModelSession → Claude (SSE) → ModelEvent → renderer → terminal
```

Four rules keep this able to grow:

1. **The core never imports a vendor SDK.** It only knows `ModelProvider`,
   `ModelSession` and `ModelEvent`. Adding `providers/openai/` is a new folder plus one
   `registerProvider()` call.
2. **Streaming is the contract, not a special case.** `send()` returns an
   `AsyncIterable<ModelEvent>` for every provider — the mock streams too, so the UI has
   exactly one code path. `ModelEvent` is a discriminated union
   (`message-start` / `text-delta` / `message-end`); `thinking-delta`, `tool-start` and
   `usage` can be added later without touching existing consumers. Failures are thrown,
   not emitted.
3. **Conversation state lives in the provider.** The Messages API is stateless, so the
   Anthropic session replays its own history; `Session` keeps only a plain transcript.
4. **Commands are data, not control flow**, and **user output is separate from debug
   logging** (`ui/` on stdout, `logger.ts` on stderr).

Agent tooling (filesystem, shell, git), permissions, Markdown rendering and persistent
history are deliberately *not* here yet.

## Scripts

```bash
npm run dev        # run from source, no build
npm run build      # tsc -> dist/
npm run typecheck  # tsc --noEmit
npm test           # node:test — no network, no credentials, no quota
npm run lint       # biome
npm run format     # biome --write
```

Tests never call Claude. The Anthropic provider is covered end to end against a local
server that speaks the Messages streaming protocol.
