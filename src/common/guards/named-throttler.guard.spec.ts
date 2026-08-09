import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  ThrottlerGuard,
  ThrottlerModuleOptions,
  ThrottlerRequest,
  ThrottlerStorage,
} from '@nestjs/throttler';
import { NamedThrottlerGuard } from './named-throttler.guard';

/** Exposes the protected hook under test. */
class TestGuard extends NamedThrottlerGuard {
  public handle(props: ThrottlerRequest): Promise<boolean> {
    return this.handleRequest(props);
  }
}

const OPTIONS: ThrottlerModuleOptions = {
  throttlers: [
    { name: 'default', ttl: 60_000, limit: 120 },
    { name: 'lookup', ttl: 60_000, limit: 20 },
  ],
};

function makeContext(): ExecutionContext {
  const res = { header: jest.fn() };
  const req = { ip: '127.0.0.1', headers: {} };
  // Stable identities — the reflector is called with these exact references.
  const handler = function handler(): void {};
  const controller = class Controller {};
  return {
    getHandler: () => handler,
    getClass: () => controller,
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as unknown as ExecutionContext;
}

function makeProps(context: ExecutionContext, name: string): ThrottlerRequest {
  return {
    context,
    limit: 20,
    ttl: 60_000,
    blockDuration: 60_000,
    throttler: { name, ttl: 60_000, limit: 20 },
    getTracker: async () => '127.0.0.1',
    generateKey: () => `key-${name}`,
  } as unknown as ThrottlerRequest;
}

function makeStorage(): ThrottlerStorage & { increment: jest.Mock } {
  return {
    increment: jest.fn().mockResolvedValue({
      totalHits: 1,
      timeToExpire: 60,
      isBlocked: false,
      timeToBlockExpire: 0,
    }),
  } as unknown as ThrottlerStorage & { increment: jest.Mock };
}

async function makeGuard(metadata: unknown): Promise<{
  guard: TestGuard;
  storage: ThrottlerStorage & { increment: jest.Mock };
  reflector: { getAllAndOverride: jest.Mock };
}> {
  const storage = makeStorage();
  const reflector = { getAllAndOverride: jest.fn().mockReturnValue(metadata) };
  const guard = new TestGuard(OPTIONS, storage, reflector as unknown as Reflector);
  // Populates `throttlers` + `commonOptions`, exactly as Nest does at boot.
  await guard.onModuleInit();
  return { guard, storage, reflector };
}

describe('NamedThrottlerGuard', () => {
  it('passes a named bucket on a route that never asked for it, without touching storage', async () => {
    const { guard, storage, reflector } = await makeGuard(undefined);
    const context = makeContext();

    await expect(guard.handle(makeProps(context, 'lookup'))).resolves.toBe(true);

    expect(storage.increment).not.toHaveBeenCalled();
    expect(reflector.getAllAndOverride).toHaveBeenCalledWith('THROTTLER:LIMITlookup', [
      context.getHandler(),
      context.getClass(),
    ]);
  });

  it('delegates to the base guard when the route opted into the named bucket', async () => {
    const { guard, storage } = await makeGuard(20);
    const superSpy = jest.spyOn(ThrottlerGuard.prototype, 'handleRequest' as never);

    await expect(guard.handle(makeProps(makeContext(), 'lookup'))).resolves.toBe(true);

    expect(superSpy).toHaveBeenCalled();
    expect(storage.increment).toHaveBeenCalledTimes(1);
    superSpy.mockRestore();
  });

  it('always applies the `default` bucket, metadata or not', async () => {
    const { guard, storage, reflector } = await makeGuard(undefined);

    await expect(guard.handle(makeProps(makeContext(), 'default'))).resolves.toBe(true);

    expect(storage.increment).toHaveBeenCalledTimes(1);
    // The `default` bucket is unconditional, so its metadata is never consulted.
    expect(reflector.getAllAndOverride).not.toHaveBeenCalled();
  });
});
