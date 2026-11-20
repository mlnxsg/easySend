// eSend 白板：无限画布 + 自由拖拽 + 一键复制。原生 JS，无框架无构建。

const ITEM_W = 360;          // 所有图统一按这个宽度渲染，高度按比例
const MIN_S = 0.05, MAX_S = 8;
const CLIENT_ID = Math.random().toString(36).slice(2);

const viewport = document.getElementById('viewport');
const world = document.getElementById('world');
const statusEl = document.getElementById('status');
const identityEl = document.getElementById('identity');
const zoomPctEl = document.getElementById('zoom-pct');
const emptyEl = document.getElementById('empty');
const followEl = document.getElementById('follow');
const autoClearEl = document.getElementById('auto-clear');
const toastEl = document.getElementById('toast');
const selBar = document.getElementById('selbar');
const selCountEl = document.getElementById('sel-count');
const marqueeEl = document.getElementById('marquee');

const items = new Map();     // id -> { data, el, img }
const selection = new Set(); // 选中的 id，可能多张
let view = { x: 0, y: 0, s: 1 };
let token = null;
let readOnly = true;
let spaceDown = false;

// ---------------------------------------------------------------- 视图变换

function applyView() {
  world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.s})`;
  const grid = 26 * view.s;
  viewport.style.backgroundSize = `${grid}px ${grid}px`;
  viewport.style.backgroundPosition = `${view.x}px ${view.y}px`;
  zoomPctEl.textContent = `${Math.round(view.s * 100)}%`;
  // 拉伸手柄按屏幕像素定大小，缩得再小也抓得住
  world.style.setProperty('--inv-zoom', 1 / view.s);
  // 缩得太小时卡片下面那行时间/尺寸会糊成一片，直接藏掉
  world.classList.toggle('zoom-tiny', view.s < 0.35);
}

function zoomAt(sx, sy, factor) {
  const next = Math.min(MAX_S, Math.max(MIN_S, view.s * factor));
  if (next === view.s) return;
  // 让光标下的那个世界坐标点保持不动
  view.x = sx - (sx - view.x) * (next / view.s);
  view.y = sy - (sy - view.y) * (next / view.s);
  view.s = next;
  applyView();
}

// 文字卡片可以拉宽，图片固定按 ITEM_W 渲染、只靠 scale 缩放
function itemWidth(entry) {
  return (entry.kind === 'text' && entry.data.w) || ITEM_W;
}

function itemHeight(entry) {
  const h = entry.el.offsetHeight;
  return h > 10 ? h : 780; // 图还没加载完时的兜底（手机截图大致比例）
}

function boundsOfAll() {
  if (!items.size) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const entry of items.values()) {
    const { x, y, scale } = entry.data;
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x + itemWidth(entry) * scale);
    y1 = Math.max(y1, y + itemHeight(entry) * scale);
  }
  return { x0, y0, x1, y1 };
}

function fitAll(animate = true) {
  const b = boundsOfAll();
  if (!b) return resetView(animate);

  // 后台标签页 / 面板还没显示时 innerWidth 可能是 0，这时算出来的缩放是负数，
  // 会被夹到 MIN_S，白板看起来一片空白。等窗口真有尺寸了再算。
  if (innerWidth < 50 || innerHeight < 50) {
    addEventListener('resize', () => fitAll(animate), { once: true });
    return;
  }

  const pad = 80;
  const s = Math.min(MAX_S, Math.max(MIN_S, Math.min(
    (innerWidth - pad * 2) / Math.max(1, b.x1 - b.x0),
    (innerHeight - pad * 2) / Math.max(1, b.y1 - b.y0)
  )));
  tweenTo({
    s,
    x: (innerWidth - (b.x1 - b.x0) * s) / 2 - b.x0 * s,
    y: (innerHeight - (b.y1 - b.y0) * s) / 2 - b.y0 * s,
  }, animate);
}

function resetView(animate = true) {
  tweenTo({ s: 1, x: 40, y: 80 }, animate);
}

function centerOn(entry, animate = true) {
  const s = view.s;
  const cx = entry.data.x + (itemWidth(entry) * entry.data.scale) / 2;
  const cy = entry.data.y + (itemHeight(entry) * entry.data.scale) / 2;
  tweenTo({ s, x: innerWidth / 2 - cx * s, y: innerHeight / 2 - cy * s }, animate);
}

let tween = null;
function tweenTo(target, animate = true) {
  if (tween) cancelAnimationFrame(tween);
  if (!animate) { view = { ...target }; applyView(); return; }
  const from = { ...view };
  const t0 = performance.now();
  const step = (now) => {
    const k = Math.min(1, (now - t0) / 380);
    const e = 1 - Math.pow(1 - k, 3);
    view = {
      x: from.x + (target.x - from.x) * e,
      y: from.y + (target.y - from.y) * e,
      s: from.s + (target.s - from.s) * e,
    };
    applyView();
    tween = k < 1 ? requestAnimationFrame(step) : null;
  };
  tween = requestAnimationFrame(step);
}

// ---------------------------------------------------------------- 渲染

function placeEl(entry) {
  const { x, y, scale } = entry.data;
  entry.el.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
  entry.el.style.zIndex = entry.data.z || 0;
  entry.el.style.setProperty('--item-scale', scale);
  if (entry.kind === 'text') {
    const { w, h } = entry.data;
    entry.el.style.width = w ? `${w}px` : '';
    // 定了高度：框就这么高，字多了在框里滚；没定就随内容长
    entry.el.classList.toggle('fixed-h', !!h);
    entry.el.style.setProperty('--h', h ? `${h}px` : '');
    if (editing?.entry === entry) editing.autosize();
  }
}

// 老数据没有 kind 字段，一律当图片
const kindOf = (data) => data.kind || 'image';

// Lucide 图标，stroke-width 2.75（设计系统要求，比默认粗）
const ICON = {
  copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  pencil: '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>',
};
const svgIcon = (name, size = 15) =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor"`
  + ` stroke-width="2.75" stroke-linecap="round" stroke-linejoin="round">${ICON[name]}</svg>`;

