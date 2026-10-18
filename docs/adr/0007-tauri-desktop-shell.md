# ADR-0007: Tauri 2 as the desktop shell

**Date**: 2026-10-18
**Status**: superseded by ADR-0010 (the desktop shell is the C# WPF + WebView2 app in `apps/shell-dotnet`)
**Deciders**: Owner, Claude

## Context

The POS must be a Windows desktop application using the existing React UI. It needs native SQLite, printer access and a tamper-resistant place to verify licences (ADR-0004). Shop PCs are often old, so a small installer and low memory use matter.

## Decision

Use Tauri 2 (Rust core + system WebView2 + the existing React/Vite UI). Rust hosts the licence verifier, DPAPI storage, native SQLite access and later the ESC/POS printing.

## Alternatives Considered

### Alternative 1: Electron
- **Pros**: all TypeScript, no Rust toolchain
- **Cons**: large installer and memory, licence logic stays in JavaScript
- **Why not**: weaker licence protection and heavy on old PCs

### Alternative 2: .NET desktop (WPF/Avalonia)
- **Pros**: same language as the server
- **Cons**: discards the React UI and its tests
- **Why not**: too much rework

## Consequences

### Positive
- Small installer, low memory, licence check outside JavaScript

### Negative
- Requires Rust and Visual Studio Build Tools (not yet installed), plus a Rust learning cost for the licence module

### Risks
- Build-tools setup blocks the first Tauri build; Phase 1b does not depend on it and can proceed in the browser meanwhile
