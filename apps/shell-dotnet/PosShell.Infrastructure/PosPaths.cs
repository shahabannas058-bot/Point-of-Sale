namespace PosShell.Infrastructure;

/// <summary>
/// Where the shop's data lives. A real file under the Windows user profile, NOT in the browser: clearing browser
/// history / cache / site data (including WebView2's own profile, kept in a separate folder below) cannot touch it.
///
/// %LOCALAPPDATA% (not %APPDATA%) on purpose: APPDATA is the *Roaming* profile, which Windows copies to a domain
/// server at logoff and can redirect to a network share. SQLite (WAL + file locking) must live on a local disk.
/// To follow the original request literally, change the one line in <see cref="DataDir"/>.
/// </summary>
public static class PosPaths
{
    /// <summary>
    /// Final folder name. Choose it BEFORE the first real shop installs: renaming later orphans their database.
    /// </summary>
    public const string AppFolderName = "AbuzarClone";

    /// <summary>Tests and portable installs can point the app at another folder.</summary>
    public const string OverrideEnvVar = "POS_DATA_DIR";

    public static string DataDir
    {
        get
        {
            var overrideDir = Environment.GetEnvironmentVariable(OverrideEnvVar);
            if (!string.IsNullOrWhiteSpace(overrideDir)) return Path.GetFullPath(overrideDir);

            var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            if (string.IsNullOrEmpty(local))
                throw new InvalidOperationException("Windows did not report a LocalApplicationData folder.");
            return Path.Combine(local, AppFolderName);
        }
    }

    public static string DatabaseFile => Path.Combine(DataDir, "pos.db");

    public static string BackupDir => Path.Combine(DataDir, "backups");

    /// <summary>Diagnostics (<see cref="FileLog"/>): one file per day, no shop data in it. Safe to delete.</summary>
    public static string LogDir => Path.Combine(DataDir, "logs");

    /// <summary>WebView2 profile (cookies, cache, localStorage). Safe to delete; the shop data is not in here.</summary>
    public static string WebViewDir => Path.Combine(DataDir, "webview");
}
