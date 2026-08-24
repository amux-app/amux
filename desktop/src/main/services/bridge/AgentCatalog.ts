import {
  getAvailableAgents,
  getAgentsWithCapability,
  type AgentCapability,
  type AgentName,
} from 'aumx/core';

export class AgentCatalog {
  private agents: AgentName[] = [];
  private hasCache = false;
  private refreshInFlight: Promise<AgentName[]> | null = null;

  async getAvailable(capability?: AgentCapability): Promise<AgentName[]> {
    if (!this.hasCache) await this.detect(false);
    return this.select(capability);
  }

  async refresh(capability?: AgentCapability): Promise<AgentName[]> {
    await this.detect(true);
    return this.select(capability);
  }

  getCached(): AgentName[] {
    return [...this.agents];
  }

  hasCached(): boolean {
    return this.hasCache;
  }

  replace(agents: readonly AgentName[]): void {
    this.agents = [...agents];
    this.hasCache = true;
  }

  clear(): void {
    this.agents = [];
    this.hasCache = false;
  }

  detect(refreshIdentity: boolean): Promise<AgentName[]> {
    if (this.refreshInFlight) return this.refreshInFlight;

    const discovery = getAvailableAgents(refreshIdentity ? { refreshIdentity: true } : undefined)
      .then((agents) => {
        this.replace(agents);
        return this.getCached();
      });
    this.refreshInFlight = discovery;
    void discovery.then(
      () => this.clearCompletedRefresh(discovery),
      () => this.clearCompletedRefresh(discovery),
    );
    return discovery;
  }

  private clearCompletedRefresh(discovery: Promise<AgentName[]>): void {
    if (this.refreshInFlight === discovery) this.refreshInFlight = null;
  }

  private select(capability?: AgentCapability): AgentName[] {
    return capability
      ? getAgentsWithCapability(this.agents, capability)
      : this.getCached();
  }
}
