using System.Text.Json;
using PosShell.Core;

namespace PosShell.Infrastructure;

/// <summary>Turns JSON values coming from the UI into values SQLite can bind (STRICT tables reject 3.0 for an INTEGER column).</summary>
public static class JsonSql
{
    private const double MaxSafe = 9_007_199_254_740_991d;

    public static object? ToParam(JsonElement v) => v.ValueKind switch
    {
        JsonValueKind.Null or JsonValueKind.Undefined => null,
        JsonValueKind.String => v.GetString(),
        JsonValueKind.True => 1L,
        JsonValueKind.False => 0L,
        JsonValueKind.Number => NumberParam(v),
        _ => throw new ServiceException("VALIDATION", "SQL parameters must be string, number, boolean or null"),
    };

    private static object NumberParam(JsonElement v)
    {
        if (v.TryGetInt64(out var l)) return l;
        var d = v.GetDouble();
        // 3.0 / 1e3 are whole numbers: bind as INTEGER like JavaScript would have meant it
        if (d == Math.Floor(d) && Math.Abs(d) <= MaxSafe) return (long)d; // two returns: a ?: would unify both arms to double
        return d;
    }
}
