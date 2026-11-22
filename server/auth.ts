import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { UserProfile, UserRole } from './types.js';
import { getUserById, getUsers, saveUsers } from './storage.js';

const EPHEMERAL_SESSION_SECRET = crypto.randomBytes(32).toString('hex');

function getSessionSecret(): string {
  return process.env.SESSION_SECRET?.trim() || EPHEMERAL_SESSION_SECRET;
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt:${salt}:${hash}`;
}

export function verifyPassword(password: string, storedHash?: string, legacyPlain?: string): boolean {
  if (storedHash && storedHash.startsWith('scrypt:')) {
    const [, salt, original] = storedHash.split(':');
    if (!salt || !original) return false;
    const derived = crypto.scryptSync(password, salt, 64);
    const originalBuf = Buffer.from(original, 'hex');
    if (derived.length !== originalBuf.length) return false;
    return crypto.timingSafeEqual(derived, originalBuf);
  }
  if (legacyPlain) {
    const a = Buffer.from(password, 'utf8');
    const b = Buffer.from(legacyPlain, 'utf8');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }
  return false;
}

export interface SessionPayload {
  userId: string;
  role: UserRole;
  memberId?: string;
  memberName?: string;
  iat: number;
  exp: number;
}

export function issueToken(payload: Omit<SessionPayload, 'iat' | 'exp'>): string {
  const now = Math.floor(Date.now() / 1000);
  const full: SessionPayload = {
    ...payload,
    iat: now,
    exp: now + 60 * 60 * 24 * 30, // 30 days
  };
  const encoded = Buffer.from(JSON.stringify(full)).toString('base64url');
  const sig = crypto
    .createHmac('sha256', getSessionSecret())
    .update(encoded)
    .digest('base64url');
  return `${encoded}.${sig}`;
}

export function verifyToken(token: string): SessionPayload | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 2) return null;
    const [encoded, sig] = parts;
    const expectedSig = crypto
      .createHmac('sha256', getSessionSecret())
      .update(encoded)
      .digest('base64url');
    const sigBuf = Buffer.from(sig, 'utf8');
    const expectedBuf = Buffer.from(expectedSig, 'utf8');
    if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
      return null;
    }
    const decoded = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as SessionPayload;
    if (!decoded.userId || (decoded.exp && decoded.exp < Math.floor(Date.now() / 1000))) {
      return null;
    }
    return decoded;
  } catch {
    return null;
  }
}

export function toSafeUser(u: UserProfile) {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    hasPassword: Boolean(u.passwordHash || u.password),
    telegramChatId: u.telegramChatId,
    telegramUsername: u.telegramUsername,
    linkedMembers: u.linkedMembers || [],
    pendingRequests: u.pendingRequests || [],
    linkCode: u.linkCode,
    createdAt: u.createdAt,
    trackingStartMonth: u.trackingStartMonth,
  };
}

export interface AuthedRequest extends Request {
  activeUser?: UserProfile;
  authRole?: UserRole;
  authMemberName?: string;
}

export function resolveUserContext(req: AuthedRequest, res: Response, next: NextFunction): void {
  const allUsers = getUsers();
  const authHeader = req.headers.authorization;
  const bearer = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';

  if (bearer) {
    const session = verifyToken(bearer);
    if (session) {
      const found = getUserById(session.userId);
      if (found) {
        req.activeUser = found;
        req.authRole = session.role || 'owner';
        req.authMemberName = session.memberName;
        next();
        return;
      }
    }
  }

  const headerUserId = typeof req.headers['x-user-id'] === 'string' ? req.headers['x-user-id'].trim() : '';
  const candidate = (headerUserId ? getUserById(headerUserId) : undefined) || allUsers[0];

  if (!candidate) {
    res.status(404).json({ error: 'No workspace profile found' });
    return;
  }

  // If the account has a password set, require a valid Bearer token for protected endpoints
  if (candidate.passwordHash || candidate.password) {
    // Allow unauthenticated read of public profile list only on /api/users/me or /api/users? Wait:
    // Better: require auth token when password is set, except on login/register/health/telegram webhook.
    res.status(401).json({ error: 'Authentication required', requiresLogin: true, userId: candidate.id });
    return;
  }

  req.activeUser = candidate;
  req.authRole = 'owner';
  next();
}

export function migrateLegacyPasswordIfNeeded(user: UserProfile, plainPassword: string): void {
  if (user.password && !user.passwordHash) {
    user.passwordHash = hashPassword(plainPassword);
    delete user.password;
    const list = getUsers().map(u => (u.id === user.id ? user : u));
    saveUsers(list);
  }
}
