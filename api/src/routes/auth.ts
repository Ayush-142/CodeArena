import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import type { Response } from 'express';
import { User } from '../models/User.js';
import { env } from '../config/env.js';
import { AppError, asyncHandler, isMongoDuplicateKeyError } from '../middleware/errors.js';
import { requireAuth, authCookieOptions, AUTH_COOKIE_NAME } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { AUTH_RATE_WINDOWS } from '../config/rateLimits.js';

export const authRouter = Router();

const HANDLE_RE = /^[a-zA-Z0-9]{3,20}$/;
// bcryptjs (pure JS) is slower than native bcrypt at equal cost; 10 is the OWASP-recommended
// floor and keeps login/register latency reasonable on typical dev hardware.
const BCRYPT_COST = 10;

// Shared by register and login — one rl:auth:{ip} bucket per §7's key convention, not two.
const authRateLimiter = rateLimit({
  keyPrefix: 'rl:auth',
  windows: AUTH_RATE_WINDOWS,
  identify: (req) => req.ip ?? 'unknown',
});

function issueAuthCookie(res: Response, user: { _id: unknown; handle: string; isAdmin: boolean }): void {
  const token = jwt.sign(
    { userId: String(user._id), handle: user.handle, isAdmin: user.isAdmin },
    env.jwtSecret,
    { expiresIn: '7d' }, // no refresh tokens (out of scope) — prod upgrade path: short-lived access + refresh rotation
  );
  res.cookie(AUTH_COOKIE_NAME, token, authCookieOptions());
}

authRouter.post(
  '/register',
  authRateLimiter,
  asyncHandler(async (req, res) => {
    const { handle, email, password } = (req.body ?? {}) as {
      handle?: unknown;
      email?: unknown;
      password?: unknown;
    };

    if (typeof handle !== 'string' || !HANDLE_RE.test(handle)) {
      throw new AppError(400, 'VALIDATION_ERROR', 'handle must be 3-20 alphanumeric characters');
    }
    if (typeof email !== 'string' || !email.includes('@')) {
      throw new AppError(400, 'VALIDATION_ERROR', 'email must be a valid address');
    }
    if (typeof password !== 'string' || password.length < 8) {
      throw new AppError(400, 'VALIDATION_ERROR', 'password must be at least 8 characters');
    }

    const normalizedEmail = email.toLowerCase();
    const passwordHash = await bcrypt.hash(password, BCRYPT_COST);

    let user;
    try {
      user = await User.create({ handle, email: normalizedEmail, passwordHash, isAdmin: false });
    } catch (err) {
      // No pre-check findOne: it would just be a TOCTOU race under concurrent identical
      // registers anyway. Catch the unique-index violation directly instead.
      if (isMongoDuplicateKeyError(err)) {
        throw new AppError(409, 'HANDLE_OR_EMAIL_TAKEN', 'handle or email already in use');
      }
      throw err;
    }

    issueAuthCookie(res, user);
    res.status(201).json({ id: user._id.toString(), handle: user.handle, email: user.email, isAdmin: user.isAdmin });
  }),
);

authRouter.post(
  '/login',
  authRateLimiter,
  asyncHandler(async (req, res) => {
    const { handle, password } = (req.body ?? {}) as { handle?: unknown; password?: unknown };
    if (typeof handle !== 'string' || typeof password !== 'string') {
      throw new AppError(400, 'VALIDATION_ERROR', 'handle and password are required');
    }

    const user = await User.findOne({ handle });
    const ok = user ? await bcrypt.compare(password, user.passwordHash) : false;
    if (!user || !ok) {
      // Deliberately identical error for "no such user" and "wrong password" — don't leak
      // which one it was (standard login-enumeration hardening).
      throw new AppError(401, 'INVALID_CREDENTIALS', 'invalid handle or password');
    }

    issueAuthCookie(res, user);
    res.json({ id: user._id.toString(), handle: user.handle, email: user.email, isAdmin: user.isAdmin });
  }),
);

authRouter.post('/logout', (_req, res) => {
  res.clearCookie(AUTH_COOKIE_NAME, authCookieOptions());
  res.status(204).end();
});

authRouter.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    // Re-fetch from Mongo rather than trusting the JWT for `email`: the JWT payload is
    // deliberately minimal ({userId, handle, isAdmin}) and doesn't carry email.
    const user = await User.findById(req.user!.userId).select('handle email isAdmin').lean();
    if (!user) {
      throw new AppError(404, 'NOT_FOUND', 'user not found');
    }
    res.json({ id: user._id.toString(), handle: user.handle, email: user.email, isAdmin: user.isAdmin });
  }),
);
