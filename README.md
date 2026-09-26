# Polaris

**An AI coding agent for your terminal — works with Codex, Claude and the Anthropic API.**

![Status](https://img.shields.io/badge/status-Developer%20Preview-orange)
![Node.js](https://img.shields.io/badge/node-%3E%3D22-339933?logo=node.js&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)
![Tests](https://img.shields.io/badge/tests-384%20passing-2ea44f)
![License](https://img.shields.io/badge/license-MIT-blue)

```text
 ✦ my-project                                              v0.8.3 · Developer Preview

  ┃ Add validation to createUser and add the tests it needs.

  ✓ Read src/user/UserService.ts                                   142 lines · 0.1s
  ✓ Grep "createUser"                                              4 matches · 0.2s
  ✓ Edit src/user/UserService.ts                                        +6 -1 · 0.1s
  ✓ Write src/user/UserServiceTest.ts                        created · 38 lines · 0.1s

 ╭─ Permission required ─────────────────────────────────── enter allow · d deny ─╮
 │ Run command                                                                    │
 │ ./gradlew test                                                                 │
 │ Reason: Executes project code.                                                 │
 ╰────────────────────────────────────────────────────────────────────────────────╯
```

> **Developer Preview.** Polaris is early software. It can modify files and run commands
> in your workspace. Use it inside a Git repository while testing, and review what it
> changes. Feedback is very welcome — see [Reporting problems](#reporting-problems).

## What is Polaris?

Polaris is an interactive command-line coding agent, in the family of Claude Code and
Codex. You describe a task in plain language; the agent reads your repository, edits
files, runs the commands it needs (with your approval when it matters) and iterates until
the work is done.

It runs on top of the AI tools you may already use — the Codex CLI, Claude Code, or an
Anthropic API key — and adds a common layer around them:

- **Smart permissions** — routine reads and the edits your request implies happen without
  interruptions; Polaris asks only before running project code, installing packages,
  using the network or destructive Git commands. Nothing outside your project folder is
  ever touched.
- **Safe undo** — Polaris tracks exactly what *it* changed, separately from your own
  uncommitted work. `/diff` shows its changes, `/undo` puts them back.
- **Honest verification** — every test or build it runs is recorded; if the code changes
  after a passing test, the result goes back to *unverified*.
- **Project knowledge** — a `POLARIS.md` file and reusable *skills* teach it your
  project's conventions.
- **Live feedback** — you always see what is running, for how long, and its latest output.

## Requirements

- **Node.js 22 or newer** (`node --version`).
- **Git** — recommended; Polaris works outside a repository, but `/diff` and change
  tracking work best inside one.
- **At least one provider** (see [Providers](#providers)). The built-in `mock` provider
  needs nothing and is handy for a first look.

Tested on **Windows 11**. **Linux and macOS are experimental**: the test suite runs on them
in CI, but they have not had hands-on use yet — reports are especially welcome.

## Installation

Polaris is not published to npm yet. Install it from source:

```bash
git clone https://github.com/EduardoGainzaKoller/polaris-cli.git
cd polaris-cli
npm install
npm run build
npm link        # makes the `polaris` command available everywhere
```

To update later: `git pull && npm install && npm run build`.
To uninstall: `npm unlink -g polaris`.

Once it is published, installation will be a single command
(`npm install -g <package-name>`); the package name is not decided yet.

## First run

```bash
cd ~/projects/my-app     # any project, ideally a Git repository
polaris
```

The first time, Polaris shows a short notice, checks which providers are available on
your machine, and asks you to pick one. That choice is saved to `~/.polaris/config.json`;
you can change it any time with `/provider`. It never asks for an API key and never stores
one.

Not sure everything is set up? Run:

```bash
polaris doctor
```

## Providers

| Provider | Uses | You need |
| --- | --- | --- |
| `codex` | the Codex CLI and your ChatGPT sign-in | the [Codex CLI](https://developers.openai.com/codex/cli) installed; run `codex` once to sign in |
| `claude` | the Claude Agent SDK (installed with Polaris) | a Claude Code sign-in (run `claude` once), or `ANTHROPIC_API_KEY` |
| `anthropic-api` | the Anthropic Messages API directly | `ANTHROPIC_API_KEY` set in your environment |
| `mock` | nothing — an offline demo that echoes you | nothing |

Choose one for a single run with `polaris --provider claude`, or switch inside Polaris with
`/provider`. `polaris doctor` shows which ones are ready.

## Basic usage

Type what you want, the way you would ask a colleague:

```text
❯ Explain how this repository is organised.
❯ Fix the validation bug in UserService.
❯ Add tests for this behaviour and run them.
```

Polaris shows each step as it happens (`● Read …`, `● Edit …`). When it needs your
approval, a card explains why: **Enter** allows once, **d** denies. **Ctrl+C** cancels the
current task without closing Polaris. After a task that changed files, it prints what was
verified.

```text
❯ /diff        what Polaris changed
❯ /undo        put it back (your own changes are never touched)
```

## Permissions

Polaris starts in the **smart** profile:

| | read-only | **smart** (default) | workspace-write |
| --- | --- | --- | --- |
| Read, search, `git status` / `git diff` | ✓ | ✓ | ✓ |
| Edit and create files in your project | — | ✓ when you asked for changes | ✓ |
| Tests, builds, installs, network, Git commits | — | asks | asks |
| Anything outside your project folder | denied | denied | denied |

"Analyse this service" reads freely but will ask before editing anything; "implement X"
edits without interruptions and stops when it wants to run your test suite. Change
profile with `/permissions`, or for one run with `polaris --permissions read-only`.

## Project context and skills

- **`POLARIS.md`** in your project holds standing instructions — "we use hexagonal
  architecture", "never edit existing migrations". Polaris reads it at startup.
- **Skills** are reusable procedures in `.polaris/skills/<name>/SKILL.md` (per project) or
  `~/.polaris/skills/<name>/SKILL.md` (for you). The agent sees only their names and
  descriptions and loads one when it is relevant; `/skill <name>` loads one yourself.

The [full guide](docs/guide.md#project-context-and-skills) has the file format.

## Commands

| Command | What it does |
| --- | --- |
| `/help` | All commands |
| `/status` | Version, provider, model, Git and verification state, token usage |
| `/provider` · `/model` · `/effort` | Switch provider, model or reasoning effort |
| `/permissions` | Show or change the permission profile |
| `/tools` | What Polaris may do, and when it asks |
| `/context` | The `POLARIS.md` instructions in use |
| `/skills` · `/skill <name>` | List or load skills |
| `/diff` | What Polaris changed this session |
| `/checkpoint` · `/checkpoints` · `/undo` | Save and restore Polaris's changes |
| `/verify` | Run the project's checks against the current changes |
| `/activity` | What is running right now |
| `/new` | Start a new conversation (files are kept) |
| `/clear` | Clear the screen |
| `/config` | Show or save the configuration |
| `/exit` | Quit (also Ctrl+C when idle) |

Command-line options: `polaris --help`.

## Troubleshooting

**Start with `polaris doctor`.** It checks Node, Git, each provider, your configuration
and the current folder, and says what to do about anything missing. It changes nothing
and never contacts a model.

| Problem | What to do |
| --- | --- |
| `Codex CLI not found` | Install the Codex CLI, or set `POLARIS_CODEX_EXECUTABLE` to its path |
| `Codex is not authenticated` | Run `codex` and sign in again |
| `Claude sign-in has expired` | Run `claude` and sign in again, or set `ANTHROPIC_API_KEY` |
| `Invalid Polaris configuration` | Fix or delete the file it names; Polaris never overwrites it |
| `Polaris requires Node.js >= 22` | Install a current Node.js LTS release |
| The provider fails to start | Try another one: `polaris --provider mock` |
| Something looks wrong | Run with `polaris --debug` and check the log file it names |

Logs live in `~/.polaris/logs/` (the latest 10 sessions). They never contain API keys or
tokens.

## Reporting problems

Open an issue at
[github.com/EduardoGainzaKoller/polaris-cli/issues](https://github.com/EduardoGainzaKoller/polaris-cli/issues)
and include:

- Polaris version (`polaris --version`), operating system and Node version
- the provider you were using
- the steps to reproduce, what you expected and what happened
- the output of `polaris doctor` — or attach the file from `polaris doctor --report`,
  which removes your home directory path and any credentials

**Never include API keys or authentication tokens.** Polaris sends no telemetry: nothing
leaves your machine unless you share it yourself.

## Contributing

Setup, tests and architecture are in [CONTRIBUTING.md](CONTRIBUTING.md); security issues
in [SECURITY.md](SECURITY.md). The [full guide](docs/guide.md) documents every behaviour in
depth.

## License

[MIT](LICENSE)
