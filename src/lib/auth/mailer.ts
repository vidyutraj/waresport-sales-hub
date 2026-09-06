import '@/lib/server-guard';
import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { env } from '@/lib/env';

/**
 * Transactional email. This is used ONLY for authentication and invitations —
 * never for prospect outreach, which interns perform manually from their own
 * Waresport mailbox and record here afterwards.
 *
 * In development the transport points at the local Mailpit capture server, so
 * nothing leaves the machine and Playwright can read the delivered code back
 * out of Mailpit's HTTP API.
 */

let cached: Transporter | null = null;

function transporter(): Transporter {
  if (cached) return cached;
  const e = env();
  cached = nodemailer.createTransport({
    host: e.SMTP_HOST,
    port: e.SMTP_PORT,
    secure: e.SMTP_SECURE,
    auth: e.SMTP_USER ? { user: e.SMTP_USER, pass: e.SMTP_PASSWORD ?? '' } : undefined,
    // Mailpit presents a self-signed certificate on its optional TLS port.
    tls: e.NODE_ENV === 'production' ? undefined : { rejectUnauthorized: false },
  });
  return cached;
}

export type MailMessage = {
  to: string;
  subject: string;
  text: string;
  html: string;
};

export class MailDeliveryError extends Error {}

export async function sendMail(message: MailMessage): Promise<void> {
  try {
    await transporter().sendMail({
      from: env().MAIL_FROM,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
  } catch (error) {
    // Never let the recipient address or message body reach the logs verbatim.
    throw new MailDeliveryError(
      `Could not deliver "${message.subject}": ${error instanceof Error ? error.message : 'unknown transport error'}`,
    );
  }
}

function shell(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>
<body style="margin:0;background:#f5f5f7;font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#111927;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:14px;border:1px solid #e5e7eb;overflow:hidden;">
        <tr><td style="background:#111927;padding:20px 28px;">
          <span style="color:#ffffff;font-weight:700;letter-spacing:.12em;font-size:13px;">WARESPORT</span>
          <span style="color:#9ca3af;font-size:13px;"> &nbsp;|&nbsp; Sales Hub</span>
        </td></tr>
        <tr><td style="padding:28px;">${bodyHtml}</td></tr>
        <tr><td style="padding:16px 28px 24px;border-top:1px solid #f3f4f6;color:#6b7280;font-size:12px;line-height:1.6;">
          This is an internal Waresport tool. If you were not expecting this message you can ignore it.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function signInCodeMessage(to: string, code: string, ttlMinutes: number): MailMessage {
  return {
    to,
    subject: `${code} is your Waresport Sales Hub sign-in code`,
    text: `Your Waresport Sales Hub sign-in code is ${code}.\n\nIt expires in ${ttlMinutes} minutes and can be used once.\nIf you did not request it, ignore this email.`,
    html: shell(
      'Your sign-in code',
      `<h1 style="margin:0 0 8px;font-size:19px;">Your sign-in code</h1>
       <p style="margin:0 0 20px;color:#4b5563;font-size:14px;line-height:1.6;">Enter this code to finish signing in.</p>
       <div style="font-size:34px;font-weight:700;letter-spacing:.34em;padding:16px 20px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:10px;text-align:center;">${escapeHtml(code)}</div>
       <p style="margin:20px 0 0;color:#6b7280;font-size:13px;">Expires in ${ttlMinutes} minutes. It can be used once.</p>`,
    ),
  };
}

export function invitationMessage(
  to: string,
  code: string,
  appUrl: string,
  ttlHours: number,
  inviterName: string,
): MailMessage {
  const link = `${appUrl.replace(/\/$/, '')}/verify?email=${encodeURIComponent(to)}`;
  return {
    to,
    subject: 'Your Waresport Sales Hub invitation',
    text:
      `${inviterName} invited you to the Waresport business development internship workspace.\n\n` +
      `Your verification code is ${code}.\n\nOpen ${link} and enter the code to set up your account.\n` +
      `The invitation expires in ${ttlHours} hours.`,
    html: shell(
      'You have been invited',
      `<h1 style="margin:0 0 8px;font-size:19px;">You have been invited</h1>
       <p style="margin:0 0 20px;color:#4b5563;font-size:14px;line-height:1.6;">
         ${escapeHtml(inviterName)} invited you to the Waresport business development internship workspace.
       </p>
       <div style="font-size:34px;font-weight:700;letter-spacing:.34em;padding:16px 20px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:10px;text-align:center;">${escapeHtml(code)}</div>
       <p style="margin:20px 0 20px;color:#4b5563;font-size:14px;">
         <a href="${escapeHtml(link)}" style="display:inline-block;background:#E60027;color:#ffffff;text-decoration:none;padding:11px 20px;border-radius:8px;font-weight:600;font-size:14px;">Accept your invitation</a>
       </p>
       <p style="margin:0;color:#6b7280;font-size:13px;">This invitation expires in ${ttlHours} hours and can only be used by ${escapeHtml(to)}.</p>`,
    ),
  };
}
