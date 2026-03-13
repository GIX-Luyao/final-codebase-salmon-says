/**
 * User model with DynamoDB persistence when configured, plus in-memory fallback
 * for local development.
 */

const bcrypt = require('bcryptjs');
const {
  hasUserTable,
  normalizeEmail,
  getUserByUsernameFromDynamo,
  getUserByEmailFromDynamo,
  putUserToDynamo,
  updateUserStatusInDynamo,
  deleteUserFromDynamo
} = require('../services/dynamoService');

const usersByUsername = new Map();
const usersByEmail = new Map();

const ADMIN_USERNAME = 'admin';
const ADMIN_PASSWORD_HASH = bcrypt.hashSync('admin123', 10);

const USER_STATUS_PENDING_APPROVAL = 'PENDING_APPROVAL';
const USER_STATUS_ACTIVE = 'ACTIVE';
const USER_STATUS_REJECTED = 'REJECTED';

function normalizeUsername(username) {
  return (username || '').trim();
}

function buildUserRecord({ username, passwordHash, email, role, status, isAdmin, createdAt, updatedAt, approvedAt, rejectedAt }) {
  return {
    username,
    passwordHash,
    password_hash: passwordHash,
    email: normalizeEmail(email),
    role: role === 'biologist' ? 'biologist' : (role === 'admin' ? 'admin' : 'technician'),
    status: status || USER_STATUS_PENDING_APPROVAL,
    isAdmin: !!isAdmin,
    createdAt,
    created_at: createdAt,
    updatedAt,
    approvedAt: approvedAt || undefined,
    rejectedAt: rejectedAt || undefined
  };
}

async function createUser({ username, password, email, role }) {
  const key = normalizeUsername(username);
  if (!key) throw new Error('Username is required');

  const emailKey = normalizeEmail(email);
  if (!emailKey) throw new Error('Email is required');

  const existingByUsername = await getUserByUsername(key);
  if (existingByUsername) {
    throw new Error('Username already exists');
  }

  const existingByEmail = await getUserByEmail(emailKey);
  if (existingByEmail) {
    throw new Error('Email already exists');
  }

  const now = new Date().toISOString();
  const user = buildUserRecord({
    username: key,
    passwordHash: bcrypt.hashSync(password, 10),
    email: emailKey,
    role,
    status: USER_STATUS_PENDING_APPROVAL,
    isAdmin: false,
    createdAt: now,
    updatedAt: now
  });

  if (hasUserTable()) {
    await putUserToDynamo(user, { ifNotExists: true });
    return user;
  }

  usersByUsername.set(key, user);
  usersByEmail.set(emailKey, user);
  return user;
}

async function getUserByUsername(username) {
  const key = normalizeUsername(username);
  if (!key) return null;
  if (hasUserTable()) {
    return await getUserByUsernameFromDynamo(key);
  }
  return usersByUsername.get(key) || null;
}

async function getUserByEmail(email) {
  const key = normalizeEmail(email);
  if (!key) return null;
  if (hasUserTable()) {
    return await getUserByEmailFromDynamo(key);
  }
  return usersByEmail.get(key) || null;
}

async function deleteUser(username) {
  const key = normalizeUsername(username);
  if (!key) return false;
  if (hasUserTable()) {
    return await deleteUserFromDynamo(key);
  }
  const existing = usersByUsername.get(key);
  if (!existing) return false;
  usersByUsername.delete(key);
  if (existing.email) {
    const emailKey = normalizeEmail(existing.email);
    if (usersByEmail.get(emailKey) === existing) {
      usersByEmail.delete(emailKey);
    }
  }
  return true;
}

async function updateUserStatus(username, status) {
  const key = normalizeUsername(username);
  if (!key) return null;
  const now = new Date().toISOString();
  const extra = {};
  if (status === USER_STATUS_ACTIVE) extra.approvedAt = now;
  if (status === USER_STATUS_REJECTED) extra.rejectedAt = now;

  if (hasUserTable()) {
    return await updateUserStatusInDynamo(key, status, extra);
  }

  const user = usersByUsername.get(key);
  if (!user) return null;
  user.status = status;
  user.updatedAt = now;
  if (extra.approvedAt) user.approvedAt = extra.approvedAt;
  if (extra.rejectedAt) user.rejectedAt = extra.rejectedAt;
  return user;
}

function verifyAdmin(username, password) {
  if (normalizeUsername(username) === ADMIN_USERNAME) {
    return bcrypt.compareSync(password, ADMIN_PASSWORD_HASH);
  }
  return false;
}

function isAdminUser(username) {
  return normalizeUsername(username) === ADMIN_USERNAME;
}

function isLoginAllowed(user) {
  const status = user && (user.status || user.statu);
  return !!user && (user.isAdmin || status === USER_STATUS_ACTIVE || status === 'APPROVED');
}

function toPublicUser(user) {
  if (!user) return null;
  return {
    username: user.username,
    email: user.email || '',
    role: user.role,
    status: user.status || user.statu || '',
    isAdmin: !!user.isAdmin
  };
}

function ensureAdminExists() {
  if (hasUserTable()) return;
  if (usersByUsername.has(ADMIN_USERNAME)) return;
  const now = new Date().toISOString();
  const adminUser = buildUserRecord({
    username: ADMIN_USERNAME,
    passwordHash: ADMIN_PASSWORD_HASH,
    email: '',
    role: 'admin',
    status: 'APPROVED',
    isAdmin: true,
    createdAt: now,
    updatedAt: now,
    approvedAt: now
  });
  usersByUsername.set(ADMIN_USERNAME, adminUser);
}

ensureAdminExists();

module.exports = {
  USER_STATUS_PENDING_APPROVAL,
  USER_STATUS_ACTIVE,
  USER_STATUS_REJECTED,
  createUser,
  getUserByUsername,
  getUserByEmail,
  deleteUser,
  updateUserStatus,
  verifyAdmin,
  isAdminUser,
  isLoginAllowed,
  toPublicUser
};
