using System.Diagnostics;
using System.Windows;
using PosShell.Core;
using PosShell.Infrastructure;

namespace PosShell.Desktop;

public partial class App : Application
{
    private Mutex? _singleInstance;
    private bool _ownsMutex;
    private SqliteDatabase? _db;
    private FileLog? _log;

    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);

        // One copy per Windows session: two instances on one SQLite file would fight over the sale chain.
        _singleInstance = new Mutex(initiallyOwned: true, @"Local\PosShell.Desktop.SingleInstance", out _ownsMutex);
        if (!_ownsMutex)
        {
            MessageBox.Show("POS pehle se chal raha hai.", "POS", MessageBoxButton.OK, MessageBoxImage.Information);
            Shutdown();
            return;
        }

        _log = FileLog.TryCreateDefault(); // %LOCALAPPDATA%\<AppFolderName>\logs; null only if even the data folder is unusable
        try
        {
            _db = DatabaseBootstrap.OpenAndMigrate(); // creates %LOCALAPPDATA%\<AppFolderName>\pos.db on first run
        }
        catch (DatabaseCorruptException ex)
        {
            _log?.Error("startup", ex);
            MessageBox.Show(
                $"Database kharab lag raha hai:\n{ex.Message}\n\nBackups yahan hain:\n{PosPaths.BackupDir}\n\n" +
                "Naya khali database NAHI banaya gaya. Latest backup restore karein.",
                "POS", MessageBoxButton.OK, MessageBoxImage.Error);
            Shutdown(2);
            return;
        }
        catch (Exception ex)
        {
            _log?.Error("startup", ex);
            MessageBox.Show($"POS start nahi ho saka:\n{ex.Message}", "POS", MessageBoxButton.OK, MessageBoxImage.Error);
            Shutdown(1);
            return;
        }

        try { DatabaseBootstrap.RunDailyBackup(_db); }
        catch (Exception ex) // never block the shop because a backup failed
        {
            _log?.Error("backup", ex);
            Debug.WriteLine($"Daily backup failed: {ex}");
        }

        // Phase 2b replaces the guard with the Ed25519 licence module (and NoApprovals with the PIN-approval store).
        // ONE guard instance: SalesService asks it before a sale, WebBridge asks it before every db.batch from the page.
        var licence = new AllowAllLicenceGuard();
        var sales = new SalesService(_db, licence, new NoApprovals(), new UuidV7Generator());
        new MainWindow(new WebBridge(_db, sales, licence, _log)).Show();
    }

    protected override void OnExit(ExitEventArgs e)
    {
        _db?.Dispose();
        if (_ownsMutex) _singleInstance?.ReleaseMutex();
        _singleInstance?.Dispose();
        base.OnExit(e);
    }
}
