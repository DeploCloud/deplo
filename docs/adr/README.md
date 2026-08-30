# Architecture decisions

Numbered records of decisions that shaped Deplo, with the reasoning that was
current when each was made. **They are a history, not a manual.** A decision can
be amended, superseded or retired without its record being rewritten, so an ADR
read alone can be misleading.

For how the system behaves **today**, read the
[user documentation](../README.md); for the vocabulary, `CONTEXT.md` at the
repository root.

## The live ones

| #                                                                                         | Decision                                                                                                                    |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| [0005](0005-apps-are-host-managed-containers-not-projects.md)                             | Apps are host-managed containers, not projects. **Superseded in part by 0013**                                              |
| [0006](0006-server-agent-is-a-per-host-go-binary.md)                                      | Remote execution is a per-host Go agent; the control plane stays TypeScript and never runs Docker. **The foundational one** |
| [0007](0007-backups-route-through-the-owning-agent-databases-become-agent-provisioned.md) | Backups route through the owning agent; databases become agent-provisioned                                                  |
| [0009](0009-projects-are-advanced-folders-environments-scope-their-contents.md)           | Projects are advanced folders; Environments scope their contents. **Supersedes the containment reading of 0008**            |
| [0011](0011-server-removal-is-trust-revocation-not-a-host-uninstall.md)                   | Removing a server is trust revocation, not a host uninstall                                                                 |
| [0012](0012-shared-variables-are-opt-in-per-app.md)                                       | Shared variables are opt-in per app: scopes suggest, links inject. **Amends 0010**                                          |
| [0013](0013-plugins-are-deferred-and-the-mcp-plugin-is-withdrawn.md)                      | Plugins are deferred; the MCP plugin is withdrawn                                                                           |
| [0014](0014-better-auth-is-the-live-login-path-and-2fa-is-a-team-policy.md)               | Better Auth is the live login path; two-factor is a team and role policy, not a capability                                  |
| [0015](0015-an-api-token-is-a-principal-with-its-own-capabilities.md)                     | An API token is a principal with its own capabilities                                                                       |
| [0016](0016-a-node-capability-set-overrides-the-team-role-inside-that-node.md)            | A node capability set overrides the team role inside that node                                                              |
| [0017](0017-pull-request-previews-are-per-pull-request-stacks.md)                         | Pull request previews are per-pull-request stacks, keyed off the deploy key                                                 |
| [0018](0018-cron-jobs-are-agent-tracked-container-execs.md)                               | Cron jobs are agent-tracked container execs, polled by the control plane                                                    |
| [0019](0019-a-backup-destination-is-a-bucket-or-a-server.md)                              | A backup destination is a bucket **or** a server, and a server's artifacts are always encrypted                             |
| [0020](0020-a-build-server-builds-for-hosts-it-does-not-run-on.md)                        | A build server builds for hosts it does not run on                                                                          |
| [0021](0021-the-mcp-server-is-a-first-party-route-not-a-plugin.md)                        | The MCP server is a first-party route, not a plugin. **Amends 0013**                                                        |
| [0022](0022-the-oauth-consent-screen-mints-an-api-token.md)                               | The OAuth consent screen mints an API token                                                                                 |
| [0023](0023-the-template-catalog-is-a-remote-service.md)                                  | The template catalogue is a remote service, not repository content                                                          |
| [0024](0024-a-passkey-is-a-full-sign-in-method-and-satisfies-the-2fa-mandate.md)          | A passkey is a full sign-in method, and it satisfies the two-factor mandate. **Amends 0014**                                |
| [0025](0025-a-migration-source-is-a-server-that-hosts-nothing.md)                         | A migration source is a server that hosts nothing, and Deplo takes itself back off it                                       |
| [0026](0026-a-source-platform-is-one-adapter-behind-one-client.md)                        | A source platform is one adapter behind one client interface                                                                |
| [0027](0027-a-shared-variable-reaches-many-teams.md)                                      | A shared variable reaches many teams, and the instance layer is one of them. **Amends 0010 and 0012**                       |
| [0028](0028-an-environment-owns-a-network.md)                                             | An Environment owns a network, and nothing crosses it                                                                       |

## Amended or superseded

| #                                                                          | Decision                                                    | Read instead                                                                                                       |
| -------------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| [0001](0001-ports-are-per-target-not-a-single-scalar.md)                   | Ports are modeled per-target, not as a single scalar        | Amended 2026-07-19: dev mode was removed, so the per-target axis collapsed. Only the single port accessor survives |
| [0008](0008-projects-own-environments-services-are-the-deployable-unit.md) | Projects own Environments; the deployable unit is a Service | [0009](0009-projects-are-advanced-folders-environments-scope-their-contents.md)                                    |
| [0010](0010-unified-shared-variables.md)                                   | Unified shared variables, one model and three sharing modes | [0012](0012-shared-variables-are-opt-in-per-app.md)                                                                |

## Retired

All three were retired on 2026-07-19 by the same event: dev mode, the live
editable development container with an SSH gateway, was removed from the
product. They are kept as history.

| #                                                                         | Decision                                                                        |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| [0002](0002-ssh-gateway-is-lazy-platform-infrastructure.md)               | The SSH gateway is lazy platform infrastructure, not reserved at install        |
| [0003](0003-gateway-socket-access-is-proxied-and-key-auth-is-default.md)  | The gateway never holds the raw Docker socket; key auth is the default          |
| [0004](0004-dev-containers-use-official-base-images-not-built-presets.md) | Dev containers run on official base images, set up by a bind-mounted entrypoint |

## Two trip hazards for a new reader

- **The plugin thread is 0005, then 0013, then 0021.** Reading any one of them
  alone is misleading: 0005 is superseded in part, 0013 defers the feature, and
  0021 replaces the withdrawn piece with a first-party route.
- **ADR-0017's number was reused.** An earlier ADR-0014 of the same name shipped
  and was reverted in August 2026, and the slot was taken by Better Auth. The
  preview decision is 0017.

## See also

- [User documentation](../README.md)
- [`AGENTS.md`](../../AGENTS.md) - the architecture rules these decisions produced
- [`CONTEXT.md`](../../CONTEXT.md) - the glossary
