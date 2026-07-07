import type { Capability } from "@/lib/types";
import type { ApiFieldDoc, ApiArgDoc, FieldScope } from "./types";

/** Does the current viewer satisfy a field's scope? Mirrors the server gate. */
export function holdsScope(
  scope: FieldScope,
  capabilities: Capability[],
  isInstanceAdmin: boolean,
): boolean {
  switch (scope.kind) {
    case "public":
    case "loggedIn":
      // Anyone viewing this page is authenticated.
      return true;
    case "instanceAdmin":
      return isInstanceAdmin;
    case "capability":
      return capabilities.includes(scope.capability);
  }
}

/** A placeholder literal for an argument, by its (unwrapped) GraphQL type. */
function placeholderForType(type: string): string {
  const base = type.replace(/[![\]]/g, "");
  if (base === "Int" || base === "Float") return "0";
  if (base === "Boolean") return "false";
  if (base === "ID" || base === "String") return '""';
  if (base === "JSON") return "{}";
  // Input objects / enums — leave a hint the user fills in.
  return `null # ${base}`;
}

/** Render an argument list as `(a: …, b: …)`, or "" when there are none. */
function renderArgs(args: ApiArgDoc[]): string {
  // Only include required args in the inline example to keep it runnable-ish.
  const required = args.filter((a) => a.required);
  const use = required.length > 0 ? required : args;
  if (use.length === 0) return "";
  const parts = use.map((a) => `${a.name}: ${placeholderForType(a.type)}`);
  return `(${parts.join(", ")})`;
}

/** Does this return type look like an object (needs a sub-selection)? */
function isLeafReturn(returnType: string): boolean {
  const base = returnType.replace(/[![\]]/g, "");
  return ["Boolean", "Int", "Float", "String", "ID", "JSON", "DateTime"].includes(
    base,
  );
}

/**
 * A best-effort example operation for a field. Objects get a generic
 * `{ id }`-ish body (the user expands it in the playground); leaves get none.
 * Good enough to copy, paste and adjust — the playground validates precisely.
 */
export function exampleFor(field: ApiFieldDoc): string {
  const op = field.operation;
  const args = renderArgs(field.args);
  const body = isLeafReturn(field.returnType) ? "" : " {\n    # …fields\n  }";
  const indentedCall = `  ${field.name}${args}${body}`;
  const verb = op === "query" ? "query" : "mutation";
  return `${verb} {\n${indentedCall}\n}`;
}

/** Curated, ready-to-run examples shown in the playground's example picker. */
export interface CuratedExample {
  label: string;
  description: string;
  /** "query" examples really execute; "mutation" examples are dry-run. */
  kind: "query" | "mutation";
  operation: string;
}

export const CURATED_EXAMPLES: CuratedExample[] = [
  {
    label: "Who am I?",
    description: "The authenticated viewer + how the request authenticated.",
    kind: "query",
    operation: `query WhoAmI {
  me {
    id
    username
    name
    role
    isInstanceAdmin
  }
  apiContext
}`,
  },
  {
    label: "List my services",
    description: "Every project in the active team (read-only).",
    kind: "query",
    operation: `query Services {
  services {
    id
    name
    slug
    status
    productionUrl
  }
}`,
  },
  {
    label: "List servers",
    description: "Connected servers and their live status.",
    kind: "query",
    operation: `query Servers {
  servers {
    id
    name
    host
    status
    cpuUsage
    memoryUsage
  }
}`,
  },
  {
    label: "Project environments & shared vars",
    description:
      "A Project container's environments, plus one environment's shared variables (requires “manage env vars”).",
    kind: "query",
    operation: `query ProjectEnvironments {
  environments(projectId: "prc_example") {
    id
    name
    slug
    kind
    isDefault
  }
  environmentEnv(environmentId: "environ_example") {
    key
    value
    isMasked
    type
  }
}`,
  },
  {
    label: "Create a token (dry run)",
    description:
      "A mutation — it will NOT run. You'll see whether you're allowed to.",
    kind: "mutation",
    operation: `mutation CreateToken {
  createToken(name: "my-ci-token") {
    raw
  }
}`,
  },
  {
    label: "Rebuild a service (dry run)",
    description:
      "A destructive mutation, simulated. Requires the “deploy” capability — try it whether or not you hold it.",
    kind: "mutation",
    operation: `mutation RebuildService {
  rebuildService(id: "prj_example") {
    id
    name
    status
  }
}`,
  },
];
