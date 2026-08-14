# ADR-0023: The template catalog is a remote service, not repo content

- **Status**: Accepted — 2026-08-14.
- **Constrains**: `templates/*`, `lib/templates-blueprint.ts`, `app/(dashboard)/templates/*`,
  `app/(dashboard)/new/*`, `components/templates/*`, the CSP in `proxy.ts`, and the
  `DeploCloud/templates` repository.

## Context

The one-click catalog used to live inside this repository: a generated
`templates/catalog.json` (388 entries, 7,169 lines) plus a `templates/blueprints/<id>/` folder per
template holding its `docker-compose.yml` and `template.toml`, with each logo copied into
`public/templates/<id>.<ext>`. `lib/templates.ts` imported the JSON, and
`getTemplateBlueprint(id)` read the two files off local disk with `readFileSync`.

That shape made publishing a template a **Deplo release**. Upstream renames an image tag, a
project moves its repo, someone contributes a new stack — none of it reaches a running instance
until its operator upgrades. It also put ~7 MB of third-party content, none of which Deplo
executes or even parses at build time, in the middle of every clone, every Docker image layer and
every code review.

The catalog is also the one part of Deplo that is genuinely **shared**: every instance wants the
same 388 stacks, and none of them wants a private copy that drifts.

## Decision

1. **The catalog is an HTTP service** (`DeploCloud/templates`, a Bun server) and this repo holds
   only a client for it: `templates/catalog.ts`. `DEPLO_TEMPLATES_API_URL` points at it and
   defaults to the public catalog, so a fresh install has 388 templates with **zero
   configuration** — the first-run rule is not negotiable here, and an env var nobody sets is
   exactly the kind of knob that first run must not have.

2. **Every response is parsed before it is used** (`templates/schema.ts`). This is remote input
   whose `docker-compose.yml` and `template.toml` end up in a real deploy, and whose asset paths
   end up in `<img src>` — so paths are re-validated against the grammar the API documents rather
   than trusted, and an origin that starts serving something else fails closed.

3. **Responses are cached for an hour** (`force-cache` + `revalidate: 3600`, tagged `templates`),
   and the browser filters the catalog client-side over a payload trimmed to what a card shows.
   Four cached requests an hour beats a round-trip per keystroke, and the search stays instant.

4. **A template's logo is inlined as a data URI when an App is created from it**
   (`templateLogoDataUri`). Apps store their icon inline already; keeping the catalog URL instead
   would mean the dashboard fires one remote image request per row and every template App loses
   its icon the day the catalog is unreachable.

   Consequence: a template's logo is now an ordinary inline image, indistinguishable from an
   upload. `isTemplateLogo` and the "detection may not replace a template's icon" exception are
   gone — the value shape they keyed on no longer exists, and one consistent rule beats a guard
   that would only fire for Apps created before this change.

5. **The catalogue degrades, it does not error.** An unreachable service renders an empty state
   that says so; an unknown `?template=` slug renders "that template isn't available" with a way
   back. Neither takes down a dashboard section.

6. **The blueprint parser stays here.** `getTemplateBlueprint` is now a pure function over the two
   files the catalog serves. The variable helpers (`${password:N}`, `${domain}`, …), the
   expose/mount resolution and the guarantee that a generated secret is byte-identical in the env
   and in every mounted config file are deploy semantics — they belong next to the deploy engine,
   not in a content service.

## Consequences

- `templates/catalog.json`, `templates/blueprints/`, `lib/templates.ts`,
  `scripts/import-templates.mjs` and `scripts/merge-descriptions.mjs` are deleted.
- `public/templates/*` **stays**: Apps created before this change still store `/templates/<file>`
  logos, and `isValidLogoValue` still accepts that shape.
- Template ids became slugs derived from the name (`actualbudget` → `actual-budget`, 59 in total).
  Ids only ever appeared in `?template=` links the product generates, so nothing stored moves.
- The CSP gains the catalog's origin in `img-src` — the cards load their logos from it directly.
  `connect-src` does not: nothing in the browser talks to the catalog.
- An air-gapped instance has no catalogue. That is the honest trade: the alternative is shipping a
  copy that is stale the week after it ships. Such an instance can mirror the service and point
  `DEPLO_TEMPLATES_API_URL` at it.
