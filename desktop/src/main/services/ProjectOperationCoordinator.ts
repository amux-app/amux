import { AsyncLocalStorage } from 'node:async_hooks';

interface ProjectOperationContext {
  active: boolean;
  kind: 'mutation' | 'switch';
}

export class ProjectOperationCoordinator {
  private readonly context = new AsyncLocalStorage<ProjectOperationContext>();
  private activeMutations = 0;
  private activeSwitchScopes = 0;
  private switchActive = false;
  private readonly mutationWaiters: Array<() => void> = [];
  private readonly switchWaiters: Array<() => void> = [];

  async runMutation<T>(operation: () => Promise<T>): Promise<T> {
    const inherited = this.context.getStore();
    if (inherited?.active) {
      if (inherited.kind === 'switch') return this.runNestedSwitchScope(operation);
      this.activeMutations += 1;
      return this.runAcquiredMutation(operation);
    }

    await this.acquireMutation();
    return this.runAcquiredMutation(operation);
  }

  async runSwitch<T>(operation: () => Promise<T>): Promise<T> {
    const inherited = this.context.getStore();
    if (inherited?.active && inherited.kind === 'switch') {
      return this.runNestedSwitchScope(operation);
    }
    if (inherited?.active && inherited.kind === 'mutation') {
      throw new Error('Cannot switch projects from inside a project mutation');
    }

    await this.acquireSwitch();
    this.activeSwitchScopes += 1;
    return this.runAcquiredSwitch(operation);
  }

  private async runAcquiredMutation<T>(operation: () => Promise<T>): Promise<T> {
    const context: ProjectOperationContext = { active: true, kind: 'mutation' };
    try {
      return await this.context.run(context, operation);
    } finally {
      context.active = false;
      this.activeMutations -= 1;
      this.drain();
    }
  }

  private async runAcquiredSwitch<T>(operation: () => Promise<T>): Promise<T> {
    const context: ProjectOperationContext = { active: true, kind: 'switch' };
    try {
      return await this.context.run(context, operation);
    } finally {
      context.active = false;
      this.activeSwitchScopes -= 1;
      if (this.activeSwitchScopes === 0) {
        this.switchActive = false;
        this.drain();
      }
    }
  }

  private runNestedSwitchScope<T>(operation: () => Promise<T>): Promise<T> {
    this.activeSwitchScopes += 1;
    return this.runAcquiredSwitch(operation);
  }

  private async acquireMutation(): Promise<void> {
    if (!this.switchActive && this.switchWaiters.length === 0) {
      this.activeMutations += 1;
      return;
    }

    await new Promise<void>((resolve) => {
      this.mutationWaiters.push(resolve);
    });
  }

  private async acquireSwitch(): Promise<void> {
    if (!this.switchActive && this.activeMutations === 0 && this.switchWaiters.length === 0) {
      this.switchActive = true;
      return;
    }

    await new Promise<void>((resolve) => {
      this.switchWaiters.push(resolve);
    });
  }

  private drain(): void {
    if (this.switchActive || this.activeMutations > 0) return;

    const nextSwitch = this.switchWaiters.shift();
    if (nextSwitch) {
      this.switchActive = true;
      nextSwitch();
      return;
    }

    const mutations = this.mutationWaiters.splice(0);
    this.activeMutations += mutations.length;
    for (const startMutation of mutations) startMutation();
  }
}
