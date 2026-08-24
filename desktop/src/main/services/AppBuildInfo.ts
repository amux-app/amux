import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const AUMX_BUILD_KEY = 'aumxBuild';
const BUILD_NUMBER_KEY = 'number';
const BUILD_VERSION_KEY = 'version';
const PACKAGE_FILE = 'package.json';

export interface AppBuildInfo {
  buildNumber?: string;
  buildVersion: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readMetadataString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }

  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function readAppBuildInfo(appPath: string, appVersion: string): AppBuildInfo {
  const packageJson: unknown = JSON.parse(readFileSync(join(appPath, PACKAGE_FILE), 'utf8'));

  if (!isRecord(packageJson)) {
    return { buildVersion: appVersion };
  }

  const buildMetadata = packageJson[AUMX_BUILD_KEY];
  if (!isRecord(buildMetadata)) {
    return { buildVersion: appVersion };
  }

  return {
    buildNumber: readMetadataString(buildMetadata, BUILD_NUMBER_KEY),
    buildVersion: readMetadataString(buildMetadata, BUILD_VERSION_KEY) ?? appVersion,
  };
}
