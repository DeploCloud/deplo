// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import { builder } from "../builder";
import type { HealthCheck } from "@/lib/types";

/**
 * The App health check object/input pair. Kept beside `resource-limits` for the
 * same reason: one shape, two places (the field on App and the save).
 */

const HealthCheckTypeEnum = builder.enumType("HealthCheckType", {
  description:
    "How the check asks. http requests a path over localhost inside the container; command runs a shell line and reads its exit code.",
  values: ["http", "command"] as const,
});

export const HealthCheckRef = builder
  .objectRef<HealthCheck>("HealthCheck")
  .implement({
    description:
      "What Deplo writes into the app's compose `healthcheck:`. Docker runs it inside the container and the agent reports the verdict, which is what the status dot follows. Null on an app that has none.",
    fields: (t) => ({
      type: t.field({ type: HealthCheckTypeEnum, resolve: (h) => h.type }),
      path: t.exposeString("path", { nullable: true }),
      port: t.exposeInt("port", {
        nullable: true,
        description:
          "The port INSIDE the container. Null means the app's own port.",
      }),
      command: t.exposeString("command", { nullable: true }),
      intervalS: t.exposeInt("intervalS"),
      timeoutS: t.exposeInt("timeoutS"),
      retries: t.exposeInt("retries"),
      startPeriodS: t.exposeInt("startPeriodS"),
    }),
  });

export const HealthCheckInputType = builder.inputType("HealthCheckInput", {
  description:
    "A health check to save. Send null instead to turn it off. An http check needs curl or wget in the image; one that has neither cannot answer, and the container would sit unhealthy.",
  fields: (t) => ({
    type: t.field({ type: HealthCheckTypeEnum, required: true }),
    path: t.string({ required: false }),
    port: t.int({ required: false }),
    command: t.string({ required: false }),
    intervalS: t.int({ required: true }),
    timeoutS: t.int({ required: true }),
    retries: t.int({ required: true }),
    startPeriodS: t.int({ required: true }),
  }),
});
