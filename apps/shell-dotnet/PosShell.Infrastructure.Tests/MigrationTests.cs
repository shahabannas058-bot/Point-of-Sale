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
                    "app_meta", "branches", "cash_entries", "customers", "day_closes", "items",
                    "ledger_entries", "outbox", "payments", "products", "purchases",
                    "sale_lines", "sales", "schema_migrations", "stock_batches", "stock_movements",
                    "suppliers", "users",
                ];
                Assert.Equal(expected, tables); // 17 business tables + schema_migrations (0009 dropped the mobile-shop ones)
                var views = Names(db, "view");
                Assert.Contains("v_item_on_hand", views);
                Assert.Contains("v_sale_line_mismatch", views);
                Assert.DoesNotContain("v_variant_on_hand", views);
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
            Assert.Equal(new[] { 1, 2, 3, 4, 5, 6, 7, 8, 9 }, Migrator.Apply(db));
            Assert.Empty(Migrator.Apply(db));
            Assert.Equal(9, db.Query("SELECT COUNT(*) AS n FROM schema_migrations")[0].Lng("n"));
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
            Assert.Equal(9, restored.Query("SELECT COUNT(*) AS n FROM schema_migrations")[0].Lng("n"));
        }
        finally { if (Directory.Exists(dir)) Directory.Delete(dir, recursive: true); }
    }

    [Fact]
    public void A_new_backup_survives_rotation_after_the_pc_clock_jumps_back()
    {
        using var t = new TempDb();
        var dir = Path.Combine(Path.GetTempPath(), $"pos-bak-{Guid.NewGuid():N}");
        try
        {
            DatabaseBootstrap.RunDailyBackup(t.Db, dir, keep: 2, today: new DateTime(2026, 10, 12));
            DatabaseBootstrap.RunDailyBackup(t.Db, dir, keep: 2, today: new DateTime(2026, 10, 13));

            // the clock went back (dead CMOS battery): today's file sorts before the others by name
            var created = DatabaseBootstrap.RunDailyBackup(t.Db, dir, keep: 2, today: new DateTime(2026, 10, 1));

            Assert.NotNull(created);
            Assert.True(File.Exists(created));
            Assert.Equal(new[] { "pos-2026-10-01.db", "pos-2026-10-13.db" },
                Directory.GetFiles(dir).Select(f => Path.GetFileName(f)).OrderBy(n => n, StringComparer.Ordinal).ToArray());
        }
        finally { if (Directory.Exists(dir)) Directory.Delete(dir, recursive: true); }
    }

    [Fact]
    public void An_existing_database_is_backed_up_before_it_is_upgraded_and_a_new_one_is_not()
    {
        var file = Path.Combine(Path.GetTempPath(), $"pos-up-{Guid.NewGuid():N}.db");
        var dir = Path.Combine(Path.GetTempPath(), $"pos-bak-{Guid.NewGuid():N}");
        try
        {
            using (DatabaseBootstrap.OpenAndMigrate(file, dir)) { }
            Assert.False(Directory.Exists(dir) && Directory.GetFiles(dir).Length > 0); // nothing to protect yet
            Cleanup(file);

            using (var old = new SqliteDatabase(file)) Migrator.Apply(old, Migrator.LoadEmbedded().Take(8).ToList());

            using (var upgraded = DatabaseBootstrap.OpenAndMigrate(file, dir, new DateTime(2026, 11, 22, 10, 15, 0)))
                Assert.Equal(9, upgraded.Query("SELECT COUNT(*) AS n FROM schema_migrations")[0].Lng("n"));

            var backup = Assert.Single(Directory.GetFiles(dir));
            Assert.Equal("premigrate-v0009-20261122-101500.db", Path.GetFileName(backup));
            using var copy = new SqliteDatabase(backup);
            Assert.Equal(8, copy.Query("SELECT COUNT(*) AS n FROM schema_migrations")[0].Lng("n")); // the data as it was
        }
        finally
        {
            Cleanup(file);
            if (Directory.Exists(dir)) Directory.Delete(dir, recursive: true);
        }
    }

    [Fact]
    public void Only_the_newest_pre_upgrade_copies_are_kept()
    {
        using var t = new TempDb();
        var dir = Path.Combine(Path.GetTempPath(), $"pos-bak-{Guid.NewGuid():N}");
        try
        {
            for (var i = 0; i < DatabaseBootstrap.KeepPremigrate + 2; i++)
                DatabaseBootstrap.BackupBeforeUpgrade(t.Db, dir, 9, new DateTime(2026, 11, 1 + i, 9, 0, 0));
            File.WriteAllText(Path.Combine(dir, "premigrate-notes.db"), "not ours"); // a name we did not write stays

            var names = Directory.GetFiles(dir).Select(f => Path.GetFileName(f)).OrderBy(n => n, StringComparer.Ordinal).ToList();
            Assert.Equal(DatabaseBootstrap.KeepPremigrate + 1, names.Count);
            Assert.Contains("premigrate-notes.db", names);
            Assert.DoesNotContain("premigrate-v0009-20261101-090000.db", names);
            Assert.Contains("premigrate-v0009-20261107-090000.db", names);
        }
        finally { if (Directory.Exists(dir)) Directory.Delete(dir, recursive: true); }
    }

    [Fact]
    public void Immutability_triggers_surface_as_IMMUTABLE_RECORD_through_the_real_driver_message()
    {
        using var fx = new ShopFixture();
        // one invoice, written the way the TypeScript service writes it through db.batch
        fx.Db.Batch([new SqlStatement("""
            INSERT INTO sales (id, device_id, seq, invoice_no, kind, branch_id, cashier_id, subtotal, discount_total, total,
              created_at, hash_version, prev_hash, hash) VALUES (?, ?, 1, 'A-000001', 'sale', ?, ?, 50000, 0, 50000, ?, 2, ?, ?)
            """,
            [fx.Ids.Next(), fx.S.DeviceId, fx.S.BranchId, fx.S.CashierId, fx.Now(), InvoiceHasher.Genesis, new string('a', 64)])]);

        var update = Assert.Throws<ServiceException>(() =>
            fx.Db.Batch([new SqlStatement("UPDATE sales SET note = ?", ["tamper"])]));
        Assert.Equal("IMMUTABLE_RECORD", update.Code);

        var delete = Assert.Throws<ServiceException>(() => fx.Db.Batch([new SqlStatement("DELETE FROM stock_movements")]));
        Assert.Equal("IMMUTABLE_RECORD", delete.Code);

        var dup = Assert.Throws<ServiceException>(() => fx.Db.Batch([
            new SqlStatement("UPDATE items SET sku = (SELECT sku FROM items WHERE id = ?) WHERE id = ?",
                [fx.S.ItemId, fx.S.CableItemId])]));
        Assert.Equal("DUPLICATE", dup.Code);
        Assert.Equal("sku", dup.Details!["field"]);
    }
}
