import { builder } from "../builder";
import type { FailoverReach } from "@/lib/data/clusters/architectures";

export const FailoverReachRef = builder
  .objectRef<FailoverReach>("FailoverReach")
  .implement({
    description:
      "On a cluster of ARM and x86 servers: which of them an app or database can fail over to.",
    fields: (t) => ({
      line: t.exposeString("line", {
        nullable: true,
        description: '"Fails over to x86 servers only (2 of 3)".',
      }),
      warning: t.exposeString("warning", {
        nullable: true,
        description:
          "Set instead of the line when a single server can run it, so it has nowhere to go if that one stops.",
      }),
    }),
  });

/** Null when every server of the cluster can take it. */
export const reachOrNull = (r: FailoverReach): FailoverReach | null =>
  r.line || r.warning ? r : null;