// 卡片右上角浮出的操作胶囊。内容全是写死的字符串，没有用户输入，用 innerHTML 是安全的。
function buildActions(kind) {
  const el = document.createElement('div');
  el.className = 'item-actions';
  const btns = [['copy', 'act-copy', '复制', 'copy']];
  if (kind === 'text') btns.push(['edit', 'act-edit', '编辑', 'pencil']);
  btns.push(['delete', 'act-delete', '删除', 'trash']);
  el.innerHTML = btns
    .map(([act, cls, label, icon]) =>
      `<button type="button" class="${cls}" data-act="${act}" title="${label}" aria-label="${label}">${svgIcon(icon)}</button>`)
    .join('');
  return el;
}

function metaText(entry) {
  const t = new Date(entry.data.createdAt)
    .toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  if (entry.kind === 'text') return `${t} · ${(entry.data.text || '').length} 字`;
  const w = entry.img?.naturalWidth;
  return w ? `${t} · ${w}×${entry.img.naturalHeight}` : t;
}

function renderMeta(entry) {
  entry.metaEl.textContent = metaText(entry);
  const full = new Date(entry.data.createdAt).toLocaleString('zh-CN', { hour12: false });
  entry.metaEl.title = entry.data.bytes ? `${full} · ${fmtBytes(entry.data.bytes)}` : full;
}

function renderTextBody(entry) {
  // textContent 而不是 innerHTML —— 内容来自剪贴板/键盘，是外部输入
  entry.el.querySelector('.text-body').textContent = entry.data.text || '';
}

function nextZ() {
  return Math.max(0, ...[...items.values()].map((i) => i.data.z || 0)) + 1;
}

function addItem(data, { fresh = false } = {}) {
  if (items.has(data.id)) return items.get(data.id);
  const kind = kindOf(data);
  const el = document.createElement('div');
  el.className = `item kind-${kind}`;
  el.dataset.id = data.id;

  // 裁切层单独一层：圆角和 overflow:hidden 在它身上，操作胶囊挂在外面才不会被裁掉
  const clip = document.createElement('div');
  clip.className = 'item-clip';
  el.appendChild(clip);

  let img = null;
  if (kind === 'text') {
    const body = document.createElement('div');
    body.className = 'text-body';
    clip.appendChild(body);
  } else {
    img = document.createElement('img');
    img.src = `/img/${data.file}`;
    img.alt = '';
    img.draggable = false;
    clip.appendChild(img);
  }

  el.appendChild(buildActions(kind));
  // 拉伸手柄：文字卡片右边拉宽、下边拉高、角上两个一起；图片只有角，等比缩放
  for (const edge of kind === 'text' ? ['e', 's', 'se'] : ['se']) {
    const h = document.createElement('div');
    h.className = `item-resize rz-${edge}`;
    h.dataset.edge = edge;
    el.appendChild(h);
  }
  const metaEl = document.createElement('div');
  metaEl.className = 'item-meta';
  el.appendChild(metaEl);
  world.appendChild(el);

  const entry = { data, el, img, kind, metaEl };
  items.set(data.id, entry);
  if (kind === 'text') renderTextBody(entry);
  renderMeta(entry);
  // 尺寸要等图解码出来才知道
  img?.addEventListener('load', () => renderMeta(entry), { once: true });
  placeEl(entry);

  if (fresh) {
    el.classList.add('fresh');
    setTimeout(() => el.classList.remove('fresh'), 1000);
  }
  updateEmpty();
  return entry;
}

function removeItemLocal(id) {
  const entry = items.get(id);
  if (!entry) return;
  // 别人删掉了我正在编辑的这张：先把编辑态收掉，否则元素移除后 blur 才触发，
  // commitEdit 会在一张已经不存在的卡片上继续跑
  if (editing?.entry === entry) cancelEdit();
  entry.el.remove();
  items.delete(id);
  selection.delete(id);
  syncSelection();
  updateEmpty();
}

function clearAllLocal() {
  if (editing) cancelEdit();
  for (const entry of items.values()) entry.el.remove();
  items.clear();
  select(null);
  updateEmpty();
}

function updateEmpty() {
  emptyEl.hidden = items.size > 0;
}

// ---------------------------------------------------------------- 选中与工具条

/** 选中集合变了以后统一刷一遍描边和底部工具条 */
function syncSelection() {
  for (const id of [...selection]) if (!items.has(id)) selection.delete(id);
  for (const [id, entry] of items) entry.el.classList.toggle('selected', selection.has(id));
  const n = selection.size;
  // 单选时卡片自己的操作胶囊就够用了，工具条只为多选而存在
  selBar.hidden = n < 2;
  selCountEl.textContent = `已选 ${n} 项`;
}

/** 单选：清掉别的，只留这一个。id 传 null = 取消选中。 */
function select(id) {
  selection.clear();
  if (id && items.has(id)) selection.add(id);
  syncSelection();
}

function toggleSelect(id) {
  if (!items.has(id)) return;
  if (!selection.delete(id)) selection.add(id);
  syncSelection();
}

function selectAll() {
  for (const id of items.keys()) selection.add(id);
  syncSelection();
}

function selectedEntries() {
  return [...selection].map((id) => items.get(id)).filter(Boolean);
}

