// Windows desktop mode for the observability dashboard, run with Bun (no Python). The window is a small
// WebView2 program compiled on this PC at install time (desktop/host); without it, an Edge app window.
//
//   bun apps/desktop/main.ts                 open the dashboard window (starts the server if needed)
//   bun apps/desktop/main.ts --install       build the client, add Claude Code hooks, create shortcuts
//   bun apps/desktop/main.ts --uninstall     remove the hooks and shortcuts (data is kept)
//   bun apps/desktop/main.ts --hook          hook sender: reads Claude Code hook JSON on stdin
//
// The server runs inside the window process: closing the window stops it, and hooks then fail
// silently (events are not recorded while the window is closed).
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync, openSync, readSync, closeSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir, hostname } from 'node:os';
import { createHash } from 'node:crypto';

const PORT = Number(process.env.SERVER_PORT || 4000);
const URL_ROOT = `http://127.0.0.1:${PORT}`;
const APP_NAME = 'Claude Observability';
const REPO_ROOT = resolve(import.meta.dir, '..', '..');
const CLIENT_DIR = join(REPO_ROOT, 'apps', 'client');
const WEB_DIR = join(CLIENT_DIR, 'dist');
const DATA_DIR = join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'ClaudeObservability');
const PROFILE_DIR = join(DATA_DIR, 'webview-profile'); // Edge fallback window only
// Window host: desktop/host/ObservabilityWindow.cs compiled at install against a pinned WebView2 SDK.
const HOST_DIR = join(DATA_DIR, 'host');
const HOST_EXE = join(HOST_DIR, 'ObservabilityWindow.exe');
const WEBVIEW2_SDK = { version: '1.0.4258.31', sha256: '56f7f4b8bf9aee4b8efefbbdd4f67d5f74ebd1b100ed0806da71bf76af481aa9' };
const APP_ID = 'MultiAgentObservability.Desktop'; // taskbar id shared by the window and its shortcuts
const SETTINGS_PATH = join(homedir(), '.claude', 'settings.json');
const HOOK_EVENTS = [
  'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
  'PermissionRequest', 'Notification', 'SubagentStart', 'SubagentStop', 'Stop', 'PreCompact',
];
const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest']);
const HOOK_MARK = 'apps/desktop/main.ts'; // identifies hooks this tool installed

const args = process.argv.slice(2);
const argValue = (name: string, fallback: string) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

// ---------------------------------------------------------------- hook sender

// Last model name recorded in the transcript tail (the dashboard shows it per session).
function modelFromTranscript(path: string): string {
  try {
    const size = statSync(path).size;
    const len = Math.min(size, 256 * 1024);
    const buf = Buffer.alloc(len);
    const fd = openSync(path, 'r');
    readSync(fd, buf, 0, len, size - len);
    closeSync(fd);
    const lines = buf.toString('utf8').split('\n').reverse();
    for (const line of lines) {
      const m = line.match(/"model"\s*:\s*"([^"]+)"/);
      if (m && m[1] !== '<synthetic>') return m[1];
    }
  } catch { /* transcript missing or unreadable */ }
  return '';
}

