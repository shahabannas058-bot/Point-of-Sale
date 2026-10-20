using System.Text;
using System.Text.Json;
using PosShell.Core;
using Xunit;

namespace PosShell.Infrastructure.Tests;

public class MigrationTests
{
    private static string Temp() => Path.Combine(Path.GetTempPath(), $"pos-mig-{Guid.NewGuid():N}.db");

    private static void Cleanup(string file)
    {
        foreach (var suffix in new[] { "", "-wal", "-shm" })
            try { File.Delete(file + suffix); } catch (IOException) { }
    }

    private static List<string> Names(SqliteDatabase db, string type) =>
        db.Query("SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite_%' ORDER BY name", type)
            .Select(r => r.Str("name")).ToList();

    [Fact]
    public void A_missing_db_file_is_created_and_every_table_is_built()
    {
        var file = Temp();
        try
        {
            Assert.False(File.Exists(file));
            using (var db = DatabaseBootstrap.OpenAndMigrate(file))
            {
                Assert.True(File.Exists(file));
                var tables = Names(db, "table");
                string[] expected =
                [
                    "accessory_variants", "app_meta", "branches", "cash_entries", "customers", "day_closes",
                    "ledger_entries", "outbox", "payments",
                    "phone_units", "products", "purchases", "repair_parts", "repair_payments", "repair_status_history",
                    "repair_tickets", "sale_lines", "sales", "schema_migrations", "stock_batches", "stock_movements",
                    "suppliers", "users", "warranties",
                ];
                Assert.Equal(expected, tables); // 23 business tables + schema_migrations
                Assert.Contains("v_variant_on_hand", Names(db, "view"));
                Assert.True(Names(db, "trigger").Count >= 10, "immutability / chain triggers must exist");
            }
        }
        finally { Cleanup(file); }
    }

    [Fact]
    public void Applying_twice_is_a_no_op_and_versions_are_contiguous()
    {
        var file = Temp();
        try
        {
            using var db = new SqliteDatabase(file);
            Assert.Equal(new[] { 1, 2, 3, 4, 5, 6, 7, 8 }, Migrator.Apply(db));
            Assert.Empty(Migrator.Apply(db));
            Assert.Equal(8, db.Query("SELECT COUNT(*) AS n FROM schema_migrations")[0].Lng("n"));
        }
        finally { Cleanup(file); }
    }

    [Fact]
    public void Checksums_equal_the_typescript_migrator()
    {
        var path = Path.Combine(AppContext.BaseDirectory, "testdata", "migration-checksums.json");
        using var doc = JsonDocument.Parse(File.ReadAllText(path, new UTF8Encoding(false)));
        var golden = doc.RootElement.GetProperty("migrations").EnumerateArray().ToList();

        var embedded = Migrator.LoadEmbedded();
        Assert.Equal(golden.Count, embedded.Count);
        for (var i = 0; i < golden.Count; i++)
        {
            Assert.Equal(golden[i].GetProperty("version").GetInt32(), embedded[i].Version);
            Assert.Equal(golden[i].GetProperty("name").GetString(), embedded[i].Name);
            Assert.Equal(golden[i].GetProperty("checksum").GetString(), Migrator.Checksum(embedded[i].Sql));
        }
    }

    [Fact]
    public void A_modified_migration_is_rejected()
    {
        var file = Temp();
        try
        {
            using var db = DatabaseBootstrap.OpenAndMigrate(file);
            var tampered = Migrator.LoadEmbedded().ToList();
            tampered[1] = tampered[1] with { Sql = tampered[1].Sql + "\n-- sneaky edit" };
            var e = Assert.Throws<MigrationException>(() => Migrator.Apply(db, tampered));
            Assert.Equal("Migration 2 (stock) was modified after it was applied", e.Message);
        }
        finally { Cleanup(file); }
    }

    [Fact]
    public void A_database_newer_than_the_app_is_rejected()
    {
        var file = Temp();
        try
        {
            using var db = DatabaseBootstrap.OpenAndMigrate(file);
            var older = Migrator.LoadEmbedded().Take(2).ToList();
            var e = Assert.Throws<MigrationException>(() => Migrator.Apply(db, older));
            Assert.Contains("database is newer than the app", e.Message);
        }
        finally { Cleanup(file); }
    }

    [Fact]
    public void A_failing_migration_rolls_back_completely()
    {
        var file = Temp();
        try
        {
            using var db = new SqliteDatabase(file);
            var bad = new List<Migrator.Migration>
            {
                new(1, "good", "CREATE TABLE a (id INTEGER PRIMARY KEY) STRICT;"),
                new(2, "bad", "CREATE TABLE b (id INTEGER PRIMARY KEY) STRICT; CREATE TABLE b (id INTEGER) STRICT;"),
            };
            var e = Assert.Throws<MigrationException>(() => Migrator.Apply(db, bad));
            Assert.StartsWith("Migration 2 (bad) failed", e.Message);
            Assert.Contains("a", Names(db, "table"));       // migration 1 stays applied
            Assert.DoesNotContain("b", Names(db, "table")); // migration 2 left nothing behind
            Assert.Equal(1, db.Query("SELECT COUNT(*) AS n FROM schema_migrations")[0].Lng("n"));
        }
        finally { Cleanup(file); }
    }

