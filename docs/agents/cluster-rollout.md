# Cluster rollout: shipping a `deplo-cluster` release

How a change to the cluster binary gets from a commit to the machines that run it. It is the
sibling of [`fleet-rollout.md`](fleet-rollout.md) and follows the same rules; this file only says
where the cluster binary differs. Read that one first for the pin, the asset contract and the
forward-only rule.

`deplo-cluster` (`DeploCloud/deplo-cluster`) is one static Go binary: a **cluster leader**, or with
`relay` a **cluster relay** ([ADR-0043](../adr/0043-a-cluster-is-led-by-its-own-leader-not-kubernetes.md),
[ADR-0044](../adr/0044-cluster-members-meet-through-a-relay-over-tcp.md)). The control plane never
dials it: the **server agent** that supervises it installs it and forwards calls, gated on the Hello
capability `cluster.host`.

## 1. The ship path

1. **Push a `v*` tag** in `DeploCloud/deplo-cluster`. The tag is the version: `release.yml` stamps
   `internal/cluster.Version` from `${GITHUB_REF_NAME#v}`.
2. **`release.yml` gates on `go test ./...`**, then builds static (`CGO_ENABLED=0 -trimpath`)
   `linux/amd64` + `linux/arm64`, writes `checksums.txt` with `sha256sum`, attests the binaries'
   provenance (the signature, Sigstore keyless) and publishes them. A canary tag is a pre-release.
3. **Pin it** in `package.json`: `"deplo": { "cluster": "<tag without v>" }`, and `clusterMin` only
   when the panel can no longer lead with an older one. Both are read by `lib/version.ts`
   (`CLUSTER_VERSION`, `CLUSTER_MIN_VERSION`, `clusterPinned()`).
4. **Ship the panel.** `docker-image.yml` refuses to publish one whose `deplo.cluster` has no
   `checksums.txt`.

**An unset pin is allowed, on purpose, while nothing is released.** Both keys are empty strings;
`clusterPinned()` is false, the tag workflow prints a notice instead of failing, and
`lib/version.test.ts` accepts "unset" only when the floor is unset too. The first release sets both.

## 2. The asset-name contract

```
deplo-cluster-linux-amd64
deplo-cluster-linux-arm64
checksums.txt          # sha256sum format: "<64-hex>  <filename>" per line
```

The agent verifies the sha256 from `checksums.txt` (and the attestation) before it installs or
replaces the binary, as SelfUpdate does for itself. A release without `checksums.txt` is refused,
never installed unverified.

## 3. Below the floor

Below `deplo.clusterMin` a cluster's leader is refused, and Deplo's own machine leads that cluster
until the update lands (spec #176). The cluster binary is updated by the agent that supervises it,
one host at a time, so the order in `fleet-rollout.md` §4 applies: **a remote leader before Deplo's
machine, the Deplo host last**, and skip a host while a failover is in flight.

## 4. Rollback is forward-only

Same as the fleet (`fleet-rollout.md` §10): nothing installs an older cluster binary than the one
running, and a bad release is undone by pinning a fixed patch release. Never release a cluster
binary that drops something an older pinned panel still relies on.
