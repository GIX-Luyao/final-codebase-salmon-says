/**
 * DynamoDB helpers for server-side auth and registration approval flows.
 *
 * Tables:
 * - DYNAMO_TABLE_USERS: partition key `username` (string)
 * - DYNAMO_TABLE_REGISTRATION_REQUESTS: partition key `id` (string)
 *
 * When the env vars or AWS SDK are unavailable, callers should fall back to
 * in-memory models for local development.
 */

const crypto = require('crypto');

const AWS_REGION = process.env.AWS_REGION || 'us-west-2';
const USERS_TABLE = process.env.DYNAMO_TABLE_USERS || '';
const REGISTRATION_REQUESTS_TABLE = process.env.DYNAMO_TABLE_REGISTRATION_REQUESTS || '';

let docClientPromise = null;

function hasUserTable() {
  return USERS_TABLE.length > 0;
}

function hasRegistrationRequestTable() {
  return REGISTRATION_REQUESTS_TABLE.length > 0;
}

function normalizeEmail(email) {
  return (email || '').trim().toLowerCase();
}

async function getDocClient() {
  if (!docClientPromise) {
    docClientPromise = (async () => {
      const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
      const { DynamoDBDocumentClient } = require('@aws-sdk/lib-dynamodb');
      const client = new DynamoDBClient({ region: AWS_REGION });
      return DynamoDBDocumentClient.from(client, {
        marshallOptions: {
          removeUndefinedValues: true
        }
      });
    })();
  }
  return docClientPromise;
}

async function getUserByUsernameFromDynamo(username) {
  if (!hasUserTable()) return null;
  const key = (username || '').trim();
  if (!key) return null;
  const { GetCommand } = require('@aws-sdk/lib-dynamodb');
  const doc = await getDocClient();
  const resp = await doc.send(new GetCommand({
    TableName: USERS_TABLE,
    Key: { username: key },
    ConsistentRead: true
  }));
  return resp.Item || null;
}

async function getUserByEmailFromDynamo(email) {
  if (!hasUserTable()) return null;
  const emailKey = normalizeEmail(email);
  if (!emailKey) return null;
  const { ScanCommand } = require('@aws-sdk/lib-dynamodb');
  const doc = await getDocClient();
  const resp = await doc.send(new ScanCommand({
    TableName: USERS_TABLE,
    FilterExpression: 'email = :email',
    ExpressionAttributeValues: {
      ':email': emailKey
    },
    Limit: 1
  }));
  return (resp.Items && resp.Items[0]) || null;
}

async function putUserToDynamo(user, options = {}) {
  if (!hasUserTable()) return null;
  const { PutCommand } = require('@aws-sdk/lib-dynamodb');
  const doc = await getDocClient();
  const normalizedUser = { ...user };
  if (normalizedUser.passwordHash && !normalizedUser.password_hash) {
    normalizedUser.password_hash = normalizedUser.passwordHash;
  }
  if (normalizedUser.createdAt && !normalizedUser.created_at) {
    normalizedUser.created_at = normalizedUser.createdAt;
  }
  const params = {
    TableName: USERS_TABLE,
    Item: normalizedUser
  };
  if (options.ifNotExists) {
    params.ConditionExpression = 'attribute_not_exists(username)';
  }
  await doc.send(new PutCommand(params));
  return user;
}

async function updateUserStatusInDynamo(username, status, extraUpdates = {}) {
  if (!hasUserTable()) return null;
  const key = (username || '').trim();
  if (!key) return null;
  const { UpdateCommand } = require('@aws-sdk/lib-dynamodb');
  const doc = await getDocClient();
  const now = new Date().toISOString();

  const names = {};
  const values = {
    ':status': status,
    ':updatedAt': now
  };
  const updates = ['#status = :status', 'updatedAt = :updatedAt'];

  Object.entries(extraUpdates).forEach(([field, value], index) => {
    const nameKey = `#f${index}`;
    const valueKey = `:v${index}`;
    names[nameKey] = field;
    values[valueKey] = value;
    updates.push(`${nameKey} = ${valueKey}`);
  });

  const resp = await doc.send(new UpdateCommand({
    TableName: USERS_TABLE,
    Key: { username: key },
    UpdateExpression: `SET ${updates.join(', ')}`,
    ExpressionAttributeNames: {
      '#status': 'status',
      ...names
    },
    ExpressionAttributeValues: values,
    ReturnValues: 'ALL_NEW'
  }));
  return resp.Attributes || null;
}

async function deleteUserFromDynamo(username) {
  if (!hasUserTable()) return false;
  const key = (username || '').trim();
  if (!key) return false;
  const { DeleteCommand } = require('@aws-sdk/lib-dynamodb');
  const doc = await getDocClient();
  await doc.send(new DeleteCommand({
    TableName: USERS_TABLE,
    Key: { username: key }
  }));
  return true;
}

