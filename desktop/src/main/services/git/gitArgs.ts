export const HEAD_REF = 'HEAD';
export const PATHSPEC_SEPARATOR = '--';
export const REV_PARSE = 'rev-parse';
export const STATUS_ARGS = ['status', '--porcelain=v1', '-z', '-uall'] as const;
export const VERIFY_HEAD_ARGS = [REV_PARSE, '--verify', HEAD_REF] as const;
