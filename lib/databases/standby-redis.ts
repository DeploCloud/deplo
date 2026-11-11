import { LOGIN, marks, sh, type StandbyEngine } from "./standby-shell";

// Redis keeps a standby copy as a replica that persists like its database: append-only, on disk every second (#219).

const DIR = "/data";
const M = marks(DIR);
const BACKLOG = 64 * 1024 * 1024;

// redis-cli answers an error on stdout and exits 0, so the answer itself is read.
const ok = `ok() { out=$(redis-cli "$@" 2>&1); [ "$out" = OK ] || { echo "$out" >&2; exit 1; }; }`;
const linked = `redis-cli info replication 2>/dev/null | grep -q '^master_link_status:up'`;

export const redis: StandbyEngine = {
  label: "Redis",
  // The first version with logins of its own: the copy never uses the database's password.
  minVersion: "6",
  kept: "Its own server uses up to 64 MB more memory.",
  // Neither survives a restart of the database, which is why a copy that waits has it prepared again.
  prepare: (a) =>
    [
      ok,
      `ok ACL SETUSER ${LOGIN} reset on ${sh(`>${a.password}`)} +psync +replconf +ping`,
      // Room for a copy that lost its database for a moment to catch up without starting over.
      `ok CONFIG SET repl-backlog-size ${BACKLOG}`,
    ].join("\n"),
  retire: () =>
    [
      `redis-cli ACL DELUSER ${LOGIN} >/dev/null`,
      "redis-cli CONFIG SET repl-backlog-size 1048576 >/dev/null",
    ].join("\n"),
  start: (a) => ({
    env: [
      `DEPLO_STANDBY_PASSWORD=${a.password}`,
      `DEPLO_STANDBY_SEED=${a.seed}`,
    ],
    command: [
      "sh",
      "-c",
      [
        "set -e",
        // ponytail: data an old database left here is overwritten; ticket #206 backs it up when its member returns.
        `if ${M.unseeded}; then find ${DIR} -mindepth 1 -delete; fi`,
        // Seeded once the first full copy has arrived, never before.
        `(while sleep 5; do if ${linked}; then ${M.arrive}; fi; done) &`,
        `exec docker-entrypoint.sh redis-server --requirepass "$REDISCLI_AUTH" --appendonly yes --appendfsync everysec --replicaof ${a.primaryHost} ${a.port} --masteruser ${LOGIN} --masterauth "$DEPLO_STANDBY_PASSWORD"`,
        "",
      ].join("\n"),
    ],
  }),
  check: M.check,
  promote: {
    user: "",
    command: [
      "sh",
      "-c",
      [
        M.refuse,
        // Mid-way through a full copy the data here is not whole.
        `redis-cli info replication | grep -q '^master_sync_in_progress:0' || { echo "the standby copy was still receiving its database's data" >&2; exit 1; }`,
        '[ "$(redis-cli REPLICAOF NO ONE)" = OK ]',
      ].join("\n"),
    ],
  },
};
