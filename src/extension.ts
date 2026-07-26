import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';
import { scheduleUpdateChecks } from './update';
import { TmuxMonitor, SessionsProvider } from './sessions';

const execAsync = promisify(exec);

/**
 * Terminal name format: "tmux <slot>: <session>", e.g. "tmux 3: Library". The
 * slot is a stable 1-based number shown in the tab so it is obvious which
 * Cmd/Alt+N shortcut focuses it. Session names never contain ':' (forbidden at
 * creation), so the trailing group is unambiguous.
 */
const TERMINAL_RE = /^tmux(?: (\d+))?: (.+)$/s;

/** Codicon id shown on every tmux terminal and the '+' dropdown entry. */
const TMUX_ICON = 'server-process';

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('tmuxReconnect.reconnectAll', () =>
      reconnectAll({ manual: true })
    ),
    vscode.commands.registerCommand('tmuxReconnect.newSession', () => newSession()),
    vscode.commands.registerCommand('tmuxReconnect.renameSession', (arg: unknown) =>
      renameSession(sessionArg(arg))
    ),
    vscode.commands.registerCommand('tmuxReconnect.killSession', (arg: unknown) =>
      killSession(sessionArg(arg))
    ),
    vscode.commands.registerCommand('tmuxReconnect.focusTerminal', (index: unknown) =>
      focusTmuxTerminal(index)
    ),
    vscode.commands.registerCommand('tmuxReconnect.focusOrAttach', (name: unknown) =>
      focusOrAttach(name)
    ),
    vscode.window.registerTerminalProfileProvider('tmuxReconnect.newSessionProfile', {
      provideTerminalProfile: () => newSessionProfile()
    })
  );

  // Live sessions sidebar, fed by a background poller.
  const monitor = new TmuxMonitor(
    () => readConfig().tmuxPath,
    () => vscode.workspace.getConfiguration('tmuxReconnect').get<number>('statusRefreshMs', 2000)
  );
  context.subscriptions.push(
    monitor,
    vscode.window.registerTreeDataProvider('tmuxReconnect.sessions', new SessionsProvider(monitor)),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('tmuxReconnect.statusRefreshMs')) {
        monitor.reschedule();
      }
    })
  );
  monitor.start();

  // VS Code may restore persisted terminals asynchronously after we reconnect;
  // debounce a dedupe pass so a late-restored duplicate gets collapsed.
  let dedupeTimer: NodeJS.Timeout | undefined;
  context.subscriptions.push(
    vscode.window.onDidOpenTerminal(() => {
      if (dedupeTimer) {
        clearTimeout(dedupeTimer);
      }
      dedupeTimer = setTimeout(dedupeTmuxTerminals, 500);
    })
  );

  const config = vscode.workspace.getConfiguration('tmuxReconnect');
  const isRemote = vscode.env.remoteName !== undefined;

  if (config.get<boolean>('autoReconnect', true) && (isRemote || config.get<boolean>('localToo', false))) {
    // Fire and forget; failures are surfaced to the user inside reconnectAll.
    void reconnectAll({ manual: false });
  }

  // Check GitHub for a newer release now and every 24h (silent on failure).
  scheduleUpdateChecks(context);
}

export function deactivate(): void {
  // Nothing to clean up: terminals are owned by VS Code.
}

interface ReconnectOptions {
  manual: boolean;
}

async function reconnectAll({ manual }: ReconnectOptions): Promise<void> {
  const { tmuxPath } = readConfig();

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

  // A session counts as open only if it already has a numbered terminal. Legacy
  // (un-numbered) terminals are left to be superseded and cleaned up by dedupe.
  const openSessions = new Set<string>();
  for (const t of vscode.window.terminals) {
    const parsed = parseTerminal(t.name);
    if (parsed?.slot !== undefined) {
      openSessions.add(parsed.session);
    }
  }
  const used = usedSlots();

  let attached = 0;
  for (const session of sessions) {
    if (openSessions.has(session)) {
      continue;
    }
    const slot = firstFreeSlot(used);
    used.add(slot);
    attachTerminal(session, tmuxPath, slot);
    attached++;
  }

  // Collapse any duplicates (e.g. an old terminal restored alongside a fresh one).
  dedupeTmuxTerminals();

  if (attached > 0) {
    vscode.window.terminals[vscode.window.terminals.length - 1]?.show(true);
  } else if (manual) {
    void vscode.window.showInformationMessage('Tmux Reconnect: all sessions are already attached.');
  }
}

