// The DNS records of a domain that answers on every server (ADR-0048 step 3): one A, and one AAAA where there is
// IPv6, per server of the cluster that is online and not being emptied.

import type { DnsAnswers } from "./cloudflare";

export interface AnswerServer {
  id: string;
  online: boolean;
  emptying: boolean;
  v4: string[];
  v6: string[];
}

export interface AnswerRecordSet {
  a: string[];
  aaaa: string[];
  /** Every address of every server of the cluster, healthy or not: a record naming one still reaches the cluster. */
  members?: string[];
}

/** TTL of each record Deplo writes: a stopped server drops out of answers within a minute. */
export const ANSWER_RECORD_TTL = 60;

const sorted = (xs: string[]) => [...new Set(xs)].sort();

/** The records the domain must hold: each healthy server's first address of each family. */
export function answerRecordSet(servers: AnswerServer[]): AnswerRecordSet {
  const healthy = servers.filter((s) => s.online && !s.emptying);
  return {
    a: sorted(healthy.flatMap((s) => s.v4.slice(0, 1))),
    aaaa: sorted(healthy.flatMap((s) => s.v6.slice(0, 1))),
    members: sorted(servers.flatMap((s) => [...s.v4, ...s.v6])),
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
    ? answered.every((ip) => members.has(ip) || healthy.has(ip)) &&
      answered.some((ip) => healthy.has(ip))
    : missing.length === 0 && extra.length === 0;
  return { status: reaches ? "valid" : "misconfigured", missing, extra };
}

export interface RecordChange {
  create: { type: "A" | "AAAA"; content: string }[];
  /** Ids of records Deplo wrote that the set no longer has. */
  remove: string[];
}

/**
 * What to change at a connected provider so the name holds exactly the set. A record Deplo did not write (another
 * comment, or a CNAME) is never touched: the caller refuses instead, naming it.
 */
export function answerRecordChange(
  existing: { id: string; type: string; content: string; ours: boolean }[],
  set: AnswerRecordSet,
): RecordChange & { foreign: { type: string; content: string } | null } {
  const wanted = [
    ...set.a.map((content) => ({ type: "A" as const, content })),
    ...set.aaaa.map((content) => ({ type: "AAAA" as const, content })),
  ];
  const routing = existing.filter((r) =>
    ["A", "AAAA", "CNAME"].includes(r.type),
  );
  const has = (w: { type: string; content: string }) =>
    routing.some((r) => r.type === w.type && r.content === w.content);
  const foreign =
    routing.find(
      (r) =>
        !r.ours &&
        !wanted.some((w) => w.type === r.type && w.content === r.content),
    ) ?? null;
  return {
    foreign: foreign ? { type: foreign.type, content: foreign.content } : null,
    create: wanted.filter((w) => !has(w)),
    remove: routing
      .filter(
        (r) =>
          r.ours &&
          !wanted.some((w) => w.type === r.type && w.content === r.content),
      )
      .map((r) => r.id),
  };
}
