import type { BenchRequest } from './types.js';
export function localPath(value: unknown): value is string {
  if (typeof value !== 'string' || !value.startsWith('/') || /[\s#\\]/u.test(value)) return false;
  try {
    const path = decodeURIComponent(value.split('?')[0]);
    return !path.startsWith('//') && !/[\\\p{Cc}]/u.test(path) &&
      !path.split('/').some(segment => segment === '.' || segment === '..');
  } catch {
    return false;
  }
}

export function requireLocalPath(value: string): string {
  if (!localPath(value)) throw new TypeError('Use an application-relative, same-origin path.');
  return value;
}

export function sameOrigin({ headers, origin }: Pick<BenchRequest, 'headers' | 'origin'>): boolean {
  const site = headers['sec-fetch-site'];
  if ([site].flat().some(value => value?.split(',').some(part => part.trim().toLowerCase() === 'cross-site'))) return false;
  if (headers.origin === undefined) return true;
  if (typeof headers.origin !== 'string' || !/^https?:\/\//i.test(headers.origin)) return false;
  try {
    const value = new URL(headers.origin);
    return value.origin === new URL(origin).origin &&
      !value.username && !value.password && value.pathname === '/' && !value.search && !value.hash;
  } catch {
    return false;
  }
}

export function hasPreference(value: BenchRequest['headers'][string], name: string): boolean {
  return typeof value === 'string' && value.trim().toLowerCase() === name;
}

export function requestsRollback(value: BenchRequest['headers'][string]): boolean {
  return [value].flat().some(header => header?.split(/[,;]/).some(part => /^\s*tx\s*=\s*(rollback|"rollback")\s*$/i.test(part)));
}
