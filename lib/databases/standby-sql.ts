import {
  LOGIN,
  marks,
  sh,
  type StandbyArgs,
  type StandbyEngine,
} from "./standby-shell";

// MySQL and MariaDB keep a standby copy the same way: a dump seeds it, then it follows the binary log (#219).

interface Dialect {
  label: string;
  minVersion: string;
  client: string;
  /** The dump tool with the flags only this engine knows; it writes where the binary log stood as a comment. */
  dump: string;
  server: string;
  rootPassword: string;
  /** The statement that points the copy at its database; `$file` and `$pos` are filled in by the shell. */
  follow(a: StandbyArgs): string;
  /** Shell run once the dump is loaded, before the copy counts as seeded. */
  afterLoad?: string;
  /** Run in the database once no copy follows it, before the login goes. */
  forget?: string;
  settings?: string[];
  kept: string;
}

const DIR = "/var/lib/mysql";
const M = marks(DIR);
const AT = "/tmp/deplo-standby-at";

const GRANTS =
  "SELECT, RELOAD, PROCESS, SHOW VIEW, EVENT, TRIGGER, LOCK TABLES, REPLICATION SLAVE, REPLICATION CLIENT";

function sqlEngine(d: Dialect): StandbyEngine {
  // Root over the container's own socket: the password never rides on a command line.
  const q = `q() { MYSQL_PWD="${d.rootPassword}" ${d.client} -uroot -N -B -e "$1"; }`;
  const running = `[ "$(q 'SHOW REPLICA STATUS\\G' 2>/dev/null | grep -Ec '(IO|SQL)_Running: Yes')" = 2 ]`;
  return {
    label: d.label,
    minVersion: d.minVersion,
    settings: d.settings,
    kept: d.kept,
    prepare: (a) => {
      const login = `'${LOGIN}'@'%'`;
      return [
        "set -e",
        q,
        // The database may have just restarted with the settings a copy needs.
        `i=0; until q 'SELECT 1' >/dev/null 2>&1 || [ $i -ge 20 ]; do i=$((i+1)); sleep 1; done`,
        `[ "$(q 'SELECT @@log_bin')" = 1 ] || { echo "the database has its binary log turned off, which a standby copy follows. Remove that setting from its configuration first." >&2; exit 1; }`,
        `q ${sh(
          `CREATE USER IF NOT EXISTS ${login} IDENTIFIED BY '${a.password}'; ` +
            `ALTER USER ${login} IDENTIFIED BY '${a.password}'; ` +
            `GRANT ${GRANTS} ON *.* TO ${login}`,
        )}`,
      ].join("\n");
    },
    retire: () =>
      [
        q,
        ...(d.forget ? [`q ${sh(d.forget)} 2>/dev/null`] : []),
        `q ${sh(`DROP USER IF EXISTS '${LOGIN}'@'%'`)}`,
      ].join("\n"),
    start: (a) => {
      // Sourced by the image's own entrypoint once the empty engine is up, with `docker_process_sql` at hand.
      const init = [
        `MYSQL_PWD="$DEPLO_STANDBY_PASSWORD" ${d.dump} --host=${a.primaryHost} --port=${a.port} --user=${LOGIN} --all-databases --single-transaction --routines --events --triggers | sed -e '/^-- CHANGE /w ${AT}' | docker_process_sql`,
        `file=$(sed -n "s/.*_LOG_FILE='\\([^']*\\)'.*/\\1/p" ${AT})`,
        `pos=$(sed -n 's/.*_LOG_POS=\\([0-9]*\\).*/\\1/p' ${AT})`,
        `if [ -z "$file" ] || [ -z "$pos" ]; then echo "the dump did not say where the database's binary log stood" >&2; exit 1; fi`,
        `echo "${d.follow(a)}" | docker_process_sql`,
        ...(d.afterLoad ? [d.afterLoad] : []),
        M.arrive,
        "",
      ].join("\n");
      return {
        env: [
          `DEPLO_STANDBY_PASSWORD=${a.password}`,
          `DEPLO_STANDBY_SEED=${a.seed}`,
        ],
        command: [
          "sh",
          "-c",
          [
            "set -e",
            q,
            // ponytail: data an old database left here is overwritten; ticket #206 backs it up when its member returns.
            `if ${M.unseeded}; then`,
            `  find ${DIR} -mindepth 1 -delete`,
            "  mkdir -p /docker-entrypoint-initdb.d",
            "  cat > /docker-entrypoint-initdb.d/deplo-standby.sh <<'DEPLO_STANDBY'",
            init + "DEPLO_STANDBY",
            "fi",
            `(while sleep 5; do if ${running}; then touch ${M.following}; fi; done) &`,
            // The relay log is named, or a recreated container (a new hostname) would lose its place.
            `exec docker-entrypoint.sh ${d.server} --server-id=2 --relay-log=deplo-relay`,
            "",
          ].join("\n"),
        ],
      };
    },
    check: M.check,
    promote: {
      user: "",
      command: [
        "sh",
        "-c",
        [
          M.refuse,
          q,
          "q 'STOP REPLICA IO_THREAD'",
          // ponytail: what the copy received and had not applied after 90 s is dropped; wait on the position if that ever shows.
          `i=0; until q 'SHOW REPLICA STATUS\\G' | grep -qi 'has read all relay log' || [ $i -ge 90 ]; do i=$((i+1)); sleep 1; done`,
          "q 'STOP REPLICA; RESET REPLICA ALL'",
        ].join("\n"),
      ],
    },
  };
}

