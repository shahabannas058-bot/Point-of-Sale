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

        try
        {
            _db = DatabaseBootstrap.OpenAndMigrate(); // creates %LOCALAPPDATA%\<AppFolderName>\pos.db on first run
        }
        catch (DatabaseCorruptException ex)
        {
            MessageBox.Show(
                $"Database kharab lag raha hai:\n{ex.Message}\n\nBackups yahan hain:\n{PosPaths.BackupDir}\n\n" +
                "Naya khali database NAHI banaya gaya. Latest backup restore karein.",
                "POS", MessageBoxButton.OK, MessageBoxImage.Error);
            Shutdown(2);
            return;
        }
        catch (Exception ex)
        {
            MessageBox.Show($"POS start nahi ho saka:\n{ex.Message}", "POS", MessageBoxButton.OK, MessageBoxImage.Error);
            Shutdown(1);
            return;
        }

        try { DatabaseBootstrap.RunDailyBackup(_db); }
        catch (Exception ex) { Debug.WriteLine($"Daily backup failed: {ex}"); } // never block the shop because a backup failed

        // Phase 2 replaces these two with the Ed25519 licence guard and the PIN-approval store.
        var sales = new SalesService(_db, new AllowAllLicenceGuard(), new NoApprovals(), new UuidV7Generator());
        new MainWindow(new WebBridge(_db, sales)).Show();
    }

    protected override void OnExit(ExitEventArgs e)
    {
        _db?.Dispose();
        if (_ownsMutex) _singleInstance?.ReleaseMutex();
        _singleInstance?.Dispose();
        base.OnExit(e);
    }
}
