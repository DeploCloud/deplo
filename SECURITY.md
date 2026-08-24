# Security Policy

**Please do not report a security vulnerability in a public issue, a discussion, or a pull
request.** deplo runs other people's infrastructure, so a public report is a live map for
anyone reading it before the fix ships.

## Reporting a vulnerability

**Preferred: [open a private security advisory](https://github.com/DeploCloud/deplo/security/advisories/new).**
It is private to you and the maintainers, it keeps the whole conversation and the fix in
one place, and it is what assigns a CVE and credits you when the advisory is published.

**No GitHub account? Email `security@deplo.build`.** If you want to encrypt the report,
say so in a first message and we will send you a key.

A useful report has: the version of deplo, what an attacker gains, and the shortest path
you know to reproduce it. A working proof of concept is welcome but never required.

## What to expect

|                             |                                                         |
| --------------------------- | ------------------------------------------------------- |
| **Acknowledgement**         | within 72 hours                                         |
| **Assessment and severity** | within 7 days                                           |
| **Coordinated disclosure**  | within 90 days of the report, or as soon as a fix ships |

If a report turns out not to be a vulnerability, you get that answer with the reasoning,
not silence.

We publish a GitHub Security Advisory for every confirmed vulnerability and credit the
reporter by the name they ask for. Tell us if you would rather stay anonymous.

## Supported versions

Only the **latest minor release** receives security fixes. deplo checks for newer releases
and tells you in the dashboard, so staying current is the supported path.

| Version | Supported |
| ------- | :-------: |
| 0.x     |    yes    |

## Scope

**In scope**

- The control plane in this repository: authentication, the authorization boundary in
  `lib/data/*`, the GraphQL API, the MCP server, and the REST routes under `app/api/`.
- The [server agent](https://github.com/DeploCloud/deplo-agent) and the mTLS PKI that
  fronts it.
- Compose and Traefik rendering, including any way a team member can reach the host or
  another team's data through authored compose.
- Secret handling: encryption at rest, the deploy edge, backup artifacts.
- `install.sh` and `install-agent.sh`.

**Out of scope**

- Applications a user deploys with deplo, and the images they pull. deplo runs them, it
  does not vouch for them.
- A user's own DNS, firewall, or server hardening.
- Third-party images in the template catalog. Report those upstream.
- Findings that require a capability the actor already legitimately holds. For example,
  someone granted `canMountHostVolumes` is expected to be able to reach the host, that is
  what the grant means. A way to reach the host **without** it is very much in scope.
- Volumetric denial of service, missing security headers with no exploit path, and
  automated scanner output with no demonstrated impact.

## No bug bounty

deplo does not run a paid bounty program and cannot pay for reports. What we offer is a
fast, honest answer, a credited advisory, and the fix shipped to every install.
