using System.Text.Json;
using PosShell.Core;
using Xunit;

namespace PosShell.Infrastructure.Tests;

/// <summary>The exact JSON React sends and receives, run through the real SalesService and a real SQLite file.</summary>
public sealed class WebBridgeTests : IDisposable
{
    private readonly ShopFixture _fx = new();
    private readonly WebBridge _bridge;

    public WebBridgeTests() => _bridge = new WebBridge(_fx.Db, _fx.Sales, _fx.Licence);

    public void Dispose() => _fx.Dispose();

    private async Task<JsonElement> Send(string id, string method, string payloadJson = "null")
    {
        var reply = await _bridge.HandleAsync($$"""{ "id": "{{id}}", "method": "{{method}}", "payload": {{payloadJson}} }""");
        return JsonDocument.Parse(reply).RootElement;
    }

    private string Commit(string cartJson, string? cashierId = null) =>
        $$"""{ "cashierId": "{{cashierId ?? _fx.S.CashierId}}", "input": {{cartJson}} }""";

    [Fact]
    public async Task Ping_answers_pong_and_echoes_the_request_id()
    {
        var r = await Send("req-1", "ping");
        Assert.Equal("req-1", r.GetProperty("id").GetString());
        Assert.True(r.GetProperty("ok").GetBoolean());
        Assert.Equal("pong", r.GetProperty("data").GetString());
    }

    [Fact]
    public async Task A_cart_posted_from_react_becomes_a_sealed_invoice_in_camelCase()
    {
        var saleId = _fx.Ids.Next();
        var r = await Send("req-2", "checkout.commit", Commit(_fx.CashSaleOfChargers(2, saleId)));

        Assert.True(r.GetProperty("ok").GetBoolean());
        var inv = r.GetProperty("data");
        Assert.Equal(saleId, inv.GetProperty("id").GetString());
        Assert.Equal("A-000001", inv.GetProperty("invoiceNo").GetString());
        Assert.Equal(100_000, inv.GetProperty("total").GetInt64());
        Assert.Equal(1, inv.GetProperty("hashVersion").GetInt32());
        Assert.Equal(64, inv.GetProperty("hash").GetString()!.Length);
        Assert.Equal(1, inv.GetProperty("lines").GetArrayLength());
        Assert.Equal("cash", inv.GetProperty("payments")[0].GetProperty("method").GetString());
        Assert.Equal(1, _fx.Count("sales"));

        // a retried request (timeout, double click) returns the same invoice, it does not sell twice
        var again = await Send("req-3", "checkout.commit", Commit(_fx.CashSaleOfChargers(2, saleId)));
        Assert.Equal(inv.GetProperty("hash").GetString(), again.GetProperty("data").GetProperty("hash").GetString());
        Assert.Equal(1, _fx.Count("sales"));
    }

    [Fact]
    public async Task Business_errors_come_back_with_the_typescript_code_and_details()
    {
        var r = await Send("req-4", "checkout.commit", Commit(_fx.CashSaleOfChargers(11)));

        Assert.False(r.GetProperty("ok").GetBoolean());
        Assert.Equal("req-4", r.GetProperty("id").GetString());
        var error = r.GetProperty("error");
        Assert.Equal("STOCK_INSUFFICIENT", error.GetProperty("code").GetString());
        Assert.Equal("Not enough stock", error.GetProperty("message").GetString());
        Assert.Equal(10, error.GetProperty("details").GetProperty("onHand").GetInt64());
        Assert.Equal(11, error.GetProperty("details").GetProperty("requested").GetInt64());
        Assert.Equal(0, _fx.Count("sales"));
    }

    [Fact]
    public async Task A_fractional_quantity_survives_the_trip_as_a_VALIDATION_error()
    {
        var cart = $$"""{ "lines": [ { "variantId": "{{_fx.S.VariantId}}", "quantity": 1.5 } ], "payments": [] }""";
        var error = (await Send("req-5", "checkout.commit", Commit(cart))).GetProperty("error");
        Assert.Equal("VALIDATION", error.GetProperty("code").GetString());
        Assert.Equal("lines.0.quantity", error.GetProperty("details").GetProperty("field").GetString());
    }

