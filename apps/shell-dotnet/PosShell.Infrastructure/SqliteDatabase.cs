using System.Text;
using Microsoft.Data.Sqlite;
using PosShell.Core;

namespace PosShell.Infrastructure;

/// <summary>
/// The native SQLite file. ONE writer connection, every call serialised by a re-entrant lock (the same model as the Node
/// driver and the TS mutex), so a sale's "read head -> seal -> write" can never interleave with another writer.
///
/// A second connection on the same file is opened with Mode=ReadOnly + PRAGMA query_only and serves ONLY
/// <see cref="QueryReadOnly"/> (the page's db.query): SQLite itself refuses every INSERT/UPDATE/DELETE/DDL on it, so
/// the bridge needs no SQL parsing or allow-list to keep db.query read-only. WAL makes a commit on the writer visible to
/// the reader's next statement; the -wal/-shm files are writable by this process, which is all a WAL reader needs.
///
/// Durability settings for a shop with power cuts: WAL journal + synchronous=FULL (a committed sale survives power loss),
/// foreign keys and recursive triggers ON (the immutability / chain triggers depend on them), busy_timeout 5 s.
/// </summary>
public sealed class SqliteDatabase : IPosDb, IDisposable
{
    /// <summary>SQLITE_READONLY: the statement tried to write through the read-only connection.</summary>
    private const int SqliteReadOnly = 8;

    private readonly SqliteConnection _conn;
    private readonly SqliteConnection _read;
    private readonly object _gate = new();

    public string FilePath { get; }

    public SqliteDatabase(string filePath)
    {
        FilePath = filePath;
        var dir = Path.GetDirectoryName(filePath);
        if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);

