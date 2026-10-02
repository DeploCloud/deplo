# ADR-0035: A whole Deplo moves by copying its database and handing its servers over

**Status**: accepted

## Context

[ADR-0034](0034-another-deplo-hands-its-team-over-itself.md) moves ONE team into an existing
Deplo, onto that Deplo's servers, by re-creating each object and copying each volume. It cannot
move an instance: servers are shared across teams, so no team token may hand one over; the export
is written field by field, so every table it forgets is silently left behind; and re-created objects
get new ids, so every API token, deploy hook and git webhook URL breaks.

The common case is not "merge my team into another Deplo". It is "put this Deplo on a bigger box",
"leave the managed instance for my own", "the provider is shutting the machine down". The apps are
fine where they are; only the control plane has to go somewhere else.

The documented way to do that was a `pg_dump` plus copying `DEPLO_SECRET` by hand. Besides being
a shell procedure, a shared secret means a shared agent CA: both panels can command every agent
at once (crons and backups run twice, a renewal from the old one re-locks the agents to it), and
the old machine keeps a key to the whole fleet forever, since the secret cannot be rotated.

## Decision

**A Deplo move copies every row, re-keyed, into a fresh install, then hands each server's agent
over to it. Nothing about the workloads moves.**

### The copy is generic and re-keyed, never the secret

- `lib/deplo-move/tables.ts` classifies EVERY table: copied, skipped (sessions, verification,
  rate limits, the scheduler lease - all bound to the old secret or to the old process), or local
  (the move's own bookkeeping). A test fails on an unclassified table, so a table added later is
  a decision, not a silent loss.
- Ids are preserved. Every value sealed with the old secret is opened on the old Deplo and sealed
  again with the new one's (`*_enc` under `secrets`, the 2FA secret, backup codes and OAuth client
  secret under Better Auth's). Hashes and passwords travel as they are. Backup recovery keys and
  backup runs come along, so every old backup still restores.
- One `repeatable read` snapshot, streamed as NDJSON, restored in one transaction: a cut stream
  leaves the new Deplo exactly as it was.
- Both sides must run the same schema (the last migration tag), and the new Deplo must be empty.

### Servers are handed over through the agent's own certificate renewal

The agent's `InstallRenewedCert` already replaces the CA it trusts when `ca_pem` is set. For each
server, the new Deplo asks the old one for a CSR from that agent, signs it with its OWN CA, records
the fingerprint, and asks the old Deplo to install it with the new CA. From the next handshake only
the new Deplo can dial it: the old one is cut off by cryptography, not by a flag. No agent change,
gated on the existing `cert-renewal` capability. The old panel's own machine goes last and becomes
an ordinary server of the new Deplo; its apps keep running.

### The old Deplo freezes, then says where it went

A move code (`dmove_…`, instance admin, one hour until first use, bound to the first Deplo that
uses it) authorises the whole exchange on `POST /api/deplo-move/<step>`. From `freeze` on, every
mutation (GraphQL and MCP, wrapped once on the schema), every REST write and every background job
refuses; once the last server is handed over the old Deplo is `moved` for good and shows only
where it went. The new Deplo holds the same freeze while it hands servers over, so nothing dials an
agent that still answers to the old CA.

## Consequences

- The move code is root over the fleet for its lifetime. It is shown once, stored hashed, written
  to every team's Activity on both sides, and refused over plain http.
- Every enrolled server must answer both Deplos before the move starts, and the new machine must
  reach each agent's port. A firewall that only admitted the old panel is named per server - the
  one place a move can need the user to touch infrastructure.
- Sessions do not survive: everyone signs in again, with the account they had. Passkeys keep
  working only if the panel keeps its domain (they are bound to it), and so do webhook URLs.
- Cancelling is possible until the first server is handed over; after that a move only goes
  forward (retry), like a fleet rollout. A server whose install answer was lost counts as handed
  over until it is shown to still answer the side that asks.
- Either side dying mid-move has a way out that needs no shell: the new Deplo can **finish without
  the old one** (servers not handed over are left behind, to be added again), and the old one can
  **resume** (servers already handed over stay with the new one). Both are explicit, confirmed,
  and written to Activity.
- The progress page is public by its id, because the copy signs everyone out. The id is a key:
  whoever holds it can retry, cancel or finish the move, so it is never shown anywhere but to the
  admin who started it.
- A moved Deplo refuses every API token, so a token revoked on the new Deplo is not still alive
  on the old one.
- Not done here: removing the old panel from its machine. It stays up, frozen, pointing at the new
  address, and is harmless there.
- ADR-0034's team migration stays: it is the right tool for merging a team into a Deplo that
  already runs other teams, and for leaving a managed instance whose servers are not yours to take.
