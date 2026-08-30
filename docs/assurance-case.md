# Security assurance case

Why deplo's security requirements are met: what it is defending, against whom, where the trust
boundaries sit, and what stops the usual ways software like this gets broken.

deplo runs other people's infrastructure. A tenant hands it a repository, a compose file and a
set of secrets, and deplo turns those into containers on a host the tenant may share with other
teams. That is the shape of the risk, and everything below follows from it.

## What is being protected

| Asset                      | Why it matters                                                                |
| -------------------------- | ----------------------------------------------------------------------------- |
| The control-plane database | Every team's secrets at rest, encrypted with keys derived from `DEPLO_SECRET` |
| Another team's data        | Volumes, databases, backups, environment variables, source                    |
| Root on the host           | A container that escapes owns the whole fleet member                          |
| The panel's own traffic    | Whoever answers `deplo:3000` on a tenant network collects sessions            |
| Agent credentials          | The mTLS key pair that authorizes running `docker` on a host                  |

## Who the adversary is

1. **A logged-in member with limited Capabilities.** The most important one. deplo is built for
   teams, so the actor is usually _not_ the instance owner and must not be able to widen their
   own reach.
2. **Another team on the same instance.** Shared servers are the default (`servers.all_teams`),
   so tenant isolation is not optional.
3. **A malicious compose file.** Authored YAML reaches the agent almost verbatim. It is the
   single largest attack surface in the product.
4. **An anonymous attacker on the network**, at the login form, the webhook routes and the
   agent's gRPC port.
5. **A pull request from a fork**, whose code is a stranger's but which a preview deploys.

Explicitly out of scope: a malicious maintainer, a compromised host the agent already runs on,
and physical access.

## Trust boundaries

1. **Browser to control plane.** One GraphQL endpoint plus a short list of REST exceptions.
   Session cookie via Better Auth, or an API token. Authorization is never decided here.
2. **Control plane to `lib/data/*`.** The real boundary. Every read resolves the team internally
   and filters on it; every mutation calls `requireCapability`. The GraphQL `authScopes` layer
   is a second, introspectable gate, not the boundary itself.
3. **Control plane to server agent.** gRPC over mTLS, certificate fingerprint pinned at
   bootstrap, mandatory `Hello` pre-flight. The control plane never touches a Docker socket for
   a per-app action (ADR-0006), and there is no in-process shortcut for the local host.
4. **Agent to Docker.** The agent is the only component that runs `docker`, shell or filesystem
   operations on any host.
5. **Tenant to tenant.** Team scoping in the database, and at runtime an Environment-owned
   Docker network that nothing crosses (ADR-0028).
6. **Control plane to the outside world.** Any address a user typed.

## Secure design principles, and where they live

- **Least privilege.** 44 fine-grained Capabilities (`lib/capabilities.ts`), one action each,
  plus per-folder grants and the orthogonal `canExposePorts` / `canMountHostVolumes`. A
  capability that would cover two actions an admin might want apart is split into two. API
  tokens carry their own narrowed set and cannot widen it.
- **Defence in depth.** Both gates are kept: the field's `authScopes` _and_ the
  `requireCapability` call inside the data function. Resources under a folder need a second,
  folder-scoped gate.
- **Complete mediation.** `lib/data/*` never accepts `teamId` or `userId` as a parameter; it
  resolves them from the request identity. Row-targeting writes are scoped
  `and(eq(t.id, id), eq(t.teamId, teamId))`, so a cross-team id affects zero rows.
- **Fail-safe defaults.** Certificates are opt-in, `teams.mcp_enabled` is false for a new team,
  a new API token expires in 90 days, and an unreachable agent is a hard error rather than a
  silent local fallback.
- **Separation of privilege.** The control plane holds the encryption key and never gives it to
  an agent; the agent holds host access and never gets the key. Neither alone is enough.
- **Economy of mechanism.** One seam per concern, so a rule cannot be enforced in one place and
  forgotten in another: `connectAgent` for every host call, `portFor` for every port read,
  `traefikRouterLabels` for every routing label, `lib/deploy/network.ts` for every network name,
  `lib/outbound-url.ts` for every outbound address.
