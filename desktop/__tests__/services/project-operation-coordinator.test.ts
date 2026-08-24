import { describe, expect, it, vi } from 'vitest';
import { ProjectOperationCoordinator } from '../../src/main/services/ProjectOperationCoordinator';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('ProjectOperationCoordinator', () => {
  it('waits for active mutations before starting a project switch', async () => {
    const coordinator = new ProjectOperationCoordinator();
    const mutationRelease = deferred<void>();
    const events: string[] = [];

    const mutation = coordinator.runMutation(async () => {
      events.push('mutation:start');
      await mutationRelease.promise;
      events.push('mutation:end');
    });
    await vi.waitFor(() => expect(events).toEqual(['mutation:start']));

    const projectSwitch = coordinator.runSwitch(async () => {
      events.push('switch:start');
    });
    await Promise.resolve();
    expect(events).toEqual(['mutation:start']);

    mutationRelease.resolve();
    await Promise.all([mutation, projectSwitch]);
    expect(events).toEqual(['mutation:start', 'mutation:end', 'switch:start']);
  });

  it('gives a waiting switch priority over new mutations', async () => {
    const coordinator = new ProjectOperationCoordinator();
    const firstMutationRelease = deferred<void>();
    const switchRelease = deferred<void>();
    const events: string[] = [];

    const firstMutation = coordinator.runMutation(async () => {
      events.push('mutation-1:start');
      await firstMutationRelease.promise;
    });
    await vi.waitFor(() => expect(events).toEqual(['mutation-1:start']));

    const projectSwitch = coordinator.runSwitch(async () => {
      events.push('switch:start');
      await switchRelease.promise;
      events.push('switch:end');
    });
    const secondMutation = coordinator.runMutation(async () => {
      events.push('mutation-2:start');
    });

    firstMutationRelease.resolve();
    await vi.waitFor(() => expect(events).toContain('switch:start'));
    expect(events).not.toContain('mutation-2:start');

    switchRelease.resolve();
    await Promise.all([firstMutation, projectSwitch, secondMutation]);
    expect(events).toEqual([
      'mutation-1:start',
      'switch:start',
      'switch:end',
      'mutation-2:start',
    ]);
  });

  it('allows nested mutations in the same operation without deadlocking', async () => {
    const coordinator = new ProjectOperationCoordinator();

    await expect(coordinator.runMutation(() => (
      coordinator.runMutation(async () => 'complete')
    ))).resolves.toBe('complete');
  });

  it('allows a switch operation to use nested coordinated scopes', async () => {
    const coordinator = new ProjectOperationCoordinator();

    await expect(coordinator.runSwitch(() => (
      coordinator.runMutation(() => coordinator.runSwitch(async () => 'complete'))
    ))).resolves.toBe('complete');
  });

  it('rejects a project switch requested from inside a mutation', async () => {
    const coordinator = new ProjectOperationCoordinator();

    await expect(coordinator.runMutation(() => (
      coordinator.runSwitch(async () => 'unreachable')
    ))).rejects.toThrow('Cannot switch projects from inside a project mutation');
  });

  it('does not inherit a completed mutation context into detached async work', async () => {
    const coordinator = new ProjectOperationCoordinator();
    const detachedStart = deferred<void>();
    const switchRelease = deferred<void>();
    const events: string[] = [];

    await coordinator.runMutation(async () => {
      void (async () => {
        await detachedStart.promise;
        await coordinator.runMutation(async () => {
          events.push('detached:mutation');
        });
      })();
    });

    const projectSwitch = coordinator.runSwitch(async () => {
      events.push('switch:start');
      await switchRelease.promise;
      events.push('switch:end');
    });
    await vi.waitFor(() => expect(events).toEqual(['switch:start']));

    detachedStart.resolve();
    await Promise.resolve();
    expect(events).toEqual(['switch:start']);

    switchRelease.resolve();
    await projectSwitch;
    await vi.waitFor(() => expect(events).toEqual([
      'switch:start',
      'switch:end',
      'detached:mutation',
    ]));
  });
});
