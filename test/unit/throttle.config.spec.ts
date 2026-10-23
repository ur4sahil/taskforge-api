// Guards the rate-limit wiring. @nestjs/throttler enforces EVERY entry of the
// forRoot array on EVERY route, so a second tight "auth" bucket (5/min) was
// throttling the whole API — the Home page's parallel loads tripped it on each
// visit. These tests pin: one throttler only, credential routes override it to
// 5/min, and no controller opts out of throttling wholesale.
import { THROTTLER_LIMIT, THROTTLER_SKIP, THROTTLER_TTL } from '@nestjs/throttler/dist/throttler.constants';
import { THROTTLERS, AUTH_THROTTLE, REFRESH_THROTTLE, DEFAULT_THROTTLE_LIMIT } from '../../src/common/throttle.config';
import { AuthController } from '../../src/modules/auth/auth.controller';
import { WorkspacesController } from '../../src/modules/workspaces/workspaces.controller';
import { WorkspaceInvitationsController, PublicInvitationsController } from '../../src/modules/invitations/invitations.module';
import { TasksController } from '../../src/modules/tasks/tasks.module';
import { ListsController } from '../../src/modules/lists/lists.module';

const limitOf = (target: any) => Reflect.getMetadata(THROTTLER_LIMIT + 'default', target);
const ttlOf = (target: any) => Reflect.getMetadata(THROTTLER_TTL + 'default', target);
const skipOf = (target: any) => Reflect.getMetadata(THROTTLER_SKIP + 'default', target);

describe('throttle config', () => {
  it('registers exactly one throttler, named default, at 600/min', () => {
    const list = THROTTLERS as any[];
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('default');
    expect(list[0].limit).toBe(DEFAULT_THROTTLE_LIMIT);
    expect(DEFAULT_THROTTLE_LIMIT).toBe(600);
  });

  it('AUTH_THROTTLE overrides the default bucket (not a separate named bucket)', () => {
    expect(Object.keys(AUTH_THROTTLE)).toEqual(['default']);
    expect(AUTH_THROTTLE.default.limit).toBe(5);
  });

  it.each([
    ['signup', AuthController.prototype.signup],
    ['login', AuthController.prototype.login],
    ['invitation accept', PublicInvitationsController.prototype.accept],
  ])('%s is limited to 5/min on the default bucket', (_name, handler) => {
    expect(limitOf(handler)).toBe(5);
    expect(ttlOf(handler)).toBe(60_000);
  });

  it('refresh has its own 30/min override on the default bucket (offices share one IP)', () => {
    expect(Object.keys(REFRESH_THROTTLE)).toEqual(['default']);
    expect(limitOf(AuthController.prototype.refresh)).toBe(30);
    expect(ttlOf(AuthController.prototype.refresh)).toBe(60_000);
  });

  it('ordinary authenticated handlers carry no override and so get the 600/min default', () => {
    expect(limitOf(TasksController.prototype.findAll)).toBeUndefined();
    expect(limitOf(ListsController.prototype.findAll)).toBeUndefined();
    expect(limitOf(AuthController.prototype.logout)).toBeUndefined();
  });

  it('no controller opts out of throttling wholesale', () => {
    // The two @SkipThrottle() decorators that used to live here were band-aids
    // for the double-bucket bug and left admin mutation routes unthrottled.
    for (const ctrl of [WorkspacesController, WorkspaceInvitationsController, PublicInvitationsController, TasksController, ListsController]) {
      expect(skipOf(ctrl)).toBeUndefined();
    }
  });
});
