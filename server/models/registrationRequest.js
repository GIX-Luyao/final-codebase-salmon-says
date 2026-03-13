/**
 * Registration request model with DynamoDB persistence when configured, plus
 * in-memory fallback for local development.
 */

const {
  hasRegistrationRequestTable,
  normalizeEmail,
  listPendingRegistrationRequestsFromDynamo,
  getRegistrationRequestByIdFromDynamo,
  createRegistrationRequestInDynamo,
  updateRegistrationRequestStatusInDynamo,
  findPendingRegistrationByUsernameOrEmailFromDynamo,
  buildRegistrationRequestId
} = require('../services/dynamoService');

let nextId = 1;
const registrationRequests = [];
const byId = new Map();

function normalizeUsername(username) {
  return (username || '').trim();
}

function buildRequestRecord({ id, username, email, role, reason, status, createdAt, updatedAt, reviewedAt, reviewedBy }) {
  return {
    id,
    username: normalizeUsername(username),
    email: normalizeEmail(email),
    role: role === 'biologist' ? 'biologist' : 'technician',
    reason: reason || '',
    status: status || 'PENDING',
    createdAt,
    updatedAt,
    reviewedAt: reviewedAt || undefined,
    reviewedBy: reviewedBy || undefined
  };
}

async function createRegistrationRequest({ username, email, role, reason }) {
  const now = new Date().toISOString();
  const request = buildRequestRecord({
    id: hasRegistrationRequestTable() ? buildRegistrationRequestId() : String(nextId++),
    username,
    email,
    role,
    reason,
    status: 'PENDING',
    createdAt: now,
    updatedAt: now
  });

  if (hasRegistrationRequestTable()) {
    await createRegistrationRequestInDynamo(request);
    return request;
  }

  registrationRequests.push(request);
  byId.set(request.id, request);
  return request;
}

async function getById(id) {
  const key = (id || '').trim();
  if (!key) return null;
  if (hasRegistrationRequestTable()) {
    return await getRegistrationRequestByIdFromDynamo(key);
  }
  return byId.get(key) || null;
}

async function getAllPending() {
  if (hasRegistrationRequestTable()) {
    return await listPendingRegistrationRequestsFromDynamo();
  }
  return registrationRequests.filter((r) => r.status === 'PENDING');
}

async function setStatus(id, status, extraUpdates = {}) {
  const key = (id || '').trim();
  if (!key) return null;
  const now = new Date().toISOString();

  if (hasRegistrationRequestTable()) {
    return await updateRegistrationRequestStatusInDynamo(key, status, extraUpdates);
  }

  const req = byId.get(key);
  if (!req) return null;
  req.status = status;
  req.updatedAt = now;
  Object.assign(req, extraUpdates);
  return req;
}

async function findPendingByUsernameOrEmail(username, email) {
  const usernameKey = normalizeUsername(username);
  const emailKey = normalizeEmail(email);

  if (hasRegistrationRequestTable()) {
    return await findPendingRegistrationByUsernameOrEmailFromDynamo(usernameKey, emailKey);
  }

  return registrationRequests.find((r) =>
    r.status === 'PENDING' &&
    (r.username === usernameKey || (emailKey && r.email === emailKey))
  ) || null;
}

module.exports = {
  createRegistrationRequest,
  getById,
  getAllPending,
  setStatus,
  findPendingByUsernameOrEmail
};
