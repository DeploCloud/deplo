import { templateAssetPathSchema } from "./schema";

export function templateAssetUrl(path: string) {
  const base =
    process.env.NEXT_PUBLIC_DEPLO_TEMPLATES_API_URL ??
    process.env.DEPLO_TEMPLATES_API_URL;
  if (!base) {
    throw new Error(
      "NEXT_PUBLIC_DEPLO_TEMPLATES_API_URL or DEPLO_TEMPLATES_API_URL is required.",
    );
  }

  return new URL(templateAssetPathSchema.parse(path), `${base.replace(/\/+$/, "")}/`).toString();
}
