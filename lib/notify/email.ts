import "server-only";

import { assertSafeOutboundHost } from "../outbound-url";

/**
 * The two ways a team's alerts can leave as email: its own SMTP server, or a
 * Resend API key. Skipping it would have made SMTP the one channel that can dial
 * the control plane's own network - see `assertSafeOutboundHost`.
 */

/** What one SMTP dial gets before it is considered dead. */
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

/**
 * Implicit TLS is port 465 and nothing else - that is nodemailer's own rule
 * (`secure: true` means "TLS from the first byte"), and every other port either
 * upgrades with STARTTLS or is plaintext, which nodemailer negotiates itself.
 */
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
  // Dynamic import: nodemailer pulls in net/tls and has no business on the boot
  // path of an instance that never sends an email.
  const { createTransport } = await import("nodemailer");
  try {
    await createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: smtpSecure(cfg.port),
      // An open relay on the same box needs no credentials; asking for them would
      // make the common self-hosted case impossible to configure.
      auth: cfg.user ? { user: cfg.user, pass: cfg.password } : undefined,
      // nodemailer's own bounds, because it has no AbortSignal: without them a
      // black-holed host holds the send for two minutes and the dispatcher's 5s
      // promise means nothing on this branch.
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

/** Resend's own reason, or the bare status when the body isn't its usual shape. */
async function resendError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { message?: string; name?: string };
    if (body.message) return body.message;
  } catch {
    // Not JSON - fall through to the status.
  }
  return `Resend returned ${res.status}`;
}
