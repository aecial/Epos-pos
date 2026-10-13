import type { FieldErrors } from './errors';

export type ApiSuccess<T, M = unknown> = {
  success: true;
  data: T;
  meta?: M;
};

export type ApiFailure = {
  success: false;
  message: string;
  errors?: FieldErrors; // only with 422
};

export type UserRole = 'cashier' | 'manager' | 'admin';

export type ApiUser = {
  id: number;
  name: string;
  username: string;
  role: UserRole;
  status: string;
};

export type ApiDevice = {
  code: string; // e.g. "P3": prefix for offline order labels and receipt numbers
  name: string; // e.g. "POS-01"
};

export type LoginRequest = {
  username: string;
  password: string;
  device_name: string;
};

export type LoginData = {
  token: string;
  user: ApiUser;
  device: ApiDevice | null; // null only for kds-scoped logins, which this app never makes
};
