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
