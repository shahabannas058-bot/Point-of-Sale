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
/// Methods: ping, checkout.commit { input, cashierId }, db.query { sql, params }, db.exec { sql },
/// db.batch { statements: [ { sql, params } ] }.
///
/// Rules: the payload stays a <see cref="JsonElement"/> all the way into <see cref="SalesService"/> (so "missing",
/// null, wrong type and fractional numbers keep their distinct TypeScript errors); every failure becomes an error
/// reply with the TS ServiceError code; unknown exceptions never leak their text; work runs off the UI thread.
/// </summary>
public sealed class WebBridge(SqliteDatabase db, SalesService sales)
{
    private const int MaxRequestChars = 2_000_000;

    private static readonly JsonSerializerOptions Out = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    private sealed record Reply(string Id, bool Ok, object? Data, ErrorInfo? Error);

    /// <summary>Never throws: every outcome is a reply string for PostWebMessageAsJson.</summary>
    public async Task<string> HandleAsync(string requestJson)
    {
        var id = "";
        try
        {
            if (requestJson.Length > MaxRequestChars) throw Validate.Invalid("request", "Request is too large");
            using var doc = JsonDocument.Parse(requestJson);
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object) throw Validate.Invalid("request", "Request must be an object");

            if (root.TryGetProperty("id", out var idEl) && idEl.ValueKind == JsonValueKind.String) id = idEl.GetString()!;
            if (!root.TryGetProperty("method", out var methodEl) || methodEl.ValueKind != JsonValueKind.String)
                throw Validate.Invalid("method", "method is required");
            var payload = root.TryGetProperty("payload", out var p) ? p : default;

            var data = await DispatchAsync(methodEl.GetString()!, payload); // awaited inside `using`: the JsonDocument stays alive
            return JsonSerializer.Serialize(new Reply(id, true, data, null), Out);
        }
        catch (Exception e)
        {
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
                return await Task.Run(() => db.Query(sql, args).Select(r => r.Values).ToList());
            }

            case "db.exec":
            {
                var sql = RequireString(payload, "sql");
                await Task.Run(() => db.Exec(sql));
                return null;
            }

            case "db.batch":
            {
                var statements = Require(payload, "statements");
                if (statements.ValueKind != JsonValueKind.Array) throw Validate.Invalid("statements", "statements must be an array");
                var list = statements.EnumerateArray()
                    .Select(s => new SqlStatement(RequireString(s, "sql"), Params(s)))
                    .ToList();
                await Task.Run(() => db.Batch(list));
                return null;
            }

            default:
                throw new ServiceException("NOT_FOUND", $"Unknown method '{method}'");
        }
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
