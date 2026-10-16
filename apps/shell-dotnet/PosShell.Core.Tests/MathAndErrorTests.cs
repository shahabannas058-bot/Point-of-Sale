using System.Text.Json;
using Xunit;

namespace PosShell.Core.Tests;

/// <summary>Expected strings below were printed by node (String(n)) so they are what TypeScript would put in a message.</summary>
public class JsNumberTests
{
    [Theory]
    [InlineData(0d, "0")]
    [InlineData(5d, "5")]
    [InlineData(1.5, "1.5")]
    [InlineData(-3d, "-3")]
    [InlineData(10d, "10")]
    [InlineData(9007199254740992d, "9007199254740992")]
    [InlineData(1e21, "1e+21")]
    [InlineData(1e22, "1e+22")]
    [InlineData(123456789012345680000d, "123456789012345680000")]
    [InlineData(0.000001, "0.000001")]
    [InlineData(1e-7, "1e-7")]
    [InlineData(5e-324, "5e-324")]
    [InlineData(1.7976931348623157e308, "1.7976931348623157e+308")]
    [InlineData(12000000000000000d, "12000000000000000")]
    [InlineData(4e21, "4e+21")]
    [InlineData(-9007199254740992d, "-9007199254740992")]
    public void Matches_javascript_number_to_string(double value, string expected) =>
        Assert.Equal(expected, Validate.JsNumber(value));
}

public class PaisaMathTests
{
    private const long MaxSafe = 9_007_199_254_740_991;

    private static ServiceException Fails(Action a) => Assert.Throws<ServiceException>(a);

    [Fact]
    public void Add_and_Sub_leaving_the_safe_range_are_MONEY_INVALID_with_the_javascript_number_in_the_message()
    {
        var e = Fails(() => PaisaMath.Add(MaxSafe, 1));
        Assert.Equal("MONEY_INVALID", e.Code);
        Assert.Equal("Not a safe integer paisa amount: 9007199254740992", e.Message);
        Assert.Equal("Not a safe integer paisa amount: -9007199254740992", Fails(() => PaisaMath.Sub(-MaxSafe, 1)).Message);
        Assert.Equal(MaxSafe, PaisaMath.Add(MaxSafe - 1, 1));
    }

    [Fact]
    public void Mul_message_uses_double_arithmetic_like_javascript()
    {
        Assert.Equal("Not a safe integer paisa amount: 12000000000000000", Fails(() => PaisaMath.Mul(4_000_000_000_000_000, 3)).Message);
        Assert.Equal("Not a safe integer paisa amount: 4e+21", Fails(() => PaisaMath.Mul(4_000_000_000_000_000, 1_000_000)).Message);
        Assert.Equal(8_000_000_000_000_000, PaisaMath.Mul(4_000_000_000_000_000, 2));
    }

    [Fact]
    public void Sale_totals_are_exact_for_the_reference_cart()
    {
        // 2 chargers at 500.00 plus a phone at 1999.50 less 199.95 (same numbers as the TS fixtures)
        var t = PaisaMath.ComputeSaleTotals(
            [new PricedLine(2, 50_000, 0), new PricedLine(1, 199_950, 19_995)], 0);
        Assert.Equal(new long[] { 100_000, 179_955 }, t.LineTotals);
        Assert.Equal(279_955, t.Subtotal);
        Assert.Equal(279_955, t.Total);
    }

    [Fact]
    public void Returns_use_negative_quantities_and_negative_discounts()
    {
        var t = PaisaMath.ComputeSaleTotals([new PricedLine(-1, 199_950, -19_995)], -500);
        Assert.Equal(-179_955, t.Subtotal);
        Assert.Equal(-179_455, t.Total);
    }

    [Fact]
    public void Sale_total_rules_and_messages_match_typescript()
    {
        Assert.Equal("An invoice needs at least one line", Fails(() => PaisaMath.ComputeSaleTotals([], 0)).Message);
        Assert.Equal("All lines of an invoice must have the same sign",
            Fails(() => PaisaMath.ComputeSaleTotals([new PricedLine(1, 100, 0), new PricedLine(-1, 100, 0)], 0)).Message);
        Assert.Equal("Invalid quantity 0", Fails(() => PaisaMath.ComputeSaleTotals([new PricedLine(0, 100, 0)], 0)).Message);

        var line = Fails(() => PaisaMath.ComputeSaleTotals([new PricedLine(1, 100_000, 100_001)], 0));
        Assert.Equal("DISCOUNT_INVALID", line.Code);
        Assert.Equal("Line discount 100001 is outside 0..100000", line.Message);

        var invoice = Fails(() => PaisaMath.ComputeSaleTotals([new PricedLine(1, 1_000, 0)], 1_001));
        Assert.Equal("Invoice discount 1001 is outside 0..1000", invoice.Message);
    }

