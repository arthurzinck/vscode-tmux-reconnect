import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export type SessionState = 'needs-input' | 'working' | 'idle' | 'dead';

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
    private readonly intervalMs: () => number,
    private readonly needsInputPatterns: () => RegExp[],
    private readonly workingPatterns: () => RegExp[],
    private readonly log: vscode.LogOutputChannel
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
    const tmuxPath = this.tmuxPath();
    let sessions: TmuxSession[];
    try {
      sessions = await fetchSessions(tmuxPath, this.needsInputPatterns(), this.workingPatterns());
    } catch (err) {
      this.log.error(
        `poll failed (tmuxPath="${tmuxPath}"): ${err instanceof Error ? err.message : String(err)}`
      );
      return; // keep the last known state
    }
    this.log.debug(`poll: ${sessions.map((s) => `${s.name}=${s.state}`).join(', ') || '(none)'}`);
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

/**
 * Reads sessions and derives each state from its visible pane CONTENT, not from
 * the process name or tmux activity — both of which are unreliable for a resident
 * TUI agent. Pane content reflects the true state (working / waiting) whether or
 * not a client is attached.
 */
async function fetchSessions(
  tmuxPath: string,
  needsInputPatterns: RegExp[],
  workingPatterns: RegExp[]
): Promise<TmuxSession[]> {
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
    sessions.push({
      name,
      attached: attached !== '0',
      windows: Number(windows) || 1,
      command: info?.command ?? '',
      state: info?.dead ? 'dead' : 'idle'
    });
  }

  // Classify live sessions from their pane text: needs-input wins over working.
  await Promise.all(
    sessions.map(async (session) => {
      if (session.state === 'dead') {
        return;
      }
      const text = await capturePane(tmuxPath, session.name);
      if (text === undefined) {
        return; // capture failed — leave as idle
      }
      if (needsInputPatterns.some((re) => re.test(text))) {
        session.state = 'needs-input';
      } else if (workingPatterns.some((re) => re.test(text))) {
        session.state = 'working';
      }
    })
  );

  return sessions;
}

/** Returns a session's visible pane text, or undefined on failure. */
async function capturePane(tmuxPath: string, session: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(tmuxPath, ['capture-pane', '-p', '-t', session]);
    return stdout;
  } catch {
    return undefined;
  }
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
    if (element) {
      return [];
    }
    // Sessions waiting for input float to the top; then working, idle, dead.
    return [...this.monitor.latest].sort((a, b) => stateRank(a.state) - stateRank(b.state));
  }
}

const STATE_ORDER: SessionState[] = ['needs-input', 'working', 'idle', 'dead'];

function stateRank(state: SessionState): number {
  return STATE_ORDER.indexOf(state);
}

function describe(session: TmuxSession): string {
  switch (session.state) {
    case 'needs-input':
      return 'needs input';
    case 'working':
      return session.command;
    case 'dead':
      return 'dead';
    default:
      return session.attached ? 'idle' : 'idle · detached';
  }
}

/** Distinct icon (and colour) per state — shape carries the status, not just hue. */
function stateIcon(state: SessionState): vscode.ThemeIcon {
  switch (state) {
    case 'needs-input':
      // Attention-grabbing: this is the one the user must act on.
      return new vscode.ThemeIcon('bell-dot', new vscode.ThemeColor('charts.yellow'));
    case 'working':
      // Spinning icon reads as "busy" at a glance, regardless of theme.
      return new vscode.ThemeIcon('sync~spin', new vscode.ThemeColor('charts.green'));
    case 'dead':
      return new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red'));
    default:
      return new vscode.ThemeIcon('circle-outline');
  }
}