async function runHook() {
  try {
    const input = JSON.parse(await Bun.stdin.text());
    const type: string = input.hook_event_name || 'Unknown';
    const event: Record<string, unknown> = {
      source_app: argValue('--source-app', hostname()),
      session_id: input.session_id || 'unknown',
      hook_event_type: type,
      payload: input,
      timestamp: Date.now(),
      model_name: input.transcript_path ? modelFromTranscript(input.transcript_path) : '',
    };
    for (const key of ['tool_name', 'tool_use_id', 'error', 'is_interrupt', 'permission_suggestions', 'agent_id',
      'agent_type', 'agent_transcript_path', 'stop_hook_active', 'notification_type', 'custom_instructions', 'source', 'reason']) {
      if (key in input) event[key] = input[key];
    }
    const res = await fetch(`${URL_ROOT}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(3000),
    });
    if (process.env.OBS_HOOK_DEBUG) console.error(`POST /events -> ${res.status}`);
  } catch (e) {
    // Dashboard closed or bad input: never block Claude Code. OBS_HOOK_DEBUG=1 shows why.
    if (process.env.OBS_HOOK_DEBUG) console.error(e);
  }
  process.exit(0);
}

// ---------------------------------------------------------------- window

async function serverAlreadyUp(): Promise<boolean> {
  try {
    const res = await fetch(`${URL_ROOT}/events/recent?limit=1`, { signal: AbortSignal.timeout(800) });
    return res.ok;
  } catch {
    return false;
  }
}

function findEdge(): string | null {
  const candidates = [
    join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ];
  return candidates.find(p => existsSync(p)) ?? null;
}

async function runWindow() {
  if (!existsSync(join(WEB_DIR, 'index.html'))) {
    console.error('Dashboard is not built yet. Run: bun apps/desktop/main.ts --install');
    process.exit(1);
  }
  mkdirSync(DATA_DIR, { recursive: true });
  process.env.SERVER_PORT = String(PORT);
  process.env.OBS_DB_PATH = join(DATA_DIR, 'events.db');
  process.env.OBS_STATIC_DIR = WEB_DIR;

  // Another window (or a dev server) already owns the port: just open the window.
  const ownServer = !(await serverAlreadyUp());
  if (ownServer) {
    await import('../server/src/index.ts');
  }

  // Our own window (built by --install); a second one only brings the open window forward.
  if (existsSync(HOST_EXE)) {
    const host = Bun.spawn([HOST_EXE, '--url', `${URL_ROOT}/`, '--data', DATA_DIR, '--prefs', join(DATA_DIR, 'window.json'),
      '--icon', join(DATA_DIR, 'icon.ico'), '--app-id', APP_ID], { stdout: 'ignore', stderr: 'ignore' });
    const code = await host.exited;
    if (code !== 3 || !ownServer) process.exit(0);
    // 3: no WebView2 Runtime on this PC, so fall back to an Edge app window.
  }

  const edge = findEdge();
  if (!edge) {
    Bun.spawn(['cmd', '/c', 'start', '', URL_ROOT]);
    if (!ownServer) process.exit(0);
    return; // no app window to wait on: keep serving until the process is ended
  }

  Bun.spawn([
    edge,
    `--app=${URL_ROOT}/`,
    `--user-data-dir=${PROFILE_DIR}`,
    '--window-size=1280,860',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=msEdgeSidebarV2,msHubApps,BackgroundModeAllowed',
  ], { stdout: 'ignore', stderr: 'ignore' });

  // msedge.exe hands the window to another process and returns at once, so its exit says nothing.
  // The profile's "lockfile" is held (delete-on-close) for as long as that browser instance lives.
  const lockfile = join(PROFILE_DIR, 'lockfile');
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
  for (let i = 0; i < 60 && !existsSync(lockfile); i++) await sleep(250);
  while (existsSync(lockfile)) await sleep(1000);
  process.exit(0);
}

// ---------------------------------------------------------------- install / uninstall

function readSettings(): Record<string, any> {
  if (!existsSync(SETTINGS_PATH)) return {};
  return JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'));
}

// Hooks from this tool, or from the upstream Python sender (send_event.py), are replaced on install.
function isObservabilityHook(h: any): boolean {
  const text = `${h?.command ?? ''} ${(h?.args ?? []).join(' ')}`.replace(/\\/g, '/');
  return text.includes(HOOK_MARK) || text.includes('send_event.py');
}

function stripObservabilityHooks(settings: Record<string, any>) {
  const hooks = settings.hooks;
  if (!hooks) return;
  for (const event of Object.keys(hooks)) {
    hooks[event] = (hooks[event] as any[])
      .map(group => ({ ...group, hooks: (group.hooks || []).filter((h: any) => !isObservabilityHook(h)) }))
      .filter(group => group.hooks.length > 0);
    if (hooks[event].length === 0) delete hooks[event];
  }
  if (Object.keys(hooks).length === 0) delete settings.hooks;
}

function writeSettings(settings: Record<string, any>) {
  mkdirSync(dirname(SETTINGS_PATH), { recursive: true });
  if (existsSync(SETTINGS_PATH)) {
    const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
    copyFileSync(SETTINGS_PATH, `${SETTINGS_PATH}.bak-${stamp}`);
  }
  writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n', 'utf8');
}

// 256px PNG wrapped as a single PNG-compressed .ico entry.
function writeIcon(): string {
  const png = readFileSync(join(import.meta.dir, 'assets', 'icon-256.png'));
  const head = Buffer.alloc(22);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(1, 4);
  head.writeUInt8(0, 6); head.writeUInt8(0, 7); head.writeUInt8(0, 8); head.writeUInt8(0, 9);
  head.writeUInt16LE(1, 10); head.writeUInt16LE(32, 12);
  head.writeUInt32LE(png.length, 14); head.writeUInt32LE(22, 18);
  const ico = join(DATA_DIR, 'icon.ico');
  writeFileSync(ico, Buffer.concat([head, png]));
  return ico;
}

function shortcutPaths(): string[] {
  const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
  const desktop = Bun.spawnSync(['powershell', '-NoProfile', '-Command', "[Environment]::GetFolderPath('Desktop')"])
    .stdout.toString().trim() || join(homedir(), 'Desktop');
  return [
    join(desktop, `${APP_NAME}.lnk`),
    join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', `${APP_NAME}.lnk`),
  ];
}

function runPowerShell(script: string): string {
  const r = Bun.spawnSync(['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script]);
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return r.stdout.toString();
}

// WScript.Shell cannot set System.AppUserModel.ID, so write it through the shortcut's property store.
const SET_AUMID_CS = `
using System; using System.Runtime.InteropServices;
public static class LnkAumid {
  [StructLayout(LayoutKind.Sequential, Pack = 4)] struct PROPERTYKEY { public Guid fmtid; public uint pid; }
  [StructLayout(LayoutKind.Explicit)] struct PROPVARIANT { [FieldOffset(0)] public ushort vt; [FieldOffset(8)] public IntPtr p; [FieldOffset(16)] public IntPtr p2; }
  [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IPropertyStore { void GetCount(out uint c); void GetAt(uint i, out PROPERTYKEY k);
    void GetValue(ref PROPERTYKEY k, out PROPVARIANT v); void SetValue(ref PROPERTYKEY k, ref PROPVARIANT v); void Commit(); }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)] static extern int SHGetPropertyStoreFromParsingName(string path, IntPtr pbc, int flags, ref Guid riid, [MarshalAs(UnmanagedType.Interface)] out IPropertyStore s);
  static IPropertyStore Open(string lnk, int flags) {
    Guid iid = new Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"); IPropertyStore s;
    int hr = SHGetPropertyStoreFromParsingName(lnk, IntPtr.Zero, flags, ref iid, out s);
    if (hr != 0) { throw new Exception("open " + lnk + ": 0x" + hr.ToString("X8")); }
    return s;
  }
  static PROPERTYKEY Key() { PROPERTYKEY k = new PROPERTYKEY(); k.fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"); k.pid = 5; return k; }
  static string Get(string lnk) {
    IPropertyStore s = Open(lnk, 0); PROPERTYKEY k = Key(); PROPVARIANT v;
    try { s.GetValue(ref k, out v); return v.vt == 31 ? Marshal.PtrToStringUni(v.p) : ""; } finally { Marshal.ReleaseComObject(s); }
  }
  public static void Set(string lnk, string id) {
    for (int attempt = 0; attempt < 5; attempt++) {
      IPropertyStore s = Open(lnk, 2); PROPERTYKEY k = Key();
      PROPVARIANT v = new PROPVARIANT(); v.vt = 31; v.p = Marshal.StringToCoTaskMemUni(id);
      try { s.SetValue(ref k, ref v); s.Commit(); } finally { Marshal.FreeCoTaskMem(v.p); Marshal.ReleaseComObject(s); }
      if (Get(lnk) == id) { return; }
      System.Threading.Thread.Sleep(500); // Explorer may rewrite a desktop shortcut it is watching
    }
    throw new Exception("could not set AppUserModelID on " + lnk);
  }
}`;

// Our shortcuts plus any taskbar pin of an older install that starts launch.vbs.
function setShortcutAppIds(shortcuts: string[], vbs: string): string[] {
  const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
  const pinned = join(appData, 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'TaskBar');
  const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
  const out = runPowerShell(
    `Add-Type -TypeDefinition @"\n${SET_AUMID_CS}\n"@;` +
    `$id=${q(APP_ID)};$vbs=${q(vbs)};$sh=New-Object -ComObject WScript.Shell;` +
    `$list=@(${shortcuts.map(q).join(',')});` +
    `if(Test-Path ${q(pinned)}){$list+=@(Get-ChildItem ${q(pinned)} -Filter *.lnk | Where-Object { $sh.CreateShortcut($_.FullName).Arguments -like "*$vbs*" } | ForEach-Object FullName)};` +
    `foreach($l in ($list | Select-Object -Unique)){[LnkAumid]::Set($l,$id);$l}`
  );
  return out.split(/\r?\n/).filter(Boolean);
}

// Compiles desktop/host/ObservabilityWindow.cs with the .NET Framework C# compiler that ships with Windows,
// against the WebView2 SDK from nuget.org (pinned version, checked by SHA-256). Throws if it cannot.
async function buildHost(ico: string) {
  const windir = process.env.WINDIR || 'C:\\Windows';
  const csc = ['Framework64', 'Framework'].map(f => join(windir, 'Microsoft.NET', f, 'v4.0.30319', 'csc.exe')).find(p => existsSync(p));
  if (!csc) throw new Error('No .NET Framework C# compiler (csc.exe) found.');

  const { version, sha256 } = WEBVIEW2_SDK;
  const sdk = join(HOST_DIR, `webview2-sdk-${version}`);
  if (!existsSync(join(sdk, 'lib', 'net462', 'Microsoft.Web.WebView2.WinForms.dll'))) {
    const res = await fetch(`https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/${version}/microsoft.web.webview2.${version}.nupkg`);
    if (!res.ok) throw new Error(`WebView2 SDK download failed: HTTP ${res.status}`);
    const pkg = Buffer.from(await res.arrayBuffer());
    if (createHash('sha256').update(pkg).digest('hex') !== sha256) throw new Error('WebView2 SDK download does not match the pinned SHA-256');
    mkdirSync(sdk, { recursive: true });
    const nupkg = join(sdk, 'package.nupkg');
    writeFileSync(nupkg, pkg);
    const tar = Bun.spawnSync(['tar', '-xf', nupkg, '-C', sdk]); // Windows tar reads zip files
    rmSync(nupkg, { force: true });
    if (tar.exitCode !== 0) throw new Error(`could not unpack the WebView2 SDK: ${tar.stderr.toString()}`);
  }

  const lib = join(sdk, 'lib', 'net462');
  const arch = process.arch === 'arm64' ? 'win-arm64' : process.arch === 'ia32' ? 'win-x86' : 'win-x64';
  const r = Bun.spawnSync([csc, '/nologo', '/target:winexe', '/optimize', `/out:${HOST_EXE}`, `/win32icon:${ico}`,
    `/r:${join(lib, 'Microsoft.Web.WebView2.Core.dll')}`, `/r:${join(lib, 'Microsoft.Web.WebView2.WinForms.dll')}`,
    '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll', '/r:System.Web.Extensions.dll',
    join(import.meta.dir, 'host', 'ObservabilityWindow.cs')]);
  if (r.exitCode !== 0) throw new Error(`window build failed:\n${r.stdout.toString()}${r.stderr.toString()}`);
  for (const dll of ['Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll']) copyFileSync(join(lib, dll), join(HOST_DIR, dll));
  copyFileSync(join(sdk, 'runtimes', arch, 'native', 'WebView2Loader.dll'), join(HOST_DIR, 'WebView2Loader.dll'));
}

async function install() {
  const bun = process.execPath;
  const sourceApp = argValue('--source-app', hostname());
  mkdirSync(DATA_DIR, { recursive: true });

  console.log('1/5 Building the dashboard (vite build)...');
  const build = Bun.spawnSync([bun, 'x', 'vite', 'build'], { cwd: CLIENT_DIR, stdout: 'inherit', stderr: 'inherit' });
  if (build.exitCode !== 0) throw new Error('vite build failed (did you run "bun install" in apps/client and apps/server?)');
  // App window has its own profile: start it in the dark theme until the user picks another.
  const index = join(WEB_DIR, 'index.html');
  let html = readFileSync(index, 'utf8');
  html = html.replace(/<link rel="icon"[^>]*>/, '<link rel="icon" type="image/png" href="/favicon.png" />');
  html = html.replace('</head>', '<script>try{if(!localStorage.getItem("theme"))localStorage.setItem("theme","dark")}catch(e){}</script></head>');
  writeFileSync(index, html, 'utf8');
  copyFileSync(join(import.meta.dir, 'assets', 'icon-256.png'), join(WEB_DIR, 'favicon.png'));

  console.log(`2/5 Building the window (WebView2 SDK ${WEBVIEW2_SDK.version} from nuget.org, compiled on this PC)...`);
  mkdirSync(HOST_DIR, { recursive: true });
  const ico = writeIcon();
  try {
    await buildHost(ico);
  } catch (e) {
    // Most often the window is still open (its exe is locked): close it and install again.
    console.warn(`    ${(e as Error).message}\n    The window could not be built; until it is, an Edge app window opens instead.`);
  }

  console.log(`3/5 Adding Claude Code hooks to ${SETTINGS_PATH} (backup kept)...`);
  const settings = readSettings();
  stripObservabilityHooks(settings);
  settings.hooks ??= {};
  const mainTs = join(import.meta.dir, 'main.ts');
  for (const event of HOOK_EVENTS) {
    const group: Record<string, any> = {
      hooks: [{ type: 'command', command: bun, args: [mainTs, '--hook', '--source-app', sourceApp], async: true, timeout: 15 }],
    };
    if (TOOL_EVENTS.has(event)) group.matcher = '';
    (settings.hooks[event] ??= []).push(group);
  }
  writeSettings(settings);

  console.log('4/5 Creating desktop and Start menu shortcuts...');
  // A tiny VBScript starts Bun without a console window.
  const vbs = join(DATA_DIR, 'launch.vbs');
  writeFileSync(vbs, `CreateObject("WScript.Shell").Run """${bun}"" ""${mainTs}""", 0, False\r\n`, 'utf8');
  const shortcuts = shortcutPaths();
  for (const lnk of shortcuts) {
    mkdirSync(dirname(lnk), { recursive: true });
    runPowerShell(
      `$s=(New-Object -ComObject WScript.Shell).CreateShortcut('${lnk.replace(/'/g, "''")}');` +
      `$s.TargetPath='${join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe')}';` +
      `$s.Arguments='"${vbs}"';$s.WorkingDirectory='${DATA_DIR}';$s.IconLocation='${ico},0';` +
      `$s.Description='Claude Code multi-agent observability dashboard';$s.Save()`
    );
  }
  const tagged = setShortcutAppIds(shortcuts, vbs);
  // Explorer keeps the id a pin had when it was pinned, so an older pin stays a separate button.
  if (tagged.length > shortcuts.length) console.log('    Taskbar pin found: unpin it and pin it again, or the window opens as a second button.');

  console.log(`5/5 Done. Data folder: ${DATA_DIR}`);
  console.log(`Open "${APP_NAME}" from the desktop or Start menu. Hook source name: ${sourceApp}`);
  console.log('Events are recorded only while the window is open (minimize it to keep recording).');
}

function uninstall() {
  const settings = readSettings();
  stripObservabilityHooks(settings);
  writeSettings(settings);
  for (const lnk of shortcutPaths()) rmSync(lnk, { force: true });
  rmSync(join(DATA_DIR, 'launch.vbs'), { force: true });
  console.log(`Removed hooks and shortcuts. Data kept in ${DATA_DIR} (delete it to remove history).`);
}

// ---------------------------------------------------------------- entry

// Top-level await: an un-awaited promise does not keep Bun alive while stdin is being read.
if (args.includes('--hook')) {
  await runHook();
} else if (args.includes('--install')) {
  await install();
} else if (args.includes('--uninstall')) {
  uninstall();
} else if (args.length === 0) {
  await runWindow();
} else {
  console.error(`Unknown option: ${args.join(' ')}
Use --install, --uninstall, --hook, or no option to open the window.`);
  process.exit(2);
}
