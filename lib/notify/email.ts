import "server-only";

import { assertSafeOutboundHost } from "../outbound-url";

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
  const { createTransport } = await import("nodemailer");
  try {
    await createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: smtpSecure(cfg.port),
      auth: cfg.user ? { user: cfg.user, pass: cfg.password } : undefined,
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
    throw new Error(
      e instanceof Error ? e.message : "The SMTP server refused it",
    );
  }
}

async function resendError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { message?: string; name?: string };
    if (body.message) return body.message;
  } catch {}
  return `Resend returned ${res.status}`;
}
