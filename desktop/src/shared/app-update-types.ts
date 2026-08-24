import { z } from 'zod/mini';

const APP_UPDATE_REPOSITORY = Object.freeze({ owner: 'amux-app', repo: 'amux' });

const APP_UPDATE_DISABLED_REASONS = [
  'development',
  'policy',
  'not-in-applications',
] as const;

const APP_UPDATE_ERROR_KINDS = [
  'network',
  'feed',
  'download',
  'install',
  'unknown',
] as const;

export type AppUpdateDisabledReason = (typeof APP_UPDATE_DISABLED_REASONS)[number];

const semanticVersionSchema = z.string().check(z.regex(
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
  'Expected a semantic version',
));

const nonnegativeNumberSchema = z.number().check(z.nonnegative());

const appUpdateProgressSchema = z.strictObject({
  bytesPerSecond: nonnegativeNumberSchema,
  percent: z.number().check(z.minimum(0), z.maximum(100)),
  total: nonnegativeNumberSchema,
  transferred: nonnegativeNumberSchema,
}).check((payload) => {
  if (payload.value.transferred > payload.value.total) {
    payload.issues.push({
      code: 'custom',
      input: payload.value,
      message: 'Transferred bytes cannot exceed total bytes',
      path: ['transferred'],
    });
  }
});

const appUpdateErrorSchema = z.strictObject({
  kind: z.enum(APP_UPDATE_ERROR_KINDS),
  retryable: z.boolean(),
});

const snapshotBase = {
  checkedAt: z.optional(z.iso.datetime({ offset: true })),
  currentVersion: semanticVersionSchema,
  revision: z.int().check(z.nonnegative()),
};

const availableBase = {
  ...snapshotBase,
  availableVersion: semanticVersionSchema,
  releaseNotesUrl: z.optional(z.string().check(z.regex(
    /^https:\/\/github\.com\/amux-app\/amux\/releases\/tag\/v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/,
    'Expected a canonical stable Amux release URL',
  ))),
};

export const appUpdateSnapshotSchema = z.discriminatedUnion('phase', [
  z.strictObject({
    ...snapshotBase,
    disabledReason: z.enum(APP_UPDATE_DISABLED_REASONS),
    phase: z.literal('disabled'),
  }),
  z.strictObject({
    ...snapshotBase,
    phase: z.literal('idle'),
  }),
  z.strictObject({
    ...snapshotBase,
    manualCheck: z.optional(z.boolean()),
    phase: z.literal('checking'),
  }),
  z.strictObject({
    ...availableBase,
    phase: z.literal('available'),
  }),
  z.strictObject({
    ...availableBase,
    phase: z.literal('downloading'),
    progress: z.optional(appUpdateProgressSchema),
  }),
  z.strictObject({
    ...availableBase,
    phase: z.literal('ready'),
  }),
  z.strictObject({
    ...availableBase,
    phase: z.literal('installing'),
  }),
  z.strictObject({
    ...snapshotBase,
    error: appUpdateErrorSchema,
    manualCheck: z.optional(z.boolean()),
    phase: z.literal('error'),
  }),
]);

export type AppUpdateProgress = z.infer<typeof appUpdateProgressSchema>;
export type AppUpdateError = z.infer<typeof appUpdateErrorSchema>;
export type AppUpdateSnapshot = z.infer<typeof appUpdateSnapshotSchema>;

interface RawUpdateProgress {
  bytesPerSecond?: number;
  percent?: number;
  total?: number;
  transferred?: number;
}

function finiteNonNegative(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
}

export function normalizeUpdateProgress(progress: RawUpdateProgress): AppUpdateProgress {
  const total = finiteNonNegative(progress.total);
  return {
    bytesPerSecond: finiteNonNegative(progress.bytesPerSecond),
    percent: Math.min(100, finiteNonNegative(progress.percent)),
    total,
    transferred: Math.min(total, finiteNonNegative(progress.transferred)),
  };
}

export function createInitialUpdateSnapshot(
  currentVersion: string,
  disabledReason?: AppUpdateDisabledReason,
): AppUpdateSnapshot {
  return disabledReason
    ? appUpdateSnapshotSchema.parse({ currentVersion, disabledReason, phase: 'disabled', revision: 0 })
    : appUpdateSnapshotSchema.parse({ currentVersion, phase: 'idle', revision: 0 });
}

export function buildCanonicalReleaseNotesUrl(version: string): string | null {
  const result = semanticVersionSchema.safeParse(version);
  if (!result.success || version.includes('-') || version.includes('+')) return null;
  const { owner, repo } = APP_UPDATE_REPOSITORY;
  return `https://github.com/${owner}/${repo}/releases/tag/v${version}`;
}
