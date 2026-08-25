export type FakeUpdateScenario =
  | 'ready'
  | 'manual-error'
  | 'not-available'
  | 'not-in-applications';

export function fakeUpdateEnvironment(
  scenario: FakeUpdateScenario,
  version = '0.0.2',
): NodeJS.ProcessEnv {
  return {
    MUXBASE_E2E: '1',
    MUXBASE_E2E_UPDATE_CURRENT_VERSION: '0.0.1',
    MUXBASE_E2E_UPDATE_SCENARIO: scenario,
    MUXBASE_E2E_UPDATE_VERSION: version,
    NODE_ENV: 'test',
  };
}
