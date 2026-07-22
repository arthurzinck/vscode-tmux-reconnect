# Roadmap / TODO

Improvements to bring the extension from "clean prototype" to "pro / marketplace-grade".
Ordered by priority.

## Critical

- [ ] **Rework the self-updater** (`src/update.ts`). Downloading and installing a
      `.vsix` from GitHub with no checksum/signature is a security risk and is
      incompatible with the Marketplace update mechanism. Options: (a) drop it and
      rely on the Marketplace once published, or (b) keep it for private sideloaded
      distribution but verify the download and stop using the undocumented
      `workbench.extensions.installExtension` Uri contract.
- [ ] **Replace `exec` + `shellQuote` with `execFile`** (`extension.ts` new/kill/
      rename/list). Pass argv arrays instead of building shell strings — removes the
      whole quoting/injection class of bugs and the unquoted `tmuxPath` issue. Delete
      `shellQuote`.

## Serious

- [ ] **Add tests.** Unit-test `compareVersions`, `list-sessions` parsing, and the
      tmux argv builders. Add `@vscode/test-electron` integration tests. Wire them
      into CI.
- [ ] **Add ESLint + Prettier**, and run lint in CI.
- [ ] **Bundle with esbuild** (`dist/extension.js`) instead of shipping raw `tsc`
      output, for size and activation time.
- [ ] **Network timeout** on `fetchLatestRelease` (`update.ts`) — `https.get` has no
      timeout and can hang on every launch.

## Polish

- [ ] **Extension icon** (128×128 PNG) in `package.json` (`icon` field).
- [ ] **`CHANGELOG.md`** (shown on the Marketplace and in release notes).
- [ ] **Better `categories`** than `["Other"]`.
- [ ] **Pin `@vscode/vsce`** version in the release workflow (no `npx --yes` latest).
- [ ] **Clean up the downloaded `.vsix`** from `os.tmpdir()` after install.
- [ ] **DRY** `newSessionProfile` and `attachTerminal` — extract a shared
      `tmuxTerminalOptions(session, tmuxPath)`.

## Nice to have

- [ ] `Tmux: Check for updates` command for on-demand checks.
- [ ] Handle session names containing spaces in `list-sessions` parsing.
- [ ] `vscode.l10n` for user-facing strings.