/** Prompts for a name, creates a detached tmux session, and attaches it in a terminal. */
async function newSession(): Promise<void> {
  const { tmuxPath } = readConfig();

  const session = await promptNewSession(tmuxPath);
  if (session === undefined) {
    return; // cancelled or failed (already surfaced)
  }
  attachTerminal(session, tmuxPath, firstFreeSlot()).show(false);
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

  // Same shape as attachTerminal(), returned as a profile for the '+' dropdown.
  return new vscode.TerminalProfile({
    name: terminalName(firstFreeSlot(), session),
    iconPath: new vscode.ThemeIcon(TMUX_ICON),
    shellPath: tmuxPath,
    shellArgs: ['attach-session', '-t', session],
    isTransient: true
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

/** Kills a session (given, or picked) and closes its terminal. */
async function killSession(preset?: string): Promise<void> {
  const { tmuxPath } = readConfig();

  let picked = preset;
  if (picked === undefined) {
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

    picked = await vscode.window.showQuickPick(sessions, {
      placeHolder: 'Select a tmux session to kill',
      canPickMany: false
    });
    if (picked === undefined) {
      return; // user cancelled
    }
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
    .filter((t) => sessionOfTerminal(t) === picked)
    .forEach((t) => t.dispose());

  void vscode.window.showInformationMessage(`Tmux Reconnect: killed session "${picked}".`);
}

/**
 * Renames a tmux session and its VS Code terminal together, keeping the two in
 * sync. Targets the active tmux terminal's session when there is one, otherwise
 * asks which session to rename.
 */
async function renameSession(preset?: string): Promise<void> {
  const { tmuxPath } = readConfig();

  let sessions: string[];
  try {
    sessions = await listSessions(tmuxPath);
  } catch (err) {
    void vscode.window.showErrorMessage(`Tmux Reconnect: ${asMessage(err)}`);
    return;
  }

  if (sessions.length === 0) {
    void vscode.window.showInformationMessage('Tmux Reconnect: no tmux sessions to rename.');
    return;
  }

  // Use the given session, else the focused terminal's, else ask.
  const active = sessionOfTerminal(vscode.window.activeTerminal);
  let current = preset ?? (active && sessions.includes(active) ? active : undefined);
  if (current === undefined) {
    current = await vscode.window.showQuickPick(sessions, {
      placeHolder: 'Select a tmux session to rename'
    });
    if (current === undefined) {
      return; // user cancelled
    }
  }

  const newName = await vscode.window.showInputBox({
    prompt: `New name for tmux session "${current}"`,
    value: current,
    validateInput: (value) => {
      const trimmed = value.trim();
      if (trimmed.length === 0) {
        return 'Session name cannot be empty.';
      }
      if (/[.:]/.test(trimmed)) {
        return 'Session name cannot contain "." or ":".';
      }
      if (trimmed !== current && sessions.includes(trimmed)) {
        return `A session named "${trimmed}" already exists.`;
      }
      return undefined;
    }
  });

  if (newName === undefined) {
    return; // user cancelled
  }
  const renamed = newName.trim();
  if (renamed === current) {
    return; // nothing to do
  }

  try {
    await execAsync(`${tmuxPath} rename-session -t ${shellQuote(current)} ${shellQuote(renamed)}`);
  } catch (err) {
    void vscode.window.showErrorMessage(`Tmux Reconnect: could not rename session — ${asMessage(err)}`);
    return;
  }

  // VS Code offers no reliable API to rename an existing terminal, so re-open the
  // tab instead: close the old one and attach a fresh terminal to the renamed
  // session, reusing the same slot so its Cmd+N shortcut stays put. The tmux
  // session persists, so its content is redrawn on re-attach.
  const terminal = vscode.window.terminals.find((t) => sessionOfTerminal(t) === current);

  if (terminal) {
    const wasActive = vscode.window.activeTerminal === terminal;
    const slot = parseTerminal(terminal.name)?.slot ?? firstFreeSlot();
    terminal.dispose();
    attachTerminal(renamed, tmuxPath, slot).show(!wasActive);
  }

  void vscode.window.showInformationMessage(`Tmux Reconnect: renamed "${current}" to "${renamed}".`);
}

/** Focuses the terminal for a session, attaching a new one if none is open yet. */
function focusOrAttach(name: unknown): void {
  if (typeof name !== 'string') {
    return;
  }
  const existing = vscode.window.terminals.find((t) => sessionOfTerminal(t) === name);
  if (existing) {
    existing.show();
    return;
  }
  attachTerminal(name, readConfig().tmuxPath, firstFreeSlot()).show(false);
}

/** Extracts a session name from a command argument (a tree item or a raw string). */
function sessionArg(arg: unknown): string | undefined {
  if (typeof arg === 'string') {
    return arg;
  }
  if (arg && typeof arg === 'object' && 'name' in arg) {
    return (arg as { name: string }).name;
  }
  return undefined;
}

/** Focuses the tmux terminal whose slot number matches (the "N" shown in its tab). */
function focusTmuxTerminal(slot: unknown): void {
  if (typeof slot !== 'number' || slot < 1) {
    return;
  }
  const target = vscode.window.terminals.find((t) => parseTerminal(t.name)?.slot === slot);
  target?.show();
}

/** Returns the tmux session a terminal is attached to, if this extension owns it. */
function sessionOfTerminal(terminal: vscode.Terminal | undefined): string | undefined {
  return terminal ? parseTerminal(terminal.name)?.session : undefined;
}

/**
 * Creates a terminal whose root process IS `tmux attach`, not a shell running it.
 * This survives VS Code's persistent-session restore: on window reload VS Code
 * relaunches tmux attach instead of dropping the user into a bare shell.
 */
function attachTerminal(session: string, tmuxPath: string, slot: number): vscode.Terminal {
  return vscode.window.createTerminal({
    name: terminalName(slot, session),
    iconPath: new vscode.ThemeIcon(TMUX_ICON),
    shellPath: tmuxPath,
    shellArgs: ['attach-session', '-t', session],
    // Do NOT let VS Code persist/restore these: on reload it would revive them as
    // a bare shell (ignoring shellPath) instead of tmux. We re-attach ourselves.
    isTransient: true
  });
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

function readConfig(): { tmuxPath: string } {
  const config = vscode.workspace.getConfiguration('tmuxReconnect');
  return {
    tmuxPath: config.get<string>('tmuxPath', 'tmux')
  };
}

function terminalName(slot: number, session: string): string {
  return `tmux ${slot}: ${session}`;
}

/**
 * Parses one of this extension's terminal names into its slot and session.
 * The slot is undefined for legacy terminals named "tmux: <session>" (no number),
 * which may be restored from an older version's persistent session.
 */
function parseTerminal(name: string): { slot: number | undefined; session: string } | undefined {
  const match = TERMINAL_RE.exec(name);
  if (!match) {
    return undefined;
  }
  return { slot: match[1] !== undefined ? Number(match[1]) : undefined, session: match[2] };
}

/** All slot numbers currently in use by open tmux terminals. */
function usedSlots(): Set<number> {
  const slots = new Set<number>();
  for (const t of vscode.window.terminals) {
    const slot = parseTerminal(t.name)?.slot;
    if (slot !== undefined) {
      slots.add(slot);
    }
  }
  return slots;
}

/**
 * Keeps one terminal per tmux session, disposing extras. Prefers a numbered
 * (slotted) terminal over a legacy one. Safe: closing a duplicate just detaches
 * that tmux client; the session and its content persist.
 */
function dedupeTmuxTerminals(): void {
  const bySession = new Map<string, vscode.Terminal[]>();
  for (const t of vscode.window.terminals) {
    const session = sessionOfTerminal(t);
    if (session === undefined) {
      continue;
    }
    const group = bySession.get(session) ?? [];
    group.push(t);
    bySession.set(session, group);
  }
  for (const group of bySession.values()) {
    if (group.length < 2) {
      continue;
    }
    const keeper = group.find((t) => parseTerminal(t.name)?.slot !== undefined) ?? group[0];
    for (const t of group) {
      if (t !== keeper) {
        t.dispose();
      }
    }
  }
}

/** Smallest 1-based slot not already taken (so Cmd+N stays dense and stable). */
function firstFreeSlot(used: Set<number> = usedSlots()): number {
  let n = 1;
  while (used.has(n)) {
    n++;
  }
  return n;
}

function asMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Single-quote a value for safe use in a POSIX shell command. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