    [Fact]
    public void Connection_settings_protect_the_shops_data()
    {
        using var t = new TempDb();
        long Pragma(string name) => t.Db.Query($"PRAGMA {name}")[0].Lng(name);
        Assert.Equal(1, Pragma("foreign_keys"));
        Assert.Equal(1, Pragma("recursive_triggers"));
        Assert.Equal(2, Pragma("synchronous")); // FULL
        Assert.Equal("wal", t.Db.Query("PRAGMA journal_mode")[0].Str("journal_mode"));
        Assert.Equal("ok", t.Db.QuickCheck());
    }

    [Fact]
    public void Data_survives_closing_and_reopening_the_file()
    {
        var file = Temp();
        try
        {
            using (var db = DatabaseBootstrap.OpenAndMigrate(file))
                db.Batch([new SqlStatement("INSERT INTO app_meta (key, value) VALUES (?, ?)", ["shop_name", "Al-Madina Mobile Centre"])]);
            using (var again = DatabaseBootstrap.OpenAndMigrate(file))
                Assert.Equal("Al-Madina Mobile Centre", again.Query("SELECT value FROM app_meta WHERE key = ?", "shop_name")[0].Str("value"));
        }
        finally { Cleanup(file); }
    }

    [Fact]
    public void A_file_that_is_not_a_database_is_refused_not_silently_replaced()
    {
        var file = Temp();
        try
        {
            File.WriteAllBytes(file, Enumerable.Range(0, 4096).Select(i => (byte)(i * 31)).ToArray());
            Assert.ThrowsAny<Exception>(() => DatabaseBootstrap.OpenAndMigrate(file));
            Assert.Equal(4096, new FileInfo(file).Length); // untouched, so a backup can be restored over it
        }
        finally { Cleanup(file); }
    }

    [Fact]
    public void Daily_backup_is_created_once_per_day_and_old_ones_are_pruned()
    {
        using var t = new TempDb();
        var dir = Path.Combine(Path.GetTempPath(), $"pos-bak-{Guid.NewGuid():N}");
        try
        {
            var first = DatabaseBootstrap.RunDailyBackup(t.Db, dir, keep: 2, today: new DateTime(2026, 10, 11));
            Assert.NotNull(first);
            Assert.Null(DatabaseBootstrap.RunDailyBackup(t.Db, dir, keep: 2, today: new DateTime(2026, 10, 11))); // same day
            DatabaseBootstrap.RunDailyBackup(t.Db, dir, keep: 2, today: new DateTime(2026, 10, 12));
            DatabaseBootstrap.RunDailyBackup(t.Db, dir, keep: 2, today: new DateTime(2026, 10, 13));

            Assert.Equal(new[] { "pos-2026-10-12.db", "pos-2026-10-13.db" },
                Directory.GetFiles(dir).Select(f => Path.GetFileName(f)).OrderBy(n => n, StringComparer.Ordinal).ToArray());

            using var restored = new SqliteDatabase(Path.Combine(dir, "pos-2026-10-13.db")); // a backup is a usable database
            Assert.Equal("ok", restored.QuickCheck());
            Assert.Equal(8, restored.Query("SELECT COUNT(*) AS n FROM schema_migrations")[0].Lng("n"));
        }
        finally { if (Directory.Exists(dir)) Directory.Delete(dir, recursive: true); }
    }

    [Fact]
    public void Immutability_triggers_surface_as_IMMUTABLE_RECORD_through_the_real_driver_message()
    {
        using var fx = new ShopFixture();
        fx.Sales.Commit(ShopFixture.Json(fx.CashSaleOfChargers(1)), fx.S.CashierId);

        var update = Assert.Throws<ServiceException>(() =>
            fx.Db.Batch([new SqlStatement("UPDATE sales SET note = ?", ["tamper"])]));
        Assert.Equal("IMMUTABLE_RECORD", update.Code);

        var delete = Assert.Throws<ServiceException>(() => fx.Db.Batch([new SqlStatement("DELETE FROM stock_movements")]));
        Assert.Equal("IMMUTABLE_RECORD", delete.Code);

        Assert.Equal("UNIT_NOT_IN_STOCK", Assert.Throws<ServiceException>(() => fx.Db.Batch([
            new SqlStatement("""
                INSERT INTO stock_movements (id, branch_id, type, phone_unit_id, quantity, created_by, created_at)
                VALUES (?, ?, 'purchase', ?, 1, ?, 1)
                """, [fx.Ids.Next(), fx.S.BranchId, fx.S.PhoneUnitId, fx.S.OwnerId])])).Code); // already on hand 1

        var dup = Assert.Throws<ServiceException>(() => fx.Db.Batch([
            new SqlStatement("UPDATE phone_units SET imei1 = (SELECT imei1 FROM phone_units WHERE id = ?) WHERE id = ?",
                [fx.S.PhoneUnitId, fx.S.SecondPhoneUnitId])]));
        Assert.Equal("DUPLICATE", dup.Code);
        Assert.Equal("imei1", dup.Details!["field"]);
    }
}