export const mysql = sqlEngine({
  label: "MySQL",
  // `--source-data` and `CHANGE REPLICATION SOURCE TO` both exist from here.
  minVersion: "8.0.26",
  client: "mysql",
  dump: "mysqldump --get-server-public-key --source-data=2 --set-gtid-purged=OFF",
  server: "mysqld",
  rootPassword: "$MYSQL_ROOT_PASSWORD",
  follow: (a) =>
    `CHANGE REPLICATION SOURCE TO SOURCE_HOST='${a.host}', SOURCE_PORT=${a.port}, SOURCE_USER='${LOGIN}', SOURCE_PASSWORD='$DEPLO_STANDBY_PASSWORD', SOURCE_LOG_FILE='$file', SOURCE_LOG_POS=$pos, GET_SOURCE_PUBLIC_KEY=1;`,
  // MySQL keeps its binary log whether or not a copy follows it.
  kept: "",
});

export const mariadb = sqlEngine({
  label: "MariaDB",
  // The first version that caps its binary log by size.
  minVersion: "11.4",
  client: "mariadb",
  dump: "mariadb-dump --master-data=2",
  server: "mariadbd",
  rootPassword: "$MARIADB_ROOT_PASSWORD",
  follow: (a) =>
    `CHANGE MASTER TO MASTER_HOST='${a.host}', MASTER_PORT=${a.port}, MASTER_USER='${LOGIN}', MASTER_PASSWORD='$DEPLO_STANDBY_PASSWORD', MASTER_LOG_FILE='$file', MASTER_LOG_POS=$pos, MASTER_USE_GTID=no;`,
  // The dump brought the database's health-check login; the image checks this copy with the one it made here.
  afterLoad:
    `hp=$(sed -n 's/^password=//p' ${DIR}/.my-healthcheck.cnf 2>/dev/null || true)\n` +
    `if [ -n "$hp" ]; then for h in localhost 127.0.0.1 ::1; do echo "ALTER USER IF EXISTS healthcheck@'$h' IDENTIFIED BY '$hp';"; done | docker_process_sql; fi`,
  forget: "RESET MASTER",
  // MariaDB writes no binary log until it is started with one: an hour of changes, 1 GiB at most.
  settings: [
    "--log-bin=deplo-binlog",
    "--server-id=1",
    "--binlog-expire-logs-seconds=3600",
    "--max-binlog-total-size=1073741824",
  ],
  kept: "Its own server keeps up to 1 GiB more.",
});
