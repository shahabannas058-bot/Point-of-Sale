using System.Text.Json;
using PosShell.Core;
using PosShell.Infrastructure;

namespace PosShell.Infrastructure.Tests;

/// <summary>A real SQLite file in the temp folder, migrated from the embedded .sql files, deleted afterwards.</summary>
internal sealed class TempDb : IDisposable
{
    public string FilePath { get; } = Path.Combine(Path.GetTempPath(), $"pos-test-{Guid.NewGuid():N}.db");

    public SqliteDatabase Db { get; }

    public TempDb() => Db = DatabaseBootstrap.OpenAndMigrate(FilePath);

    public void Dispose()
    {
        Db.Dispose();
        foreach (var suffix in new[] { "", "-wal", "-shm" })
            try { File.Delete(FilePath + suffix); } catch (IOException) { /* best effort */ }
    }
}

internal sealed record Seeded(
    string DeviceId, string BranchId, string OwnerId, string ManagerId, string CashierId, string InactiveUserId,
    string CustomerId, string InactiveCustomerId, string PhoneUnitId, string SecondPhoneUnitId, string VariantId,
    string InactiveVariantId);

internal sealed class RecordingLicence : ILicenceGuard
{
    public int Calls { get; private set; }
    public Action<string, string, long>? Behaviour { get; set; }

    /// <summary>Every batch the bridge asked about (db.batch), as the guard saw it.</summary>
    public List<IReadOnlyList<SqlStatement>> Writes { get; } = [];
    public Action<IReadOnlyList<SqlStatement>, long>? WriteBehaviour { get; set; }

    public void AssertCanSell(string action, string branchId, long nowMs)
    {
        Calls++;
        Behaviour?.Invoke(action, branchId, nowMs);
    }

    public void AssertCanWrite(IReadOnlyList<SqlStatement> statements, long nowMs)
    {
        Writes.Add(statements);
        WriteBehaviour?.Invoke(statements, nowMs);
    }
}

/// <summary>Everything a sale test needs: a migrated database with a small shop in it, and the service wired to it.</summary>
internal sealed class ShopFixture : IDisposable
{
    public const long Charger = 50_000;     // 500.00
    public const long PhonePrice = 199_950; // 1999.50
    public const long CreditLimit = 100_000;

    private readonly TempDb _store = new();
    private long _now = 1_760_000_000_000;

    public SqliteDatabase Db => _store.Db;
    public UuidV7Generator Ids { get; }
    public Seeded S { get; }
    public RecordingLicence Licence { get; } = new();
    public InMemoryApprovals Approvals { get; }
    public SalesService Sales { get; }

    /// <summary>Advances 1 s per call so created_at is strictly increasing and tests are reproducible.</summary>
    public long Now() => _now += 1_000;

    public ShopFixture()
    {
        Ids = new UuidV7Generator(() => 1_760_000_000_000 + Environment.TickCount64);
        Approvals = new InMemoryApprovals(() => _now);
        S = Seed();
        Sales = new SalesService(Db, Licence, Approvals, Ids, Now);
    }

