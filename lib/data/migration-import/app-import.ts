import "server-only";

import { blocker, isBlocking, noteText, type Note } from "../../migration/note";
import { and, eq, isNotNull, isNull, ne, or, sql } from "drizzle-orm";

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
import { mapDomains, pickPrimaryDomain } from "../../migration/map/domains";
import { mapMounts } from "../../migration/map/mounts";
import { createApp } from "../apps/create";
import { setAppPorts } from "../apps/ports";
import { setAppEnv } from "../env";
import { setSharedVarAppLink } from "../shared-vars/app-links";
import { composeGrantRefusal } from "./compose-notes";
import type { Report } from "./run-report";
import type { SourceService } from "./source-tree";
import { type SharedIndex, sharedEntry } from "./shared-vars-import";
import { landSourceBackups, type LandedDestinations } from "./source-backups";
import { landingServerId } from "./target-servers";
import { mapAppEnv } from "./app-env";
import { loadComposeText, resolveAppSource } from "./app-source";
import { rehostAppDomains } from "./app-domains";
import {
  addressRules,
  composeAddressNotes,
  rehostAppVariables,
} from "./app-address-vars";
import {
  landDomainCertificates,
  landDomainRedirects,
  noteDomainMiddlewares,
} from "./domain-rules";
import { landAppStorage } from "./app-storage";
import { landAppExtras } from "./app-extras";
import { landAppUpload } from "./app-upload";
import { landSourceImage } from "./app-image";
import { pausedNote } from "./live-copy-schedules";

export async function importAppService(
  c: SourceCredential,
  svc: SourceService,
  detail: SourceApplication & SourceCompose,
  name: string,
  home: {
    projectId: string | null;
    environmentId: string | null;
    folderId?: string | null;
    serverId: string | undefined;
    buildServerId: string | null;
    sourceHost: string | null;
    servers?: Map<string, string | undefined>;
    dbHosts: Map<string, string>;
    shared: SharedIndex;
    destinations?: LandedDestinations;
    liveCopy?: boolean;
  },
  report: Report,
): Promise<string | null> {
  const paused = { paused: home.liveCopy };
  let isCompose = svc.kind === "compose";

  const teamId = await requireActiveTeamId();
  // Outside a project, the same place is the same folder (or the top level).
  const samePlace = home.environmentId
    ? eq(appsTable.environmentId, home.environmentId)
    : and(
        eq(appsTable.teamId, teamId),
        isNull(appsTable.environmentId),
        home.folderId
          ? eq(appsTable.folderId, home.folderId)
          : isNull(appsTable.folderId),
      );
  const elsewhere = home.environmentId
    ? or(
        isNull(appsTable.environmentId),
        ne(appsTable.environmentId, home.environmentId),
      )
    : home.folderId
      ? or(
          isNotNull(appsTable.environmentId),
          isNull(appsTable.folderId),
          ne(appsTable.folderId, home.folderId),
        )
      : or(isNotNull(appsTable.environmentId), isNotNull(appsTable.folderId));
  const existing = await getDb()
    .select({ id: appsTable.id, name: appsTable.name })
    .from(appsTable)
    .where(samePlace);
  const match = existing.find(
    (a) => a.name.trim().toLowerCase() === name.trim().toLowerCase(),
  );
  if (match) {
    const extra: Note[] = [];
    const schedules = await landSourceBackups(
      detail.backups,
      home.destinations,
      { kind: "app", id: match.id, name },
      extra,
      detail.backupRuns,
      paused,
    );
    const pausedLine = home.liveCopy ? pausedNote(name, { schedules }) : null;
    if (pausedLine) extra.push(pausedLine);
    await report.add({
      sourceKind: svc.kind,
      sourceId: svc.id,
      sourceName: name,
      outcome: "skipped",
      targetKind: "app",
      targetId: match.id,
      message: [
        home.environmentId
          ? "An app with this name is already in this environment."
          : "An app with this name is already here.",
        ...extra.filter((n) => !isBlocking(n)).map(noteText),
      ].join(" "),
    });
    await report.notes(
      svc.kind,
      name,
      extra.filter(isBlocking),
      { kind: "app", id: match.id },
      svc.id,
    );
    return match.id;
  }

  const notes: Note[] = [
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
          eq(appsTable.teamId, teamId),
          sql`lower(${appsTable.name}) = ${name.trim().toLowerCase()}`,
          elsewhere,
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
  const primary = pickPrimaryDomain(domains.value);
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
    await report.notes(
      svc.kind,
      name,
      [blocker(grantRefusal)],
      { kind: "app" },
      svc.id,
    );
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
    folderId: home.folderId ?? null,
    build,
    autoDeploy: home.liveCopy ? false : (detail.autoDeploy ?? true),
    noWebhook: home.liveCopy,
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

  const schedules = await landSourceBackups(
    detail.backups,
    home.destinations,
    { kind: "app", id: created.id, name },
    notes,
    detail.backupRuns,
    paused,
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
        sharedEntry(home.shared, r.level, r.sharedKey)!.varId!,
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

  if (mayClaimHosts)
    await landDomainCertificates(created.serverId, domains.value, notes);
  const rehosted = await rehostAppDomains(created, domains, primary, notes);
  const address = await addressRules(rehosted);
  await rehostAppVariables(
    created.id,
    address,
    [...env, ...linkRefused],
    linkable.filter((r) => !linkRefused.some((e) => e.key === r.key)),
    home.shared,
    notes,
  );
  if (mayClaimHosts)
    await landDomainRedirects(created.id, detail.domains, notes);
  await noteDomainMiddlewares(created.id, notes);

  const upload = (detail as SourceApplication).upload;
  if (source === "upload" && upload)
    await landAppUpload(c, svc, created.id, upload, notes);
  if (source === "docker-image" && dockerImage)
    await landSourceImage(c, svc, created, dockerImage, notes);

  await landAppStorage(
    created,
    mounts,
    { isCompose, compose, asRepoApp, yamlText },
    notes,
  );

  const crons = await landAppExtras(
    c,
    svc,
    detail,
    created,
    {
      isCompose,
      secretKeys,
      serviceRenames,
      servers: home.servers,
      liveCopy: home.liveCopy,
      address,
    },
    notes,
  );
  if (isCompose && compose)
    notes.push(...composeAddressNotes(compose, address));
  if (home.liveCopy) {
    const pausedLine = pausedNote(name, { crons, schedules });
    if (pausedLine) notes.push(pausedLine);
    if (repo && (detail.autoDeploy ?? true))
      notes.push(
        `Deploy on push is off for this copy, so a push to ${repo.repo} still deploys only on {panel}. Turn it on under the app's Deployments settings when you switch over.`,
      );
  }

  await report.notes(svc.kind, name, notes, target, svc.id);
  return created.id;
}
