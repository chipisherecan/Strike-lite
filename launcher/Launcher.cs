// Strike Lite launcher: keeps the game up to date from GitHub Releases, runs the local server, and carries the
// official Radmin VPN installer as an embedded resource. Compiled with the C# 5 compiler that ships with Windows
// (see tools/build-release.ps1). The repo name and version come from the generated BuildInfo class.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Reflection;
using System.Security.Cryptography;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

static class Program {
    [STAThread]
    static void Main() {
        ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        using (var mutex = new Mutex(true, "StrikeLiteLauncher")) {
            // a self-update restarts us while the old process is exiting, so wait briefly for the lock
            if (!mutex.WaitOne(4000)) {
                MessageBox.Show("The Strike Lite launcher is already open.", "Strike Lite");
                return;
            }
            Application.Run(new LauncherForm());
        }
    }
}

class LauncherForm : Form {
    const string GameZip = "strike-lite-game.zip";
    const string LauncherExe = "StrikeLiteLauncher.exe";
    const string LauncherVersionFile = "launcher-version.txt";
    const int Port = 3000;

    readonly string root = Path.Combine(Environment.GetEnvironmentVariable("LOCALAPPDATA") ?? ".", "StrikeLite");
    string GameDir { get { return Path.Combine(root, "game"); } }
    string VersionFile { get { return Path.Combine(GameDir, "version.txt"); } }
    string PidFile { get { return Path.Combine(root, "server.pid"); } }

    readonly Label status = new Label();
    readonly ProgressBar bar = new ProgressBar();
    readonly Button playBtn = new Button();
    readonly TextBox joinBox = new TextBox();
    readonly Button joinBtn = new Button();
    readonly Label radminLabel = new Label();
    readonly Button radminBtn = new Button();
    readonly TextBox addrBox = new TextBox();
    readonly Button copyBtn = new Button();
    Process server;

    static readonly Color Bg = Color.FromArgb(21, 23, 27), Panel2 = Color.FromArgb(34, 37, 43),
        Text1 = Color.FromArgb(238, 241, 244), Muted = Color.FromArgb(154, 164, 173), Accent = Color.FromArgb(240, 160, 32);

    public LauncherForm() {
        Text = "Strike Lite";
        ClientSize = new Size(520, 400);
        FormBorderStyle = FormBorderStyle.FixedSingle;
        MaximizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = Bg; ForeColor = Text1;
        Font = new Font("Segoe UI", 10f);
        try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }

        var title = new Label { Text = "STRIKE LITE", Font = new Font("Segoe UI", 24f, FontStyle.Bold), ForeColor = Accent, Location = new Point(20, 14), AutoSize = true };
        status.SetBounds(22, 66, 476, 22); status.ForeColor = Muted; status.Text = "Starting...";
        bar.SetBounds(22, 92, 476, 8);

        Style(playBtn, true); playBtn.SetBounds(22, 112, 476, 46); playBtn.Text = "Play / Host a game"; playBtn.Enabled = false;
        playBtn.Font = new Font("Segoe UI", 13f, FontStyle.Bold);
        playBtn.Click += delegate { StartAndOpen(); };

        var joinLabel = new Label { Text = "Join a friend (their address):", ForeColor = Muted, Location = new Point(22, 170), AutoSize = true };
        joinBox.SetBounds(22, 194, 360, 28); joinBox.BackColor = Panel2; joinBox.ForeColor = Text1; joinBox.BorderStyle = BorderStyle.FixedSingle;
        Style(joinBtn, false); joinBtn.SetBounds(390, 192, 108, 30); joinBtn.Text = "Join";
        joinBtn.Click += delegate { Join(); };

        radminLabel.SetBounds(22, 240, 476, 40); radminLabel.ForeColor = Muted;
        Style(radminBtn, false); radminBtn.SetBounds(22, 284, 476, 32);
        radminBtn.Click += delegate { RadminClick(); };

        var addrLabel = new Label { Text = "Your address for friends:", ForeColor = Muted, Location = new Point(22, 326), AutoSize = true };
        addrBox.SetBounds(22, 350, 360, 28); addrBox.ReadOnly = true; addrBox.BackColor = Panel2; addrBox.ForeColor = Text1; addrBox.BorderStyle = BorderStyle.FixedSingle;
        Style(copyBtn, false); copyBtn.SetBounds(390, 348, 108, 30); copyBtn.Text = "Copy";
        copyBtn.Click += delegate { if (addrBox.Text.Length > 0) Clipboard.SetText(addrBox.Text); };

