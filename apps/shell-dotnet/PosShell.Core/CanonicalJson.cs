using System.Globalization;
using System.Text;

namespace PosShell.Core;

/// <summary>
/// Port of packages/core/src/invoice-chain.ts canonicalize(): deterministic JSON, keys sorted by UTF-16 code
/// unit, no whitespace, integers only. String escaping copies JavaScript's JSON.stringify exactly. The default
/// System.Text.Json encoder must NOT be used: it escapes non-ASCII (Urdu) and &lt; &gt; &amp; '.
/// </summary>
public static class CanonicalJson
{
    public static string Write(object? value)
    {
        var sb = new StringBuilder();
        Append(sb, value);
        return sb.ToString();
    }

    private static void Append(StringBuilder sb, object? v)
    {
        switch (v)
        {
            case null:
                sb.Append("null");
                break;
            case string s:
                AppendString(sb, s);
                break;
            case bool b:
                sb.Append(b ? "true" : "false");
                break;
            case int or long:
                sb.Append(Convert.ToInt64(v, CultureInfo.InvariantCulture).ToString(CultureInfo.InvariantCulture));
                break;
            case IReadOnlyDictionary<string, object?> dict:
                sb.Append('{');
                var first = true;
                foreach (var key in dict.Keys.OrderBy(k => k, StringComparer.Ordinal)) // == JS Array.sort()
                {
                    if (!first) sb.Append(',');
                    first = false;
                    AppendString(sb, key);
                    sb.Append(':');
                    Append(sb, dict[key]);
                }
                sb.Append('}');
                break;
            case IEnumerable<object?> list:
                sb.Append('[');
                var firstItem = true;
                foreach (var item in list)
                {
                    if (!firstItem) sb.Append(',');
                    firstItem = false;
                    Append(sb, item);
                }
                sb.Append(']');
                break;
            default:
                throw new ServiceException("INTERNAL", $"Unsupported canonical value: {v.GetType().Name}");
        }
    }

    /// <summary>JSON.stringify for strings: escapes " \ and control chars, leaves everything else (incl. / &lt; &gt; DEL U+2028) raw.</summary>
    private static void AppendString(StringBuilder sb, string s)
    {
        sb.Append('"');
        for (var i = 0; i < s.Length; i++)
        {
            var c = s[i];
            switch (c)
            {
                case '"': sb.Append("\\\""); break;
                case '\\': sb.Append("\\\\"); break;
                case '\b': sb.Append("\\b"); break;
                case '\f': sb.Append("\\f"); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                default:
                    if (c < 0x20)
                        sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                    else if (char.IsHighSurrogate(c) && i + 1 < s.Length && char.IsLowSurrogate(s[i + 1]))
                        sb.Append(c).Append(s[++i]); // valid pair: emitted as-is
                    else if (char.IsSurrogate(c))
                        sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture)); // lone surrogate
                    else
                        sb.Append(c);
                    break;
            }
        }
        sb.Append('"');
    }
}
