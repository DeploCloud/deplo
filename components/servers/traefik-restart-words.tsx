/** What a restart of the proxy does: on a cluster member it rolls, so only an App on this server alone notices. */
export function TraefikRestartWords({ cluster }: { cluster: string | null }) {
  if (!cluster)
    return (
      <>
        <strong>Every site on this server is unreachable</strong> for the few
        seconds Traefik takes to come back. The containers keep running.
      </>
    );
  return (
    <>
      This server leaves cluster {cluster}&apos;s answers first, restarts
      Traefik and is back in them in about 30 seconds.{" "}
      <strong>Apps on the other servers are not affected</strong>; an App that
      runs only on this server is unreachable for a few seconds. The containers
      keep running.
    </>
  );
}
