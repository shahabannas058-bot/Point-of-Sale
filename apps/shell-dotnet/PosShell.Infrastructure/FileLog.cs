using System.Diagnostics;
using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;
using PosShell.Core;

namespace PosShell.Infrastructure;

/// <summary>
/// Append-only diagnostics log: one UTF-8 line per entry, one file per day (pos-yyyy-MM-dd.log) under
/// <see cref="PosPaths.LogDir"/>. The page only ever sees ErrorMap's generic text; the real exception, InnerException
/// and stack included, goes here together with the bridge method and request id.
///
/// Rules: never throws (a broken log must not stop a sale); never logs request payloads; values that look like a PIN,
/// hash, token or password are redacted; today's file stops growing at <see cref="MaxFileBytes"/>; only the newest
/// <see cref="KeepFiles"/> files are kept.
/// </summary>
public sealed class FileLog(string logDir)
{
    public const long MaxFileBytes = 5 * 1024 * 1024;
    public const int KeepFiles = 14;

    private static readonly UTF8Encoding Utf8 = new(encoderShouldEmitUTF8Identifier: false);

    // pin: 1234 / "pin_hash": "..." / token=abc  ->  the value is replaced, the key stays so the line is still readable.
    private static readonly Regex Secret = new(
        @"(?<key>[""']?\w*(?:pin|hash|token|password|secret)\w*[""']?\s*[:=]\s*)(?<value>""[^""]*""|'[^']*'|[^\s,;}\]]+)",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    private readonly object _gate = new();
    private bool _pruned;

    public string LogDir { get; } = logDir;

    /// <summary>The shop's log folder next to pos.db, or null when even the data folder cannot be resolved.</summary>
    public static FileLog? TryCreateDefault()
    {
        try { return new FileLog(PosPaths.LogDir); }
        catch (Exception e)
        {
            Debug.WriteLine($"Log folder unavailable: {e}");
            return null;
        }
    }

    public void Info(string source, string message) => Write("INFO", source, null, message);

    /// <summary>source = "bridge:db.batch", "startup", "backup"...; requestId = the bridge request id when there is one.</summary>
    public void Error(string source, Exception exception, string? requestId = null)
    {
        var code = exception is ServiceException s ? $"code={s.Code} " : "";
        Write("ERROR", source, requestId, code + exception); // ToString(): type, message, every InnerException, stack
    }

    private void Write(string level, string source, string? requestId, string text)
    {
        try
        {
            var now = DateTimeOffset.UtcNow;
            var stamp = now.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture);
            var id = string.IsNullOrEmpty(requestId) ? "-" : requestId;
            var line = $"{stamp} {level} {source} id={id} {Redact(OneLine(text))}\n";
            lock (_gate)
            {
                Directory.CreateDirectory(LogDir);
                if (!_pruned)
                {
                    Prune();
                    _pruned = true;
                }
                var file = Path.Combine(LogDir, $"pos-{now.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture)}.log");
                if (new FileInfo(file) is { Exists: true, Length: > MaxFileBytes }) return; // cap reached: drop, never grow without bound
                File.AppendAllText(file, line, Utf8);
            }
        }
        catch (Exception e)
        {
            Debug.WriteLine($"Log write failed: {e}"); // diagnostics only: it must never take the shop down
        }
    }

    private void Prune()
    {
        foreach (var old in Directory.GetFiles(LogDir, "pos-*.log").OrderByDescending(f => f, StringComparer.Ordinal).Skip(KeepFiles))
            File.Delete(old);
    }

    private static string OneLine(string s) =>
        s.Replace("\r\n", "\n", StringComparison.Ordinal).Replace("\n", " | ", StringComparison.Ordinal).Replace('\r', ' ');

    private static string Redact(string s) => Secret.Replace(s, "${key}[redacted]");
}