        Controls.AddRange(new Control[] { title, status, bar, playBtn, joinLabel, joinBox, joinBtn, radminLabel, radminBtn, addrLabel, addrBox, copyBtn });
        AcceptButton = joinBtn;

        var refresh = new System.Windows.Forms.Timer { Interval = 5000 };
        refresh.Tick += delegate { RefreshNetwork(); };
        refresh.Start();
        RefreshNetwork();

        Shown += delegate { Task.Run(() => UpdateAll()); };
        FormClosed += delegate { StopServer(); };
    }

    static void Style(Button b, bool primary) {
        b.FlatStyle = FlatStyle.Flat;
        b.FlatAppearance.BorderColor = primary ? Accent : Color.FromArgb(70, 74, 82);
        b.BackColor = primary ? Accent : Panel2;
        b.ForeColor = primary ? Color.Black : Text1;
        b.UseVisualStyleBackColor = false;
    }

    void Ui(Action a) { if (IsDisposed) return; try { BeginInvoke(a); } catch (InvalidOperationException) { } }
    void SetStatus(string s) { Ui(() => status.Text = s); }
    void SetBar(int pct) { Ui(() => bar.Value = Math.Max(0, Math.Min(100, pct))); }

    // ------------------------------------------------------------------ updates
    string GetString(string url) {
        var c = new WebClient();
        c.Headers[HttpRequestHeader.UserAgent] = "StrikeLiteLauncher";
        c.Encoding = System.Text.Encoding.UTF8;
        return c.DownloadString(url);
    }

    void Download(string url, string dest, string label) {
        var rq = (HttpWebRequest)WebRequest.Create(url);
        rq.UserAgent = "StrikeLiteLauncher";
        using (var rs = rq.GetResponse()) using (var input = rs.GetResponseStream()) using (var output = File.Create(dest)) {
            long total = rs.ContentLength, done = 0;
            var buf = new byte[81920];
            int n, lastPct = -1;
            while ((n = input.Read(buf, 0, buf.Length)) > 0) {
                output.Write(buf, 0, n);
                done += n;
                int pct = total > 0 ? (int)(done * 100 / total) : 0;
                if (pct != lastPct) { lastPct = pct; SetBar(pct); SetStatus(label + "... " + pct + "%"); }
            }
        }
    }

    static string Sha256(string file) {
        using (var s = File.OpenRead(file)) using (var h = SHA256.Create())
            return BitConverter.ToString(h.ComputeHash(s)).Replace("-", "").ToLowerInvariant();
    }

    // Downloads an asset and refuses it unless it matches the <name>.sha256 asset published beside it.
    void DownloadVerified(Dictionary<string, string> assets, string name, string dest, string label) {
        if (!assets.ContainsKey(name) || !assets.ContainsKey(name + ".sha256")) throw new Exception("The release is missing " + name);
        string expected = GetString(assets[name + ".sha256"]).Trim().Split(' ', '\t', '\r', '\n')[0].ToLowerInvariant();
        Download(assets[name], dest, label);
        if (Sha256(dest) != expected) { File.Delete(dest); throw new Exception(name + " failed its checksum, so it was not installed."); }
    }

    void UpdateAll() {
        try {
            Directory.CreateDirectory(root);
            KillOrphanServer();
            try { File.Delete(Application.ExecutablePath + ".old"); } catch { }
            SetStatus("Checking for updates...");
            var json = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(GetString(BuildInfo.ApiBase + "/repos/" + BuildInfo.Repo + "/releases/latest"));
            string tag = (string)json["tag_name"];
            var assets = new Dictionary<string, string>();
            foreach (Dictionary<string, object> a in (System.Collections.ArrayList)json["assets"])
                assets[(string)a["name"]] = (string)a["browser_download_url"];

            // 1. the launcher itself
            int remote;
            if (assets.ContainsKey(LauncherVersionFile) && int.TryParse(GetString(assets[LauncherVersionFile]).Trim(), out remote) && remote > BuildInfo.LauncherVersion) {
                if (SelfUpdate(assets)) return;
            }
            // 2. the game
            string installed = File.Exists(VersionFile) ? File.ReadAllText(VersionFile).Trim() : null;
            if (installed != tag) InstallGame(assets, tag);
            SetBar(100);
            SetStatus("Up to date (" + tag + ").");
        } catch (Exception e) {
            SetBar(0);
            SetStatus(File.Exists(VersionFile)
                ? "Couldn't check for updates. You can still play " + File.ReadAllText(VersionFile).Trim() + "."
                : "Couldn't download the game: " + e.Message);
        }
        Ui(() => playBtn.Enabled = File.Exists(Path.Combine(GameDir, "server.js")));
        AutoInstallRadmin();
    }

    // First run on a PC without Radmin VPN: start the built-in installer once, right after the game is ready.
    // If the player cancels it we don't ask again; the Install button stays available.
    void AutoInstallRadmin() {
        if (RadminExe() != null || File.Exists(RadminMarker)) return;
        try {
            SetStatus("Installing Radmin VPN: accept the prompts in the installer window...");
            var p = StartRadminInstaller();
            if (p == null) return;
            p.WaitForExit();
            SetStatus(RadminExe() != null ? "Radmin VPN installed. You're ready to play." : "Radmin VPN wasn't installed. You can install it later with the button below.");
        } catch (Exception) {
            // includes pressing No on the Windows admin prompt
            SetStatus("Radmin VPN wasn't installed. You can install it later with the button below.");
        }
        Ui(() => RefreshNetwork());
    }

    string RadminMarker { get { return Path.Combine(root, "radmin-offered.txt"); } }
    readonly object radminLock = new object();
    Process radminInstaller;

    // The automatic install and the button share this, so a player can't end up with two installers open.
    // Returns null when one is already running.
    Process StartRadminInstaller() {
        lock (radminLock) {
            if (radminInstaller != null && !radminInstaller.HasExited) return null;
            Directory.CreateDirectory(root);
            File.WriteAllText(RadminMarker, DateTime.Now.ToString("o"));
            // the unmodified official installer, run normally so the user reads and accepts Radmin's own agreement
            radminInstaller = Process.Start(new ProcessStartInfo(ExtractRadmin()) { UseShellExecute = true });
            return radminInstaller;
        }
    }

    string ExtractRadmin() {
        string file = Path.Combine(Path.GetTempPath(), BuildInfo.RadminFile);
        using (var res = Assembly.GetExecutingAssembly().GetManifestResourceStream("radmin.exe"))
        using (var o = File.Create(file)) res.CopyTo(o);
        return file;
    }

    void InstallGame(Dictionary<string, string> assets, string tag) {
        string zip = Path.Combine(root, GameZip), staging = Path.Combine(root, "staging"), old = Path.Combine(root, "game.old");
        DownloadVerified(assets, GameZip, zip, "Downloading " + tag);
        SetStatus("Installing " + tag + "...");
        if (Directory.Exists(staging)) Directory.Delete(staging, true);
        ZipFile.ExtractToDirectory(zip, staging);
        if (!File.Exists(Path.Combine(staging, "server.js")) || !File.Exists(Path.Combine(staging, "node", "node.exe")))
            throw new Exception("The downloaded game is incomplete.");

        // Keep maps the player saved in the editor; if they never edited, take the release's maps.
        string edits = Path.Combine("shared", "mapdata", "edits.js"), shippedName = "edits.shipped.js";
        string newEdits = Path.Combine(staging, edits);
        File.Copy(newEdits, Path.Combine(staging, shippedName), true);
        string oldEdits = Path.Combine(GameDir, edits), oldShipped = Path.Combine(GameDir, shippedName);
        if (File.Exists(oldEdits) && File.Exists(oldShipped) && Sha256(oldEdits) != Sha256(oldShipped)) File.Copy(oldEdits, newEdits, true);

        File.WriteAllText(Path.Combine(staging, "version.txt"), tag);
        // swap in one step, so a failure never leaves a half-installed game
        if (Directory.Exists(old)) Directory.Delete(old, true);
        if (Directory.Exists(GameDir)) Directory.Move(GameDir, old);
        try { Directory.Move(staging, GameDir); }
        catch { if (Directory.Exists(old)) Directory.Move(old, GameDir); throw; }
        try { if (Directory.Exists(old)) Directory.Delete(old, true); File.Delete(zip); } catch { }
    }

    bool SelfUpdate(Dictionary<string, string> assets) {
        string me = Application.ExecutablePath, fresh = me + ".new", old = me + ".old";
        DownloadVerified(assets, LauncherExe, fresh, "Updating the launcher");
        try { File.Delete(old); } catch { }
        File.Move(me, old);                 // Windows allows renaming a running exe
        File.Move(fresh, me);
        Process.Start(new ProcessStartInfo(me) { UseShellExecute = true });
        Ui(() => Close());
        return true;
    }

    // ------------------------------------------------------------------ server
    static bool PortOpen() {
        try { using (var c = new TcpClient()) { return c.ConnectAsync("127.0.0.1", Port).Wait(300) && c.Connected; } }
        catch { return false; }
    }

    // A server left behind by a crashed launcher would lock the game files during an update.
    void KillOrphanServer() {
        try {
            if (!File.Exists(PidFile)) return;
            var p = Process.GetProcessById(int.Parse(File.ReadAllText(PidFile).Trim()));
            if (p.ProcessName.Equals("node", StringComparison.OrdinalIgnoreCase) && p.MainModule.FileName.StartsWith(GameDir, StringComparison.OrdinalIgnoreCase)) { p.Kill(); p.WaitForExit(3000); }
        } catch { }
        try { File.Delete(PidFile); } catch { }
    }

    void StartAndOpen() {
        playBtn.Enabled = false;
        Task.Run(() => {
            try {
                if (!PortOpen()) {
                    SetStatus("Starting the game server...");
                    var si = new ProcessStartInfo(Path.Combine(GameDir, "node", "node.exe"), "server.js") { WorkingDirectory = GameDir, UseShellExecute = false, CreateNoWindow = true };
                    server = Process.Start(si);
                    File.WriteAllText(PidFile, server.Id.ToString());
                    for (int i = 0; i < 40 && !PortOpen(); i++) {
                        if (server.HasExited) throw new Exception("the server stopped right after starting.");
                        Thread.Sleep(250);
                    }
                    if (!PortOpen()) throw new Exception("the server did not start in time.");
                }
                Process.Start("http://localhost:" + Port);
                SetStatus("Game running. Keep this window open while you play; closing it stops the server.");
            } catch (Exception e) { SetStatus("Couldn't start the game: " + e.Message); }
            Ui(() => playBtn.Enabled = true);
        });
    }

    void StopServer() {
        try { if (server != null && !server.HasExited) server.Kill(); File.Delete(PidFile); } catch { }
    }

    void Join() {
        string a = Regex.Replace(joinBox.Text.Trim(), "^https?://", "").TrimEnd('/');
        if (!Regex.IsMatch(a, @"^[A-Za-z0-9.\-]+(:\d{1,5})?$")) { status.Text = "Type the address your friend gave you, like 26.12.34.56:3000"; return; }
        if (!a.Contains(":")) a += ":" + Port;
        Process.Start("http://" + a);
    }

    // ------------------------------------------------------------------ Radmin VPN
    static string RadminExe() {
        foreach (var dir in new[] { Environment.SpecialFolder.ProgramFilesX86, Environment.SpecialFolder.ProgramFiles }) {
            string p = Path.Combine(Environment.GetFolderPath(dir), "Radmin VPN", "RvRvpnGui.exe");
            if (File.Exists(p)) return p;
        }
        return null;
    }

    // Radmin VPN gives every PC a 26.x.x.x address.
    static string RadminIp() {
        foreach (var n in NetworkInterface.GetAllNetworkInterfaces()) {
            if (n.OperationalStatus != OperationalStatus.Up) continue;
            foreach (var u in n.GetIPProperties().UnicastAddresses)
                if (u.Address.AddressFamily == AddressFamily.InterNetwork && u.Address.ToString().StartsWith("26.")) return u.Address.ToString();
        }
        return null;
    }

    static string LanIp() {
        foreach (var n in NetworkInterface.GetAllNetworkInterfaces()) {
            if (n.OperationalStatus != OperationalStatus.Up || n.NetworkInterfaceType == NetworkInterfaceType.Loopback) continue;
            foreach (var u in n.GetIPProperties().UnicastAddresses) {
                string s = u.Address.ToString();
                if (u.Address.AddressFamily == AddressFamily.InterNetwork && (s.StartsWith("192.168.") || s.StartsWith("10."))) return s;
            }
        }
        return null;
    }

    void RefreshNetwork() {
        bool installed = RadminExe() != null;
        string ip = RadminIp(), lan = LanIp();
        radminLabel.Text = !installed ? "Radmin VPN lets friends outside your home join. It is included: click below to install it."
            : ip != null ? "Radmin VPN is on. Create or join a network in Radmin with your friends, then share your address."
            : "Radmin VPN is installed but not connected. Open it and turn it on.";
        radminBtn.Text = installed ? "Open Radmin VPN" : "Install Radmin VPN";
        string addr = ip != null ? ip + ":" + Port : lan != null ? lan + ":" + Port : "";
        if (addrBox.Text != addr) addrBox.Text = addr;
    }

    void RadminClick() {
        string exe = RadminExe();
        try {
            if (exe != null) { Process.Start(exe); return; }
            if (StartRadminInstaller() == null) status.Text = "The Radmin VPN installer is already open.";
        } catch (Exception e) { status.Text = "Couldn't open Radmin VPN: " + e.Message; }
    }
}