- **The client is never trusted.** UI `hasCapability` checks hide and disable; they authorize
  nothing.

## Common weaknesses, and what counters them

| Weakness                            | Countermeasure                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Broken access control**           | Team-scoped reads, `requireCapability` on writes, folder gates, `.returning()` length checks. A narrowed token is refused by team-shaped functions themselves.                                                                                                                                                                                          |
| **Injection**                       | Drizzle parameterized queries throughout; no SQL assembled from strings.                                                                                                                                                                                                                                                                                |
| **Cross-site scripting**            | React escaping plus a Content-Security-Policy that blocks remote images and scripts.                                                                                                                                                                                                                                                                    |
| **Cryptographic failure**           | AES-256-GCM for secrets, scrypt with cost stored per hash and re-hashing on sign-in, bcrypt for htpasswd, mTLS between planes. No hand-rolled primitives, no key in the agent.                                                                                                                                                                          |
| **Secret disclosure**               | `*_enc` columns never reach a DTO. Values are write-only with no reveal path, and anything resolved into a rendered stack is masked by `redactComposeForDisplay`, including the basic-auth label. Every env layer carries a required `plain`/`secret` type, so a preview of a fork drops secrets and a loader that forgets the column does not compile. |
| **Container escape to the host**    | `canMountHostVolumes` gates every route out of the sandbox, not just bind mounts: `privileged`, `cap_add`, `devices`, host `pid`/`ipc`/`uts`, `userns_mode`, unconfining `security_opt`, `cgroup_parent`, `device_cgroup_rules`, and the top-level `volumes:` block including `driver_opts` binds and `external: true`. Hardening keys are never gated. |
| **Tenant impersonation over DNS**   | Every stack gets its Environment's own network; hand-written aliases are dropped; the names Traefik still resolves are refused at save and at render, case-insensitively and including `hostname:`.                                                                                                                                                     |
| **Hostname takeover between teams** | `assertHostnameNotAnotherTeams` on add and on rename, with a zone-comparing twin for preview base domains.                                                                                                                                                                                                                                              |
| **Server-side request forgery**     | `assertSafeOutboundUrl` on every user-supplied address. Reaching a private address is an instance-admin flag, with exactly one documented exemption that asserts admin at the dialer.                                                                                                                                                                   |
| **Authentication attacks**          | Postgres-backed rate limiting that survives restarts, Have I Been Pwned checks on every chosen password, an optional per-team 2FA policy enforced on both reads and mutations, token expiry checked before the membership read, and the Better Auth account surface gated shut so deplo's own sign-in stays the only path.                              |
| **Vulnerable dependencies**         | `bun audit` on every push and on a weekly schedule, so a newly published advisory turns the repository red on its own. Security pins are re-checked empirically on every bump.                                                                                                                                                                          |
| **Missing audit trail**             | Every mutating action records an Activity entry outside the transaction, retried once, and an entry that still could not be written becomes a visible row in the trail rather than a silent gap.                                                                                                                                                        |

## Evidence

- **Automated:** 2265 tests run in process against pglite on every push, alongside ESLint,
  `tsc --noEmit` under `strict`, and the dependency audit.
- **Manual review:** five security review passes across August 2026 covering multi-tenancy, the
  compose surface, secret handling, authentication and the agent transport. Every finding was
  fixed. The working rule of those passes is recorded here because it generalises: a fix that
  closes the reported instance without closing the class is not finished, so each finding was
  followed by a search for its siblings.
- **Architecture decisions:** 28 ADRs in [`docs/adr/`](adr/), several of which exist because a
  security property demanded them.

## Known limits

- `DEPLO_SECRET` has **no key versioning**. Rotating it is destructive by design: every
  encrypted column becomes unreadable and every agent certificate is re-minted. Deployments that
  need rotation must re-enter their secrets.
- Compose authored by a tenant is **linted, not sandboxed**. The gates above enumerate the keys
  that reach the host; a Docker feature that escapes the sandbox and is not on that list would
  pass. Adding such a key to Docker means adding it to `composeNeedsHostPrivileges`.
- deplo does not claim OpenSSF `two_person_review`: maintainers commit directly to `main`.
  See [GOVERNANCE.md](../GOVERNANCE.md#code-review).
