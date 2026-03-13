const express = require('express');

const { upsertUserByEmail } = require('../models/user');
const { createRegistrationRequest } = require('../models/registrationRequest');
const { sendAdminNotificationEmail } = require('../services/emailService');

const router = express.Router();

/**
 * POST /register-request
 *
 * Body:
 * {
 *   "email": string,
 *   "name": string,
 *   "reason": string
 * }
 */
router.post('/register-request', async (req, res) => {
  const { email, name, reason } = req.body || {};

  if (!email || !name || !reason) {
    return res.status(400).json({
      error: 'email, name, and reason are required.'
    });
  }

  try {
    // Upsert user by email and set status to PENDING
    upsertUserByEmail({ email, name });

    // Create a new registration request with status PENDING
    const registrationRequest = createRegistrationRequest({ email, name, reason });

    // Fire-and-forget email notification. If it fails, we still return success for the request.
    try {
      await sendAdminNotificationEmail(registrationRequest);
    } catch (emailErr) {
      console.error('Failed to send admin notification email:', emailErr);
    }

    return res.json({
      message: 'Registration request submitted. Awaiting approval.'
    });
  } catch (err) {
    console.error('Error handling /register-request:', err);
    return res.status(500).json({
      error: 'Internal server error'
    });
  }
});

module.exports = router;

