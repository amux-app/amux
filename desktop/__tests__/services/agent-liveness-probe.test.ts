import { describe, expect, it } from 'vitest';
import { AgentLivenessProbe } from '../../src/main/services/AgentLivenessProbe';

describe('AgentLivenessProbe', () => {
  it('requires two consecutive confirmed absences before declaring a pane stopped', () => {
    const probe = new AgentLivenessProbe();

    expect(probe.resolve(['pane-1'], { indeterminate: new Set(), running: new Set() }).get('pane-1')).toBe('unknown');
    expect(probe.resolve(['pane-1'], { indeterminate: new Set(), running: new Set() }).get('pane-1')).toBe('stopped');
  });

  it('treats process-table failures as unknown and resets the stopped confirmation streak', () => {
    const probe = new AgentLivenessProbe();
    probe.resolve(['pane-1'], { indeterminate: new Set(), running: new Set() });

    expect(probe.resolve(['pane-1'], { indeterminate: new Set(['pane-1']), running: new Set() }).get('pane-1')).toBe('unknown');
    expect(probe.resolve(['pane-1'], { indeterminate: new Set(), running: new Set() }).get('pane-1')).toBe('unknown');
  });

  it('immediately confirms a discovered live process and clears old absence evidence', () => {
    const probe = new AgentLivenessProbe();
    probe.resolve(['pane-1'], { indeterminate: new Set(), running: new Set() });

    expect(probe.resolve(['pane-1'], { indeterminate: new Set(), running: new Set(['pane-1']) }).get('pane-1')).toBe('running');
    expect(probe.resolve(['pane-1'], { indeterminate: new Set(), running: new Set() }).get('pane-1')).toBe('unknown');
  });
});
