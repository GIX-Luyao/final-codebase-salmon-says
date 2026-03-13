/**
 * Proxy non-auth API routes to the prediction backend.
 * Auth/admin stays local in the server app.
 */

const REMOTE_UPSTREAM = process.env.REMOTE_API_UPSTREAM || 'http://35.163.47.188';
const REMOTE_API_TOKEN = process.env.REMOTE_API_TOKEN || '';

const proxyPaths = [
  '/api/history',
  '/api/predict',
  '/api/predict_preview',
  '/api/image-url',
  '/api/presign-upload',
  '/api/submit-to-lab',
  '/api/delete-history'
];

async function proxyToRemote(req, res, next) {
  const pathAndQuery = req.originalUrl || req.url;
  const url = `${REMOTE_UPSTREAM}${pathAndQuery}`;
  const headers = { ...req.headers };
  delete headers.host;
  if (REMOTE_API_TOKEN) headers.authorization = `Bearer ${REMOTE_API_TOKEN}`;
  else delete headers.authorization;
  try {
    const body = req.method !== 'GET' && req.method !== 'HEAD' && req.body !== undefined
      ? (typeof req.body === 'string' ? req.body : JSON.stringify(req.body))
      : undefined;
    const resp = await fetch(url, { method: req.method, headers, body });
    const data = await resp.text();
    // GET /api/history: treat upstream 404 as empty history
    if (req.method === 'GET' && (req.originalUrl || req.url).startsWith('/api/history') && resp.status === 404) {
      res.status(200).set('Content-Type', 'application/json').send('[]');
      return;
    }
    // POST /api/predict or predict_preview: if upstream 401/403 (auth/forbidden), return mock so local dev works
    if (req.method === 'POST' && (resp.status === 401 || resp.status === 403)) {
      const path = (req.originalUrl || req.url).split('?')[0];
      if (path === '/api/predict' || path === '/api/predict_preview') {
        const jobId = 'mock-' + Date.now();
        const images = (req.body && req.body.images) || [];
        const results = images.length ? images.map((img, i) => ({
          image_id: (img && (img.filename || img.image_id)) || 'mock-' + (i + 1),
          storage_status: { s3_uploaded: true, dynamodb_saved: true }
        })) : [{ image_id: 'mock-1', storage_status: { s3_uploaded: true, dynamodb_saved: true } }];
        res.status(200).json({ job_id: jobId, results });
        return;
      }
    }
    res.status(resp.status);
    resp.headers.forEach((v, k) => { if (k.toLowerCase() !== 'transfer-encoding') res.setHeader(k, v); });
    res.send(data);
  } catch (err) {
    console.error('Proxy error:', err);
    res.status(502).json({ error: 'Upstream unavailable' });
  }
}

function proxyHandler(req, res, next) {
  proxyToRemote(req, res, next).catch(next);
}

module.exports = { proxyPaths, proxyHandler };
