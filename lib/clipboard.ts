import { toast } from "sonner";

export async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {}
  const active = document.activeElement as HTMLElement | null;
  const ta = document.createElement("textarea");
  ta.value = value;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.top = "0";
  ta.style.opacity = "0";
  const host =
    (active === document.body ? null : active?.parentElement) ?? document.body;
  host.appendChild(ta);
  let ok = false;
  try {
    ta.focus();
    ta.select();
    ok = document.activeElement === ta && document.execCommand("copy");
  } catch {
    ok = false;
  } finally {
    ta.remove();
    active?.focus?.();
  }
  if (!ok) toast.error("Couldn't copy - select the text and copy it manually");
  return ok;
}
