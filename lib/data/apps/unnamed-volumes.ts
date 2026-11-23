import "server-only";

import { eq } from "drizzle-orm";
import {
  serviceImage,
  unnamedPlaces,
  unnamedVolumeName,
  volumeAdoptions,
} from "../../apps/unnamed-volumes";
import { getDb } from "../../db/client";
import { appVolumes as appVolumesTable } from "../../db/schema/control-plane/apps";
import { servicesOf } from "../../deploy/compose-lint/document";
import { serverSupports } from "../../infra/agent-client/preflight";
import { newId } from "../../ids";
import { imageVolumes } from "../../registry/client";
import { parseImageRef } from "../../registry/image-ref";
import { dockerConfigKey, loadRegistryAuthsForApp } from "../registries";
import type { VolumeMount } from "../../types/container";
import { hostVolumeName, usesComposeStack } from "../../utils";
import { recordActivity } from "../activity";
import { loadAppGraph } from "../app-graph-load";
import { volumesToRows } from "../app-graph-rows/app";
import { hostNameClaims, volumeNameClash } from "../host-name-claims";

export const ADOPT_VOLUMES_CAPABILITY = "volumes.adopt";

const placeOf = (v: VolumeMount) =>
  `${v.mountPath}${v.service ? ` of ${v.service}` : ""}`;

/**
 * Before a deploy renders, keeps every place of the App Docker would leave unnamed as a Volume, so it is
 * data like any other. Only on a server whose agent carries the old content over. Internal: the deploy holds the gates.
 */
export async function keepUnnamedVolumes(
  appId: string,
  serverId: string,
  log: (message: string) => void,
  lookup?: (image: string) => Promise<string[] | null>,
  built?: string[],
): Promise<VolumeMount[]> {
  if (!(await serverSupports(serverId, ADOPT_VOLUMES_CAPABILITY))) return [];
  const app = await loadAppGraph(appId);
  if (!app) return [];
  // A private image is read with the registry login its deploy pulls it with.
  lookup ??= await privateAware(appId);
  const composeStack = usesComposeStack(app);
  const images = new Map<string, string>();
  if (composeStack) {
    for (const [name, svc] of Object.entries(servicesOf(app.compose) ?? {})) {
      const image = serviceImage(svc);
      if (image) images.set(name, image);
    }
  } else if (app.source === "docker-image" && app.dockerImage) {
    images.set("", app.dockerImage);
  }
  const declared = new Map<string, string[]>();
  // What the image Deplo built declares, read on the server that built it.
  if (!composeStack && built?.length) declared.set("", built);
  await Promise.all(
    [...images].map(async ([service, image]) => {
      const paths = await lookup(image).catch(() => null);
      if (paths?.length) declared.set(service, paths);
    }),
  );
  const places = unnamedPlaces(
    { compose: app.compose, composeStack, volumes: app.volumes },
    declared,
  );
  if (places.length === 0) return [];

  const added: VolumeMount[] = [];
  await getDb().transaction(async (tx) => {
    const claims = await hostNameClaims(tx);
    const taken = new Set((app.volumes ?? []).map((v) => v.name));
    for (const place of places) {
      let name = unnamedVolumeName(place, taken);
      while (volumeNameClash(app, name, claims))
        name = unnamedVolumeName(place, taken);
      added.push({
        id: newId("vol"),
        name,
        ...(place.service ? { service: place.service } : {}),
        mountPath: place.path,
        readOnly: false,
        origin: place.origin,
      });
    }
    await tx.delete(appVolumesTable).where(eq(appVolumesTable.appId, appId));
    await tx
      .insert(appVolumesTable)
      .values(volumesToRows(appId, [...(app.volumes ?? []), ...added]));
  });
  const what = added.map(placeOf).join(", ");
  log(
    `Kept ${what} as ${added.length === 1 ? "a Volume" : "Volumes"}: the ${added.some((v) => v.origin === "image") ? "image declares" : "compose file names"} no name for ${added.length === 1 ? "it" : "them"}, so the data would not have survived a new container.`,
  );
  await recordActivity(
    "app",
    `${app.name} keeps ${what} as ${added.length === 1 ? "a Volume" : "Volumes"} now, so its data survives a redeploy and moves with it`,
    "Deplo",
    app.id,
    app.teamId,
  );
  return added;
}

/** Reads an image's volumes with the team's login for its registry, when it has one. */
async function privateAware(
  appId: string,
): Promise<(image: string) => Promise<string[] | null>> {
  const logins = await loadRegistryAuthsForApp(appId).catch(() => []);
  return (image) => {
    const ref = parseImageRef(image);
    const key = ref ? dockerConfigKey(ref.registry) : "";
    const login = logins.find((l) => l.host === key);
    return imageVolumes(image, login);
  };
}

/** The Volumes Deplo named for this App, as the agent carries them over at a deploy of `deployKey`. */
export async function adoptionsFor(
  appId: string,
  deployKey: string,
  renderedYaml: string,
): Promise<{ service: string; target: string; volume: string }[]> {
  const app = await loadAppGraph(appId);
  const names = new Set(
    (app?.volumes ?? [])
      .filter((v) => v.origin)
      .map((v) => hostVolumeName(deployKey, v.name)),
  );
  return volumeAdoptions(renderedYaml, names);
}
