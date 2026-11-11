import type { FailoverBundle } from "./clusters/bundles";

const enc = new TextEncoder();
const dec = new TextDecoder();
const answer = (v: unknown) => enc.encode(JSON.stringify(v));

type Roster = {
  cluster: string;
  epoch: number;
  members: { id: string }[];
  placement: unknown[];
};

/** A leader as the agent forwards to it: its own key, the bundles it holds, and the epoch rule of the real one. */
export interface TestLeader {
  identity: string;
  publicKey: string;
  held: Map<
    string,
    { cluster: string; deploymentId: string; sealed: Uint8Array }
  >;
  /** The epoch it holds for each cluster; an older roster is refused. */
  epochs: Map<string, number>;
  rosters: Roster[];
  /** The newest sequence of its event buffer, as its snapshot reports it. */
  head: number;
  calls: (method: string, payload: Uint8Array) => Uint8Array;
}

export async function newTestLeader(): Promise<TestLeader> {
  const age = await import("age-encryption");
  const identity = await age.generateX25519Identity();
  const l: TestLeader = {
    identity,
    publicKey: await age.identityToRecipient(identity),
    held: new Map(),
    epochs: new Map(),
    rosters: [],
    head: 0,
    calls(method, payload) {
      const body = payload.length
        ? (JSON.parse(dec.decode(payload)) as Record<string, string>)
        : {};
      if (method === "leader.key") return answer({ publicKey: l.publicKey });
      if (method === "leader.roster") {
        const r = body as unknown as Roster;
        if (r.epoch < (l.epochs.get(r.cluster) ?? 0))
          throw new Error("the leader holds a newer epoch");
        l.epochs.set(r.cluster, r.epoch);
        l.rosters.push(r);
        return answer({ ok: true });
      }
      if (method === "leader.snapshot")
        return answer({
          head: l.head,
          clusters: Object.fromEntries(
            [...l.epochs].map(([id, epoch]) => [
              id,
              { epoch, superseded: false, members: [], placement: [] },
            ]),
          ),
        });
      if (method === "leader.bundle.put") {
        l.held.set(body.id, {
          cluster: body.cluster,
          deploymentId: body.deploymentId,
          sealed: Buffer.from(body.sealed, "base64"),
        });
        return answer({});
      }
      if (method === "leader.bundle.drop") {
        l.held.delete(body.id);
        return answer({});
      }
      if (method === "leader.bundle.list")
        return answer({
          bundles: [...l.held]
            .filter(([, b]) => b.cluster === body.cluster)
            .map(([id, b]) => ({
              kind: "app",
              id,
              deploymentId: b.deploymentId,
            })),
        });
      if (method === "placement.place") return answer({ member: "srv_2" });
      return payload;
    },
  };
  return l;
}

/** Opens the bundle a leader holds with that leader's own identity; throws when it was sealed to another key. */
export async function openBundle(
  l: TestLeader,
  id: string,
): Promise<FailoverBundle> {
  const age = await import("age-encryption");
  const d = new age.Decrypter();
  d.addIdentity(l.identity);
  return JSON.parse(
    await d.decrypt(l.held.get(id)!.sealed, "text"),
  ) as FailoverBundle;
}
