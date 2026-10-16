using System.Globalization;

namespace PosShell.Core;

/// <summary>One statement of an atomic batch. Placeholders are "?" exactly like the TypeScript SQL.</summary>
public sealed record SqlStatement(string Sql, object?[] Params)
{
    public SqlStatement(string sql) : this(sql, []) { }
}

/// <summary>A result row. NULL columns come back as null; INTEGER as long, TEXT as string, REAL as double.</summary>
public sealed class Row(IReadOnlyDictionary<string, object?> values)
{
    public IReadOnlyDictionary<string, object?> Values { get; } = values;

    public object? this[string column] => Values[column];

    public string Str(string column) =>
        Values[column] as string ?? throw new InvalidOperationException($"Column '{column}' is NULL or not text");

    public string? StrN(string column) => Values[column] as string;

    public long Lng(string column) =>
        Values[column] is { } v
            ? Convert.ToInt64(v, CultureInfo.InvariantCulture)
            : throw new InvalidOperationException($"Column '{column}' is NULL");

    public long? LngN(string column) =>
        Values[column] is { } v ? Convert.ToInt64(v, CultureInfo.InvariantCulture) : null;
}

/// <summary>
/// The database seen by the business logic. Core never references SQLite: Infrastructure implements this and
/// turns driver errors into <see cref="ServiceException"/> (see <see cref="ErrorMap"/>).
/// </summary>
public interface IPosDb
{
    IReadOnlyList<Row> Query(string sql, params object?[] args);

    /// <summary>All statements in ONE transaction (BEGIN IMMEDIATE ... COMMIT, ROLLBACK on any error).</summary>
    void Batch(IReadOnlyList<SqlStatement> statements);

    /// <summary>
    /// Runs <paramref name="work"/> with every other reader/writer excluded. Re-entrant: Query/Batch/Exclusive
    /// called from inside <paramref name="work"/> on the same thread do not deadlock.
    /// </summary>
    T Exclusive<T>(Func<T> work);
}
