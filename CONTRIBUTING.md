# Contributing to deplo

Thanks for being here. This page is short on purpose: everything below is something that
will actually come up.

## Have a question? Don't open an issue

- **Questions, ideas, "is this supposed to work like this"** go to
  [Discussions](https://github.com/DeploCloud/deplo/discussions).
- **Bugs and feature requests** go to [Issues](https://github.com/DeploCloud/deplo/issues),
  through the templates.
- **Security vulnerabilities** go to [SECURITY.md](SECURITY.md), never to a public issue.

## Running it locally

deplo needs **Bun**, **Node 22+** and a **Postgres** you can write to.

```bash
bun install

export DEPLO_DATABASE_URL=postgres://deplo:password@localhost:5432/deplo
export DEPLO_SECRET=$(openssl rand -base64 48)   # at least 16 chars, derives every key
export DEPLO_PUBLIC_URL=http://localhost:3000

bun run db:push     # create the tables
bun run dev         # http://localhost:3000
```

The app **fails fast at startup** without `DEPLO_DATABASE_URL`. A fresh database starts
empty: the first visit opens the setup wizard.

Deploying anything from your local instance also needs a
[server agent](https://github.com/DeploCloud/deplo-agent) on a host it can reach. The
control plane never runs Docker itself.

## Before you open a pull request

Run the three things CI runs:

```bash
bun run lint

bun run test                       # see the warning below
bunx next typegen && bunx tsc --noEmit
```

**`bun run test` needs `DEPLO_DATABASE_URL` to be UNSET.** The suite runs in-process
against pglite, and with a real database URL exported the lease and scheduler tests bind
to it and fail. If your shell exports it, run `env -u DEPLO_DATABASE_URL bun run test`.
The full suite takes roughly 12 minutes.

**`bunx next typegen` before `tsc` is not optional.** `PageProps`, `LayoutProps` and
`RouteContext` are generated globals under `.next/types`. On a fresh checkout a bare
`tsc --noEmit` reports dozens of phantom "cannot find name" errors.

If you touched anything in `lib/graphql/types/*`, regenerate the SDL:

```bash
NODE_TEST_CONTEXT=1 node --require ./lib/test/server-only-shim.cjs --import tsx scripts/gen-schema.ts
```

`schema.graphql` is generated output. Never hand-edit it.

## Read these first

deplo has strong opinions and they are written down. Before changing anything structural:

- **[AGENTS.md](AGENTS.md)** - the architecture, the two planes, and the rules that hold
  them apart.
- **[CONTEXT.md](CONTEXT.md)** - the vocabulary. An App is not a service, a Project is not
  a folder, a Capability is not a permission. Use the words in there.
- **[docs/adr/](docs/adr/)** - 25 numbered decisions, indexed in
  [docs/adr/README.md](docs/adr/README.md). If your change contradicts one, say so in the
  pull request instead of quietly overriding it.
- **[deplo.build/docs](https://deplo.build/docs)** - the user manual, and it is **not in this
  repository**: it lives in [DeploCloud/docs](https://github.com/DeploCloud/docs). A change that
  alters what a user sees opens a pull request there too.

The one rule worth repeating here: **the control plane never touches a Docker socket or a
host directly.** Every per-host action goes through the server agent over gRPC and mTLS.
A pull request that reaches around that will be asked to change.

## Commits

[Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) with a scope:
`type(scope): imperative lowercase summary`. Keep the title to 50 characters or fewer, with no
trailing period. A body is optional - two or three lines, and only when the _why_ does not fit in
the title.

```
feat(apps): redeploy a stack from the app page
fix(auth): refuse a suspended account's refresh
docs(readme): name the right image in install
```

Comments in the code follow the same discipline: few and short, about three lines per block at
most. If the explanation needs more room it belongs in a docs page or an ADR, and the comment
becomes a link to it.

## Licensing your contribution

deplo is **AGPL-3.0-only**, and DeploCloud also offers it under commercial terms. For that
to keep working, every contribution has to arrive with the right to do both.

That right is the **[CLA](CLA.md)**, and a bot asks for it on your first pull request. You
read the document and post one sentence as a comment:

```
I have read the CLA Document and I hereby sign the CLA
```

Once per person. It covers every pull request you open after it, and everything you
contributed before it.

You keep the copyright to what you wrote. This is not an assignment: it is the permission
that lets the same code ship in the open source project and in a commercial license
without having to track down every contributor.

If your employer owns your work, get their sign-off before signing.

## The name is not part of the license

The **code** is AGPL-3.0-only. The **name "deplo" and the logo are not**: the license
covers copyright, not trademarks.

You may fork the code, run it, modify it and redistribute it under the AGPL. What you may
not do is present the result as deplo, or use the name and logo in a way that suggests
DeploCloud published or endorsed it. **Rename your fork.** Saying "based on deplo" or "a
fork of deplo" is fine and welcome.

Want to use the name for something else, an integration, a talk, a hosting template? Ask
first at `hello@deplo.build`. The answer is usually yes.
