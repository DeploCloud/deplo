export interface DeplopackInput {
  type: "text" | "select" | "text-list";
  label: string;
  env: string;
  description: string;
  defaultValue?: string | string[];
  placeholder?: string;
  options?: string[];
}
export interface DeplopackDetection {
  type: string;
  path?: string;
  rootDir?: string;
  metadata?: Record<string, string>;
  inputs?: DeplopackInput[];
}
export interface DeplopackOverride {
  env: string;
  type: DeplopackInput["type"];
  values: string[];
}
export interface RepoAnalysis {
  receipt: string;
  expiresAt: number;
  commitSha: string;
  detectorVersion: string;
  result: {
    success: boolean;
    detections: DeplopackDetection[];
    logs?: { Level: string; Msg: string; DocsPath?: string }[];
  };
}
export function detectionKey(detection: DeplopackDetection): string {
  return JSON.stringify([
    detection.type,
    detection.path ?? "",
    detection.rootDir ?? "",
  ]);
}
export function deplopackEnvironment(
  overrides: readonly DeplopackOverride[],
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const input of overrides) {
    if (!input.values.length) continue;
    env[input.env] =
      input.type === "text-list"
        ? input.values.map((value) => `(${value})`).join(" && ")
        : input.values[0];
  }
  return env;
}
