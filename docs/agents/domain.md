# Domain docs

Where this repo keeps its ubiquitous language and its decisions, and how a skill should consume
them.

## Read before you explore

- **`CONTEXT.md`** at the repo root: the glossary. Every entry carries an _Avoid_ line naming the
  synonyms this project refuses (App not service, Project not group, Capability not permission,
  active team not current team).
- **`docs/adr/`**: numbered decisions, indexed in `docs/adr/README.md` (0001-0032 today). Read the
  ones that touch the area you are about to change - ADR-0006 (the agent boundary) and ADR-0031
  (the URL names the team) constrain almost everything.

This repo is **single-context**: one `CONTEXT.md` + one `docs/adr/` at the root, no
`CONTEXT-MAP.md`, no per-context `src/<context>/` trees. The code lives in `app/`, `lib/` and
`components/` - a skill that expects `src/` is reading a different repo's layout.

## Use the glossary's vocabulary

When your output names a domain concept - an issue title, a test name, a proposal, a UI string -
use the term `CONTEXT.md` defines, not a synonym you find tidier. A concept that is missing from
the glossary is a signal: either you are inventing language (reconsider) or there is a real gap
worth filling with a new entry in the same shape as its neighbours.

## Flag ADR conflicts, don't silently override

If what you are about to write contradicts an ADR, say so before writing it:

> _Contradicts ADR-0028 (an Environment owns a network), but worth reopening because X._

The decision then either changes with the owner's agreement and a new ADR, or your design does.
Never leave the code and the ADR disagreeing without a line saying which one won.