function fmtBytes(n) {
  if (!n) return '';
  return n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`;
}

// ---------------------------------------------------------------- 复制到剪贴板

const canCopy = window.isSecureContext && !!navigator.clipboard?.write && !!window.ClipboardItem;

async function copyItem(id) {
  const entry = items.get(id);
  if (!entry) return;
  if (!canCopy) {
    toast('浏览器禁用了剪贴板：请在电脑上用 http://localhost 打开白板', true);
    return;
  }
  if (entry.kind === 'text') {
    try {
      await navigator.clipboard.writeText(entry.data.text || '');
      toast('文字已复制');
    } catch (err) {
      toast(`复制失败：${err.name === 'NotAllowedError' ? '浏览器拒绝了剪贴板权限' : err.message}`, true);
    }
    return;
  }
  try {
    const blob = await (await fetch(`/img/${entry.data.file}`)).blob();
    // 统一转成 PNG —— Chrome 的 clipboard.write 只稳定接受 image/png
    const bmp = await createImageBitmap(blob);
    const c = document.createElement('canvas');
    c.width = bmp.width;
    c.height = bmp.height;
    c.getContext('2d').drawImage(bmp, 0, 0);
    const dims = `${bmp.width}×${bmp.height}`;
    bmp.close?.();
    const png = await new Promise((r) => c.toBlob(r, 'image/png'));
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
    toast(`已复制 ${dims}，去粘贴吧`);
  } catch (err) {
    // 最常见的一种：页面还没拿到剪贴板权限，或这次调用不是由真实点击触发的
    const hint = err.name === 'NotAllowedError'
      ? '浏览器拒绝了剪贴板权限 —— 先在页面上点一下再试，或检查地址栏左侧的网站权限'
      : err.message;
    toast(`复制失败：${hint}`, true);
  }
}

// ---- 多选复制 ----

const STITCH_GAP = 16;          // 拼图之间留的缝
const STITCH_MAX_PX = 40e6;     // 画布再大浏览器就直接给一张空白图了

/**
 * 多张图按它们在白板上的摆法排序：横着摆的就横着拼，竖着摆的就竖着拼。
 * 拼出来的顺序和眼睛看到的一致，不用再猜。
 */
function stitchOrder(entries) {
  const xs = entries.map((e) => e.data.x);
  const ys = entries.map((e) => e.data.y);
  const horizontal = (Math.max(...xs) - Math.min(...xs)) > (Math.max(...ys) - Math.min(...ys));
  const sorted = [...entries].sort((a, b) => (horizontal
    ? a.data.x - b.data.x || a.data.y - b.data.y
    : a.data.y - b.data.y || a.data.x - b.data.x));
  return { horizontal, sorted };
}

/**
 * 系统剪贴板一次只装得下一张图（clipboard.write 给多个 ClipboardItem，
 * Chrome 只取第一个），所以多选复制 = 把它们拼成一张 PNG。
 */
async function stitchImages(entries) {
  const { horizontal, sorted } = stitchOrder(entries);
  const bmps = await Promise.all(sorted.map(async (e) =>
    createImageBitmap(await (await fetch(`/img/${e.data.file}`)).blob())));

  // 先统一到同一条边（竖拼对齐宽、横拼对齐高），不然参差不齐很难看
  const W = Math.max(...bmps.map((b) => b.width));
  const H = Math.max(...bmps.map((b) => b.height));
  const boxes = bmps.map((b) => {
    const k = horizontal ? H / b.height : W / b.width;
    return { b, w: Math.round(b.width * k), h: Math.round(b.height * k) };
  });
  const gaps = STITCH_GAP * (boxes.length - 1);
  const cw = horizontal ? boxes.reduce((t, x) => t + x.w, 0) + gaps : W;
  const ch = horizontal ? H : boxes.reduce((t, x) => t + x.h, 0) + gaps;
  const k = Math.min(1, Math.sqrt(STITCH_MAX_PX / (cw * ch)));

  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(cw * k));
  c.height = Math.max(1, Math.round(ch * k));
  const ctx = c.getContext('2d');
  // 缝隙必须填白：透明底粘到 Word、聊天窗里会变成黑块
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.scale(k, k);
  let off = 0;
  for (const { b, w, h } of boxes) {
    ctx.drawImage(b, horizontal ? off : 0, horizontal ? 0 : off, w, h);
    b.close?.();
    off += (horizontal ? w : h) + STITCH_GAP;
  }
  const png = await new Promise((r) => c.toBlob(r, 'image/png'));
  return { png, w: c.width, h: c.height };
}

function joinTexts(entries) {
  const { sorted } = stitchOrder(entries);
  return sorted.map((e) => e.data.text || '').join('\n\n');
}

async function copySelection() {
  const entries = selectedEntries();
  if (!entries.length) return;
  if (entries.length === 1) return copyItem(entries[0].data.id);
  if (!canCopy) {
    toast('浏览器禁用了剪贴板：请在电脑上用 http://localhost 打开白板', true);
    return;
  }

  const imgs = entries.filter((e) => e.kind !== 'text');
  const texts = entries.filter((e) => e.kind === 'text');

  if (!imgs.length) {
    try {
      await navigator.clipboard.writeText(joinTexts(texts));
      toast(`已复制 ${texts.length} 张卡片的文字`);
    } catch (err) {
      toast(`复制失败：${err.name === 'NotAllowedError' ? '浏览器拒绝了剪贴板权限' : err.message}`, true);
    }
    return;
  }

  // 拼图要读文件、解码、再编码 PNG，慢的话用户手势就过期了。
  // 把 Promise 直接交给 ClipboardItem，write 在点击这一帧同步发出去，权限才不会掉。
  let info = null;
  const png = stitchImages(imgs).then((r) => { info = r; return r.png; });
  const payload = { 'image/png': png };
  if (texts.length) {
    payload['text/plain'] = new Blob([joinTexts(texts)], { type: 'text/plain' });
  }
  try {
    await navigator.clipboard.write([new ClipboardItem(payload)]);
    toast(`已把 ${imgs.length} 张图拼成 ${info.w}×${info.h} 复制`
      + (texts.length ? `，${texts.length} 张文字卡也一并复制了` : '，去粘贴吧'));
  } catch (err) {
    const hint = err.name === 'NotAllowedError'
      ? '浏览器拒绝了剪贴板权限 —— 先在页面上点一下再试，或检查地址栏左侧的网站权限'
      : err.message;
    toast(`复制失败：${hint}`, true);
  }
}

// ---------------------------------------------------------------- 服务端读写

async function patchItem(id, patch) {
  if (readOnly) return;
  try {
    const res = await fetch(`/api/items/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-token': token, 'x-client-id': CLIENT_ID },
      body: JSON.stringify(patch),
    });
    if (!res.ok) toast(`保存位置失败（${res.status}）`, true);
  } catch {
    toast('保存位置失败：服务已断开', true);
  }
}

/** 删一张，成功就从本地也拿掉。不弹提示，给删除和撤销/重做共用 */
async function deleteRemote(id) {
  const res = await fetch(`/api/items/${id}`, {
    method: 'DELETE',
    headers: { 'x-token': token },
  }).catch(() => null);
  if (res?.ok) removeItemLocal(id);
  return !!res?.ok;
}

