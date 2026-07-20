# Tmux Reconnect

Re-attaches your tmux sessions when VS Code connects to a remote host, so a
dropped SSH connection or a window reload never loses your terminals.

## What it does

- **On remote connect**, it lists the tmux sessions running on the host and
  opens one integrated terminal per session, each attached with
  `tmux attach-session -t <name>`.
- Terminals are named `tmux: <session>`; sessions that already have a terminal
  open are skipped, so re-running never duplicates them.

## Commands

Run these from the Command Palette (`Ctrl/Cmd+Shift+P`):

| Command | Action |
| --- | --- |
| `Tmux: Reconnect all sessions` | Attach any sessions that aren't open yet. |
| `Tmux: New session` | Prompt for a name, create a detached session, and attach it. |
| `Tmux: Kill session` | Pick a session, confirm, kill it, and close its terminal. |

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `tmuxReconnect.autoReconnect` | `true` | Attach sessions automatically when a remote window opens. |
| `tmuxReconnect.localToo` | `false` | Also run in local (non-remote) windows. |
| `tmuxReconnect.tmuxPath` | `tmux` | Path to the `tmux` binary on the host. |
| `tmuxReconnect.execAttach` | `true` | Use `exec tmux attach` so quitting tmux closes the terminal. |

## Why it runs on the remote

The manifest declares `"extensionKind": ["workspace"]`, which forces the
extension host — and therefore its `tmux` calls — to run on the machine VS Code
is connected to, not your laptop. That is the machine whose sessions you want.

## Develop

```bash
npm install
npm run compile      # or: npm run watch
```

Press `F5` in VS Code to launch an Extension Development Host. To install
locally, package it with `npx @vscode/vsce package` and run
`code --install-extension tmux-reconnect-0.1.0.vsix`.

## Releasing

CI builds the installable `.vsix` automatically. Bump the version, tag it, and
push the tag:

```bash
npm version patch --no-git-tag-version   # 0.1.0 -> 0.1.1
git commit -am "chore: release v0.1.1"
git tag v0.1.1
git push && git push --tags
```

The `Release` workflow (`.github/workflows/release.yml`) then compiles, packages
the `.vsix`, and attaches it to a GitHub Release for that tag. The `CI` workflow
compiles on every push and pull request.
