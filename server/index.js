import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import { Store } from './store.js';
import { printBanner } from './net.js';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
try {
  process.loadEnvFile(path.join(ROOT, '.env'));
} catch {
  // 没有 .env 就用默认值，不算错误
}

const PORT = Number(process.env.PORT) || 8787;
const DATA_DIR = path.resolve(ROOT, process.env.DATA_DIR || 'data');
const TOKEN = process.env.TOKEN || randomBytes(4).toString('hex');
const TOKEN_IS_RANDOM = !process.env.TOKEN;

// 新文件名是 时间戳_sha.ext（如 20260904-143022_1a2b...png），老文件是纯 sha.ext。
// 只放行这个字符集，天然挡掉 .. 和 / ，不需要额外的路径穿越检查。
const FILE_RE = /^[A-Za-z0-9_-]+\.[a-z0-9]+$/;
const MAX_UPLOAD = 64 * 1024 * 1024;
const MAX_TEXT = 100_000;

const store = new Store(DATA_DIR);
await store.init();

const app = express();
app.disable('x-powered-by');

const LOCAL_ADDRS = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];
const isLocal = (req) => LOCAL_ADDRS.includes(req.socket.remoteAddress);

// ---- 写接口鉴权 ----------------------------------------------------------
// 局域网里可能有别人的设备，一个共享令牌足以挡住误传。读接口不设限。
function requireToken(req, res, next) {
  const given = req.get('x-token') || req.query.token;
  if (given !== TOKEN) return res.status(401).json({ error: 'bad token' });
  next();
}

// ---- 上传 ---------------------------------------------------------------
// 快捷指令的「请求体：文件」发的是原始字节，不是 multipart，所以直接收 raw。
app.post(
  '/api/upload',
  requireToken,
  express.raw({ type: ['image/*', 'application/octet-stream'], limit: MAX_UPLOAD }),
  async (req, res, next) => {
    try {
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        return res.status(400).json({ error: 'empty body（检查快捷指令的「请求体」是否选了 文件）' });
      }
      const mime = (req.get('content-type') || 'image/png').split(';')[0].trim();
      // 可选的备用去重键，见 README 的 iPhone 配置
      const shotAt = (req.get('x-shot-at') || '').trim() || null;

      const { item, duplicate } = await store.addImage(req.body, mime, shotAt);
      if (duplicate) {
        // item 为 null = 这张图收过、但已经被从白板上删掉了，故意不再收
        console.log(`  ↺ ${item ? '重复，已忽略' : '之前删过的图，不再收'} (${kb(req.body.length)})`);
        return res.json({ ok: true, duplicate: true, id: item?.id ?? null });
      }
      console.log(`  ✚ 收到新图 ${item.file.slice(0, 15)} (${kb(item.bytes)})`);
      broadcast({ type: 'add', item });
      res.json({ ok: true, duplicate: false, id: item.id });
    } catch (err) {
      next(err);
    }
  }
);

// ---- 白板数据 -----------------------------------------------------------
app.get('/api/items', (_req, res) => res.json({ items: store.items }));

// 在白板上直接新建一张文字卡片（网页双击空白处）。
app.post('/api/items/text', requireToken, express.json({ limit: '1mb' }), (req, res) => {
  const { text = '', x, y, w, h } = req.body || {};
  if (typeof text !== 'string') return res.status(400).json({ error: 'text must be a string' });
  if (text.length > MAX_TEXT) return res.status(413).json({ error: '文字太长了' });
  const item = store.createText({ text, x, y, w, h });
  broadcast({ type: 'add', item }, req.get('x-client-id'));
  res.json({ ok: true, item });
});

// 撤销删除：把客户端留的快照放回白板，id 不变。
app.post('/api/items/restore', requireToken, express.json({ limit: '1mb' }), (req, res) => {
  const raw = req.body?.item;
  if (typeof raw?.text === 'string' && raw.text.length > MAX_TEXT) {
    return res.status(413).json({ error: '文字太长了' });
  }
  const { item, error, status } = store.restoreItem(raw);
  if (error) return res.status(status).json({ error });
  broadcast({ type: 'add', item }, req.get('x-client-id'));
  res.json({ ok: true, item });
});

app.patch('/api/items/:id', requireToken, express.json({ limit: '1mb' }), (req, res) => {
  if (typeof req.body?.text === 'string' && req.body.text.length > MAX_TEXT) {
    return res.status(413).json({ error: '文字太长了' });
  }
  const item = store.updateItem(req.params.id, req.body || {});
  if (!item) return res.status(404).json({ error: 'not found' });
  broadcast({ type: 'move', item }, req.get('x-client-id'));
  res.json({ ok: true, item });
});

