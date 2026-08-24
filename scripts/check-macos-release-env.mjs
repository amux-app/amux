import { getMacOSReleaseEnvironmentError } from './macos-release-env.mjs';

const error = getMacOSReleaseEnvironmentError(process.env, process.platform);

if (error) {
  console.error(error);
  process.exit(1);
}

console.log('macOS signing and notarization environment variables are configured.');
