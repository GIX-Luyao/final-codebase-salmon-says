# 把 Admin 账号写入 DynamoDB

让 35.163.47.188 后端能识别 admin 登录，需要把 admin 用户写进**它用的那个** DynamoDB 用户表。

## 1. 确认表名和结构

- 登录 **AWS Console → DynamoDB**，找到存用户的那张表（名字可能是 `Users`、`users`、`SalmonUsers` 等）。
- 记下：**表名**、**分区键**（Partition key，一般是 `username` 或 `email`）。
- 若后端读用户时有固定字段（如 `passwordHash`、`role`、`isAdmin`、`status`），记下字段名；脚本里默认用的是 `username`, `passwordHash`, `email`, `role`, `status`, `isAdmin`, `updatedAt`，若不一致需要改 `scripts/seed-admin-to-dynamodb.js` 里的 `item`。

## 2. 本机配置 AWS 凭证

任选一种：

- **AWS CLI 已登录**：`aws configure` 或 `aws sso login` 后即可。
- **环境变量**：`export AWS_ACCESS_KEY_ID=...`、`AWS_SECRET_ACCESS_KEY=...`、`AWS_REGION=us-west-2`（或你表所在 region）。

## 3. 安装依赖并执行脚本

在 **server/** 目录下：

```bash
cd server
npm install
DYNAMO_TABLE_USERS=你的表名 AWS_REGION=us-west-2 npm run seed-admin
```

或直接：

```bash
DYNAMO_TABLE_USERS=你的表名 AWS_REGION=us-west-2 node scripts/seed-admin-to-dynamodb.js
```

可选环境变量：`ADMIN_USERNAME=admin`、`ADMIN_PASSWORD=admin123`、`ADMIN_EMAIL=admin@example.com`（不设则用默认 admin / admin123）。

## 4. 若表结构不一致

若后端用的字段名或分区键不同，编辑 `server/scripts/seed-admin-to-dynamodb.js` 里的 `item`，使其与表中已有用户项格式一致（尤其是分区键名和类型）。保存后再执行一次上面的命令。

完成后用 admin / admin123 在 35.163.47.188 上登录即可。