app.delete('/api/items/:id', requireToken, (req, res) => {
  const item = store.removeItem(req.params.id);
  if (!item) return res.status(404).json({ error: 'not found' });
  broadcast({ type: 'delete', id: item.id });
  res.json({ ok: true });
});

// 清空整块白板。原图仍留在 data/images/。
app.delete('/api/items', requireToken, (_req, res) => {
  const removed = store.clearAll();
  broadcast({ type: 'clear' });
  console.log(`  ✕ 清空白板，移除 ${removed} 项（原图仍在 data/images/）`);
  res.json({ ok: true, removed });
});

// 前端需要令牌才能改动白板；只在本地环回请求时下发。
app.get('/api/config', (req, res) => {
  res.json({ token: isLocal(req) ? TOKEN : null, local: isLocal(req) });
});

// ---- 打开图片文件夹 -------------------------------------------------------
// 只允许本机：局域网上的设备不该能操控这台电脑的资源管理器。
app.post('/api/open-folder', requireToken, (req, res) => {
  if (!isLocal(req)) return res.status(403).json({ error: '只能在运行服务的这台电脑上打开' });

  const [cmd, args] = process.platform === 'win32'
    ? ['explorer.exe', [store.imagesDir]]
    : process.platform === 'darwin'
      ? ['open', [store.imagesDir]]
      : ['xdg-open', [store.imagesDir]];

  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    // explorer.exe 打开成功也会返回退出码 1，所以只看能不能启动，不看退出码。
    child.on('error', (err) => console.error('[open-folder] 启动失败', err));
    child.unref();
    res.json({ ok: true, dir: store.imagesDir });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// ---- 图片 ---------------------------------------------------------------
app.get('/img/:file', (req, res) => {
  const { file } = req.params;
  if (!FILE_RE.test(file)) return res.status(400).end();
  res.sendFile(path.join(store.imagesDir, file), {
    // 内容寻址的文件名，内容永不改变，放心长缓存
    headers: { 'Cache-Control': 'public, max-age=31536000, immutable' },
  });
});

app.use(express.static(path.join(ROOT, 'web'), { extensions: ['html'] }));

app.use((err, _req, res, _next) => {
  if (err.type === 'entity.too.large') return res.status(413).json({ error: '图片太大' });
  console.error('[server]', err);
  res.status(500).json({ error: String(err.message || err) });
});

// ---- WebSocket ----------------------------------------------------------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

function broadcast(msg, exceptClientId) {
  const payload = JSON.stringify(msg);
  for (const ws of wss.clients) {
    if (ws.readyState !== ws.OPEN) continue;
    if (exceptClientId && ws.clientId === exceptClientId) continue;
    ws.send(payload);
  }
}

wss.on('connection', (ws, req) => {
  ws.clientId = new URL(req.url, 'http://x').searchParams.get('clientId') || null;
});

server.listen(PORT, '0.0.0.0', () => {
  printBanner({ port: PORT, token: TOKEN });
  if (TOKEN_IS_RANDOM) {
    console.log('  提示：当前令牌是随机生成的，重启就会变，手机快捷指令得跟着改。');
    console.log('        建议 cp .env.example .env 然后把 TOKEN 固定下来。\n');
  }
  console.log(`  白板上现有 ${store.items.length} 张图。等待手机传图…\n`);
});

// ws 在构造时就抢先在 http server 上挂了 error 监听并转发给 wss，
// 所以两边都要接，否则 EADDRINUSE 会变成一坨没人处理的栈。
function onFatal(err) {
  console.error('');
  if (err.code === 'EADDRINUSE') {
    console.error(`  端口 ${PORT} 已被占用。改 .env 里的 PORT，或关掉占用它的程序。`);
    console.error(`  查占用：powershell "Get-NetTCPConnection -LocalPort ${PORT} | Select OwningProcess"`);
  } else {
    console.error('  服务启动失败：', err);
  }
  console.error('');
  process.exit(1);
}
server.on('error', onFatal);
wss.on('error', onFatal);

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    await store.flush().catch(() => {});
    process.exit(0);
  });
}

function kb(n) {
  return n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// data 目录被误删时给个明确提示，而不是一堆 ENOENT
if (!fs.existsSync(store.imagesDir)) console.warn('[server] 图片目录不存在，已重建');
