using System.Globalization;
using System.Text.RegularExpressions;

namespace PosShell.Infrastructure;

public sealed class DatabaseCorruptException(string message) : Exception(message);

/// <summary>The copy taken before an upgrade could not be written (disk full, no access); the database was not touched.</summary>
public sealed class PreUpgradeBackupException(string message, Exception inner) : Exception(message, inner);

/// <summary>Startup sequence for the shop database: create/open -> integrity check -> migrate -> daily backup.</summary>
public static class DatabaseBootstrap
{
    /// <summary>
    /// Opens (creating on first run) the database, verifies it is not damaged, and brings the schema up to date.
    /// A damaged file throws <see cref="DatabaseCorruptException"/>: the app must offer "restore latest backup",
    /// never silently start with an empty database.
    /// Before an existing database is upgraded, a copy is written to the backup folder (premigrate-vNNNN-....db), so a
    /// migration that goes wrong never leaves the shop without its data as it was.
    /// </summary>
    public static SqliteDatabase OpenAndMigrate(string? filePath = null, string? backupDir = null, DateTime? now = null)
    {
        var db = new SqliteDatabase(filePath ?? PosPaths.DatabaseFile);
        try
        {
            var check = db.QuickCheck();
            if (!string.Equals(check, "ok", StringComparison.OrdinalIgnoreCase))
                throw new DatabaseCorruptException($"SQLite integrity check failed: {check}");
            Migrator.Apply(db, beforeUpgrade: version =>
            {
                try { BackupBeforeUpgrade(db, backupDir, version, now); }
                catch (Exception e) when (e is IOException or UnauthorizedAccessException)
                {
                    throw new PreUpgradeBackupException($"Backup before migration {version} failed: {e.Message}", e);
                }
            });
            return db;
        }
        catch
        {
            db.Dispose();
            throw;
        }
    }

    private static readonly Regex DailyName = new(@"^pos-\d{4}-\d{2}-\d{2}\.db\z", RegexOptions.CultureInvariant);

    private static readonly Regex PremigrateName = new(@"^premigrate-v\d{4}-\d{8}-\d{6}\.db\z", RegexOptions.CultureInvariant);

    /// <summary>How many pre-upgrade copies to keep (each is a full database).</summary>
    public const int KeepPremigrate = 5;

    /// <summary>premigrate-v0009-20261122-101500.db, kept apart from the daily rotation; the newest few are kept.</summary>
    public static string BackupBeforeUpgrade(SqliteDatabase db, string? backupDir, int version, DateTime? now = null)
    {
        var dir = backupDir ?? PosPaths.BackupDir;
        Directory.CreateDirectory(dir);
        var stamp = (now ?? DateTime.Now).ToString("yyyyMMdd-HHmmss", CultureInfo.InvariantCulture);
        var target = Path.Combine(dir, FormattableString.Invariant($"premigrate-v{version:D4}-{stamp}.db"));
        var temp = target + ".partial";
        db.BackupTo(temp);
        File.Move(temp, target, overwrite: true);

        var older = Directory.GetFiles(dir, "premigrate-v*.db")
            .Where(f => PremigrateName.IsMatch(Path.GetFileName(f)) && !string.Equals(f, target, StringComparison.Ordinal))
            .OrderByDescending(f => Path.GetFileName(f), StringComparer.Ordinal);
        foreach (var old in older.Skip(KeepPremigrate - 1))
            File.Delete(old);
        return target;
    }

    /// <summary>
    /// Writes pos-yyyy-MM-dd.db once per day and keeps the newest <paramref name="keep"/> files. Returns the new file,
    /// or null if today's backup already exists. A second copy on another drive / USB is still up to the owner.
    /// </summary>
    public static string? RunDailyBackup(SqliteDatabase db, string? backupDir = null, int keep = 14, DateTime? today = null)
    {
        var dir = backupDir ?? PosPaths.BackupDir;
        Directory.CreateDirectory(dir);
        var day = (today ?? DateTime.Now).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
        var target = Path.Combine(dir, $"pos-{day}.db");

        string? created = null;
        if (!File.Exists(target))
        {
            var temp = target + ".partial";
            db.BackupTo(temp);
            File.Move(temp, target); // a half-written backup never looks like a good one
            created = target;
        }

        // Keep the newest daily files by name, but never the one just written: after the PC clock jumps back, today's
        // file sorts as the oldest and would otherwise be deleted the moment it was made (QA S1).
        var older = Directory.GetFiles(dir, "pos-*.db")
            .Where(f => DailyName.IsMatch(Path.GetFileName(f)) && !string.Equals(f, created, StringComparison.Ordinal))
            .OrderByDescending(f => Path.GetFileName(f), StringComparer.Ordinal);
        foreach (var old in older.Skip(created is null ? keep : Math.Max(keep - 1, 0)))
            File.Delete(old);
        return created;
    }
}
