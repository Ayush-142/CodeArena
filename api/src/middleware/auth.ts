import type { Request, Response, NextFunction, CookieOptions } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { AppError } from './errors.js';

export interface AuthUser {
  userId: string;
  handle: string;
  isAdmin: boolean;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export const AUTH_COOKIE_NAME = 'token';
export const AUTH_COOKIE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days, matches JWT expiresIn below

// httpOnly blocks JS (hence XSS) from reading the cookie; SameSite=Strict means the browser
// never attaches this cookie to cross-site requests, including state-changing POSTs from
// another origin — which is what CSRF needs — so no CSRF token is required for v1.
//
// Deployment note: SameSite=Strict cookies are only ever sent on same-site requests, where
// "site" means the registrable domain (eTLD+1), not the full origin — so frontend and API
// must share a registrable domain in production (e.g. codearena.dev frontend +
// api.codearena.dev API, both under codearena.dev), not unrelated domains. Local dev works
// today only because localhost:3000 and localhost:3001 are treated as same-site (same host,
// different ports).
export function authCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    sameSite: 'strict',
    secure: env.cookieSecure,
    maxAge: AUTH_COOKIE_MAX_AGE_MS,
    path: '/',
  };
}

// Pure verification: throws on missing/invalid/expired token, never touches Express types.
// This is the SAME jwt.verify call attachUser uses for REST requests and the socket handshake
// auth middleware (api/src/socket/index.ts) uses for WS connections — one verification path,
// not two copies of jwt.verify with the same secret.
export function verifyAuthToken(token: string): AuthUser {
  const payload = jwt.verify(token, env.jwtSecret) as AuthUser;
  return { userId: payload.userId, handle: payload.handle, isAdmin: payload.isAdmin };
}

// Populates req.user from the cookie JWT if present/valid; never rejects the request itself —
// public routes need this to run without erroring. Mount globally, after cookie-parser.
export function attachUser(req: Request, _res: Response, next: NextFunction): void {
  const token = req.cookies?.[AUTH_COOKIE_NAME] as string | undefined;
  if (!token) {
    next();
    return;
  }
  try {
    req.user = verifyAuthToken(token);
  } catch {
    // expired/invalid/tampered token: treat as unauthenticated, don't error the request
  }
  next();
}

// Route guard: mount per-route on anything that must be authenticated.
export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user) {
    next(new AppError(401, 'UNAUTHENTICATED', 'Authentication required'));
    return;
  }
  next();
}

// Route guard: mount after requireAuth on anything admin-only. Mirrors requireAuth's
// shape — 401 if unauthenticated at all, 403 if authenticated but not an admin.
export function requireAdmin(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user) {
    next(new AppError(401, 'UNAUTHENTICATED', 'Authentication required'));
    return;
  }
  if (!req.user.isAdmin) {
    next(new AppError(403, 'FORBIDDEN', 'Admin access required'));
    return;
  }
  next();
}
