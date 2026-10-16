using System.Text.Json;
using PosShell.Core;
using Xunit;

namespace PosShell.Infrastructure.Tests;

/// <summary>
/// End-to-end tests of SalesService against a real SQLite file with the real migrations (triggers included).
/// Error codes, messages and details are the ones packages/db/src/service/checkout.ts produces.
/// </summary>
public sealed class SalesServiceTests : IDisposable
{
    private readonly ShopFixture _fx = new();

    public void Dispose() => _fx.Dispose();

    // ---- helpers ------------------------------------------------------------------------------------------------
    private Invoice Commit(string json, string? cashierId = null) =>
        _fx.Sales.Commit(ShopFixture.Json(json), cashierId ?? _fx.S.CashierId);

    private ServiceException Fails(string json, string? cashierId = null) =>
        Assert.Throws<ServiceException>(() => Commit(json, cashierId));

    /// <summary>One accessory line + one payment. Every argument is raw JSON so tests can send wrong types on purpose.</summary>
    private string Cart(string quantity = "1", string? discount = null, string amount = "50000",
        string method = "\"cash\"", string? top = null)
    {
        var d = discount is null ? "" : ", \"discountAmount\": " + discount;
        var t = top is null ? "" : top + ", ";
        return "{ " + t + "\"lines\": [ { \"variantId\": \"" + _fx.S.VariantId + "\", \"quantity\": " + quantity + d + " } ], " +
               "\"payments\": [ { \"method\": " + method + ", \"amount\": " + amount + " } ] }";
    }

    private static string? Field(ServiceException e) => e.Details is not null && e.Details.TryGetValue("field", out var f) ? (string?)f : null;

    // ---- the happy path -----------------------------------------------------------------------------------------
    [Fact]
    public void Cash_sale_writes_invoice_lines_payment_stock_and_outbox_in_one_go()
    {
        var inv = Commit(_fx.CashSaleOfChargers(2));

        Assert.Equal("A-000001", inv.InvoiceNo);
        Assert.Equal(1, inv.Seq);
        Assert.Equal(100_000, inv.Total);
        Assert.Equal(100_000, inv.Subtotal);
        Assert.Equal(InvoiceHasher.Genesis, inv.PrevHash);
        Assert.Equal("Anker Charger (Universal, White)", inv.Lines[0].Description);

        Assert.Equal(1, _fx.Count("sales"));
        Assert.Equal(1, _fx.Count("sale_lines"));
        Assert.Equal(1, _fx.Count("payments"));
        Assert.Equal(0, _fx.Count("ledger_entries"));
        Assert.Equal(4, _fx.Count("stock_movements")); // 3 opening + 1 sale
        Assert.Equal(8, _fx.OnHandVariant());          // stock is a ledger: 10 - 2
        Assert.Equal(2, _fx.Count("outbox"));          // 'sale' + 'stock_movement'
        Assert.Equal(1, _fx.Licence.Calls);

        var payload = JsonDocument.Parse(
            _fx.Db.Query("SELECT payload FROM outbox WHERE entity_type = 'sale'")[0].Str("payload")).RootElement;
        Assert.Equal(inv.Hash, payload.GetProperty("hash").GetString());
        Assert.Equal("A-000001", payload.GetProperty("invoiceNo").GetString());
        Assert.Equal(1, payload.GetProperty("lines").GetArrayLength());
    }

    [Fact]
    public void Invoices_chain_and_every_stored_hash_verifies_with_the_shared_hasher()
    {
        var a = Commit(_fx.CashSaleOfChargers(1));
        var b = Commit(_fx.CashSaleOfChargers(1));

        Assert.Equal(a.Hash, b.PrevHash);
        Assert.Equal(2, b.Seq);
        Assert.Equal("A-000002", b.InvoiceNo);
        Assert.True(b.CreatedAt > a.CreatedAt);
        foreach (var inv in new[] { a, b })
            Assert.Equal(inv.Hash, InvoiceHasher.Hash(inv.PrevHash, inv with { Hash = "" }));
    }

