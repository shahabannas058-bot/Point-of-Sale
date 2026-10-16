using System.Security.Cryptography;
using System.Text.RegularExpressions;

namespace PosShell.Core;

/// <summary>Structural twin of UUID_V7 in packages/shared/src/primitives.ts.</summary>
public static class UuidV7
{
    // Same regex as TS. Differences that matter in .NET: \z instead of $ (a plain $ also matches before a
    // trailing "\n", JS does not), and [0-9a-f] is case-sensitive and ASCII-only by default.
    private static readonly Regex Pattern = new(
        @"^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\z",
        RegexOptions.CultureInvariant);

    public static bool IsValid(string? id) => id is not null && Pattern.IsMatch(id);

    /// <summary>Epoch milliseconds stored in the first 48 bits (uuidV7Timestamp in TS).</summary>
    public static long Timestamp(string id) => Convert.ToInt64(id[..8] + id[9..13], 16);
}

/// <summary>
/// Port of createUuidV7Generator (packages/core/src/uuid7.ts): RFC 9562 layout 48-bit ms | ver 7 | 12-bit counter |
/// variant 10 | 62 random bits, strictly monotonic per generator even within one millisecond or if the clock steps
/// backwards. Do NOT replace with Guid.CreateVersion7(): it has no counter, so ids created in the same millisecond
/// are not ordered, and its output could never match the TS vectors.
/// Call order is identical to TS (now(), then randomBytes(2) only when the ms advanced, then randomBytes(16)),
/// which is what makes the recorded vectors replayable.
/// </summary>
public sealed class UuidV7Generator
{
    private readonly Func<long> _now;
    private readonly Func<int, byte[]> _randomBytes;
    private readonly object _gate = new();
    private long _lastMs = -1;
    private int _counter;

    public UuidV7Generator(Func<long>? now = null, Func<int, byte[]>? randomBytes = null)
    {
        _now = now ?? (() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        _randomBytes = randomBytes ?? (n => RandomNumberGenerator.GetBytes(n));
    }

    public string Next()
    {
        lock (_gate)
        {
            var nowMs = _now();
            if (nowMs > _lastMs)
            {
                _lastMs = nowMs;
                var r = _randomBytes(2);
                _counter = ((r[0] << 8) | r[1]) & 0x7ff; // start low: 2048 ids of headroom per ms
            }
            else
            {
                _counter++;
                if (_counter > 0xfff)
                {
                    _lastMs++;
                    _counter = 0;
                }
            }

            var random = _randomBytes(16);
            if (random.Length != 16) throw new InvalidOperationException("randomBytes(16) must return 16 bytes");
            var b = (byte[])random.Clone();
            b[0] = (byte)((_lastMs >> 40) & 0xff);
            b[1] = (byte)((_lastMs >> 32) & 0xff);
            b[2] = (byte)((_lastMs >> 24) & 0xff);
            b[3] = (byte)((_lastMs >> 16) & 0xff);
            b[4] = (byte)((_lastMs >> 8) & 0xff);
            b[5] = (byte)(_lastMs & 0xff);
            b[6] = (byte)(0x70 | (_counter >> 8));
            b[7] = (byte)(_counter & 0xff);
            b[8] = (byte)(0x80 | (b[8] & 0x3f));

            var h = Convert.ToHexStringLower(b);
            return $"{h[..8]}-{h[8..12]}-{h[12..16]}-{h[16..20]}-{h[20..]}";
        }
    }
}
