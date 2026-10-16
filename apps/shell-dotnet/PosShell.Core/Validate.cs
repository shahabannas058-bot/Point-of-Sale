using System.Globalization;
using System.Text.Json;

namespace PosShell.Core;

/// <summary>
/// C# twins of intIn / optIntIn / money / optText (packages/db/src/service/errors.ts) and discountMoney (checkout.ts).
/// Inputs are <see cref="JsonElement"/>? because TypeScript sees JSON values: null (C#) == undefined (field not sent),
/// JsonValueKind.Null == JSON null. Error codes, messages and details match the TS ones character for character.
/// </summary>
public static class Validate
{
    private const double MaxSafe = 9_007_199_254_740_991d; // Number.MAX_SAFE_INTEGER

    public static ServiceException Invalid(string field, string message) =>
        new("VALIDATION", message, new Dictionary<string, object?> { ["field"] = field });

    /// <summary>Number.isSafeInteger(v): must be a JSON number (typeof v === 'number'), whole, |v| &lt;= 2^53-1.</summary>
    public static bool TryGetSafeInteger(JsonElement? v, out long n)
    {
        n = 0;
        if (v is not { ValueKind: JsonValueKind.Number } e) return false;
        if (!e.TryGetDouble(out var d) || double.IsNaN(d) || double.IsInfinity(d)) return false;
        if (Math.Floor(d) != d || Math.Abs(d) > MaxSafe) return false; // "3.0" is fine, as in JS
        n = (long)d;
        return true;
    }

    /// <summary>intIn: a safe integer within [min, max], else VALIDATION.</summary>
    public static long IntIn(JsonElement? v, string field, double min, double max)
    {
        if (!TryGetSafeInteger(v, out var n) || n < min || n > max)
            throw Invalid(field, $"{field} must be an integer between {JsNumber(min)} and {JsNumber(max)}");
        return n;
    }

    /// <summary>optIntIn: undefined / null -> null, otherwise intIn.</summary>
    public static long? OptIntIn(JsonElement? v, string field, double min, double max) =>
        IsNullish(v) ? null : IntIn(v, field, min, max);

    /// <summary>
    /// money: integer paisa. Non-integers -> MONEY_INVALID; negatives (unless allowed) and zero (when
    /// allowZero=false) -> VALIDATION.
    /// </summary>
    public static long Money(JsonElement? v, string field, bool allowZero = true, bool allowNegative = false)
    {
        if (!TryGetSafeInteger(v, out var n))
            throw new ServiceException(
                "MONEY_INVALID", $"{field} must be a whole number of paisa",
                new Dictionary<string, object?> { ["field"] = field });
        if (n < 0 && !allowNegative) throw Invalid(field, $"{field} must not be negative");
        if (n == 0 && !allowZero) throw Invalid(field, $"{field} must be greater than zero");
        return n;
    }

    /// <summary>discountMoney (checkout.ts): a negative whole number is DISCOUNT_INVALID, anything else follows money().</summary>
    public static long DiscountMoney(JsonElement? v, string field)
    {
        if (TryGetSafeInteger(v, out var n) && n < 0)
            throw new ServiceException(
                "DISCOUNT_INVALID", $"{field} must not be negative",
                new Dictionary<string, object?> { ["field"] = field });
        return Money(v, field);
    }

    /// <summary>optText: undefined / null / blank -> null; trims like JS String.prototype.trim; length in UTF-16 units.</summary>
    public static string? OptText(JsonElement? v, string field, int max)
    {
        if (IsNullish(v)) return null;
        if (v!.Value.ValueKind != JsonValueKind.String) throw Invalid(field, $"{field} must be text");
        var t = JsTrim(v.Value.GetString() ?? "");
        if (t.Length == 0) return null;
        if (t.Length > max) throw Invalid(field, $"{field} must be at most {max} characters");
        return t;
    }

    /// <summary>JS `v === undefined || v === null`.</summary>
    public static bool IsNullish(JsonElement? v) =>
        v is null || v.Value.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined;

    /// <summary>
    /// ECMAScript WhiteSpace + LineTerminator. NOT the same set as char.IsWhiteSpace / string.Trim():
    /// JS trims U+FEFF but not U+0085 (NEL); .NET does the opposite.
    /// </summary>
    private static bool IsJsSpace(char c) =>
        c is '\t' or '\n' or '\v' or '\f' or '\r' or ' ' or ' ' or ' '
          or (>= ' ' and <= ' ') or ' ' or ' ' or ' ' or ' ' or '　' or '﻿';

    public static string JsTrim(string s)
    {
        var start = 0;
        var end = s.Length;
        while (start < end && IsJsSpace(s[start])) start++;
        while (end > start && IsJsSpace(s[end - 1])) end--;
        return s[start..end];
    }

    /// <summary>
    /// How JavaScript prints a Number in a template string (ECMAScript Number::toString): shortest round-trip digits,
    /// plain notation for 1e-6 &lt;= |x| &lt; 1e21, otherwise d.ddde+XX. Used so error messages match TS character for character.
    /// </summary>
    public static string JsNumber(double d)
    {
        if (double.IsNaN(d)) return "NaN";
        if (double.IsInfinity(d)) return d > 0 ? "Infinity" : "-Infinity";
        if (d == 0) return "0";

        var sign = d < 0 ? "-" : "";
        // "R" is shortest round-trip in .NET Core 3.0+, e.g. "9007199254740992", "1E+22", "1.2345E-07".
        var r = Math.Abs(d).ToString("R", CultureInfo.InvariantCulture);
        var exp = 0;
        var e = r.IndexOf('E', StringComparison.Ordinal);
        if (e >= 0)
        {
            exp = int.Parse(r[(e + 1)..], CultureInfo.InvariantCulture);
            r = r[..e];
        }
        var dot = r.IndexOf('.', StringComparison.Ordinal);
        var digits = dot >= 0 ? r.Remove(dot, 1) : r;
        var n = (dot >= 0 ? dot : r.Length) + exp; // decimal point sits after the first n digits
        var lead = digits.Length - digits.TrimStart('0').Length;
        digits = digits[lead..].TrimEnd('0');
        n -= lead;
        var k = digits.Length;

        string body;
        if (k <= n && n <= 21) body = digits + new string('0', n - k);
        else if (0 < n && n <= 21) body = digits[..n] + "." + digits[n..];
        else if (-6 < n && n <= 0) body = "0." + new string('0', -n) + digits;
        else
        {
            var x = n - 1;
            var mantissa = k == 1 ? digits : digits[..1] + "." + digits[1..];
            body = mantissa + "e" + (x < 0 ? "-" : "+") + Math.Abs(x).ToString(CultureInfo.InvariantCulture);
        }
        return sign + body;
    }
}