    [Fact]
    public void Phone_sale_with_discount_and_split_cash_khata_writes_the_ledger_entry()
    {
        var json = $$"""
            { "customerId": "{{_fx.S.CustomerId}}",
              "lines": [ { "phoneUnitId": "{{_fx.S.PhoneUnitId}}", "quantity": 1, "discountAmount": 19995 } ],
              "payments": [ { "method": "cash", "amount": 79955 }, { "method": "khata", "amount": 100000 } ] }
            """;
        var inv = Commit(json, _fx.S.ManagerId); // 10 % discount is above a cashier's limit

        Assert.Equal(179_955, inv.Total);
        Assert.Equal("Samsung Galaxy A55 (Blue, 8/256GB) · IMEI 356938035643809", inv.Lines[0].Description);
        Assert.Equal(0, _fx.OnHandPhone(_fx.S.PhoneUnitId));
        Assert.Equal(1, _fx.OnHandPhone(_fx.S.SecondPhoneUnitId));

        var ledger = _fx.Db.Query("SELECT type, amount, sale_id FROM ledger_entries").Single();
        Assert.Equal("sale_credit", ledger.Str("type"));
        Assert.Equal(100_000, ledger.Lng("amount"));
        Assert.Equal(inv.Id, ledger.Str("sale_id"));
        Assert.Equal(3, _fx.Count("outbox")); // sale + stock_movement + ledger_entry
    }

    [Fact]
    public void Same_saleId_returns_the_stored_invoice_and_changes_nothing()
    {
        var id = _fx.Ids.Next();
        var a = Commit(_fx.CashSaleOfChargers(2, id));
        var b = Commit(_fx.CashSaleOfChargers(2, id));

        Assert.Equal(a.Hash, b.Hash);
        Assert.Equal(id, b.Id);
        Assert.Equal(1, _fx.Count("sales"));
        Assert.Equal(8, _fx.OnHandVariant());
        Assert.Equal(1, _fx.Licence.Calls);

        var bad = Fails(_fx.CashSaleOfChargers(1, "not-a-uuid"));
        Assert.Equal("VALIDATION", bad.Code);
        Assert.Equal("saleId", Field(bad));
    }

    [Fact]
    public void Negative_stock_setting_lets_a_shop_oversell()
    {
        Assert.Equal("STOCK_INSUFFICIENT", Fails(_fx.CashSaleOfChargers(11)).Code);
        _fx.Db.Batch([new SqlStatement("INSERT INTO app_meta (key, value) VALUES (?, ?)", ["allow_negative_stock", "1"])]);
        Commit(_fx.CashSaleOfChargers(11));
        Assert.Equal(-1, _fx.OnHandVariant());
    }

    // ---- stock and IMEI ---------------------------------------------------------------------------------------------
    [Fact]
    public void The_same_phone_twice_in_one_cart_is_UNIT_NOT_IN_STOCK_on_the_second_line()
    {
        var json = $$"""
            { "lines": [ { "phoneUnitId": "{{_fx.S.PhoneUnitId}}", "quantity": 1 }, { "phoneUnitId": "{{_fx.S.PhoneUnitId}}", "quantity": 1 } ],
              "payments": [ { "method": "cash", "amount": 399900 } ] }
            """;
        var e = Fails(json);
        Assert.Equal("UNIT_NOT_IN_STOCK", e.Code);
        Assert.Equal(2, e.Details!["lineNo"]);
        Assert.Equal(_fx.S.PhoneUnitId, e.Details["phoneUnitId"]);
        Assert.Equal(0, _fx.Count("sales"));
    }

    [Fact]
    public void A_phone_that_was_already_sold_cannot_be_sold_again()
    {
        var json = $$"""
            { "lines": [ { "phoneUnitId": "{{_fx.S.SecondPhoneUnitId}}", "quantity": 1 } ],
              "payments": [ { "method": "cash", "amount": 199950 } ] }
            """;
        Commit(json);
        Assert.Equal("UNIT_NOT_IN_STOCK", Fails(json).Code);
        Assert.Equal(1, _fx.Count("sales"));
    }

