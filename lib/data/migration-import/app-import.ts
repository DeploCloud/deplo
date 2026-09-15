import "server-only";

import { and, eq, isNull, ne, or, sql } from "drizzle-orm";

import { getDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import { environments as environmentsTable } from "../../db/schema/control-plane/projects";
import {
  canExposePorts,
  hasCapability,
  requireActiveTeamId,
} from "../../membership";
import type { SourceCredential } from "../../migration/source";
import type { SourceApplication, SourceCompose } from "../../migration/model";
import { mapLogo } from "../../migration/map/app-settings";
import { cloneTarget } from "../../migration/map/app-source";
import { composeAsRepoApp } from "../../migration/map/compose-read";
import { mapDomains } from "../../migration/map/domains";
import { mapMounts } from "../../migration/map/mounts";
import { createApp } from "../apps/create";
import { setAppPorts } from "../apps/ports";
import { setAppEnv } from "../env";
import { setSharedVarAppLink } from "../shared-vars/app-links";
import { composeGrantRefusal } from "./compose-notes";
import type { Report } from "./run-report";
import type { SourceService } from "./source-tree";
import type { SharedIndex } from "./shared-vars-import";
import { landSourceBackups } from "./source-backups";
import { landingServerId } from "./target-servers";
import { mapAppEnv } from "./app-env";
import { loadComposeText, resolveAppSource } from "./app-source";
import { rehostAppDomains } from "./app-domains";
import { landAppStorage } from "./app-storage";
import { landAppExtras } from "./app-extras";

export async function importAppService(
  c: SourceCredential,
  svc: SourceService,
  detail: SourceApplication & SourceCompose,
  name: string,
  home: {
    projectId: string;
    environmentId: string;
    serverId: string | undefined;
    buildServerId: string | null;
    sourceHost: string | null;
    dbHosts: Map<string, string>;
    shared: SharedIndex;
    destinations?: Map<string, string>;
  },
  report: Report,
): Promise<string | null> {
  let isCompose = svc.kind === "compose";

  const existing = await getDb()
    .select({ id: appsTable.id, name: appsTable.name })
    .from(appsTable)
    .where(eq(appsTable.environmentId, home.environmentId));
  const match = existing.find(
    (a) => a.name.trim().toLowerCase() === name.trim().toLowerCase(),
  );
  if (match) {
    const extra: string[] = [];
    await landSourceBackups(
      detail.backups,
      home.destinations,
      { kind: "app", id: match.id, name },
      extra,
    );
    await report.add({
      sourceKind: svc.kind,
      sourceId: svc.id,
      sourceName: name,
      outcome: "skipped",
      targetKind: "app",
      targetId: match.id,
      message: [
        "An app with this name is already in this environment.",
        ...extra,
      ].join(" "),
    });
    return match.id;
  }

  const notes: string[] = [
    ...((detail as SourceApplication).platformNotes ?? []),
  ];

  const namesake = (
    await getDb()
      .select({
        slug: appsTable.slug,
        environmentName: environmentsTable.name,
      })
      .from(appsTable)
      .leftJoin(
        environmentsTable,
        eq(environmentsTable.id, appsTable.environmentId),
      )
      .where(
        and(
          eq(appsTable.teamId, await requireActiveTeamId()),
          sql`lower(${appsTable.name}) = ${name.trim().toLowerCase()}`,
          or(
            isNull(appsTable.environmentId),
            ne(appsTable.environmentId, home.environmentId),
          ),
        ),
      )
      .limit(1)
  )[0];

  const { env, linkable, dropped, secretKeys } = mapAppEnv(detail, home, notes);

  let yamlText = "";
  if (isCompose) {
    const text = await loadComposeText(c, svc, detail, name, report);
    if (text === null) return null;
    yamlText = text;
  }

  const repoTarget = isCompose ? cloneTarget(detail) : null;
  const asRepoApp = repoTarget ? composeAsRepoApp(yamlText) : null;
  if (asRepoApp) isCompose = false;

  const domains = mapDomains(detail.domains, {
    isCompose,
    fallbackPort: (detail as SourceApplication).routingPort,
    compose: isCompose ? yamlText : null,
  });
  notes.push(...domains.notes);
  if (
    home.sourceHost != null &&
    home.sourceHost === (await landingServerId(home.serverId))
  )
    for (const d of domains.value)
      if (d.generated && !/(^|\.)localhost$/i.test(d.host)) d.generated = false;
  const primary =
    domains.value.find((d) => !d.generated) ?? domains.value[0] ?? null;
  const mounts = mapMounts(detail.mounts, { isCompose, compose: yamlText });
  notes.push(...mounts.notes);

  const { serviceRenames, source, repo, dockerImage, compose, ports, build } =
    await resolveAppSource(
      c,
      svc,
      detail,
      name,
      home,
      { isCompose, yamlText, asRepoApp, repoTarget, domains, mounts, env },
      notes,
    );

  const routingPort =
    primary?.port ?? (detail as SourceApplication).routingPort ?? null;
  if (routingPort) build.port = routingPort;

  const mayClaimHosts = await hasCapability("manage_domains");
  const claimed = domains.value.filter((d) => !d.generated);
  if (!mayClaimHosts && claimed.length > 0)
    notes.push(
      `You don't have permission to manage domains, so ${claimed
        .map((d) => d.host)
        .join(", ")} came across on a generated address instead.`,
    );

  const grantRefusal = compose
    ? await composeGrantRefusal(compose, name)
    : null;
  if (grantRefusal) {
    await report.add({
      sourceKind: svc.kind,
      sourceId: svc.id,
      sourceName: name,
      outcome: "manual",
      targetKind: "app",
      message: grantRefusal,
    });
    return null;
  }

  const created = await createApp({
    name,
    source,
    repo,
    dockerImage,
    compose,
    env,
    serverId: home.serverId,
    buildServerId: home.buildServerId,
    projectId: home.projectId,
    environmentId: home.environmentId,
    build,
    autoDeploy: detail.autoDeploy ?? true,
    autoDomain:
      mayClaimHosts && primary && !primary.generated ? primary.host : null,
    autoDomainPath: primary?.pathPrefix || null,
    noAutoDomain: domains.value.length === 0,
    composeService: isCompose ? (primary?.service ?? null) : null,
    composePort: isCompose ? (primary?.port ?? null) : null,
    mounts:
      isCompose && mounts.value.files.length > 0 ? mounts.value.files : null,
    logo: mapLogo(detail.icon),
    deploy: false,
  });

  if (ports.length > 0) {
    if (!(await canExposePorts()))
      notes.push(
        `It published ${ports
          .map((p) => p.published)
          .join(
            ", ",
          )} on its host. You don't have permission to publish ports, so it came across without them - ask an instance admin, then add them under Settings -> Advanced.`,
      );
    else
      try {
        await setAppPorts(created.id, ports);
      } catch (e) {
        notes.push(
          `${ports.map((p) => `${p.published}:${p.target}`).join(", ")} could not be published here (${
            e instanceof Error ? e.message : "the port was refused"
          }). Set them under Settings -> Advanced.`,
        );
      }
  }

  await landSourceBackups(
    detail.backups,
    home.destinations,
    { kind: "app", id: created.id, name },
    notes,
  );

  if (namesake)
    notes.push(
      `This team already has an app called ${name}${
        namesake.environmentName
          ? ` in the ${namesake.environmentName} environment`
          : ""
      }. Both are kept; this one is /apps/${created.slug}.`,
    );

  const linkRefused: { key: string; value: string }[] = [];
  for (const r of linkable) {
    try {
      await setSharedVarAppLink(
        home.shared.get(r.sharedKey)!.varId,
        created.id,
        true,
      );
    } catch {
      const back = dropped.get(r.key);
      if (back) linkRefused.push(back);
    }
  }
  if (linkRefused.length > 0) {
    await setAppEnv(created.id, [...env, ...linkRefused], undefined, {
      overwriteSecrets: true,
    });
    notes.push(
      `${linkRefused
        .map((e) => e.key)
        .join(
          ", ",
        )} could not be linked to the shared variable, so ${linkRefused.length === 1 ? "it kept its" : "they kept their"} own copy of the value.`,
    );
  }

  await report.add({
    sourceKind: svc.kind,
    sourceId: svc.id,
    sourceName: name,
    outcome: "created",
    targetKind: "app",
    targetId: created.id,
    message: `${env.length} variable(s), ${
      linkable.length - linkRefused.length
    } shared variable(s), ${mounts.value.files.length} config file(s).`,
  });
  const target = { kind: "app", id: created.id };

  await rehostAppDomains(created, domains, primary, env, notes);

  await landAppStorage(
    created,
    mounts,
    { isCompose, compose, asRepoApp, yamlText },
    notes,
  );

  await landAppExtras(
    c,
    svc,
    detail,
    created,
    { isCompose, secretKeys, serviceRenames },
    notes,
  );

  await report.notes(svc.kind, name, notes, target, svc.id);
  return created.id;
}
