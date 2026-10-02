# Contributing to Polaris

Thanks for helping. Polaris is a Developer Preview, so bug reports from real use are the
most valuable contribution right now.

## Reporting bugs

Use the **Bug report** issue template. Include `polaris --version`, your OS and Node
version, the provider, the steps to reproduce, and the output of `polaris doctor`
(or the file from `polaris doctor --report`). Never paste API keys or tokens.

Security problems go through [SECURITY.md](SECURITY.md), not public issues.

## Setup

Requires Node.js 22 or newer.

```bash
git clone https://github.com/EduardoGainzaKoller/polaris-cli.git
cd polaris-cli
npm install          # also builds dist/
npm link             # optional: `polaris` on your PATH, pointing at this checkout
```

## Everyday commands

```bash
npm run build          # clean dist/ and compile with tsc
npm run typecheck      # tsc --noEmit
npm test               # node:test — offline, no credentials, no model calls
npm run lint           # Biome (npm run format fixes most issues)
npm run test:package   # pack, install the tarball in a temp project, smoke-test it
```

`npm test` never talks to a real model: providers are tested against local fakes of their
real protocols, and every test runs with a throwaway `POLARIS_HOME`. Please keep it that
way — a test that needs a network, an account or quota does not belong in `npm test`.
(`npm run check:codex` / `check:claude` exist for deliberate, manual live checks.)

## Architecture in brief

```text
src/
  bin.ts, main.ts     entry point: Node check, --help/--version/doctor, session startup
  core/               PolarisApp (the controller), sessions, activity, verification, logging
  providers/          one folder per runtime behind the ModelProvider interface
  permissions/        task authorisation, risk classification, the permission gate
  tools/              Read/Glob/Grep/Write/Edit/Run and the workspace boundary
  workspace/          read-only Git client, change tracking, checkpoints and undo
  context/            POLARIS.md and skills
  agents/             agent definitions, the agent manager and delegation results
  cli/                commands, the line renderer, doctor and first-run setup
  ui/                 the Ink terminal UI and pure layout helpers
```

A few rules keep this maintainable:

- The core never imports a vendor SDK; providers translate their runtime into
  `ModelEvent`s and nothing else leaks past `providers/provider.ts`.
- Every permission decision goes through `PermissionGate`, whichever runtime asked.
- Safety properties are tests, not comments — add one when you add a guarantee.

The [full guide](docs/guide.md) explains each part in depth.

## Pull requests

Keep them focused, make sure `typecheck`, `test`, `lint` and `build` pass, and describe
what you changed and why. Match the surrounding code's style; Biome enforces formatting.
