// Unit tests for R2StorageService.
// The underlying S3 client is mocked at the @aws-sdk/client-s3 module level so
// we can assert constructor wiring + URL formatting without hitting Cloudflare.
import { ConfigService } from '@nestjs/config';
import { InternalServerErrorException } from '@nestjs/common';

// Capture S3Client construction args + .send() calls so tests can assert against them.
const sendMock = jest.fn();
const ctorCalls: any[] = [];
jest.mock('@aws-sdk/client-s3', () => {
  return {
    S3Client: jest.fn().mockImplementation((opts) => {
      ctorCalls.push(opts);
      return { send: sendMock };
    }),
    PutObjectCommand: jest.fn().mockImplementation((p) => ({ __cmd: 'Put', ...p })),
    GetObjectCommand: jest.fn().mockImplementation((p) => ({ __cmd: 'Get', ...p })),
    DeleteObjectCommand: jest.fn().mockImplementation((p) => ({ __cmd: 'Delete', ...p })),
  };
});
jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn().mockResolvedValue('https://signed.example/object?sig=abc'),
}));

import { R2StorageService } from '../../src/common/utils/r2-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

function makeConfig(overrides: Record<string, any> = {}): ConfigService {
  const base = {
    'storage.r2BucketName': 'taskforge-files',
    'storage.r2AccountId': 'acct123',
    'storage.r2AccessKeyId': 'kid',
    'storage.r2SecretAccessKey': 'sec',
    'storage.r2PublicUrl': undefined,
    'storage.r2KeyPrefix': '',
    'storage.presignedUrlExpirySeconds': 3600,
    ...overrides,
  };
  return { get: (k: string) => base[k as keyof typeof base] } as any;
}

beforeEach(() => {
  sendMock.mockReset();
  ctorCalls.length = 0;
  (getSignedUrl as jest.Mock).mockClear();
});

describe('R2StorageService', () => {
  it('constructs an S3Client pointed at the r2.cloudflarestorage.com endpoint when creds are present', () => {
    new R2StorageService(makeConfig());
    expect(ctorCalls).toHaveLength(1);
    expect(ctorCalls[0].region).toBe('auto');
    expect(ctorCalls[0].endpoint).toBe('https://acct123.r2.cloudflarestorage.com');
    expect(ctorCalls[0].credentials).toEqual({ accessKeyId: 'kid', secretAccessKey: 'sec' });
  });

  it('does NOT create an S3Client when credentials are missing — isConfigured()=false', () => {
    const svc = new R2StorageService(makeConfig({ 'storage.r2AccountId': undefined }));
    expect(ctorCalls).toHaveLength(0);
    expect(svc.isConfigured()).toBe(false);
  });

  it('upload throws InternalServerErrorException when not configured', async () => {
    const svc = new R2StorageService(makeConfig({ 'storage.r2AccessKeyId': undefined }));
    await expect(svc.upload('key.txt', Buffer.from('x'), 'text/plain'))
      .rejects.toBeInstanceOf(InternalServerErrorException);
  });

  it('upload sends a PutObjectCommand with bucket + key + body + content-type', async () => {
    const svc = new R2StorageService(makeConfig());
    sendMock.mockResolvedValue({});
    await svc.upload('docs/hello.txt', Buffer.from('hi'), 'text/plain');
    expect(sendMock).toHaveBeenCalledTimes(1);
    const cmd = sendMock.mock.calls[0][0];
    expect(cmd).toMatchObject({ __cmd: 'Put', Bucket: 'taskforge-files', Key: 'docs/hello.txt', ContentType: 'text/plain' });
  });

  it('upload prepends keyPrefix when configured', async () => {
    const svc = new R2StorageService(makeConfig({ 'storage.r2KeyPrefix': 'taskforge' }));
    sendMock.mockResolvedValue({});
    await svc.upload('a/b.txt', Buffer.from('x'), 'text/plain');
    const cmd = sendMock.mock.calls[0][0];
    expect(cmd.Key).toBe('taskforge/a/b.txt');
  });

  it('keyPrefix strips surrounding slashes and adds exactly one trailing slash', async () => {
    const svc = new R2StorageService(makeConfig({ 'storage.r2KeyPrefix': '/wrap/' }));
    sendMock.mockResolvedValue({});
    await svc.upload('/leading.txt', Buffer.from('x'), 'text/plain');
    const cmd = sendMock.mock.calls[0][0];
    expect(cmd.Key).toBe('wrap/leading.txt');
  });

  it('getDownloadUrl returns a direct public URL when publicUrl is set', async () => {
    const svc = new R2StorageService(makeConfig({ 'storage.r2PublicUrl': 'https://files.housify365.com' }));
    const url = await svc.getDownloadUrl('chat/abc.webm', 'voice memo.webm');
    expect(url).toBe('https://files.housify365.com/chat/abc.webm');
    expect(getSignedUrl).not.toHaveBeenCalled();
  });

  it('getDownloadUrl strips trailing slash from publicUrl before joining', async () => {
    const svc = new R2StorageService(makeConfig({ 'storage.r2PublicUrl': 'https://files.housify365.com/' }));
    expect(await svc.getDownloadUrl('foo.bin', 'foo.bin')).toBe('https://files.housify365.com/foo.bin');
  });

  it('getDownloadUrl falls back to a presigned URL when publicUrl is absent', async () => {
    const svc = new R2StorageService(makeConfig());
    const url = await svc.getDownloadUrl('foo.bin', 'My File.pdf');
    expect(url).toBe('https://signed.example/object?sig=abc');
    expect(getSignedUrl).toHaveBeenCalledTimes(1);
    const [, cmd, opts] = (getSignedUrl as jest.Mock).mock.calls[0];
    expect(cmd).toMatchObject({ __cmd: 'Get', Bucket: 'taskforge-files', Key: 'foo.bin' });
    expect(cmd.ResponseContentDisposition).toBe('attachment; filename="My File.pdf"');
    expect(opts).toEqual({ expiresIn: 3600 });
  });

  it('getDownloadUrl strips quotes from filename to prevent header injection', async () => {
    const svc = new R2StorageService(makeConfig());
    await svc.getDownloadUrl('foo.bin', 'bad"name".pdf');
    const cmd = (getSignedUrl as jest.Mock).mock.calls[0][1];
    expect(cmd.ResponseContentDisposition).toBe('attachment; filename="badname.pdf"');
  });

  it('delete is a no-op when not configured (does not throw)', async () => {
    const svc = new R2StorageService(makeConfig({ 'storage.r2AccountId': undefined }));
    await expect(svc.delete('foo')).resolves.toBeUndefined();
  });

  it('delete sends a DeleteObjectCommand when configured', async () => {
    const svc = new R2StorageService(makeConfig());
    sendMock.mockResolvedValue({});
    await svc.delete('to-remove.txt');
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0][0]).toMatchObject({ __cmd: 'Delete', Bucket: 'taskforge-files', Key: 'to-remove.txt' });
  });

  it('delete swallows backend errors instead of propagating', async () => {
    const svc = new R2StorageService(makeConfig());
    sendMock.mockRejectedValue(new Error('R2 5xx'));
    await expect(svc.delete('foo')).resolves.toBeUndefined();
  });
});
