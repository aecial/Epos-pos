export type ApiErrorKind =
  | 'not_configured' // no server address set yet
  | 'network' // fetch failed: no Wi-Fi, server down, wrong address
  | 'timeout'
  | 'unauthorized' // 401
  | 'forbidden' // 403
  | 'not_found' // 404
  | 'conflict' // 409
  | 'validation' // 422
  | 'rate_limited' // 429
  | 'server' // 5xx
  | 'unknown';

export type FieldErrors = Record<string, string[]>;

type ApiErrorInit = {
  kind: ApiErrorKind;
  message: string;
  status?: number;
  fieldErrors?: FieldErrors;
  retryAfterSeconds?: number;
};

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number | null;
  readonly fieldErrors: FieldErrors | null;
  readonly retryAfterSeconds: number | null;

  constructor(init: ApiErrorInit) {
    super(init.message);
    Object.setPrototypeOf(this, ApiError.prototype);
    this.name = 'ApiError';
    this.kind = init.kind;
    this.status = init.status ?? null;
    this.fieldErrors = init.fieldErrors ?? null;
    this.retryAfterSeconds = init.retryAfterSeconds ?? null;
  }
}

/** True when the server could not be reached or is in trouble: treat as offline. */
export function isOfflineError(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.kind === 'network' || error.kind === 'timeout' || error.kind === 'server')
  );
}

export function kindFromStatus(status: number): ApiErrorKind {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 422) return 'validation';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server';
  return 'unknown';
}
