# Polaris

A terminal application for working with coding agents. You run `polaris` once and keep a
conversation going: the agent explores your repository on its own, answers stream in, the
provider and model are always on screen, and Ctrl+C cancels a single turn without killing
the session.

```text
 ✦ POLARIS  my-project                                          codex · gpt-5.6-luna
 ──────────────────────────────────────────────────────────────────────────────────

 You
 Analiza la arquitectura de este proyecto

 ● Glob src/**/*.ts
   31 files
 ● Read package.json
   42 lines
 ● Grep "ModelProvider"
   8 matches in 5 files

 Polaris
 El proyecto separa el núcleo de la interfaz…

╭──────────────────────────────────────────────────────────────────────────────────╮
│ > Ask Polaris…                                                                   │
╰──────────────────────────────────────────────────────────────────────────────────╯
 codex · gpt-5.6-luna    ~/projects/my-project                  read-only · ready
```

Polaris renders full-screen when it owns a terminal, and falls back to a plain
line-by-line renderer when its output is piped — both drive the same core.

## Requirements

Node.js >= 24. Runtime dependencies: the official `@anthropic-ai/sdk` and
`@anthropic-ai/claude-agent-sdk`, `ink` and `react` for the terminal UI, and `ignore` to
honour `.gitignore`. The Codex provider needs no package — it drives the Codex CLI you already
have.

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

During development, `npm run dev` compiles and runs in one step.

## Repository tools

Polaris can look at the project it was started in — and, in this version, **only look**.

| Tool | What it does |
| --- | --- |
| **Read** | Reads a text file, whole or as a line range |
| **Glob** | Lists files matching a pattern such as `src/**/*.ts` |
| **Grep** | Searches file contents (literal text, or a regular expression) |

The agent decides on its own when to use them, so a question like *"analyse the
architecture of this project"* is answered after it has actually read the code. Each call
appears in the transcript as one line with a short outcome (`● Read package.json · 42
lines`); the file contents go to the model, not to your screen.

**Current capability mode: read-only.** Polaris v0.5 cannot create, modify, move or delete
files, and cannot run commands that change anything. Ask it to edit something and it will
tell you it can't. There is no option to turn writing on; that arrives, with an explicit
permission system, in a later version.

The boundary holds for every provider:

- Paths are confined to the directory Polaris was started in. `..` escapes, absolute paths
  elsewhere, and symlinks or Windows junctions that point outside are all refused — the
  check runs on the real, resolved path.
- `.git` and `node_modules` are never searched, and the root `.gitignore` is honoured
  (nested `.gitignore` files are not, yet).
- Binary files are skipped, big files must be read by line range, and long listings or
  searches are truncated — the agent is told when that happens.

`/tools` shows what the current provider can do; `/status` includes the mode.

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

How each one gets repository access differs, because each runtime has its own official
mechanism — what you see, and the read-only guarantee, are the same:

- `anthropic-api` and `mock` use **Polaris's own tools**; Polaris runs the tool loop.
- `claude` uses the runtime's **built-in Read, Glob and Grep and nothing else**. Every other
  built-in and all MCP tools are removed, the runtime never prompts (it denies instead), a
  hook enforces the workspace boundary on every call, and no settings, skills, plugins or
  `CLAUDE.md` are loaded from disk.
- `codex` explores with its own commands inside a **read-only sandbox without network**,
  with web search turned off. Approval requests are **declined**, never granted — Polaris
  has no approval UI, and saying "yes" automatically would be the wrong default.

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
| `/status` | Show cwd, provider, model, tool mode and turn count |
| `/tools` | Show the repository tools available and the capability mode |
| `/provider [id]` | Switch provider — with no id, pick one from a list |
| `/model [id]` | Switch model — with no id, pick from what the provider reports |
| `/config [save]` | Show the configuration, or save the current provider and model |
| `/clear` | Clear the transcript (the provider keeps its conversation) |
| `/exit` | Exit Polaris (`exit`, `quit`, `/q` also work) |

Type `/` to see the commands; Tab completes a unique prefix. Flags:
`--provider <id>`, `--model <id>`, `--debug`, `--version`, `--help`.

### Keyboard

| Key | Does |
| --- | --- |
| `Enter` | Send |
| `Ctrl+C` | Cancel the running turn; with an empty composer, exit |
| `Ctrl+D` | Exit (empty composer) |
| `PageUp` / `PageDown` | Scroll the transcript (`↑n` in the status bar means you scrolled up) |
| `←` `→` `Home` `End` | Move the cursor (`Ctrl+A` / `Ctrl+E` also work) |
| `Tab` | Complete a slash command |
| `↑` `↓` `Enter` `Esc` | Move, choose and cancel inside a picker |

Cancelling never ends the session: the turn stops, whatever arrived stays on screen, and
the next message continues the same conversation.

## Configuration

Read at startup, written only when you ask:

```jsonc
// ~/.polaris/config.json
{ "provider": "claude" }
```

