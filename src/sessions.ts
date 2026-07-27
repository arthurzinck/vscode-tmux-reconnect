import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/** Commands that mean "just a shell is sitting there", i.e. the session is idle. */
const SHELLS = new Set(['zsh', '-zsh', 'bash', '-bash', 'sh', '-sh', 'fish', '-fish']);

export type SessionState = 'working' | 'idle' | 'dead';

export interface TmuxSession {
  name: string;
  attached: boolean;
  windows: number;
  /** Current command of the active pane of the active window. */
  command: string;
  state: SessionState;
}

/**
 * Polls tmux on an interval and emits the list of sessions with a derived state.
 * A single source of truth for the sidebar (and, later, notifications).
 */
export class TmuxMonitor implements vscode.Disposable {
  private timer: NodeJS.Timeout | undefined;
  private readonly emitter = new vscode.EventEmitter<TmuxSession[]>();
  readonly onDidChange = this.emitter.event;
  latest: TmuxSession[] = [];

  constructor(
    private readonly tmuxPath: () => string,
    private readonly intervalMs: () => number
  ) {}

  start(): void {
    void this.tick();
    this.schedule();
  }

  private schedule(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    const ms = this.intervalMs();
    if (ms > 0) {
      this.timer = setInterval(() => void this.tick(), ms);
    }
  }

  /** Re-reads the poll interval from config and applies it. */
  reschedule(): void {
    this.schedule();
  }

  async tick(): Promise<void> {
    let sessions: TmuxSession[];
    try {
      sessions = await fetchSessions(this.tmuxPath());
    } catch {
      return; // transient tmux/exec error — keep the last known state
    }
    this.latest = sessions;
    this.emitter.fire(sessions);
  }

  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
    this.emitter.dispose();
  }
}

/** Reads sessions plus the active pane's command in two tmux calls (no shell). */
async function fetchSessions(tmuxPath: string): Promise<TmuxSession[]> {
  let sessionsOut: string;
  try {
    const res = await execFileAsync(tmuxPath, [
      'list-sessions',
      '-F',
      '#{session_name}\t#{session_attached}\t#{session_windows}'
    ]);
    sessionsOut = res.stdout;
  } catch (err) {
    if (isNoServer(err)) {
      return [];
    }
    throw err;
  }

  // active pane (active window) per session → its current command / dead flag
  const active = new Map<string, { command: string; dead: boolean }>();
  try {
    const { stdout } = await execFileAsync(tmuxPath, [
      'list-panes',
      '-a',
      '-F',
      '#{session_name}\t#{window_active}\t#{pane_active}\t#{pane_dead}\t#{pane_current_command}'
    ]);
    for (const line of stdout.split('\n')) {
      if (!line) {
        continue;
      }
      const [name, win, pane, dead, ...cmd] = line.split('\t');
      if (win === '1' && pane === '1') {
        active.set(name, { command: cmd.join('\t'), dead: dead === '1' });
      }
    }
  } catch {
    // Panes are best-effort: without them, sessions still render as idle.
  }

  const sessions: TmuxSession[] = [];
  for (const line of sessionsOut.split('\n')) {
    if (!line) {
      continue;
    }
    const [name, attached, windows] = line.split('\t');
    const info = active.get(name);
    const command = info?.command ?? '';
    let state: SessionState = 'idle';
    if (info?.dead) {
      state = 'dead';
    } else if (command && !SHELLS.has(command)) {
      state = 'working';
    }
    sessions.push({
      name,
      attached: attached !== '0',
      windows: Number(windows) || 1,
      command,
      state
    });
  }
  return sessions;
}

function isNoServer(err: unknown): boolean {
  const stderr = String((err as { stderr?: string }).stderr ?? '').toLowerCase();
  return stderr.includes('no server running') || stderr.includes('no sessions');
}

/** Renders the monitor's sessions as a live tree in the sidebar. */
export class SessionsProvider implements vscode.TreeDataProvider<TmuxSession> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly monitor: TmuxMonitor) {
    monitor.onDidChange(() => this.changed.fire());
  }

  getTreeItem(session: TmuxSession): vscode.TreeItem {
    const item = new vscode.TreeItem(session.name);
    item.id = session.name;
    item.contextValue = 'tmuxSession';
    item.iconPath = stateIcon(session.state);
    item.description = describe(session);
    item.tooltip = new vscode.MarkdownString(
      `**${session.name}** — ${session.state}\n\n` +
        `- windows: ${session.windows}\n` +
        `- attached: ${session.attached ? 'yes' : 'no'}\n` +
        `- command: \`${session.command || 'shell'}\``
    );
    item.command = {
      command: 'tmuxReconnect.focusOrAttach',
      title: 'Focus session',
      arguments: [session.name]
    };
    return item;
  }

  getChildren(element?: TmuxSession): TmuxSession[] {
    return element ? [] : this.monitor.latest;
  }
}

function describe(session: TmuxSession): string {
  if (session.state === 'dead') {
    return 'dead';
  }
  if (session.state === 'working') {
    return session.command;
  }
  return session.attached ? 'idle' : 'idle · detached';
}

/** Distinct icon (and colour) per state — shape carries the status, not just hue. */
function stateIcon(state: SessionState): vscode.ThemeIcon {
  switch (state) {
    case 'working':
      // Spinning icon reads as "busy" at a glance, regardless of theme.
      return new vscode.ThemeIcon('sync~spin', new vscode.ThemeColor('charts.green'));
    case 'dead':
      return new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red'));
    default:
      return new vscode.ThemeIcon('circle-outline');
  }
}
