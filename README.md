# Tmux Reconnect

Re-attaches your tmux sessions when VS Code connects to a remote host, so a
dropped SSH connection or a window reload never loses your terminals.

## What it does

- **On remote connect**, it lists the tmux sessions running on the host and
  opens one integrated terminal per session, each attached with
  `tmux attach-session -t <name>`.
- Terminals are named `tmux <n>: <session>` (e.g. `tmux 3: Library`), where `<n>`
  is a stable slot number shown in the tab so you can see which `Cmd/Alt+N`
  shortcut focuses it. Sessions that already have a terminal open are skipped, so
  re-running never duplicates them.

## Sessions sidebar

The **Tmux** view (activity bar) lists every session live, with a state icon:

| Icon | State | Meaning |
| --- | --- | --- |
| 🔔 `bell-dot` (yellow) | **needs input** | The session is waiting for you (e.g. an agent's approval prompt). Floats to the top. |
| ⟳ `sync` (green, spinning) | **working** | Produced output in the last few seconds. |
| ○ `circle-outline` | **idle** | Quiet — finished or waiting silently. |
| ✖ `error` (red) | **dead** | The pane died. |

Sessions needing input are counted in a **badge** on the Tmux icon, and (unless
disabled) raise a notification with an **Open** button when they start waiting.
This makes the extension a control panel for a fleet of terminal AI agents
(Claude Code, etc.) running in tmux: see at a glance which one needs you.

"Needs input" is detected by scanning the visible pane against
`tmuxReconnect.needsInputPatterns` — tune these for your tools.

## Commands

Run these from the Command Palette (`Ctrl/Cmd+Shift+P`):

| Command | Action |
| --- | --- |
| `Tmux: Reconnect all sessions` | Attach any sessions that aren't open yet. |
| `Tmux: New session` | Prompt for a name, create a detached session, and attach it. |
| `Tmux: Rename session` | Rename the session (defaults to the active terminal's) and its terminal tab together. |
| `Tmux: Kill session` | Pick a session, confirm, kill it, and close its terminal. |

## Keyboard shortcuts

While a terminal is focused, jump straight to the tmux terminal whose slot number
`<n>` is shown in its tab (`tmux <n>: <session>`):

| Shortcut (macOS) | Shortcut (Linux/Windows) | Action |
| --- | --- | --- |
| `Cmd+1` … `Cmd+9` | `Alt+1` … `Alt+9` | Focus tmux terminal 1 … 9. |
| `Cmd+0` | `Alt+0` | Focus tmux terminal 10. |

The mapping is stable: closing a terminal in the middle does not renumber the
others, and renaming a session keeps its slot.

The bindings are guarded by `terminalFocus`, so `Cmd+1`…`Cmd+9` keep their usual
editor-group behaviour when a terminal is not focused.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `tmuxReconnect.autoReconnect` | `true` | Attach sessions automatically when a remote window opens. |
| `tmuxReconnect.localToo` | `false` | Also run in local (non-remote) windows. |
| `tmuxReconnect.checkForUpdates` | `true` | Check GitHub Releases at each launch (and every 24h) and offer to install a newer `.vsix`. |
| `tmuxReconnect.tmuxPath` | `tmux` | Path to the `tmux` binary on the host. |

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
