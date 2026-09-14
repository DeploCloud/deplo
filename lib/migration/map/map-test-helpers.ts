import type { SourceApplication, SourceDatabase } from "../model";

export function app(over: Partial<SourceApplication> = {}): SourceApplication {
  return {
    applicationId: "app-1",
    name: "web",
    appName: "acme-web-abc123",
    sourceType: "github",
    buildType: "nixpacks",
    owner: "acme",
    repository: "web",
    branch: "main",
    ...over,
  };
}

export function db(over: Partial<SourceDatabase> = {}): SourceDatabase {
  return {
    name: "main",
    appName: "acme-main-abc",
    dockerImage: "postgres:16",
    databaseName: "app",
    databaseUser: "app",
    databasePassword: "s3cret-value",
    ...over,
  };
}

// What the Coolify adapter passes: the platform's name, and the per-resource network it puts every service of one stack on.
export const COOLIFY_PLATFORM = {
  name: "Coolify",
  networks: ["ewc08w0", "coolify"],
};
