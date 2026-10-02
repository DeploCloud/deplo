import "server-only";

import { instanceFingerprint } from "../migration/deplo/instance";
import {
  PanelUnreachableError,
  REQUEST_TIMEOUT_MS,
  openStream,
  panelSaid,
  refuseRedirect,
  sendRequest,
  type PanelIdentity,
} from "../migration/transport";
import { publicBaseUrl } from "../public-url";
import {
  MOVE_PEER_HEADER,
  MOVE_PEER_URL_HEADER,
  type MoveCsrResponse,
  type MoveHello,
  type MoveStep,
} from "./protocol";

// The new Deplo's side of the wire (ADR-0035): one call per step, POST /api/deplo-move/<step>.
export interface MoveCredential {
  baseUrl: string;
  code: string;
}

// The old Deplo answered and said no; `handedOver` is its "that server already answers to you".
export class MoveRefusedError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly handedOver = false,
  ) {
    super(message);
    this.name = "MoveRefusedError";
  }
}

const PANEL: PanelIdentity = { name: "Deplo", portHint: ":3000" };

// The old Deplo dials every server agent to answer hello, so it gets longer than a plain request.
const HELLO_TIMEOUT_MS = 60_000;
const AGENT_STEP_TIMEOUT_MS = 30_000;

const NOT_A_MOVE_SOURCE =
  "Nothing at that address can be moved: check it is the old Deplo, and update it if it is older than this one.";
const NOT_A_DEPLO = "That address answered, but not as a Deplo.";
const CUT_OFF = "The copy was cut off before it finished. Retry the move.";

function headers(c: MoveCredential): Record<string, string> {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    "User-Agent": "deplo",
    Authorization: `Bearer ${c.code}`,
    [MOVE_PEER_HEADER]: instanceFingerprint(),
    [MOVE_PEER_URL_HEADER]: publicBaseUrl() ?? "",
  };
}

// The shared transport suggests plain http for a certificate it cannot trust; a move never takes that way out.
function httpsOnly(e: unknown): unknown {
  if (!(e instanceof PanelUnreachableError)) return e;
  if (/certificate/i.test(e.message))
    return new PanelUnreachableError(
      "The old Deplo's https certificate is not one this machine trusts. Use the address it is reached at with a valid certificate.",
    );
  if (/not over https/i.test(e.message))
    return new PanelUnreachableError(
      "The old Deplo does not answer over https at that address, and a move only runs over https.",
    );
  return e;
}

async function refusal(res: Response): Promise<MoveRefusedError> {
  const text = await res.text().catch(() => "");
  let said = "";
  let handedOver = false;
  try {
    const body = JSON.parse(text) as { error?: unknown; handedOver?: unknown };
    if (typeof body.error === "string") said = body.error.trim();
    handedOver = body.handedOver === true;
  } catch {}
  if (said) return new MoveRefusedError(said, res.status, handedOver);
  if (res.status === 404)
    return new MoveRefusedError(NOT_A_MOVE_SOURCE, res.status);
  const raw = panelSaid(text);
  return new MoveRefusedError(
    `The old Deplo answered ${res.status}${raw ? `: ${raw}` : "."}`,
    res.status,
  );
}

function stepUrl(c: MoveCredential, step: MoveStep): string {
  return `${c.baseUrl}/api/deplo-move/${step}`;
}

async function call<T>(
  c: MoveCredential,
  step: MoveStep,
  body: unknown,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<T> {
  let res: Response;
  try {
    res = await sendRequest(
      c.baseUrl,
      stepUrl(c, step),
      {
        method: "POST",
        headers: headers(c),
        body: JSON.stringify(body ?? {}),
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      },
      PANEL,
    );
  } catch (e) {
    throw httpsOnly(e);
  }
  refuseRedirect(res, PANEL);
  if (!res.ok) throw await refusal(res);
  const text = await res.text().catch(() => "");
  if (!text.trim()) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(NOT_A_DEPLO);
  }
}

export async function hello(c: MoveCredential): Promise<MoveHello> {
  const h = await call<MoveHello>(c, "hello", {}, HELLO_TIMEOUT_MS);
  if (
    !h ||
    typeof h.protocol !== "number" ||
    typeof h.schema !== "string" ||
    typeof h.instance !== "string" ||
    !Array.isArray(h.servers)
  )
    throw new Error(NOT_A_DEPLO);
  return h;
}

export async function freeze(c: MoveCredential): Promise<void> {
  await call(c, "freeze", {});
}

export async function csr(
  c: MoveCredential,
  serverId: string,
): Promise<string> {
  const r = await call<MoveCsrResponse>(
    c,
    "csr",
    { serverId },
    AGENT_STEP_TIMEOUT_MS,
  );
  if (typeof r.csrPem !== "string" || !r.csrPem) throw new Error(NOT_A_DEPLO);
  return r.csrPem;
}

export async function install(
  c: MoveCredential,
  serverId: string,
  certPem: string,
  caPem: string,
): Promise<void> {
  await call(c, "install", { serverId, certPem, caPem }, AGENT_STEP_TIMEOUT_MS);
}

export async function finish(
  c: MoveCredential,
  movedTo: string,
  handedOver: string[],
): Promise<void> {
  await call(c, "finish", { movedTo, handedOver });
}

export async function thaw(c: MoveCredential): Promise<void> {
  await call(c, "thaw", {});
}

function isEndFrame(line: string): boolean {
  try {
    return (JSON.parse(line) as { kind?: unknown }).kind === "end";
  } catch {
    return false;
  }
}

// The old Deplo waits up to 4 minutes for builds and backups to settle before the first byte.
const DUMP_HEADERS_TIMEOUT_MS = 5 * 60_000;

// NDJSON, one frame a line. A stream that stops before its `end` frame throws, so a cut copy never commits.
export function dump(c: MoveCredential): AsyncIterable<string> {
  return (async function* () {
    const aborter = new AbortController();
    let late = false;
    const deadline = setTimeout(() => {
      late = true;
      aborter.abort();
    }, DUMP_HEADERS_TIMEOUT_MS);
    try {
      let res: Response;
      try {
        res = await openStream(
          c.baseUrl,
          stepUrl(c, "dump"),
          {
            method: "POST",
            headers: { ...headers(c), Accept: "application/x-ndjson" },
            body: "{}",
            redirect: "manual",
            signal: aborter.signal,
          },
          PANEL,
        );
      } catch (e) {
        if (late)
          throw new Error(
            "The old Deplo did not start the copy within 5 minutes. Retry the move.",
          );
        throw httpsOnly(e);
      } finally {
        clearTimeout(deadline);
      }
      refuseRedirect(res, PANEL);
      if (!res.ok) throw await refusal(res);
      if (!res.body) throw new Error(CUT_OFF);
      const decoder = new TextDecoder();
      let buf = "";
      let last = "";
      try {
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          buf += decoder.decode(chunk, { stream: true });
          let start = 0;
          let nl: number;
          while ((nl = buf.indexOf("\n", start)) !== -1) {
            const line = buf.slice(start, nl).replace(/\r$/, "");
            start = nl + 1;
            if (!line.trim()) continue;
            last = line;
            yield line;
          }
          buf = buf.slice(start);
        }
      } catch (e) {
        throw new Error(CUT_OFF, { cause: e });
      }
      const rest = (buf + decoder.decode()).replace(/\r$/, "");
      if (rest.trim()) last = rest;
      if (!isEndFrame(last)) throw new Error(CUT_OFF);
      if (rest.trim()) yield rest;
    } finally {
      aborter.abort();
    }
  })();
}
