# Polaris

A terminal application for working with coding agents. You run `polaris` once and keep a
conversation going: the agent explores your repository on its own, proposes changes and
runs commands, answers stream in, the provider and model are always on screen, and Ctrl+C
cancels a single turn without killing the session.

Every operation that changes something is shown to you before it happens — the file, the
diff, the exact command — and waits for you to allow or deny it.

```text
 ✦ my-project                                                              v0.8.0

  ┃
  ┃ Añade validación a createUser y ejecuta los tests
  ┃

  ✓ Read src/user/UserService.ts                                             142 lines
  ✓ Grep "createUser"                                              4 matches in 2 files
  ✓ Edit src/user/UserService.ts                                                 +6 -1

 ╭─ Permission required ───────────────────────────────────── enter allow · d deny ─╮
 │ Run command                                                                      │
 │ npm test                                                                         │
 │ cwd: ~/projects/my-project                                                       │
 │ timeout: 120s                                                                    │
 │                                                                                  │
 │ enter  Allow once                                                        d  Deny │
 ╰──────────────────────────────────────────────────────────────────────────────────╯

 ╭──────────────────────────────────────────────────────────────────────────────────╮
 │ > Ask anything, or type / for commands                                           │
 │  ASK   codex · gpt-5.6-luna · high                                    enter send │
 ╰──────────────────────────────────────────────────────────────────────────────────╯
 ● approval required   ~/projects/my-project     enter allow · d deny · ctrl+c cancel
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

## Tools

Polaris works on the project it was started in, and never outside it.

| Tool | What it does | Capability |
| --- | --- | --- |
| **Read** | Reads a text file, whole or as a line range | read |
| **Glob** | Lists files matching a pattern such as `src/**/*.ts` | read |
| **Grep** | Searches file contents (literal text, or a regular expression) | read |
| **Write** | Creates a file, or replaces one completely | write |
| **Edit** | Replaces an exact stretch of text in a file | edit |
| **Run Command** | Runs a command and returns its output and exit code | command |

The agent decides on its own when to use them, so *"add validation to `createUser` and run
the tests"* becomes a real sequence: read the file, propose an edit, run the suite, read
the failure, try again. Each call is one line in the transcript with a short outcome
(`✓ Edit src/user.ts  +6 -1`); file contents and command output go to the model, not to
your screen.

**Edit** replaces text that must match **exactly once**. Two matches is an error, not a
guess — a substitution meant for one line must never quietly rewrite twenty-seven. Pass
`all` to replace every occurrence deliberately.

**Run Command** is deliberately not called `bash`: Polaris runs on Windows, Linux and
macOS, and the command goes to the platform's own shell. A non-zero exit code is a normal
result the agent reads and acts on, not a crash.

## Permissions

A capability is what a tool *can* do. A permission is what Polaris may do *right now*.
They are separate, so "Polaris can edit files" never means "Polaris edits files without
asking".

| Profile | Read / Glob / Grep | Write / Edit | Run Command |
| --- | --- | --- | --- |
| `read-only` | automatic | **denied** | **denied** |
| `ask` (default) | automatic | **asks every time** | **asks every time** |
| `workspace-write` | automatic | automatic, inside the workspace | **asks every time** |

```text
/permissions                    show the profiles and which one is active
/permissions workspace-write    switch
/config save                    remember it in ~/.polaris/config.json
polaris --permissions read-only just for this run, never saved
```

A few things worth being precise about:

- **Commands always ask, in every profile.** A file write is bounded by the workspace; a
  command is not — it can reach the network, your home directory or your package manager.
  Automatic command execution is not something v0.6 offers.
- **`workspace-write` is not full filesystem access.** It means "edit files inside the
  directory Polaris was started in, without asking each time". Everything outside stays
  refused. There is no full-access profile, and no flag to skip permissions.
- **Under `read-only`, a mutation is impossible rather than discouraged.** The tools are
  not offered to the model at all, so there is nothing for it to call.
- **A denial is not an error.** The agent is told a person said no, and can suggest
  something else or explain what it wanted to do. The session carries on.

### What you see before you decide

A file change shows the unified diff of the change itself (a new file is shown as all
additions, with the line count; a long one is truncated on screen and says so). A command
shows the command in full — never shortened — the working directory and the timeout.

`Enter` or `y` allows once; `d`, `n` or `Esc` denies; `Ctrl+C` denies *and* cancels the
turn. There is no default acceptance: nothing is approved by a stray keystroke, and no
"always allow" rules are stored anywhere.

### The boundary, and what is not a sandbox

Paths are confined to the directory Polaris was started in. `..` escapes, absolute paths
elsewhere, and symlinks or Windows junctions that point outside are all refused — the
check runs on the real, resolved path, for reads, writes, edits and a command's working
directory alike. Writes go through a temporary file and a rename, so a crash never leaves
a half-written source file. If a file changes between the moment you are shown a diff and
the moment the change is applied, the operation is abandoned rather than applied blindly.

`.git` and `node_modules` are never searched, the root `.gitignore` is honoured, binary
files are skipped, and long reads, listings, searches and command output are truncated
with the agent told it happened.

**Polaris's own command execution is not sandboxed.** With `anthropic-api` or `mock`, a
command you approve has the same reach as one you typed into your own shell. What bounds
it is your approval, a working directory pinned inside the workspace, a timeout, and
killing the whole process tree when you cancel — not isolation. The Codex runtime is
different: it runs commands inside its own OS sandbox as well as asking. `/tools` says
which of the two you are in.

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

How each one gets repository access and asks for permission differs, because each runtime
has its own official mechanism — what you see is the same card either way:

- `anthropic-api` and `mock` use **Polaris's own tools**; Polaris runs the tool loop and
  authorises each call before executing it.
- `claude` uses the runtime's **built-in Read, Glob, Grep, Write, Edit and Bash**, chosen by
  the profile. Permission goes through the SDK's official `canUseTool` callback, which
  Polaris answers from the same gate; a `PreToolUse` hook enforces the workspace boundary
  on every call. Every other built-in and all MCP tools are removed, and no settings,
  skills, plugins or `CLAUDE.md` are loaded from disk.
- `codex` keeps its own agent loop inside its own **OS sandbox** — `read-only` or
  `workspace-write`, never `danger-full-access` — with web search turned off. Its
  server-initiated approval requests (`item/commandExecution/requestApproval`,
  `item/fileChange/requestApproval`) become Polaris approvals, and your answer goes back
  over the same protocol. If an administrator has restricted the sandbox or approval
  policy for that install, Polaris reports it rather than working around it.

One difference worth stating plainly: **under `read-only`, Codex still runs commands**.
That is simply how it reads a repository — its `Read`, `List` and `Grep` are shell
commands — and they run inside a read-only sandbox with no network, so they cannot change
anything. They are therefore not asked about. Under `ask` and `workspace-write` every
command it wants to run is shown to you first, unwrapped: on Windows Codex launches
everything through `powershell.exe`, and the card shows the command Codex actually parsed,
not the wrapper.

Polaris does not re-implement either runtime's permission system. The profile is
translated once into that runtime's own configuration, and the runtime's own callback is
the only gate — Polaris renders the question, it does not ask a second one.

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

## Usage

`/status` answers "how much have I used?" alongside the session facts. Every runtime
meters something different, so Polaris reports what each one actually measures and stays
quiet about the rest — a number it did not receive is never invented, and never shown as a
zero.

```text
  provider  codex
  model     gpt-5.6-luna
  plan      plus
  turns     4

  Limits
    5h window  ████░░░░░░░░░░░░░░░░ 21%  resets in 4h 22m
    weekly     █░░░░░░░░░░░░░░░░░░░  6%  resets in 6d 23h

  Tokens by model
    gpt-5.6-luna  48k total · 39k in · 1.2k out · 31k cached
                  context ███░░░░░░░░░░░░░░░░░ 41k / 258k
