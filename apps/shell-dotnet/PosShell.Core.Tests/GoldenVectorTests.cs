using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using PosShell.Core;
using Xunit;

namespace PosShell.Core.Tests;

/// <summary>Loads the JSON files that `npm run vectors` writes into /testdata (copied next to the test dll).</summary>
internal static class Vectors
{
    private static readonly Dictionary<string, JsonDocument> Cache = new();

    public static JsonElement Load(string file)
    {
        lock (Cache)
        {
            if (!Cache.TryGetValue(file, out var doc))
            {
                var path = Path.Combine(AppContext.BaseDirectory, "testdata", file);
                Cache[file] = doc = JsonDocument.Parse(File.ReadAllText(path, new UTF8Encoding(false)));
            }
            return doc.RootElement;
        }
    }

    public static TheoryData<string> Names(string file, string array)
    {
        var data = new TheoryData<string>();
        foreach (var v in Load(file).GetProperty(array).EnumerateArray()) data.Add(v.GetProperty("name").GetString()!);
        return data;
    }

    public static JsonElement ByName(string file, string array, string name) =>
        Load(file).GetProperty(array).EnumerateArray().Single(v => v.GetProperty("name").GetString() == name);
}

// ============================================================================================
// 1. Invoice hash: C# must reproduce the TypeScript canonical string and SHA-256 exactly
// ============================================================================================
public class InvoiceVectorTests
{
    private static readonly JsonSerializerOptions Json = new() { PropertyNameCaseInsensitive = true };

    public static TheoryData<string> Names() => Vectors.Names("invoice-vectors.json", "vectors");

    private static (Invoice Unsealed, string Prev, JsonElement Vector) Read(string name)
    {
        var v = Vectors.ByName("invoice-vectors.json", "vectors", name);
        var inv = v.GetProperty("unsealed_data").Deserialize<Invoice>(Json)!;
        return (inv, v.GetProperty("previous_hash").GetString()!, v);
    }

    [Theory]
    [MemberData(nameof(Names))]
    public void Canonical_string_and_hash_match_typescript(string name)
    {
        var (unsealed, prev, v) = Read(name);

        // Canonical first: when this fails, the diff shows exactly which character differs.
        Assert.Equal(v.GetProperty("canonical").GetString(), InvoiceHasher.Canonical(unsealed));
        Assert.Equal(v.GetProperty("expected_hash").GetString(), InvoiceHasher.Hash(prev, unsealed));
    }

    [Theory]
    [MemberData(nameof(Names))]
    public void Array_order_of_lines_and_payments_does_not_change_the_hash(string name)
    {
        var (unsealed, prev, _) = Read(name);
        var shuffled = unsealed with
        {
            Lines = unsealed.Lines.Reverse().ToList(),
            Payments = unsealed.Payments.Reverse().ToList(),
        };
        Assert.Equal(InvoiceHasher.Hash(prev, unsealed), InvoiceHasher.Hash(prev, shuffled));
    }

    [Theory]
    [MemberData(nameof(Names))]
    public void Changing_any_hashed_field_changes_the_hash(string name)
    {
        var (unsealed, prev, _) = Read(name);
        var baseline = InvoiceHasher.Hash(prev, unsealed);
        Assert.NotEqual(baseline, InvoiceHasher.Hash(prev, unsealed with { Note = (unsealed.Note ?? "") + "x" }));
        Assert.NotEqual(baseline, InvoiceHasher.Hash(prev, unsealed with { Total = unsealed.Total + 1 }));
        Assert.NotEqual(baseline, InvoiceHasher.Hash(InvoiceHasher.Genesis.Replace('0', '1'), unsealed));
    }

    [Fact]
    public void Vectors_form_one_chain_from_genesis()
    {
        var names = Vectors.Names("invoice-vectors.json", "vectors").Select(d => (string)d[0]!).ToList();
        Assert.True(names.Count >= 5);
        var prev = InvoiceHasher.Genesis;
        foreach (var name in names)
        {
            var (unsealed, vectorPrev, v) = Read(name);
            Assert.Equal(prev, vectorPrev);
            prev = InvoiceHasher.Seal(vectorPrev, unsealed).Hash;
            Assert.Equal(v.GetProperty("expected_hash").GetString(), prev);
        }
    }

