// The DNS records of a domain that answers on every server (ADR-0048 step 3): one A, and one AAAA where there is
// IPv6, per server of the cluster that is online and not being emptied.

import type { DnsAnswers } from "./cloudflare";

export interface AnswerServer {
  id: string;
  online: boolean;
  emptying: boolean;
  v4: string[];
  v6: string[];
  /** False when its agent could not list its addresses: a stopped server's IPv6 is then unknown. */
  known?: boolean;
}

export interface AnswerRecordSet {
  a: string[];
  aaaa: string[];
  /** Every address of every server of the cluster, healthy or not: a record naming one still reaches the cluster. */
  members?: string[];
  /** Every server's addresses were known: only then is an address outside `members` another host's. */
  complete?: boolean;
}

const sorted = (xs: string[]) => [...new Set(xs)].sort();

/** The records the domain must hold: each healthy server's first address of each family. */
export function answerRecordSet(servers: AnswerServer[]): AnswerRecordSet {
  const healthy = servers.filter((s) => s.online && !s.emptying);
  return {
    a: sorted(healthy.flatMap((s) => s.v4.slice(0, 1))),
    aaaa: sorted(healthy.flatMap((s) => s.v6.slice(0, 1))),
    members: sorted(servers.flatMap((s) => [...s.v4, ...s.v6])),
    complete: servers.every((s) => s.known !== false),
  };
}

export interface AnswerRecordCheck {
  status: "valid" | "misconfigured" | "pending";
  /** Addresses the set needs that DNS does not answer with. */
  missing: string[];
  /** Addresses DNS answers with that no healthy server of the cluster has: a stopped server's, or another host's. */
  extra: string[];
}

/**
 * Whether the domain reaches the cluster: valid while every address DNS answers is a server of the cluster and one
 * of them is healthy, since each server passes the domain on. `missing` and `extra` say what to change to match the
 * set exactly; a stopped server still listed costs visitors a retry, never the domain its route.
 */
export function checkAnswerRecords(
  answers: DnsAnswers,
  set: AnswerRecordSet,
): AnswerRecordCheck {
  if (answers.a.length === 0 && answers.aaaa.length === 0)
    return {
      status: "pending",
      missing: [...set.a, ...set.aaaa],
      extra: [],
    };
  const missing = [
    ...set.a.filter((ip) => !answers.a.includes(ip)),
    ...set.aaaa.filter((ip) => !answers.aaaa.includes(ip)),
  ];
  const extra = [
    ...sorted(answers.a).filter((ip) => !set.a.includes(ip)),
    ...sorted(answers.aaaa).filter((ip) => !set.aaaa.includes(ip)),
  ];
  const members = set.members ? new Set(set.members) : null;
  const healthy = new Set([...set.a, ...set.aaaa]);
  const answered = [...answers.a, ...answers.aaaa];
  const reaches = members
    ? (set.complete === false ||
        answered.every((ip) => members.has(ip) || healthy.has(ip))) &&
      answered.some((ip) => healthy.has(ip))
    : missing.length === 0 && extra.length === 0;
  return { status: reaches ? "valid" : "misconfigured", missing, extra };
}