    [Fact]
    public void Overselling_an_accessory_is_STOCK_INSUFFICIENT_with_the_numbers()
    {
        var e = Fails(_fx.CashSaleOfChargers(11));
        Assert.Equal("STOCK_INSUFFICIENT", e.Code);
        Assert.Equal("Not enough stock", e.Message);
        Assert.Equal(10L, e.Details!["onHand"]);
        Assert.Equal(11L, e.Details["requested"]);
        Assert.Equal(1, e.Details["lineNo"]);
        Assert.Equal(0, _fx.Count("sales"));
        Assert.Equal(0, _fx.Licence.Calls); // rejected before the licence is even asked
    }

    [Fact]
    public void The_same_variant_on_two_lines_is_counted_cumulatively()
    {
        var v = _fx.S.VariantId;
        var json = $$"""
            { "lines": [ { "variantId": "{{v}}", "quantity": 6 }, { "variantId": "{{v}}", "quantity": 6 } ],
              "payments": [ { "method": "cash", "amount": 600000 } ] }
            """;
        var e = Fails(json);
        Assert.Equal("STOCK_INSUFFICIENT", e.Code);
        Assert.Equal(12L, e.Details!["requested"]);
        Assert.Equal(2, e.Details["lineNo"]);
    }

    [Fact]
    public void Unknown_or_inactive_things_are_NOT_FOUND()
    {
        string One(string line, string? top = null) =>
            "{ " + (top is null ? "" : top + ", ") + "\"lines\": [ " + line + " ], \"payments\": [ { \"method\": \"cash\", \"amount\": 50000 } ] }";

        var unknownVariant = Fails(One("{ \"variantId\": \"" + _fx.Ids.Next() + "\", \"quantity\": 1 }"));
        Assert.Equal("NOT_FOUND", unknownVariant.Code);
        Assert.Equal("Accessory not found", unknownVariant.Message);
        Assert.Equal(1, unknownVariant.Details!["lineNo"]);

        Assert.Equal("Accessory not found", Fails(One("{ \"variantId\": \"" + _fx.S.InactiveVariantId + "\", \"quantity\": 1 }")).Message);
        Assert.Equal("Phone unit not found", Fails(One("{ \"phoneUnitId\": \"" + _fx.Ids.Next() + "\", \"quantity\": 1 }")).Message);

        var line = "{ \"variantId\": \"" + _fx.S.VariantId + "\", \"quantity\": 1 }";
        Assert.Equal("Customer not found", Fails(One(line, "\"customerId\": \"" + _fx.Ids.Next() + "\"")).Message);
        Assert.Equal("Customer not found", Fails(One(line, "\"customerId\": \"" + _fx.S.InactiveCustomerId + "\"")).Message);
    }

    [Fact]
    public void A_line_needs_exactly_one_of_phoneUnitId_or_variantId()
    {
        var both = Fails("{ \"lines\": [ { \"phoneUnitId\": \"" + _fx.S.PhoneUnitId + "\", \"variantId\": \"" + _fx.S.VariantId +
                         "\", \"quantity\": 1 } ], \"payments\": [] }");
        Assert.Equal("VALIDATION", both.Code);
        Assert.Equal("Each line needs exactly one of phoneUnitId / variantId", both.Message);
        Assert.Equal("lines.0", Field(both));

        Assert.Equal("Each line needs exactly one of phoneUnitId / variantId",
            Fails("{ \"lines\": [ { \"quantity\": 1 } ], \"payments\": [] }").Message);

        var phoneQty = Fails("{ \"lines\": [ { \"phoneUnitId\": \"" + _fx.S.PhoneUnitId + "\", \"quantity\": 2 } ], \"payments\": [] }");
        Assert.Equal("A phone unit is sold one at a time", phoneQty.Message);
    }

