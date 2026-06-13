// Unit tests for EmailService. The `resend` SDK is mocked at the module level so
// no network calls happen; we assert the dev-fallback path, send success/error/
// throw handling, and that invitee-supplied text is HTML-escaped in the body.
import { ConfigService } from '@nestjs/config';

const sendMock = jest.fn();
jest.mock('resend', () => ({
  Resend: jest.fn().mockImplementation(() => ({ emails: { send: sendMock } })),
}));

import { EmailService } from '../../src/common/email/email.module';

function makeConfig(key?: string): ConfigService {
  const base: Record<string, any> = {
    'email.resendApiKey': key,
    'email.fromAddress': 'noreply@taskforge.test',
    'email.fromName': 'TaskForge',
  };
  return { get: (k: string) => base[k] } as any;
}

const params = () => ({
  to: 'invitee@example.com',
  inviteeName: 'Pat',
  inviterName: 'Sam',
  workspaceName: 'Acme',
  acceptUrl: 'https://app.test/accept-invite/tok',
  expiresAt: new Date(Date.now() + 7 * 86400000),
});

beforeEach(() => { sendMock.mockReset(); });

describe('EmailService (no API key)', () => {
  it('does not send and reports sent:false', async () => {
    const svc = new EmailService(makeConfig(undefined));
    const out = await svc.sendInviteEmail(params());
    expect(out).toEqual({ sent: false });
    expect(sendMock).not.toHaveBeenCalled();
  });
});

describe('EmailService (with API key)', () => {
  it('sends via Resend and returns the message id', async () => {
    sendMock.mockResolvedValue({ data: { id: 'msg_abc' } });
    const svc = new EmailService(makeConfig('re_test'));
    const out = await svc.sendInviteEmail(params());
    expect(out).toEqual({ sent: true, id: 'msg_abc' });
    const arg = sendMock.mock.calls[0][0];
    expect(arg).toMatchObject({ from: 'TaskForge <noreply@taskforge.test>', to: 'invitee@example.com' });
    expect(arg.subject).toContain('Acme');
  });

  it('returns sent:false when Resend responds with an error object', async () => {
    sendMock.mockResolvedValue({ error: { message: 'rate limited' } });
    const svc = new EmailService(makeConfig('re_test'));
    expect(await svc.sendInviteEmail(params())).toEqual({ sent: false });
  });

  it('returns sent:false when the send call throws', async () => {
    sendMock.mockRejectedValue(new Error('network'));
    const svc = new EmailService(makeConfig('re_test'));
    expect(await svc.sendInviteEmail(params())).toEqual({ sent: false });
  });

  it('HTML-escapes invitee/inviter/workspace names to prevent injection', async () => {
    sendMock.mockResolvedValue({ data: { id: 'x' } });
    const svc = new EmailService(makeConfig('re_test'));
    await svc.sendInviteEmail({ ...params(), inviterName: '<script>alert(1)</script>' });
    const html = sendMock.mock.calls[0][0].html as string;
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
