/* 拡大プリント labels: PDFに入れる日本語の案内文字を canvas で PNG にする
 * spec.kind === 'h' : 横書き（lines: [{t, s(mm), b(太字), c(色)}], maxW(mm) に収まるよう縮小）
 * spec.kind === 'v' : 縦書き（1文字ずつ縦に並べる。text, size(mm)）
 * 戻り値: { bytes: PNG(Uint8Array), w, h } … w, h は mm
 */
(function (root) {
  'use strict';
  const FONT = '"BIZ UDPGothic", "Yu Gothic", "YuGothic", "Meiryo", "Hiragino Sans", "Noto Sans JP", "IPAGothic", sans-serif';
  const PXMM = 10; // 1mm = 10px（約254dpi）

  async function ensureFont(font, text) {
    try { if (document.fonts && document.fonts.load) await document.fonts.load(font, text); } catch (e) { /* 代わりのフォントで描く */ }
  }
  function toPng(canvas) {
    return new Promise((resolve, reject) => canvas.toBlob(async (blob) => {
      if (!blob) return reject(new Error('ラベル画像を作れませんでした'));
      resolve(new Uint8Array(await blob.arrayBuffer()));
    }, 'image/png'));
  }

  async function renderLabel(spec) {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (spec.kind === 'v') {
      const chars = Array.from(spec.text), s = spec.size * PXMM, step = s * 1.08;
      const font = `700 ${s}px ${FONT}`;
      await ensureFont(font, spec.text);
      canvas.width = Math.ceil(s * 1.3);
      canvas.height = Math.ceil(chars.length * step + s * 0.4);
      ctx.fillStyle = 'rgba(255,255,255,0.78)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.font = font; ctx.fillStyle = '#2a2a2a'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      chars.forEach((ch, k) => { if (ch.trim()) ctx.fillText(ch, canvas.width / 2, s * 0.7 + k * step); });
      return { bytes: await toPng(canvas), w: canvas.width / PXMM, h: canvas.height / PXMM };
    }
    const lines = spec.lines.map((l) => ({ ...l, font: `${l.b ? 700 : 400} ${l.s * PXMM}px ${FONT}` }));
    for (const l of lines) await ensureFont(l.font, l.t);
    let widest = 1;
    for (const l of lines) { ctx.font = l.font; widest = Math.max(widest, ctx.measureText(l.t).width); }
    const scale = Math.min(1, (spec.maxW * PXMM) / widest);
    const gap = 0.35;
    const heights = lines.map((l) => l.s * PXMM * scale * 1.25);
    canvas.width = Math.ceil(widest * scale) + 2;
    canvas.height = Math.ceil(heights.reduce((a, h) => a + h, 0) + gap * PXMM * (lines.length - 1)) + 2;
    ctx.textBaseline = 'middle';
    let y = 1;
    lines.forEach((l, k) => {
      ctx.font = `${l.b ? 700 : 400} ${l.s * PXMM * scale}px ${FONT}`;
      ctx.fillStyle = l.c || '#1a1a1e';
      ctx.fillText(l.t, 1, y + heights[k] / 2);
      y += heights[k] + gap * PXMM;
    });
    return { bytes: await toPng(canvas), w: canvas.width / PXMM, h: canvas.height / PXMM };
  }

  root.KakudaiLabels = { renderLabel, FONT };
})(typeof self !== 'undefined' ? self : this);
