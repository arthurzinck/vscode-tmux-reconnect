import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/** Prefix used to name and recognize terminals this extension owns. */
const TERMINAL_PREFIX = 'tmux: ';

/** Codicon id shown on every tmux terminal and the '+' dropdown entry. */
const TMUX_ICON = 'server-process';

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('tmuxReconnect.reconnectAll', () =>
      reconnectAll({ manual: true })
    ),
    vscode.commands.registerCommand('tmuxReconnect.newSession', () => newSession()),
    vscode.commands.registerCommand('tmuxReconnect.killSession', () => killSession()),
    vscode.window.registerTerminalProfileProvider('tmuxReconnect.newSessionProfile', {
      provideTerminalProfile: () => newSessionProfile()
    })
  );

  const config = vscode.workspace.getConfiguration('tmuxReconnect');
  const isRemote = vscode.env.remoteName !== undefined;

  if (config.get<boolean>('autoReconnect', true) && (isRemote || config.get<boolean>('localToo', false))) {
    // Fire and forget; failures are surfaced to the user inside reconnectAll.
    void reconnectAll({ manual: false });
  }
}

export function deactivate(): void {
  // Nothing to clean up: terminals are owned by VS Code.
}

interface ReconnectOptions {
  manual: boolean;
}

async function reconnectAll({ manual }: ReconnectOptions): Promise<void> {
  const { tmuxPath, execAttach } = readConfig();

  let sessions: string[];
  try {
    sessions = await listSessions(tmuxPath);
  } catch (err) {
    if (manual) {
      void vscode.window.showErrorMessage(`Tmux Reconnect: ${asMessage(err)}`);
    }
    return;
  }

  if (sessions.length === 0) {
    if (manual) {
      void vscode.window.showInformationMessage('Tmux Reconnect: no tmux sessions to attach.');
    }
    return;
  }

  // Skip sessions that already have a terminal open from a previous run.
  const openNames = new Set(vscode.window.terminals.map((t) => t.name));

  let attached = 0;
  for (const session of sessions) {
    if (openNames.has(terminalName(session))) {
      continue;
    }
    attachTerminal(session, tmuxPath, execAttach);
    attached++;
  }

  if (attached > 0) {
    vscode.window.terminals[vscode.window.terminals.length - 1]?.show(true);
  } else if (manual) {
    void vscode.window.showInformationMessage('Tmux Reconnect: all sessions are already attached.');
  }
}

/** Prompts for a name, creates a detached tmux session, and attaches it in a terminal. */
async function newSession(): Promise<void> {
  const { tmuxPath, execAttach } = readConfig();

  const session = await promptNewSession(tmuxPath);
  if (session === undefined) {
    return; // cancelled or failed (already surfaced)
  }
  attachTerminal(session, tmuxPath, execAttach).show(false);
}

/**
 * Backs the "New tmux session" entry in the terminal '+' dropdown: prompts for a
 * name, creates the session detached, then returns a profile that attaches to it.
 */
async function newSessionProfile(): Promise<vscode.TerminalProfile | undefined> {
  const { tmuxPath } = readConfig();

  const session = await promptNewSession(tmuxPath);
  if (session === undefined) {
    return undefined; // cancelled or failed (already surfaced)
  }

  // 'exec' semantics come free here: the terminal's root process is tmux itself,
  // so quitting tmux closes the terminal regardless of the execAttach setting.
  return new vscode.TerminalProfile({
    name: terminalName(session),
    iconPath: new vscode.ThemeIcon(TMUX_ICON),
    shellPath: tmuxPath,
    shellArgs: ['attach-session', '-t', session]
  });
}

/**
 * Prompts for a session name (validated against existing sessions) and creates it
 * detached. Returns the created name, or undefined if the user cancelled or it failed.
 */
