using System.Security.Cryptography;
using System.Text;

namespace PosShell.Core;

/// <summary>Port of invoiceHashPayload / computeInvoiceHash (packages/core/src/invoice-chain.ts), hash version 1.</summary>
public static class InvoiceHasher
{
    public static readonly string Genesis = new('0', 64);
    private const string Domain = "pos.invoice.v1";

    /// <summary>The canonical JSON that gets hashed. Lines are sorted by lineNo, payments by id (ordinal).</summary>
    public static string Canonical(Invoice inv)
    {
        var lines = inv.Lines.OrderBy(l => l.LineNo).Select(l => (object?)new Dictionary<string, object?>
        {
            ["id"] = l.Id,
            ["lineNo"] = l.LineNo,
            ["productId"] = l.ProductId,
            ["phoneUnitId"] = l.PhoneUnitId,
            ["variantId"] = l.VariantId,
            ["description"] = l.Description,
            ["quantity"] = l.Quantity,
            ["unitPrice"] = l.UnitPrice,
            ["costPrice"] = l.CostPrice,
            ["discountAmount"] = l.DiscountAmount,
            ["lineTotal"] = l.LineTotal,
            ["createdAt"] = l.CreatedAt,
        }).ToList();

        var payments = inv.Payments.OrderBy(p => p.Id, StringComparer.Ordinal).Select(p => (object?)new Dictionary<string, object?>
        {
            ["id"] = p.Id,
            ["method"] = p.Method,
            ["amount"] = p.Amount,
            ["reference"] = p.Reference,
            ["createdAt"] = p.CreatedAt,
        }).ToList();

        var payload = new Dictionary<string, object?>
        {
            ["v"] = inv.HashVersion,
            ["id"] = inv.Id,
            ["deviceId"] = inv.DeviceId,
            ["seq"] = inv.Seq,
            ["invoiceNo"] = inv.InvoiceNo,
            ["kind"] = inv.Kind,
            ["originalSaleId"] = inv.OriginalSaleId,
            ["branchId"] = inv.BranchId,
            ["customerId"] = inv.CustomerId,
            ["cashierId"] = inv.CashierId,
            ["subtotal"] = inv.Subtotal,
            ["discountTotal"] = inv.DiscountTotal,
            ["total"] = inv.Total,
            ["note"] = inv.Note,
            ["createdAt"] = inv.CreatedAt,
            ["lines"] = lines,
            ["payments"] = payments,
        };
        return CanonicalJson.Write(payload);
    }

    public static string Hash(string prevHash, Invoice inv)
    {
        var text = $"{Domain}\n{prevHash}\n{Canonical(inv)}";
        return Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(text)));
    }

    public static Invoice Seal(string prevHash, Invoice unsealed) =>
        unsealed with { PrevHash = prevHash, Hash = Hash(prevHash, unsealed) };
}