    // ---- JsonElement validation parity (the TS helper rules) ----------------------------------------------------------
    [Theory]
    [InlineData("1.5")]
    [InlineData("\"2\"")]
    [InlineData("0")]
    [InlineData("-1")]
    [InlineData("1000001")]
    [InlineData("null")]
    [InlineData("true")]
    [InlineData("9007199254740993")]
    public void A_bad_quantity_is_VALIDATION_on_lines_0_quantity(string quantity)
    {
        var e = Fails(Cart(quantity));
        Assert.Equal("VALIDATION", e.Code);
        Assert.Equal("lines.0.quantity", Field(e));
        Assert.Equal("lines.0.quantity must be an integer between 1 and 1000000", e.Message);
    }

    [Fact]
    public void A_missing_quantity_is_VALIDATION_too()
    {
        var e = Fails("{ \"lines\": [ { \"variantId\": \"" + _fx.S.VariantId + "\" } ], \"payments\": [] }");
        Assert.Equal("VALIDATION", e.Code);
        Assert.Equal("lines.0.quantity", Field(e));
    }

    [Theory]
    [InlineData("1.5", "MONEY_INVALID", "lines.0.discountAmount")]
    [InlineData("\"10\"", "MONEY_INVALID", "lines.0.discountAmount")]
    [InlineData("-5", "DISCOUNT_INVALID", "lines.0.discountAmount")]
    public void A_bad_line_discount_follows_discountMoney(string discount, string code, string field)
    {
        var e = Fails(Cart(discount: discount));
        Assert.Equal(code, e.Code);
        Assert.Equal(field, Field(e));
    }

    [Fact]
    public void A_null_line_discount_means_none_but_a_null_invoice_discount_is_MONEY_INVALID()
    {
        Commit(Cart(discount: "null")); // `l.discountAmount ?? 0`
        var e = Fails(Cart(amount: "50000", top: "\"invoiceDiscount\": null"));
        Assert.Equal("MONEY_INVALID", e.Code);
        Assert.Equal("invoiceDiscount", Field(e));
    }

    [Fact]
    public void A_discount_larger_than_the_line_is_DISCOUNT_INVALID_with_the_ts_message()
    {
        var e = Fails(Cart(discount: "50001"));
        Assert.Equal("DISCOUNT_INVALID", e.Code);
        Assert.Equal("Line discount 50001 is outside 0..50000", e.Message);

        var inv = Fails(Cart(top: "\"invoiceDiscount\": 50001"));
        Assert.Equal("Invoice discount 50001 is outside 0..50000", inv.Message);

        Assert.Equal("invoiceDiscount must not be negative", Fails(Cart(top: "\"invoiceDiscount\": -1")).Message);
    }

    [Theory]
    [InlineData("1.5", "MONEY_INVALID", "payments.0.amount must be a whole number of paisa")]
    [InlineData("\"50000\"", "MONEY_INVALID", "payments.0.amount must be a whole number of paisa")]
    [InlineData("null", "MONEY_INVALID", "payments.0.amount must be a whole number of paisa")]
    [InlineData("0", "VALIDATION", "payments.0.amount must be greater than zero")]
    [InlineData("-50000", "VALIDATION", "payments.0.amount must not be negative")]
    public void A_bad_payment_amount_follows_money(string amount, string code, string message)
    {
        var e = Fails(Cart(amount: amount));
        Assert.Equal(code, e.Code);
        Assert.Equal(message, e.Message);
        Assert.Equal("payments.0.amount", Field(e));
    }

    [Fact]
    public void Payments_must_add_up_to_the_total_exactly()
    {
        var e = Fails(Cart(amount: "49999"));
        Assert.Equal("PAYMENT_MISMATCH", e.Code);
        Assert.Equal("Payments sum to 49999 paisa but total is 50000 paisa (difference 1)", e.Message);
        Assert.Equal(0, _fx.Count("sales"));
    }