async function promptNewSession(tmuxPath: string): Promise<string | undefined> {
  let existing: string[] = [];
  try {
    existing = await listSessions(tmuxPath);
  } catch (err) {
    void vscode.window.showErrorMessage(`Tmux Reconnect: ${asMessage(err)}`);
    return undefined;
  }

  const name = await vscode.window.showInputBox({
    prompt: 'Name for the new tmux session',
    placeHolder: 'e.g. build, logs, editor',
    validateInput: (value) => {
      const trimmed = value.trim();
      if (trimmed.length === 0) {
        return 'Session name cannot be empty.';
      }
      // tmux forbids '.' and ':' in session names.
      if (/[.:]/.test(trimmed)) {
        return 'Session name cannot contain "." or ":".';
      }
      if (existing.includes(trimmed)) {
        return `A session named "${trimmed}" already exists.`;
      }
      return undefined;
    }
  });

  if (name === undefined) {
    return undefined; // user cancelled
  }
  const session = name.trim();

  try {
    // Create detached so we control the client through the terminal.
    await execAsync(`${tmuxPath} new-session -d -s ${shellQuote(session)}`);
  } catch (err) {
    void vscode.window.showErrorMessage(`Tmux Reconnect: could not create session — ${asMessage(err)}`);
    return undefined;
  }

  return session;
}

/** Lets the user pick a running session, kills it, and closes its terminal. */
async function killSession(): Promise<void> {
  const { tmuxPath } = readConfig();

  let sessions: string[];
  try {
    sessions = await listSessions(tmuxPath);
  } catch (err) {
    void vscode.window.showErrorMessage(`Tmux Reconnect: ${asMessage(err)}`);
    return;
  }

  if (sessions.length === 0) {
    void vscode.window.showInformationMessage('Tmux Reconnect: no tmux sessions to kill.');
    return;
  }

  const picked = await vscode.window.showQuickPick(sessions, {
    placeHolder: 'Select a tmux session to kill',
    canPickMany: false
  });
  if (picked === undefined) {
    return; // user cancelled
  }

  const confirm = await vscode.window.showWarningMessage(
    `Kill tmux session "${picked}"? This ends all its processes.`,
    { modal: true },
    'Kill'
  );
  if (confirm !== 'Kill') {
    return;
  }

  try {
    await execAsync(`${tmuxPath} kill-session -t ${shellQuote(picked)}`);
  } catch (err) {
    void vscode.window.showErrorMessage(`Tmux Reconnect: could not kill session — ${asMessage(err)}`);
    return;
  }

  // Dispose the matching terminal, if we own one.
  vscode.window.terminals
    .filter((t) => t.name === terminalName(picked))
    .forEach((t) => t.dispose());

  void vscode.window.showInformationMessage(`Tmux Reconnect: killed session "${picked}".`);
}

/** Creates a terminal attached to the given session and returns it. */
function attachTerminal(session: string, tmuxPath: string, execAttach: boolean): vscode.Terminal {
  const terminal = vscode.window.createTerminal({
    name: terminalName(session),
    iconPath: new vscode.ThemeIcon(TMUX_ICON)
  });
  const attachCmd = `${execAttach ? 'exec ' : ''}${tmuxPath} attach-session -t ${shellQuote(session)}`;
  terminal.sendText(attachCmd, true);
  return terminal;
}

/** Returns the list of tmux session names on the host, or [] when no server runs. */
async function listSessions(tmuxPath: string): Promise<string[]> {
  try {
    const { stdout } = await execAsync(`${tmuxPath} list-sessions -F '#{session_name}'`);
    return stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch (err: unknown) {
    const e = err as { stderr?: string; message?: string; code?: string };
    const stderr = (e.stderr ?? '').toLowerCase();

    // No running server means simply no sessions — not an error worth surfacing.
    if (stderr.includes('no server running') || stderr.includes('no sessions')) {
      return [];
    }
    if (e.code === 'ENOENT' || stderr.includes('not found')) {
      throw new Error(`tmux not found (looked for "${tmuxPath}"). Set tmuxReconnect.tmuxPath.`);
    }
    throw new Error(e.stderr?.trim() || e.message || 'failed to list tmux sessions');
  }
}

function readConfig(): { tmuxPath: string; execAttach: boolean } {
  const config = vscode.workspace.getConfiguration('tmuxReconnect');
  return {
    tmuxPath: config.get<string>('tmuxPath', 'tmux'),
    execAttach: config.get<boolean>('execAttach', true)
  };
}

function terminalName(session: string): string {
  return `${TERMINAL_PREFIX}${session}`;
}

function asMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Single-quote a value for safe use in a POSIX shell command. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
