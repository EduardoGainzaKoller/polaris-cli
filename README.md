# Polaris

**A terminal coding agent that works with Claude, Codex and the Anthropic API — built so
an AI can change your code without you losing control of your repository.**

![Node.js](https://img.shields.io/badge/node-%3E%3D24-339933?logo=node.js&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)
![Tests](https://img.shields.io/badge/tests-362%20passing-2ea44f)
![Platforms](https://img.shields.io/badge/platforms-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)
![License](https://img.shields.io/badge/license-MIT-blue)

```text
 ✦ my-project                                                                  v0.8

  ┃ Add validation to createUser and add the tests it needs.

  ✓ Read src/user/UserService.ts                                        142 lines · 0.1s
  ✓ Grep "createUser"                                                   4 matches · 0.2s
  ✓ Edit src/user/UserService.ts                                             +6 -1 · 0.1s
  ✓ Write src/user/UserServiceTest.ts                               created · 38 lines · 0.1s
  ✓ Run git diff                                                          exit 0 · 0.3s

 ╭─ Permission required ────────────────────────────────── enter allow · d deny ─╮
 │ Run command                                                                   │
 │ ./gradlew test                                                                │
 │ Reason: Executes project code.                                                │
 │ cwd: ~/projects/my-project                                                    │
 ╰───────────────────────────────────────────────────────────────────────────────╯

 ● approval required   main +2 · unverified            enter allow · d deny · ctrl+c cancel
```

Polaris is an interactive CLI in the family of Claude Code and Codex: you describe a task,
and the agent explores the repository, edits files, runs commands and iterates until the
work is done. What sets it apart is the layer *around* the model — one provider-agnostic
core that decides what an agent may do, tracks exactly what it changed, verifies the result
and can put everything back.

## Highlights

- **One agent, several engines.** Drive the Claude Agent SDK, the Codex App Server or the
  Anthropic Messages API from the same interface. Switch provider or model mid-session;
  the UI, the permissions and the safety guarantees stay the same.
- **Smart permissions.** You authorise a *task*, not individual tool calls. Reads,
  searches and the edits your request implies happen without interruptions; Polaris
  stops only when an operation crosses a real boundary — running project code, installing
  packages, touching the network, destructive Git. Anything outside the workspace is
  denied outright, and no approval can override that.
- **Your work is never collateral damage.** Polaris records the repository as it found it
  and tells *its* changes apart from yours — including edits made natively by Codex or
  Claude. `/diff` shows only the session's changes, `/checkpoint` and `/undo` restore
  them without touching your uncommitted work, and nothing is ever stashed, committed or
  reset behind your back.
- **Honest verification.** Every test or build the agent runs is recorded against the
  exact state of the workspace it checked. Edit after a passing test and the result goes
  back to *unverified*; after each turn Polaris reports what actually passed or failed,
  whatever the model claims.
- **Project knowledge on demand.** A `POLARIS.md` file carries a project's conventions,
  and reusable *skills* (`.polaris/skills/<name>/SKILL.md`) teach procedures. Only a
  skill's name and description reach the model until it decides to load one — progressive
  disclosure keeps the context lean — and the same skill works unchanged on every
  provider.
- **Never looks frozen.** A live activity view shows what is running, for how long, what it
  is waiting for, the last lines of command output and how long since anything happened —
  built only from real events, never invented "thinking…" messages.

## Smart permissions

Polaris automatically performs the routine actions an authorised task needs, and asks
only when an operation crosses a risk boundary.

| | read-only | **smart** (default) | workspace-write |
| --- | --- | --- | --- |
| Read, search, safe Git inspection | ✓ | ✓ | ✓ |
| Edits and new files in the workspace | — | ✓ when your request asks for changes, otherwise asks | ✓ |
| Tests, builds, installs, network, Git writes, unknown commands | — | asks | asks |
| Destructive Git (`reset --hard`, `clean -f`…) | — | asks, flagged high risk | asks, flagged high risk |
| Anything outside the workspace | denied | denied | denied |

- *"Analyse UserService"* reads, searches and diffs with no approvals — and has no
  implicit permission to edit.
- *"Implement createUser and add tests"* reads, edits and creates files with no approvals,
  and stops once, when it wants to run the test suite.
- Commands are classified by explicit rules, never by substring: `git status && rm -rf x`
  is a compound line, not inspection, and always asks.
- The workspace boundary is enforced in code; no approval can override it.

The details are in the [guide](docs/guide.md#permissions).

## Quick start

Requires **Node.js 24+**.

```bash
git clone https://github.com/EduardoGainzaKoller/polaris-cli.git
cd polaris-cli
npm install
npm run build
npm link          # puts `polaris` on your PATH
```

Then, from any project:

```bash
cd ~/projects/my-app
polaris                      # offline mock provider, to explore the UI
polaris --provider codex     # uses your Codex CLI sign-in
polaris --provider claude    # uses your Claude Code sign-in
polaris --provider anthropic-api   # uses ANTHROPIC_API_KEY
```

Polaris never asks for, stores or prints credentials: each runtime authenticates the way it
already does.

## How it works

```text
                ┌─────────────── Polaris core ────────────────┐
                │                                             │
  you ──► TUI ──►  PolarisApp ── Permission gate ── Tools     │
                │      │          (task · risk · profile)     │
                │      ├── Change tracker · checkpoints · undo │
                │      ├── Verifier                            │
                │      ├── Project context · skills            │
                │      └── Activity tracker                    │
                │      │                                       │
                └──────┼───────────────────────────────────────┘
                       ▼
          ModelProvider (one small interface)
        ┌──────────────┬────────────────┬────────────────┐
     Claude Agent SDK  Codex App Server  Anthropic API     Mock (offline)
```

A few design decisions that shape everything else:

- **The core never imports a vendor SDK.** Each provider translates its runtime into one
  stream of events (`text-delta`, `tool-start`, `tool-result`…), so the UI has exactly one
  code path and a new backend is a new folder.
- **Each runtime's official mechanism, never a second agent loop.** Claude's permission
  callback, Codex's JSON-RPC approval requests and Polaris's own tool loop all feed the
  *same* permission gate. Codex keeps its OS sandbox; Polaris answers its approval requests
  according to its own policy.
- **Observe, don't trust.** Change tracking reconciles the file system and Git after every
  tool, so edits made by any runtime — or by a build script — are attributed correctly.
- **Security is enforced in code.** `POLARIS.md`, skills and the model's own words can
  shape behaviour, but they cannot change permissions, the workspace boundary or a sandbox.

## Commands

| | |
| --- | --- |
| `/status` | Session, Git, verification and token usage per model, like Claude's `/usage` |
| `/diff` | What Polaris changed this session — your pre-existing changes listed apart |
| `/checkpoint` · `/undo` | Snapshot Polaris's changes and restore them safely |
| `/verify` | Have the agent run the project's own checks against the current changes |
| `/permissions` | `read-only`, `smart` (default) or `workspace-write` |
| `/skills` · `/skill <name>` | Discover and load project or user skills |
| `/context` | The `POLARIS.md` instructions in use |
| `/activity` | What is running right now, and since when |
| `/provider` · `/model` · `/effort` | Switch runtime, model or reasoning effort live |
| `/new` · `/clear` | New conversation · clear the screen |

Every command, flag and behaviour is described in the **[full guide](docs/guide.md)**.

## Engineering

- **TypeScript in strict mode** end to end, running on Node 24 — no bundler, no framework
  beyond Ink and React for the terminal UI.
- **362 tests, fully offline.** Providers are tested against faithful fakes of their real
  protocols (a local HTTP server speaking the Messages streaming API, a fake Codex App
  Server, a fake Agent SDK runtime), so `npm test` never needs a network, a credential or a
  token of quota.
- **Built for Windows, macOS and Linux** — process-tree cancellation, junction-aware path
  checks and Windows PowerShell wrappers are handled explicitly, not assumed away.
- **Safety properties are tests, not comments:** a workspace escape through a symlink,
  `git status && rm -rf …` posing as inspection, an undo that would overwrite work you did
  in your editor — each has a test that fails if the guarantee ever breaks.

```bash
npm run typecheck   # tsc --noEmit
npm test            # node:test, no network
npm run lint        # Biome
npm run build
```

## Roadmap

- **Agents & delegation** — a main agent that delegates to focused agents (repository
  explorer, planner, implementer, reviewer), each with its own provider, model, skills,
  tools and permissions.
- **Intent-aware command approval** — letting an explicit request such as "run the tests"
  authorise exactly those commands for the task.
- **Context management** — budgeting and compaction built on the context-size accounting
  already in place.

## License

[MIT](LICENSE)