    [Fact]
    public void Empty_or_missing_cart_payments_and_unknown_method_have_their_own_errors()
    {
        Assert.Equal("EMPTY_CART", Fails("{ \"lines\": [], \"payments\": [] }").Code);
        Assert.Equal("EMPTY_CART", Fails("{ \"payments\": [] }").Code);
        Assert.Equal("EMPTY_CART", Fails("{ \"lines\": \"x\", \"payments\": [] }").Code);

        var noPayments = Fails("{ \"lines\": [ { \"variantId\": \"" + _fx.S.VariantId + "\", \"quantity\": 1 } ] }");
        Assert.Equal("VALIDATION", noPayments.Code);
        Assert.Equal("payments", Field(noPayments));
        Assert.Equal("payments are required", noPayments.Message);

        var method = Fails(Cart(method: "\"paypal\""));
        Assert.Equal("Unknown payment method", method.Message);
        Assert.Equal("payments.0.method", Field(method));

        Assert.Equal("KHATA_NEEDS_CUSTOMER", Fails(Cart(method: "\"khata\"")).Code);
    }

    [Fact]
    public void Notes_are_trimmed_and_limited_like_optText()
    {
        Assert.Null(Commit(Cart(top: "\"note\": \"   \"")).Note);
        var kept = Commit(Cart(top: "\"note\": \"\\u00a0 nakad \\ufeff\"")); // NBSP and BOM are trimmed by JS trim()
        Assert.Equal("nakad", kept.Note);
        var tooLong = Fails(Cart(top: "\"note\": \"" + new string('x', 401) + "\""));
        Assert.Equal("note must be at most 400 characters", tooLong.Message);
        Assert.Equal("note must be text", Fails(Cart(top: "\"note\": 5")).Message);
    }

    // ---- policy: who may do what ---------------------------------------------------------------------------------------
    [Fact]
    public void Cashier_over_the_credit_limit_needs_approval_but_owner_and_manager_do_not()
    {
        var khata = Cart("3", amount: "150000", method: "\"khata\"", top: "\"customerId\": \"" + _fx.S.CustomerId + "\"");

        var e = Fails(khata);
        Assert.Equal("APPROVAL_REQUIRED", e.Code);
        Assert.Equal("credit_limit", e.Details!["reason"]);
        Assert.Equal(new[] { "credit_limit" }, Assert.IsType<List<string>>(e.Details["reasons"]).ToArray());
        Assert.Equal(0, _fx.Count("ledger_entries"));

        var inv = Commit(khata, _fx.S.OwnerId);
        Assert.Equal(150_000, inv.Total);
        Assert.Equal(150_000, _fx.Db.Query("SELECT SUM(amount) AS n FROM ledger_entries")[0].Lng("n"));
    }

    [Fact]
    public void Cashier_discount_limit_is_five_percent_exactly()
    {
        Commit(Cart("2", discount: "5000", amount: "95000")); // 5.00 % of 100000: allowed
        var e = Fails(Cart("2", discount: "5001", amount: "94999")); // one paisa more
        Assert.Equal("APPROVAL_REQUIRED", e.Code);
        Assert.Equal("discount", e.Details!["reason"]);
    }

    [Fact]
    public void An_approval_token_unlocks_one_sale_then_is_used_up_and_is_written_on_the_invoice()
    {
        var token = _fx.Approvals.Grant("manager");
        string Khata(string tok) => Cart("3", amount: "150000", method: "\"khata\"",
            top: "\"customerId\": \"" + _fx.S.CustomerId + "\", \"approvalToken\": \"" + tok + "\"");

        var inv = Commit(Khata(token));
        Assert.Equal("approved:manager", inv.Note);

        Assert.Equal("APPROVAL_REQUIRED", Fails(Khata(token)).Code); // single use
        Assert.Equal("APPROVAL_REQUIRED", Fails(Khata("not-a-token")).Code);
    }