async function listPendingRegistrationRequestsFromDynamo() {
  if (!hasRegistrationRequestTable()) return [];
  const { ScanCommand } = require('@aws-sdk/lib-dynamodb');
  const doc = await getDocClient();
  const resp = await doc.send(new ScanCommand({
    TableName: REGISTRATION_REQUESTS_TABLE,
    FilterExpression: '#status = :status',
    ExpressionAttributeNames: {
      '#status': 'status'
    },
    ExpressionAttributeValues: {
      ':status': 'PENDING'
    }
  }));
  return (resp.Items || []).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

async function getRegistrationRequestByIdFromDynamo(id) {
  if (!hasRegistrationRequestTable()) return null;
  const key = (id || '').trim();
  if (!key) return null;
  const { GetCommand } = require('@aws-sdk/lib-dynamodb');
  const doc = await getDocClient();
  const resp = await doc.send(new GetCommand({
    TableName: REGISTRATION_REQUESTS_TABLE,
    Key: { id: key },
    ConsistentRead: true
  }));
  return resp.Item || null;
}

async function createRegistrationRequestInDynamo(request) {
  if (!hasRegistrationRequestTable()) return null;
  const { PutCommand } = require('@aws-sdk/lib-dynamodb');
  const doc = await getDocClient();
  await doc.send(new PutCommand({
    TableName: REGISTRATION_REQUESTS_TABLE,
    Item: request,
    ConditionExpression: 'attribute_not_exists(id)'
  }));
  return request;
}

async function updateRegistrationRequestStatusInDynamo(id, status, extraUpdates = {}) {
  if (!hasRegistrationRequestTable()) return null;
  const key = (id || '').trim();
  if (!key) return null;
  const { UpdateCommand } = require('@aws-sdk/lib-dynamodb');
  const doc = await getDocClient();
  const now = new Date().toISOString();
  const names = {};
  const values = {
    ':status': status,
    ':updatedAt': now
  };
  const updates = ['#status = :status', 'updatedAt = :updatedAt'];

  Object.entries(extraUpdates).forEach(([field, value], index) => {
    const nameKey = `#f${index}`;
    const valueKey = `:v${index}`;
    names[nameKey] = field;
    values[valueKey] = value;
    updates.push(`${nameKey} = ${valueKey}`);
  });

  const resp = await doc.send(new UpdateCommand({
    TableName: REGISTRATION_REQUESTS_TABLE,
    Key: { id: key },
    UpdateExpression: `SET ${updates.join(', ')}`,
    ExpressionAttributeNames: {
      '#status': 'status',
      ...names
    },
    ExpressionAttributeValues: values,
    ReturnValues: 'ALL_NEW'
  }));
  return resp.Attributes || null;
}

async function findPendingRegistrationByUsernameOrEmailFromDynamo(username, email) {
  if (!hasRegistrationRequestTable()) return null;
  const usernameKey = (username || '').trim();
  const emailKey = normalizeEmail(email);
  if (!usernameKey && !emailKey) return null;
  const { ScanCommand } = require('@aws-sdk/lib-dynamodb');
  const doc = await getDocClient();

  let filterExpression = '#status = :status';
  const values = { ':status': 'PENDING' };
  const names = { '#status': 'status' };

  if (usernameKey && emailKey) {
    filterExpression += ' AND (username = :username OR email = :email)';
    values[':username'] = usernameKey;
    values[':email'] = emailKey;
  } else if (usernameKey) {
    filterExpression += ' AND username = :username';
    values[':username'] = usernameKey;
  } else {
    filterExpression += ' AND email = :email';
    values[':email'] = emailKey;
  }

  const resp = await doc.send(new ScanCommand({
    TableName: REGISTRATION_REQUESTS_TABLE,
    FilterExpression: filterExpression,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
    Limit: 1
  }));
  return (resp.Items && resp.Items[0]) || null;
}

function buildRegistrationRequestId() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function writeUserToDynamoDB(user) {
  if (!user || !hasUserTable()) return;
  await putUserToDynamo(user);
}

module.exports = {
  hasUserTable,
  hasRegistrationRequestTable,
  normalizeEmail,
  getUserByUsernameFromDynamo,
  getUserByEmailFromDynamo,
  putUserToDynamo,
  updateUserStatusInDynamo,
  deleteUserFromDynamo,
  listPendingRegistrationRequestsFromDynamo,
  getRegistrationRequestByIdFromDynamo,
  createRegistrationRequestInDynamo,
  updateRegistrationRequestStatusInDynamo,
  findPendingRegistrationByUsernameOrEmailFromDynamo,
  buildRegistrationRequestId,
  writeUserToDynamoDB
};
