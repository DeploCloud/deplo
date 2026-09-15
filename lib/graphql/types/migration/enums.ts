import { builder } from "../../builder";
import { MIGRATION_PLATFORMS } from "@/lib/migration/source";

export const MigrationPlanStatusEnum = builder.enumType("MigrationPlanStatus", {
  description:
    "What the preview thinks will happen to one service on the panel. new = it will be created. exists = something with that name is already here, so it is left alone. unsupported = Deplo has no such thing (a keydb database, a service the panel would not return). needs_grant = it can only be created by someone holding the host-volumes or expose-ports grant.",
  values: ["new", "exists", "unsupported", "needs_grant"] as const,
});

export const MigrationPlatformEnum = builder.enumType("MigrationPlatform", {
  description:
    "Which product a migration reads. Deplo migrates from these two and refuses anything else by name.",
  values: MIGRATION_PLATFORMS,
});

export const MigrationOutcomeEnum = builder.enumType("MigrationOutcome", {
  description:
    "One line of the report. created = it is in Deplo now. skipped = already here, or left out on purpose. failed = refused, with the server's own message. manual = it came across, but something needs a person (a private repo with no credential, a database whose host name changed, a compose file that was rewritten). unsupported = there is no Deplo equivalent.",
  values: ["created", "skipped", "failed", "manual", "unsupported"] as const,
});
