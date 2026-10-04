import "server-only";

import type { Domain } from "../../types/domain";
import type {
  domains,
  domainMiddlewares,
  domainCorsOrigins,
} from "../../db/schema/control-plane/domains";

export type DomainRow = typeof domains.$inferSelect;
export type DomainMiddlewareRow = typeof domainMiddlewares.$inferSelect;
export type DomainCorsOriginRow = typeof domainCorsOrigins.$inferSelect;

type DomainInsert = typeof domains.$inferInsert;
type DomainMiddlewareInsert = typeof domainMiddlewares.$inferInsert;
type DomainCorsOriginInsert = typeof domainCorsOrigins.$inferInsert;

export function assembleDomain(
  row: DomainRow,
  middlewares: DomainMiddlewareRow[],
  corsOrigins: DomainCorsOriginRow[],
): Domain {
  const mw = [...middlewares]
    .sort((a, b) => a.position - b.position)
    .map((m) => m.name);
  const cors = [...corsOrigins]
    .sort((a, b) => a.position - b.position)
    .map((o) => o.origin);
  return {
    id: row.id,
    appId: row.appId,
    name: row.name,
    status: row.status as Domain["status"],
    primary: row.isPrimary,
    redirectTo: row.redirectTo,
    ssl: row.ssl,
    // source/entrypoint/certProvider are nullable with NO default: the auto/manual tri-state, never coerce an absent one.
    ...(row.source != null ? { source: row.source as Domain["source"] } : {}),
    ...(row.port != null ? { port: row.port } : {}),
    ...(row.entrypoint != null
      ? { entrypoint: row.entrypoint as Domain["entrypoint"] }
      : {}),
    ...(row.certProvider != null
      ? { certProvider: row.certProvider as Domain["certProvider"] }
      : {}),
    ...(mw.length ? { middlewares: mw } : {}),
    securityHeaders: row.securityHeaders,
    ...(cors.length ? { corsOrigins: cors } : {}),
    ...(row.pathPrefix != null ? { pathPrefix: row.pathPrefix } : {}),
    ...(row.stripPrefix != null ? { stripPrefix: row.stripPrefix } : {}),
    ...(row.service != null ? { service: row.service } : {}),
    ...(row.proxied != null ? { proxied: row.proxied } : {}),
    ...(row.importedFrom != null ? { importedFrom: row.importedFrom } : {}),
    createdAt: row.createdAt,
  };
}

export function domainToRow(d: Domain): DomainInsert {
  return {
    id: d.id,
    appId: d.appId,
    name: d.name,
    status: d.status,
    isPrimary: d.primary,
    redirectTo: d.redirectTo ?? null,
    ssl: d.ssl,
    source: d.source ?? null,
    port: d.port ?? null,
    entrypoint: d.entrypoint ?? null,
    certProvider: d.certProvider ?? null,
    pathPrefix: d.pathPrefix ?? null,
    stripPrefix: d.stripPrefix ?? null,
    service: d.service ?? null,
    proxied: d.proxied ?? null,
    // Left out on a new row, so the column default (on) decides.
    securityHeaders: d.securityHeaders,
    importedFrom: d.importedFrom ?? null,
    createdAt: d.createdAt,
  };
}

export function domainMiddlewaresToRows(d: Domain): DomainMiddlewareInsert[] {
  return (d.middlewares ?? []).map((name, position) => ({
    domainId: d.id,
    position,
    name,
  }));
}

export function domainCorsOriginsToRows(d: Domain): DomainCorsOriginInsert[] {
  return (d.corsOrigins ?? []).map((origin, position) => ({
    domainId: d.id,
    position,
    origin,
  }));
}
