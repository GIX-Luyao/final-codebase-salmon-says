/**
 * One-time script: write admin user into DynamoDB so the real backend (35.163.47.188) can accept admin login.
 *
 * Prerequisites:
 * 1. Know the DynamoDB table name and partition key used by your backend (e.g. "Users", PK = username).
 * 2. AWS credentials: export AWS_PROFILE / AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY, or run on EC2 with IAM role.
 * 3. npm install @aws-sdk/client-dynamodb @aws-sdk/lib-dynamodb (if not already).
 *
 * Usage (from server/):
 *   DYNAMO_TABLE_USERS=YourTableName AWS_REGION=us-west-2 node scripts/seed-admin-to-dynamodb.js
 *
 * Optional env:
 *   ADMIN_USERNAME=admin   (default admin)
 *   ADMIN_PASSWORD=admin123
 *   ADMIN_EMAIL=admin@example.com
 */
require('dotenv').config();
const bcrypt = require('bcryptjs');

const tableName = process.env.DYNAMO_TABLE_USERS;
const region = process.env.AWS_REGION || 'us-west-2';
const username = (process.env.ADMIN_USERNAME || 'admin').trim();
const password = process.env.ADMIN_PASSWORD || 'admin123';
const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();

if (!tableName) {
  console.error('Set DYNAMO_TABLE_USERS (DynamoDB table name used by your backend).');
  process.exit(1);
}

const passwordHash = bcrypt.hashSync(password, 10);

// Item shape: match what your backend on 35.163.188 expects when reading users.
// Common: partition key = username (string). Adjust if your table uses email/id or different attribute names.
const item = {
  username,
  passwordHash,
  password_hash: passwordHash,
  email: email || `admin@local`,
  role: 'admin',
  status: 'APPROVED',
  isAdmin: true,
  created_at: new Date().toISOString(),
  updatedAt: new Date().toISOString()
};

async function run() {
  try {
    const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
    const { DynamoDBDocumentClient, PutCommand } = require('@aws-sdk/lib-dynamodb');
    const client = new DynamoDBClient({ region });
    const doc = DynamoDBDocumentClient.from(client);
    await doc.send(new PutCommand({ TableName: tableName, Item: item }));
    console.log('Admin user written to DynamoDB:', username, 'Table:', tableName);
  } catch (e) {
    if (e.code === 'MODULE_NOT_FOUND') {
      console.error('Install: npm install @aws-sdk/client-dynamodb @aws-sdk/lib-dynamodb');
      process.exit(1);
    }
    console.error('DynamoDB error:', e.message);
    process.exit(1);
  }
}

run();
