// Window for the observability dashboard: the page in WebView2, in a resizable window without a title bar.
// The page's header acts as the title bar (CSS app-region: drag) and sends window commands with
// chrome.webview.postMessage; see apps/client/src/App.vue. Built at install time by apps/desktop/main.ts
// with the C# 5 compiler that ships with .NET Framework, so keep to C# 5 syntax.
//
//   ObservabilityWindow.exe --url URL --data DIR --prefs FILE --icon ICO --app-id ID
//
// Exit code 3: WebView2 Runtime is not installed (the launcher then falls back to an Edge app window).
using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

static class Program
{
    public const string Title = "Multi-Agent Observability";

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)] static extern int SetCurrentProcessExplicitAppUserModelID(string id);
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindowW(string cls, string title);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);

    [STAThread]
    static int Main(string[] argv)
    {
        var args = new Dictionary<string, string>();
        for (int i = 0; i + 1 < argv.Length; i += 2) { args[argv[i]] = argv[i + 1]; }

        // One window: a second launch brings the open one forward.
        bool first;
        var mutex = new Mutex(true, "MultiAgentObservability.Window", out first);
        if (!first)
        {
            IntPtr h = FindWindowW(null, Title);
            if (h != IntPtr.Zero)
            {
                if (IsIconic(h)) { ShowWindow(h, 9 /* SW_RESTORE */); }
                SetForegroundWindow(h);
            }
            return 0;
        }

        try { CoreWebView2Environment.GetAvailableBrowserVersionString(); }
        catch (WebView2RuntimeNotFoundException) { return 3; }

        SetProcessDpiAwarenessContext(new IntPtr(-4)); // per-monitor v2: sharp text at any scaling
        SetCurrentProcessExplicitAppUserModelID(args["--app-id"]); // groups with the pinned shortcut
        Application.EnableVisualStyles();
        Application.Run(new MainForm(args["--url"], args["--data"], args["--prefs"], args["--icon"]));
        GC.KeepAlive(mutex);
        return 0;
    }
}

class MainForm : Form
{
    const int WM_NCCALCSIZE = 0x83, WM_SYSCOMMAND = 0x112, SC_KEEP_ON_TOP = 0x1F10;
    const uint MF_STRING = 0, MF_SEPARATOR = 0x800, MF_CHECKED = 0x8, MF_BYCOMMAND = 0;

    [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] struct NCCALCSIZE_PARAMS { public RECT Rect0, Rect1, Rect2; public IntPtr Pos; }
    [DllImport("user32.dll")] static extern IntPtr GetSystemMenu(IntPtr h, bool revert);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool AppendMenuW(IntPtr menu, uint flags, UIntPtr id, string text);
    [DllImport("user32.dll")] static extern uint CheckMenuItem(IntPtr menu, uint id, uint flags);
    [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr h);
    [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr h);
    [DllImport("user32.dll")] static extern int GetSystemMetricsForDpi(int index, uint dpi);

    readonly WebView2 web = new WebView2();
    readonly string url, prefsPath;
    Dictionary<string, object> prefs;
    bool lastMaximized;
    Rectangle normalBounds;
    FormWindowState lastState = FormWindowState.Normal;
    bool restoring;

    public MainForm(string url, string dataDir, string prefsPath, string iconPath)
    {
        this.url = url;
        this.prefsPath = prefsPath;
        prefs = LoadPrefs();

        Text = Program.Title;
        if (File.Exists(iconPath)) { Icon = new Icon(iconPath); }
        BackColor = Color.FromArgb(15, 23, 42); // dark page background: no white flash while loading
        StartPosition = FormStartPosition.Manual;
        Bounds = SavedBounds();
        TopMost = PrefBool("topmost");

        web.Dock = DockStyle.Fill;
        web.DefaultBackgroundColor = BackColor;
        web.CreationProperties = new CoreWebView2CreationProperties { UserDataFolder = Path.Combine(dataDir, "webview2") };
        Controls.Add(web);

        Load += async delegate
        {
            if (PrefBool("maximized")) { WindowState = FormWindowState.Maximized; }
            await web.EnsureCoreWebView2Async(null);
            var settings = web.CoreWebView2.Settings;
            try { settings.IsNonClientRegionSupportEnabled = true; } catch (Exception) { } // header drags the window
            settings.IsStatusBarEnabled = false;
            web.CoreWebView2.WebMessageReceived += OnWebMessage;
            web.CoreWebView2.Navigate(url);
        };
        Move += delegate { TrackNormalBounds(); };
        Resize += delegate
        {
            TrackNormalBounds();
            bool maximized = WindowState == FormWindowState.Maximized;
            if (maximized != lastMaximized) { lastMaximized = maximized; SendState(); }
        };
        FormClosing += delegate { SavePrefs(); };
    }

    // ---- page <-> window

