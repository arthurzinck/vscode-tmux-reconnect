import * as vscode from 'vscode';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

/** GitHub repo that publishes the releases. */
const REPO = 'arthurzinck/vscode-tmux-reconnect';

/** Required by the GitHub API; also identifies the client. */
const USER_AGENT = 'vscode-tmux-reconnect';

/** Keys used in the extension's global state. */
const LAST_CHECK_KEY = 'tmuxReconnect.lastUpdateCheck';
const SKIP_VERSION_KEY = 'tmuxReconnect.skipVersion';

/** Only hit the network once per day. */
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

interface GithubRelease {
  tag_name: string;
  html_url: string;
  assets: Array<{ name: string; browser_download_url: string }>;
}

/**
 * Checks GitHub for a newer release and, if found, offers to install it. Silent
 * on any failure — an update check should never disrupt the user.
 */
export async function checkForUpdates(context: vscode.ExtensionContext): Promise<void> {
  const config = vscode.workspace.getConfiguration('tmuxReconnect');
  if (!config.get<boolean>('checkForUpdates', true)) {
    return;
  }

  // Throttle to once per day.
  const lastCheck = context.globalState.get<number>(LAST_CHECK_KEY, 0);
  if (Date.now() - lastCheck < CHECK_INTERVAL_MS) {
    return;
  }

  let release: GithubRelease;
  try {
    release = await fetchLatestRelease();
    await context.globalState.update(LAST_CHECK_KEY, Date.now());
  } catch {
    return; // offline, rate-limited, etc. — stay quiet
  }

  const current = context.extension.packageJSON.version as string;
  const latest = release.tag_name.replace(/^v/, '');

  if (compareVersions(latest, current) <= 0) {
    return; // already up to date
  }
  if (context.globalState.get<string>(SKIP_VERSION_KEY) === latest) {
    return; // user asked to skip this one
  }

  const vsix = release.assets.find((a) => a.name.endsWith('.vsix'));
  const install = 'Update';
  const notes = 'Release notes';
  const skip = 'Skip';

  const choice = await vscode.window.showInformationMessage(
    `Tmux Reconnect ${latest} is available (you have ${current}).`,
    ...(vsix ? [install] : []),
    notes,
    skip
  );

  if (choice === install && vsix) {
    await downloadAndInstall(vsix.browser_download_url, vsix.name);
  } else if (choice === notes) {
    void vscode.env.openExternal(vscode.Uri.parse(release.html_url));
  } else if (choice === skip) {
    await context.globalState.update(SKIP_VERSION_KEY, latest);
  }
}

/** Downloads the .vsix, installs it via VS Code, and offers to reload. */
async function downloadAndInstall(url: string, fileName: string): Promise<void> {
  try {
    const dest = path.join(os.tmpdir(), fileName);
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Downloading ${fileName}…` },
      () => download(url, dest)
    );

    await vscode.commands.executeCommand('workbench.extensions.installExtension', vscode.Uri.file(dest));

    const reload = 'Reload window';
    const choice = await vscode.window.showInformationMessage(
      `Tmux Reconnect updated. Reload to activate the new version.`,
      reload
    );
    if (choice === reload) {
      void vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    void vscode.window.showErrorMessage(`Tmux Reconnect: update failed — ${message}`);
  }
}

/** GETs the latest release metadata from the GitHub API. */
function fetchLatestRelease(): Promise<GithubRelease> {
  return new Promise((resolve, reject) => {
    const options = {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/vnd.github+json' }
    };
    https
      .get(`https://api.github.com/repos/${REPO}/releases/latest`, options, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`GitHub API returned ${res.statusCode}`));
          return;
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(body) as GithubRelease);
          } catch (err) {
            reject(err);
          }
        });
      })
      .on('error', reject);
  });
}

/** Downloads a URL to a file, following GitHub's redirect to the asset CDN. */
function download(url: string, dest: string, redirects = 0): Promise<void> {
  return new Promise((resolve, reject) => {
    if (redirects > 5) {
      reject(new Error('too many redirects'));
      return;
    }
    https
      .get(url, { headers: { 'User-Agent': USER_AGENT } }, (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          download(res.headers.location, dest, redirects + 1).then(resolve, reject);
          return;
        }
        if (status !== 200) {
          res.resume();
          reject(new Error(`download failed (HTTP ${status})`));
          return;
        }
        const file = fs.createWriteStream(dest);
        res.pipe(file);
        file.on('finish', () => file.close((err) => (err ? reject(err) : resolve())));
        file.on('error', (err) => {
          fs.unlink(dest, () => reject(err));
        });
      })
      .on('error', reject);
  });
}

/** Compares dotted numeric versions. Returns >0 if a is newer than b. */
function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}