`/config` shows what is in effect; `/config save` writes the session's current provider
and model there, so the next `polaris` starts the same way. A missing or malformed file
is not an error — Polaris falls back to defaults (and says why under `--debug`).
`POLARIS_HOME` overrides the directory.

### Debug output

`polaris --debug` normally logs to stderr, but the full-screen UI owns the terminal, so
there it writes to `~/.polaris/logs/polaris.log` instead (the path is printed at
startup). Credentials are never logged, in either mode.

## Architecture

```text
src/
  main.ts              entry point: flags, config, provider registration, error boundary
  core/
    app.ts             PolarisApp — headless controller: transcript, status, switching
    session.ts         cwd, turn lifecycle over one provider session
    errors.ts          PolarisError = message safe to show the user
    logger.ts          debug logging (stderr, or a file while the TUI owns the terminal)
  cli/
    repl.ts            line renderer for pipes and scripts
    commands/          command registry + built-ins (no if/else chain)
  providers/
    provider.ts        ModelProvider / ModelSession / ModelEvent + registry
    mock/              offline echo provider (streams, like the real one)
    anthropic-api/     Messages API via @anthropic-ai/sdk
    claude/            Claude Agent SDK runtime
    codex/             Codex App Server (JSON-RPC over stdio)
      app-server.ts    the process + protocol seam; tests replace it wholesale
  tools/               Read / Glob / Grep, the workspace boundary and every limit
  config/config.ts     ~/.polaris/config.json
  ui/
    tui/               Ink components: App, Composer, Selector
    layout.ts          wrapping, viewport and status-bar maths (pure, unit-tested)
    theme.ts           the whole palette
    output.ts          plain-text output for the fallback renderer
```

The data flow for one turn:

```text
UI → PolarisApp → Session → ModelSession → provider backend
                                              ↓
terminal ← renderer ← AppState ← PolarisApp ← ModelEvent
```

The UI never touches a provider and a provider never draws anything. `PolarisApp` sits
between them, which is why the same core serves both the full-screen TUI and the
line-based renderer — and will serve a future non-interactive `polaris run`.

The translation to `ModelEvent` happens inside each provider, so the renderer never sees
an Anthropic stream event or an Agent SDK message.

These rules keep this able to grow:

1. **The core never imports a vendor SDK.** It only knows `ModelProvider`,
   `ModelSession` and `ModelEvent`. Adding `providers/openai/` is a new folder plus one
   `registerProvider()` call.
2. **Streaming is the contract, not a special case.** `send()` returns an
   `AsyncIterable<ModelEvent>` for every provider — the mock streams too, so the UI has
   exactly one code path. `ModelEvent` is a discriminated union: `message-start`,
   `text-delta`, `message-end`, and `tool-start` / `tool-result` / `tool-error`, which
   describe tool activity *whoever ran it* — with a human name, a target and a one-line
   outcome, never the content the model read. Turn failures are thrown; a failed tool is
   an event the model recovers from.
3. **Each provider owns its conversation state, in whatever way suits it.**
   `anthropic-api` replays a message list because the Messages API is stateless;
   `claude` keeps one live runtime session; `codex` keeps one thread and adds a turn per
   prompt. `Session` keeps only a plain transcript for the UI.
   Cancellation follows the same rule: `anthropic-api` keeps the partial answer as
   context (Polaris owns that history), while `claude` calls `interrupt()` and `codex`
   calls `turn/interrupt`, letting each runtime decide what its own transcript keeps.
   In all three the session stays open for the next prompt.
4. **The visual transcript is presentation, never truth.** `PolarisApp` keeps the
   messages the user sees; the conversation itself belongs to the provider. `/clear`
   therefore clears pixels, and switching provider starts a genuinely new context — which
   Polaris says out loud instead of pretending otherwise.
5. **Tools share semantics, not machinery.** Polaris executes its own tools for
   `anthropic-api`; the Claude runtime runs its built-ins; Codex runs commands in its
   sandbox. Each provider translates what happened into the same tool events, and the
   workspace boundary is one function reused wherever Polaris itself decides.
6. **A richer protocol is narrowed at the provider, not in the UI.** Codex and Claude
   stream reasoning, plans, diffs, usage and more; Polaris renders text and tool activity
   and ignores the rest by design. Unknown events never break a session.
7. **Commands are data, not control flow**, and **user output is separate from debug
   logging** (`ui/` on stdout, `logger.ts` on stderr).

Writing files, running commands, git operations, a permission system, Markdown rendering
and persistent history are deliberately *not* here yet.

## Scripts

```bash
npm run dev        # build and run
npm run build      # tsc -> dist/
npm run typecheck  # tsc --noEmit
npm test           # node:test — no network, no credentials, no quota
npm run lint       # biome
npm run format     # biome --write
```

Tests never reach a real model and never spend quota. `anthropic-api` runs against a
local server speaking the Messages streaming protocol; `claude` and `codex` run against
fake runtimes injected through `createClaudeProvider()` and `createCodexProvider()`. The
interface is tested where it is worth testing — controller state and layout maths — not
by snapshotting ANSI output.
