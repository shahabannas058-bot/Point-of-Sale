using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace PosShell.Infrastructure;

public sealed class MigrationException(string message, Exception? inner = null) : Exception(message, inner);

/// <summary>
/// C# twin of packages/db/src/migrate.ts. It applies the SAME SQL files (embedded from packages/db/migrations), keeps
/// the same schema_migrations table and the same checksum, so a database created by either side can be opened by
/// the other. On a brand-new pos.db it builds every table, view, trigger and index; on an existing one it only
/// applies what is missing, each migration in its own transaction.
/// </summary>
public static class Migrator
{
    public sealed record Migration(int Version, string Name, string Sql);

    private static readonly Regex FileName = new(@"^Migrations/(\d{4})_([a-z0-9_]+)\.sql\z", RegexOptions.CultureInvariant);

    // The runner owns the transaction: a migration file may not carry its own (same rule as TS).
    private static readonly Regex Forbidden = new(
        @"^\s*(PRAGMA\b|COMMIT\b|ROLLBACK\b|BEGIN\s+(TRANSACTION|IMMEDIATE|DEFERRED|EXCLUSIVE)\b|BEGIN\s*;)",
        RegexOptions.IgnoreCase | RegexOptions.Multiline | RegexOptions.CultureInvariant);

    /// <summary>SHA-256 (lowercase hex) of the UTF-8 SQL after CRLF -> LF. Identical to checksum() in migrate.ts.</summary>
    public static string Checksum(string sql) =>
        Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(NormalizeEol(sql))));

    private static string NormalizeEol(string s) => s.Replace("\r\n", "\n", StringComparison.Ordinal);

    public static IReadOnlyList<Migration> LoadEmbedded(Assembly? assembly = null)
    {
        var asm = assembly ?? typeof(Migrator).Assembly;
        var list = new List<Migration>();
        foreach (var resource in asm.GetManifestResourceNames())
        {
            var m = FileName.Match(resource);
            if (!m.Success) continue;
            using var stream = asm.GetManifestResourceStream(resource)!;
            using var reader = new StreamReader(stream, new UTF8Encoding(false), detectEncodingFromByteOrderMarks: false);
            var sql = NormalizeEol(reader.ReadToEnd());
            if (Forbidden.IsMatch(sql))
                throw new MigrationException(
                    $"{resource}: PRAGMA/BEGIN/COMMIT/ROLLBACK are not allowed; the runner owns the transaction");
            list.Add(new Migration(int.Parse(m.Groups[1].Value), m.Groups[2].Value, sql));
        }
        list.Sort((a, b) => a.Version.CompareTo(b.Version));
        for (var i = 0; i < list.Count; i++)
            if (list[i].Version != i + 1)
                throw new MigrationException(
                    $"Migration versions must be contiguous from 0001; found {list[i].Version} at position {i + 1}");
        return list;
    }

    /// <summary>Applies pending migrations. Returns the versions applied now (empty when already up to date).</summary>
    public static IReadOnlyList<int> Apply(SqliteDatabase db, IReadOnlyList<Migration>? migrations = null)
    {
        migrations ??= LoadEmbedded();

        db.Exec("""
            CREATE TABLE IF NOT EXISTS schema_migrations (
              version    INTEGER PRIMARY KEY,
              name       TEXT    NOT NULL,
              checksum   TEXT    NOT NULL,
              applied_at INTEGER NOT NULL
            ) STRICT;
            """);

        var applied = db.Query("SELECT version, name, checksum FROM schema_migrations ORDER BY version");
        for (var i = 0; i < applied.Count; i++)
        {
            var row = applied[i];
            var version = (int)row.Lng("version");
            if (i >= migrations.Count || migrations[i].Version != version)
                throw new MigrationException(
                    $"Database has migration {version} ({row.Str("name")}) unknown to this app: database is newer than the app");
            if (Checksum(migrations[i].Sql) != row.Str("checksum"))
                throw new MigrationException($"Migration {version} ({row.Str("name")}) was modified after it was applied");
        }

        var done = new List<int>();
        foreach (var m in migrations.Skip(applied.Count))
        {
            var script =
                $"BEGIN IMMEDIATE;\n{m.Sql}\n" +
                $"INSERT INTO schema_migrations (version, name, checksum, applied_at) " +
                $"VALUES ({m.Version}, '{m.Name}', '{Checksum(m.Sql)}', {DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()});\n" +
                "COMMIT;";
            try
            {
                db.Exec(script);
            }
            catch (Exception e)
            {
                try { db.Exec("ROLLBACK"); }
                catch (Exception) { /* nothing to roll back */ }
                throw new MigrationException($"Migration {m.Version} ({m.Name}) failed: {e.Message}", e);
            }
            done.Add(m.Version);
        }
        return done;
    }
}
