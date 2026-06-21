# Dev containers run on official base images, set up by a bind-mounted entrypoint

## Context

A dev container needs `git`, a UID-1000 `devuser`, and a default dev command on top of a
language base. The obvious path is to build six thin `deplo/dev-<lang>:latest` images
(node/python/go/rust/php/java) that bake these in. But Deplo is a single-host,
self-hosted tool where install simplicity is a first-class concern, and six Dockerfiles
means a build step at install (or shipping prebuilt images) plus ongoing maintenance and
version drift against the upstream bases.

## Decision

Dev containers run on **official base images directly** (`node:22`, `python:3.12`,
`golang:1.23`, `rust:1`, `php:8.3`, `eclipse-temurin:21`). The dev image **preset** is
**derived by default from the project's `framework`** (nextjs/svelte/astro → `node`,
etc.), overridable only for the custom-image case — so the preset never drifts from the
framework's language. The `devuser`/git/dep-install setup runs in a small **entrypoint
script bind-mounted from `/data`** at first boot, not baked into a custom image.

## Consequences

- Zero per-language images to build, tag, version, or ship; install gains no build step.
- First boot of a fresh dev container pays a few seconds of apk/apt + dep install.
  Accepted; only happens once per workspace (the workspace then persists).
- If first-boot latency ever becomes a problem, prebuilt `deplo/dev-<lang>` images can be
  reintroduced as a pure optimization behind the same preset — not a prerequisite.
- The entrypoint lives in `/data` (bind-mounted), so it is updatable without rebuilding
  anything, consistent with how stacks/configs already live under `/data`.
