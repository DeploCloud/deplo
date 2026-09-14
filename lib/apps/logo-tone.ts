import "server-only";

import { analyseLogo } from "@/lib/templates/logo-color";

// logoToneFromDataUri reads a logo's own pixels: "dark" for a black-only mark (invisible on the dark theme), "light" for white-only, null otherwise.
export async function logoToneFromDataUri(
  value: string | null,
): Promise<"dark" | "light" | null> {
  const base64 = value?.startsWith("data:") ? value.split(",")[1] : null;
  if (!base64) return null;
  try {
    const { tone } = await analyseLogo(Buffer.from(base64, "base64"));
    return tone ?? null;
  } catch {
    return null;
  }
}
