import "server-only";

import { analyseLogo } from "@/lib/templates/logo-color";

/**
 * The plate a stored logo needs, read from its own pixels: "dark" for a mark
 * drawn only in black (invisible on the dark theme), "light" for one drawn only
 * in white, null for anything with colour - or anything that will not decode.
 */
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
