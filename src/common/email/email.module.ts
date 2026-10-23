import { Global, Injectable, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';

export interface InviteEmailParams {
  to: string;
  inviteeName: string;
  inviterName: string;
  workspaceName: string;
  acceptUrl: string;
  expiresAt: Date;
}

/** Thin wrapper around Resend. If RESEND_API_KEY is missing, logs the would-send
 *  email instead of throwing — keeps dev/CI environments functional without
 *  forcing every contributor to set up a sandboxed Resend account. */
@Injectable()
export class EmailService {
  private readonly log = new Logger('EmailService');
  private client: Resend | null = null;
  private from: string;
  private fromName: string;

  constructor(private config: ConfigService) {
    const key = this.config.get<string>('email.resendApiKey');
    this.from = this.config.get<string>('email.fromAddress') || 'noreply@taskforge.housify365.com';
    this.fromName = this.config.get<string>('email.fromName') || 'TaskForge';
    if (key) {
      this.client = new Resend(key);
      this.log.log(`Resend configured — emails will send from ${this.fromName} <${this.from}>`);
    } else {
      this.log.warn('RESEND_API_KEY not set — emails will be logged instead of sent');
    }
  }

  async sendInviteEmail(p: InviteEmailParams): Promise<{ sent: boolean; id?: string }> {
    const subject = `${p.inviterName} invited you to ${p.workspaceName} on TaskForge`;
    const html = renderInviteHtml(p);
    const text = renderInviteText(p);

    if (!this.client) {
      // Dev path. Log everything an operator needs to test the flow without Resend.
      this.log.warn(`[DEV] Invite email NOT SENT (no RESEND_API_KEY). To: ${p.to}. Accept URL: ${p.acceptUrl}`);
      return { sent: false };
    }

    return this.deliver('Invite', p.to, subject, html, text);
  }

  /** Forgot-password link. `url` carries the raw single-use token; it is never
   *  logged except on the dev (no Resend) path, mirroring the invite flow. */
  async sendPasswordReset(to: string, name: string, url: string, expiresMinutes: number): Promise<{ sent: boolean; id?: string }> {
    const subject = 'Reset your TaskForge password';
    const html = renderPasswordResetHtml({ name, url, expiresMinutes });
    const text = renderPasswordResetText({ name, url, expiresMinutes });
    if (!this.client) {
      this.log.warn(`[DEV] Password reset email NOT SENT (no RESEND_API_KEY). To: ${to}. Reset URL: ${url}`);
      return { sent: false };
    }
    return this.deliver('Password reset', to, subject, html, text);
  }

  /** Sent in place of a reset link when the account has no password (Google
   *  sign-in). Keeps the forgot-password response identical for every email
   *  while still telling the real owner what to do. */
  async sendPasswordResetNotApplicable(to: string, name: string, loginUrl: string): Promise<{ sent: boolean; id?: string }> {
    const subject = 'Your TaskForge account uses Google sign-in';
    const html = renderGoogleOnlyHtml({ name, loginUrl });
    const text = renderGoogleOnlyText({ name, loginUrl });
    if (!this.client) {
      this.log.warn(`[DEV] Google-only notice NOT SENT (no RESEND_API_KEY). To: ${to}.`);
      return { sent: false };
    }
    return this.deliver('Google-only notice', to, subject, html, text);
  }

  private async deliver(kind: string, to: string, subject: string, html: string, text: string): Promise<{ sent: boolean; id?: string }> {
    if (!this.client) return { sent: false };
    try {
      const result = await this.client.emails.send({
        from: `${this.fromName} <${this.from}>`,
        to,
        subject,
        html,
        text,
      });
      if ((result as any)?.error) {
        this.log.error(`Resend returned error: ${JSON.stringify((result as any).error)}`);
        return { sent: false };
      }
      const id = (result as any)?.data?.id;
      this.log.log(`${kind} email sent to ${to} (id=${id || 'unknown'})`);
      return { sent: true, id };
    } catch (err: any) {
      this.log.error(`Resend send failed: ${err?.message || err}`);
      return { sent: false };
    }
  }
}

// Shared chrome for every transactional email so they look like one product.
function wrapHtml(inner: string): string {
  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f4f4f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
    <div style="max-width:520px;margin:40px auto;background:#ffffff;border-radius:16px;padding:32px;box-shadow:0 1px 3px rgba(0,0,0,0.05);">
      <div style="font-size:22px;font-weight:700;color:#1e1b4b;margin-bottom:8px;">TaskForge</div>
      <div style="height:1px;background:#e5e7eb;margin:16px 0 24px;"></div>
${inner}
    </div>
  </body>
</html>`;
}

function renderPasswordResetHtml(p: { name: string; url: string; expiresMinutes: number }): string {
  const safeName = escapeHtml(p.name);
  const safeUrl = escapeHtml(p.url);
  return wrapHtml(`      <p style="font-size:15px;color:#111827;margin:0 0 12px;">Hi ${safeName},</p>
      <p style="font-size:15px;color:#374151;line-height:1.55;margin:0 0 20px;">
        We received a request to reset the password for your TaskForge account. Click the button below to choose a new one.
      </p>
      <p style="margin:24px 0;">
        <a href="${safeUrl}" style="display:inline-block;background:#6366f1;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;padding:12px 22px;border-radius:8px;">Reset password</a>
      </p>
      <p style="font-size:13px;color:#6b7280;line-height:1.5;margin:0 0 8px;">
        Or copy and paste this link into your browser:
      </p>
      <p style="font-size:12px;color:#4f46e5;word-break:break-all;margin:0 0 24px;">
        <a href="${safeUrl}" style="color:#4f46e5;">${safeUrl}</a>
      </p>
      <p style="font-size:12px;color:#9ca3af;margin:0;">
        This link expires in ${p.expiresMinutes} minutes and can be used once. If you didn't ask to reset your password, you can safely ignore this email — your password won't change.
      </p>`);
}

function renderPasswordResetText(p: { name: string; url: string; expiresMinutes: number }): string {
  return [
    `Hi ${p.name},`,
    ``,
    `We received a request to reset the password for your TaskForge account.`,
    ``,
    `Reset your password:`,
    p.url,
    ``,
    `This link expires in ${p.expiresMinutes} minutes and can be used once.`,
    `If you didn't ask to reset your password, you can ignore this email — your password won't change.`,
  ].join('\n');
}

function renderGoogleOnlyHtml(p: { name: string; loginUrl: string }): string {
  const safeName = escapeHtml(p.name);
  const safeUrl = escapeHtml(p.loginUrl);
  return wrapHtml(`      <p style="font-size:15px;color:#111827;margin:0 0 12px;">Hi ${safeName},</p>
      <p style="font-size:15px;color:#374151;line-height:1.55;margin:0 0 20px;">
        Someone asked to reset the password for this TaskForge account, but this account signs in with <b>Google</b> and has no TaskForge password to reset.
      </p>
      <p style="margin:24px 0;">
        <a href="${safeUrl}" style="display:inline-block;background:#6366f1;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;padding:12px 22px;border-radius:8px;">Sign in with Google</a>
      </p>
      <p style="font-size:12px;color:#9ca3af;margin:0;">
        If this wasn't you, no action is needed — nothing about your account has changed.
      </p>`);
}

function renderGoogleOnlyText(p: { name: string; loginUrl: string }): string {
  return [
    `Hi ${p.name},`,
    ``,
    `Someone asked to reset the password for this TaskForge account, but this account signs in with Google and has no TaskForge password to reset.`,
    ``,
    `Sign in with Google:`,
    p.loginUrl,
    ``,
    `If this wasn't you, no action is needed — nothing about your account has changed.`,
  ].join('\n');
}

