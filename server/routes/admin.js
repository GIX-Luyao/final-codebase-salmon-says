const express = require('express');
const { authMiddleware, requireAdmin } = require('../middleware/auth');
const { getAllPending, getById, setStatus } = require('../models/registrationRequest');
const { getUserByUsername, updateUserStatus, deleteUser, USER_STATUS_ACTIVE, USER_STATUS_REJECTED } = require('../models/user');

const router = express.Router();

router.use(authMiddleware);
router.use(requireAdmin);

/**
 * GET /api/admin/requests
 * List all PENDING registration requests (admin only).
 */
router.get('/requests', async (_req, res) => {
  try {
    const list = await getAllPending();
    return res.json({ success: true, requests: list });
  } catch (err) {
    console.error('Error in /api/admin/requests:', err);
    return res.status(500).json({ success: false, error: 'Failed to load requests.' });
  }
});

/**
 * POST /api/admin/approve/:id
 * Approve a registration request: set user status to APPROVED, optionally write to DynamoDB (admin only).
 */
router.post('/approve/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const reg = await getById(id);
    if (!reg) {
      return res.status(404).json({ success: false, error: 'Request not found.' });
    }
    if (reg.status !== 'PENDING') {
      return res.status(400).json({ success: false, error: 'Request already processed.' });
    }

    const user = await getUserByUsername(reg.username);
    if (!user) {
      return res.status(400).json({ success: false, error: 'User not found.' });
    }

    await setStatus(id, 'APPROVED', {
      reviewedAt: new Date().toISOString(),
      reviewedBy: req.user.username || 'admin'
    });
    await updateUserStatus(reg.username, USER_STATUS_ACTIVE);

    const approvedUser = await getUserByUsername(reg.username);

    return res.json({
      success: true,
      message: 'User approved.',
      user: { username: approvedUser.username, email: approvedUser.email, role: approvedUser.role }
    });
  } catch (err) {
    console.error('Error in /api/admin/approve:', err);
    return res.status(500).json({ success: false, error: 'Approve failed.' });
  }
});

/**
 * POST /api/admin/reject/:id
 * Reject a registration request: mark request as REJECTED and remove the associated user
 * so that it behaves like the account was never created.
 */
router.post('/reject/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const reg = await getById(id);
    if (!reg) {
      return res.status(404).json({ success: false, error: 'Request not found.' });
    }
    if (reg.status !== 'PENDING') {
      return res.status(400).json({ success: false, error: 'Request already processed.' });
    }

    await setStatus(id, 'REJECTED', {
      reviewedAt: new Date().toISOString(),
      reviewedBy: req.user.username || 'admin'
    });
    if (reg.username) {
      await updateUserStatus(reg.username, USER_STATUS_REJECTED);
      await deleteUser(reg.username);
    }

    return res.json({
      success: true,
      message: 'Request rejected.'
    });
  } catch (err) {
    console.error('Error in /api/admin/reject:', err);
    return res.status(500).json({ success: false, error: 'Reject failed.' });
  }
});

module.exports = router;
