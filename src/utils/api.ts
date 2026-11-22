import { UserRole } from '../types';

// Session token is held strictly in JS memory (never written to localStorage/sessionStorage)
let inMemoryAuthToken = '';
let inMemoryUserId = '';
let inMemoryRole: UserRole = 'owner';
let inMemoryMemberName = '';

export function getActiveUserId(): string {
  if (inMemoryUserId) return inMemoryUserId;
  try {
    return localStorage.getItem('teleexpense_user_id') || '';
  } catch {
    return '';
  }
}

export function getAuthToken(): string {
  return inMemoryAuthToken;
}

export function getAuthSessionRole(): UserRole {
  return inMemoryRole;
}

export function getAuthMemberName(): string {
  return inMemoryMemberName;
}

export function setAuthSession(
  userId: string,
  token?: string,
  meta?: { role?: UserRole; memberName?: string }
): void {
  inMemoryUserId = userId;
  if (token !== undefined) {
    inMemoryAuthToken = token;
  }
  if (meta?.role) {
    inMemoryRole = meta.role;
  }
  if (meta?.memberName !== undefined) {
    inMemoryMemberName = meta.memberName;
  }
  try {
    if (userId) {
      localStorage.setItem('teleexpense_user_id', userId);
    } else {
      localStorage.removeItem('teleexpense_user_id');
    }
  } catch {
    // ignore storage errors
  }
}

export function clearAuthSession(): void {
  inMemoryAuthToken = '';
  inMemoryUserId = '';
  inMemoryRole = 'owner';
  inMemoryMemberName = '';
  try {
    localStorage.removeItem('teleexpense_user_id');
  } catch {
    // ignore
  }
}

export function setActiveUserId(userId: string): void {
  setAuthSession(userId);
}

export async function safeFetchJson<T = any>(
  url: string,
  options?: RequestInit
): Promise<{ data: T | null; error: string | null; ok: boolean; status?: number }> {
  try {
    const activeUserId = getActiveUserId();
    const token = getAuthToken();
    const headers = new Headers(options?.headers || {});

    if (activeUserId && !headers.has('x-user-id')) {
      headers.set('x-user-id', activeUserId);
    }
    if (token && !headers.has('authorization')) {
      headers.set('authorization', `Bearer ${token}`);
    }

    const res = await fetch(url, {
      ...options,
      headers,
    });

    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      return {
        data: null,
        error: !res.ok ? `Request failed with status ${res.status}` : 'Non-JSON server response',
        ok: res.ok,
        status: res.status,
      };
    }

    const data = await res.json();
    if (!res.ok) {
      return {
        data,
        error: data?.error || `Request failed with status ${res.status}`,
        ok: false,
        status: res.status,
      };
    }

    return { data, error: null, ok: true, status: res.status };
  } catch (err: any) {
    return {
      data: null,
      error: err?.message || 'Network error',
      ok: false,
    };
  }
}

export async function downloadAuthenticatedFile(
  url: string,
  fallbackFilename: string
): Promise<{ ok: boolean; filename?: string; error?: string }> {
  try {
    const headers: Record<string, string> = {};
    const activeUserId = getActiveUserId();
    const token = getAuthToken();
    if (activeUserId) headers['x-user-id'] = activeUserId;
    if (token) headers['authorization'] = `Bearer ${token}`;

    const res = await fetch(url, { headers });
    if (!res.ok) {
      let msg = `Download failed (${res.status})`;
      try {
        const errJson = await res.json();
        if (errJson?.error) msg = errJson.error;
      } catch {
        // ignore non-json errors
      }
      return { ok: false, error: msg };
    }

    const blob = await res.blob();
    const disp = res.headers.get('content-disposition') || '';
    const nameMatch = disp.match(/filename="([^"]+)"/);
    const filename = nameMatch?.[1] || fallbackFilename;

    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objectUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(objectUrl);

    return { ok: true, filename };
  } catch (err: any) {
    return { ok: false, error: err?.message || 'Download failed' };
  }
}

