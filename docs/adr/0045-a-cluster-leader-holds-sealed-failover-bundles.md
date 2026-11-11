# ADR-0045: A cluster leader holds sealed failover bundles

**Status**: proposed. Follows from [ADR-0043](0043-a-cluster-is-led-by-its-own-leader-not-kubernetes.md).

To fail over while Deplo is down, the leader must re-send a workload's last stack with its decrypted variables, which until now only the control plane could produce. **The leader keeps one failover bundle per cluster workload**: the last rendered stack, its plaintext env-file, registry credentials, the run token of the App's own Cloudflare tunnel, and for a database its engine password and backup destination credentials. It holds exactly what a member already receives at deploy, and no more: never `DEPLO_SECRET`, never an account or zone token.

A workload that keeps data also carries the backup request a member that comes back uses to save what it still held before removing it (#206). It names the same destination, and the leader hands it only to the member that workload moved off, with the order that asks what it removed; neither the leader nor that member writes it to disk.

The leader makes an age key pair at install and only its public key leaves its machine. The control plane seals every bundle to it, so bundles are ciphertext at rest and opened in memory only to send a failover inside mutual TLS. A new bundle follows every successful deploy; leaving the cluster deletes it; a moved or reinstalled leader gets a new key and every bundle again.

## Considered options

- **The leader holds nothing**: rejected. A remote leader could then fail over no App with a secret, which is nearly every App, and ADR-0043's reason for a remote leader disappears.
- **The leader holds a decryption key for the database's `*_enc` columns**: rejected. One stolen file would open every secret of the instance.
- **Bundles kept on every member instead**: rejected. It spreads the same secrets to more machines for no gain.

## Consequences

- A compromised leader machine exposes the clusters' workloads' variables, as a compromised member already exposes its own.
- A workload whose bundle the leader never received does not fail over, and Activity says why.
- **The control plane keeps each bundle too**, in `failover_bundle_pushes.bundle_enc`, encrypted under `DEPLO_SECRET` like every other `*_enc` column. That is what lets it seal the same bundle to a new leader key and resend one a leader lost, without a redeploy. It is a second copy at rest of values the control plane already holds (variables, registry and destination credentials, the tunnel token, the engine password), and one whole document in a text column by decision, not a precedent for JSON in the schema: it is ciphertext nothing queries into.
