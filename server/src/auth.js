import crypto from 'node:crypto';
import { HttpError } from './errors.js';

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  const [saltHex, hashHex] = stored.split(':');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), 32);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function login(db, email, password) {
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email || '').toLowerCase());
  // Same error for unknown user and wrong password.
  if (!user || !verifyPassword(String(password || ''), user.password_hash)) {
    throw new HttpError(401, 'invalid_credentials', 'Invalid email or password');
  }
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?,?,?)')
    .run(sha256(token), user.id, Date.now() + SESSION_TTL_MS);
  return { token, user: { id: user.id, email: user.email, name: user.name } };
}

/** Express middleware: resolves Bearer token to req.user (with memberships) or 401. */
export function authenticate(db) {
  const findSession = db.prepare(
    `SELECT u.id, u.email, u.name FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ?`
  );
  const memberships = db.prepare('SELECT team_id, role FROM memberships WHERE user_id = ?');
  return (req, _res, next) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    const row = token && findSession.get(sha256(token), Date.now());
    if (!row) return next(new HttpError(401, 'unauthenticated', 'Sign in required'));
    req.user = { ...row, teams: Object.fromEntries(memberships.all(row.id).map((m) => [m.team_id, m.role])) };
    next();
  };
}