    void OnWebMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        string msg;
        try { msg = e.TryGetWebMessageAsString(); } catch (ArgumentException) { return; }
        switch (msg)
        {
            case "ready": SendState(); break;
            case "minimize": WindowState = FormWindowState.Minimized; break;
            case "maximize": WindowState = WindowState == FormWindowState.Maximized ? FormWindowState.Normal : FormWindowState.Maximized; break;
            case "close": Close(); break;
            case "topmost:on": SetKeepOnTop(true); break;
            case "topmost:off": SetKeepOnTop(false); break;
        }
    }

    void SendState()
    {
        if (web.CoreWebView2 == null) { return; }
        web.CoreWebView2.PostWebMessageAsJson(string.Format("{{\"topmost\":{0},\"maximized\":{1}}}",
            TopMost ? "true" : "false", WindowState == FormWindowState.Maximized ? "true" : "false"));
    }

    void SetKeepOnTop(bool on)
    {
        TopMost = on;
        CheckMenuItem(GetSystemMenu(Handle, false), SC_KEEP_ON_TOP, MF_BYCOMMAND | (on ? MF_CHECKED : 0));
        SavePrefs();
        SendState();
    }

    // WinForms sizes a restored window from a client size it computes as if there were a title bar, so each
    // maximize/minimize-restore would grow the window by that much: put back the size it had before.
    void TrackNormalBounds()
    {
        if (restoring) { return; }
        if (WindowState == FormWindowState.Normal && lastState != FormWindowState.Normal && !normalBounds.IsEmpty)
        {
            restoring = true;
            BeginInvoke((Action)delegate { Bounds = normalBounds; restoring = false; });
        }
        else if (WindowState == FormWindowState.Normal)
        {
            normalBounds = Bounds;
        }
        lastState = WindowState;
    }

    // ---- frame: keep the resize borders and shadow, drop the title bar

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        IntPtr menu = GetSystemMenu(Handle, false); // right-click on the header shows this menu
        AppendMenuW(menu, MF_SEPARATOR, UIntPtr.Zero, null);
        AppendMenuW(menu, MF_STRING | (TopMost ? MF_CHECKED : 0), new UIntPtr(SC_KEEP_ON_TOP), "Keep on top");
    }

    // Resize border thickness at this window's DPI.
    Size FrameSize()
    {
        uint dpi = IsHandleCreated ? GetDpiForWindow(Handle) : 96;
        int pad = GetSystemMetricsForDpi(92 /* SM_CXPADDEDBORDER */, dpi);
        return new Size(GetSystemMetricsForDpi(32 /* SM_CXSIZEFRAME */, dpi) + pad, GetSystemMetricsForDpi(33 /* SM_CYSIZEFRAME */, dpi) + pad);
    }

    protected override void WndProc(ref Message m)
    {
        if (m.Msg == WM_NCCALCSIZE && m.WParam != IntPtr.Zero)
        {
            // Client area = whole window minus the side and bottom resize borders; the top border goes too,
            // except when maximized, where the frame hangs off screen by that much.
            var p = (NCCALCSIZE_PARAMS)Marshal.PtrToStructure(m.LParam, typeof(NCCALCSIZE_PARAMS));
            Size f = FrameSize();
            int fx = f.Width, fy = f.Height;
            p.Rect0.Left += fx;
            p.Rect0.Right -= fx;
            p.Rect0.Bottom -= fy;
            if (IsZoomed(Handle)) { p.Rect0.Top += fy; }
            Marshal.StructureToPtr(p, m.LParam, false);
            m.Result = IntPtr.Zero;
            return;
        }
        if (m.Msg == WM_SYSCOMMAND && (m.WParam.ToInt64() & 0xFFF0) == SC_KEEP_ON_TOP)
        {
            SetKeepOnTop(!TopMost);
            return;
        }
        base.WndProc(ref m);
    }

    // ---- window.json: keep on top, size and place

    Dictionary<string, object> LoadPrefs()
    {
        try { return new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(prefsPath)) ?? new Dictionary<string, object>(); }
        catch (Exception) { return new Dictionary<string, object>(); }
    }

    bool PrefBool(string key) { object v; return prefs.TryGetValue(key, out v) && v is bool && (bool)v; }
    int PrefInt(string key, int fallback) { object v; return prefs.TryGetValue(key, out v) && v is int ? (int)v : fallback; }

    Rectangle SavedBounds()
    {
        var area = Screen.PrimaryScreen.WorkingArea;
        int w = Math.Min(PrefInt("width", 1280), area.Width), h = Math.Min(PrefInt("height", 860), area.Height);
        var r = new Rectangle(PrefInt("x", area.Left + (area.Width - w) / 2), PrefInt("y", area.Top + (area.Height - h) / 2), w, h);
        foreach (var s in Screen.AllScreens) { if (s.WorkingArea.IntersectsWith(r)) { return r; } }
        return new Rectangle(area.Left + (area.Width - w) / 2, area.Top + (area.Height - h) / 2, w, h);
    }

    void SavePrefs()
    {
        var b = normalBounds.IsEmpty ? Bounds : normalBounds;
        prefs["topmost"] = TopMost;
        prefs["maximized"] = WindowState == FormWindowState.Maximized;
        prefs["x"] = b.X; prefs["y"] = b.Y; prefs["width"] = b.Width; prefs["height"] = b.Height;
        try { File.WriteAllText(prefsPath, new JavaScriptSerializer().Serialize(prefs)); } catch (Exception) { }
    }
}
