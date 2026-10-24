import type { BuildConfig, BuildMethod } from "../types/build";

// What a person picks: a builder, or "auto" (Detect automatically), spelled as the GraphQL input spells it.
export type BuildMethodChoice = BuildMethod | "auto";

export function methodChoice(
  build: Pick<BuildConfig, "buildMethod" | "methodAuto">,
): BuildMethodChoice {
  return build.methodAuto ? "auto" : build.buildMethod;
}

// "auto" leaves buildMethod alone: it is what the last deploy resolved, and saving "auto" never sends it.
export function withMethodChoice(
  build: BuildConfig,
  choice: BuildMethodChoice,
): BuildConfig {
  return choice === "auto"
    ? { ...build, methodAuto: true }
    : { ...build, buildMethod: choice, methodAuto: false };
}

// Detect automatically builds with Railpack unless the source holds a Dockerfile or a Compose file.
export function buildsWithRailpack(choice: BuildMethodChoice): boolean {
  return choice === "auto" || choice === "railpack";
}
