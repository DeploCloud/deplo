# ADR-0038: Security updates are matched in the control plane

**Status**: accepted

Deplo checks every image it runs for a team (apps of every source, template apps, managed databases, stopped workloads and pull request previews) against known vulnerabilities, and tells the team what to do in its own words. Deplo's own components are out of scope: their fix is a Deplo release.

**The server agent reads, the control plane judges.** `InventoryImage` reads one image's package list with syft (version and archive checksum pinned in the agent, downloaded at first use), one image at a time, never during a deploy, under a hard cgroup memory cap (`systemd-run`, a quarter of RAM between 512 MB and 2 GB) and a 2x-image free-disk guard. The list is stored per image id (`image_inventories`), so an image is read once. `ListWorkloadImages` says what runs where; both ride the `image-inventory` capability.

**"Periodic" is re-matching, not re-reading.** Images do not change; what is known about them does. A leased scheduler re-matches every stored list against OSV.dev every 6 hours, a new image within about 5 minutes, and refreshes CISA's known-exploited list daily. Only package ecosystem, name and version leave the instance, never an app name, a host or anything that identifies the instance. With no egress the checks fail open: findings stay as they were and the settings line says since when OSV could not be reached. An instance admin can turn the checks off.

**Counted from the team's side.** A finding counts in the badge, the banner and the alert only when the team can act on it, or it is already used in attacks: a dependency in the app's own code, the base of a Dockerfile build, or a newer build or version of a vendor image in its registry. A fix only the image's maintainers can ship is listed as "No fix yet". One security update is one package to move, however many advisories that closes. Kernel headers are never matched. Levels are "Used in attacks" (known-exploited), "Critical" and "Important"; anything lower is not stored.

**Alerts are rare on purpose.** `security_update_available` fires once per finding, for running apps and databases only, when a flaw is known-exploited or critical with a fix the team can apply. Deduplication lives in the database (`security_findings.alerted_at`), not the per-process cooldown.
