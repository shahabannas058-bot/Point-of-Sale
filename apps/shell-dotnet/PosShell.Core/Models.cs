namespace PosShell.Core;

/// <summary>Mirror of the TS ServiceError: the UI maps <see cref="Code"/> to its err.&lt;CODE&gt; translation.</summary>
public sealed class ServiceException(
    string code, string message, IReadOnlyDictionary<string, object?>? details = null, Exception? inner = null)
    : Exception(message, inner)
{
    public string Code { get; } = code;
    public IReadOnlyDictionary<string, object?>? Details { get; } = details;
}

public sealed record InvoiceLine(
    string Id, string SaleId, int LineNo, string ProductId, string? PhoneUnitId, string? VariantId,
    string Description, long Quantity, long UnitPrice, long CostPrice, long DiscountAmount, long LineTotal,
    long CreatedAt);

public sealed record InvoicePayment(
    string Id, string SaleId, string Method, long Amount, string? Reference, long CreatedAt);

/// <summary>An invoice. "Unsealed" = PrevHash/Hash not set yet (they are not part of the hashed payload).</summary>
public sealed record Invoice(
    string Id, string DeviceId, long Seq, string InvoiceNo, string Kind, string? OriginalSaleId,
    string BranchId, string? CustomerId, string CashierId, long Subtotal, long DiscountTotal, long Total,
    string? Note, long CreatedAt, int HashVersion, string PrevHash, string Hash,
    IReadOnlyList<InvoiceLine> Lines, IReadOnlyList<InvoicePayment> Payments);