    private Seeded Seed()
    {
        var s = new Seeded(
            DeviceId: Ids.Next(), BranchId: Ids.Next(), OwnerId: Ids.Next(), ManagerId: Ids.Next(), CashierId: Ids.Next(),
            InactiveUserId: Ids.Next(), CustomerId: Ids.Next(), InactiveCustomerId: Ids.Next(), PhoneUnitId: Ids.Next(),
            SecondPhoneUnitId: Ids.Next(), VariantId: Ids.Next(), InactiveVariantId: Ids.Next());
        var phoneProduct = Ids.Next();
        var accessoryProduct = Ids.Next();
        var t = Now();

        var batch = new List<SqlStatement>
        {
            new("INSERT INTO app_meta (key, value) VALUES (?, ?), (?, ?), (?, ?), (?, ?)",
                ["device_id", s.DeviceId, "branch_id", s.BranchId, "invoice_prefix", "A", "shop_name", "Test Shop"]),
            new("INSERT INTO branches (id, name, created_at) VALUES (?, ?, ?)", [s.BranchId, "Main", t]),
        };
        foreach (var (id, name, role, active) in new[]
                 {
                     (s.OwnerId, "owner", "owner", 1), (s.ManagerId, "manager", "manager", 1),
                     (s.CashierId, "cashier", "cashier", 1), (s.InactiveUserId, "gone", "cashier", 0),
                 })
            batch.Add(new("""
                INSERT INTO users (id, username, display_name, role, pin_hash, is_active, created_at, updated_at)
                VALUES (?, ?, ?, ?, 'x', ?, ?, ?)
                """, [id, name, name, role, active, t, t]));

        batch.Add(new("""
            INSERT INTO products (id, kind, brand, name, category, is_active, created_at, updated_at)
            VALUES (?, 'phone', 'Samsung', 'Galaxy A55', NULL, 1, ?, ?), (?, 'accessory', 'Anker', 'Charger', NULL, 1, ?, ?)
            """, [phoneProduct, t, t, accessoryProduct, t, t]));

        foreach (var (unit, imei) in new[] { (s.PhoneUnitId, "356938035643809"), (s.SecondPhoneUnitId, "356938035643817") })
            batch.Add(new("""
                INSERT INTO phone_units (id, product_id, imei1, colour, storage_gb, ram_gb, pta_status, condition,
                  cost_price, sale_price, created_at, updated_at)
                VALUES (?, ?, ?, 'Blue', 256, 8, 'approved', 'new', 150000, 199950, ?, ?)
                """, [unit, phoneProduct, imei, t, t]));

        foreach (var (variant, sku, active) in new[] { (s.VariantId, "CH-25", 1), (s.InactiveVariantId, "OLD-1", 0) })
            batch.Add(new("""
                INSERT INTO accessory_variants (id, product_id, sku, model, colour, cost_price, sale_price, reorder_level,
                  is_active, created_at, updated_at) VALUES (?, ?, ?, 'Universal', 'White', 30000, 50000, 3, ?, ?, ?)
                """, [variant, accessoryProduct, sku, active, t, t]));

        foreach (var (id, name, active, limit) in new (string, string, int, long?)[]
                 {
                     (s.CustomerId, "Bilal", 1, CreditLimit), (s.InactiveCustomerId, "Old customer", 0, null),
                 })
            batch.Add(new("""
                INSERT INTO customers (id, name, credit_limit, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
                """, [id, name, limit, active, t, t]));

        // opening stock: 10 chargers and the two phones, as 'purchase' movements (the ledger, not a counter)
        foreach (var (unit, variant, qty) in new (string?, string?, int)[]
                 {
                     (null, s.VariantId, 10), (s.PhoneUnitId, null, 1), (s.SecondPhoneUnitId, null, 1),
                 })
            batch.Add(new("""
                INSERT INTO stock_movements (id, branch_id, type, phone_unit_id, variant_id, quantity, created_by, created_at)
                VALUES (?, ?, 'purchase', ?, ?, ?, ?, ?)
                """, [Ids.Next(), s.BranchId, unit, variant, qty, s.OwnerId, t]));

        Db.Batch(batch);
        return s;
    }

    // ---- helpers for the tests ---------------------------------------------------------------------------------
    public static JsonElement Json(string json) => JsonDocument.Parse(json).RootElement;

    public long Count(string table) => Db.Query($"SELECT COUNT(*) AS n FROM {table}")[0].Lng("n");

    public long OnHandVariant() =>
        Db.Query("SELECT COALESCE(SUM(quantity), 0) AS n FROM stock_movements WHERE variant_id = ?", S.VariantId)[0].Lng("n");

    public long OnHandPhone(string unitId) =>
        Db.Query("SELECT COALESCE(SUM(quantity), 0) AS n FROM stock_movements WHERE phone_unit_id = ?", unitId)[0].Lng("n");

    public string CashSaleOfChargers(int quantity, string? saleId = null)
    {
        var idPart = saleId is null ? "" : "\"saleId\": \"" + saleId + "\", ";
        var amount = quantity * Charger;
        return $$"""
            { {{idPart}}"lines": [ { "variantId": "{{S.VariantId}}", "quantity": {{quantity}} } ],
              "payments": [ { "method": "cash", "amount": {{amount}} } ] }
            """;
    }

    public void Dispose() => _store.Dispose();
}
