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

    try {
      const result = await this.client.emails.send({
        from: `${this.fromName} <${this.from}>`,
        to: p.to,
        subject,
        html,
        text,
      });
      if ((result as any)?.error) {
        this.log.error(`Resend returned error: ${JSON.stringify((result as any).error)}`);
        return { sent: false };
      }
      const id = (result as any)?.data?.id;
      this.log.log(`Invite email sent to ${p.to} (id=${id || 'unknown'})`);
      return { sent: true, id };
    } catch (err: any) {
      this.log.error(`Resend send failed: ${err?.message || err}`);
      return { sent: false };
    }
  }
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
