namespace PosShell.Core;

/// <summary>
/// The ONLY place licensing plugs into the database. The bridge asks it inside the write lock, right before a batch from
/// the page runs (db.batch). The TypeScript PosService writes sales, stock and khata that way, so this is the choke point
/// ADR-0010 names. Throw <see cref="ServiceException"/>("LICENCE_BLOCKED", ..., {state}) to block. Any other exception
/// becomes INTERNAL with its message (same as the TS hook). Reads are never asked: in LOCKED the shop stays viewable
/// (read-only).
/// </summary>
public interface ILicenceGuard
{
    /// <summary>
    /// Asked before a batch from the page is written. The real guard looks at which tables the statements touch
    /// (sales / stock_movements / ledger_entries are refused when the licence is not valid).
    /// </summary>
    void AssertCanWrite(IReadOnlyList<SqlStatement> statements, long nowMs);
}

/// <summary>Phase 1 default, like the TS default hook. Replaced by the Ed25519 licence module in Phase 2.</summary>
public sealed class AllowAllLicenceGuard : ILicenceGuard
{
    public void AssertCanWrite(IReadOnlyList<SqlStatement> statements, long nowMs) { }
}
