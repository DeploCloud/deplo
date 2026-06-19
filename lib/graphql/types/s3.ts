import { builder } from "../builder";
import { S3ProviderEnum } from "./enums";
import {
  listS3,
  createS3,
  testS3,
  deleteS3,
  type S3DestinationDTO,
} from "@/lib/data/s3";
import type { S3Provider } from "@/lib/types";

/* ------------------------------------------------------------------ */
/* Enums (local — S3Status is not shared in enums.ts)                   */
/* ------------------------------------------------------------------ */

// Connectivity state of a destination. Local to this module because no other
// domain references it; the wire enum mirrors the S3Status TS union exactly.
const S3StatusEnum = builder.enumType("S3Status", {
  values: ["connected", "error", "unverified"] as const,
});

/* ------------------------------------------------------------------ */
/* Object types                                                        */
/* ------------------------------------------------------------------ */

export const S3DestinationRef = builder
  .objectRef<S3DestinationDTO>("S3Destination")
  .implement({
    description:
      "An S3-compatible storage destination owned by a team (secrets masked).",
    fields: (t) => ({
      id: t.exposeID("id"),
      teamId: t.exposeID("teamId"),
      name: t.exposeString("name"),
      provider: t.field({ type: S3ProviderEnum, resolve: (s) => s.provider }),
      endpoint: t.exposeString("endpoint"),
      region: t.exposeString("region"),
      bucket: t.exposeString("bucket"),
      accessKeyMasked: t.exposeString("accessKeyMasked"),
      status: t.field({ type: S3StatusEnum, resolve: (s) => s.status }),
      createdAt: t.exposeString("createdAt"),
    }),
  });

/* ------------------------------------------------------------------ */
/* Inputs                                                              */
/* ------------------------------------------------------------------ */

const CreateS3InputType = builder.inputType("CreateS3Input", {
  fields: (t) => ({
    name: t.string({ required: true }),
    provider: t.field({ type: S3ProviderEnum, required: true }),
    endpoint: t.string({ required: true }),
    region: t.string({ required: false }),
    bucket: t.string({ required: true }),
    accessKey: t.string({ required: true }),
    secretKey: t.string({ required: true }),
  }),
});

/* ------------------------------------------------------------------ */
/* Queries                                                             */
/* ------------------------------------------------------------------ */

builder.queryFields((t) => ({
  s3Destinations: t.field({
    type: [S3DestinationRef],
    authScopes: { loggedIn: true },
    description: "All S3 destinations in the active team, newest first.",
    resolve: () => listS3(),
  }),
}));

/* ------------------------------------------------------------------ */
/* Mutations (every S3 server action)                                  */
/* ------------------------------------------------------------------ */

builder.mutationFields((t) => ({
  createS3: t.field({
    type: S3DestinationRef,
    authScopes: { capability: "manage_infra" },
    args: { input: t.arg({ type: CreateS3InputType, required: true }) },
    resolve: (_r, { input }) =>
      createS3({
        name: input.name,
        provider: input.provider as S3Provider,
        endpoint: input.endpoint,
        region: input.region ?? "auto",
        bucket: input.bucket,
        accessKey: input.accessKey,
        secretKey: input.secretKey,
      }),
  }),
  testS3: t.field({
    type: S3DestinationRef,
    authScopes: { capability: "manage_infra" },
    description: "Run a connectivity check (HEAD bucket) and return the dest.",
    args: { id: t.arg.string({ required: true }) },
    resolve: (_r, { id }) => testS3(id),
  }),
  deleteS3: t.field({
    type: "Boolean",
    authScopes: { capability: "manage_infra" },
    description: "Delete the S3 destination and its backups. Returns true.",
    args: { id: t.arg.string({ required: true }) },
    resolve: async (_r, { id }) => {
      await deleteS3(id);
      return true;
    },
  }),
}));