    [Fact]
    public void An_expired_approval_token_is_refused()
    {
        var token = _fx.Approvals.Grant("manager");
        for (var i = 0; i < 61; i++) _fx.Now(); // each Now() call moves the fixture clock by 1 s; tokens live 60 s
        var e = Fails(Cart("3", amount: "150000", method: "\"khata\"",
            top: "\"customerId\": \"" + _fx.S.CustomerId + "\", \"approvalToken\": \"" + token + "\""));
        Assert.Equal("APPROVAL_REQUIRED", e.Code);
    }

    [Fact]
    public void Unknown_or_inactive_cashier_is_NOT_AUTHENTICATED()
    {
        Assert.Equal("NOT_AUTHENTICATED", Fails(Cart(), _fx.Ids.Next()).Code);
        Assert.Equal("NOT_AUTHENTICATED", Fails(Cart(), _fx.S.InactiveUserId).Code);
        Assert.Equal(0, _fx.Count("sales"));
    }

    // ---- licence ------------------------------------------------------------------------------------------------------
    [Fact]
    public void A_licence_block_stops_the_sale_and_writes_nothing()
    {
        _fx.Licence.Behaviour = (_, _, _) => throw new ServiceException(
            "LICENCE_BLOCKED", "Subscription locked", new Dictionary<string, object?> { ["state"] = "LOCKED" });
        var before = (_fx.Count("stock_movements"), _fx.Count("outbox"));

        var e = Fails(_fx.CashSaleOfChargers(1));
        Assert.Equal("LICENCE_BLOCKED", e.Code);
        Assert.Equal("LOCKED", e.Details!["state"]);
        Assert.Equal(0, _fx.Count("sales"));
        Assert.Equal(before, (_fx.Count("stock_movements"), _fx.Count("outbox")));
    }

    [Fact]
    public void A_plain_exception_from_the_licence_hook_becomes_INTERNAL_with_its_message()
    {
        _fx.Licence.Behaviour = (_, _, _) => throw new InvalidOperationException("licence store unreachable");
        var e = Fails(_fx.CashSaleOfChargers(1));
        Assert.Equal("INTERNAL", e.Code);
        Assert.Equal("licence store unreachable", e.Message);
        Assert.Equal(0, _fx.Count("sales"));
    }

    [Fact]
    public void The_licence_is_called_with_the_sale_action_and_the_invoice_time()
    {
        string? action = null;
        long at = 0;
        _fx.Licence.Behaviour = (a, _, now) => { action = a; at = now; };
        var inv = Commit(_fx.CashSaleOfChargers(1));
        Assert.Equal("sale", action);
        Assert.Equal(inv.CreatedAt, at);
    }

    // ---- concurrency --------------------------------------------------------------------------------------------------
    [Fact]
    public async Task Ten_simultaneous_sales_make_one_unbroken_chain_and_the_eleventh_finds_no_stock()
    {
        var sales = await Task.WhenAll(Enumerable.Range(0, 10).Select(_ => Task.Run(() => Commit(_fx.CashSaleOfChargers(1)))));

        var ordered = sales.OrderBy(s => s.Seq).ToList();
        Assert.Equal(Enumerable.Range(1, 10).Select(i => (long)i), ordered.Select(s => s.Seq));
        Assert.Equal(10, ordered.Select(s => s.InvoiceNo).Distinct().Count());
        for (var i = 0; i < ordered.Count; i++)
        {
            Assert.Equal(i == 0 ? InvoiceHasher.Genesis : ordered[i - 1].Hash, ordered[i].PrevHash);
            Assert.Equal(ordered[i].Hash, InvoiceHasher.Hash(ordered[i].PrevHash, ordered[i] with { Hash = "" }));
        }
        Assert.Equal(0, _fx.OnHandVariant());
        Assert.Equal("STOCK_INSUFFICIENT", Fails(_fx.CashSaleOfChargers(1)).Code);
    }
}