        var connectionString = new SqliteConnectionStringBuilder
        {
            DataSource = filePath,
            Mode = SqliteOpenMode.ReadWriteCreate, // creates pos.db on first run
            Cache = SqliteCacheMode.Private,
            Pooling = false,
            ForeignKeys = true,
        }.ToString();
        _conn = new SqliteConnection(connectionString);
        try
        {
            _conn.Open();
            Exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; " +
                 "PRAGMA recursive_triggers = ON; PRAGMA busy_timeout = 5000;");
            _read = OpenReadOnly(filePath); // after the writer: the file exists and is already in WAL mode
        }
        catch
        {
            _conn.Dispose(); // e.g. "file is not a database": do not keep the file locked
            throw;
        }
    }

    private static SqliteConnection OpenReadOnly(string filePath)
    {
        var conn = new SqliteConnection(new SqliteConnectionStringBuilder
        {
            DataSource = filePath,
            Mode = SqliteOpenMode.ReadOnly,
            Cache = SqliteCacheMode.Private,
            Pooling = false,
        }.ToString());
        try
        {
            conn.Open();
            using var cmd = conn.CreateCommand();
            cmd.CommandText = "PRAGMA query_only = ON; PRAGMA busy_timeout = 5000;"; // belt and braces on top of Mode=ReadOnly
            cmd.ExecuteNonQuery();
            return conn;
        }
        catch
        {
            conn.Dispose();
            throw;
        }
    }

    /// <summary>
    /// Runs a multi-statement script (migrations, pragmas). Throws the raw <see cref="SqliteException"/>: callers here
    /// need the real text. Query/Batch, which carry user data, translate errors instead.
    /// </summary>
    public void Exec(string script)
    {
        lock (_gate)
        {
            using var cmd = _conn.CreateCommand();
            cmd.CommandText = script;
            cmd.ExecuteNonQuery();
        }
    }

    public IReadOnlyList<Row> Query(string sql, params object?[] args) => Run(_conn, sql, args);

    /// <summary>
    /// <see cref="Query"/> over the read-only connection, for SQL that comes from the page (db.query). A statement that
    /// tries to write fails inside SQLite (SQLITE_READONLY) and is reported as FORBIDDEN; nothing reaches the file.
    /// </summary>
    public IReadOnlyList<Row> QueryReadOnly(string sql, params object?[] args) => Run(_read, sql, args);

    private IReadOnlyList<Row> Run(SqliteConnection conn, string sql, object?[] args)
    {
        lock (_gate)
        {
            try
            {
                using var cmd = Build(conn, sql, args);
                using var reader = cmd.ExecuteReader();
                var names = Enumerable.Range(0, reader.FieldCount).Select(reader.GetName).ToArray();
                var rows = new List<Row>();
                while (reader.Read())
                {
                    var values = new Dictionary<string, object?>(names.Length, StringComparer.Ordinal);
                    for (var i = 0; i < names.Length; i++) values[names[i]] = reader.IsDBNull(i) ? null : reader.GetValue(i);
                    rows.Add(new Row(values));
                }
                return rows;
            }
            catch (SqliteException e) when (e.SqliteErrorCode == SqliteReadOnly)
            {
                throw new ServiceException("FORBIDDEN", "This query may only read",
                    new Dictionary<string, object?> { ["reason"] = "read_only" }, e);
            }
            catch (SqliteException e)
            {
                throw ErrorMap.FromDatabaseMessage(e.Message, e);
            }
        }
    }

    public void Batch(IReadOnlyList<SqlStatement> statements)
    {
        lock (_gate)
        {
            try
            {
                Exec("BEGIN IMMEDIATE");
                foreach (var s in statements)
                {
                    using var cmd = Build(_conn, s.Sql, s.Params);
                    cmd.ExecuteNonQuery();
                }
                Exec("COMMIT");
            }
            catch (SqliteException e)
            {
                TryRollback();
                throw ErrorMap.FromDatabaseMessage(e.Message, e);
            }
            catch
            {
                TryRollback();
                throw;
            }
        }
    }

    public T Exclusive<T>(Func<T> work)
    {
        lock (_gate) return work();
    }

    /// <summary>PRAGMA quick_check: "ok" or a description of the damage.</summary>
    public string QuickCheck() => Query("PRAGMA quick_check")[0].Str("quick_check");

    /// <summary>Consistent online snapshot (SQLite backup API); safe while the app is running, WAL included.</summary>
    public void BackupTo(string destinationFile)
    {
        var dir = Path.GetDirectoryName(destinationFile);
        if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
        lock (_gate)
        {
            using var dest = new SqliteConnection(new SqliteConnectionStringBuilder
            {
                DataSource = destinationFile,
                Mode = SqliteOpenMode.ReadWriteCreate,
                Pooling = false,
            }.ToString());
            dest.Open();
            _conn.BackupDatabase(dest);
        }
    }

    public void Dispose()
    {
        lock (_gate)
        {
            _read.Dispose(); // reader first: the LAST connection to close is the writer, which checkpoints and removes the WAL
            _conn.Dispose();
        }
    }

    private void TryRollback()
    {
        try { Exec("ROLLBACK"); }
        catch (SqliteException) { /* no transaction was open (BEGIN itself failed) */ }
    }

    /// <summary>
    /// Rewrites TS-style "?" placeholders to $p0, $p1... (skipping quoted text) and binds the values. The placeholder
    /// count must equal the value count: a mismatch is a programming error, never silently ignored.
    /// </summary>
    private static SqliteCommand Build(SqliteConnection conn, string sql, object?[] args)
    {
        var sb = new StringBuilder(sql.Length + 16);
        var count = 0;
        for (var i = 0; i < sql.Length; i++)
        {
            var c = sql[i];
            if (c is '\'' or '"' or '`')
            {
                sb.Append(c);
                for (i++; i < sql.Length; i++)
                {
                    sb.Append(sql[i]);
                    if (sql[i] != c) continue;
                    if (i + 1 < sql.Length && sql[i + 1] == c) { sb.Append(sql[++i]); continue; } // '' escape
                    break;
                }
            }
            else if (c == '?') sb.Append("$p").Append(count++);
            else sb.Append(c);
        }
        if (count != args.Length)
            throw new ArgumentException($"SQL has {count} placeholders but {args.Length} values were supplied.");

        var cmd = conn.CreateCommand();
        cmd.CommandText = sb.ToString();
        for (var i = 0; i < args.Length; i++) cmd.Parameters.AddWithValue($"$p{i}", Normalize(args[i]));
        return cmd;
    }

    private static object Normalize(object? v) => v switch
    {
        null => DBNull.Value,
        string or long or double or byte[] => v,
        int i => (long)i,
        bool b => b ? 1L : 0L,
        System.Text.Json.JsonElement je => JsonSql.ToParam(je) ?? DBNull.Value,
        _ => throw new ArgumentException($"Unsupported SQL parameter type {v.GetType().Name}"),
    };
}
