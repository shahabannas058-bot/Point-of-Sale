# ADR-0004: Licence verification in Rust with Ed25519 and a clock guard

**Date**: 2026-10-18
**Status**: accepted; amended by ADR-0010: the design below stands, but verification runs in the C# host instead of Rust (the file name keeps the old title)
**Deciders**: Owner, Claude

## Context

The app must stop accepting sales when a subscription lapses, including when the shopkeeper sets the PC clock back or stays offline. The threat model is an ordinary shopkeeper, not a skilled reverse engineer. Honest customers must not be locked out by mistake (a dead CMOS battery can skew the clock).

## Decision

The server signs a licence token with a private Ed25519 key (`tenant_id, device_id, plan, business_type, modules[], valid_until, grace_days, max_offline_days, issued_at`). The app embeds only the public key. Verification runs in the Rust side of Tauri, not in JavaScript, at start-up, before every committed sale and when opening reports. The token is stored encrypted with Windows DPAPI. Trusted time is the maximum of the persisted `last_seen` (stored in three signed places), the newest local sale and the last server time anchor. States are `TRIAL → ACTIVE → GRACE → LOCKED → SUSPENDED`; in `LOCKED` data stays viewable. An emergency unlock code issued by the owner covers legitimate failures.

## Alternatives Considered

### Alternative 1: Verify in JavaScript
- **Pros**: no Rust needed
- **Cons**: trivially patched in the web bundle
- **Why not**: too easy to bypass

### Alternative 2: Always-online check
- **Pros**: strongest control
- **Cons**: breaks the offline-first rule (ADR-0001)
- **Why not**: shops would lose sales during outages

## Consequences

### Positive
- Cheating is inconvenient, honest customers stay safe, and the owner keeps remote control

### Negative
- Requires Rust and Visual Studio Build Tools on the dev machine

### Risks
- Not secure against a determined reverse engineer; accepted