async function deleteItem(id) {
  if (readOnly) return toast('只读模式，无法删除', true);
  const entry = items.get(id);
  if (!entry) return;
  const snap = snapshot(entry);
  if (!(await deleteRemote(id))) return toast('删除失败', true);
  record({ type: 'delete', label: '删除', items: [snap] });
  toast(entry.kind === 'text'
    ? '文字卡片已删除（Ctrl+Z 撤销）'
    : '已删除，手机不会再把它传上来（Ctrl+Z 撤销）');
}

async function deleteSelection() {
  const ids = [...selection].filter((id) => items.has(id));
  if (!ids.length) return;
  if (ids.length === 1) return deleteItem(ids[0]);
  if (readOnly) return toast('只读模式，无法删除', true);
  if (!confirm(
    `确定删除选中的 ${ids.length} 项？\n\n`
    + '图片的原文件仍留在 data/images/ 文件夹里，手机也不会再把它们传上来。\n'
    + '文字卡片会被直接删掉。'
  )) return;

  // 没有批量删除的接口，就一条条删；失败的留在白板上，不假装成功
  const gone = [];
  for (const id of ids) {
    const snap = snapshot(items.get(id));
    if (await deleteRemote(id)) gone.push(snap);
  }
  const ok = gone.length;
  if (ok) record({ type: 'delete', label: `删除 ${ok} 项`, items: gone });
  if (ok === ids.length) toast(`已删除 ${ok} 项（Ctrl+Z 撤销）`);
  else toast(`只删掉了 ${ok}/${ids.length} 项，其余失败`, true);
}

// ---------------------------------------------------------------- 文字卡片

let editing = null; // { entry, ta, before, autosize }

/**
 * 双击空白处新建。先只在本地建一张草稿卡，等真的写了字才发给服务端——
 * 这样点空了、又改主意，不会在白板上留下一张空卡片。
 */
function createDraftText(worldX, worldY) {
  const entry = addItem({
    id: `draft-${Math.random().toString(36).slice(2)}`,
    kind: 'text',
    text: '',
    createdAt: new Date().toISOString(),
    x: worldX,
    y: worldY,
    scale: 1,
    z: nextZ(),
    draft: true,
  });
  select(entry.data.id);
  startEdit(entry);
}

