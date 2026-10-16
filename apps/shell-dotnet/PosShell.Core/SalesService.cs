using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace PosShell.Core;

/// <summary>
/// Port of checkout.commit (packages/db/src/service/checkout.ts): validate the cart, enforce stock / IMEI / credit /
/// discount rules, seal a hash-chained invoice and write it with its stock movements, khata ledger entry and outbox
/// rows in ONE transaction.
///
/// The input stays a <see cref="JsonElement"/> on purpose. TypeScript distinguishes "field missing" (undefined),
/// null, wrong type and fractional numbers, and each one maps to a different error code. Binding the JSON to a typed
/// DTO would collapse those cases. Every check below therefore goes through <see cref="Validate"/> and runs in the same
/// ORDER as the TS code, so a cart with several mistakes reports the same first error.
///
/// Known deviations from TS (all on input that the UI can never produce): a line/payment that is not a JSON object,
/// or an id field that is present but not a string, reports VALIDATION instead of TS's accidental TypeError/NOT_FOUND.
/// </summary>
public sealed class SalesService(
    IPosDb db, ILicenceGuard licence, IApprovals approvals, UuidV7Generator ids, Func<long>? clock = null)
{
    private static readonly HashSet<string> PaymentMethods =
        new(["cash", "khata", "jazzcash", "easypaisa", "bank_transfer", "card"], StringComparer.Ordinal);

    private static readonly JsonSerializerOptions OutboxJson = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
    private static readonly Regex InvoicePrefix = new(@"^[A-Z0-9]{1,4}\z", RegexOptions.CultureInvariant);
    private const int MaxChainRetries = 2;

    private readonly Func<long> _clock = clock ?? (() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());

    // ---- internal shapes -------------------------------------------------------------------------------------
    private sealed record Shop(string DeviceId, string BranchId, string Prefix, int MaxDiscountBps, bool AllowNegativeStock);
    private sealed record Cashier(string Id, string Role);
    private sealed record Customer(string Id, long? CreditLimit);
    private sealed record LineSpec(string ProductId, string? PhoneUnitId, string? VariantId, string Description,
        long Quantity, long UnitPrice, long CostPrice, long Discount);
    private sealed record Pay(string Method, long Amount, string? Reference);
    private sealed record Cart(IReadOnlyList<LineSpec> Items, long[] LineTotals, long Gross, long LineDiscounts,
        long Subtotal, long InvoiceDiscount, long Total, Customer? Customer, long Balance);

    /// <summary>input = the cart JSON from the UI (CommitSaleInput). cashierId = the logged-in user.</summary>
    public Invoice Commit(JsonElement input, string cashierId) => db.Exclusive(() => CommitLocked(input, cashierId));

    private Invoice CommitLocked(JsonElement input, string cashierId)
    {
        var cashier = LoadCashier(cashierId);                       // 1. session + permission
        var shop = LoadShop();
        if (input.ValueKind != JsonValueKind.Object) throw Validate.Invalid("input", "Invalid request");

        string? saleId = null;
        if (Prop(input, "saleId") is { } saleIdEl)
        {
            if (saleIdEl.ValueKind != JsonValueKind.String || !UuidV7.IsValid(saleIdEl.GetString()))
                throw Validate.Invalid("saleId", "saleId must be a UUID v7");
            saleId = saleIdEl.GetString();
        }
        var note = Validate.OptText(Prop(input, "note"), "note", 400);

        if (saleId is not null && LoadInvoice(saleId) is { } existing) return existing;   // 2. idempotency

        var cart = PriceCart(input, shop);                          // 3. cart + stock

        var payments = ParsePayments(input);                        // 4. payments, policy
        var khata = PaisaMath.Sum(payments.Where(p => p.Method == "khata").Select(p => p.Amount));
        if (khata > 0 && cart.Customer is null) throw new ServiceException("KHATA_NEEDS_CUSTOMER", "Khata needs a customer");
        PaisaMath.AssertPaymentsMatchTotal(cart.Total, payments.Select(p => new PaymentPart(p.Method, p.Amount)).ToList());

        var needed = new List<string>();
        if (!Permissions.HasDiscountUnlimited(cashier.Role))
        {
            if (PaisaMath.ExceedsDiscountLimit(PaisaMath.Add(cart.LineDiscounts, cart.InvoiceDiscount), cart.Gross, shop.MaxDiscountBps))
                needed.Add("discount");
            if (khata > 0 && cart.Customer?.CreditLimit is { } limit && PaisaMath.Add(cart.Balance, khata) > limit)
                needed.Add("credit_limit");
        }

        var token = Prop(input, "approvalToken") is { ValueKind: JsonValueKind.String } t ? t.GetString() : null;
        string? approvedBy = null;
        if (needed.Count > 0)
            approvedBy = approvals.Lookup(token) ?? throw new ServiceException(
                "APPROVAL_REQUIRED", "Manager approval is required",
                new Dictionary<string, object?> { ["reason"] = needed[0], ["reasons"] = needed });
        var finalNote = approvedBy is null ? note : (note is null ? $"approved:{approvedBy}" : $"{note} | approved:{approvedBy}");

        var invoice = WriteInvoice(shop, cashier.Id, saleId ?? ids.Next(), cart, payments, finalNote, khata);
        if (approvedBy is not null) approvals.Consume(token);       // only after the batch succeeded
        return invoice;
    }

    // ---- priceCart --------------------------------------------------------------------------------------------
    private Cart PriceCart(JsonElement input, Shop shop)
    {
        if (Prop(input, "lines") is not { ValueKind: JsonValueKind.Array } lines || lines.GetArrayLength() == 0)
            throw new ServiceException("EMPTY_CART", "The cart is empty");

        var invoiceDiscount = Prop(input, "invoiceDiscount") is { } idEl ? Validate.DiscountMoney(idEl, "invoiceDiscount") : 0;

        Customer? customer = null;
        long balance = 0;
        if (Prop(input, "customerId") is { } cEl && cEl.ValueKind != JsonValueKind.Null)
        {
            if (cEl.ValueKind != JsonValueKind.String) throw Validate.Invalid("customerId", "customerId must be text");
            var customerId = cEl.GetString()!;
            var row = db.Query("SELECT id, is_active, credit_limit FROM customers WHERE id = ?", customerId).FirstOrDefault()
                ?? throw new ServiceException("NOT_FOUND", "Customer not found", new Dictionary<string, object?> { ["id"] = customerId });
            if (row.Lng("is_active") == 0) throw new ServiceException("NOT_FOUND", "Customer not found");
            customer = new Customer(row.Str("id"), row.LngN("credit_limit"));
            balance = db.Query("SELECT COALESCE(SUM(amount), 0) AS n FROM ledger_entries WHERE customer_id = ?", customer.Id)[0].Lng("n");
        }

        // total requested per accessory variant across all lines (a variant may appear on several lines)
        var requested = new Dictionary<string, long>(StringComparer.Ordinal);
        foreach (var l in lines.EnumerateArray())
            if (l.ValueKind == JsonValueKind.Object && Prop(l, "variantId") is { ValueKind: JsonValueKind.String } v)
            {
                var key = v.GetString()!;
                requested[key] = requested.GetValueOrDefault(key) + (Validate.TryGetSafeInteger(Prop(l, "quantity"), out var q) ? q : 0);
            }

        var items = new List<LineSpec>();
        var usedUnits = new HashSet<string>(StringComparer.Ordinal);
        var cumulative = new Dictionary<string, long>(StringComparer.Ordinal);
        var idx = 0;
        foreach (var l in lines.EnumerateArray())
        {
            var lineNo = idx + 1;
            var field = $"lines.{idx}";
            idx++;
            if (l.ValueKind != JsonValueKind.Object) throw Validate.Invalid(field, "Each line must be an object");

            var phoneUnitId = OptId(l, "phoneUnitId", field);
            var variantId = OptId(l, "variantId", field);
            if ((phoneUnitId is null) == (variantId is null))
                throw Validate.Invalid(field, "Each line needs exactly one of phoneUnitId / variantId");
            var quantity = Validate.IntIn(Prop(l, "quantity"), $"{field}.quantity", 1, 1_000_000);
            var discountEl = Prop(l, "discountAmount");
            var discount = Validate.IsNullish(discountEl) ? 0 : Validate.DiscountMoney(discountEl, $"{field}.discountAmount");

            if (phoneUnitId is not null)
            {
                if (quantity != 1) throw Validate.Invalid($"{field}.quantity", "A phone unit is sold one at a time");
                var u = db.Query(
                        @"SELECT pu.product_id, pu.imei1, pu.serial, pu.colour, pu.ram_gb, pu.storage_gb, pu.sale_price, pu.cost_price,
                                 p.brand, p.name
                          FROM phone_units pu JOIN products p ON p.id = pu.product_id WHERE pu.id = ?", phoneUnitId).FirstOrDefault()
                    ?? throw new ServiceException("NOT_FOUND", "Phone unit not found", new Dictionary<string, object?> { ["lineNo"] = lineNo });
                var onHand = db.Query(
                    "SELECT COALESCE(SUM(quantity), 0) AS n FROM stock_movements WHERE phone_unit_id = ? AND branch_id = ?",
                    phoneUnitId, shop.BranchId)[0].Lng("n");
                if (usedUnits.Contains(phoneUnitId) || onHand != 1)
                    throw new ServiceException("UNIT_NOT_IN_STOCK", "This phone is not in stock",
                        new Dictionary<string, object?> { ["lineNo"] = lineNo, ["phoneUnitId"] = phoneUnitId });
                usedUnits.Add(phoneUnitId);

                var imei = u.StrN("imei1");
                var idText = imei is not null ? $"IMEI {imei}" : $"SN {u.StrN("serial") ?? ""}";
                var description = $"{PhoneLabel(u.Str("brand"), u.Str("name"), u.StrN("colour"), u.LngN("ram_gb"), u.LngN("storage_gb"))} · {idText}";
                items.Add(new LineSpec(u.Str("product_id"), phoneUnitId, null, Slice200(description), 1,
                    u.Lng("sale_price"), u.Lng("cost_price"), discount));
            }
            else
            {
                var v = db.Query(
                        @"SELECT av.id, av.product_id, av.model, av.colour, av.sale_price, av.cost_price, av.is_active, p.brand, p.name,
                                 COALESCE((SELECT SUM(sm.quantity) FROM stock_movements sm
                                           WHERE sm.variant_id = av.id AND sm.branch_id = ?), 0) AS on_hand
                          FROM accessory_variants av JOIN products p ON p.id = av.product_id WHERE av.id = ?",
                        shop.BranchId, variantId!).FirstOrDefault();
                if (v is null || v.Lng("is_active") == 0)
                    throw new ServiceException("NOT_FOUND", "Accessory not found", new Dictionary<string, object?> { ["lineNo"] = lineNo });

                var vid = v.Str("id");
                var cum = cumulative.GetValueOrDefault(vid) + quantity;
                cumulative[vid] = cum;
                if (!shop.AllowNegativeStock && cum > v.Lng("on_hand"))
                    throw new ServiceException("STOCK_INSUFFICIENT", "Not enough stock", new Dictionary<string, object?>
                    {
                        ["onHand"] = v.Lng("on_hand"),
                        ["requested"] = requested.TryGetValue(vid, out var r) ? r : cum,
                        ["lineNo"] = lineNo,
                    });
                items.Add(new LineSpec(v.Str("product_id"), null, vid,
                    Slice200(VariantLabel(v.Str("brand"), v.Str("name"), v.StrN("model"), v.StrN("colour"))), quantity,
                    v.Lng("sale_price"), v.Lng("cost_price"), discount));
            }
        }

        var totals = PaisaMath.ComputeSaleTotals(
            items.Select(i => new PricedLine(i.Quantity, i.UnitPrice, i.Discount)).ToList(), invoiceDiscount);
        return new Cart(items, totals.LineTotals,
            PaisaMath.Sum(items.Select(i => PaisaMath.Mul(i.UnitPrice, i.Quantity))),
            PaisaMath.Sum(items.Select(i => i.Discount)),
            totals.Subtotal, invoiceDiscount, totals.Total, customer, balance);
    }

    private static List<Pay> ParsePayments(JsonElement input)
    {
        if (Prop(input, "payments") is not { ValueKind: JsonValueKind.Array } arr)
            throw Validate.Invalid("payments", "payments are required");

        var result = new List<Pay>();
        var idx = 0;
        foreach (var p in arr.EnumerateArray())
        {
            var field = $"payments.{idx}";
            idx++;
            if (p.ValueKind != JsonValueKind.Object) throw Validate.Invalid(field, "Each payment must be an object");
            if (Prop(p, "method") is not { ValueKind: JsonValueKind.String } m || !PaymentMethods.Contains(m.GetString()!))
                throw Validate.Invalid($"{field}.method", "Unknown payment method");
            var amount = Validate.Money(Prop(p, "amount"), $"{field}.amount", allowZero: false);
            var reference = Validate.OptText(Prop(p, "reference"), $"{field}.reference", 100);
            result.Add(new Pay(m.GetString()!, amount, reference));
        }
        return result;
    }

    // ---- writeInvoice: head -> seal -> licence -> ONE atomic batch ------------------------------------------------
    private Invoice WriteInvoice(Shop shop, string cashierId, string saleId, Cart cart, IReadOnlyList<Pay> pays, string? note, long khata)
    {
        for (var attempt = 0; ; attempt++)
        {
            try
            {
                var head = db.Query("SELECT seq, hash, created_at FROM sales WHERE device_id = ? ORDER BY seq DESC LIMIT 1", shop.DeviceId).FirstOrDefault();
                var seq = (head?.Lng("seq") ?? 0) + 1;
                var prevHash = head?.Str("hash") ?? InvoiceHasher.Genesis;
                var createdAt = Math.Max(_clock(), head?.Lng("created_at") ?? 0);   // invoices never go back in time

                var lines = cart.Items.Select((it, i) => new InvoiceLine(ids.Next(), saleId, i + 1, it.ProductId, it.PhoneUnitId,
                    it.VariantId, it.Description, it.Quantity, it.UnitPrice, it.CostPrice, it.Discount, cart.LineTotals[i], createdAt)).ToList();
                var payments = pays.Select(p => new InvoicePayment(ids.Next(), saleId, p.Method, p.Amount, p.Reference, createdAt)).ToList();
                var unsealed = new Invoice(saleId, shop.DeviceId, seq, FormatInvoiceNo(shop.Prefix, seq), "sale", null, shop.BranchId,
                    cart.Customer?.Id, cashierId, cart.Subtotal, cart.InvoiceDiscount, cart.Total, note, createdAt, 1,
                    prevHash, "", lines, payments);
                var invoice = InvoiceHasher.Seal(prevHash, unsealed);

                CallLicence(shop.BranchId, createdAt);

                var batch = new List<SqlStatement>
                {
                    new("""
                        INSERT INTO sales (id, device_id, seq, invoice_no, kind, original_sale_id, branch_id, customer_id, cashier_id,
                          subtotal, discount_total, total, note, created_at, hash_version, prev_hash, hash)
                        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                        """,
                        [invoice.Id, invoice.DeviceId, invoice.Seq, invoice.InvoiceNo, invoice.Kind, invoice.OriginalSaleId, invoice.BranchId,
                         invoice.CustomerId, invoice.CashierId, invoice.Subtotal, invoice.DiscountTotal, invoice.Total, invoice.Note,
                         invoice.CreatedAt, invoice.HashVersion, invoice.PrevHash, invoice.Hash]),
                };
                foreach (var l in lines)
                    batch.Add(new("""
                        INSERT INTO sale_lines (id, sale_id, line_no, product_id, phone_unit_id, variant_id, description, quantity,
                          unit_price, cost_price, discount_amount, line_total, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
                        """,
                        [l.Id, l.SaleId, l.LineNo, l.ProductId, l.PhoneUnitId, l.VariantId, l.Description, l.Quantity,
                         l.UnitPrice, l.CostPrice, l.DiscountAmount, l.LineTotal, l.CreatedAt]));
                foreach (var p in payments)
                    batch.Add(new("INSERT INTO payments (id, sale_id, method, amount, reference, created_at) VALUES (?,?,?,?,?,?)",
                        [p.Id, p.SaleId, p.Method, p.Amount, p.Reference, p.CreatedAt]));
                Emit(batch, "sale", invoice.Id, invoice, createdAt);

                foreach (var l in lines)   // stock is a ledger: a sale appends -quantity
                {
                    var m = new
                    {
                        id = ids.Next(), branchId = shop.BranchId, type = "sale", phoneUnitId = l.PhoneUnitId, variantId = l.VariantId,
                        quantity = -l.Quantity, unitCost = (long?)l.CostPrice, refType = "sale", refId = invoice.Id,
                        reason = (string?)null, createdBy = cashierId, createdAt,
                    };
                    batch.Add(new("""
                        INSERT INTO stock_movements (id, branch_id, type, phone_unit_id, variant_id, quantity, unit_cost,
                          ref_type, ref_id, reason, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
                        """,
                        [m.id, m.branchId, m.type, m.phoneUnitId, m.variantId, m.quantity, m.unitCost, m.refType, m.refId, m.reason, m.createdBy, m.createdAt]));
                    Emit(batch, "stock_movement", m.id, m, createdAt);
                }

                if (khata != 0 && invoice.CustomerId is not null)
                {
                    var e = new
                    {
                        id = ids.Next(), customerId = invoice.CustomerId, supplierId = (string?)null, type = "sale_credit", amount = khata,
                        method = (string?)null, saleId = invoice.Id, purchaseId = (string?)null, note = (string?)null,
                        createdBy = cashierId, createdAt,
                    };
                    batch.Add(new("""
                        INSERT INTO ledger_entries (id, customer_id, supplier_id, type, amount, method, sale_id, purchase_id, note,
                          created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)
                        """,
                        [e.id, e.customerId, e.supplierId, e.type, e.amount, e.method, e.saleId, e.purchaseId, e.note, e.createdBy, e.createdAt]));
                    Emit(batch, "ledger_entry", e.id, e, createdAt);
                }

                db.Batch(batch);
                return invoice;
            }
            // Only a second writer can fork the chain; under our lock it cannot happen. Retry like TS does.
            catch (ServiceException e) when (e.Code == "CHAIN_CONFLICT" && attempt < MaxChainRetries)
            {
            }
        }
    }

    private void CallLicence(string branchId, long nowMs)
    {
        try { licence.AssertCanSell("sale", branchId, nowMs); }
        catch (ServiceException) { throw; }
        catch (Exception e) { throw new ServiceException("INTERNAL", e.Message, null, e); } // plain Error from the hook: INTERNAL + message
    }

    private void Emit(List<SqlStatement> batch, string entityType, string entityId, object payload, long at) =>
        batch.Add(new("INSERT INTO outbox (id, entity_type, entity_id, op, payload, created_at) VALUES (?,?,?,?,?,?)",
            [ids.Next(), entityType, entityId, "insert", JsonSerializer.Serialize(payload, OutboxJson), at]));

    // ---- reads -----------------------------------------------------------------------------------------------
    private Cashier LoadCashier(string id)
    {
        var u = db.Query("SELECT id, role FROM users WHERE id = ? AND is_active = 1", id).FirstOrDefault()
            ?? throw new ServiceException("NOT_AUTHENTICATED", "Login required");
        if (!Permissions.CanSell(u.Str("role")))
            throw new ServiceException("FORBIDDEN", "Permission required: sell", new Dictionary<string, object?> { ["permission"] = "sell" });
        return new Cashier(u.Str("id"), u.Str("role"));
    }

    private Shop LoadShop()
    {
        var meta = db.Query("SELECT key, value FROM app_meta").ToDictionary(r => r.Str("key"), r => r.Str("value"), StringComparer.Ordinal);
        if (!meta.TryGetValue("device_id", out var device) || !meta.TryGetValue("branch_id", out var branch)
            || !meta.TryGetValue("invoice_prefix", out var prefix))
            throw new ServiceException("NOT_SETUP", "Shop has not been set up yet");
        var bps = int.TryParse(meta.GetValueOrDefault("cashier_max_discount_bps"), NumberStyles.Integer, CultureInfo.InvariantCulture, out var b) ? b : 500;
        return new Shop(device, branch, prefix, bps, meta.GetValueOrDefault("allow_negative_stock") == "1");
    }

    private Invoice? LoadInvoice(string id)
    {
        var s = db.Query("SELECT * FROM sales WHERE id = ?", id).FirstOrDefault();
        if (s is null) return null;
        var lines = db.Query("SELECT * FROM sale_lines WHERE sale_id = ? ORDER BY line_no", id).Select(l => new InvoiceLine(
            l.Str("id"), l.Str("sale_id"), (int)l.Lng("line_no"), l.Str("product_id"), l.StrN("phone_unit_id"), l.StrN("variant_id"),
            l.Str("description"), l.Lng("quantity"), l.Lng("unit_price"), l.Lng("cost_price"), l.Lng("discount_amount"),
            l.Lng("line_total"), l.Lng("created_at"))).ToList();
        var pays = db.Query("SELECT * FROM payments WHERE sale_id = ? ORDER BY id", id).Select(p => new InvoicePayment(
            p.Str("id"), p.Str("sale_id"), p.Str("method"), p.Lng("amount"), p.StrN("reference"), p.Lng("created_at"))).ToList();
        return new Invoice(s.Str("id"), s.Str("device_id"), s.Lng("seq"), s.Str("invoice_no"), s.Str("kind"), s.StrN("original_sale_id"),
            s.Str("branch_id"), s.StrN("customer_id"), s.Str("cashier_id"), s.Lng("subtotal"), s.Lng("discount_total"), s.Lng("total"),
            s.StrN("note"), s.Lng("created_at"), (int)s.Lng("hash_version"), s.Str("prev_hash"), s.Str("hash"), lines, pays);
    }

    // ---- helpers -----------------------------------------------------------------------------------------------
    /// <summary>Property of a JSON object, or null when the key is absent (JS undefined). A present JSON null is returned as Null.</summary>
    private static JsonElement? Prop(JsonElement obj, string name) =>
        obj.ValueKind == JsonValueKind.Object && obj.TryGetProperty(name, out var v) ? v : null;

    private static string? OptId(JsonElement line, string name, string field)
    {
        if (Prop(line, name) is not { } el) return null;
        return el.ValueKind == JsonValueKind.String ? el.GetString() : throw Validate.Invalid($"{field}.{name}", $"{name} must be text");
    }

    private static string FormatInvoiceNo(string prefix, long seq)
    {
        if (!InvoicePrefix.IsMatch(prefix) || seq < 1)
            throw new ServiceException("INTERNAL", "Unexpected internal error");
        return $"{prefix}-{seq.ToString("D6", CultureInfo.InvariantCulture)}";
    }

    private static string Join(string separator, params string?[] parts) =>
        string.Join(separator, parts.Where(p => !string.IsNullOrEmpty(p)));

    private static string PhoneLabel(string brand, string name, string? colour, long? ramGb, long? storageGb)
    {
        var mem = ramGb is not null && storageGb is not null ? $"{ramGb}/{storageGb}GB" : storageGb is not null ? $"{storageGb}GB" : null;
        var extra = Join(", ", colour, mem);
        return Join(" ", $"{brand} {name}", extra == "" ? null : $"({extra})");
    }

    private static string VariantLabel(string brand, string name, string? model, string? colour)
    {
        var extra = Join(", ", model, colour);
        return Join(" ", $"{brand} {name}", extra == "" ? null : $"({extra})");
    }

    /// <summary>JS .slice(0, 200): counts UTF-16 code units, may cut a surrogate pair, exactly like TS.</summary>
    private static string Slice200(string s) => s.Length > 200 ? s[..200] : s;
}
