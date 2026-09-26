# Release checklist

For each Developer Preview build handed to testers.

- [ ] Version updated in `package.json` (the only place it lives)
- [ ] `npm run typecheck`, `npm test`, `npm run lint`, `npm run build` green locally
- [ ] CI green on Windows, Ubuntu and macOS
- [ ] `npm pack --dry-run` inspected: only `dist/`, docs, README, LICENSE, package.json
- [ ] `npm run test:package` passes
- [ ] Windows smoke test by hand: first run, `polaris doctor`, a small edit, `/diff`, `/undo`
- [ ] README matches the commands and options that actually exist
- [ ] No secrets in the repository, the package or example logs
- [ ] `polaris doctor` output reviewed on a machine that is not the maintainer's

Decisions still open before a public npm release:

- [ ] npm package name (`polaris` is almost certainly taken)
- [ ] Private vulnerability reporting enabled on GitHub (see SECURITY.md)
