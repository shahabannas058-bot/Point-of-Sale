# ADR-0001: Offline-first desktop app with cloud sync

**Date**: 2026-10-11 (backfilled; recorded 2026-10-18)
**Status**: accepted
**Deciders**: Owner, Claude

## Context

Pakistani shops have unreliable internet and frequent power cuts. A sale must never wait for the network. Shopkeepers also need a thermal printer and barcode scanner to work without friction, and the owner wants to see data remotely.

## Decision

The POS is a desktop application that reads and writes a local SQLite database. A background sync engine pushes local changes to the server (via an `outbox` table) and pulls remote changes by cursor when online. Ids are UUID v7 generated on the device.

## Alternatives Considered

### Alternative 1: Pure web POS
- **Pros**: nothing to install, one deployment
- **Cons**: every outage stops the shop; printer and scanner access is awkward in a browser
- **Why not**: unacceptable when internet or power fails mid-sale

### Alternative 2: Local-only, no server
- **Pros**: simplest
- **Cons**: no remote subscription control, no owner dashboard, no backup
- **Why not**: subscriptions and remote visibility are core to the business model

## Consequences

### Positive
- Sales always work, even offline
- Conflict-free ids and ledger-based stock make multi-device sync safe

### Negative
- Sync, conflict handling and local migrations add real complexity

### Risks
- Local data can be lost with the PC; mitigated by local backup and (later) encrypted cloud backup
