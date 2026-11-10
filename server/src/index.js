import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, SERVER_ROOT, loadConfig, writeConfig } from './config.js';
import { initDb } from './db.js';
import { currentConfig, handleApi, initApi, requireAuth } from './api.js';
import { hashPassword, randomPassword } from './util.js';

const WEB_DIST = process.env.EL_WEB_DIST
  ? path.resolve(process.env.EL_WEB_DIST)
  : path.resolve(SERVER_ROOT, '..', 'web', 'dist');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.txt': 'text/plain; charset=utf-8'
};

function bootstrapPassword(config) {
  if (config.auth.passwordHash) return null;
  const password = process.env.EL_PASSWORD || randomPassword(12);
  const { salt, hash } = hashPassword(password);
  config.auth.salt = salt;
  config.auth.passwordHash = hash;
  writeConfig(config);
  return password;
}

function readBody(req, limitBytes = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve(null);
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  const text = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text)
  });
  res.end(text);
}

function sendText(res, status, text, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'content-type': contentType });
  res.end(text);
}

function serveStatic(req, res, url) {
  if (!fs.existsSync(WEB_DIST)) {
    sendText(
      res,
      200,
      [
        'english-learn API 正在运行，但还没有构建前端页面。',
        '',
        '开发模式：cd web && npm install && npm run dev  然后在浏览器打开 http://localhost:5173',
        '生产模式：cd web && npm install && npm run build  然后刷新本页面'
      ].join('\n')
    );
    return;
  }

  let requested = decodeURIComponent(url.pathname);
  if (requested === '/' || requested.endsWith('/')) requested += 'index.html';
  const target = path.join(WEB_DIST, path.normalize(requested).replace(/^([/\\])+/, ''));
  const inside = path.resolve(target).startsWith(path.resolve(WEB_DIST));
  const file = inside && fs.existsSync(target) && fs.statSync(target).isFile() ? target : null;

  if (!file) {
    // SPA fallback: let the client router handle unknown paths.
    const fallback = path.join(WEB_DIST, 'index.html');
    if (fs.existsSync(fallback)) {
      sendText(res, 200, fs.readFileSync(fallback), MIME['.html']);
      return;
    }
    sendText(res, 404, 'not found');
    return;
  }

  const ext = path.extname(file).toLowerCase();
  const isHashed = /-[A-Za-z0-9_]{8,}\./.test(path.basename(file));
  res.writeHead(200, {
    'content-type': MIME[ext] || 'application/octet-stream',
    'cache-control': isHashed ? 'public, max-age=31536000, immutable' : 'no-cache'
  });
  fs.createReadStream(file).pipe(res);
}

async function main() {
  const config = loadConfig();
  let password = null;
  try {
    password = bootstrapPassword(config);
  } catch (err) {
    console.error('[warn] 写入初始密码失败：', err.message);
  }
  initApi(config);
  initDb();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const isApi = url.pathname.startsWith('/api/');

    if (isApi) {
      res.setHeader('access-control-allow-origin', req.headers.origin || '*');
      res.setHeader('vary', 'origin');
      res.setHeader('access-control-allow-headers', 'content-type, authorization');
      res.setHeader('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }
    }

    try {
      if (isApi) {
        let body = null;
        if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
          body = await readBody(req);
        }
        const denied = requireAuth(req, url);
        if (denied) return sendJson(res, denied.status, denied.body);

        const result = await handleApi(req, url, body);
        if (result.raw) {
          const { file, buffer, contentType = 'audio/mpeg' } = result.raw;
          res.writeHead(200, {
            'content-type': contentType,
            'cache-control': 'public, max-age=604800'
          });
          if (file) fs.createReadStream(file).pipe(res);
          else res.end(buffer);
          return;
        }
        return sendJson(res, result.status || 200, result.body);
      }
      serveStatic(req, res, url);
    } catch (err) {
      console.error('[error]', err);
      if (!res.headersSent) sendJson(res, 500, { error: err.message || '服务器内部错误' });
    }
  });

  const port = currentConfig().port || 8787;
  const host = currentConfig().host || '0.0.0.0';
  server.listen(port, host, () => {
    console.log('');
    console.log('  english-learn 服务已启动');
    console.log(`  本地地址     http://localhost:${port}`);
    console.log(`  数据目录     ${DATA_DIR}`);
    console.log(`  前端构建     ${fs.existsSync(WEB_DIST) ? WEB_DIST : '（未构建，见 web/ 目录）'}`);
    if (password) {
      console.log('');
      console.log('  ┌──────────────────────────────────────────────┐');
      console.log(`  │  初始登录密码：${password.padEnd(28)}│`);
      console.log('  │  请登录后在「设置」里修改，或直接编辑        │');
      console.log('  │  server/data/config.json 里的 auth 字段。    │');
      console.log('  └──────────────────────────────────────────────┘');
    }
    console.log('');
  });
}

main().catch((err) => {
  console.error('启动失败：', err);
  process.exit(1);
});
