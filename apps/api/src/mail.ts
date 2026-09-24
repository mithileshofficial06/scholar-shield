/**
 * Outbound mail.
 *
 * Two sign-in paths depend on a message actually arriving: an applicant's
 * magic link and a reviewer's invitation. Both used to mint a token and hand it
 * back in the HTTP response, which is fine for a local demo and useless anywhere
 * else.
 *
 * WHY A LOG TRANSPORT EXISTS
 * --------------------------
 * The project's promise is that `docker compose up` gives you a working stack
 * with no external accounts. Requiring SMTP credentials to run it locally would
 * break that, so with no SMTP_URL configured the message is written to the
 * server log and reported as `log` delivery — visibly not sent, never silently
 * dropped.
 *
 * In production that fallback is refused outright (see config.ts): a deployment
 * that cannot send a sign-in link cannot sign anyone in, and it should fail at
 * boot rather than at the first login attempt.
 */

import nodemailer, { type Transporter } from 'nodemailer';

import { config, isProduction } from './config.js';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export type MailDelivery = 'smtp' | 'log';

let transport: Transporter | null = null;

function smtpTransport(): Transporter {
  if (!transport) {
    transport = nodemailer.createTransport(config.SMTP_URL);
  }
  return transport;
}

export async function sendMail(message: MailMessage): Promise<{ delivered: boolean; via: MailDelivery }> {
  if (!config.SMTP_URL) {
    // Deliberately one line per field rather than a JSON blob: this is read by a
    // human in a terminal, and the link needs to be clickable.
    console.info(
      [
        '[mail] no SMTP_URL configured — message not sent',
        `  to:      ${message.to}`,
        `  subject: ${message.subject}`,
        ...message.text.split('\n').map((line) => `  ${line}`),
      ].join('\n'),
    );
    return { delivered: false, via: 'log' };
  }

  await smtpTransport().sendMail({
    from: config.MAIL_FROM,
    to: message.to,
    subject: message.subject,
    text: message.text,
  });

  return { delivered: true, via: 'smtp' };
}

/** Where a sign-in link points. The token is a URL parameter, never a path. */
function link(path: string, token: string): string {
  const url = new URL(path, config.WEB_ORIGIN);
  url.searchParams.set('token', token);
  return url.toString();
}

export function magicLinkMessage(to: string, token: string): MailMessage {
  const url = link('/status', token);
  return {
    to,
    subject: 'Your ScholarShield sign-in link',
    text: [
      'Use this link to check your scholarship application:',
      '',
      url,
      '',
      `The link expires in ${config.MAGIC_LINK_TTL_MINUTES} minutes and can be used once.`,
      'If you did not request it, you can ignore this message.',
    ].join('\n'),
  };
}

/**
 * Sent once, on a first submission from a new address. The link is an ordinary
 * sign-in link; using it is what confirms the address (migration 007).
 */
export function confirmationMessage(to: string, token: string): MailMessage {
  const url = link('/status', token);
  return {
    to,
    subject: 'Confirm your scholarship application',
    text: [
      'We received a scholarship application that gave this email address.',
      'Open this link to confirm it is yours — your application is not reviewed until you do:',
      '',
      url,
      '',
      'The link works for 3 days. After that, request a new one from the status page.',
      'If you did not apply, ignore this message and nothing further will happen.',
    ].join('\n'),
  };
}

export function inviteMessage(to: string, token: string, role: string): MailMessage {
  const url = link('/accept-invite', token);
  return {
    to,
    subject: 'You have been invited to review on ScholarShield',
    text: [
      `You have been invited as a ${role}. Set your password here:`,
      '',
      url,
      '',
      `This invitation expires in ${config.INVITE_TTL_DAYS} day${config.INVITE_TTL_DAYS === 1 ? '' : 's'}.`,
      'ScholarShield shows reviewers risk signals only. Every decision remains yours,',
      'requires a written reason, and is recorded in an append-only audit log.',
    ].join('\n'),
  };
}

/** True when mail would actually leave the building. Surfaced in /health/ready. */
export function mailConfigured(): boolean {
  return Boolean(config.SMTP_URL);
}

export function assertMailUsable(): void {
  if (isProduction && !config.SMTP_URL) {
    throw new Error('SMTP_URL must be set in production: sign-in links cannot be delivered.');
  }
}