    [Fact]
    public void The_default_json_encoder_would_have_broken_the_hash()
    {
        // Documents WHY CanonicalJson exists: System.Text.Json escapes Urdu and < > & ' by default.
        const string text = "نقد <a> & 'b'";
        Assert.NotEqual(CanonicalJson.Write(text), JsonSerializer.Serialize(text));
        Assert.Equal("\"" + text + "\"", CanonicalJson.Write(text));
    }
}

// ============================================================================================
// 2. intIn / optIntIn / money / optText: same input -> same result, code, field and message
// ============================================================================================
public class HelperVectorTests
{
    public static TheoryData<int> Indexes()
    {
        var data = new TheoryData<int>();
        var count = Vectors.Load("helper-vectors.json").GetProperty("cases").GetArrayLength();
        for (var i = 0; i < count; i++) data.Add(i);
        return data;
    }

    [Theory]
    [MemberData(nameof(Indexes))]
    public void Helper_behaves_like_typescript(int index)
    {
        var c = Vectors.Load("helper-vectors.json").GetProperty("cases")[index];
        var fn = c.GetProperty("fn").GetString()!;
        var a = c.GetProperty("args");
        var expect = c.GetProperty("expect");
        var label = c.GetProperty("name").GetString()!;

        JsonElement? v = a.TryGetProperty("v", out var ve) ? ve : null; // missing key == JS undefined
        var field = a.GetProperty("field").GetString()!;
        double Num(string key) => a.GetProperty(key).GetDouble();
        bool Flag(string key, bool dflt) => a.TryGetProperty(key, out var f) ? f.GetBoolean() : dflt;

        object? Run() => fn switch
        {
            "intIn" => Validate.IntIn(v, field, Num("min"), Num("max")),
            "optIntIn" => Validate.OptIntIn(v, field, Num("min"), Num("max")),
            "money" => Validate.Money(v, field, Flag("allowZero", true), Flag("allowNegative", false)),
            "optText" => Validate.OptText(v, field, (int)Num("max")),
            _ => throw new InvalidOperationException($"unknown helper {fn}"),
        };

        if (expect.GetProperty("ok").GetBoolean())
        {
            var want = expect.GetProperty("value");
            var got = Run();
            switch (want.ValueKind)
            {
                case JsonValueKind.Null: Assert.Null(got); break;
                case JsonValueKind.String: Assert.Equal(want.GetString(), (string?)got); break;
                case JsonValueKind.Number: Assert.Equal(want.GetInt64(), Convert.ToInt64(got)); break;
                default: Assert.Fail($"{label}: unexpected expected kind {want.ValueKind}"); break;
            }
        }
        else
        {
            var ex = Assert.Throws<ServiceException>(Run);
            Assert.Equal(expect.GetProperty("code").GetString(), ex.Code);
            Assert.Equal(expect.GetProperty("message").GetString(), ex.Message);
            var wantField = expect.GetProperty("field");
            var gotField = ex.Details is not null && ex.Details.TryGetValue("field", out var f) ? (string?)f : null;
            Assert.Equal(wantField.ValueKind == JsonValueKind.Null ? null : wantField.GetString(), gotField);
        }
    }

    [Fact]
    public void Discount_money_negative_is_DISCOUNT_INVALID_not_VALIDATION()
    {
        var neg = JsonDocument.Parse("-5").RootElement;
        var ex = Assert.Throws<ServiceException>(() => Validate.DiscountMoney(neg, "lines.0.discountAmount"));
        Assert.Equal("DISCOUNT_INVALID", ex.Code);
        var frac = JsonDocument.Parse("1.5").RootElement;
        Assert.Equal("MONEY_INVALID", Assert.Throws<ServiceException>(() => Validate.DiscountMoney(frac, "d")).Code);
        Assert.Equal(7, Validate.DiscountMoney(JsonDocument.Parse("7").RootElement, "d"));
    }

    [Fact]
    public void JsTrim_differs_from_dotnet_Trim_exactly_where_expected()
    {
        Assert.Equal("x", Validate.JsTrim("﻿x﻿")); // JS trims BOM ...
        Assert.Equal("﻿x﻿", "﻿x﻿".Trim()); // ... .NET does not
        Assert.Equal("\u0085x\u0085", Validate.JsTrim("\u0085x\u0085")); // JS keeps NEL ...
        Assert.Equal("x", "\u0085x\u0085".Trim()); // ... .NET trims it
    }
}

// ============================================================================================
// 3. UUID v7: structure + the TS generator replayed bit for bit
// ============================================================================================
public class UuidVectorTests
{
    public static TheoryData<string> Names() => Vectors.Names("uuid-vectors.json", "scenarios");

