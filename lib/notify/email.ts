import "server-only";

import { assertSafeOutboundHost } from "../outbound-url";

// Without `assertSafeOutboundHost`, SMTP is the one channel that can dial the control plane's network.
const SMTP_TIMEOUT_MS = 10_000;

export type EmailConfig =
  | {
      provider: "smtp";
      host: string;
      port: number;
      user: string;
      password: string;
      from: string;
    }
  | { provider: "resend"; apiKey: string; from: string };

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

// Implicit TLS is port 465 and nothing else - nodemailer's own rule for `secure: true`.
export function smtpSecure(port: number): boolean {
  return port === 465;
}

export async function sendEmail(
  cfg: EmailConfig,
  msg: EmailMessage,
  signal?: AbortSignal,
): Promise<void> {
  if (cfg.provider === "resend") {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: cfg.from,
        to: [msg.to],
        subject: msg.subject,
        text: msg.text,
      }),
      signal,
    });
    if (!res.ok) throw new Error(await resendError(res));
    return;
  }

  await assertSafeOutboundHost(cfg.host, "SMTP host");
  // Dynamic import: nodemailer pulls in net/tls, off the boot path of an instance that never mails.
  const { createTransport } = await import("nodemailer");
  try {
    await createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: smtpSecure(cfg.port),
      // An open relay on the same box needs no credentials, and that is the common self-hosted case.
      auth: cfg.user ? { user: cfg.user, pass: cfg.password } : undefined,
      // nodemailer's own bounds, because it has no AbortSignal: a black-holed host holds it 2 minutes.
      connectionTimeout: SMTP_TIMEOUT_MS,
      greetingTimeout: SMTP_TIMEOUT_MS,
      socketTimeout: SMTP_TIMEOUT_MS,
    }).sendMail({
      from: cfg.from,
      to: msg.to,
      subject: msg.subject,
      text: msg.text,
    });
  } catch (e) {
    // Rewrapped so the reason survives `mask-error.ts` (see the module docblock).
    throw new Error(
      e instanceof Error ? e.message : "The SMTP server refused it",
    );
  }
}

// Resend's own reason, or the bare status when the body isn't its usual shape.
async function resendError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { message?: string; name?: string };
    if (body.message) return body.message;
  } catch {
    // Not JSON - fall through to the status.
  }
  return `Resend returned ${res.status}`;
}
