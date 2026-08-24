## What this changes

<!-- One or two sentences. If it fixes an issue, write "Fixes #123". -->

## How you tested it

<!-- What you actually ran or clicked. "The tests pass" on its own is not a test of the change. -->

## Checklist

- [ ] `bun run lint` passes
- [ ] `bun run test` passes (with `DEPLO_DATABASE_URL` unset)
- [ ] `bunx next typegen && bunx tsc --noEmit` passes
- [ ] I regenerated `schema.graphql` if I touched `lib/graphql/types/*`
- [ ] I read [CONTRIBUTING.md](../CONTRIBUTING.md), including the licensing section
- [ ] This does not make the control plane touch Docker or a host directly (see [AGENTS.md](../AGENTS.md))
