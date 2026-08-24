const { existsSync } = require('node:fs');
const { join } = require('node:path');
const { notarize } = require('@electron/notarize');

exports.default = async function notarizeHook(context) {
  if (context.electronPlatformName !== 'darwin') {
    return;
  }

  const requireNotarization = process.env.AUMX_REQUIRE_NOTARIZATION === '1';
  const appName = context?.packager?.appInfo?.productFilename;
  const appOutDir = context?.appOutDir;

  if (!appName || !appOutDir) {
    if (requireNotarization) throw new Error('Notarization metadata missing');
    console.log('[notarize] Skipping: missing app metadata');
    return;
  }

  const appPath = join(appOutDir, `${appName}.app`);
  if (!existsSync(appPath)) {
    if (requireNotarization) throw new Error(`App not found for notarization: ${appPath}`);
    console.log(`[notarize] Skipping: app not found at ${appPath}`);
    return;
  }

  const appleId = process.env.APPLE_ID;
  const appleIdPassword = process.env.APPLE_APP_SPECIFIC_PASSWORD;
  const teamId = process.env.APPLE_TEAM_ID;
  const keychainProfile = process.env.APPLE_NOTARY_PROFILE;

  const hasKeychain = Boolean(keychainProfile);
  const hasCredentials = Boolean(appleId && appleIdPassword && teamId);

  if (!hasKeychain && !hasCredentials) {
    if (requireNotarization) throw new Error('No notarization credentials configured');
    console.log('[notarize] Skipping: no notarization credentials configured');
    return;
  }

  const appBundleId = context?.packager?.appInfo?.macBundleIdentifier ?? context?.packager?.appInfo?.id;

  const options = hasKeychain
    ? { tool: 'notarytool', appPath, keychainProfile }
    : { tool: 'notarytool', appPath, appleId, appleIdPassword, teamId };

  console.log(`[notarize] Submitting ${appPath} (${appBundleId ?? 'no bundle id'})`);
  await notarize(options);
  console.log(`[notarize] Notarization complete for ${appPath}`);
};
