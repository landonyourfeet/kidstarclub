// lib/bucket.js — zero-dependency S3 SigV4 client for Railway Bucket (Tigris).
// Same pattern as Connect's blob migration. Env: BUCKET_NAME, AWS_ACCESS_KEY_ID,
// AWS_SECRET_ACCESS_KEY, AWS_ENDPOINT_URL_S3 (default https://fly.storage.tigris.dev)

const crypto = require('crypto');
const https = require('https');

const ENDPOINT = (process.env.AWS_ENDPOINT_URL_S3 || 'https://fly.storage.tigris.dev').replace(/\/$/, '');
const REGION = process.env.AWS_REGION || 'auto';
const BUCKET = process.env.BUCKET_NAME;

const hmac = (key, msg) => crypto.createHmac('sha256', key).update(msg).digest();
const sha256hex = (msg) => crypto.createHash('sha256').update(msg).digest('hex');

function signV4({ method, key, headers, payloadHash, query = '' }) {
  const host = new URL(ENDPOINT).host;
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const canonicalUri = `/${BUCKET}/${key.split('/').map(encodeURIComponent).join('/')}`;
  const allHeaders = { host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate, ...headers };
  const sortedNames = Object.keys(allHeaders).map(h => h.toLowerCase()).sort();
  const canonicalHeaders = sortedNames.map(h => `${h}:${String(allHeaders[Object.keys(allHeaders).find(k => k.toLowerCase() === h)]).trim()}\n`).join('');
  const signedHeaders = sortedNames.join(';');
  const canonicalRequest = [method, canonicalUri, query, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${dateStamp}/${REGION}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');
  let k = hmac(`AWS4${process.env.AWS_SECRET_ACCESS_KEY}`, dateStamp);
  k = hmac(k, REGION); k = hmac(k, 's3'); k = hmac(k, 'aws4_request');
  const signature = crypto.createHmac('sha256', k).update(stringToSign).digest('hex');
  return {
    url: `${ENDPOINT}${canonicalUri}${query ? '?' + query : ''}`,
    headers: {
      ...allHeaders,
      Authorization: `AWS4-HMAC-SHA256 Credential=${process.env.AWS_ACCESS_KEY_ID}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
    }
  };
}

function request(method, key, { body = null, headers = {}, query = '' } = {}) {
  const payloadHash = body ? sha256hex(body) : sha256hex('');
  const signed = signV4({ method, key, headers, payloadHash, query });
  return new Promise((resolve, reject) => {
    const u = new URL(signed.url);
    const req = https.request({ method, hostname: u.hostname, path: u.pathname + u.search, headers: signed.headers }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (res.statusCode >= 200 && res.statusCode < 300) resolve({ status: res.statusCode, body: buf, headers: res.headers });
        else reject(new Error(`Bucket ${method} ${key} -> ${res.statusCode}: ${buf.toString().slice(0, 300)}`));
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

module.exports = {
  put: (key, buf, contentType) => request('PUT', key, { body: buf, headers: { 'content-type': contentType, 'content-length': buf.length } }),
  get: (key) => request('GET', key),
  del: (key) => request('DELETE', key),
  // Presigned GET so <video> tags can stream directly without proxying through Node.
  presignGet(key, expiresSec = 3600) {
    const host = new URL(ENDPOINT).host;
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);
    const scope = `${dateStamp}/${REGION}/s3/aws4_request`;
    const canonicalUri = `/${BUCKET}/${key.split('/').map(encodeURIComponent).join('/')}`;
    const q = new URLSearchParams({
      'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
      'X-Amz-Credential': `${process.env.AWS_ACCESS_KEY_ID}/${scope}`,
      'X-Amz-Date': amzDate,
      'X-Amz-Expires': String(expiresSec),
      'X-Amz-SignedHeaders': 'host'
    });
    const query = [...q.entries()].map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).sort().join('&');
    const canonicalRequest = ['GET', canonicalUri, query, `host:${host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');
    let k = hmac(`AWS4${process.env.AWS_SECRET_ACCESS_KEY}`, dateStamp);
    k = hmac(k, REGION); k = hmac(k, 's3'); k = hmac(k, 'aws4_request');
    const signature = crypto.createHmac('sha256', k).update(stringToSign).digest('hex');
    return `${ENDPOINT}${canonicalUri}?${query}&X-Amz-Signature=${signature}`;
  },
  // Presigned PUT so browsers upload directly to the bucket (no server memory, 5GB single-PUT ceiling).
  presignPut(key, expiresSec = 7200) {
    const host = new URL(ENDPOINT).host;
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);
    const scope = `${dateStamp}/${REGION}/s3/aws4_request`;
    const canonicalUri = `/${BUCKET}/${key.split('/').map(encodeURIComponent).join('/')}`;
    const q = new URLSearchParams({
      'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
      'X-Amz-Credential': `${process.env.AWS_ACCESS_KEY_ID}/${scope}`,
      'X-Amz-Date': amzDate,
      'X-Amz-Expires': String(expiresSec),
      'X-Amz-SignedHeaders': 'host'
    });
    const query = [...q.entries()].map(([k2, v]) => `${encodeURIComponent(k2)}=${encodeURIComponent(v)}`).sort().join('&');
    const canonicalRequest = ['PUT', canonicalUri, query, `host:${host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');
    let k = hmac(`AWS4${process.env.AWS_SECRET_ACCESS_KEY}`, dateStamp);
    k = hmac(k, REGION); k = hmac(k, 's3'); k = hmac(k, 'aws4_request');
    const signature = crypto.createHmac('sha256', k).update(stringToSign).digest('hex');
    return `${ENDPOINT}${canonicalUri}?${query}&X-Amz-Signature=${signature}`;
  },
  // Boot-time CORS so browsers may PUT directly. Safe to run every boot.
  async setCors(origins = ['*']) {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<CORSConfiguration><CORSRule>
${origins.map(o => `<AllowedOrigin>${o}</AllowedOrigin>`).join('')}
<AllowedMethod>PUT</AllowedMethod><AllowedMethod>GET</AllowedMethod><AllowedMethod>HEAD</AllowedMethod>
<AllowedHeader>*</AllowedHeader><MaxAgeSeconds>3600</MaxAgeSeconds>
</CORSRule></CORSConfiguration>`;
    const body = Buffer.from(xml);
    const md5 = crypto.createHash('md5').update(body).digest('base64');
    return request('PUT', '', { body, query: 'cors=', headers: { 'content-type': 'application/xml', 'content-md5': md5 } });
  }
};