```

| Provider | What it can report |
| --- | --- |
| `codex` | Your ChatGPT plan, its rolling limit windows as percentages with reset times, this thread's tokens and the model's context window |
| `claude` | Tokens and an estimated cost per model, and the context window, all reported by the runtime |
| `anthropic-api` | Tokens per model, counted by Polaris for this session, and the per-minute ceilings the API returns in its response headers. The API prices nothing, so no cost is shown |
| `mock` | An offline estimate, labelled as such |

Two details that matter if you compare the numbers with a bill:

- **Costs are the runtime's estimate, not an invoice.** Only `claude` reports one at all.
- **"Tokens" and "context" are different questions.** The token total counts every turn,
  including the conversation re-sent each time; the context bar is what the conversation
  is holding right now. The second is the one that tells you how close you are to
  filling the window.

## Changes, checkpoints and verification

**Polaris preserves pre-existing user changes.** When a session starts it records the
workspace as it found it: in a Git repository, the HEAD commit plus a private copy of
every file you had already modified or left untracked. From then on the rule is time, not
tools — what changes while a turn is running is Polaris's, whichever runtime or command
did it (a Codex patch, a Claude `Edit`, a test run writing a snapshot); what changes while
Polaris is idle is yours. So:

- `/diff` shows **Changes this session** with their diffs, and lists your **Pre-existing
  changes** separately, unexpanded. A file you had modified that Polaris then edited is
  diffed against *your* version, not HEAD.
- `/undo` restores only what Polaris changed, and puts a file you had modified back to
  your version. It never runs `git reset`, `checkout`, `restore`, `clean` or `stash`.
- A file you edit after Polaris last wrote it (in your IDE, say) is never overwritten:
  undo skips it and says why. So is a file that changes while the confirmation is open.

**Checkpoints are not Git commits.** `/checkpoint` copies only the files Polaris has
changed into a temporary directory that belongs to the session, and `/undo` returns to
the latest one (then the one before, down to the session start); `/undo cp-2` goes to a
specific one. No commit, branch or stash is ever created, and the copies are deleted when
Polaris exits. They are capped — 5 MB per file, 256 MB per session — and a checkpoint
that could not restore a file refuses to be created rather than pretend. Undo asks for
confirmation (`y`; Enter does nothing), writes atomically and respects the same workspace
boundary as the tools, junctions and symlinks included.

`/new` starts a new conversation on the same provider, model and profile, and touches no
file. It also takes a new baseline: what the previous conversation changed now counts as
your pre-existing work, so `/undo` in the new one cannot reach it. `/clear` only clears
the screen, and `/undo` is the only one of the three that touches files.

**Verification** is bookkeeping over the coding loop, not a separate agent. Every check
the model runs (`npm test`, `./gradlew test`, `pytest`, `cargo test`, …) is recorded with
the state of the workspace it saw, and any later change makes it stale. After a turn that
changed files or ran checks, Polaris prints what it actually observed:

```text
  Verification
  Changes
    M src/UserService.ts
  Checks
    ✓ ./gradlew test
  Workspace
    ✓ no unexpected changes
  Result    passed
