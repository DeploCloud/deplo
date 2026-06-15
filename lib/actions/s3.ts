"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { run, type ActionResult } from "./result";
import { createS3, deleteS3, testS3 } from "@/lib/data/s3";

const createSchema = z.object({
  name: z.string().min(1).max(80),
  provider: z.enum([
    "aws", "cloudflare-r2", "backblaze-b2", "minio", "digitalocean", "wasabi", "other",
  ]),
  endpoint: z.string().min(1).max(300),
  region: z.string().max(60).optional().default("auto"),
  bucket: z.string().min(1).max(120),
  accessKey: z.string().min(1).max(300),
  secretKey: z.string().min(1).max(500),
});

export async function createS3Action(
  input: z.input<typeof createSchema>
): Promise<ActionResult<{ id: string }>> {
  const parsed = createSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid" };
  const res = await run(async () => {
    const s = await createS3({ ...parsed.data, region: parsed.data.region ?? "auto" });
    return { id: s.id };
  });
  if (res.ok) revalidatePath("/storage");
  return res;
}

export async function testS3Action(id: string): Promise<ActionResult> {
  const res = await run(() => testS3(id));
  if (res.ok) revalidatePath("/storage");
  return res as ActionResult;
}

export async function deleteS3Action(id: string): Promise<ActionResult> {
  const res = await run(() => deleteS3(id));
  if (res.ok) revalidatePath("/storage");
  return res as ActionResult;
}
