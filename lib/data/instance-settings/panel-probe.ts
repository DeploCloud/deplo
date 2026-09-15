import "server-only";

import { get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";

import { requireInstanceAdmin } from "../../membership";

export type PanelReachability = {
  url: string;
  ok: boolean;
  error: string | null;
};

// The one sanctioned exemption from lib/outbound-url.ts: it dials the panel's own address, so the gate is instance admin here.
export async function probePanel(url: string): Promise<PanelReachability> {
  await requireInstanceAdmin();
  try {
    const res = await getTolerant(`${url}/api/health`);
    if (res.status < 200 || res.status >= 300)
      return {
        url,
        ok: false,
        error: `${url} answered ${res.status}, it does not reach Deplo yet`,
      };
    const body = (() => {
      try {
        return JSON.parse(res.body) as { ok?: boolean };
      } catch {
        return null;
      }
    })();
    if (!body?.ok)
      return {
        url,
        ok: false,
        error: `Something answered on ${url}, but it is not this Deplo`,
      };
    return { url, ok: true, error: null };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return { url, ok: false, error: `${url} did not answer (${reason})` };
  }
}

function getTolerant(
  url: string,
  redirectsLeft = 3,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const get = target.protocol === "https:" ? httpsGet : httpGet;
    const req = get(
      target,
      // The generated host serves Traefik's self-signed certificate, which fetch refuses outright.
      { rejectUnauthorized: false, timeout: 6_000 },
      (res) => {
        const location = res.headers.location;
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && location) {
          res.resume();
          if (redirectsLeft <= 0)
            return reject(new Error("too many redirects"));
          resolve(
            getTolerant(new URL(location, target).href, redirectsLeft - 1),
          );
          return;
        }
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          body += chunk;
        });
        res.on("end", () => resolve({ status, body }));
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timed out")));
  });
}

export async function panelCertificateTrusted(
  url: string,
): Promise<boolean | null> {
  try {
    const { controlPlaneCert } = await import("../../agent/bootstrap");
    const cert = await controlPlaneCert(url);
    return cert.fingerprint ? !cert.insecure : null;
  } catch {
    return null;
  }
}

export async function probeUntilAnswers(
  url: string,
): Promise<PanelReachability> {
  let last = await probePanel(url);
  for (let attempt = 0; attempt < 2 && !last.ok; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    last = await probePanel(url);
  }
  return last;
}
