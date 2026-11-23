import type { ClusterLeaseState } from "../types/cluster";

export const TWO_SERVERS_JOINED =
  "Failover is on. With two servers it works only while Deplo is up.";

// A leader moves work while more than half of the servers answer it, or exactly half and Deplo does.
export function leaderHearsEnough(answering: number, total: number): boolean {
  return answering > 0 && answering * 2 >= total;
}

const need = (total: number) => Math.ceil(total / 2);

/** What the card says while its leader answers and too few servers answer the leader. */
export function tooFewSentence(answering: number, total: number): string {
  const heard =
    answering === 0
      ? `None of the ${total} servers answers`
      : `Only ${answering} of ${total} servers ${answering === 1 ? "answers" : "answer"}`;
  const n = need(total);
  return `${heard} this leader, so nothing moves. Failover works again once ${n} ${n === 1 ? "does" : "do"}.`;
}

/** Deplo's machine standing in hears only some servers: the others are off or cut off from it, which it cannot tell apart. */
export function standInWhy(
  name: string,
  cluster: string,
  hears: string[],
): string {
  return `Deplo's machine, standing in as the leader of cluster ${cluster}, hears ${hears.length > 0 ? list(hears) : "none of its servers"}: ${name} is off, or cut off from it`;
}

/** The Activity entry for a server's lease change; `tooFew` is the leader no longer hearing enough servers to move anything. */
export function leaseSentence(
  name: string,
  cluster: string,
  state: ClusterLeaseState,
  tooFew: boolean,
): string {
  if (state === "ok") return `${name} answers again in cluster ${cluster}.`;
  if (tooFew)
    return state === "not_responding"
      ? `Too few servers answer in cluster ${cluster}, so nothing moves and ${name} no longer counts as answering.`
      : `Too few servers answer in cluster ${cluster}, so ${name} stopped the databases and Apps with files that must never run twice.`;
  return state === "not_responding"
    ? `${name} is not responding in cluster ${cluster}.`
    : `${name} stopped responding in cluster ${cluster}, so it stopped the databases and Apps with files that must never run twice.`;
}

export const list = (names: string[]) =>
  names.length < 2
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

/**
 * A member whose lease ran out, said as it is: what it held that must never run twice, and whether its agent says
 * it stopped it (true), still runs it (false) or does not answer (null).
 */
export function stoppedSentence(
  name: string,
  cluster: string,
  tooFew: boolean,
  writers: string[],
  stopped: boolean | null,
  why = tooFew
    ? `Too few servers answer in cluster ${cluster}`
    : `${name} stopped responding in cluster ${cluster}`,
): string {
  if (writers.length === 0)
    return `${why}. ${name} runs no database or App that must never run twice, so nothing on it had to stop.`;
  const what = list(writers);
  if (stopped === true)
    return `${why}, so ${name} stopped ${what}: it must never run twice.`;
  if (stopped === false)
    return `${why}, but ${name} still runs ${what}, which must never run twice. Its server agent stops it once its lease is over.`;
  return `${why}. Its lease ran out, so ${name} stops ${what} on its own if it is still running; Deplo cannot reach it to check.`;
}
