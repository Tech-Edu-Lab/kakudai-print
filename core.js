/* 拡大プリント core: 分割の計算と印刷用PDFの作成（ブラウザ / Node 共通）
 *
 * 座標の約束（すべて mm）
 *   仕上がり座標 (X, Y): 原稿の左上が原点、X 右向き・Y 下向き。仕上がりサイズ W × H。
 *   帯座標 (a, t): a = 紙を横につなぐ方向（across）、t = ロール紙が流れる方向（along）。
 *     cols（縦長の紙を横に並べる）: a = X, t = Y
 *     rows（横長の紙を縦に並べる）: a = Y, t = X（紙の上では 90°時計回りに回転）
 *   用紙座標 (u, v): 用紙の左上が原点、u 右向き・v 下向き。PDF は pt・左下原点に変換。
 *
 * 分割は「帯（strip）」× 「区間（seg）」。帯は a 方向の分割、区間は t 方向の分割で、
 * 1枚の紙が「1枚の最大の長さ」を超えるときだけ区間が2つ以上になる。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory;
  else root.KakudaiCore = factory(root.PDFLib);
})(typeof self !== 'undefined' ? self : this, function (PDFLib) {
  'use strict';

  const K = 72 / 25.4;      // mm → pt
  const ZONE = 40;          // 絵の先端・後端に付ける案内帯（最後に切り落とす）
  const SIDE = 16;          // 長さ方向に分けるとき、紙の両脇に取る合わせマーク用の帯
  const MARK_T = 16;        // 合わせマークの中心：絵の端からの距離
  const MARK_R = 6;         // 合わせマークの円の半径
  const SAFE = 8;           // のりしろのうち、継ぎ目側の「何も重ねない」幅
  const CUT_W = 0.5;        // 切り取り線の太さ
  const PDF_MAX_MM = 5080;  // PDF 1ページの標準の上限（200インチ）
  const CIRCLED = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳';
  const num = (i) => CIRCLED[i] || `(${i + 1})`;
  const fmt = (v) => Math.round(v).toLocaleString('ja-JP');

  // 2D アフィン行列 [a b c d e f]（PDF の cm と同じ並び）。mul(A, B) は「B のあと A」。
  const mul = (A, B) => [
    A[0] * B[0] + A[2] * B[1], A[1] * B[0] + A[3] * B[1],
    A[0] * B[2] + A[2] * B[3], A[1] * B[2] + A[3] * B[3],
    A[0] * B[4] + A[2] * B[5] + A[4], A[1] * B[4] + A[3] * B[5] + A[5],
  ];
  const ap = (M, x, y) => [M[0] * x + M[2] * y + M[4], M[1] * x + M[3] * y + M[5]];

  /** 1つの向きで分割を計算する。p: {W,H,rollW,mSide,mFeed,glue,bleed,nextOnTop,maxLen} */
  function planOne(p, orient, count) {
    const D = orient === 'cols' ? p.W : p.H;          // 横につなぐ方向の長さ
    const L = orient === 'cols' ? p.H : p.W;          // 紙の流れる方向の長さ
    const g = p.glue, e = p.bleed + CUT_W, ext = g + e;
    const extOf = (type) => (type === 'glue' ? g : type === 'cut' ? e : 0);
    const cap = (p.maxLen > 0 ? p.maxLen : 5000) - 2 * p.mFeed;   // 1枚に印刷できる長さ
    const base = { orient, D, L, P: p.rollW - 2 * p.mSide };
    if (!(D > 0 && L > 0)) return { ...base, ok: false, reason: '仕上がりサイズを入力してください。' };

    // 長さ方向：1枚に収まらなければ区間に分ける
    let M = 1;
    if (L + 2 * ZONE > cap) {
      const per = cap - ZONE - Math.max(g, e);
      if (per < 100) return { ...base, ok: false, reason: '「1枚の最大の長さ」が短すぎます。' };
      M = Math.max(2, Math.ceil(L / per - 1e-9));
    }
    const SZ = M > 1 ? SIDE : 0;
    const P = p.rollW - 2 * p.mSide - 2 * SZ;         // 絵に使える幅
    base.P = P;
    if (P < 50) return { ...base, ok: false, reason: 'ロール紙の幅に対して余白が大きすぎます。' };
    let nMin = 1;
    if (D > P + 1e-6) {
      if (P - ext < 20) return { ...base, ok: false, reason: 'のりしろが広すぎて、1枚に入る絵の幅が残りません。' };
      nMin = Math.ceil((D - ext) / (P - ext) - 1e-9);
    }
    const N = Math.max(nMin, Math.floor(count || 0));
    if (N * M > 60) return { ...base, ok: false, reason: `${N * M}枚に分かれます。仕上がりサイズを確かめてください。` };

    const strips = [];
    for (let i = 0; i < N; i++) {
      const startType = i === 0 ? 'edge' : p.nextOnTop ? 'cut' : 'glue';
      const endType = i === N - 1 ? 'edge' : p.nextOnTop ? 'glue' : 'cut';
      strips.push({ i, startType, endType, startExt: extOf(startType), endExt: extOf(endType) });
    }
    // 見える幅をそろえる。入らなければ「印刷する幅」をそろえる（必ず入る）。
    let v = strips.map(() => D / N);
    if (!strips.every((s, k) => v[k] + s.startExt + s.endExt <= P + 1e-6)) {
      const c = (D + (N - 1) * ext) / N;
      v = strips.map((s) => c - s.startExt - s.endExt);
    }
    let acc = 0;
    strips.forEach((s, k) => {
      s.vs = acc; acc += v[k]; s.ve = k === N - 1 ? D : acc;
      s.as = s.vs - s.startExt; s.ae = s.ve + s.endExt; s.c = s.ae - s.as;
      s.U0 = p.mSide + SZ + (P - s.c) / 2;           // 印刷できる範囲の中央に置く
    });
    const segs = [];
    for (let j = 0; j < M; j++) {
      const first = j === 0, last = j === M - 1;
      const startType = first ? 'edge' : p.nextOnTop ? 'cut' : 'glue';
      const endType = last ? 'edge' : p.nextOnTop ? 'glue' : 'cut';
      const ts = (L * j) / M, te = last ? L : (L * (j + 1)) / M;
      const ps = ts - extOf(startType), pe = te + extOf(endType);   // 印刷する範囲
      const head = first ? ZONE : 0, foot = last ? ZONE : 0;
      segs.push({ j, first, last, startType, endType, ts, te, ps, pe,
        vOff: p.mFeed + head - ps, PL: p.mFeed + head + (pe - ps) + foot + p.mFeed });
    }
    const PL = Math.max(...segs.map((s) => s.PL));
    return {
      ...base, ok: true, N, M, SZ, nMin, sheets: N * M, countClamped: count > 0 && count < nMin,
      g, b: p.bleed, e, strips, segs, V0: segs[0].vOff, PL, pageW: p.rollW,
      seams: strips.slice(0, -1).map((s) => s.ve), tseams: segs.slice(0, -1).map((s) => s.te),
      paper: N * segs.reduce((a, s) => a + s.PL, 0), tooLong: PL > PDF_MAX_MM, p,
    };
  }

  /** 両方の向きを計算し、指定（auto/cols/rows）に従って選ぶ。 */
  function plan(p, orientChoice, count) {
    const cols = planOne(p, 'cols', count), rows = planOne(p, 'rows', count);
    const score = (x) => (x.ok ? x.sheets * 1e4 + x.paper / 1e3 : 1e12);
    let chosen;
    if (orientChoice === 'cols') chosen = cols;
    else if (orientChoice === 'rows') chosen = rows;
    else chosen = score(rows) < score(cols) ? rows : cols;
    return { chosen, cols, rows };
  }

  /** 原稿を PDF に埋め込み、原稿の座標 → 仕上がり座標 の行列を返す。 */
  async function embedSource(doc, src, p) {
    if (src.kind === 'pdf') {
      const sd = await PDFLib.PDFDocument.load(src.bytes, { ignoreEncryption: true });
      const sp = sd.getPage(src.pageIndex || 0);
      const cb = sp.getCropBox();
      const obj = await doc.embedPage(sp, { left: cb.x, bottom: cb.y, right: cb.x + cb.width, top: cb.y + cb.height });
      const rot = (((sp.getRotation().angle || 0) % 360) + 360) % 360;
      const w = cb.width, h = cb.height;
      let R = [1, 0, 0, 1, 0, 0], dw = w, dh = h;
      if (rot === 90) { R = [0, -1, 1, 0, 0, w]; dw = h; dh = w; }
      else if (rot === 180) { R = [-1, 0, 0, -1, w, h]; }
      else if (rot === 270) { R = [0, 1, -1, 0, h, 0]; dw = h; dh = w; }
      return { obj, M: mul([p.W / dw, 0, 0, -p.H / dh, 0, p.H], R) };
    }
    const obj = src.mime === 'image/png' ? await doc.embedPng(src.bytes) : await doc.embedJpg(src.bytes);
    return { obj, M: [p.W, 0, 0, -p.H, 0, p.H] };
  }

  /** 印刷用PDF（1枚 = 1ページ）を作る。label(spec) → {bytes(PNG), w, h}(mm) */
  async function buildPdf(pl, src, label) {
    const { PDFDocument, StandardFonts, rgb, PDFName, pushGraphicsState, popGraphicsState,
      concatTransformationMatrix, rectangle, clip, endPath, drawObject } = PDFLib;
    const p = pl.p, N = pl.N, M = pl.M, L = pl.L, cols = pl.orient === 'cols';
    const INK = rgb(0.1, 0.1, 0.12), GRAY = rgb(0.5, 0.5, 0.52), WHITE = rgb(1, 1, 1), MAGENTA = rgb(0.89, 0, 0.5);
    const doc = await PDFDocument.create();
    doc.setTitle(`拡大プリント ${fmt(p.W)}×${fmt(p.H)}mm（${pl.sheets}枚）`);
    doc.setCreator('拡大プリント（のりしろ分割印刷）');
    const font = await doc.embedFont(StandardFonts.HelveticaBold);
    const source = await embedSource(doc, src, p);
    const cache = new Map();
    const getLabel = async (spec) => {
      const key = JSON.stringify(spec);
      if (!cache.has(key)) {
        const r = await label(spec);
        cache.set(key, { img: await doc.embedPng(r.bytes), w: r.w, h: r.h });
      }
      return cache.get(key);
    };
    const words = cols ? ['左', '右'] : ['上', '下'];
    const name = (i, j) => (M > 1 ? `${num(i)}-${j + 1}` : num(i));

    for (const s of pl.strips) for (const sg of pl.segs) {
      const page = doc.addPage([pl.pageW * K, sg.PL * K]);
      const S2U = cols ? [1, 0, 0, 1, s.U0 - s.as, sg.vOff] : [-1, 0, 0, 1, s.U0 + s.ae, sg.vOff];
      const S2P = mul([K, 0, 0, -K, 0, K * sg.PL], S2U);
      const F2S = cols ? [1, 0, 0, 1, 0, 0] : [0, 1, 1, 0, 0, 0];
      const pt = (a, t) => ap(S2P, a, t);
      const pdirX = cols ? 1 : -1;  // +a 方向が用紙の右(+1)か左(-1)か
      const tA = sg.first ? -ZONE + 3 : sg.ps, tB = sg.last ? L + ZONE - 3 : sg.pe;   // この紙に入る t の範囲

      // 1) 絵（この紙が受け持つ範囲だけを切り抜いて描く）
      const key = PDFName.of('KpSrc');
      page.node.setXObject(key, source.obj.ref);
      const [x0, y0] = pt(s.as, sg.ps), [x1, y1] = pt(s.ae, sg.pe);
      page.pushOperators(
        pushGraphicsState(),
        rectangle(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0)), clip(), endPath(),
        concatTransformationMatrix(...mul(S2P, mul(F2S, source.M))),
        drawObject(key),
        popGraphicsState(),
      );

      const line = (a1, t1, a2, t2, o = {}) => {
        const [xa, ya] = pt(a1, t1), [xb, yb] = pt(a2, t2);
        page.drawLine({ start: { x: xa, y: ya }, end: { x: xb, y: yb }, thickness: (o.w || 0.25) * K,
          color: o.color || INK, dashArray: o.dash ? o.dash.map((d) => d * K) : undefined });
      };
      const box = (a1, a2, t1, t2, color, opacity) => {
        const [xa, ya] = pt(a1, t1), [xb, yb] = pt(a2, t2);
        page.drawRectangle({ x: Math.min(xa, xb), y: Math.min(ya, yb), width: Math.abs(xb - xa), height: Math.abs(yb - ya), color, opacity });
      };
      const ring = (a, t, r) => {
        const [x, y] = pt(a, t);
        page.drawCircle({ x, y, size: r * K, color: undefined, borderColor: INK, borderWidth: 0.25 * K });
      };
      // 画像ラベルを置く。dir: 0=中央、+1/-1=その a 方向へ伸ばす
      const put = (lab, a, t, dir = 0) => {
        const [x, y] = pt(a, t), w = lab.w * K, h = lab.h * K;
        const px = dir * pdirX;
        const left = px > 0 ? x : px < 0 ? x - w : x - w / 2;
        page.drawImage(lab.img, { x: left, y: y - h / 2, width: w, height: h });
      };
      const mark = (a, t, r = MARK_R) => {
        ring(a, t, r); ring(a, t, 2);
        line(a - r - 3, t, a + r + 3, t); line(a, t - r - 3, a, t + r + 3);
      };
      const badge = (x, y, r) => {   // 用紙座標(pt)に番号の丸
        page.drawCircle({ x, y, size: r * K, color: INK });
        const str = String(s.i + 1), size = r * (str.length > 1 ? 1.05 : 1.3) * K;
        const w = font.widthOfTextAtSize(str, size);
        page.drawText(str, { x: x - w / 2, y: y - size * 0.36, size, font, color: WHITE });
      };

      // 2) 両脇（横の継ぎ目 / 外周）
      const sides = [
        { type: s.startType, sp: s.vs, dir: -1, nb: s.i - 1, word: words[0] },
        { type: s.endType, sp: s.ve, dir: 1, nb: s.i + 1, word: words[1] },
      ];
      const hintRows = [];
      if (sg.first) hintRows.push(-32.5);
      if (sg.last) hintRows.push(L + 32.5);
      const hintW = s.c >= 160 ? 44 : 0;
      for (const sd of sides) {
        if (sd.type === 'glue') {
          const a1 = sd.sp + sd.dir * SAFE, a2 = sd.sp + sd.dir * pl.g;
          if (pl.g - SAFE >= 3) {
            box(Math.min(a1, a2), Math.max(a1, a2), sg.ps, sg.pe, WHITE, 0.55);
            const size = Math.min(7, pl.g - SAFE - 2.5), len = sg.te - sg.ts;
            if (size >= 3 && len >= 120) {
              const lab = await getLabel({ kind: 'v', text: `のりしろ　${num(sd.nb)}を重ねる`, size });
              const n = Math.max(1, Math.floor(len / 450));
              for (let k = 0; k < n; k++) put(lab, sd.sp + sd.dir * (SAFE + pl.g) / 2, sg.ts + (len * (k + 0.5)) / n);
            }
          }
          if (hintW) {
            const lab = await getLabel({ kind: 'h', lines: [{ t: `のりしろ（${num(sd.nb)}を重ねる）`, s: 3.4, b: true }], maxW: hintW });
            for (const t of hintRows) put(lab, sd.sp + sd.dir * pl.g, t, -sd.dir);
          }
        } else if (sd.type === 'cut') {
          const ac = sd.sp + sd.dir * (pl.b + CUT_W / 2);
          line(ac, tA, ac, tB, { w: CUT_W, color: MAGENTA, dash: [3, 2] });
          if (hintW) {
            const lab = await getLabel({ kind: 'h', lines: [{ t: '✂ 点線のすぐ内側を切る', s: 3.4, b: true, c: '#c8006e' }], maxW: hintW });
            for (const t of hintRows) put(lab, sd.sp + sd.dir * (pl.b - 1), t, -sd.dir);
          }
        } else {
          if (sg.first) line(sd.sp, -12, sd.sp, -3, { color: GRAY });
          if (sg.last) line(sd.sp, L + 3, sd.sp, L + 12, { color: GRAY });
        }
        if (sd.type !== 'edge') {
          if (sg.first) mark(sd.sp, -MARK_T);
          if (sg.last) mark(sd.sp, L + MARK_T);
        }
      }

      // 3) 長さ方向の継ぎ目（同じ番号の紙どうしを先につなぐ）。合わせマークは両脇の帯に置く
      const ends = [
        { type: sg.startType, q: sg.ts, dir: -1, nb: sg.j - 1 },
        { type: sg.endType, q: sg.te, dir: 1, nb: sg.j + 1 },
      ];
      for (const en of ends) {
        if (en.type === 'edge') continue;
        if (en.type === 'glue') {
          const t1 = en.q + en.dir * SAFE, t2 = en.q + en.dir * pl.g;
          if (pl.g - SAFE >= 3) {
            box(s.as, s.ae, Math.min(t1, t2), Math.max(t1, t2), WHITE, 0.55);
            const size = Math.min(5, pl.g - SAFE - 3);
            if (size >= 2.5) {
              const lab = await getLabel({ kind: 'h', maxW: Math.max(40, s.c - 30), lines: [{ t: `${name(s.i, sg.j)}　のりしろ（${name(s.i, en.nb)}を重ねる）　※となりの番号と貼る前に、先にここをつなぐ`, s: size, b: true }] });
              put(lab, (s.vs + s.ve) / 2, en.q + en.dir * (SAFE + pl.g) / 2);
            }
          }
        } else {
          const tc = en.q + en.dir * (pl.b + CUT_W / 2);
          line(s.as - pl.SZ, tc, s.ae + pl.SZ, tc, { w: CUT_W, color: MAGENTA, dash: [3, 2] });
        }
        mark(s.as - 8, en.q, 5); mark(s.ae + 8, en.q, 5);
      }

      // 4) 仕上がり線（最後に外周を切るとき用）
      if (sg.first) line(s.as, -0.6, s.ae, -0.6, { color: GRAY, dash: [2, 2] });
      if (sg.last) line(s.as, L + 0.6, s.ae, L + 0.6, { color: GRAY, dash: [2, 2] });

      // 5) 中央の案内（番号・つなぎ方・サイズ）
      const mid = (s.vs + s.ve) / 2;
      const centerW = s.c - 2 * (hintW + 4) - 14;
      const sideText = (sd) => sd.type === 'cut' ? `${sd.word}側：点線で切り、${num(sd.nb)}ののりしろに重ねる`
        : sd.type === 'glue' ? `${sd.word}側：のりしろ（${num(sd.nb)}を上に重ねる）` : '';
      const l2 = (M > 1 ? `先に ${num(s.i)}-1〜${num(s.i)}-${M} を長さの方向につなぐ　／　` : '') +
        (sides.map(sideText).filter(Boolean).join('　／　') || (M > 1 ? '横の貼り合わせはありません' : 'この1枚で完成します'));
      const l3 = `仕上がり ${fmt(p.W)}×${fmt(p.H)}mm　用紙 ${fmt(pl.pageW)}×${fmt(sg.PL)}mm　倍率100%（実際のサイズ）で印刷` +
        (cols ? '' : '　※紙の右側が仕上がりの「上」');
      const l1 = `全${pl.sheets}枚のうち ${name(s.i, sg.j)}`;
      const rows = [];
      if (sg.first) rows.push([-32.5, [{ t: l1, s: 4.2, b: true }, { t: l2, s: 3.3 }, { t: l3, s: 2.7 }]]);
      if (sg.last) rows.push([L + 32.5, [{ t: `${l1}（紙の終わり）`, s: 3.6, b: true }, { t: l3, s: 2.7 }]]);
      for (const [row, lines] of rows) {
        if (centerW < 60) break;
        const lab = await getLabel({ kind: 'h', maxW: centerW, lines });
        const [cx, cy] = pt(mid, row);
        const w = lab.w * K, bw = 12 * K, x = cx - (w + bw) / 2;
        badge(x + 5 * K, cy, 5);
        page.drawImage(lab.img, { x: x + bw, y: cy - (lab.h * K) / 2, width: w, height: lab.h * K });
      }

      // 6) 100mm の確認線
      if (sg.first && s.ve - s.vs >= 150) {
        const t = -14;
        line(mid - 50, t, mid + 50, t, { w: 0.35 });
        line(mid - 50, t - 2.5, mid - 50, t + 2.5, { w: 0.35 }); line(mid + 50, t - 2.5, mid + 50, t + 2.5, { w: 0.35 });
        const lab = await getLabel({ kind: 'h', lines: [{ t: 'この線が100mmなら倍率OK', s: 2.6 }], maxW: 80 });
        const [cx, cy] = pt(mid, t + 4.5);
        page.drawImage(lab.img, { x: cx - (lab.w * K) / 2, y: cy - (lab.h * K) / 2, width: lab.w * K, height: lab.h * K });
      }
    }
    return doc.save();
  }

  /** テスト印刷：余白（印刷できない幅）と倍率を確かめる1ページ。 */
  async function buildTestPdf(p, label) {
    const { PDFDocument, StandardFonts, rgb } = PDFLib;
    const INK = rgb(0.1, 0.1, 0.12);
    const W = p.rollW, H = 300;
    const doc = await PDFDocument.create();
    doc.setTitle(`拡大プリント テスト印刷（幅${fmt(W)}mm）`);
    const font = await doc.embedFont(StandardFonts.HelveticaBold);
    const page = doc.addPage([W * K, H * K]);
    const L = (u1, v1, u2, v2, w = 0.2) => page.drawLine({ start: { x: u1 * K, y: (H - v1) * K }, end: { x: u2 * K, y: (H - v2) * K }, thickness: w * K, color: INK });
    const T = (str, u, v, size) => {
      const w = font.widthOfTextAtSize(str, size * K);
      page.drawText(str, { x: u * K - w / 2, y: (H - v) * K - size * K * 0.36, size: size * K, font, color: INK });
    };
    const tick = (n) => (n % 10 === 0 ? 6 : n % 5 === 0 ? 4 : 2.5);
    for (const v0 of [80, 225]) {               // 左右の端から 0〜30mm の目盛り
      L(0, v0, 30, v0); L(W - 30, v0, W, v0);
      for (let n = 0; n <= 30; n++) {
        L(n, v0, n, v0 + tick(n)); L(W - n, v0, W - n, v0 + tick(n));
        if (n % 5 === 0 && n) { T(String(n), n, v0 + 9, 2.4); T(String(n), W - n, v0 + 9, 2.4); }
      }
    }
    for (const u0 of [W * 0.3, W * 0.7]) {      // 上下の端から 0〜30mm の目盛り
      L(u0, 0, u0, 30); L(u0, H - 30, u0, H);
      for (let n = 0; n <= 30; n++) {
        L(u0, n, u0 + tick(n), n); L(u0, H - n, u0 + tick(n), H - n);
        if (n % 5 === 0 && n) { T(String(n), u0 + 10, n, 2.4); T(String(n), u0 + 10, H - n, 2.4); }
      }
    }
    const cx = W / 2;                           // 100mm の正方形と長い線
    L(cx - 50, 105, cx + 50, 105, 0.35); L(cx + 50, 105, cx + 50, 205, 0.35);
    L(cx + 50, 205, cx - 50, 205, 0.35); L(cx - 50, 205, cx - 50, 105, 0.35);
    T('100 mm', cx, 155, 4);
    const bar = Math.min(500, Math.floor((W - 80) / 100) * 100);
    if (bar >= 100) {
      L(cx - bar / 2, 245, cx + bar / 2, 245, 0.35);
      for (let k = 0; k <= bar / 100; k++) L(cx - bar / 2 + k * 100, 241, cx - bar / 2 + k * 100, 249, 0.35);
      T(`${bar} mm`, cx, 254, 3.2);
    }
    const lab = await label({ kind: 'h', maxW: Math.min(W - 90, 420), lines: [
      { t: 'テスト印刷（倍率100%・実際のサイズで印刷してください）', s: 4.6, b: true },
      { t: '① 正方形が 100mm、長い線が目盛りどおりの長さか、定規で測ります。', s: 3.4 },
      { t: '② 四辺の目盛りが「何mmから」印刷されているかを読みます。その数字が「印刷できない余白」です。', s: 3.4 },
      { t: `※ ロール紙の幅が ${fmt(W)}mm のときに正しく測れます。`, s: 3 },
    ] });
    const img = await doc.embedPng(lab.bytes);
    page.drawImage(img, { x: (cx - lab.w / 2) * K, y: (H - 52 - lab.h / 2) * K, width: lab.w * K, height: lab.h * K });
    return doc.save();
  }

  return { plan, planOne, buildPdf, buildTestPdf, mul, ap, num, fmt, consts: { K, ZONE, SIDE, MARK_T, MARK_R, SAFE, CUT_W, PDF_MAX_MM } };
});
