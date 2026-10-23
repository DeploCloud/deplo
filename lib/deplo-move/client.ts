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
  MOVE_FILENAME_HEADER,
  MOVE_PEER_HEADER,
  MOVE_PEER_URL_HEADER,
  type MoveHello,
  type MovePauseResponse,
  type MoveStep,
  type MoveWorkloadInfo,
  type WorkloadRef,
} from "./protocol";

// The new Deplo's side of the wire (ADR-0035): one call per step, POST /api/deplo-move/<step>.
export interface MoveCredential {
  baseUrl: string;
  code: string;
}

// The old Deplo answered and said no. A data step's `code` 5 is "not on that server", like an agent's NOT_FOUND.
export class MoveRefusedError extends Error {
  code?: number;
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "MoveRefusedError";
  }
}

const PANEL: PanelIdentity = { name: "Deplo", portHint: ":3000" };

// The old Deplo dials its server agents to answer these, so they get longer than a plain request.
const HELLO_TIMEOUT_MS = 60_000;
const AGENT_STEP_TIMEOUT_MS = 2 * 60_000;

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
  let code: number | undefined;
  try {
    const body = JSON.parse(text) as { error?: unknown; code?: unknown };
    if (typeof body.error === "string") said = body.error.trim();
    if (typeof body.code === "number") code = body.code;
  } catch {}
  if (said) {
    const e = new MoveRefusedError(said, res.status);
    e.code = code ?? (res.status === 404 ? 5 : undefined);
    return e;
  }
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

function deadline(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([timeout, signal]) : timeout;
}

