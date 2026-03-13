const express = require('express');
const bcrypt = require('bcryptjs');
const {
  createUser,
  getUserByUsername,
  getUserByEmail,
  verifyAdmin,
  isLoginAllowed,
  USER_STATUS_PENDING_APPROVAL,
  toPublicUser
} = require('../models/user');
const { createRegistrationRequest, findPendingByUsernameOrEmail } = require('../models/registrationRequest');
const { signToken, authMiddleware } = require('../middleware/auth');
const { sendAdminNotificationEmail } = require('../services/emailService');

const router = express.Router();

const handleRegister = async (req, res) => {
  const { email, username, password, role, reason } = req.body || {};

  if (!email || !username || !password) {
    return res.status(400).json({
      success: false,
      error: 'Email, username, and password are required.'
    });
  }

  const un = (username || '').trim();
  if (un.length < 2) {
    return res.status(400).json({ success: false, error: 'Username must be at least 2 characters.' });
  }

  if ((password || '').length < 4) {
    return res.status(400).json({ success: false, error: 'Password must be at least 4 characters.' });
  }

  try {
    // Prevent duplicate pending requests by username/email
    const emailKey = (email || '').trim().toLowerCase();
    const existingPending = await findPendingByUsernameOrEmail(un, emailKey);
    if (existingPending) {
      return res.status(400).json({
        success: false,
        error: 'An account with this username or email is already pending approval.'
      });
    }

    const existingUserByUsername = await getUserByUsername(un);
    if (existingUserByUsername) {
      return res.status(400).json({ success: false, error: 'Username already exists' });
    }

    const existingUserByEmail = await getUserByEmail(emailKey);
    if (existingUserByEmail) {
      return res.status(400).json({ success: false, error: 'Email already exists' });
    }

    const user = createUser({ username: un, password, email, role });
    const createdUser = await user;
    const registrationRequest = await createRegistrationRequest({
      username: un,
      email: createdUser.email,
      role: createdUser.role,
      reason: (reason || '').trim() || `Signup request for ${createdUser.role}`
    });

    try {
      await sendAdminNotificationEmail({
        id: registrationRequest.id,
        email: createdUser.email,
        name: un,
        reason: registrationRequest.reason,
        createdAt: registrationRequest.createdAt
      });
    } catch (emailErr) {
      console.error('Failed to send admin notification email:', emailErr);
    }

    return res.status(201).json({
      success: true,
      message: 'Registration submitted. Awaiting admin approval.'
    });
  } catch (err) {
    if (err.message === 'Username already exists' || err.message === 'Email already exists') {
      return res.status(400).json({ success: false, error: err.message });
    }
    console.error('Error in register:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

/** POST /api/register - same as signup */
router.post('/register', handleRegister);
/** POST /api/signup - alias for frontend */
router.post('/signup', handleRegister);

/**
 * POST /api/login
 * Body: { username, password }
 * Admin: always allowed. Regular user: only if status === 'APPROVED'.
 */
router.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  const un = (username || '').trim();

  if (!un || !password) {
    return res.status(400).json({
      success: false,
      error: 'Username and password are required.'
    });
  }

  try {
    // Admin login
    if (verifyAdmin(un, password)) {
      const token = signToken({
        username: 'admin',
        role: 'admin',
        isAdmin: true
      });
      return res.json({
        success: true,
        token,
        user: { username: 'admin', role: 'admin', isAdmin: true }
      });
    }

    // Regular user: must exist and be APPROVED
    const user = await getUserByUsername(un);
    if (!user) {
      return res.status(401).json({ success: false, error: 'Invalid username or password.' });
    }

    const passwordHash = user.passwordHash || user.password_hash || '';
    const valid = passwordHash ? bcrypt.compareSync(password, passwordHash) : false;
    if (!valid) {
      return res.status(401).json({ success: false, error: 'Invalid username or password.' });
    }

    if (!isLoginAllowed(user)) {
      const status = user.status || user.statu || USER_STATUS_PENDING_APPROVAL;
      if (status === USER_STATUS_PENDING_APPROVAL || status === 'PENDING') {
        return res.status(403).json({
          success: false,
          error: 'Your account is pending approval. Please wait for an administrator to approve your registration.'
        });
      }
      return res.status(403).json({
        success: false,
        error: 'Your account is not active. Please contact an administrator.'
      });
    }

    const token = signToken({
      username: user.username,
      role: user.role,
      isAdmin: false
    });

    return res.json({
      success: true,
      token,
      user: toPublicUser(user)
    });
  } catch (err) {
    console.error('Error in /api/login:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * GET /api/me
 * Requires Bearer token. Returns current user info.
 */
router.get('/me', authMiddleware, (req, res) => {
  const payload = req.user;
  Promise.resolve(getUserByUsername(payload.username))
    .then((user) => {
      if (!user) {
        return res.json({ success: true, user: { username: payload.username, role: payload.role, isAdmin: payload.isAdmin } });
      }
      return res.json({ success: true, user: toPublicUser(user) });
    })
    .catch((err) => {
      console.error('Error in /api/me:', err);
      return res.status(500).json({ success: false, error: 'Internal server error' });
    });
});

/** POST /api/logout - client clears token; server just acknowledges */
router.post('/logout', (req, res) => {
  res.json({ success: true });
});

module.exports = router;
