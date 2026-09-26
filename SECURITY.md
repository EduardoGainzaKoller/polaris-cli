# Security

## What Polaris can do on your machine

Polaris is an AI coding agent. Depending on the permission profile it can **read and
modify files in the project folder it was started in** and **run commands** there.

- Commands that run project code, install packages, use the network or rewrite Git
  history always ask for your approval first, and anything outside the project folder is
  refused whatever the approval.
- With the `anthropic-api` and `mock` providers, an approved command runs with the same
  access as your own shell — it is not sandboxed. The Codex runtime runs commands inside
  its own OS sandbox as well.
- Polaris is a **Developer Preview**. Use it inside a Git repository and review what it
  changes.

## Credentials

- Polaris never asks for, stores or prints API keys or tokens. Providers authenticate
  through their own tools (`codex`, `claude`) or the `ANTHROPIC_API_KEY` environment
  variable.
- Logs in `~/.polaris/logs/` and reports from `polaris doctor --report` redact keys,
  tokens, authorization headers and cookies. Still, check a file before sharing it.
- Polaris sends no telemetry.

**Never include API keys, tokens or other credentials in issues, logs or screenshots.**

## Reporting a vulnerability

Please do not open a public issue for security problems. Use GitHub's private
vulnerability reporting instead: open the repository's **Security** tab and choose
**Report a vulnerability**.

<!-- TODO(maintainer): if private vulnerability reporting is not enabled for the
repository, enable it (Settings → Code security) or add a contact address here. -->

Include what you found, how to reproduce it, and its impact. You will get an answer as
soon as possible; this is a small project, so please allow some time.

## Supported versions

Only the latest release receives fixes during the Developer Preview.
