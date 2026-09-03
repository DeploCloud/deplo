import { toast } from "sonner";

/**
 * `navigator.clipboard` exists only in a SECURE context, so on a plain-http
 * instance the modern API is simply absent - fall back to the old textarea.
 */
export async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    /* no clipboard API, or the permission was refused - try the old way */
  }
  const active = document.activeElement as HTMLElement | null;
  const ta = document.createElement("textarea");
  ta.value = value;
  ta.setAttribute("readonly", "");
  // Off-screen but still selectable; `display:none` would make select() a no-op.
  ta.style.position = "fixed";
  ta.style.top = "0";
  ta.style.opacity = "0";
  // Inside the focus trap, never on <body>: an open dialog or menu pulls the focus
  // straight back out of a stray textarea, and the selection dies with it.
  const host =
    (active === document.body ? null : active?.parentElement) ?? document.body;
  host.appendChild(ta);
  let ok = false;
  try {
    ta.focus();
    ta.select();
    // `execCommand` answers true even when something took the selection back, so
    // holding the focus is the only proof the copy was real.
    ok = document.activeElement === ta && document.execCommand("copy");
  } catch {
    ok = false;
  } finally {
    ta.remove();
    active?.focus?.();
  }
  // Both paths are gone (a hardened browser). Say so - a button that reports
  // nothing reads as "copied" and the value never arrives.
  if (!ok) toast.error("Couldn't copy - select the text and copy it manually");
  return ok;
}
