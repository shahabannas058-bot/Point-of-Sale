# ADR-0010: A C# WPF + WebView2 shell instead of Tauri

**Date**: 2026-10-18
**Status**: accepted (supersedes ADR-0007; amends ADR-0004)
**Deciders**: Owner, Claude

## Context

ADR-0007 chose Tauri 2 for the Windows desktop shell. Since then three facts surfaced:

- `apps/shell-dotnet` already exists: a WPF window hosting the React build in WebView2 (served from the virtual host
  `https://app.pos/`), a native SQLite file with migrations, a daily backup, and a `WebBridge` that the React side talks
  to. It has 62 tests, 61 of which pass today.
- Tauri has not been started: Rust, `cargo` and the Visual Studio Build Tools (C++) are not installed on the dev PC
  (several GB), and `src-tauri` does not exist.
- ADR-0007 rejected ".NET desktop (WPF/Avalonia)" because it "discards the React UI and its tests". That does not apply
  to this shell: it keeps the React UI unchanged and only replaces what Tauri's Rust core would do. Both options use the
  same WebView2 engine, so the user sees the same UI.

The server is already C# (ADR-0002), so the licence token is signed in C# (NSec, Ed25519).

## Decision

The desktop shell is the C# WPF + WebView2 app in `apps/shell-dotnet`. Tauri is dropped.

- **React stays wrapper-agnostic.** The UI only knows a database host: the browser (sql.js, development and tests) or the
  native shell (`createWebViewDriver`, a `SqlDriver` over the bridge). Nothing in the screens depends on the shell.
- **Native database.** Inside the shell the TypeScript `PosService` runs against the native `pos.db` through
  `db.query` / `db.exec` / `db.batch`. C# has already created and migrated the file, so the page does not migrate.
- **Licence verification (amends ADR-0004).** The design is unchanged (Ed25519 token, bound to the device, DPAPI
  storage, trusted-time floor from `last_seen` kept in three signed places, offline budget, states
  `TRIAL → ACTIVE → GRACE → LOCKED → SUSPENDED`, emergency code). Only the language moves: verification runs in the C#
  host, not in the web bundle and no longer in Rust, using the same NSec library as the server. It is still checked at
  start-up, before every committed sale and when opening reports.
- ESC/POS printing, when built, also lives in the C# host.

## Alternatives Considered

### Alternative 1: Keep Tauri 2 (ADR-0007)
- **Pros**: ~10 MB installer; Rust binaries are harder to reverse than .NET assemblies
- **Cons**: Rust and the Build Tools must be installed first; the shell, the bridge and the native database would be
  written again; licence code would exist in Rust (app) and C# (server)
- **Why not**: days of setup and a second language for no change the user can see

### Alternative 2: Electron
- **Pros**: all TypeScript
- **Cons**: heavy on old PCs, licence logic stays in JavaScript
- **Why not**: same reasons as in ADR-0007

## Consequences

### Positive
- A real desktop window can run today: .NET 10 SDK and the WebView2 runtime are already installed
- One language for server and shell: the token format, the signature code and the golden test vectors are shared
- The migrations are shared files: C# embeds `packages/db/migrations/*.sql`, and a checksum file keeps both runners in step

### Negative
- A self-contained single-file publish is large (roughly 70 MB or more) compared with Tauri's ~10 MB; a framework-dependent
  publish is small but needs the .NET runtime on the shop PC
- .NET assemblies are easy to decompile. This is accepted by the threat model in ADR-0004 (an ordinary shopkeeper, not a
  reverse engineer); the server still checks the licence on every sync. Obfuscation or NativeAOT can be added later
- Windows only (the product targets Windows shops)

### Risks
- **The licence has to be enforced at the bridge.** Sales are written by the TypeScript `PosService` and reach the
  database through `db.batch`; the C# `SalesService` is not on that path. The host must therefore refuse `db.batch`
  statements that write sales or stock when the licence is not valid (or the commit must move into C#). Checking only in
  the page would be the JavaScript check ADR-0004 rejects
- The bridge exposes raw SQL to the page. This is acceptable only because the shell never navigates away from its own
  bundle and DevTools are off in release (see `webview-driver.ts`); typed methods should replace raw SQL over time
- Two pre-existing C# test problems (one failing bridge test, and `PosShell.Core.Tests` does not compile) must be fixed
  before the shell is trusted for releases
- The C# `SalesService` duplicates the commit rules of the TypeScript service and does not know about batches (ADR-0009);
  the UI does not use it, it goes through the TypeScript service. Remove it or port it before anything depends on it
