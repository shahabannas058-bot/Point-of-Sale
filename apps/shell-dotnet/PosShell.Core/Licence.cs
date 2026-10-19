namespace PosShell.Core;

/// <summary>
/// The ONLY place licensing plugs into the database. Both questions are asked inside the write lock, right before the
/// statements run:
///   AssertCanSell  - by <see cref="SalesService"/> (checkout.commit) once the invoice is sealed;
///   AssertCanWrite - by the bridge for every raw write the page sends (db.batch). The TypeScript PosService writes
///                    sales, stock and khata that way, so this is the choke point ADR-0010 names.
/// Throw <see cref="ServiceException"/>("LICENCE_BLOCKED", ..., {state}) to block. Any other exception becomes INTERNAL
/// with its message (same as the TS hook). Reads are never asked: in LOCKED the shop stays viewable (read-only).
/// </summary>
public interface ILicenceGuard
{
    void AssertCanSell(string action, string branchId, long nowMs);

    /// <summary>
    /// Asked before a batch from the page is written. The real guard looks at which tables the statements touch
    /// (sales / stock_movements / ledger_entries are refused when the licence is not valid).
    /// </summary>
    void AssertCanWrite(IReadOnlyList<SqlStatement> statements, long nowMs);
}

/// <summary>Supervisor approvals (a manager typed their PIN to allow a discount / credit-limit override).</summary>
public interface IApprovals
{
    /// <summary>The approver's username if the token is valid and unexpired, else null.</summary>
    string? Lookup(string? token);

    void Consume(string? token);
}

/// <summary>Phase 1 default, like the TS default hook. Replaced by the Ed25519 licence module in Phase 2.</summary>
public sealed class AllowAllLicenceGuard : ILicenceGuard
{
    public void AssertCanSell(string action, string branchId, long nowMs) { }

    public void AssertCanWrite(IReadOnlyList<SqlStatement> statements, long nowMs) { }
}

public sealed class NoApprovals : IApprovals
{
    public string? Lookup(string? token) => null;

    public void Consume(string? token) { }
}

/// <summary>Single-use, short-lived (60 s by default) approval tokens, like ctx.approvals in the TS service.</summary>
public sealed class InMemoryApprovals(Func<long>? clock = null, long ttlMs = 60_000) : IApprovals
{
    private readonly Func<long> _clock = clock ?? (() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
    private readonly Dictionary<string, (string Approver, long ExpiresAt)> _grants = new(StringComparer.Ordinal);
    private readonly object _gate = new();

    public string Grant(string approverUsername)
    {
        var token = Convert.ToHexStringLower(System.Security.Cryptography.RandomNumberGenerator.GetBytes(16));
        lock (_gate) _grants[token] = (approverUsername, _clock() + ttlMs);
        return token;
    }

    public string? Lookup(string? token)
    {
        if (token is null) return null;
        lock (_gate)
        {
            if (!_grants.TryGetValue(token, out var g)) return null;
            if (g.ExpiresAt > _clock()) return g.Approver;
            _grants.Remove(token); // expired
            return null;
        }
    }

    public void Consume(string? token)
    {
        if (token is null) return;
        lock (_gate) _grants.Remove(token);
    }
}

/// <summary>ROLE_PERMISSIONS from packages/shared/src/service.ts, only what a sale needs.</summary>
public static class Permissions
{
    /// <summary>`sell` is held by every role; `discount_unlimited` by owner and manager.</summary>
    public static bool CanSell(string role) => role is "owner" or "manager" or "cashier";

    public static bool HasDiscountUnlimited(string role) => role is "owner" or "manager";
}