function startEdit(entry) {
  if (readOnly) return toast('只读模式，无法编辑', true);
  if (entry.kind !== 'text') return;
  if (editing) commitEdit();

  const body = entry.el.querySelector('.text-body');
  const ta = document.createElement('textarea');
  ta.className = 'text-edit';
  ta.value = entry.data.text || '';
  ta.placeholder = '写点什么，点别处保存';
  body.hidden = true;
  // 放进 .item-clip 顶替 body 的位置，不然 clip 塌成 0 高，选中描边缩成一条空框
  body.after(ta);
  entry.el.classList.add('editing');
  // 定了高度的卡片交给 CSS 撑满，不跟着字数长
  const autosize = () => {
    if (entry.data.h) { ta.style.height = ''; return; }
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 500)}px`;
  };
  editing = { entry, ta, before: entry.data.text || '', autosize };
  ta.addEventListener('input', autosize);
  ta.addEventListener('keydown', (e) => {
    // 别让画布的快捷键（Delete / F / 0 / 空格平移）抢走按键
    e.stopPropagation();
    if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) {
      e.preventDefault();
      ta.blur();
    }
  });
  ta.addEventListener('blur', () => commitEdit());

  autosize();
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
}

/** 只收掉编辑态，不保存。卡片被别人删掉时用。 */
function cancelEdit() {
  if (!editing) return;
  const { entry, ta } = editing;
  editing = null;
  ta.remove();
  entry.el.classList.remove('editing');
  const body = entry.el.querySelector('.text-body');
  if (body) body.hidden = false;
}

async function commitEdit() {
  if (!editing) return;
  const { entry, ta, before } = editing;
  editing = null; // 先清空，避免 remove() 触发的 blur 再进来一次

  const text = ta.value;
  ta.remove();
  entry.el.classList.remove('editing');
  entry.el.querySelector('.text-body').hidden = false;
  entry.data.text = text;
  renderTextBody(entry);
  renderMeta(entry);

  // 编辑期间这张卡被删了（别的标签页删的、或者点了清空），就到此为止，
  // 别再往服务端写一张已经不存在的卡片
  if (!items.has(entry.data.id)) return;

  const isDraft = entry.data.draft;

  if (!text.trim()) {
    // 空卡片没有意义：草稿直接丢掉，已有的就删掉。
    // 删之前把原文放回去，这样撤销时恢复的是清空前的内容
    if (isDraft) removeItemLocal(entry.data.id);
    else {
      entry.data.text = before;
      await deleteItem(entry.data.id);
    }
    return;
  }

  if (isDraft) {
    const res = await fetch('/api/items/text', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-token': token, 'x-client-id': CLIENT_ID },
      body: JSON.stringify({ text, x: entry.data.x, y: entry.data.y, w: entry.data.w, h: entry.data.h }),
    }).catch(() => null);
    if (!res?.ok) {
      toast('保存失败，这张卡片没有存到电脑上', true);
      return;
    }
    // 服务端发回真正的 id，把本地这张草稿换成正式的
    const { item } = await res.json();
    const oldId = entry.data.id;
    items.delete(oldId);
    entry.data = item;
    entry.el.dataset.id = item.id;
    items.set(item.id, entry);
    if (selection.delete(oldId)) { selection.add(item.id); syncSelection(); }
    placeEl(entry);
    record({ type: 'create', label: '新建文字', items: [snapshot(entry)] });
  } else if (text !== before) {
    patchItem(entry.data.id, { text });
    record({ type: 'patch', label: '编辑文字', changes: [{ id: entry.data.id, before: { text: before }, after: { text } }] });
  }
}

async function clearBoard() {
  if (readOnly) return toast('只读模式，无法清空', true);
  if (!items.size) return toast('白板已经是空的');
  const n = items.size;
  if (!confirm(
    `确定清空白板上的 ${n} 项？\n\n`
    + '图片的原文件仍留在 data/images/ 文件夹里，手机也不会再把它们传上来。\n'
    + '想让某张图能重新传，去文件夹里删掉它的文件即可。\n\n'
    + '文字卡片会被直接删掉，只能在关掉这个页面之前用 Ctrl+Z 找回。'
  )) return;

  // 快照必须在发请求之前拍：服务端先广播 clear 再回响应，
  // 等响应回来时 WebSocket 那边往往已经把本地清空了
  const snaps = [...items.values()].map(snapshot);
  const res = await fetch('/api/items', {
    method: 'DELETE',
    headers: { 'x-token': token },
  }).catch(() => null);
  if (!res?.ok) return toast('清空失败', true);

  const { removed } = await res.json();
  clearAllLocal();
  record({ type: 'delete', label: '清空白板', items: snaps });
  resetView();
  toast(`已清空 ${removed} 项（关页面之前可以 Ctrl+Z 撤销）`);
}

// ---------------------------------------------------------------- 打开时自动清空

const AUTO_CLEAR_KEY = 'esend.autoClearOnOpen';
const SESSION_KEY = 'esend.session';

// 默认开启；存 '0' 表示用户主动关掉了
function autoClearEnabled() {
  try {
    return localStorage.getItem(AUTO_CLEAR_KEY) !== '0';
  } catch {
    return true;
  }
}

function setAutoClear(on) {
  try {
    localStorage.setItem(AUTO_CLEAR_KEY, on ? '1' : '0');
  } catch { /* 隐私模式下存不了就算了，本次会话内仍然生效 */ }
}

/**
 * 「重新打开」和「刷新」要区分开：sessionStorage 在同一个标签页里刷新不会丢，
 * 关掉标签页才会清。所以有标记 = 这次是刷新，别动白板；没标记 = 新开的页面，可以清。
 * 按 F5 就把辛苦摆好的板子清掉，那才是灾难。
 */
function isNewPageSession() {
  try {
    if (sessionStorage.getItem(SESSION_KEY)) return false;
    sessionStorage.setItem(SESSION_KEY, '1');
    return true;
  } catch {
    return false; // 存不了就当作刷新，宁可不清也别误清
  }
}

async function autoClearOnOpen() {
  const res = await fetch('/api/items', {
    method: 'DELETE',
    headers: { 'x-token': token },
  }).catch(() => null);
  if (!res?.ok) return 0;
  const { removed } = await res.json();
  return removed || 0;
}

async function openFolder() {
  if (readOnly) return toast('只能在运行服务的那台电脑上用 localhost 打开', true);
  const res = await fetch('/api/open-folder', {
    method: 'POST',
    headers: { 'x-token': token },
  }).catch(() => null);
  if (!res?.ok) {
    return toast(res?.status === 403 ? '只能在运行服务的那台电脑上打开文件夹' : '打开文件夹失败', true);
  }
  toast('已在资源管理器里打开 data/images');
}

// ---------------------------------------------------------------- 撤销 / 重做

// 只记这个标签页自己做的操作，关掉页面就没了。三种记录：
//  patch  —— [{ id, before, after }]：移动、拉伸、改字，撤销＝把 before 套回去
//  delete —— 删之前的快照：撤销＝原样放回（id 不变），重做＝再删
//  create —— 新建文字卡的快照：撤销＝删掉，重做＝放回
const UNDO_MAX = 100;
const undoStack = [];
const redoStack = [];
let undoBusy = false;

function record(op) {
  undoStack.push(op);
  if (undoStack.length > UNDO_MAX) undoStack.shift();
  redoStack.length = 0;
}

const snapshot = (entry) => structuredClone(entry.data);
const sizeKeys = (entry) => (entry.kind === 'text' ? ['w', 'h'] : ['scale']);
// 没有的字段也要记成 undefined：「原来没有 w」撤销时得真的删掉 w，而不是留着新值
const pick = (data, keys) => Object.fromEntries(keys.map((k) => [k, data[k]]));

/** 把一组字段套到卡片上并回写服务端。undefined 表示删掉这个字段（服务端收 null） */
function applyFields(id, fields) {
  const entry = items.get(id);
  if (!entry) return false;
  const patch = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) delete entry.data[k];
    else entry.data[k] = v;
    patch[k] = v === undefined ? null : v;
  }
  placeEl(entry);
  if ('text' in fields) { renderTextBody(entry); renderMeta(entry); }
  patchItem(id, patch);
  return true;
}

async function restoreRemote(snap) {
  if (items.has(snap.id)) return true;
  const res = await fetch('/api/items/restore', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-token': token, 'x-client-id': CLIENT_ID },
    body: JSON.stringify({ item: snap }),
  }).catch(() => null);
  if (!res?.ok) return false;
  addItem((await res.json()).item);
  return true;
}

const undo = () => step(undoStack, redoStack, true);
const redo = () => step(redoStack, undoStack, false);

async function step(from, to, isUndo) {
  if (readOnly || undoBusy || editing) return;
  const op = from.pop();
  if (!op) return toast(isUndo ? '没有可以撤销的了' : '没有可以重做的了');
  undoBusy = true;
  try {
    let done = 0, total;
    if (op.type === 'patch') {
      total = op.changes.length;
      for (const c of op.changes) if (applyFields(c.id, isUndo ? c.before : c.after)) done++;
    } else {
      total = op.items.length;
      // 撤销删除、重做新建 → 放回去；反过来 → 删掉
      const bringBack = (op.type === 'delete') === isUndo;
      for (const snap of op.items) {
        const ok = bringBack
          ? await restoreRemote(snap)
          : !items.has(snap.id) || await deleteRemote(snap.id);
        if (ok) done++;
      }
    }
    to.push(op);
    // 卡片可能已经被别的标签页删了、原图被手动删了：做不了的跳过，但要说一声
    const miss = total - done;
    toast(`${isUndo ? '已撤销' : '已重做'}：${op.label}${miss ? `（${miss} 项已不在，跳过）` : ''}`, miss > 0);
  } finally {
    undoBusy = false;
  }
}

// ---------------------------------------------------------------- 指针交互

let drag = null;

// 卡片在屏幕上占的矩形，框选要用
function screenRect(entry) {
  const { x, y, scale } = entry.data;
  return {
    x0: x * view.s + view.x,
    y0: y * view.s + view.y,
    x1: (x + itemWidth(entry) * scale) * view.s + view.x,
    y1: (y + itemHeight(entry) * scale) * view.s + view.y,
  };
}

function updateMarquee() {
  const x0 = Math.min(drag.sx, drag.cx), x1 = Math.max(drag.sx, drag.cx);
  const y0 = Math.min(drag.sy, drag.cy), y1 = Math.max(drag.sy, drag.cy);
  marqueeEl.style.left = `${x0}px`;
  marqueeEl.style.top = `${y0}px`;
  marqueeEl.style.width = `${x1 - x0}px`;
  marqueeEl.style.height = `${y1 - y0}px`;

  // 框之前已经选上的保留（按住 Ctrl 可以框第二批），碰到框就算选中
  selection.clear();
  for (const id of drag.base) selection.add(id);
  for (const [id, entry] of items) {
    const r = screenRect(entry);
    if (r.x0 < x1 && r.x1 > x0 && r.y0 < y1 && r.y1 > y0) selection.add(id);
  }
  syncSelection();
}

viewport.addEventListener('pointerdown', (e) => {
  if (e.button > 2) return;
  const itemEl = e.target.closest('.item');
  // 点在操作胶囊上：交给按钮自己的 click，别当成拖拽起手
  if (e.target.closest('.item-actions')) return;
  // 拉伸手柄。放在「编辑中」判断之前：边写边拉宽是常见需求
  const handle = e.target.closest('.item-resize');
  if (handle && e.button === 0 && !readOnly) {
    const entry = items.get(itemEl.dataset.id);
    // 不然 mousedown 会把焦点从 textarea 抢走，编辑就被提交了
    e.preventDefault();
    if (!selection.has(entry.data.id)) select(entry.data.id);
    entry.el.classList.add('resizing');
    // 指针被 #viewport 捕获后光标会跟着它变，手动钉住拉伸光标
    viewport.style.cursor = getComputedStyle(handle).cursor;
    drag = {
      kind: 'resize', entry, edge: handle.dataset.edge, moved: false,
      sx: e.clientX, sy: e.clientY,
      w: itemWidth(entry),
      h: entry.data.h || entry.el.querySelector('.item-clip').offsetHeight,
      imgH: itemHeight(entry),
      scale: entry.data.scale,
      before: pick(entry.data, sizeKeys(entry)),
    };
    viewport.setPointerCapture(e.pointerId);
    return;
  }
  // 正在编辑的那张卡片交给 textarea 自己处理（放光标、选字），别抢去拖动
  if (editing && itemEl === editing.entry.el) return;
  // Ctrl / Shift 是「加选」修饰键：点卡片是加选，拉空白是框选
  const additive = e.shiftKey || e.ctrlKey || e.metaKey;

  // 右键拖 = 框选，从卡片上起手也行（左键在卡片上是拖动，右键不冲突）。
  // 拖动过了才算框选；没拖就松开是普通右键，照常弹浏览器菜单（图片上的「复制图片」还用得着）
  if (e.button === 2) {
    if (spaceDown) return;
    drag = {
      kind: 'marquee', byRightButton: true, sx: e.clientX, sy: e.clientY,
      cx: e.clientX, cy: e.clientY, base: new Set(additive ? selection : []), moved: false,
    };
    viewport.setPointerCapture(e.pointerId);
    return;
  }

  if (!itemEl) {
    if (additive && e.button === 0 && !spaceDown) {
      drag = {
        kind: 'marquee', sx: e.clientX, sy: e.clientY,
        cx: e.clientX, cy: e.clientY, base: new Set(selection), moved: false,
      };
      marqueeEl.hidden = false;
      updateMarquee();
    } else {
      drag = { kind: 'pan', sx: e.clientX, sy: e.clientY, ox: view.x, oy: view.y, moved: false };
      viewport.classList.add('panning');
    }
  } else if (e.button === 1 || spaceDown) {
    drag = { kind: 'pan', sx: e.clientX, sy: e.clientY, ox: view.x, oy: view.y, moved: false };
    viewport.classList.add('panning');
  } else {
    const entry = items.get(itemEl.dataset.id);
    if (additive) {
      toggleSelect(entry.data.id);
      // 刚被取消选中的那张就别跟着拖了
      if (!selection.has(entry.data.id)) { viewport.setPointerCapture(e.pointerId); return; }
    } else if (!selection.has(entry.data.id)) {
      select(entry.data.id);
    }
    // 点在选区里的卡片上先不收拢选区，否则整组拖不动；
    // 松手时发现只是「点了一下」没拖动，再收拢成这一张（见 endDrag）
    if (readOnly) {
      if (!additive) select(entry.data.id);
      viewport.setPointerCapture(e.pointerId);
      return;
    }
    // 选中多张时整组一起拖
    const group = selection.size > 1 && selection.has(entry.data.id)
      ? selectedEntries()
      : [entry];
    // 拖起来的图放到最上层，组内保持原有的前后关系
    let z = nextZ();
    for (const g of group.sort((a, b) => (a.data.z || 0) - (b.data.z || 0))) {
      g.data.z = z++;
      placeEl(g);
      g.el.classList.add('dragging');
    }
    drag = {
      kind: 'item', group, entry, additive, moved: false,
      sx: e.clientX, sy: e.clientY,
      origins: group.map((g) => ({ x: g.data.x, y: g.data.y })),
    };
  }
  viewport.setPointerCapture(e.pointerId);
});

viewport.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.sx;
  const dy = e.clientY - drag.sy;
  if (Math.abs(dx) > 3 || Math.abs(dy) > 3) drag.moved = true;

  if (drag.kind === 'pan') {
    view.x = drag.ox + dx;
    view.y = drag.oy + dy;
    applyView();
  } else if (drag.kind === 'marquee') {
    // 右键在没拖开之前还可能只是想弹菜单，先别动选区
    if (drag.byRightButton && !drag.moved) return;
    marqueeEl.hidden = false;
    drag.cx = e.clientX;
    drag.cy = e.clientY;
    updateMarquee();
  } else if (drag.kind === 'resize') {
    resizeTo(drag, dx, dy);
  } else {
    // 屏幕位移换算回世界坐标
    drag.group.forEach((entry, i) => {
      entry.data.x = drag.origins[i].x + dx / view.s;
      entry.data.y = drag.origins[i].y + dy / view.s;
      placeEl(entry);
    });
  }
});

function endDrag(e) {
  if (!drag) return;
  viewport.classList.remove('panning');
  if (drag.kind === 'item') {
    for (const entry of drag.group) entry.el.classList.remove('dragging');
    // 只是点了一下选区里的某张（没拖动）：收拢成单选
    if (!drag.moved && !drag.additive) select(drag.entry.data.id);
    // 拖完才回写一次，拖动过程中不打服务器
    if (drag.moved) {
      for (const entry of drag.group) {
        const { x, y, scale } = entry.data;
        patchItem(entry.data.id, { x, y, scale, bringToFront: true });
      }
      record({
        type: 'patch',
        label: drag.group.length > 1 ? `移动 ${drag.group.length} 项` : '移动',
        changes: drag.group.map((g, i) => ({
          id: g.data.id, before: drag.origins[i], after: { x: g.data.x, y: g.data.y },
        })),
      });
    }
  } else if (drag.kind === 'resize') {
    const { entry } = drag;
    entry.el.classList.remove('resizing');
    viewport.style.cursor = spaceDown ? 'grab' : '';
    // 草稿还没存到服务端，尺寸等提交时随 POST 一起带过去
    if (drag.moved && !entry.data.draft) {
      const after = pick(entry.data, sizeKeys(entry));
      applyFields(entry.data.id, after);
      record({ type: 'patch', label: '调整大小', changes: [{ id: entry.data.id, before: drag.before, after }] });
    }
  } else if (drag.kind === 'marquee') {
    marqueeEl.hidden = true;
    if (drag.byRightButton && drag.moved) suppressMenuUntil = performance.now() + 500;
  } else if (!drag.moved) {
    select(null); // 点空白 = 取消选中
  }
  drag = null;
  if (e) viewport.releasePointerCapture?.(e.pointerId);
}

// 右键框选松手后，浏览器紧接着会补一个 contextmenu（Windows 上是松手时触发），把它吞掉。
// 用时间窗而不是开关：万一这次没有补发，下一次正常右键也不会被误吞
let suppressMenuUntil = 0;
addEventListener('contextmenu', (e) => {
  if (performance.now() < suppressMenuUntil) {
    e.preventDefault();
    suppressMenuUntil = 0;
  }
});

const TEXT_MIN_W = 120, TEXT_MIN_H = 48;
const IMG_MIN_S = 0.15, IMG_MAX_S = 6;

function resizeTo(d, dx, dy) {
  const { entry } = d;
  // 屏幕位移 → 卡片自身坐标（再除掉卡片自己的 scale）
  const k = view.s * d.scale;
  if (entry.kind === 'text') {
    if (d.edge !== 's') entry.data.w = Math.round(Math.max(TEXT_MIN_W, d.w + dx / k));
    if (d.edge !== 'e') entry.data.h = Math.round(Math.max(TEXT_MIN_H, d.h + dy / k));
  } else {
    // 等比：把拖动量投影到对角线上，横着拉竖着拉都跟手
    const W = ITEM_W, H = d.imgH;
    const along = (dx * W + dy * H) / Math.hypot(W, H) / view.s;
    const next = d.scale * (1 + along / Math.hypot(W * d.scale, H * d.scale));
    entry.data.scale = Math.min(IMG_MAX_S, Math.max(IMG_MIN_S, next));
  }
  placeEl(entry);
}

/** 双击手柄＝复位：右边恢复默认宽度，下边/角恢复随内容的高度，图片回到原始大小 */
function resetSize(entry, edge) {
  if (readOnly) return;
  const keys = entry.kind !== 'text' ? ['scale'] : edge === 'e' ? ['w'] : ['h'];
  const before = pick(entry.data, keys);
  const after = entry.kind !== 'text' ? { scale: 1 } : edge === 'e' ? { w: undefined } : { h: undefined };
  if (entry.data.draft) {
    // 草稿还没上服务端，改本地就行，尺寸会随 POST 一起带过去
    for (const k of keys) { if (after[k] === undefined) delete entry.data[k]; else entry.data[k] = after[k]; }
    placeEl(entry);
    return;
  }
  applyFields(entry.data.id, after);
  record({ type: 'patch', label: '调整大小', changes: [{ id: entry.data.id, before, after }] });
}

viewport.addEventListener('pointerup', endDrag);
viewport.addEventListener('pointercancel', endDrag);

// pointerdown 里的 setPointerCapture 会把随后的 click/dblclick 的 target
// 重定向到 #viewport，所以这里不能信 e.target，得按坐标反查真正在下面的元素。
viewport.addEventListener('dblclick', (e) => {
  const under = document.elementFromPoint(e.clientX, e.clientY);
  const handle = under?.closest('.item-resize');
  if (handle) {
    const entry = items.get(handle.closest('.item').dataset.id);
    if (entry) resetSize(entry, handle.dataset.edge);
    return;
  }
  const itemEl = under?.closest('.item');

  // 双击空白处 = 新建一张文字卡片
  if (!itemEl) {
    if (readOnly) return toast('只读模式：请在这台电脑上用 localhost 打开', true);
    createDraftText((e.clientX - view.x) / view.s, (e.clientY - view.y) / view.s);
    return;
  }

  const entry = items.get(itemEl.dataset.id);
  if (!entry) return;
  // 文字双击进编辑，图片双击直接复制
  if (entry.kind === 'text') startEdit(entry);
  else copyItem(entry.data.id);
});

viewport.addEventListener('wheel', (e) => {
  // 指针停在有内容可滚的文字卡片上时，把滚轮让给它，别去缩放画布
  const scroller = document.elementFromPoint(e.clientX, e.clientY)?.closest('.text-body, .text-edit');
  if (scroller && scroller.scrollHeight > scroller.clientHeight) return;

  e.preventDefault();
  // 触控板捏合会带 ctrlKey，和滚轮走同一条路径，只是步长不同
  const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
  zoomAt(e.clientX, e.clientY, factor);
}, { passive: false });

// ---------------------------------------------------------------- 键盘

addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea')) return;
  if (e.code === 'Space' && !spaceDown) { spaceDown = true; viewport.style.cursor = 'grab'; }

  const mod = e.ctrlKey || e.metaKey;

  if (mod && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    e.shiftKey ? redo() : undo();
  } else if (mod && e.key.toLowerCase() === 'y') {
    e.preventDefault();
    redo();
  } else if (mod && e.key.toLowerCase() === 'a') {
    e.preventDefault();
    selectAll();
  } else if (mod && e.key.toLowerCase() === 'c' && selection.size) {
    e.preventDefault();
    copySelection();
  } else if ((e.key === 'Delete' || e.key === 'Backspace') && selection.size) {
    e.preventDefault();
    deleteSelection();
  } else if (e.key === '0') {
    resetView();
  } else if (e.key.toLowerCase() === 'f') {
    fitAll();
  } else if (e.key === 'Escape') {
    select(null);
  }
});

addEventListener('keyup', (e) => {
  if (e.code === 'Space') { spaceDown = false; viewport.style.cursor = ''; }
});

// ---------------------------------------------------------------- 按钮

// 卡片上的复制/编辑/删除：委托到 #world，省得每张卡各绑一遍
world.addEventListener('click', (e) => {
  const btn = e.target.closest('.item-actions button');
  if (!btn) return;
  e.stopPropagation();
  const id = btn.closest('.item')?.dataset.id;
  const entry = id && items.get(id);
  if (!entry) return;
  // 这张卡本来就在多选里，那按钮作用于整个选区，符合直觉
  const asGroup = selection.size > 1 && selection.has(id);
  if (btn.dataset.act === 'copy') asGroup ? copySelection() : copyItem(id);
  else if (btn.dataset.act === 'delete') asGroup ? deleteSelection() : deleteItem(id);
  else if (btn.dataset.act === 'edit') startEdit(entry);
});

document.getElementById('btn-sel-copy').onclick = () => copySelection();
document.getElementById('btn-sel-delete').onclick = () => deleteSelection();
document.getElementById('btn-sel-clear').onclick = () => select(null);

document.getElementById('btn-fit').onclick = () => fitAll();
document.getElementById('btn-reset').onclick = () => resetView();
document.getElementById('btn-clear').onclick = () => clearBoard();
document.getElementById('btn-folder').onclick = () => openFolder();

// ---------------------------------------------------------------- WebSocket

let ws = null;
let retry = 0;

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws?clientId=${CLIENT_ID}`);

  ws.onopen = () => {
    retry = 0;
    identityEl.dataset.status = 'on';
    statusEl.textContent = '已连接';
  };

  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'add') {
      const entry = addItem(msg.item, { fresh: true });
      if (followEl.checked) centerOn(entry);
      toast('收到新图');
    } else if (msg.type === 'move') {
      const entry = items.get(msg.item.id);
      // 正在被自己拖动或编辑的那张不要被覆盖
      if (entry && !drag?.group?.includes(entry) && editing?.entry !== entry) {
        Object.assign(entry.data, msg.item);
        // 「恢复默认宽度 / 高度随内容」在服务端是删掉 w / h，assign 删不掉本地的旧值
        for (const k of ['w', 'h']) if (!(k in msg.item)) delete entry.data[k];
        placeEl(entry);
        if (entry.kind === 'text') renderTextBody(entry);
      }
    } else if (msg.type === 'delete') {
      removeItemLocal(msg.id);
    } else if (msg.type === 'clear') {
      clearAllLocal();
      toast('白板已被清空');
    }
  };

  ws.onclose = () => {
    identityEl.dataset.status = 'off';
    statusEl.textContent = '已断开，重连中…';
    retry = Math.min(retry + 1, 6);
    setTimeout(connect, 400 * retry);
  };

  ws.onerror = () => ws.close();
}