```

A file nobody announced — written by a build or a test — is flagged as an unexpected
change, not treated as an error. The status bar shows the branch, how many files Polaris
changed and the verdict (`main +2 · unverified`, `verified`, `checks failed`). `/verify`
asks the model to work out the project's own checks and run them; they go through the
same permission gate as any other command. The model is also told to re-run checks after
editing and to say "Implementation changed, but verification failed." when that is the
truth — and the verification block shows the real result whatever the answer says.

Outside Git, Polaris still works: `/status` says `git: not a repository`, and only files
changed through a file tool (Polaris's own, Claude's `Write`/`Edit`, Codex patches) are
tracked, captured just before each change.

## Project context and skills

Polaris can learn how a project wants work done, and pick up reusable procedures only
when a task needs them.

**`POLARIS.md`** holds the project's standing instructions — architecture rules, the
stack, how to test, what never to do. Polaris reads it from the workspace and from every
directory above it up to the root of the Git repository (never beyond: not the drive root,
not your home). In a monorepo, launching in `repo/backend` gives the model
`repo/POLARIS.md` and then `repo/backend/POLARIS.md`; the nearer file takes precedence. A
file over 64 KB is refused rather than truncated. Outside Git only the workspace's own file
is read.

**Skills** are folders with a `SKILL.md` — Markdown with a small frontmatter — and optional
reference files:

```text
.polaris/skills/spring-boot-testing/     project skill (can be versioned with the repo)
├── SKILL.md
└── references/
    └── testing-patterns.md
~/.polaris/skills/code-review/SKILL.md   user skill, available in every project
```

```markdown
---
name: spring-boot-testing
description: Implement and verify Spring Boot tests.
---

