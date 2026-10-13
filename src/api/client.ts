import { ApiError, kindFromStatus, type FieldErrors } from './errors';
import type { ApiSuccess } from './types';

const DEFAULT_TIMEOUT_MS = 10_000;

type ApiConfig = {
  getBaseUrl: () => string | null;
  getToken: () => string | null;
  /** Called on a 401 from an authenticated request. Show login; never clear the outbox. */
  onUnauthorized?: () => void;
};

let config: ApiConfig = {
  getBaseUrl: () => null,
  getToken: () => null,
};

/** Called once at startup so the client can read settings and the session without importing them. */
export function configureApi(next: ApiConfig) {
  config = next;
}

type RequestOptions = {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  /** Send the Bearer token. Only login turns this off. */
  auth?: boolean;
  timeoutMs?: number;
};

function parseJson(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readFieldErrors(body: Record<string, unknown>): FieldErrors | undefined {
  return isRecord(body.errors) ? (body.errors as FieldErrors) : undefined;
}

function readRetryAfter(response: Response): number | undefined {
  const seconds = Number(response.headers.get('Retry-After'));
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}

function fallbackMessage(status: number): string {
  if (status >= 500) return 'The server had a problem. Try again shortly.';
  return `Request failed (${status}).`;
}

export async function apiRequest<T>(
  path: string,
  { method = 'GET', body, auth = true, timeoutMs = DEFAULT_TIMEOUT_MS }: RequestOptions = {},
): Promise<ApiSuccess<T>> {
  const baseUrl = config.getBaseUrl()?.trim().replace(/\/+$/, '');
  if (!baseUrl) {
    throw new ApiError({ kind: 'not_configured', message: 'Server address is not set.' });
  }

  const headers: Record<string, string> = { Accept: 'application/json' };
  const token = auth ? config.getToken() : null;
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  let response: Response;
  let text: string;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    text = await response.text();
  } catch {
    throw new ApiError(
      timedOut
        ? { kind: 'timeout', message: 'The server took too long to answer.' }
        : { kind: 'network', message: 'Cannot reach the server.' },
    );
  } finally {
    clearTimeout(timer);
  }

  const json = parseJson(text);

  if (response.ok) {
    if (isRecord(json) && json.success === true && 'data' in json) {
      return json as ApiSuccess<T>;
    }
    throw new ApiError({
      kind: 'unknown',
      status: response.status,
      message: 'The server sent an unexpected response.',
    });
  }

  if (response.status === 401 && auth) config.onUnauthorized?.();

  const failure = isRecord(json) ? json : {};
  throw new ApiError({
    kind: kindFromStatus(response.status),
    status: response.status,
    message: typeof failure.message === 'string' ? failure.message : fallbackMessage(response.status),
    fieldErrors: readFieldErrors(failure),
    retryAfterSeconds: response.status === 429 ? readRetryAfter(response) : undefined,
  });
}
