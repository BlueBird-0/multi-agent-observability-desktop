// Windows desktop mode for the observability dashboard, run with Bun (no Python, no compiled exe).
//
//   bun apps/desktop/main.ts                 open the dashboard window (starts the server if needed)
//   bun apps/desktop/main.ts --install       build the client, add Claude Code hooks, create shortcuts
//   bun apps/desktop/main.ts --uninstall     remove the hooks and shortcuts (data is kept)
//   bun apps/desktop/main.ts --hook          hook sender: reads Claude Code hook JSON on stdin
//
// The server runs inside the window process: closing the window stops it, and hooks then fail
// silently (events are not recorded while the window is closed).
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync, openSync, readSync, closeSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { homedir, hostname } from 'node:os';
import { dlopen, FFIType, CFunction, ptr, read, type Pointer } from 'bun:ffi';

const PORT = Number(process.env.SERVER_PORT || 4000);
const URL_ROOT = `http://127.0.0.1:${PORT}`;
const APP_NAME = 'Claude Observability';
const REPO_ROOT = resolve(import.meta.dir, '..', '..');
const CLIENT_DIR = join(REPO_ROOT, 'apps', 'client');
const WEB_DIR = join(CLIENT_DIR, 'dist');
const DATA_DIR = join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'ClaudeObservability');
const PROFILE_DIR = join(DATA_DIR, 'webview-profile');
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

// ---------------------------------------------------------------- keep on top

const WINDOW_PREFS = join(DATA_DIR, 'window.json');

function readPrefs(): { topmost?: boolean } {
  try { return JSON.parse(readFileSync(WINDOW_PREFS, 'utf8')); } catch { return {}; }
}

// Win32 calls for the Edge app window, loaded only when the window process needs them.
let win32: ReturnType<typeof loadWin32> | null = null;
function loadWin32() {
  const user32 = dlopen('user32.dll', {
    FindWindowExW: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
    IsWindowVisible: { args: [FFIType.ptr], returns: FFIType.bool },
    GetWindowLongPtrW: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i64 },
    SetWindowPos: { args: [FFIType.ptr, FFIType.i64, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.u32], returns: FFIType.bool },
  });
  const shell32 = dlopen('shell32.dll', {
    SHGetPropertyStoreForWindow: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  });
  const ole32 = dlopen('ole32.dll', { PropVariantClear: { args: [FFIType.ptr], returns: FFIType.i32 } });
  return { user32: user32.symbols, shell32: shell32.symbols, ole32: ole32.symbols };
}

function guid(text: string): Buffer {
  const h = text.replace(/[{}-]/g, '');
  const b = Buffer.alloc(16);
  b.writeUInt32LE(parseInt(h.slice(0, 8), 16), 0);
  b.writeUInt16LE(parseInt(h.slice(8, 12), 16), 4);
  b.writeUInt16LE(parseInt(h.slice(12, 16), 16), 6);
  Buffer.from(h.slice(16), 'hex').copy(b, 8);
  return b;
}

const IID_PROPERTY_STORE = guid('886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99');
const PKEY_APP_USER_MODEL_ID = Buffer.concat([guid('9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3'), Buffer.from([5, 0, 0, 0])]);
const EDGE_WINDOW_CLASS = Buffer.from('Chrome_WidgetWin_1\0', 'utf16le');

// A window's AppUserModelID through its IPropertyStore (vtable: 2 Release, 5 GetValue).
function windowAppId(hwnd: Pointer): string {
  const { shell32, ole32 } = win32!;
  const out = new BigUint64Array(1);
  if (shell32.SHGetPropertyStoreForWindow(hwnd, ptr(IID_PROPERTY_STORE), ptr(out)) !== 0 || !out[0]) return '';
  const store = Number(out[0]) as Pointer;
  const vtbl = read.ptr(store, 0) as Pointer;
  const getValue = CFunction({ ptr: read.ptr(vtbl, 5 * 8) as Pointer, args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 });
  const release = CFunction({ ptr: read.ptr(vtbl, 2 * 8) as Pointer, args: [FFIType.ptr], returns: FFIType.u32 });
  const pv = Buffer.alloc(24);
  let id = '';
  // Window stores answer S_FALSE (1) with the value filled in, so test for any success code.
  if (getValue(store, ptr(PKEY_APP_USER_MODEL_ID), ptr(pv)) >= 0 && pv.readUInt16LE(0) === 31 /* VT_LPWSTR */) {
    const s = read.ptr(ptr(pv), 8) as Pointer;
    for (let i = 0; i < 256; i++) {
      const c = read.u16(s, i * 2);
      if (c === 0) break;
      id += String.fromCharCode(c);
    }
    ole32.PropVariantClear(ptr(pv));
  }
  release(store);
  getValue.close(); release.close();
  return id;
}

// Visible Edge windows that belong to this dashboard (same id the shortcuts carry).
function dashboardWindows(): Pointer[] {
  const { user32 } = win32!;
  const appId = edgeAppUserModelId();
  const found: Pointer[] = [];
  let h: Pointer | null = null;
  while ((h = user32.FindWindowExW(null, h, ptr(EDGE_WINDOW_CLASS), null))) {
    if (user32.IsWindowVisible(h) && windowAppId(h) === appId) found.push(h);
  }
  return found;
}

