import { toast } from "sonner";

// `navigator.clipboard` exists only in a SECURE context: plain http has no modern API.
export async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    /* no clipboard API, or the permission was refused */
  }
  const active = document.activeElement as HTMLElement | null;
  const ta = document.createElement("textarea");
  ta.value = value;
  ta.setAttribute("readonly", "");
  // Off-screen but still selectable; `display:none` would make select() a no-op.
  ta.style.position = "fixed";
  ta.style.top = "0";
  ta.style.opacity = "0";
  // Inside the focus trap, never on <body>: an open dialog pulls the focus back out.
  const host =
    (active === document.body ? null : active?.parentElement) ?? document.body;
  host.appendChild(ta);
  let ok = false;
  try {
    ta.focus();
    ta.select();
    // `execCommand` answers true even when something took the selection back.
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