// ---------------------------------------------------------------- toast

let toastTimer = null;
function toast(text, isError = false) {
  toastEl.textContent = text;
  toastEl.className = isError ? 'err' : '';
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, isError ? 5000 : 2200);
}

// ---------------------------------------------------------------- 启动

(async function boot() {
  const cfg = await fetch('/api/config').then((r) => r.json()).catch(() => ({}));
  token = cfg.token;
  readOnly = !token;
  document.getElementById('readonly').hidden = !readOnly;
  document.body.classList.toggle('read-only', readOnly);
  if (readOnly) {
    for (const id of ['btn-clear', 'btn-folder']) {
      document.getElementById(id).disabled = true;
    }
  }

  autoClearEl.checked = autoClearEnabled();
  autoClearEl.disabled = readOnly;
  autoClearEl.onchange = () => {
    setAutoClear(autoClearEl.checked);
    toast(autoClearEl.checked ? '以后重新打开网页会自动清空白板' : '已关闭：重新打开网页不再自动清空');
  };

  // 必须赶在拉取 items 之前，否则会先渲染一屏再抹掉，闪一下很难看
  let autoCleared = 0;
  if (!readOnly && autoClearEnabled() && isNewPageSession()) {
    autoCleared = await autoClearOnOpen();
  }

  const { items: list = [] } = await fetch('/api/items').then((r) => r.json()).catch(() => ({}));
  for (const data of list) addItem(data);
  updateEmpty();

  // 等图片解码出高度再算「适应全部」，否则 offsetHeight 还是 0（文字卡片没有 img）
  await Promise.all([...items.values()].filter((e) => e.img).map((e) => e.img.decode().catch(() => {})));
  if (items.size) fitAll(false); else resetView(false);

  if (autoCleared) {
    toast(`重新打开，已清空上次的 ${autoCleared} 项（图片原文件仍在 data/images/）`);
  }

  connect();
})();
