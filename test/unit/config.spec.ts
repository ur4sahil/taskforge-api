// Regression tests for the secret-validation guard in src/config/index.ts.
// The actual authConfig factory is invoked at module load — to test both
// production-required and dev-fallback paths, we re-require the file with
// different env state per test (jest.isolateModules clears the cache).
describe('authConfig secret validation', () => {
  const origEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...origEnv };
    jest.resetModules();
  });

  it('uses dev fallback when secrets are missing in development', () => {
    process.env.NODE_ENV = 'development';
    delete process.env.JWT_ACCESS_SECRET;
    delete process.env.JWT_REFRESH_SECRET;
    let cfg: any;
    jest.isolateModules(() => { cfg = require('../../src/config').authConfig(); });
    expect(cfg.jwtAccessSecret).toBe('dev-access-secret');
    expect(cfg.jwtRefreshSecret).toBe('dev-refresh-secret');
  });

  it('uses dev fallback when secrets are missing in test', () => {
    process.env.NODE_ENV = 'test';
    delete process.env.JWT_ACCESS_SECRET;
    delete process.env.JWT_REFRESH_SECRET;
    let cfg: any;
    jest.isolateModules(() => { cfg = require('../../src/config').authConfig(); });
    expect(cfg.jwtAccessSecret).toBe('dev-access-secret');
  });

  it('honors explicit env values regardless of NODE_ENV', () => {
    process.env.NODE_ENV = 'production';
    process.env.JWT_ACCESS_SECRET = 'real-access';
    process.env.JWT_REFRESH_SECRET = 'real-refresh';
    let cfg: any;
    jest.isolateModules(() => { cfg = require('../../src/config').authConfig(); });
    expect(cfg.jwtAccessSecret).toBe('real-access');
    expect(cfg.jwtRefreshSecret).toBe('real-refresh');
  });

  it('throws when JWT_ACCESS_SECRET is missing in production', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.JWT_ACCESS_SECRET;
    process.env.JWT_REFRESH_SECRET = 'set';
    expect(() => {
      jest.isolateModules(() => { require('../../src/config').authConfig(); });
    }).toThrow(/JWT_ACCESS_SECRET is required in production/);
  });

  it('throws when JWT_REFRESH_SECRET is missing in production', () => {
    process.env.NODE_ENV = 'production';
    process.env.JWT_ACCESS_SECRET = 'set';
    delete process.env.JWT_REFRESH_SECRET;
    expect(() => {
      jest.isolateModules(() => { require('../../src/config').authConfig(); });
    }).toThrow(/JWT_REFRESH_SECRET is required in production/);
  });
});
