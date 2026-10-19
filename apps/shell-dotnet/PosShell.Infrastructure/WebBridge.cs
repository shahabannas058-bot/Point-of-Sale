using System.Text.Json;
using PosShell.Core;

namespace PosShell.Infrastructure;

/// <summary>
/// The one door between React and the native side. No WebView2 types here, so it is unit-testable; the WPF window
/// just forwards WebMessageReceived text into <see cref="HandleAsync"/> and posts the returned string back.
///
///   Request : { "id": "&lt;uuid&gt;", "method": "checkout.commit", "payload": { ... } }
///   Reply   : { "id": "&lt;same&gt;", "ok": true,  "data": ... }
///           | { "id": "&lt;same&gt;", "ok": false, "error": { "code", "message", "details" } }
///
/// Methods: ping, checkout.commit { input, cashierId }, db.query { sql, params } (read-only connection),
/// db.batch { statements: [ { sql, params } ] } (one transaction, asked of the licence first). db.exec is refused:
/// the page never needs it in the shell (C# migrates) and an unguarded multi-statement script would bypass the guard.
///
/// Rules: the payload stays a <see cref="JsonElement"/> all the way into <see cref="SalesService"/> (so "missing",
/// null, wrong type and fractional numbers keep their distinct TypeScript errors); every failure becomes an error
/// reply with the TS ServiceError code; unknown exceptions never leak their text to the page, the full exception goes
/// to <see cref="FileLog"/> instead; work runs off the UI thread.
///
/// Writes: db.batch is the choke point ADR-0010 names (the TypeScript PosService writes sales, stock and khata through
/// it), so every batch passes <see cref="ILicenceGuard.AssertCanWrite"/> inside the write lock right before it runs,
/// exactly like SalesService asks AssertCanSell before its own batch. Phase 2b only swaps the guard implementation.
/// </summary>
public sealed class WebBridge(SqliteDatabase db, SalesService sales, ILicenceGuard licence, FileLog? log = null, Func<long>? clock = null)
{
    private const int MaxRequestChars = 2_000_000;

    private static readonly JsonSerializerOptions Out = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    private readonly Func<long> _clock = clock ?? (() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());

    private sealed record Reply(string Id, bool Ok, object? Data, ErrorInfo? Error);

    /// <summary>Never throws: every outcome is a reply string for PostWebMessageAsJson.</summary>
    public async Task<string> HandleAsync(string requestJson)
    {
        var id = "";
        var method = "";
        try
        {
            if (requestJson.Length > MaxRequestChars) throw Validate.Invalid("request", "Request is too large");
            using var doc = JsonDocument.Parse(requestJson);
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object) throw Validate.Invalid("request", "Request must be an object");

            if (root.TryGetProperty("id", out var idEl) && idEl.ValueKind == JsonValueKind.String) id = idEl.GetString()!;
            if (!root.TryGetProperty("method", out var methodEl) || methodEl.ValueKind != JsonValueKind.String)
                throw Validate.Invalid("method", "method is required");
            method = methodEl.GetString()!;
            var payload = root.TryGetProperty("payload", out var p) ? p : default;

            var data = await DispatchAsync(method, payload); // awaited inside `using`: the JsonDocument stays alive
            return JsonSerializer.Serialize(new Reply(id, true, data, null), Out);
        }
        catch (Exception e)
        {
            log?.Error($"bridge:{(method.Length > 0 ? method : "?")}", e, id); // the page gets the generic text below
            return JsonSerializer.Serialize(new Reply(id, false, null, ErrorMap.ToInfo(e)), Out);
        }
    }

    private async Task<object?> DispatchAsync(string method, JsonElement payload)
    {
        switch (method)
        {
            case "ping":
                return "pong";

            case "checkout.commit":
            {
                var input = Require(payload, "input");
                var cashierId = RequireString(payload, "cashierId");
                return await Task.Run(() => sales.Commit(input, cashierId));
            }

            case "db.query":
            {
                var sql = RequireString(payload, "sql");
                var args = Params(payload);
                return await Task.Run(() => db.QueryReadOnly(sql, args).Select(r => r.Values).ToList());
            }

            case "db.exec":
                // Only migrate() in packages/db calls SqlDriver.exec, and the shell never migrates from the page
                // (apps/desktop/src/service/real.ts). Refused rather than guarded: a raw script has no statement list
                // for the licence to inspect and ran outside any transaction.
                throw new ServiceException("FORBIDDEN", "db.exec is not available in the desktop shell",
                    new Dictionary<string, object?> { ["method"] = method });

            case "db.batch":
            {
                var statements = Require(payload, "statements");
                if (statements.ValueKind != JsonValueKind.Array) throw Validate.Invalid("statements", "statements must be an array");
                var list = statements.EnumerateArray()
                    .Select(s => new SqlStatement(RequireString(s, "sql"), Params(s)))
                    .ToList();
                await Task.Run(() => db.Exclusive(() =>
                {
                    AssertCanWrite(list); // inside the write lock, right before the batch: no write can slip between them
                    db.Batch(list);       // BEGIN IMMEDIATE ... COMMIT, ROLLBACK on any error
                    return 0;
                }));
                return null;
            }

            default:
                throw new ServiceException("NOT_FOUND", $"Unknown method '{method}'");
        }
    }

    /// <summary>Same contract as SalesService.CallLicence: LICENCE_BLOCKED passes through, a plain Error becomes INTERNAL + message.</summary>
    private void AssertCanWrite(IReadOnlyList<SqlStatement> statements)
    {
        try { licence.AssertCanWrite(statements, _clock()); }
        catch (ServiceException) { throw; }
        catch (Exception e) { throw new ServiceException("INTERNAL", e.Message, null, e); }
    }

    private static JsonElement Require(JsonElement obj, string name) =>
        obj.ValueKind == JsonValueKind.Object && obj.TryGetProperty(name, out var v)
            ? v
            : throw Validate.Invalid(name, $"{name} is required");

    private static string RequireString(JsonElement obj, string name) =>
        Require(obj, name) is { ValueKind: JsonValueKind.String } v && v.GetString() is { Length: > 0 } s
            ? s
            : throw Validate.Invalid(name, $"{name} must be text");

    private static object?[] Params(JsonElement obj)
    {
        if (obj.ValueKind != JsonValueKind.Object || !obj.TryGetProperty("params", out var p) || p.ValueKind == JsonValueKind.Null)
            return [];
        if (p.ValueKind != JsonValueKind.Array) throw Validate.Invalid("params", "params must be an array");
        return p.EnumerateArray().Select(JsonSql.ToParam).ToArray();
    }
}
