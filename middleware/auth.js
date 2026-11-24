const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-this';

const ALL_PERMISSIONS = [
  'view_registrations',
  'edit_registrations',
  'delete_registrations',
  'export_data',
  'manage_users'
];

/**
 * Hash a plaintext password using scrypt with a random 16-byte salt
 */
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derivedKey = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${derivedKey}`;
}

/**
 * Verify a plaintext password against a stored salt:hash string
 */
function verifyPassword(password, storedHash) {
  if (!storedHash || !String(storedHash).includes(':')) return false;
  const [salt, keyHex] = String(storedHash).split(':');
  if (!salt || !keyHex) return false;
  const derivedBuffer = crypto.scryptSync(String(password), salt, 64);
  const keyBuffer = Buffer.from(keyHex, 'hex');
  if (derivedBuffer.length !== keyBuffer.length) return false;
  return crypto.timingSafeEqual(derivedBuffer, keyBuffer);
}

/**
 * Middleware to verify JWT token
 */
function verifyToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  if (!token) {
    return res.status(401).json({
      success: false,
      message: 'Access denied. No token provided.'
    });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(403).json({
      success: false,
      message: 'Invalid or expired token.'
    });
  }
}

/**
 * Middleware factory to enforce granular permissions (Super Admin always allowed)
 */
function requirePermission(permission) {
  return (req, res, next) => {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ success: false, message: 'Authentication required.' });
    }
    if (user.role === 'super_admin' || user.isSuperAdmin === true) {
      return next();
    }
    const perms = Array.isArray(user.permissions) ? user.permissions : [];
    if (perms.includes(permission)) {
      return next();
    }
    return res.status(403).json({
      success: false,
      message: 'You do not have permission to perform this action.'
    });
  };
}

/**
 * Generate JWT token with role and permissions
 */
function generateToken(userOrUsername) {
  const isString = typeof userOrUsername === 'string';
  const payload = isString
    ? {
        id: 0,
        username: userOrUsername,
        fullName: 'Super Admin',
        role: 'super_admin',
        isSuperAdmin: true,
        permissions: [...ALL_PERMISSIONS],
        timestamp: Date.now()
      }
    : {
        id: userOrUsername.id || 0,
        username: userOrUsername.username,
        fullName: userOrUsername.fullName || userOrUsername.username,
        role: userOrUsername.role || 'admin',
        isSuperAdmin: userOrUsername.role === 'super_admin' || userOrUsername.isSuperAdmin === true,
        permissions: Array.isArray(userOrUsername.permissions) ? userOrUsername.permissions : [],
        timestamp: Date.now()
      };

  return jwt.sign(payload, JWT_SECRET, { expiresIn: '6h' });
}

/**
 * Verify Super Admin credentials from .env
 */
function verifyCredentials(username, password) {
  const adminUsername = (process.env.ADMIN_USERNAME || 'admin').trim();
  const adminPassword = (process.env.ADMIN_PASSWORD || 'admin123').trim();
  return String(username || '').trim() === adminUsername && String(password || '') === adminPassword;
}

module.exports = {
  ALL_PERMISSIONS,
  hashPassword,
  verifyPassword,
  verifyToken,
  requirePermission,
  generateToken,
  verifyCredentials
};
