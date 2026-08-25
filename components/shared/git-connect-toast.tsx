"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

const GIT_FEEDBACK: Record<string, { ok: boolean; msg: string }> = {
  connected: { ok: true, msg: "GitHub App connected" },
  error: { ok: false, msg: "GitHub connection failed. Please try again." },
  state_error: {
    ok: false,
    msg: "GitHub connection expired or was tampered with. Try again.",
  },
};

/**
 * One-shot feedback from the GitHub connect redirects (`?
 */
export function GitConnectToast(): null {
  const router = useRouter();

  React.useEffect(() => {
    const url = new URL(window.location.href);
    const fb = GIT_FEEDBACK[url.searchParams.get("git") ?? ""];
    if (!fb) return;
    (fb.ok ? toast.success : toast.error)(fb.msg);
    url.searchParams.delete("git");
    router.replace(url.pathname + url.search, { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}