    [Fact]
    public void Payments_must_match_the_total_exactly()
    {
        PaisaMath.AssertPaymentsMatchTotal(1_000, [new PaymentPart("cash", 600), new PaymentPart("khata", 400)]);
        PaisaMath.AssertPaymentsMatchTotal(-1_000, [new PaymentPart("cash", -1_000)]);
        PaisaMath.AssertPaymentsMatchTotal(0, []);

        Assert.Equal("Payments sum to 999 paisa but total is 1000 paisa (difference 1)",
            Fails(() => PaisaMath.AssertPaymentsMatchTotal(1_000, [new PaymentPart("cash", 999)])).Message);
        Assert.Equal("Payment amount cannot be zero",
            Fails(() => PaisaMath.AssertPaymentsMatchTotal(1_000, [new PaymentPart("cash", 0)])).Message);
        Assert.Equal("Payment sign must match the invoice total",
            Fails(() => PaisaMath.AssertPaymentsMatchTotal(1_000, [new PaymentPart("cash", -1_000)])).Message);
        Assert.Equal("A zero-total invoice must have no payments",
            Fails(() => PaisaMath.AssertPaymentsMatchTotal(0, [new PaymentPart("cash", 1)])).Message);
        Assert.Equal("PAYMENT_MISMATCH",
            Fails(() => PaisaMath.AssertPaymentsMatchTotal(5, [new PaymentPart("cash", 4)])).Code);
    }

    [Theory]
    [InlineData(500, 10_000, 500, false)] // exactly 5.00 %
    [InlineData(501, 10_000, 500, true)]  // one paisa over
    [InlineData(0, 0, 500, false)]
    public void Discount_limit_comparison_is_exact(long discount, long gross, int bps, bool exceeds) =>
        Assert.Equal(exceeds, PaisaMath.ExceedsDiscountLimit(discount, gross, bps));
}

public class ErrorMapTests
{
    [Theory]
    [InlineData("SQLite Error 19: 'stock_movements: phone unit on-hand must stay within 0..1'.", "UNIT_NOT_IN_STOCK")]
    [InlineData("SQLite Error 19: 'sales: seq must be previous seq + 1 for this device'.", "CHAIN_CONFLICT")]
    [InlineData("SQLite Error 19: 'sales: prev_hash must equal the hash of the previous invoice'.", "CHAIN_CONFLICT")]
    [InlineData("SQLite Error 19: 'payments: khata requires a sale with a customer'.", "KHATA_NEEDS_CUSTOMER")]
    [InlineData("SQLite Error 19: 'sales: original_sale_id must reference a kind=sale invoice'.", "RETURN_NOT_ALLOWED")]
    [InlineData("SQLite Error 19: 'sales is immutable: corrections are return/void invoices'.", "IMMUTABLE_RECORD")]
    [InlineData("SQLite Error 19: 'ledger_entries is append-only: add an adjustment entry instead'.", "IMMUTABLE_RECORD")]
    [InlineData("SQLite Error 19: 'outbox: only attempts, last_error and sent_at may change'.", "IMMUTABLE_RECORD")]
    [InlineData("SQLite Error 19: 'FOREIGN KEY constraint failed'.", "NOT_FOUND")]
    [InlineData("SQLite Error 19: 'CHECK constraint failed: quantity <> 0'.", "DB_CONSTRAINT")]
    [InlineData("SQLite Error 19: 'NOT NULL constraint failed: users.pin_hash'.", "DB_CONSTRAINT")]
    [InlineData("something unforeseen", "INTERNAL")]
    public void Database_messages_map_to_the_same_codes_as_typescript(string message, string code) =>
        Assert.Equal(code, ErrorMap.FromDatabaseMessage(message).Code);

    [Fact]
    public void Unique_violation_exposes_table_and_field_but_not_the_raw_text()
    {
        var raw = new InvalidOperationException("SQLite Error 19: 'UNIQUE constraint failed: phone_units.imei1'.");
        var e = ErrorMap.FromDatabaseMessage(raw.Message, raw);
        Assert.Equal("DUPLICATE", e.Code);
        Assert.Equal("A record with the same value already exists", e.Message);
        Assert.Equal("phone_units", e.Details!["table"]);
        Assert.Equal("imei1", e.Details["field"]);
        Assert.Same(raw, e.InnerException); // the raw text is kept for the log only
    }

    [Fact]
    public void Unknown_exceptions_never_leak_their_text()
    {
        Assert.Equal("Unexpected internal error", ErrorMap.ToInfo(new InvalidOperationException("secret path C:\\x")).Message);
        Assert.Equal("VALIDATION", ErrorMap.ToInfo(new JsonException("bad")).Code);
        var s = ErrorMap.ToInfo(new ServiceException("STOCK_INSUFFICIENT", "Not enough stock",
            new Dictionary<string, object?> { ["onHand"] = 3L }));
        Assert.Equal("STOCK_INSUFFICIENT", s.Code);
        Assert.Equal(3L, s.Details!["onHand"]);
    }
}

public class ApprovalsAndPermissionsTests
{
    [Fact]
    public void Approval_tokens_expire_and_are_single_use()
    {
        long now = 1_000;
        var approvals = new InMemoryApprovals(() => now, ttlMs: 60_000);
        var token = approvals.Grant("manager");
        Assert.Equal("manager", approvals.Lookup(token));
        now += 59_999;
        Assert.Equal("manager", approvals.Lookup(token));
        approvals.Consume(token);
        Assert.Null(approvals.Lookup(token));

        var second = approvals.Grant("owner");
        now += 60_000; // expiresAt <= now counts as expired, like TS
        Assert.Null(approvals.Lookup(second));
        Assert.Null(approvals.Lookup(null));
        Assert.Null(approvals.Lookup("nope"));
    }

    [Theory]
    [InlineData("owner", true)]
    [InlineData("manager", true)]
    [InlineData("cashier", false)]
    public void Only_owner_and_manager_have_unlimited_discount(string role, bool expected)
    {
        Assert.Equal(expected, Permissions.HasDiscountUnlimited(role));
        Assert.True(Permissions.CanSell(role));
    }
}
