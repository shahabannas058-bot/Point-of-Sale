using System.Diagnostics;
using System.Windows;
using System.Windows.Threading;
using PosShell.Core;
using PosShell.Infrastructure;

namespace PosShell.Desktop;

public partial class App : Application
{
    private Mutex? _singleInstance;
    private bool _ownsMutex;
    private SqliteDatabase? _db;
    private FileLog? _log;
    private DispatcherTimer? _backupTimer;

    /// <summary>The shop PC often runs for days without a restart: check for today's backup this often.</summary>
    private static readonly TimeSpan BackupCheckEvery = TimeSpan.FromHours(1);

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
        catch (MigrationException ex) when (ex.Message.Contains("grocery upgrade refused", StringComparison.Ordinal))
        {
            // migration 0009 found mobile-shop data (phones, repairs) and rolled back: pos.db is still on 0008
            _log?.Error("startup", ex);
            MessageBox.Show(
                "Yeh database purane mobile-shop version ka hai (phones / repairs ka data). " +
                "Is liye grocery version ise nahi khol sakta. Data ko haath nahi lagaya gaya, sab mehfooz hai.\n" +
                "This database is from the old mobile-shop version, so the grocery version cannot open it. " +
                "Nothing was changed or deleted.\n\n" +
                $"Database: {PosPaths.DatabaseFile}\nBackups: {PosPaths.BackupDir}\n\n" +
                "Support se rabta karein. / Please contact support.",
                "POS", MessageBoxButton.OK, MessageBoxImage.Warning);
            Shutdown(1);
            return;
        }
        catch (Exception ex)
        {
            _log?.Error("startup", ex);
            MessageBox.Show($"POS start nahi ho saka:\n{ex.Message}", "POS", MessageBoxButton.OK, MessageBoxImage.Error);
            Shutdown(1);
            return;
        }

        RunBackup();
        // A backup only at startup misses every day the PC is left on (QA S2); the file is still written once per day.
        _backupTimer = new DispatcherTimer { Interval = BackupCheckEvery };
        _backupTimer.Tick += async (_, _) => await Task.Run(RunBackup);
        _backupTimer.Start();

        // Phase 2b replaces the guard with the Ed25519 licence module. WebBridge asks it before every db.batch from the page.
        var licence = new AllowAllLicenceGuard();
        new MainWindow(new WebBridge(_db, licence, _log)).Show();
    }

    private void RunBackup()
    {
        var db = _db; // OnExit clears it first, so a late timer tick does nothing
        if (db is null) return;
        try { DatabaseBootstrap.RunDailyBackup(db); }
        catch (Exception ex) // never block the shop because a backup failed
        {
            _log?.Error("backup", ex);
            Debug.WriteLine($"Daily backup failed: {ex}");
        }
    }

    protected override void OnExit(ExitEventArgs e)
    {
        _backupTimer?.Stop();
        var db = _db;
        _db = null;
        db?.Dispose(); // waits for a running backup: both take the database lock
        if (_ownsMutex) _singleInstance?.ReleaseMutex();
        _singleInstance?.Dispose();
        base.OnExit(e);
    }
}
