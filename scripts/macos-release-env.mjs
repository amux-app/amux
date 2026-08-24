const REQUIRED_SIGNING_VARS = ['CSC_NAME'];

function isConfigured(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

export function getMacOSReleaseEnvironmentError(environment, platform) {
  if (platform !== 'darwin') return 'macOS release packaging must run on macOS.';

  const missingSigningVars = REQUIRED_SIGNING_VARS.filter(
    (name) => !isConfigured(environment[name]),
  );
  if (missingSigningVars.length > 0) {
    return `Missing required macOS signing environment variables: ${missingSigningVars.join(', ')}`;
  }

  const hasNotaryProfile = isConfigured(environment.APPLE_NOTARY_PROFILE);
  const hasDirectNotaryCredentials = [
    environment.APPLE_ID,
    environment.APPLE_APP_SPECIFIC_PASSWORD,
    environment.APPLE_TEAM_ID,
  ].every(isConfigured);

  if (!hasNotaryProfile && !hasDirectNotaryCredentials) {
    return 'Missing notarization credentials. Provide APPLE_NOTARY_PROFILE or APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, and APPLE_TEAM_ID.';
  }

  return null;
}
