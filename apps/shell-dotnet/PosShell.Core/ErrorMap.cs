using System.Text.Json;
using System.Text.RegularExpressions;

namespace PosShell.Core;

/// <summary>What crosses the bridge when something fails: the UI maps <see cref="Code"/> to its err.&lt;CODE&gt; text.</summary>
public sealed record ErrorInfo(string Code, string Message, IReadOnlyDictionary<string, object?>? Details);

/// <summary>
/// Port of the database half of mapError (packages/db/src/service/errors.ts). Rules are matched on the driver's
/// message TEXT, in the same order as TS. SQLite surfaces RAISE(ABORT, '...') verbatim inside its own message
/// ("SQLite Error 19: '...'"), so Contains() works for Microsoft.Data.Sqlite just as it does for better-sqlite3.
/// The raw text is kept only as InnerException (for logs); callers get a generic message.
/// </summary>
public static class ErrorMap
{
    private static readonly Regex Unique = new(
        @"UNIQUE constraint failed: ([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)", RegexOptions.CultureInvariant);

    public static ServiceException FromDatabaseMessage(string msg, Exception? inner = null)
    {
        static bool Has(string text, string needle) => text.Contains(needle, StringComparison.Ordinal);

        if (Has(msg, "phone unit on-hand must stay within 0..1"))
            return new("UNIT_NOT_IN_STOCK", "This phone is not in stock", null, inner);
        if (Has(msg, "seq must be previous seq + 1") || Has(msg, "prev_hash must equal"))
            return new("CHAIN_CONFLICT", "The invoice chain moved; please retry", null, inner);
        if (Has(msg, "khata requires a sale with a customer"))
            return new("KHATA_NEEDS_CUSTOMER", "Khata needs a customer", null, inner);
        if (Has(msg, "original_sale_id must reference"))
            return new("RETURN_NOT_ALLOWED", "Only a sale invoice can be returned", null, inner);
        if (Has(msg, "is immutable") || Has(msg, "is append-only") || Has(msg, "only attempts, last_error"))
            return new("IMMUTABLE_RECORD", "This record cannot be changed", null, inner);

        var unique = Unique.Match(msg);
        if (unique.Success)
            return new("DUPLICATE", "A record with the same value already exists",
                new Dictionary<string, object?> { ["table"] = unique.Groups[1].Value, ["field"] = unique.Groups[2].Value },
                inner);

        if (Has(msg, "FOREIGN KEY constraint failed"))
            return new("NOT_FOUND", "A referenced record was not found", null, inner);
        if (Has(msg, "CHECK constraint failed") || Has(msg, "NOT NULL constraint failed"))
            return new("DB_CONSTRAINT", "The data was rejected by a database rule", null, inner);

        return new("INTERNAL", "Unexpected internal error", null, inner);
    }

    /// <summary>Anything that reaches the bridge becomes an <see cref="ErrorInfo"/>; unknown exceptions never leak their text.</summary>
    public static ErrorInfo ToInfo(Exception e) => e switch
    {
        ServiceException s => new ErrorInfo(s.Code, s.Message, s.Details),
        JsonException => new ErrorInfo("VALIDATION", "Invalid request", null),
        _ => new ErrorInfo("INTERNAL", "Unexpected internal error", null),
    };
}
