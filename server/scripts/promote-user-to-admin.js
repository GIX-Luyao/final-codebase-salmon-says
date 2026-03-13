/**
 * 把 DynamoDB 里已有用户提成管理员（初始管理员用这个即可）.
 *
 * 用法（在 server/ 下）:
 *   DYNAMO_TABLE_USERS=你的表名 PROMOTE_USERNAME=要提成admin的用户名 AWS_REGION=us-west-2 node scripts/promote-user-to-admin.js
 *
 * 会更新该用户的 isAdmin=true，并把 role 设为 'admin'（若你表里有 role 字段）.
 */
require('dotenv').config();

const tableName = process.env.DYNAMO_TABLE_USERS;
const username = (process.env.PROMOTE_USERNAME || '').trim();
const region = process.env.AWS_REGION || 'us-west-2';

if (!tableName || !username) {
  console.error('用法: DYNAMO_TABLE_USERS=表名 PROMOTE_USERNAME=用户名 AWS_REGION=us-west-2 node scripts/promote-user-to-admin.js');
  process.exit(1);
}

async function run() {
  try {
    const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
    const { DynamoDBDocumentClient, UpdateCommand } = require('@aws-sdk/lib-dynamodb');
    const client = new DynamoDBClient({ region });
    const doc = DynamoDBDocumentClient.from(client);

    const now = new Date().toISOString();
    // 假设表的分区键是 username；若你是 email 或 id，改 Key 和 UpdateExpression 里的字段名
    await doc.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { username },
        UpdateExpression: 'SET isAdmin = :t, #r = :role, updatedAt = :now',
        ExpressionAttributeNames: { '#r': 'role' },
        ExpressionAttributeValues: {
          ':t': true,
          ':role': 'admin',
          ':now': now
        }
      })
    );
    console.log('已提成管理员:', username);
  } catch (e) {
    if (e.code === 'MODULE_NOT_FOUND') {
      console.error('请先安装: npm install @aws-sdk/client-dynamodb @aws-sdk/lib-dynamodb');
      process.exit(1);
    }
    if (e.name === 'ConditionalCheckFailedException' || e.message?.includes('provided key')) {
      console.error('未找到该用户或主键不对，请确认 DYNAMO_TABLE_USERS 和 PROMOTE_USERNAME 正确，且表的主键为 username');
      process.exit(1);
    }
    console.error('DynamoDB 错误:', e.message);
    process.exit(1);
  }
}

run();
