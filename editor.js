/* かくピタくん editor: この画面で横断幕・ポスターを作る（文字・画像・四角を置いて動かす） */
(function (root) {
  'use strict';
  const Design = root.KakudaiDesign, Fonts = root.KakudaiFonts;
  const $ = (id) => document.getElementById(id);
  const DRAFT = 'kakudai-print:draft';
  const E = { design: { bg: '#ffffff', items: [] }, images: {}, sel: null, undo: [], redo: [], k: 1, drag: null, guide: null, ver: 0, bmp: null, bmpKey: '', active: false };
  let O = null;                                   // app から渡される関数（getSize, setSize, getPlan, onChange, loadImage, status, offerFile）
  const size = () => O.getSize();
  const U = () => { const { W, H } = size(); return Math.min(W, H); };
  const selItem = () => E.design.items.find((i) => i.id === E.sel) || null;
  const r1 = (v) => Math.round(v * 10) / 10;

  // ---------- 元に戻す・やり直す ----------
  let lastTag = '', lastTime = 0;
  const snap = () => { const { W, H } = size(); return JSON.stringify({ d: E.design, W, H }); };
  function checkpoint(tag) {
    const now = Date.now();
    if (tag && tag === lastTag && now - lastTime < 1500) { lastTime = now; return; }
    E.undo.push(snap()); if (E.undo.length > 80) E.undo.shift();
    E.redo = []; lastTag = tag || ''; lastTime = now; syncButtons();
  }
  function restoreSnap(s) {
    const o = JSON.parse(s), { W, H } = size();
    E.design = o.d; if (o.W !== W || o.H !== H) O.setSize(o.W, o.H);
    if (!selItem()) E.sel = null;
    lastTag = ''; $('bgColor').value = E.design.bg; changed();
  }
  function undo() { if (E.undo.length) { E.redo.push(snap()); restoreSnap(E.undo.pop()); } }
  function redo() { if (E.redo.length) { E.undo.push(snap()); restoreSnap(E.redo.pop()); } }
  function syncButtons() { $('undoBtn').disabled = !E.undo.length; $('redoBtn').disabled = !E.redo.length; }
  function changed() { E.ver++; draw(); fillProps(); syncButtons(); saveDraftSoon(); O.onChange(); }

  // ---------- 描画 ----------
  function draw() {
    const cv = $('stage');
    if (!E.active || !cv) return;
    const box = $('stageBox'), cs = getComputedStyle(box);
    const bw = box.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const { W, H } = size();
    const k = Math.min(bw / W, Math.max(220, Math.min(560, root.innerHeight * 0.62)) / H);
    if (!(k > 0 && isFinite(k))) return;
    E.k = k;
    const dpr = Math.min(2, root.devicePixelRatio || 1);
    cv.width = Math.max(1, Math.round(W * k * dpr)); cv.height = Math.max(1, Math.round(H * k * dpr));
    cv.style.width = Math.round(W * k) + 'px'; cv.style.height = Math.round(H * k) + 'px';
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    Design.render(ctx, E.design, W, H, k, E.images);
    const pl = O.getPlan();
    if ($('seamChk').checked && pl && pl.ok && (pl.N > 1 || pl.M > 1)) {   // 紙の継ぎ目
      ctx.save(); ctx.setLineDash([6, 4]); ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(214,0,122,0.9)';
      for (const s of pl.seams) {
        ctx.beginPath();
        if (pl.orient === 'cols') { ctx.moveTo(s * k, 0); ctx.lineTo(s * k, H * k); } else { ctx.moveTo(0, s * k); ctx.lineTo(W * k, s * k); }
        ctx.stroke();
      }
      for (const q of pl.tseams) {                     // 長さ方向の継ぎ目
        ctx.beginPath();
        if (pl.orient === 'cols') { ctx.moveTo(0, q * k); ctx.lineTo(W * k, q * k); } else { ctx.moveTo(q * k, 0); ctx.lineTo(q * k, H * k); }
        ctx.stroke();
      }
      ctx.restore();
    }
    if (E.guide) {                                   // 中央にそろったときの案内線
      ctx.save(); ctx.strokeStyle = 'rgba(0,150,255,0.9)'; ctx.lineWidth = 1;
      if (E.guide.x) { ctx.beginPath(); ctx.moveTo(W * k / 2, 0); ctx.lineTo(W * k / 2, H * k); ctx.stroke(); }
      if (E.guide.y) { ctx.beginPath(); ctx.moveTo(0, H * k / 2); ctx.lineTo(W * k, H * k / 2); ctx.stroke(); }
      ctx.restore();
    }
    const it = selItem();
    if (it) {
      const g = Design.geom(it, W, H), x = (g.cx - g.w / 2) * k - 3, y = (g.cy - g.h / 2) * k - 3, w = g.w * k + 6, h = g.h * k + 6;
      ctx.save();
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.strokeRect(x, y, w, h);
      ctx.lineWidth = 1.5; ctx.strokeStyle = '#1d7350'; ctx.setLineDash([5, 3]); ctx.strokeRect(x, y, w, h); ctx.setLineDash([]);
      ctx.fillStyle = '#ffffff';
      for (const [, hx, hy] of handlePts(it, g)) { ctx.fillRect(hx - 6, hy - 6, 12, 12); ctx.strokeRect(hx - 6, hy - 6, 12, 12); }
      ctx.restore();
    }
  }

  // ---------- マウス・タッチ ----------
  function toMm(e) { const r = $('stage').getBoundingClientRect(); return [(e.clientX - r.left) / E.k, (e.clientY - r.top) / E.k]; }
  // つまみ：右下＝全体の拡大縮小、右辺＝横だけ、下辺＝縦だけ（画像は比率を保つので右下のみ）
  function handlePts(it, g) {
    const k = E.k, R = (g.cx + g.w / 2) * k + 3, B = (g.cy + g.h / 2) * k + 3;
    const pts = [['resize', R, B]];
    if (it.type !== 'image') pts.push(['ex', R, g.cy * k], ['ey', g.cx * k, B]);
    return pts;
  }
  function handleAt(it, e) {
    const { W, H } = size(), g = Design.geom(it, W, H), r = $('stage').getBoundingClientRect();
    const px = e.clientX - r.left, py = e.clientY - r.top;
    const h = handlePts(it, g).find(([, hx, hy]) => Math.abs(px - hx) <= 11 && Math.abs(py - hy) <= 11);
    return h ? h[0] : null;
  }
  function onDown(e) {
    if (e.button !== 0) return;
    $('stage').focus();
    const { W, H } = size(), [mx, my] = toMm(e);
    let it = selItem(), mode = (it && handleAt(it, e)) || 'move';
    if (mode === 'move') { it = Design.hit(E.design, W, H, mx, my); E.sel = it ? it.id : null; fillProps(); draw(); }
    E.drag = it ? { mode, mx, my, orig: { ...it }, g0: Design.geom(it, W, H), moved: false } : null;
    if (E.drag) { $('stage').setPointerCapture(e.pointerId); e.preventDefault(); }
  }
  function onMove(e) {
    const d = E.drag, it = selItem();
    if (!d || !it) return;
    const { W, H } = size(), [mx, my] = toMm(e);
    if (!d.moved) { if (Math.hypot(mx - d.mx, my - d.my) * E.k < 3) return; checkpoint(); d.moved = true; }
    const g = d.g0;
    if (d.mode === 'move') {
      let cx = g.cx + (mx - d.mx), cy = g.cy + (my - d.my);
      const tol = 8 / E.k;
      E.guide = { x: Math.abs(cx - W / 2) < tol, y: Math.abs(cy - H / 2) < tol };
      if (E.guide.x) cx = W / 2;
      if (E.guide.y) cy = H / 2;
      it.x = cx / W; it.y = cy / H;
    } else if (d.mode === 'ex') {                      // 横だけ伸縮
      const nw = Math.max(2, 2 * Math.abs(mx - g.cx));
      if (it.type === 'rect') it.w = nw / W; else it.sx = (d.orig.sx || 1) * nw / g.w;
    } else if (d.mode === 'ey') {                      // 縦だけ伸縮
      const nh = Math.max(2, 2 * Math.abs(my - g.cy));
      if (it.type === 'rect') it.h = nh / H; else it.sy = (d.orig.sy || 1) * nh / g.h;
    } else if (it.type === 'rect') {
      it.w = Math.max(2, 2 * Math.abs(mx - g.cx)) / W; it.h = Math.max(2, 2 * Math.abs(my - g.cy)) / H;
    } else {
      const f = Math.max(0.05, Math.hypot(mx - g.cx, my - g.cy) / Math.max(1e-6, Math.hypot(d.mx - g.cx, d.my - g.cy)));
      if (it.type === 'text') it.size = d.orig.size * f; else it.w = d.orig.w * f;
    }
    draw();
  }
  function onUp() {
    const moved = E.drag && E.drag.moved;
    E.drag = null; E.guide = null;
    if (moved) changed(); else draw();
  }
  function onKey(e) {
    const mod = e.ctrlKey || e.metaKey, key = e.key.toLowerCase();
    if (mod && key === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
    if (mod && key === 'y') { e.preventDefault(); redo(); return; }
    const it = selItem();
    if (!it) return;
    const { W, H } = size(), st = e.shiftKey ? 10 : 1;
    const mv = { arrowleft: [-st, 0], arrowright: [st, 0], arrowup: [0, -st], arrowdown: [0, st] }[key];
    if (mv) { e.preventDefault(); checkpoint('key'); it.x += mv[0] / W; it.y += mv[1] / H; changed(); }
    else if (key === 'delete' || key === 'backspace') { e.preventDefault(); removeSel(); }
  }

  // ---------- 右側の設定欄 ----------
  function fillProps() {
    const it = selItem(), { W, H } = size(), u = Math.min(W, H);
    syncSwatches();
    $('propsEmpty').hidden = !!it;
    for (const id of ['pText', 'pImage', 'pRect', 'pCommon']) $(id).hidden = true;
    if (!it) return;
    const set = (id, v) => { const el = $(id); if (el === document.activeElement) return; if (el.type === 'checkbox') el.checked = !!v; else el.value = v; };
    $('pCommon').hidden = false;
    set('cX', r1(it.x * W)); set('cY', r1(it.y * H));
    if (it.type === 'text') {
      $('pText').hidden = false;
      set('tText', it.text); set('tFont', it.font); set('tSize', r1(it.size * u)); set('tColor', it.color);
      set('tStrokeOn', !!it.stroke); set('tStroke', it.stroke || '#ffffff'); set('tStrokeW', r1(it.strokeW * it.size * u));
      set('tSx', Math.round((it.sx || 1) * 100)); set('tSy', Math.round((it.sy || 1) * 100));
      set('tVert', it.vertical); set('tAlign', it.align); set('tLine', Math.round(it.lineGap * 100)); set('tLetter', Math.round(it.letterGap * 100));
      const L = Fonts.layout(it);
      $('tMissing').textContent = !L ? 'フォントを読み込んでいます…' : L.missing.length ? `このフォントにない文字：${L.missing.join(' ')}` : '';
    } else if (it.type === 'image') {
      $('pImage').hidden = false;
      set('iW', r1(it.w * u));
      const im = E.images[it.img];
      $('iInfo').textContent = im ? `${im.pxW}×${im.pxH}ピクセル・印刷すると約${Math.round(im.pxW / (it.w * u / 25.4))}dpi` : '';
    } else {
      $('pRect').hidden = false;
      set('rFillOn', !!it.fill); set('rFill', it.fill || '#f2c94c'); set('rStrokeOn', !!it.stroke); set('rStroke', it.stroke || '#1b2420');
      set('rStrokeW', r1(it.strokeW * u)); set('rW', r1(it.w * W)); set('rH', r1(it.h * H));
    }
  }
  function bindProp(id, apply, evt) {
    $(id).addEventListener(evt || 'input', () => {
      const it = selItem(), el = $(id);
      if (!it) return;
      const v = el.type === 'checkbox' ? el.checked : el.type === 'number' ? parseFloat(el.value) : el.value;
      if (el.type === 'number' && !isFinite(v)) return;
      checkpoint(id); apply(it, v); changed();
    });
  }
  function bindAll() {
    bindProp('tText', (it, v) => { it.text = v; });
    bindProp('tFont', (it, v) => { it.font = v; Fonts.load(v).catch(() => O.status('フォントを読み込めませんでした。', 'error')); }, 'change');
    bindProp('tSize', (it, v) => { if (v > 0) it.size = v / U(); });
    bindProp('tColor', (it, v) => { it.color = v; });
    bindProp('tSx', (it, v) => { if (v > 0) it.sx = v / 100; });
    bindProp('tSy', (it, v) => { if (v > 0) it.sy = v / 100; });
    bindProp('tStrokeOn', (it, v) => { it.stroke = v ? $('tStroke').value : ''; }, 'change');
    bindProp('tStroke', (it, v) => { it.stroke = v; $('tStrokeOn').checked = true; });
    bindProp('tStrokeW', (it, v) => { if (v >= 0) it.strokeW = v / (it.size * U()); });
    bindProp('tVert', (it, v) => { it.vertical = v; }, 'change');
    bindProp('tAlign', (it, v) => { it.align = v; }, 'change');
    bindProp('tLine', (it, v) => { it.lineGap = v / 100; });
    bindProp('tLetter', (it, v) => { it.letterGap = v / 100; });
    bindProp('iW', (it, v) => { if (v > 0) it.w = v / U(); });
    bindProp('rFillOn', (it, v) => { it.fill = v ? $('rFill').value : ''; }, 'change');
    bindProp('rFill', (it, v) => { it.fill = v; $('rFillOn').checked = true; });
    bindProp('rStrokeOn', (it, v) => { it.stroke = v ? $('rStroke').value : ''; }, 'change');
    bindProp('rStroke', (it, v) => { it.stroke = v; $('rStrokeOn').checked = true; });
    bindProp('rStrokeW', (it, v) => { if (v >= 0) it.strokeW = v / U(); });
    bindProp('rW', (it, v) => { if (v > 0) it.w = v / size().W; });
    bindProp('rH', (it, v) => { if (v > 0) it.h = v / size().H; });
    bindProp('cX', (it, v) => { it.x = v / size().W; });
    bindProp('cY', (it, v) => { it.y = v / size().H; });
    const act = (id, fn) => $(id).addEventListener('click', () => { const it = selItem(); if (it) { checkpoint(); fn(it); changed(); } });
    act('cCenterX', (it) => { it.x = 0.5; });
    act('cCenterY', (it) => { it.y = 0.5; });
    act('cFront', (it) => { const a = E.design.items; a.push(a.splice(a.indexOf(it), 1)[0]); });
    act('cBack', (it) => { const a = E.design.items; a.unshift(a.splice(a.indexOf(it), 1)[0]); });
    act('cDup', (it) => { const c = { ...it, id: Design.newId(), x: it.x + 0.02, y: it.y + 0.02 }; E.design.items.push(c); E.sel = c.id; });
    $('cDel').addEventListener('click', removeSel);
    $('tFit').addEventListener('click', async () => {
      const it = selItem();
      if (!it || it.type !== 'text') return;
      await Fonts.load(it.font).catch(() => {});
      const L = Fonts.layout(it), { W, H } = size();
      if (!L) return;
      checkpoint(); it.size = Math.min((0.92 * W) / (L.w * (it.sx || 1)), (0.86 * H) / (L.h * (it.sy || 1))) / U(); changed();
    });
    // 追加
    $('addText').addEventListener('click', () => add(Design.newText({ text: '文字を入力', size: 0.25 })));
    $('addRect').addEventListener('click', () => add(Design.newRect({ w: 0.5, h: 0.25 })));
    $('addImage').addEventListener('click', () => { $('imgFile').dataset.replace = ''; $('imgFile').click(); });
    $('iReplace').addEventListener('click', () => { $('imgFile').dataset.replace = '1'; $('imgFile').click(); });
    $('imgFile').addEventListener('change', async (e) => {
      const f = e.target.files && e.target.files[0], replace = $('imgFile').dataset.replace === '1';
      e.target.value = '';
      if (!f) return;
      try {
        const im = await O.loadImage(new Uint8Array(await f.arrayBuffer()), f.type || 'image/png', f.name);
        const id = Design.newId(); E.images[id] = im;
        const it = selItem();
        if (replace && it && it.type === 'image') { checkpoint(); it.img = id; it.ar = im.pxH / im.pxW; changed(); return; }
        const { W, H } = size(), wMm = Math.min(W * 0.5, (H * 0.5 * im.pxW) / im.pxH);
        add({ id: Design.newId(), type: 'image', img: id, x: 0.5, y: 0.5, w: wMm / U(), ar: im.pxH / im.pxW });
      } catch (err) { O.status('画像を読み込めませんでした。PNG・JPEG の画像を選んでください。', 'error'); }
    });
    $('bgColor').addEventListener('input', () => { checkpoint('bg'); E.design.bg = $('bgColor').value; changed(); });
    $('undoBtn').addEventListener('click', undo);
    $('redoBtn').addEventListener('click', redo);
    $('seamChk').addEventListener('change', draw);
    let armed = 0;
    $('tplApply').addEventListener('click', () => {
      if (E.design.items.length && Date.now() - armed > 4000) {
        armed = Date.now(); $('tplApply').textContent = 'もう一度押すと置きかえます';
        setTimeout(() => { $('tplApply').textContent = 'ひな形にする'; }, 4000);
        return;
      }
      armed = 0; $('tplApply').textContent = 'ひな形にする';
      const t = Design.TEMPLATES.find((x) => x.key === $('tplSel').value) || Design.TEMPLATES[0];
      checkpoint(); if (t.W) O.setSize(t.W, t.H);
      E.design = t.make(); E.sel = null; $('bgColor').value = E.design.bg; changed();
    });
    $('saveDesign').addEventListener('click', async () => {
      const res = await O.offerFile('かくピタくん_デザイン.json', JSON.stringify(serialize(true)), 'application/json');
      if (res !== 'declined' && res !== 'busy') O.status('デザインを保存しました。「デザインを開く」で続きから編集できます。', 'ok');
    });
    $('openDesign').addEventListener('click', () => $('designFile').click());
    $('designFile').addEventListener('change', async (e) => {
      const f = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!f) return;
      try { checkpoint(); await restore(JSON.parse(await f.text())); changed(); O.status('デザインを開きました。', 'ok'); }
      catch (err) { O.status('このファイルは開けませんでした。かくピタくんで保存したデザイン（.json）を選んでください。', 'error'); }
    });
    const st = $('stage');
    // 作業面・設定欄・道具の列・色パレット以外を押したら、選択を外して設定欄を閉じる
    document.addEventListener('pointerdown', (e) => {
      if (!E.sel || e.target.closest('#stage, .ed-props, .ed-bar, .palette')) return;
      E.sel = null; fillProps(); draw();
    });
    st.addEventListener('pointerdown', onDown);
    st.addEventListener('pointermove', onMove);
    st.addEventListener('pointerup', onUp);
    st.addEventListener('pointercancel', onUp);
    st.addEventListener('keydown', onKey);
    st.addEventListener('dblclick', () => { const it = selItem(); if (it && it.type === 'text') { $('tText').focus(); $('tText').select(); } });
  }
  function add(it) { checkpoint(); E.design.items.push(it); E.sel = it.id; changed(); if (it.type === 'text') { $('tText').focus(); $('tText').select(); } }
  function removeSel() { const it = selItem(); if (!it) return; checkpoint(); E.design.items.splice(E.design.items.indexOf(it), 1); E.sel = null; changed(); }

  // ---------- 色パレット ----------
  const PALETTE = [
    ['#000000', '黒'], ['#4d4d4d', '濃い灰色'], ['#9e9e9e', '灰色'], ['#ffffff', '白'], ['#fff3c4', 'クリーム'],
    ['#c8102e', '赤'], ['#e60012', '朱赤'], ['#f39800', 'オレンジ'], ['#ffd400', '黄'], ['#c9a227', '金茶'],
    ['#8fc31f', '黄緑'], ['#009944', '緑'], ['#1d7350', '深緑'], ['#00a0e9', '水色'], ['#0068b7', '青'],
    ['#123c7a', '紺'], ['#920783', '紫'], ['#e4007f', 'ピンク'], ['#f6b3c8', 'うすピンク'], ['#7b4a12', '茶'],
  ];
  let pop = null, popInput = null;
  function syncSwatches() {
    document.querySelectorAll('.swatch-btn').forEach((b) => { b.firstChild.style.background = b.nextElementSibling.value; });
  }
  function closePalette() { if (pop) pop.hidden = true; popInput = null; }
  function openPalette(btn, input) {
    if (!pop) {
      pop = document.createElement('div'); pop.className = 'palette'; pop.hidden = true;
      const grid = document.createElement('div'); grid.className = 'palette-grid';
      for (const [c, name] of PALETTE) {
        const s = document.createElement('button');
        s.type = 'button'; s.className = 'palette-color'; s.style.background = c; s.title = name; s.setAttribute('aria-label', name); s.dataset.color = c;
        grid.appendChild(s);
      }
      const more = document.createElement('button');
      more.type = 'button'; more.className = 'tool palette-more'; more.textContent = 'その他の色…';
      pop.append(grid, more);
      document.body.appendChild(pop);
      grid.addEventListener('click', (e) => {
        const c = e.target.dataset && e.target.dataset.color;
        if (!c || !popInput) return;
        const input2 = popInput;
        input2.value = c; input2.dispatchEvent(new Event('input', { bubbles: true }));
        closePalette(); syncSwatches();
      });
      more.addEventListener('click', () => { const input2 = popInput; closePalette(); if (input2) input2.click(); });
      document.addEventListener('pointerdown', (e) => { if (pop && !pop.hidden && !pop.contains(e.target) && !e.target.closest('.swatch-btn')) closePalette(); });
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePalette(); });
    }
    if (popInput === input) { closePalette(); return; }
    popInput = input; pop.hidden = false;
    pop.querySelectorAll('.palette-color').forEach((s) => s.classList.toggle('is-current', s.dataset.color === input.value.toLowerCase()));
    const r = btn.getBoundingClientRect(), pw = pop.offsetWidth;
    pop.style.left = Math.max(8, Math.min(r.left, document.documentElement.clientWidth - pw - 8)) + root.scrollX + 'px';
    pop.style.top = r.bottom + 6 + root.scrollY + 'px';
  }
  function setupPalette() {
    document.querySelectorAll('#editor input[type="color"]').forEach((input) => {
      const btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'swatch-btn'; btn.setAttribute('aria-label', '色を選ぶ');
      btn.appendChild(document.createElement('span'));
      input.parentNode.insertBefore(btn, input);
      input.classList.add('color-native');
      btn.addEventListener('click', (e) => { e.preventDefault(); openPalette(btn, input); });
      input.addEventListener('input', syncSwatches);
    });
  }

  // ---------- 保存・下書き ----------
  function b64(bytes) { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); }
  function unb64(str) { const bin = atob(str), out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }
  function serialize(withImages) {
    const { W, H } = size(), images = {};
    if (withImages) for (const it of E.design.items) if (it.type === 'image' && E.images[it.img]) images[it.img] = { mime: E.images[it.img].mime, b64: b64(E.images[it.img].bytes) };
    return { app: 'kakudai-print', version: 1, W, H, design: E.design, images };
  }
  async function restore(o) {
    if (!o || o.app !== 'kakudai-print' || !o.design || !Array.isArray(o.design.items)) throw new Error('形式が違います');
    for (const [id, v] of Object.entries(o.images || {})) { try { E.images[id] = await O.loadImage(unb64(v.b64), v.mime, id); } catch (e) { /* 読めない画像は外す */ } }
    if (o.W > 0 && o.H > 0) O.setSize(o.W, o.H);
    E.design = { bg: o.design.bg || '#ffffff', items: o.design.items.filter((i) => i.type !== 'image' || E.images[i.img]) };
    E.sel = null; $('bgColor').value = E.design.bg;
  }
  let draftTimer = 0;
  function saveDraftSoon() { clearTimeout(draftTimer); draftTimer = setTimeout(saveDraft, 800); }
  function saveDraft() {
    try {
      let s = JSON.stringify(serialize(true));
      if (s.length > 3500000) s = JSON.stringify(serialize(false));
      localStorage.setItem(DRAFT, s);
    } catch (e) { /* 保存できない環境でも動く */ }
  }

  async function init(opts) {
    O = opts;
    for (const f of Fonts.LIST) $('tFont').add(new Option(f.name, f.key));
    for (const t of Design.TEMPLATES) $('tplSel').add(new Option(t.name, t.key));
    setupPalette();
    bindAll();
    Fonts.onLoad(() => { E.ver++; draw(); fillProps(); O.onChange(); });
    let restored = false;
    try { const s = localStorage.getItem(DRAFT); if (s) { await restore(JSON.parse(s)); restored = true; } } catch (e) { restored = false; }
    if (!restored) { const t = Design.TEMPLATES[0]; O.setSize(t.W, t.H); E.design = t.make(); }
    $('bgColor').value = E.design.bg;
    E.ver++; syncButtons(); fillProps();
    return restored;
  }
  function warnings() {
    const { W, H } = size(), u = Math.min(W, H), out = [];
    const miss = new Set();
    for (const it of E.design.items) {
      if (it.type === 'text') { const L = Fonts.layout(it); if (L) L.missing.forEach((c) => miss.add(c)); }
      if (it.type === 'image' && E.images[it.img]) {
        const dpi = E.images[it.img].pxW / (it.w * u / 25.4);
        if (dpi < 25) out.push(['warn', `画像の解像度が低めです（約${Math.round(dpi)}dpi）。近くで見ると粗く見えます。`]);
      }
    }
    if (miss.size) out.push(['warn', `フォントにない文字は印刷されません：${[...miss].join(' ')}`]);
    return out;
  }

  root.KakudaiEditor = {
    init, draw, warnings,
    setActive(on) { E.active = on; draw(); },
    sizeChanged() { E.ver++; draw(); fillProps(); saveDraftSoon(); },
    isEmpty: () => !E.design.items.length,
    toPdf() { const { W, H } = size(); return Design.toPdf(E.design, W, H, E.images); },
    bitmap(maxPx) {
      const { W, H } = size(), key = `${E.ver}:${W}:${H}:${maxPx}`;
      if (E.bmpKey !== key) { E.bmp = Design.bitmap(E.design, W, H, E.images, maxPx); E.bmpKey = key; }
      return E.bmp;
    },
  };
})(typeof self !== 'undefined' ? self : this);
