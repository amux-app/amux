const MARKETPLACE_ERROR_CODES = [
  'ARTIFACT_MODIFIED',
  'CONCURRENT_MODIFICATION',
  'DESTINATION_CONFLICT',
  'INVALID_SOURCE_TREE',
  'ROLLBACK_FAILED',
  'TRANSACTION_RECOVERED',
] as const;

export type MarketplaceErrorCode = typeof MARKETPLACE_ERROR_CODES[number];
export type MarketplaceIntegrityErrorCode = Exclude<MarketplaceErrorCode, 'INVALID_SOURCE_TREE'>;
export type MarketplaceSourceTreeErrorCode = Extract<MarketplaceErrorCode, 'INVALID_SOURCE_TREE'>;

export function isMarketplaceErrorCode(value: unknown): value is MarketplaceErrorCode {
  return typeof value === 'string'
    && (MARKETPLACE_ERROR_CODES as readonly string[]).includes(value);
}

export class MarketplaceIntegrityError extends Error {
  readonly affectedPaths?: string[];
  readonly code: MarketplaceIntegrityErrorCode;
  readonly artifactPath?: string;

  constructor(
    code: MarketplaceIntegrityErrorCode,
    message: string,
    artifactPath?: string,
    affectedPaths?: string[],
  ) {
    super(`${code}: ${message}`);
    this.name = 'MarketplaceIntegrityError';
    this.affectedPaths = affectedPaths;
    this.code = code;
    this.artifactPath = artifactPath;
  }
}

export class MarketplaceSourceTreeError extends Error {
  readonly artifactPath: string;
  readonly code: MarketplaceSourceTreeErrorCode = 'INVALID_SOURCE_TREE';

  constructor(message: string, artifactPath: string) {
    super(message);
    this.name = 'MarketplaceSourceTreeError';
    this.artifactPath = artifactPath;
  }
}
