/* 拡大プリント design: デザイン（背景・文字・画像・四角）の描画と、1枚もののPDF化
 * 位置 x, y は仕上がりの幅・高さに対する割合（要素の中心）。
 * 大きさは U = min(幅, 高さ) に対する割合（四角だけは w が幅、h が高さに対する割合）。
 * 文字の縁取りの太さ strokeW は文字の大きさに対する割合。サイズを変えても配置が崩れにくい。
 */
(function (root) {
  'use strict';
  const Fonts = root.KakudaiFonts;
  const K = 72 / 25.4;
  let seq = 0;
  const newId = () => 'e' + Date.now().toString(36) + (seq++).toString(36);
  const T = (o) => ({ id: newId(), type: 'text', text: '文字', font: 'gothic', size: 0.2, color: '#1b2420', stroke: '', strokeW: 0.06,
    vertical: false, align: 'center', lineGap: 0.2, letterGap: 0, x: 0.5, y: 0.5, ...o });
  const R = (o) => ({ id: newId(), type: 'rect', x: 0.5, y: 0.5, w: 0.6, h: 0.2, fill: '#f2c94c', stroke: '', strokeW: 0.01, ...o });

  /** 要素の絶対位置（mm）：中心 cx, cy と幅 w, 高さ h。文字は輪郭データ L と文字の大きさ s も返す */
  function geom(it, W, H) {
    const U = Math.min(W, H), cx = it.x * W, cy = it.y * H;
    if (it.type === 'text') {
      const s = it.size * U, L = Fonts.layout(it), sx = it.sx || 1, sy = it.sy || 1;
      if (L) return { cx, cy, w: L.w * s * sx, h: L.h * s * sy, s, L, sx, sy };
      const lines = String(it.text || ' ').split('\n'), n = Math.max(...lines.map((l) => Array.from(l).length), 1);
      return it.vertical ? { cx, cy, w: lines.length * s * sx, h: n * s * sy, s, L: null, sx, sy } : { cx, cy, w: n * s * sx, h: lines.length * s * sy, s, L: null, sx, sy };
    }
    if (it.type === 'image') { const w = it.w * U; return { cx, cy, w, h: w * it.ar }; }
    return { cx, cy, w: it.w * W, h: it.h * H };
  }

  // 文字の輪郭を横 sx 倍・縦 sy 倍に伸縮したもの（縁取りの太さは変えないよう、輪郭の座標そのものを伸縮する）
  const shapes = new WeakMap();
  function shaped(L, sx, sy) {
    let m = shapes.get(L);
    if (!m) { m = new Map(); shapes.set(L, m); }
    const key = sx + ',' + sy;
    let r = m.get(key);
    if (!r) {
      let d = L.d, n = 0;
      if (sx !== 1 || sy !== 1) d = L.d.replace(/-?\d+(\.\d+)?/g, (t) => String(Math.round(parseFloat(t) * (n++ % 2 ? sy : sx) * 10000) / 10000));
      r = { d, path: null };
      if (m.size > 20) m.clear();
      m.set(key, r);
    }
    return r;
  }
  function drawItem(ctx, it, W, H, k, images) {
    const g = geom(it, W, H), x = (g.cx - g.w / 2) * k, y = (g.cy - g.h / 2) * k;
    if (it.type === 'rect') {
      if (it.fill) { ctx.fillStyle = it.fill; ctx.fillRect(x, y, g.w * k, g.h * k); }
      if (it.stroke && it.strokeW > 0) {
        ctx.strokeStyle = it.stroke; ctx.lineWidth = it.strokeW * Math.min(W, H) * k; ctx.strokeRect(x, y, g.w * k, g.h * k);
      }
    } else if (it.type === 'image') {
      const im = images[it.img];
      if (im && im.bmp) ctx.drawImage(im.bmp, x, y, g.w * k, g.h * k);
      else { ctx.fillStyle = 'rgba(120,130,125,0.35)'; ctx.fillRect(x, y, g.w * k, g.h * k); }
    } else if (it.type === 'text') {
      if (!g.L) {                                     // フォントの読み込み中
        ctx.save(); ctx.setLineDash([6, 4]); ctx.strokeStyle = 'rgba(120,130,125,0.8)'; ctx.lineWidth = 1;
        ctx.strokeRect(x, y, g.w * k, g.h * k); ctx.restore();
        return;
      }
      if (!g.L.d) return;
      const sh = shaped(g.L, g.sx, g.sy);
      if (!sh.path) sh.path = new Path2D(sh.d);
      const p = sh.path;
      ctx.save();
      ctx.translate(g.cx * k, g.cy * k); ctx.scale(g.s * k, g.s * k);
      if (it.stroke && it.strokeW > 0) { ctx.lineJoin = 'round'; ctx.lineWidth = it.strokeW * 2; ctx.strokeStyle = it.stroke; ctx.stroke(p); }
      ctx.fillStyle = it.color; ctx.fill(p);
      ctx.restore();
    }
  }
  /** デザイン全体を描く（k = 1mm あたりの画面の点の数） */
  function render(ctx, d, W, H, k, images) {
    ctx.fillStyle = d.bg || '#ffffff'; ctx.fillRect(0, 0, W * k, H * k);
    for (const it of d.items) drawItem(ctx, it, W, H, k, images);
  }
  /** プレビュー用に縮小した絵 */
  function bitmap(d, W, H, images, maxPx) {
    const k = maxPx / Math.max(W, H), c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(W * k)); c.height = Math.max(1, Math.round(H * k));
    render(c.getContext('2d'), d, W, H, k, images);
    return c;
  }
  function hit(d, W, H, mx, my) {
    for (let i = d.items.length - 1; i >= 0; i--) {
      const g = geom(d.items[i], W, H);
      if (Math.abs(mx - g.cx) <= g.w / 2 && Math.abs(my - g.cy) <= g.h / 2) return d.items[i];
    }
    return null;
  }
  /** 使っているフォントを読み込む（足りない文字があればゴシックも） */
  async function ensureFonts(d) {
    const keys = [...new Set(d.items.filter((i) => i.type === 'text').map((i) => i.font))];
    await Promise.all(keys.map((k) => Fonts.load(k)));
    if (keys.some((k) => k !== 'gothic') && d.items.some((i) => i.type === 'text' && (Fonts.layout(i) || { missing: [] }).missing.length)) await Fonts.load('gothic');
  }
  const col = (hex) => {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    const v = m ? parseInt(m[1], 16) : 0;
    return PDFLib.rgb(((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255);
  };
  /** 仕上がりサイズ 1ページのPDF（文字は輪郭＝ベクターで描く） */
  async function toPdf(d, W, H, images) {
    const { PDFDocument, pushGraphicsState, popGraphicsState, setLineJoin, LineJoinStyle } = PDFLib;
    await ensureFonts(d);
    const doc = await PDFDocument.create();
    doc.setTitle(`拡大プリント デザイン ${Math.round(W)}×${Math.round(H)}mm`);
    const page = doc.addPage([W * K, H * K]);
    page.drawRectangle({ x: 0, y: 0, width: W * K, height: H * K, color: col(d.bg || '#ffffff') });
    const embedded = {};
    for (const it of d.items) {
      const g = geom(it, W, H), x = (g.cx - g.w / 2) * K, y = (H - g.cy - g.h / 2) * K;
      if (it.type === 'rect') {
        const hasStroke = it.stroke && it.strokeW > 0;
        if (!it.fill && !hasStroke) continue;
        page.drawRectangle({ x, y, width: g.w * K, height: g.h * K, color: it.fill ? col(it.fill) : undefined,
          borderColor: hasStroke ? col(it.stroke) : undefined, borderWidth: hasStroke ? it.strokeW * Math.min(W, H) * K : 0 });
      } else if (it.type === 'image') {
        const im = images[it.img];
        if (!im) continue;
        if (!embedded[it.img]) embedded[it.img] = im.mime === 'image/png' ? await doc.embedPng(im.bytes) : await doc.embedJpg(im.bytes);
        page.drawImage(embedded[it.img], { x, y, width: g.w * K, height: g.h * K });
      } else if (it.type === 'text' && g.L && g.L.d) {
        const base = { x: g.cx * K, y: (H - g.cy) * K, scale: g.s * K };
        if (it.stroke && it.strokeW > 0) {
          page.pushOperators(pushGraphicsState(), setLineJoin(LineJoinStyle.Round));
          page.drawSvgPath(shaped(g.L, g.sx, g.sy).d, { ...base, borderColor: col(it.stroke), borderWidth: it.strokeW * 2 });
          page.pushOperators(popGraphicsState());
        }
        page.drawSvgPath(shaped(g.L, g.sx, g.sy).d, { ...base, color: col(it.color) });
      }
    }
    return doc.save();
  }

  const TEMPLATES = [
    { key: 'banner', name: '横断幕（3600×900mm）', W: 3600, H: 900, make: () => ({ bg: '#ffffff', items: [
      R({ x: 0.5, y: 0.5, w: 0.97, h: 0.88, fill: '', stroke: '#c8102e', strokeW: 0.012 }),
      T({ text: '祝　全国大会出場', font: 'fude', size: 0.42, color: '#c8102e', x: 0.5, y: 0.43 }),
      T({ text: '○○中学校　吹奏楽部', font: 'gothic', size: 0.12, x: 0.78, y: 0.84 }),
    ] }) },
    { key: 'tare', name: '垂れ幕・縦書き（900×4000mm）', W: 900, H: 4000, make: () => ({ bg: '#123c7a', items: [
      T({ text: '祝　県大会優勝', font: 'fude', vertical: true, size: 0.46, color: '#ffffff', x: 0.5, y: 0.4005 }),
      T({ text: '陸上競技部', font: 'gothic', vertical: true, size: 0.15, color: '#f2c94c', x: 0.5, y: 0.877 }),
    ] }) },
    { key: 'poster', name: 'ポスター（A0 縦 841×1189mm）', W: 841, H: 1189, make: () => ({ bg: '#fffaf0', items: [
      R({ x: 0.5, y: 0.14, w: 1, h: 0.28, fill: '#1d7350' }),
      T({ text: '文化祭', font: 'pop', size: 0.24, color: '#ffffff', x: 0.5, y: 0.14 }),
      T({ text: '11月21日（土）・22日（日）', font: 'gothic', size: 0.06, x: 0.5, y: 0.36 }),
      T({ text: '体育館で合唱と演劇\n各教室で展示とバザー', font: 'maru', size: 0.06, lineGap: 0.5, x: 0.5, y: 0.6 }),
      T({ text: 'どなたでもご来場ください', font: 'gothic', size: 0.045, color: '#1d7350', x: 0.5, y: 0.88 }),
    ] }) },
    { key: 'blank', name: '白紙（今のサイズのまま）', make: () => ({ bg: '#ffffff', items: [] }) },
  ];

  root.KakudaiDesign = { geom, render, bitmap, hit, ensureFonts, toPdf, newText: T, newRect: R, newId, TEMPLATES };
})(typeof self !== 'undefined' ? self : this);
