import "server-only";

import { builder } from "./builder";

// Import every domain module for its side effect of registering types,
// queries and mutations on the shared builder. Order is irrelevant — Pothos
// resolves refs lazily at build time. Keep this list alphabetical.
import "./types/account";
import "./types/activity";
import "./types/plugins";
import "./types/auth";
import "./types/backup";
import "./types/basic-auth";
import "./types/console";
import "./types/database";
import "./types/dev";
import "./types/domain";
import "./types/enums";
import "./types/env";
import "./types/environment";
import "./types/global-env";
import "./types/folder";
import "./types/github";
import "./types/member";
import "./types/monitoring";
import "./types/notifications";
import "./types/project";
import "./types/app";
import "./types/app-files";
import "./types/registry";
import "./types/s3";
import "./types/server";
import "./types/shared-env";
import "./types/team";
import "./types/token";
import "./types/updates";
import "./types/viewer";

/**
 * The assembled executable schema. Built once at module load and reused across
 * requests (the schema is stateless; per-request data flows through context).
 */
export const schema = builder.toSchema();
