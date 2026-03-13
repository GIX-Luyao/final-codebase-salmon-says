/**
 * 给 DynamoDB 里某用户设置新密码（用 bcrypt 写 passwordHash），解决 401 时先试已知密码.
 *
 * 用法（在 server/ 下）:
 *   SET_PASSWORD_USERNAME=bio1 SET_PASSWORD_NEW=你的新密码 node scripts/set-password-in-dynamodb.js
 *
 * 需要 DYNAMO_TABLE_USERS、AWS_REGION（或 .env）.
 */
require('dotenv').config();
const bcrypt = require('bcryptjs');

const tableName = process.env.DYNAMO_TABLE_USERS;
const username = (process.env.SET_PASSWORD_USERNAME || '').trim();
const newPassword = process.env.SET_PASSWORD_NEW || '';
const region = process.env.AWS_REGION || 'us-west-2';

if (!tableName || !username || !newPassword) {
  console.error('用法: SET_PASSWORD_USERNAME=用户名 SET_PASSWORD_NEW=新密码 [DYNAMO_TABLE_USERS=表名] [AWS_REGION=us-west-2] node scripts/set-password-in-dynamodb.js');
  process.exit(1);
}

const passwordHash = bcrypt.hashSync(newPassword, 10);

async function run() {
  try {
    const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
    const { DynamoDBDocumentClient, UpdateCommand } = require('@aws-sdk/lib-dynamodb');
    const client = new DynamoDBClient({ region });
    const doc = DynamoDBDocumentClient.from(client);

    const now = new Date().toISOString();
    await doc.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { username },
        UpdateExpression: 'SET passwordHash = :ph, updatedAt = :now',
        ExpressionAttributeValues: {
          ':ph': passwordHash,
          ':now': now
        }
      })
    );
    console.log('已更新密码:', username, '(请用新密码登录)');
  } catch (e) {
    if (e.code === 'MODULE_NOT_FOUND') {
      console.error('请先安装: npm install @aws-sdk/client-dynamodb @aws-sdk/lib-dynamodb');
      process.exit(1);
    }
    if (e.name === 'ConditionalCheckFailedException' || e.message?.includes('provided key')) {
      console.error('未找到该用户或主键不对，请确认 DYNAMO_TABLE_USERS 和 SET_PASSWORD_USERNAME 正确，且表的主键为 username');
      process.exit(1);
    }
    console.error('DynamoDB 错误:', e.message);
    process.exit(1);
  }
}

run();