    [Theory]
    [MemberData(nameof(Names))]
    public void Generator_reproduces_typescript_ids(string name)
    {
        var s = Vectors.ByName("uuid-vectors.json", "scenarios", name);
        var count = s.GetProperty("count").GetInt32();
        var rng = s.GetProperty("rng");
        var fixedRng = rng.GetProperty("kind").GetString() == "fixed";
        var hasSeq = s.TryGetProperty("now_sequence", out var seq);
        var constant = s.TryGetProperty("now_constant", out var c) ? c.GetInt64() : 0;

        var index = 0;
        var call = 0;
        byte[] Random(int n)
        {
            if (fixedRng)
            {
                var two = rng.GetProperty("two");
                var bytes = new byte[n];
                if (n == 2) { bytes[0] = (byte)two[0].GetInt32(); bytes[1] = (byte)two[1].GetInt32(); }
                else Array.Fill(bytes, (byte)rng.GetProperty("fill").GetInt32());
                return bytes;
            }
            var recorded = rng.GetProperty("calls")[call++].EnumerateArray().Select(x => (byte)x.GetInt32()).ToArray();
            Assert.Equal(recorded.Length, n); // same call order as TS: randomBytes(2) only when the ms advanced
            return recorded;
        }

        var gen = new UuidV7Generator(() => hasSeq ? seq[index].GetInt64() : constant, Random);
        var ids = new List<string>(count);
        for (; index < count; index++) ids.Add(gen.Next());

        if (s.TryGetProperty("expected_ids", out var all))
            Assert.Equal(all.EnumerateArray().Select(x => x.GetString()!), ids);
        if (s.TryGetProperty("expected_samples", out var samples))
            foreach (var sample in samples.EnumerateArray())
                Assert.Equal(sample.GetProperty("id").GetString(), ids[sample.GetProperty("index").GetInt32()]);

        var sha = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(string.Join("\n", ids))));
        Assert.Equal(s.GetProperty("expected_ids_sha256").GetString(), sha);
        Assert.All(ids, id => Assert.True(UuidV7.IsValid(id), id));
    }

    [Theory]
    [InlineData("0199c82c-c000-720f-8227-c384325e4b88", true)]
    [InlineData("0199C82C-C000-720F-8227-C384325E4B88", false)] // upper case rejected, like TS
    [InlineData("0199c82c-c000-720f-8227-c384325e4b88\n", false)] // $ would accept this; \z must not
    [InlineData(" 0199c82c-c000-720f-8227-c384325e4b88", false)]
    [InlineData("0199c82c-c000-420f-8227-c384325e4b88", false)] // version 4
    [InlineData("0199c82c-c000-720f-c227-c384325e4b88", false)] // variant 11xx
    [InlineData("0199c82c-c000-720f-b227-c384325e4b88", true)] // variant 10xx ok
    [InlineData("0199c82cc000720f8227c384325e4b88", false)] // no dashes
    [InlineData("", false)]
    public void IsValid_matches_the_typescript_regex(string id, bool expected) =>
        Assert.Equal(expected, UuidV7.IsValid(id));

    [Fact]
    public void Ids_are_strictly_increasing_in_one_millisecond_and_when_the_clock_steps_back()
    {
        var times = new Queue<long>([5000, 5000, 5000, 4000, 4000, 6000]);
        var gen = new UuidV7Generator(() => times.Count > 1 ? times.Dequeue() : times.Peek());
        var ids = Enumerable.Range(0, 6).Select(_ => gen.Next()).ToList();
        Assert.Equal(ids.OrderBy(i => i, StringComparer.Ordinal).ToList(), ids);
        Assert.Equal(ids.Count, ids.Distinct().Count());
    }

    [Fact]
    public void Default_generator_is_valid_unique_monotonic_and_carries_the_clock()
    {
        var gen = new UuidV7Generator();
        var before = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var ids = Enumerable.Range(0, 20_000).Select(_ => gen.Next()).ToList();
        Assert.All(ids, id => Assert.True(UuidV7.IsValid(id), id));
        Assert.Equal(ids.Count, ids.Distinct().Count());
        Assert.Equal(ids.OrderBy(i => i, StringComparer.Ordinal).ToList(), ids);
        Assert.InRange(UuidV7.Timestamp(ids[0]), before, before + 5_000);
    }
}