When adding tests, inspect the existing conventions first and run targeted tests…
Consult references/testing-patterns.md when choosing between slice and integration tests.
```

`name` must be lowercase-kebab-case and match its folder; `description` is what the model
chooses by, so make it specific. A project skill replaces a user skill of the same name. A
broken skill is listed as invalid and never stops Polaris from starting.

**Progressive disclosure.** At startup the model sees only each skill's name and
description. When one is relevant it loads it (`● Skill spring-boot-testing  loaded`) and
gets the instructions plus the *names* of its references; it reads a reference only when it
needs one. You can load one yourself with `/skill <name>`. A skill is knowledge, not a
tool: it registers nothing, runs nothing — `scripts/` are not supported — and cannot
change permissions, the workspace boundary or a sandbox; Polaris enforces those in code
whatever a skill or `POLARIS.md` says. Text in source files, READMEs or command output is
treated as data, never as instructions.

The same skill works unchanged with every provider; only the delivery differs:

| Provider | Project context | Model loads a skill through |
| --- | --- | --- |
| `anthropic-api` | system prompt, re-rendered every request | Polaris's own `load_skill` tool |
| `claude` | the Agent SDK `systemPrompt` | an in-process MCP server Polaris starts (`strictMcpConfig`: no other MCP) |
| `codex` | the thread's `developerInstructions` | App Server `dynamicTools` (an experimental field; if refused, skills are loaded with `/skill` only) |

Polaris never reads `CLAUDE.md`, `AGENTS.md`, Claude settings or skills, or Codex's own
instructions: its context is `POLARIS.md` and its own skills.

Loaded skills last for the conversation. `/new` clears them and keeps `POLARIS.md`.
`anthropic-api` is given its instructions afresh on every request, so `/context reload`
and `/skill unload` apply to the next message; the Claude and Codex runtimes fix them when
the session starts, so there both start a new conversation — and Polaris says so.

## Commands

| Command | Description |
| --- | --- |
| `/help` | Show available commands |
| `/status` | The session, plus how much of the model you have used: plan, limits, tokens |
| `/tools` | Show every tool and whether it is automatic, asks, or is denied |
| `/provider [id]` | Switch provider — with no id, pick one from a list |
| `/model [id]` | Switch model — with no id, pick from what the provider reports |
| `/effort [level]` | Reasoning effort (`low` … `max`, as the model allows) — changes live, the conversation is kept |
| `/permissions [profile]` | Show the profiles, or switch to `read-only`, `ask` or `workspace-write` |
| `/config [save]` | Show the configuration, or save provider, model, effort and permissions |
| `/diff [file]` | What Polaris changed this session, with diffs; your pre-existing changes listed apart |
| `/checkpoint [label]` | Save the current state of Polaris's changes |
| `/checkpoints` | List this session's checkpoints |
| `/undo [cp-N]` | Restore Polaris's changes to the latest (or a given) checkpoint, after confirming |
| `/verify` | Have the model run the project's checks against the current changes |
| `/new` | New conversation; same provider, model, permissions and files; loaded skills cleared |
| `/context [show\|reload]` | The POLARIS.md files in use, their content, or re-read them |
| `/skills [reload]` | Skills available, with scope, source and whether loaded; `reload` rediscovers |
| `/skill <name>` | Load a skill into this conversation (`/skill unload <name>` to drop it) |
| `/clear` | Clear the transcript (the provider keeps its conversation) |
| `/exit` | Exit Polaris (`exit`, `quit`, `/q` also work) |

Type `/` to open the command list: ↑↓ to move, Enter to run, Tab to complete and add arguments, Esc to close. Flags:
`--provider <id>`, `--model <id>`, `--debug`, `--version`, `--help`.

### Keyboard and mouse

| Key | Does |
| --- | --- |
| `Enter` | Send |
| `↑` / `↓` | Previous / next prompt or command from your history |
| `PageUp` / `PageDown` | Scroll the conversation a page |
| `Shift`/`Ctrl` + `↑` `↓` | Scroll one line |
| Mouse wheel | Scroll three lines |
| `Esc` | Jump back to the latest output (or close the command list / a dialog) |
| `Ctrl+C` | Cancel the running turn; with an empty prompt, exit |
| `Enter` / `y` | Allow the operation you are being asked about |
| `d` / `n` / `Esc` | Deny it |
| `Ctrl+D` | Exit (empty prompt) |
| `←` `→` `Home` `End`, `Ctrl+A`/`Ctrl+E`, `Ctrl+U` | Edit the prompt |

History covers every prompt and command you send, is kept across sessions in
`~/.polaris/history.json` (last 500 entries), and skips immediate repeats.

The mouse wheel works because Polaris asks the terminal to report the mouse. While it
does, most terminals only select text with **Shift** held.

Cancelling never ends the session: the turn stops, whatever arrived stays on screen, and
the next message continues the same conversation.

## Configuration

Read at startup, written only when you ask:

```jsonc
// ~/.polaris/config.json
{ "provider": "claude" }
```

`/config` shows what is in effect; `/config save` writes the session's current provider,
model and effort there, so the next `polaris` starts the same way. A missing or malformed file
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
    verification.ts    which checks ran against which state of the workspace
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
  tools/               file and command tools, the workspace boundary and every limit
  context/
    project.ts         POLARIS.md, from the workspace up to the Git root
    skills.ts          SkillRegistry: discovery, SKILL.md parsing, references
    manager.ts         ContextManager: loaded skills, events, the one rendering
  workspace/
    git.ts             read-only Git: status (porcelain v2), files at a commit
    changes.ts         ChangeTracker: baseline, session changes, checkpoints, undo
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

Git awareness lives in the core, not in any provider: runtimes report what they did as
tool events, and the change tracker checks the workspace itself, so a native Codex or
Claude edit is found the same way as one of Polaris's own. Git mutations (add, commit,
branch, push, stash), Markdown rendering and persistent history are deliberately *not*
here yet.

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