async function call<T>(
  c: MoveCredential,
  step: MoveStep,
  body: unknown,
  timeoutMs = REQUEST_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
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
        signal: deadline(timeoutMs, signal),
      },
      PANEL,
    );
  } catch (e) {
    signal?.throwIfAborted();
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

export async function hello(
  c: MoveCredential,
  signal?: AbortSignal,
): Promise<MoveHello> {
  const h = await call<MoveHello>(c, "hello", {}, HELLO_TIMEOUT_MS, signal);
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

const ref = (w: WorkloadRef): WorkloadRef => ({ kind: w.kind, id: w.id });

export async function workload(
  c: MoveCredential,
  w: WorkloadRef,
  signal?: AbortSignal,
): Promise<MoveWorkloadInfo> {
  const info = await call<MoveWorkloadInfo>(
    c,
    "workload",
    ref(w),
    AGENT_STEP_TIMEOUT_MS,
    signal,
  );
  if (
    info?.id !== w.id ||
    !Array.isArray(info.volumes) ||
    !Array.isArray(info.hostPaths)
  )
    throw new Error(NOT_A_DEPLO);
  return info;
}

export async function pause(
  c: MoveCredential,
  w: WorkloadRef,
  signal?: AbortSignal,
): Promise<MovePauseResponse> {
  const r = await call<MovePauseResponse>(
    c,
    "pause",
    ref(w),
    AGENT_STEP_TIMEOUT_MS,
    signal,
  );
  if (typeof r.wasRunning !== "boolean") throw new Error(NOT_A_DEPLO);
  return r;
}

// False: the lease had lapsed and the old Deplo already started it again, so a copy read since may be torn.
export async function resume(
  c: MoveCredential,
  w: WorkloadRef,
): Promise<boolean> {
  const r = await call<{ resumed?: unknown }>(
    c,
    "resume",
    ref(w),
    AGENT_STEP_TIMEOUT_MS,
  );
  return r.resumed !== false;
}

export async function finish(c: MoveCredential): Promise<void> {
  await call(c, "finish", {});
}

export async function cancel(c: MoveCredential): Promise<void> {
  await call(c, "cancel", {}, AGENT_STEP_TIMEOUT_MS);
}

interface OpenedStream {
  res: Response;
  close: () => void;
}

// One attempt and no deadline: a copy may run for hours, and a retry would start it over.
async function openData(
  c: MoveCredential,
  step: MoveStep,
  body: unknown,
  signal?: AbortSignal,
): Promise<OpenedStream> {
  signal?.throwIfAborted();
  const aborter = new AbortController();
  const onAbort = () => aborter.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  const close = () => {
    signal?.removeEventListener("abort", onAbort);
    aborter.abort();
  };
  try {
    let res: Response;
    try {
      res = await openStream(
        c.baseUrl,
        stepUrl(c, step),
        {
          method: "POST",
          headers: { ...headers(c), Accept: "application/octet-stream" },
          body: JSON.stringify(body),
          redirect: "manual",
          signal: aborter.signal,
        },
        PANEL,
      );
    } catch (e) {
      signal?.throwIfAborted();
      throw httpsOnly(e);
    }
    refuseRedirect(res, PANEL);
    if (!res.ok) throw await refusal(res);
    return { res, close };
  } catch (e) {
    close();
    throw e;
  }
}

async function* chunksOf(opened: OpenedStream): AsyncGenerator<Buffer> {
  try {
    // 204: the old Deplo has nothing to send, like an agent's empty export.
    if (opened.res.status === 204 || !opened.res.body) return;
    try {
      for await (const chunk of opened.res
        .body as unknown as AsyncIterable<Uint8Array>)
        yield Buffer.from(chunk);
    } catch (e) {
      throw new Error(CUT_OFF, { cause: e });
    }
  } finally {
    opened.close();
  }
}

function dataStream(
  c: MoveCredential,
  step: MoveStep,
  body: unknown,
  signal?: AbortSignal,
): AsyncIterable<Buffer> {
  return (async function* () {
    yield* chunksOf(await openData(c, step, body, signal));
  })();
}

export function volume(
  c: MoveCredential,
  w: WorkloadRef,
  name: string,
  signal?: AbortSignal,
): AsyncIterable<Buffer> {
  return dataStream(c, "volume", { ...ref(w), volume: name }, signal);
}

export function hostPath(
  c: MoveCredential,
  w: WorkloadRef,
  path: string,
  allowFile: boolean,
  signal?: AbortSignal,
): AsyncIterable<Buffer> {
  return dataStream(c, "hostpath", { ...ref(w), path, allowFile }, signal);
}

export function files(
  c: MoveCredential,
  w: WorkloadRef,
  signal?: AbortSignal,
): AsyncIterable<Buffer> {
  return dataStream(c, "files", ref(w), signal);
}

export function image(
  c: MoveCredential,
  w: WorkloadRef,
  imageRef: string,
  signal?: AbortSignal,
): AsyncIterable<Buffer> {
  return dataStream(c, "image", { ...ref(w), imageRef }, signal);
}

function headerFilename(res: Response): string {
  const raw = res.headers.get(MOVE_FILENAME_HEADER) ?? "";
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

// The archive an upload-sourced app builds from. `close` must run whether or not `chunks` was read.
export async function upload(
  c: MoveCredential,
  w: WorkloadRef,
  signal?: AbortSignal,
): Promise<{
  filename: string;
  chunks: AsyncIterable<Buffer>;
  close: () => void;
}> {
  const opened = await openData(c, "upload", ref(w), signal);
  return {
    filename: headerFilename(opened.res),
    chunks: chunksOf(opened),
    close: opened.close,
  };
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
export function dump(
  c: MoveCredential,
  signal?: AbortSignal,
): AsyncIterable<string> {
  return (async function* () {
    const aborter = new AbortController();
    const onAbort = () => aborter.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    let late = false;
    const timer = setTimeout(() => {
      late = true;
      aborter.abort();
    }, DUMP_HEADERS_TIMEOUT_MS);
    try {
      signal?.throwIfAborted();
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
        signal?.throwIfAborted();
        if (late)
          throw new Error(
            "The old Deplo did not start the copy within 5 minutes. Retry the move.",
          );
        throw httpsOnly(e);
      } finally {
        clearTimeout(timer);
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
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      aborter.abort();
    }
  })();
}
