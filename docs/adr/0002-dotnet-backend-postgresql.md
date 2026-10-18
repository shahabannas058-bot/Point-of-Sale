# ADR-0002: C# / ASP.NET Core + PostgreSQL for the server

**Date**: 2026-10-18
**Status**: accepted (supersedes the NestJS plan in the earlier CLAUDE.md)
**Deciders**: Owner, Claude

## Context

The server handles licensing, subscriptions, payments, sync and the admin API. These are security-critical. The owner knows C# and wants the backend in C#/.NET and the frontend in TypeScript. The server had not been started, so changing the plan was cheap. .NET SDK 10.0.402 is already installed.

## Decision

The server is ASP.NET Core on `net10.0` with EF Core and PostgreSQL. Tenant isolation uses a `tenant_id` column on every row plus PostgreSQL Row-Level Security; an EF Core interceptor sets `app.tenant_id` on each connection. Ed25519 signing uses `NSec.Cryptography`, because .NET has no built-in Ed25519.

## Alternatives Considered

### Alternative 1: NestJS (TypeScript) as originally planned
- **Pros**: one language everywhere, Zod schemas shared directly with the desktop app
- **Cons**: the owner is stronger in C#
- **Why not**: owner preference and skill; security code is safer in a language the owner can maintain

### Alternative 2: Rewrite everything in .NET (WPF/Avalonia desktop)
- **Pros**: single language
- **Cons**: throws away the working React UI and 536 tests
- **Why not**: too much finished work lost

## Consequences

### Positive
- Mature platform for APIs, auth and background jobs; owner can maintain it
- The desktop POS keeps its existing code and tests

### Negative
- Rules that exist on both sides (invoice hash chain, stock ledger, money) must be implemented twice
- `packages/shared` Zod schemas are no longer shared with the server

### Risks
- Drift between the TypeScript and C# implementations; mitigated by shared JSON test vectors run by both test suites (see ADR-0006)
