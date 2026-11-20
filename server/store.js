import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

// 自动排版的网格。手机截图都是竖长条，格子按 9:19.5 左右留够高度。
const GRID_COLS = 5;
const CELL_W = 400;
const CELL_H = 840;

const EXT_BY_MIME = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/heic': '.heic',
  'image/heif': '.heif',
};

// seenShotAt：X-Shot-At 去重键的持久记录。和 sha 不同，它在磁盘上没有对应文件，
// 所以只能自己记一份。截图不会无限多，但还是封个顶免得 board.json 无限长。
const MAX_SEEN_SHOT_AT = 1000;

const EMPTY_BOARD = { nextSlot: 0, maxZ: 0, items: [], seenShotAt: [] };

// 文件名里的时间前缀，用服务器本机时间（和用户是同一台电脑，时区不会对不上）。
// 定宽零填充，字典序等价于时间顺序，Windows 资源管理器按名称排序就是按时间排序。
function stampOf(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

// 文字卡片的框尺寸（世界坐标，未乘 scale）。没有 w = 默认宽度；没有 h = 高度随内容。
// 传 null 表示恢复默认（w 回到默认宽度、h 恢复随内容）。老数据两个都没有，前端兜底，不做迁移。
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
function applyTextSize(item, { w, h }) {
  if (w === null) delete item.w;
  else if (typeof w === 'number' && Number.isFinite(w)) item.w = Math.round(clamp(w, 120, 4000));
  if (h === null) delete item.h;
  else if (typeof h === 'number' && Number.isFinite(h)) item.h = Math.round(clamp(h, 48, 4000));
}

// ---- 新图落位时的避让 ----
// 服务端不知道卡片渲染出来多高，只能估，宁可估大：多跳一格没关系，盖住用户的字才要命。
// 估算里已经算上了下面那行时间，所以判重叠不再额外留缝，挨着不算压住。
// 数字对应 web/board.css：卡片宽 360，文字 18px/1.6、上下内边距 18、左右 20、最高 500。
const ITEM_W = 360;
const IMG_H_GUESS = 780; // 手机竖屏截图按 360 宽渲染大约这么高
const META_H = 30;       // 卡片下面那行时间/尺寸

function estimateTextHeight(item) {
  if (item.h) return item.h;
  // 每行末尾放不下的那个字会整个折到下一行，平均浪费不到一个字宽，按一个字宽扣掉
  const inner = (item.w || ITEM_W) - 40 - 18;
  let lines = 0;
  for (const para of String(item.text || '').split('\n')) {
    let px = 0;
    // 中日韩和全角字按一个字号宽，其余按半个多一点
    for (const ch of para) px += ch.codePointAt(0) > 0x2e7f ? 18 : 10;
    lines += Math.max(1, Math.ceil(px / inner));
  }
  return Math.min(500, lines * 29 + 36);
}

function footprint(item) {
  const s = item.scale || 1;
  const isText = (item.kind || 'image') === 'text';
  const w = (isText ? item.w || ITEM_W : ITEM_W) * s;
  const h = (isText ? estimateTextHeight(item) : IMG_H_GUESS) * s + META_H;
  return { x0: item.x, y0: item.y, x1: item.x + w, y1: item.y + h };
}

const overlaps = (a, b) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;

export class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.imagesDir = path.join(dataDir, 'images');
    this.boardPath = path.join(dataDir, 'board.json');
    this.board = structuredClone(EMPTY_BOARD);
    this.byId = new Map();
    this.bySha = new Map();
    this.byShotAt = new Map(); // 备用去重键，见 README 的 iPhone 配置
    this.saveTimer = null;
    this.saving = null;
  }

  async init() {
    await fsp.mkdir(this.imagesDir, { recursive: true });
    try {
      const raw = await fsp.readFile(this.boardPath, 'utf8');
      const parsed = JSON.parse(raw);
      this.board = { ...structuredClone(EMPTY_BOARD), ...parsed };
    } catch (err) {
      if (err.code !== 'ENOENT') {
        // 文件损坏时不要静默清空用户的白板，先备份再重来。
        const backup = `${this.boardPath}.corrupt-${Date.now()}`;
        await fsp.rename(this.boardPath, backup).catch(() => {});
        console.warn(`[store] board.json 无法解析，已备份到 ${backup}`);
      }
      this.board = structuredClone(EMPTY_BOARD);
    }
    this.reindex();
  }

  reindex() {
    this.byId.clear();
    this.bySha.clear();
    this.byShotAt.clear();
    for (const item of this.board.items) {
      this.byId.set(item.id, item);
      if (item.sha) this.bySha.set(item.sha, item);
      if (item.shotAt) this.byShotAt.set(item.shotAt, item);
    }
    // 老数据里可能没有 seenShotAt，用板上现有的补一份，避免升级后老照片被当成新的
    if (!Array.isArray(this.board.seenShotAt)) this.board.seenShotAt = [];
    for (const item of this.board.items) {
      if (item.shotAt && !this.board.seenShotAt.includes(item.shotAt)) {
        this.board.seenShotAt.push(item.shotAt);
      }
    }
    this.seenShotAt = new Set(this.board.seenShotAt);
  }

  /**
   * 这个 sha 的图片文件是不是已经在 data/images/ 里了。
   * 去重以磁盘为准而不是以白板为准：从白板上删掉一张图并不会删文件，
   * 所以手机再盲传同一张时仍然认得出来，不会又冒回来。
   * 想让某张图重新能传上来，就去文件夹里把它的文件删掉。
   */
  findExistingFile(sha) {
    let names;
    try {
      names = fs.readdirSync(this.imagesDir);
    } catch {
      return null;
    }
    // 文件名里只要出现这个 sha 就认了：新文件是 "时间戳_sha.ext"，老文件是纯 "sha.ext"，
    // 两种都能被 includes 命中，不用管当时用的是哪种格式。
    // 排除还在写的 .tmp-<pid> 临时文件，那还不算「已经有了」。
    return names.find((name) => name.includes(sha) && !name.includes('.tmp-')) || null;
  }

  rememberShotAt(shotAt) {
    if (!shotAt || this.seenShotAt.has(shotAt)) return;
    this.seenShotAt.add(shotAt);
    this.board.seenShotAt.push(shotAt);
    if (this.board.seenShotAt.length > MAX_SEEN_SHOT_AT) {
      const dropped = this.board.seenShotAt.splice(0, this.board.seenShotAt.length - MAX_SEEN_SHOT_AT);
      for (const d of dropped) this.seenShotAt.delete(d);
    }
  }

  get items() {
    return this.board.items;
  }

  /**
   * 落盘一张图。返回 { item, duplicate }。
   * 去重：内容哈希命中，或 X-Shot-At（照片拍摄时间）命中，都算同一张。
   * 这让手机端可以无脑重传最近几张截图而不产生重复。
   */
  async addImage(buf, mime, shotAt) {
    const sha = createHash('sha256').update(buf).digest('hex');

    // 以磁盘为准，不是以白板为准 —— 见 findExistingFile 的说明。
    // 从白板删掉的图，文件还在，所以不会被重新传上来。
    if (this.findExistingFile(sha) || (shotAt && this.seenShotAt.has(shotAt))) {
      this.rememberShotAt(shotAt);
      this.scheduleSave();
      // 这张图可能还在板上，也可能早就被删了；有就把 id 一并返回，方便排查
      return { item: this.bySha.get(sha) || null, duplicate: true };
    }

    const now = new Date();
    const ext = EXT_BY_MIME[mime] || '.png';
    const file = `${stampOf(now)}_${sha}${ext}`;
    const dest = path.join(this.imagesDir, file);
    const tmp = `${dest}.tmp-${process.pid}`;
    await fsp.writeFile(tmp, buf);
    await fsp.rename(tmp, dest);

    const slot = this.takeFreeSlot();
    const item = {
      id: randomUUID(),
      kind: 'image',
      sha,
      file,
      mime,
      bytes: buf.length,
      shotAt: shotAt || null,
      createdAt: now.toISOString(),
      x: (slot % GRID_COLS) * CELL_W,
      y: Math.floor(slot / GRID_COLS) * CELL_H,
      scale: 1,
      z: ++this.board.maxZ,
    };

    this.board.items.push(item);
    this.byId.set(item.id, item);
    this.bySha.set(sha, item);
    if (shotAt) this.byShotAt.set(shotAt, item);
    this.rememberShotAt(shotAt);
    this.scheduleSave();
    return { item, duplicate: false };
  }

  /**
   * 从 nextSlot 往后找第一个空着的格子。格子只替手机传来的图记账，
   * 用户手写的文字卡、拖到别处的图都不占格，不看一眼就放会直接盖在上面。
   */
  takeFreeSlot() {
    const taken = this.board.items.map(footprint);
    let slot = this.board.nextSlot;
    // 封个顶防止死循环；真跳了这么多格说明板子已经很满了，就放在那
    for (let tries = 0; tries < 5000; tries++, slot++) {
      const x = (slot % GRID_COLS) * CELL_W;
      const y = Math.floor(slot / GRID_COLS) * CELL_H;
      const cell = { x0: x, y0: y, x1: x + ITEM_W, y1: y + IMG_H_GUESS + META_H };
      if (!taken.some((t) => overlaps(cell, t))) break;
    }
    this.board.nextSlot = slot + 1;
    return slot;
  }

  /**
   * 在白板上直接新建一张文字卡片（网页双击空白处触发）。
   * 和 addImage 有两点刻意不同：
   *  - 不做去重。手写的两张内容相同的便签是合法的，而且编辑后内容会变。
   *  - 不占用 nextSlot。位置由用户点在哪决定，不该让手机传来的图跳过格子。
   */
  createText({ text, x, y, w, h }) {
    const item = {
      id: randomUUID(),
      kind: 'text',
      text: String(text ?? ''),
      createdAt: new Date().toISOString(),
      x: Number.isFinite(x) ? x : 0,
      y: Number.isFinite(y) ? y : 0,
      scale: 1,
      z: ++this.board.maxZ,
    };
    applyTextSize(item, { w, h });
    this.board.items.push(item);
    this.byId.set(item.id, item);
    this.scheduleSave();
    return item;
  }

  updateItem(id, patch) {
    const item = this.byId.get(id);
    if (!item) return null;
    for (const key of ['x', 'y', 'scale']) {
      if (typeof patch[key] === 'number' && Number.isFinite(patch[key])) item[key] = patch[key];
    }
    // 只有文字卡片能改内容；图片是内容寻址的，改了就不是同一张了。
    if (typeof patch.text === 'string' && item.kind === 'text') item.text = patch.text;
    if (item.kind === 'text') applyTextSize(item, patch);
    if (patch.bringToFront) item.z = ++this.board.maxZ;
    this.scheduleSave();
    return item;
  }

  /**
   * 把删掉的卡片原样放回去（网页 Ctrl+Z 撤销删除用）。id 不变，之后的撤销/重做还能找到它。
   * 客户端发来的是它删之前留的快照，不能全信：字段逐个挑，图片必须真的还在磁盘上。
   * 返回 { item } 或 { error, status }。
   */
  restoreItem(raw) {
    if (!raw || typeof raw.id !== 'string' || !/^[\w-]{1,64}$/.test(raw.id)) {
      return { error: 'bad id', status: 400 };
    }
    if (this.byId.has(raw.id)) return { error: 'already exists', status: 409 };
    const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
    const base = {
      id: raw.id,
      createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString(),
      x: num(raw.x, 0),
      y: num(raw.y, 0),
      scale: num(raw.scale, 1),
      z: ++this.board.maxZ,
    };

    let item;
    if ((raw.kind || 'image') === 'text') {
      item = { ...base, kind: 'text', text: String(raw.text ?? '') };
      applyTextSize(item, raw);
    } else {
      // 文件名必须是这张图自己的（含它的 sha），而且还在文件夹里——用户可能已经手动删了
      const sha = typeof raw.sha === 'string' && /^[0-9a-f]{64}$/.test(raw.sha) ? raw.sha : null;
      const file = sha && this.findExistingFile(sha);
      if (!file) return { error: '原图文件已经不在 data/images/ 里了', status: 410 };
      item = {
        ...base,
        kind: 'image',
        sha,
        file,
        mime: typeof raw.mime === 'string' ? raw.mime : 'image/png',
        bytes: num(raw.bytes, 0),
        shotAt: typeof raw.shotAt === 'string' ? raw.shotAt : null,
      };
      this.bySha.set(sha, item);
      if (item.shotAt) this.byShotAt.set(item.shotAt, item);
    }
    this.board.items.push(item);
    this.byId.set(item.id, item);
    this.scheduleSave();
    return { item };
  }

  removeItem(id) {
    const item = this.byId.get(id);
    if (!item) return null;
    this.board.items = this.board.items.filter((it) => it.id !== id);
    this.byId.delete(id);
    // 图片文件保留在 data/images/ 里：内容寻址，别的 item 可能也指向它。
    if (this.bySha.get(item.sha) === item) this.bySha.delete(item.sha);
    if (item.shotAt && this.byShotAt.get(item.shotAt) === item) this.byShotAt.delete(item.shotAt);
    this.scheduleSave();
    return item;
  }

  /**
   * 清空整块白板，返回移除的条目数。
   * 和 removeItem 一样，图片文件保留在 data/images/ 里——内容寻址，删了不可逆，
   * 想真正腾空间就去文件夹里自己删。文字卡片没有磁盘备份，清了就没了。
   */
  clearAll() {
    const n = this.board.items.length;
    this.board.items = [];
    // 槽位归零，下一批图重新从左上角开始排
    this.board.nextSlot = 0;
    // reindex 只往 seenShotAt 里加、不删，所以持久的去重记录不会被连带清掉
    this.reindex();
    this.scheduleSave();
    return n;
  }

  scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save().catch((err) => console.error('[store] 保存失败', err));
    }, 200);
    this.saveTimer.unref?.();
  }

  // 串行化写入，避免两次 flush 交错写同一个临时文件。
  async save() {
    this.saving = (this.saving || Promise.resolve()).then(async () => {
      const tmp = `${this.boardPath}.tmp-${process.pid}`;
      await fsp.writeFile(tmp, JSON.stringify(this.board, null, 2));
      await fsp.rename(tmp, this.boardPath);
    });
    return this.saving;
  }

  // 进程退出前把防抖中的改动落盘。
  async flush() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    await this.save();
  }
}