// Sets the state on windows that differ; returns how many dashboard windows exist.
function applyTopmost(on: boolean): number {
  const { user32 } = win32!;
  const HWND_TOPMOST = -1, HWND_NOTOPMOST = -2, SWP_NOSIZE = 0x1, SWP_NOMOVE = 0x2, SWP_NOACTIVATE = 0x10;
  const GWL_EXSTYLE = -20, WS_EX_TOPMOST = 0x8n;
  const windows = dashboardWindows();
  for (const h of windows) {
    const isTop = (BigInt(user32.GetWindowLongPtrW(h, GWL_EXSTYLE)) & WS_EX_TOPMOST) !== 0n;
    if (isTop !== on) user32.SetWindowPos(h, on ? HWND_TOPMOST : HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE);
  }
  return windows.length;
}

// Called by the server's /desktop/topmost route (apps/server/src/index.ts).
function exposeWindowControls() {
  win32 ??= loadWin32();
  (globalThis as any).__observabilityDesktop = {
    getTopmost: () => !!readPrefs().topmost,
    setTopmost: (on: boolean) => {
      writeFileSync(WINDOW_PREFS, JSON.stringify({ ...readPrefs(), topmost: on }) + '\n', 'utf8');
      applyTopmost(on);
      return on;
    },
  };
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

  // Another window (or a dev server) already owns the port: just open one more window.
  const ownServer = !(await serverAlreadyUp());
  exposeWindowControls();
  if (ownServer) {
    await import('../server/src/index.ts');
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
  // Keep on top: applied once the window shows up, and again if Edge drops it while activating.
  while (existsSync(lockfile)) {
    if (readPrefs().topmost) applyTopmost(true);
    await sleep(1000);
  }
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

// The taskbar groups a window with a pinned shortcut only when both carry the same AppUserModelID.
// Edge names its --app window the way Chromium's ShellUtil::BuildAppUserModelId does: base id,
// "host_path" of the URL, and "<user-data-dir name>.<profile>" kept to letters, digits and dots,
// each part cut in the middle to fit a 64-character id. Port is not part of it.
function edgeAppUserModelId(): string {
  const url = new URL(`${URL_ROOT}/`);
  const parts = ['MSEdge', `${url.hostname}_${url.pathname}`, `${basename(PROFILE_DIR)}.Default`.replace(/[^A-Za-z0-9.]/g, '')];
  const max = Math.floor((64 - (parts.length - 1)) / parts.length);
  return parts
    .map(p => (p.length > max ? p.slice(0, Math.floor(max / 2)) + p.slice(p.length - Math.ceil(max / 2)) : p))
    .join('.')
    .replace(/ /g, '_');
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
    `$id=${q(edgeAppUserModelId())};$vbs=${q(vbs)};$sh=New-Object -ComObject WScript.Shell;` +
    `$list=@(${shortcuts.map(q).join(',')});` +
    `if(Test-Path ${q(pinned)}){$list+=@(Get-ChildItem ${q(pinned)} -Filter *.lnk | Where-Object { $sh.CreateShortcut($_.FullName).Arguments -like "*$vbs*" } | ForEach-Object FullName)};` +
    `foreach($l in ($list | Select-Object -Unique)){[LnkAumid]::Set($l,$id);$l}`
  );
  return out.split(/\r?\n/).filter(Boolean);
}

function install() {
  const bun = process.execPath;
  const sourceApp = argValue('--source-app', hostname());
  mkdirSync(DATA_DIR, { recursive: true });

  console.log('1/4 Building the dashboard (vite build)...');
  const build = Bun.spawnSync([bun, 'x', 'vite', 'build'], { cwd: CLIENT_DIR, stdout: 'inherit', stderr: 'inherit' });
  if (build.exitCode !== 0) throw new Error('vite build failed (did you run "bun install" in apps/client and apps/server?)');
  // App window has its own profile: start it in the dark theme until the user picks another.
  const index = join(WEB_DIR, 'index.html');
  let html = readFileSync(index, 'utf8');
  html = html.replace(/<link rel="icon"[^>]*>/, '<link rel="icon" type="image/png" href="/favicon.png" />');
  html = html.replace('</head>', '<script>try{if(!localStorage.getItem("theme"))localStorage.setItem("theme","dark")}catch(e){}</script></head>');
  writeFileSync(index, html, 'utf8');
  copyFileSync(join(import.meta.dir, 'assets', 'icon-256.png'), join(WEB_DIR, 'favicon.png'));

  console.log(`2/4 Adding Claude Code hooks to ${SETTINGS_PATH} (backup kept)...`);
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

  console.log('3/4 Creating desktop and Start menu shortcuts...');
  // A tiny VBScript starts Bun without a console window.
  const vbs = join(DATA_DIR, 'launch.vbs');
  writeFileSync(vbs, `CreateObject("WScript.Shell").Run """${bun}"" ""${mainTs}""", 0, False\r\n`, 'utf8');
  const ico = writeIcon();
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

  console.log(`4/4 Done. Data folder: ${DATA_DIR}`);
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
  install();
} else if (args.includes('--uninstall')) {
  uninstall();
} else if (args.length === 0) {
  await runWindow();
} else {
  console.error(`Unknown option: ${args.join(' ')}
Use --install, --uninstall, --hook, or no option to open the window.`);
  process.exit(2);
}
