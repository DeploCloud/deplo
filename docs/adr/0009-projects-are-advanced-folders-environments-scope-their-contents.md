# ADR-0009: Projects are advanced folders; Environments scope their contents

- **Status**: Accepted — 2026-07-07 (supersedes the "passive container" reading of
  ADR-0008; the Environment entity, env-var scoping and deploy-key groundwork from
  ADR-0008 are unchanged).
- **Amends**: [ADR-0008](0008-projects-own-environments-services-are-the-deployable-unit.md)
  (Decision 2's containment model), the glossary ([CONTEXT.md](../../CONTEXT.md)).

## Context

ADR-0008 Phase 2 shipped the Project as a **passive container**: folders and
services pointed into it via a nullable `project_id`, its environments existed
alongside that content, and the container had its own `/projects` pages. Product
direction (owner feedback, 2026-07-07) rejects that shape:

> A Project is a more **advanced folder**. Its extra feature is **development
> environments**: each environment is selected from a dropdown and holds its
> **own services** — like sub-folders — and each environment has **shared
> variables that apply only in that environment**. Projects must not have a page
> of their own; projects, folders and services all live on the Overview.

## Decision

1. **The membership axis is the Environment, not the Project.** A service inside
   a project lives in exactly ONE of its environments: `services.environment_id`
   (nullable FK, migration 0020; existing project members backfill to the
   project's default environment). `services.project_id` stays as the derived
   project link; the data layer keeps the pair coherent (entering a project ⇒
   the default environment unless an explicit environment is given; leaving ⇒
   both NULL).
2. **One home only.** A service is in a folder OR in a project's environment,
   never both — `moveServiceToFolder` clears the project/environment,
   `moveServiceToProject`/`moveServiceToEnvironment` clear the folder. Folders
   never live inside projects: `moveFolderToProject` is REMOVED (data layer and
   GraphQL); the ADR-0008 `folders.project_id` column remains only so legacy
   rows keep loading (they render at the Overview top level), and migration
   0020 reconciles legacy dual-membership services (the folder wins).
3. **No project pages.** The Overview (`/`) is the single browsing surface:
   project cards render beside folders and services; opening one is a drill-in
   (`/?project=<id>&env=<envId>`) with an **environment dropdown** that switches
   the visible services and the environment-scoped shared variables (ADR-0008's
   `environment_env_vars`, presented per selected environment only). The old
   `/projects` routes survive purely as redirects.
4. **Environment lifecycle respects contents.** Deleting an environment
   re-parents its services to the project's default environment (mirroring
   folder deletion, which never deletes contents); deleting a project moves its
   services back to the Overview top level.

## Consequences

- The Overview project drill-in is the project UI: environment dropdown,
  services grid, per-environment shared variables, environment management.
- **Runtime injection follows membership**: a service that lives in an
  environment receives THAT environment's shared variables on every runtime
  (`loadEnvironmentEnvForService` returns them marked `membership: true`, which
  bypasses the legacy kind→target bridge in `resolveEnvEntries`). Project
  services without membership (legacy rows) keep the ADR-0008 kind bridge.
- `service_environments` (runtime fan-out) is untouched: it records where a
  service is *deployed*; `services.environment_id` records where it *lives*.
  The per-environment deploy pipeline (ADR-0008 remainder) can consume both.
- Project cards summarize `N services · M environments`; folder counts are gone
  from the project surface.
