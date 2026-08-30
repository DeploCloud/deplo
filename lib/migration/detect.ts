// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Which product is answering at that address.
 *
 * Deplo migrates from two, and works this out rather than asking. The wizard only
 * asks when this comes back empty-handed.
 */

import {
  listProjects as coolifyProjects,
  panelFromHealth,
} from "./coolify/client";
import { listProjects as dokployProjects } from "./dokploy/client";
import type { MigrationPlatform, SourceCredential } from "./source";
import { PanelUnreachableError } from "./transport";

/**
 * Laravel Sanctum mints `<id>|<random>`, and Dokploy's keys have no pipe. Free,
 * and only ever used to decide which of the two to TRY first.
 */
const SANCTUM_TOKEN = /^\d+\|[A-Za-z0-9]{20,}$/;

/** The one call an import cannot proceed without, per platform. */
const PROBE: Record<
  MigrationPlatform,
  (c: SourceCredential) => Promise<unknown>
> = {
  dokploy: (c) => dokployProjects(c),
  coolify: (c) => coolifyProjects(c),
};

export class PanelNotIdentifiedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PanelNotIdentifiedError";
  }
}

/**
 * Ask each platform, cheapest guess first, and answer with the one that did.
 *
 * A TRANSPORT failure stops it dead: a machine that did not answer will not
 * answer the second guess either, and two timeouts are thirty seconds of spinner.
 * Only an application-level refusal moves on to the other candidate.
 */
export async function detectMigrationSource(
  baseUrl: string,
  apiKey: string,
): Promise<MigrationPlatform> {
  const order: MigrationPlatform[] = SANCTUM_TOKEN.test(apiKey.trim())
    ? ["coolify", "dokploy"]
    : ["dokploy", "coolify"];

  const refused: string[] = [];
  for (const kind of order) {
    try {
      await PROBE[kind]({ kind, baseUrl, apiKey });
      return kind;
    } catch (e) {
      if (e instanceof PanelUnreachableError) throw e;
      refused.push(
        `${kind === "coolify" ? "Coolify" : "Dokploy"}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  // Both refused. The unauthenticated healthcheck only chooses the WORDS - a
  // reverse proxy can answer 200 there, so it never decides which product it is.
  const answered = await panelFromHealth(baseUrl);
  const name = answered === "coolify" ? "Coolify" : "Dokploy";
  const said = refused.find((r) => r.startsWith(`${name}: `));
  if (answered && said)
    throw new PanelNotIdentifiedError(
      `That is a ${name} panel, and it refused the token. ${said.slice(`${name}: `.length)}`,
    );

  throw new PanelNotIdentifiedError(
    `Deplo could not read ${baseUrl} as a Dokploy or a Coolify panel. ${refused.join(" ")}`,
  );
}