    [Fact]
    public async Task Bad_requests_are_rejected_without_a_crash_and_without_leaking_details()
    {
        var notJson = JsonDocument.Parse(await _bridge.HandleAsync("{ nope")).RootElement;
        Assert.Equal("VALIDATION", notJson.GetProperty("error").GetProperty("code").GetString());
        Assert.Equal("", notJson.GetProperty("id").GetString());

        var noMethod = JsonDocument.Parse(await _bridge.HandleAsync("""{ "id": "x1" }""")).RootElement;
        Assert.Equal("x1", noMethod.GetProperty("id").GetString());
        Assert.Equal("method", noMethod.GetProperty("error").GetProperty("details").GetProperty("field").GetString());

        var unknown = await Send("x2", "format.disk");
        Assert.Equal("NOT_FOUND", unknown.GetProperty("error").GetProperty("code").GetString());

        var array = JsonDocument.Parse(await _bridge.HandleAsync("[1,2,3]")).RootElement;
        Assert.False(array.GetProperty("ok").GetBoolean());

        var huge = JsonDocument.Parse(await _bridge.HandleAsync(new string(' ', 2_000_001))).RootElement;
        Assert.Equal("Request is too large", huge.GetProperty("error").GetProperty("message").GetString());
    }

    [Fact]
    public async Task Commit_without_a_cashier_or_input_is_refused()
    {
        var noCashier = await Send("c1", "checkout.commit", $$"""{ "input": {{_fx.CashSaleOfChargers(1)}} }""");
        Assert.Equal("cashierId", noCashier.GetProperty("error").GetProperty("details").GetProperty("field").GetString());

        var noInput = await Send("c2", "checkout.commit", $$"""{ "cashierId": "{{_fx.S.CashierId}}" }""");
        Assert.Equal("input", noInput.GetProperty("error").GetProperty("details").GetProperty("field").GetString());

        var stranger = await Send("c3", "checkout.commit", Commit(_fx.CashSaleOfChargers(1), "someone-else"));
        Assert.Equal("NOT_AUTHENTICATED", stranger.GetProperty("error").GetProperty("code").GetString());
    }

    [Fact]
    public async Task The_sql_driver_methods_round_trip_values_for_the_typescript_services()
    {
        var batch = await Send("d1", "db.batch", """
            { "statements": [
                { "sql": "INSERT INTO app_meta (key, value) VALUES (?, ?)", "params": ["k1", "Al-Madina مال"] },
                { "sql": "INSERT INTO app_meta (key, value) VALUES (?, ?)", "params": ["k2", "it's ? not a placeholder"] }
            ] }
            """);
        Assert.True(batch.GetProperty("ok").GetBoolean());

        var rows = (await Send("d2", "db.query", """{ "sql": "SELECT key, value FROM app_meta WHERE key IN (?, ?) ORDER BY key", "params": ["k2", "k1"] }"""))
            .GetProperty("data");
        Assert.Equal(2, rows.GetArrayLength());
        Assert.Equal("Al-Madina مال", rows[0].GetProperty("value").GetString());
        Assert.Equal("it's ? not a placeholder", rows[1].GetProperty("value").GetString());

        // 3.0 and 1e3 are whole numbers: they bind as INTEGER (STRICT tables reject REAL for an INTEGER column)
        var count = (await Send("d3", "db.query", """{ "sql": "SELECT ? AS a, ? AS b, ? AS c", "params": [3.0, 1e3, null] }""")).GetProperty("data")[0];
        Assert.Equal(3, count.GetProperty("a").GetInt64());
        Assert.Equal(1000, count.GetProperty("b").GetInt64());
        Assert.Equal(JsonValueKind.Null, count.GetProperty("c").ValueKind);
    }

    [Fact]
    public async Task A_failed_batch_changes_nothing_and_a_duplicate_is_reported_like_typescript()
    {
        var r = await Send("d4", "db.batch", """
            { "statements": [
                { "sql": "INSERT INTO app_meta (key, value) VALUES (?, ?)", "params": ["a", "1"] },
                { "sql": "INSERT INTO app_meta (key, value) VALUES (?, ?)", "params": ["a", "2"] }
            ] }
            """);
        Assert.False(r.GetProperty("ok").GetBoolean());
        Assert.Equal("DUPLICATE", r.GetProperty("error").GetProperty("code").GetString());
        Assert.Equal("app_meta", r.GetProperty("error").GetProperty("details").GetProperty("table").GetString());

        var rows = (await Send("d5", "db.query", """{ "sql": "SELECT COUNT(*) AS n FROM app_meta WHERE key = ?", "params": ["a"] }""")).GetProperty("data");
        Assert.Equal(0, rows[0].GetProperty("n").GetInt64()); // the first insert was rolled back too
    }

    [Fact]
    public async Task Broken_sql_never_leaks_its_text_to_the_page()
    {
        var r = await Send("d6", "db.batch", """{ "statements": [ { "sql": "SELEKT nothing FROM nowhere" } ] }""");
        Assert.False(r.GetProperty("ok").GetBoolean());
        Assert.Equal("INTERNAL", r.GetProperty("error").GetProperty("code").GetString());
        Assert.Equal("Unexpected internal error", r.GetProperty("error").GetProperty("message").GetString());

        var placeholders = await Send("d7", "db.query", """{ "sql": "SELECT ?", "params": [] }""");
        Assert.Equal("INTERNAL", placeholders.GetProperty("error").GetProperty("code").GetString());
    }

