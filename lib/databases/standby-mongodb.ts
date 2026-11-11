import {
  marks,
  sh,
  standbyContainer,
  type StandbyArgs,
  type StandbyEngine,
} from "./standby-shell";

// MongoDB keeps a standby copy as a second member of the database's own set that never votes (#219).
// Its login is the set's keyfile, which Deplo derives and never shows.

const DIR = "/data/db";
const M = marks(DIR);
const KEYFILE = "/etc/mongo-keyfile";

const auth = `-u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin`;
const copyHost = (a: StandbyArgs) => `${standbyContainer(a.host)}:${a.port}`;

// Exactly the database and its one copy: a copy left over from before a failover is replaced, not added to.
const join = (a: StandbyArgs) =>
  `const h = "${copyHost(a)}"; const c = rs.conf(); ` +
  `const me = c.members.find((x) => x.host === db.hello().me) || c.members[0]; ` +
  `if (c.members.length !== 2 || !c.members.some((x) => x.host === h && x.votes === 0)) { ` +
  `c.members = [me, { _id: me._id === 1 ? 2 : 1, host: h, priority: 0, votes: 0, hidden: true }]; rs.reconfig(c); }`;

const leave = (a: StandbyArgs) =>
  `const h = "${copyHost(a)}"; const c = rs.conf(); ` +
  `if (c.members.some((x) => x.host === h)) { c.members = c.members.filter((x) => x.host !== h); rs.reconfig(c); }`;

const up = `[ "$(mongosh --quiet --eval 'const h = db.hello(); print(h.secondary && h.primary ? "up" : "")' 2>/dev/null)" = up ]`;

export const mongodb: StandbyEngine = {
  label: "MongoDB",
  // The first image that ships mongosh.
  minVersion: "5",
  minMembers: 3,
  // The database already keeps the log a copy reads.
  kept: "",
  prepare: (a) =>
    [
      // A database that has not been redeployed since Deplo began keeping its log is not a set yet.
      `mongosh --quiet ${auth} --eval 'quit(db.hello().setName ? 0 : 3)' >/dev/null 2>&1 || { echo "the database does not keep the log a standby copy reads yet. Redeploy it first." >&2; exit 1; }`,
      `mongosh --quiet ${auth} --eval ${sh(join(a))} >/dev/null`,
    ].join("\n"),
  retire: (a) => `mongosh --quiet ${auth} --eval ${sh(leave(a))} >/dev/null`,
  start: (a) => ({
    env: [`DEPLO_STANDBY_SEED=${a.seed}`],
    command: [
      "sh",
      "-c",
      [
        "set -e",
        `printf %s "$MONGO_KEYFILE" > ${KEYFILE} && chown mongodb:mongodb ${KEYFILE} && chmod 400 ${KEYFILE}`,
        // ponytail: data an old database left here is overwritten; ticket #206 backs it up when its member returns.
        `if ${M.unseeded}; then`,
        `  find ${DIR} -mindepth 1 -delete`,
        // The database cannot reach this server, so the copy brings the set's configuration with it and joins by itself.
        `  conf=$(mongosh --quiet --host ${a.primaryHost} --port ${a.port} ${auth} --eval 'EJSON.stringify(rs.conf(), { relaxed: false })')`,
        `  [ -n "$conf" ]`,
        `  mongod --dbpath ${DIR} --bind_ip 127.0.0.1 --port 27018 --fork --logpath /tmp/deplo-standby.log >/dev/null`,
        `  DEPLO_STANDBY_CONF="$conf" mongosh --quiet --port 27018 --eval 'db.getSiblingDB("local").system.replset.insertOne(EJSON.parse(process.env.DEPLO_STANDBY_CONF))' >/dev/null`,
        `  mongod --dbpath ${DIR} --shutdown >/dev/null`,
        `  chown -R mongodb:mongodb ${DIR}`,
        "fi",
        // Seeded once it is a member that sees its database, never before.
        `(while sleep 5; do if ${up}; then ${M.arrive}; fi; done) &`,
        `exec docker-entrypoint.sh mongod --replSet rs0 --keyFile ${KEYFILE} --bind_ip_all`,
        "",
      ].join("\n"),
    ],
  }),
  check: M.check,
  // Nothing more to run: the database's stack starts over this data under the database's own name, which the
  // set already lists as its one voting member.
  promote: { user: "", command: ["sh", "-c", M.refuse] },
};