function renderInviteHtml(p: InviteEmailParams): string {
  const expiresDays = Math.max(1, Math.round((p.expiresAt.getTime() - Date.now()) / 86400000));
  const safeName = escapeHtml(p.inviteeName);
  const safeInviter = escapeHtml(p.inviterName);
  const safeWorkspace = escapeHtml(p.workspaceName);
  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f4f4f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
    <div style="max-width:520px;margin:40px auto;background:#ffffff;border-radius:16px;padding:32px;box-shadow:0 1px 3px rgba(0,0,0,0.05);">
      <div style="font-size:22px;font-weight:700;color:#1e1b4b;margin-bottom:8px;">TaskForge</div>
      <div style="height:1px;background:#e5e7eb;margin:16px 0 24px;"></div>
      <p style="font-size:15px;color:#111827;margin:0 0 12px;">Hi ${safeName},</p>
      <p style="font-size:15px;color:#374151;line-height:1.55;margin:0 0 20px;">
        <b>${safeInviter}</b> invited you to join the <b>${safeWorkspace}</b> workspace on TaskForge.
      </p>
      <p style="margin:24px 0;">
        <a href="${p.acceptUrl}" style="display:inline-block;background:#6366f1;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;padding:12px 22px;border-radius:8px;">Accept invitation</a>
      </p>
      <p style="font-size:13px;color:#6b7280;line-height:1.5;margin:0 0 8px;">
        Or copy and paste this link into your browser:
      </p>
      <p style="font-size:12px;color:#4f46e5;word-break:break-all;margin:0 0 24px;">
        <a href="${p.acceptUrl}" style="color:#4f46e5;">${p.acceptUrl}</a>
      </p>
      <p style="font-size:12px;color:#9ca3af;margin:0;">
        This invitation expires in ${expiresDays} day${expiresDays === 1 ? '' : 's'}. If you weren't expecting it, you can safely ignore this email.
      </p>
    </div>
  </body>
</html>`;
}

function renderInviteText(p: InviteEmailParams): string {
  return [
    `Hi ${p.inviteeName},`,
    ``,
    `${p.inviterName} invited you to join the ${p.workspaceName} workspace on TaskForge.`,
    ``,
    `Accept your invitation:`,
    p.acceptUrl,
    ``,
    `This invitation expires on ${p.expiresAt.toISOString()}.`,
  ].join('\n');
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

@Global()
@Module({
  providers: [EmailService],
  exports: [EmailService],
})
export class EmailModule {}