    // ---- the write choke point (ADR-0010) --------------------------------------------------------------------------
    [Fact]
    public async Task Db_query_is_read_only_so_it_cannot_insert_or_drop_anything()
    {
        var insert = await Send("q1", "db.query", """{ "sql": "INSERT INTO app_meta (key, value) VALUES (?, ?)", "params": ["q1", "x"] }""");
        Assert.False(insert.GetProperty("ok").GetBoolean());
        Assert.Equal("FORBIDDEN", insert.GetProperty("error").GetProperty("code").GetString());
        Assert.Equal(0, _fx.Db.Query("SELECT COUNT(*) AS n FROM app_meta WHERE key = ?", "q1")[0].Lng("n"));

        var drop = await Send("q2", "db.query", """{ "sql": "DROP TABLE outbox" }""");
        Assert.Equal("FORBIDDEN", drop.GetProperty("error").GetProperty("code").GetString());
        Assert.Equal(0, _fx.Count("outbox")); // the table is still there

        var read = await Send("q3", "db.query", """{ "sql": "WITH u AS (SELECT id FROM users) SELECT COUNT(*) AS n FROM u" }""");
        Assert.True(read.GetProperty("ok").GetBoolean());
        Assert.Equal(4, read.GetProperty("data")[0].GetProperty("n").GetInt64());
    }

    [Fact]
    public async Task Db_exec_is_refused_in_the_shell()
    {
        var r = await Send("e1", "db.exec", """{ "sql": "INSERT INTO app_meta (key, value) VALUES ('e1', 'x')" }""");
        Assert.False(r.GetProperty("ok").GetBoolean());
        Assert.Equal("FORBIDDEN", r.GetProperty("error").GetProperty("code").GetString());
        Assert.Equal(0, _fx.Db.Query("SELECT COUNT(*) AS n FROM app_meta WHERE key = ?", "e1")[0].Lng("n"));
    }

    [Fact]
    public async Task Db_batch_asks_the_licence_guard_first_and_a_blocked_licence_writes_nothing()
    {
        const string batch = """{ "statements": [ { "sql": "INSERT INTO app_meta (key, value) VALUES (?, ?)", "params": ["l1", "x"] } ] }""";
        _fx.Licence.WriteBehaviour = (_, _) => throw new ServiceException("LICENCE_BLOCKED", "Licence expired",
            new Dictionary<string, object?> { ["state"] = "LOCKED" });

        var blocked = await Send("l1", "db.batch", batch);
        Assert.False(blocked.GetProperty("ok").GetBoolean());
        Assert.Equal("LICENCE_BLOCKED", blocked.GetProperty("error").GetProperty("code").GetString());
        Assert.Equal("LOCKED", blocked.GetProperty("error").GetProperty("details").GetProperty("state").GetString());
        var seen = Assert.Single(_fx.Licence.Writes);
        Assert.Contains("INSERT INTO app_meta", seen[0].Sql);
        Assert.Equal(0, _fx.Db.Query("SELECT COUNT(*) AS n FROM app_meta WHERE key = ?", "l1")[0].Lng("n"));

        _fx.Licence.WriteBehaviour = null;
        var allowed = await Send("l2", "db.batch", batch);
        Assert.True(allowed.GetProperty("ok").GetBoolean());
        Assert.Equal(2, _fx.Licence.Writes.Count);
        Assert.Equal(1, _fx.Db.Query("SELECT COUNT(*) AS n FROM app_meta WHERE key = ?", "l1")[0].Lng("n"));
    }

    [Fact]
    public async Task A_failed_call_is_logged_with_method_request_id_and_the_real_exception()
    {
        var dir = Path.Combine(Path.GetTempPath(), $"pos-log-{Guid.NewGuid():N}");
        try
        {
            var bridge = new WebBridge(_fx.Db, _fx.Sales, _fx.Licence, new FileLog(dir));
            var reply = await bridge.HandleAsync(
                """{ "id": "req-log-1", "method": "db.batch", "payload": { "statements": [ { "sql": "SELEKT nothing FROM nowhere" } ] } }""");
            Assert.Equal("INTERNAL", JsonDocument.Parse(reply).RootElement.GetProperty("error").GetProperty("code").GetString());

            var line = Assert.Single(File.ReadAllLines(Assert.Single(Directory.GetFiles(dir, "pos-*.log"))));
            Assert.Contains(" ERROR bridge:db.batch id=req-log-1 code=INTERNAL ", line);
            Assert.Contains("SELEKT", line);       // the real SQLite text is in the log...
            Assert.DoesNotContain("SELEKT", reply); // ...and only there
        }
        finally { if (Directory.Exists(dir)) Directory.Delete(dir, recursive: true); }
    }
}
