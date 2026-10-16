using System.Globalization;

namespace PosShell.Infrastructure;

public sealed class DatabaseCorruptException(string message) : Exception(message);

/// <summary>Startup sequence for the shop database: create/open -> integrity check -> migrate -> daily backup.</summary>
public static class DatabaseBootstrap
{
    /// <summary>
    /// Opens (creating on first run) the database, verifies it is not damaged, and brings the schema up to date.
    /// A damaged file throws <see cref="DatabaseCorruptException"/>: the app must offer "restore latest backup",
    /// never silently start with an empty database.
    /// </summary>
    public static SqliteDatabase OpenAndMigrate(string? filePath = null)
    {
        var db = new SqliteDatabase(filePath ?? PosPaths.DatabaseFile);
        try
        {
            var check = db.QuickCheck();
            if (!string.Equals(check, "ok", StringComparison.OrdinalIgnoreCase))
                throw new DatabaseCorruptException($"SQLite integrity check failed: {check}");
            Migrator.Apply(db);
            return db;
        }
        catch
        {
            db.Dispose();
            throw;
        }
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

        foreach (var old in Directory.GetFiles(dir, "pos-*.db").OrderByDescending(f => f, StringComparer.Ordinal).Skip(keep))
            File.Delete(old);
        return created;
    }
}
