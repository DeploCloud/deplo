"use server";

import { revalidateTag } from "next/cache";
import { getCurrentUser } from "@/lib/auth";

export async function refreshTemplates(): Promise<void> {
  if (!(await getCurrentUser())) throw new Error("Unauthorized");
  revalidateTag("templates", { expire: 0 });
}
