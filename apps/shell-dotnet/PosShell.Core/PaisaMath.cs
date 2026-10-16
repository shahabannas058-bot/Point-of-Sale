namespace PosShell.Core;

public sealed record PricedLine(long Quantity, long UnitPrice, long DiscountAmount);

public sealed record PaymentPart(string Method, long Amount);

public sealed record SaleTotals(long[] LineTotals, long Subtotal, long Total);

/// <summary>
/// Port of the money math a sale needs (packages/core/src/money.ts). Amounts are integer paisa in a <see cref="long"/>.
/// Error codes AND messages match the TypeScript DomainErrors. JavaScript computes in doubles, so when a result leaves
/// the safe-integer range the message prints the *double* result (via <see cref="Validate.JsNumber"/>), exactly like
/// String(n) does in TS.
/// </summary>
public static class PaisaMath
{
    private const long MaxSafe = 9_007_199_254_740_991; // Number.MAX_SAFE_INTEGER

    private static ServiceException MoneyInvalid(string message) => new("MONEY_INVALID", message);

    private static ServiceException Unsafe(double n) =>
        MoneyInvalid($"Not a safe integer paisa amount: {Validate.JsNumber(n)}");

    /// <summary>paisa(n): n must be a safe integer.</summary>
    public static long Check(long n) => n is >= -MaxSafe and <= MaxSafe ? n : throw Unsafe(n);

    public static long Add(long a, long b) => Narrow((Int128)a + b, (double)a + b);

    public static long Sub(long a, long b) => Narrow((Int128)a - b, (double)a - b);

    /// <summary>mulPaisa(a, quantity).</summary>
    public static long Mul(long a, long quantity)
    {
        if (quantity is < -MaxSafe or > MaxSafe)
            throw MoneyInvalid($"Quantity must be an integer: {Validate.JsNumber(quantity)}");
        return Narrow((Int128)a * quantity, (double)a * quantity);
    }

    public static long Sum(IEnumerable<long> values) => values.Aggregate(0L, Add);

    private static long Narrow(Int128 exact, double asJavaScript) =>
        exact < -MaxSafe || exact > MaxSafe ? throw Unsafe(asJavaScript) : (long)exact;

    /// <summary>A discount may not exceed the gross it applies to, in the gross's direction (sales 0..gross, returns gross..0).</summary>
    private static void AssertDiscountWithin(long discount, long gross, string label)
    {
        var ok = gross >= 0 ? discount >= 0 && discount <= gross : discount <= 0 && discount >= gross;
        if (!ok)
            throw new ServiceException("DISCOUNT_INVALID", $"{label} discount {discount} is outside 0..{gross}");
    }

    public static long LineTotal(PricedLine line)
    {
        if (line.Quantity == 0 || line.Quantity is < -MaxSafe or > MaxSafe)
            throw MoneyInvalid($"Invalid quantity {Validate.JsNumber(line.Quantity)}");
        var gross = Mul(line.UnitPrice, line.Quantity);
        AssertDiscountWithin(line.DiscountAmount, gross, "Line");
        return Sub(gross, line.DiscountAmount);
    }

    public static SaleTotals ComputeSaleTotals(IReadOnlyList<PricedLine> lines, long invoiceDiscount)
    {
        if (lines.Count == 0) throw MoneyInvalid("An invoice needs at least one line");
        var sign = Math.Sign(lines[0].Quantity);
        if (lines.Any(l => Math.Sign(l.Quantity) != sign))
            throw MoneyInvalid("All lines of an invoice must have the same sign");

        var lineTotals = lines.Select(LineTotal).ToArray();
        var subtotal = Sum(lineTotals);
        AssertDiscountWithin(invoiceDiscount, subtotal, "Invoice");
        return new SaleTotals(lineTotals, subtotal, Sub(subtotal, invoiceDiscount));
    }

    /// <summary>Payments (cash / khata / split) must sum EXACTLY to the invoice total, same sign, no zero parts.</summary>
    public static void AssertPaymentsMatchTotal(long total, IReadOnlyList<PaymentPart> payments)
    {
        static ServiceException Mismatch(string m) => new("PAYMENT_MISMATCH", m);

        if (total == 0 && payments.Count > 0) throw Mismatch("A zero-total invoice must have no payments");
        long paid = 0;
        foreach (var p in payments)
        {
            if (p.Amount == 0) throw Mismatch("Payment amount cannot be zero");
            if (Math.Sign(p.Amount) != Math.Sign(total)) throw Mismatch("Payment sign must match the invoice total");
            paid = Add(paid, p.Amount);
        }
        if (paid != total)
            throw Mismatch($"Payments sum to {paid} paisa but total is {total} paisa (difference {total - paid})");
    }

    /// <summary>Exact comparison discount/gross &gt; maxBps/10000 (no floor: 1 paisa over the limit counts). Int128, like BigInt in TS.</summary>
    public static bool ExceedsDiscountLimit(long discount, long gross, int maxBps) =>
        (Int128)discount * 10_000 > (Int128)maxBps * gross;
}
