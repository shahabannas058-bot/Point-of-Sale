# Architecture Decision Records

Each ADR records one significant decision: why we chose it and what we rejected. Newer ADRs may supersede older ones; never delete an ADR, change its status instead.

| ADR | Title | Status | Date |
|-----|-------|--------|------|
| [0001](0001-offline-first-desktop-with-cloud-sync.md) | Offline-first desktop app with cloud sync | accepted | 2026-10-11 (recorded 2026-10-18) |
| [0002](0002-dotnet-backend-postgresql.md) | C# / ASP.NET Core + PostgreSQL for the server | accepted | 2026-10-18 |
| [0003](0003-per-tenant-modules-in-licence-token.md) | One product, per-tenant modules carried in the licence token | accepted | 2026-10-18 |
| [0004](0004-licence-verification-in-rust-ed25519.md) | Licence verification with Ed25519 and a clock guard (was: in Rust) | accepted, amended by 0010 | 2026-10-18 |
| [0005](0005-quantities-in-milli-units.md) | Quantities stored as integer milli-units | superseded by 0008 | 2026-10-18 |
| [0006](0006-openapi-contract-between-csharp-and-typescript.md) | OpenAPI as the contract between C# and TypeScript | accepted | 2026-10-18 |
| [0007](0007-tauri-desktop-shell.md) | Tauri 2 as the desktop shell | superseded by 0010 | 2026-10-18 |
| [0008](0008-per-item-unit-scale.md) | Per-item unit scale for loose goods (kg / litre) | accepted | 2026-10-18 |
| [0009](0009-batches-and-expiry-on-the-stock-ledger.md) | Batches and expiry dates on the stock ledger | accepted | 2026-10-18 |
| [0010](0010-csharp-webview2-shell-instead-of-tauri.md) | A C# WPF + WebView2 shell instead of Tauri | accepted | 2026-10-18 |
