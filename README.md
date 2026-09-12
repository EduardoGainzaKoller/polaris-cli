# Polaris

An interactive CLI for working with coding agents. You run `polaris` once and keep a
conversation going, instead of firing one-shot commands. Answers stream token by token
and Ctrl+C cancels a single turn without killing the session.

```text
  ✦ Polaris

  ~/projects/example
  claude · claude-sonnet-5

❯ Hola, me llamo Eduardo

Hola Eduardo, ¿en qué puedo ayudarte?

❯ ¿Cómo me llamo?

Te llamas Eduardo.

❯ /exit

Goodbye.
```

## Requirements

Node.js >= 22.6 (24 recommended). Two runtime dependencies, both official Anthropic
packages: `@anthropic-ai/sdk` and `@anthropic-ai/claude-agent-sdk`.

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

Polaris talks to a model through one small interface, so backends are
interchangeable. Pick one per run:

| Provider | Flag | What it is |
| --- | --- | --- |
| `mock` (default) | `polaris --provider mock` | Offline echo provider. No credentials, no network. |
| `anthropic-api` | `polaris --provider anthropic-api` | The Anthropic **Messages API** through `@anthropic-ai/sdk`. Polaris replays the conversation on every turn. |
| `claude` | `polaris --provider claude` | The **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`), the runtime behind Claude Code, used as a library. The runtime owns the session. |
| `codex` | `polaris --provider codex` | The **Codex App Server**, spoken over JSON-RPC to a `codex app-server` process. Codex owns the thread. |

`mock` is the default on purpose: starting on a real provider would greet anyone
without credentials with an error on their first message. Change the default with
`{"provider": "claude"}` in `~/.polaris/config.json`.

They differ in *what runs the conversation*:

* `anthropic-api` is a direct HTTP conversation with the Messages API. Polaris keeps
  the message list and resends it each turn.
* `claude` starts one long-lived Agent SDK session and feeds every prompt into it.
* `codex` starts one `codex app-server` process, opens a thread, and turns each prompt
  into a turn on that thread.

Both agentic runtimes are deliberately stripped down to a plain chat. `claude` runs with
**all built-in tools disabled** (`tools: []`) and **no settings, skills or `CLAUDE.md`
loaded** (`settingSources: []`); `codex` runs its thread **read-only**
(`sandbox: "read-only"`, `approvalPolicy: "never"`), and any approval request that
reaches Polaris anyway is **declined** — Polaris has no approval UI, and answering "yes"
automatically would be the wrong default. Capabilities come later, on purpose.

### Authentication

Polaris never reads credential files, never copies tokens from another tool and never
sets credential environment variables of its own. Each SDK resolves credentials from
the environment, as documented by Anthropic:

| Provider | Documented authentication |
| --- | --- |
| `anthropic-api` | `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, or an `ant auth login` profile. |
| `claude` | `ANTHROPIC_API_KEY`, or the third-party platform variables the Agent SDK documents (`CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY`, …). |
| `codex` | Whatever the Codex CLI is already signed in with — including **Sign in with ChatGPT**. Polaris asks the runtime *whether* a login exists (`getAuthStatus`), never for the token, and **does not require `OPENAI_API_KEY`**. |

```bash
# PowerShell
$env:ANTHROPIC_API_KEY = "sk-ant-..."

# bash
export ANTHROPIC_API_KEY="sk-ant-..."
```

Get a key at <https://console.anthropic.com/>. Keys, tokens and headers are never
printed, not even under `--debug`.

> **A note on Claude subscriptions.** The Agent SDK documentation states that, unless
> previously approved by Anthropic, third-party developers may not offer claude.ai login
> or its rate limits in their products, including products built on the Agent SDK, and
> directs them to API key authentication instead. Polaris therefore documents and
> targets API key authentication only. See
> <https://code.claude.com/docs/en/agent-sdk/overview>.

### The Claude Code runtime

The Agent SDK npm package bundles a native Claude Code binary, so a separate install is
normally unnecessary. Some installs get no bundled binary — for example
`npm ci --omit=optional`, which skips the optional dependency that carries it. Reinstall
without skipping optional dependencies, or [install Claude Code](https://code.claude.com/docs/en/setup)
and point Polaris at it:

```bash
export POLARIS_CLAUDE_EXECUTABLE="/path/to/claude"
```

Polaris does not install anything for you; when the runtime is missing it says so in one
line.

### The Codex runtime

`--provider codex` drives a `codex app-server` process, so the
[Codex CLI](https://developers.openai.com/codex/cli) must be installed and signed in:

```bash
codex        # sign in with ChatGPT the first time
```

Polaris spawns `codex` from your PATH; set `POLARIS_CODEX_EXECUTABLE` to point somewhere
else. It installs nothing and signs in to nothing — when Codex is missing or logged out,
it says so in one line.

### Model

`anthropic-api` defaults to `claude-opus-5` (one constant, in
`src/providers/anthropic-api/index.ts`). `claude` sets **no** model, so the runtime's own
default applies; Polaris reads back whatever the runtime reports and shows it in
`/status`. `codex` behaves the same way: the thread reports the model Codex resolved.
Override any of them with `polaris --model <id>`, or with `{"model": "..."}` in
`~/.polaris/config.json`.

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
{ "provider": "claude" }
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
    anthropic-api/     Messages API via @anthropic-ai/sdk
    claude/            Claude Agent SDK runtime
    codex/             Codex App Server (JSON-RPC over stdio)
      app-server.ts    the process + protocol seam; tests replace it wholesale
  config/config.ts     ~/.polaris/config.json
  ui/
    output.ts          banner, tables, errors
    stream.ts          renders a model stream as continuous text
```

The data flow for one turn:

```text
REPL → Session → ModelSession → provider backend → ModelEvent → renderer → terminal
```

The translation to `ModelEvent` happens inside each provider, so the renderer never sees
an Anthropic stream event or an Agent SDK message.

These rules keep this able to grow:

1. **The core never imports a vendor SDK.** It only knows `ModelProvider`,
   `ModelSession` and `ModelEvent`. Adding `providers/openai/` is a new folder plus one
   `registerProvider()` call.
2. **Streaming is the contract, not a special case.** `send()` returns an
   `AsyncIterable<ModelEvent>` for every provider — the mock streams too, so the UI has
   exactly one code path. `ModelEvent` is a discriminated union
   (`message-start` / `text-delta` / `message-end`); `thinking-delta`, `tool-start` and
   `usage` can be added later without touching existing consumers. Failures are thrown,
   not emitted.
3. **Each provider owns its conversation state, in whatever way suits it.**
   `anthropic-api` replays a message list because the Messages API is stateless;
   `claude` keeps one live runtime session; `codex` keeps one thread and adds a turn per
   prompt. `Session` keeps only a plain transcript for the UI.
   Cancellation follows the same rule: `anthropic-api` keeps the partial answer as
   context (Polaris owns that history), while `claude` calls `interrupt()` and `codex`
   calls `turn/interrupt`, letting each runtime decide what its own transcript keeps.
   In all three the session stays open for the next prompt.
4. **A richer protocol is narrowed at the provider, not in the UI.** Codex streams
   reasoning, plans, command output, diffs, usage and rate limits; v0.3 renders only
   `item/agentMessage/delta` and ignores the rest by design. Unknown events are logged
   under `--debug` and never break a session.
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

Tests never reach a real model and never spend quota. `anthropic-api` runs against a
local server speaking the Messages streaming protocol; `claude` and `codex` run against
fake runtimes injected through `createClaudeProvider()` and `createCodexProvider()`.
