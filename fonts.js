/* 拡大プリント fonts: フォントの読み込みと、文字を輪郭（パス）にする処理
 * フォントは fonts/<key>.js（base64）を必要になったときに読み込む（手元のファイルで開いても動くように script で読む）。
 * 文字の輪郭は「文字の大きさ＝1」の単位で、文字ブロックの中心を原点（y 下向き）として SVG パスにする。
 */
(function (root) {
  'use strict';
  const LIST = [
    { key: 'gothic', name: 'ゴシック（太字）', credit: 'BIZ UDPGothic Bold' },
    { key: 'pop', name: '極太ゴシック', credit: 'Dela Gothic One' },
    { key: 'maru', name: '丸ゴシック', credit: 'Zen Maru Gothic Black' },
    { key: 'mincho', name: '明朝（極太）', credit: 'Zen Old Mincho Black' },
    { key: 'fude', name: '筆文字', credit: 'Yuji Syuku' },
  ];
  const data = {}, loaded = {}, pending = {}, listeners = [];
  root.KakudaiFontData = { put: (key, b64) => { data[key] = b64; } };

  function loadScript(src) {
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src; s.onload = res; s.onerror = () => rej(new Error('フォントを読み込めませんでした: ' + src));
      document.head.appendChild(s);
    });
  }
  function load(key) {
    if (!LIST.some((f) => f.key === key)) key = 'gothic';
    if (loaded[key]) return Promise.resolve(loaded[key]);
    if (!pending[key]) {
      pending[key] = (async () => {
        if (!data[key]) await loadScript(`fonts/${key}.js`);
        const bin = atob(data[key]);
        delete data[key];
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const font = root.fontkit.create(bytes);
        const os2 = font['OS/2'];
        let asc = os2 && os2.typoAscender, desc = os2 && os2.typoDescender;
        if (!(asc > 0)) { asc = font.ascent; desc = font.descent; }
        loaded[key] = { key, font, asc, em: asc - desc, cache: new Map() };
        layouts.clear();
        listeners.forEach((fn) => fn(key));
        return loaded[key];
      })();
      pending[key].catch(() => { delete pending[key]; });
    }
    return pending[key];
  }
  const get = (key) => loaded[key] || null;

  function glyph(F, ch, vertical) {
    const ck = (vertical ? 'v' : 'h') + ch;
    if (F.cache.has(ck)) return F.cache.get(ck);
    let g = null;
    try {
      const run = F.font.layout(ch, vertical ? ['vert'] : undefined);
      const gl = run.glyphs[0];
      if (gl && gl.id !== 0) g = { cmds: gl.path.commands, adv: run.positions[0].xAdvance / F.em };
    } catch (e) { g = null; }
    F.cache.set(ck, g);
    return g;
  }

  const f4 = (v) => String(Math.round(v * 10000) / 10000);
  const layouts = new Map();

  /** 文字の配置を計算して輪郭にする。フォントが未読込なら null（読み込みを始める）。 */
  function layout(item) {
    const F = get(item.font);
    if (!F) { load(item.font).catch(() => {}); return null; }
    const fb = item.font !== 'gothic' ? get('gothic') : null;
    const key = JSON.stringify([item.text, item.font, !!item.vertical, item.align, item.lineGap, item.letterGap, !!fb]);
    if (layouts.has(key)) return layouts.get(key);
    const lg = +item.lineGap || 0, sp = +item.letterGap || 0, missing = new Set();
    const pick = (ch, vertical) => {
      let g = glyph(F, ch, vertical), FF = F;
      if (!g && fb) { g = glyph(fb, ch, vertical); FF = fb; }
      if (!g) missing.add(ch);
      return g ? { g, F: FF } : null;
    };
    const lines = String(item.text || '').split('\n');
    const parts = [];
    let w, h;
    if (!item.vertical) {
      const rows = lines.map((line) => {
        const chars = Array.from(line).map((ch) => ({ p: pick(ch, false) }));
        const width = chars.reduce((a, c, i) => a + (c.p ? c.p.g.adv : 1) + (i < chars.length - 1 ? sp : 0), 0);
        return { chars, width };
      });
      w = Math.max(0.001, ...rows.map((r) => r.width));
      h = rows.length + (rows.length - 1) * lg;
      rows.forEach((r, i) => {
        const top = -h / 2 + i * (1 + lg);
        let x = item.align === 'left' ? -w / 2 : item.align === 'right' ? w / 2 - r.width : -r.width / 2;
        for (const c of r.chars) {
          if (c.p) parts.push({ g: c.p.g, F: c.p.F, x, base: top + c.p.F.asc / c.p.F.em });
          x += (c.p ? c.p.g.adv : 1) + sp;
        }
      });
    } else {                                          // 縦書き：右の行から左へ
      const cols = lines.map((line) => {
        const chars = Array.from(line).map((ch) => ({ p: pick(ch, true), cell: ch === ' ' ? 0.5 : 1 }));
        const len = chars.reduce((a, c, i) => a + c.cell + (i < chars.length - 1 ? sp : 0), 0);
        return { chars, len };
      });
      w = cols.length + (cols.length - 1) * lg;
      h = Math.max(0.001, ...cols.map((c) => c.len));
      cols.forEach((col, i) => {
        const cx = w / 2 - 0.5 - i * (1 + lg);
        let y = item.align === 'left' ? -h / 2 : item.align === 'right' ? h / 2 - col.len : -col.len / 2;
        for (const c of col.chars) {
          if (c.p) parts.push({ g: c.p.g, F: c.p.F, x: cx - c.p.g.adv / 2, base: y + c.p.F.asc / c.p.F.em });
          y += c.cell + sp;
        }
      });
    }
    const out = [];
    for (const p of parts) {
      const s = 1 / p.F.em;
      for (const c of p.g.cmds) {
        const a = c.args, X = (i) => f4(p.x + a[i] * s), Y = (i) => f4(p.base - a[i + 1] * s);
        if (c.command === 'moveTo') out.push('M', X(0), Y(0));
        else if (c.command === 'lineTo') out.push('L', X(0), Y(0));
        else if (c.command === 'quadraticCurveTo') out.push('Q', X(0), Y(0), X(2), Y(2));
        else if (c.command === 'bezierCurveTo') out.push('C', X(0), Y(0), X(2), Y(2), X(4), Y(4));
        else if (c.command === 'closePath') out.push('Z');
      }
    }
    const res = { d: out.join(' '), w, h, missing: [...missing] };
    if (layouts.size > 300) layouts.clear();
    layouts.set(key, res);
    return res;
  }

  root.KakudaiFonts = { LIST, load, get, layout, onLoad: (fn) => listeners.push(fn) };
})(typeof self !== 'undefined' ? self : this);
