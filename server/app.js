const express = require('express');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config();

const authRouter = require('./routes/auth');
const adminRouter = require('./routes/admin');
const { proxyPaths, proxyHandler } = require('./routes/proxy');
const { authMiddleware } = require('./middleware/auth');

const app = express();

// CORS: run first; allow localhost (any port) so 8888 -> 4000 works
app.use((req, res, next) => {
  let origin = req.headers.origin;
  if (!origin && req.headers.referer) {
    try { origin = new URL(req.headers.referer).origin; } catch (_) {}
  }
  const allow = !origin || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
  const setOrigin = allow ? (origin || 'http://localhost:8888') : 'http://localhost:8888';
  res.setHeader('Access-Control-Allow-Origin', setOrigin);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});
// Allow large payloads for /api/predict (e.g. base64 images)
app.use(express.json({ limit: '50mb' }));

const REMOTE_UPSTREAM = process.env.REMOTE_API_UPSTREAM || '';
const useRemoteBackend = REMOTE_UPSTREAM.length > 0;

// Auth/admin always stays local in this server.
app.use('/api', authRouter);
app.use('/api/admin', adminRouter);

// When using remote backend, proxy prediction/history APIs to REMOTE_UPSTREAM.
if (useRemoteBackend) {
  proxyPaths.forEach((p) => app.use(p, proxyHandler));
} else {
  // Local fallback so history pages still render in auth-only development.
  app.get('/api/history', authMiddleware, (_req, res) => res.json([]));
}

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// Serve the static frontend from the dedicated frontend directory.
const projectRoot = path.join(__dirname, '..');
const defaultFrontendRoot = path.join(projectRoot, 'frontend');
const configuredFrontendRoot = process.env.FRONTEND_ROOT
  ? path.resolve(process.env.FRONTEND_ROOT)
  : defaultFrontendRoot;
const frontendRoot = require('fs').existsSync(path.join(configuredFrontendRoot, 'index.html'))
  ? configuredFrontendRoot
  : defaultFrontendRoot;

app.use(express.static(frontendRoot));
app.get('*', (_req, res) => res.sendFile(path.join(frontendRoot, 'index.html')));

const PORT = process.env.PORT || 4000;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`App + API at http://localhost:${PORT}`);
  });
}

module.exports = app;
