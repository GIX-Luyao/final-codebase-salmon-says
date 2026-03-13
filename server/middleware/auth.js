const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  throw new Error('JWT_SECRET is required');
}

function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (_) {
    return null;
  }
}

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Unauthorized', success: false });
  }

  const payload = verifyToken(token);
  if (!payload || !payload.username) {
    return res.status(401).json({ error: 'Invalid token', success: false });
  }

  req.user = payload;
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user || !req.user.isAdmin) {
    return res.status(403).json({ error: 'Admin only', success: false });
  }
  next();
}

module.exports = {
  signToken,
  verifyToken,
  authMiddleware,
  requireAdmin,
  JWT_SECRET
};
