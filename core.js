/* かくピタくん core: 分割の計算と印刷用PDFの作成（ブラウザ / Node 共通）
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
  const K_PT = K;
  const TEST_LEN = 130;     // テスト印刷の紙の長さ
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
    const Z = p.guide === false ? 0 : ZONE;            // 案内の帯（印刷しない設定なら 0）
    const lap = p.join !== 'cut';                      // 横の継ぎ目を切らずに重ねるか
    const g = p.glue, e = p.bleed + CUT_W, ext = g + (lap ? 0 : e);
    const extOf = (type) => (type === 'glue' ? g : type === 'cut' ? e : 0);
    const cap = (p.maxLen > 0 ? p.maxLen : 5000) - 2 * p.mFeed;   // 1枚に印刷できる長さ
    const base = { orient, D, L, P: p.rollW - 2 * p.mSide };
    if (!(D > 0 && L > 0)) return { ...base, ok: false, reason: '仕上がりサイズを入力してください。' };

    // 長さ方向：1枚に収まらなければ区間に分ける
    let M = 1;
    if (L + 2 * Z > cap) {
      const per = cap - Z - Math.max(g, e);
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

    // 横の継ぎ目で上に重ねる側：'lap' = 切らずに紙の端をそのまま重ねる、'cut' = 点線で切ってから重ねる
    const top = lap ? 'lap' : 'cut';
    const strips = [];
    for (let i = 0; i < N; i++) {
      const startType = i === 0 ? 'edge' : p.nextOnTop ? top : 'glue';
      const endType = i === N - 1 ? 'edge' : p.nextOnTop ? 'glue' : top;
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
      // 紙の両端の位置（帯座標）。rows は紙の上で a が逆向きになる
      s.pa0 = orient === 'cols' ? s.as - s.U0 : s.ae + s.U0 - p.rollW;
      s.pa1 = s.pa0 + p.rollW;
      // 絵を描く範囲。切らずに重ねる側は、紙の端まで絵をのばす（印刷できない余白の分だけが白く残る）
      s.cs = s.startType === 'lap' ? s.pa0 : s.as;
      s.ce = s.endType === 'lap' ? s.pa1 : s.ae;
      s.clipU0 = orient === 'cols' ? s.U0 + (s.cs - s.as) : s.U0 + (s.ae - s.ce);
      s.clipW = s.ce - s.cs;
    });
    // 切らずに重ねるとき：下になる紙に「となりの紙の端を合わせる線」を引く位置（継ぎ目からの距離）
    strips.forEach((s, k) => {
      s.startLap = s.startType === 'lap' ? s.vs - s.pa0 : 0;
      s.endLap = s.endType === 'lap' ? s.pa1 - s.ve : 0;
    });
    strips.forEach((s, k) => {
      s.startGuide = s.startType === 'glue' && lap ? strips[k - 1].endLap : 0;
      s.endGuide = s.endType === 'glue' && lap ? strips[k + 1].startLap : 0;
    });
    // 長さ方向の区切り：どのページも同じ長さになるように、区間ごとの絵の長さを決める
    // （プリンタのドライバに登録する用紙サイズが1つで済む）
    const segs = [];
    for (let j = 0; j < M; j++) {
      const first = j === 0, last = j === M - 1;
      const startType = first ? 'edge' : p.nextOnTop ? 'cut' : 'glue';
      const endType = last ? 'edge' : p.nextOnTop ? 'glue' : 'cut';
      const head = first ? Z : 0, foot = last ? Z : 0;
      segs.push({ j, first, last, startType, endType, head, foot, over: head + foot + extOf(startType) + extOf(endType) });
    }
    const X = (L + segs.reduce((a, s) => a + s.over, 0)) / M;     // 1ページのうち、上下の余白を除いた長さ
    const PL = Math.ceil(X + 2 * p.mFeed - 1e-6);                  // ページの長さ（整数 mm に切り上げ。余りは紙の終わりの白い部分）
    let tAcc = 0;
    for (const sg of segs) {
      sg.ts = tAcc; tAcc += X - sg.over; sg.te = sg.last ? L : tAcc;
      sg.ps = sg.ts - extOf(sg.startType); sg.pe = sg.te + extOf(sg.endType);   // 印刷する範囲
      sg.vOff = p.mFeed + sg.head - sg.ps;
      sg.PL = PL;
    }
    return {
      ...base, ok: true, N, M, SZ, nMin, sheets: N * M, countClamped: count > 0 && count < nMin,
      g, b: p.bleed, e, lap, Z, strips, segs, V0: segs[0].vOff, PL, pageW: p.rollW,
      needLen: Math.ceil(L + 2 * Z + 2 * p.mFeed),   // 長さ方向に分けないために必要な「1枚の最大の長さ」
      seams: strips.slice(0, -1).map((s) => s.ve), tseams: segs.slice(0, -1).map((s) => s.te),
      paper: N * M * PL, tooLong: PL > PDF_MAX_MM, p,
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
    // 5,080mm を超えるページは、PDF の拡張（UserUnit：1単位を何倍にするか）で表す
    const uu = pl.PL > PDF_MAX_MM ? Math.ceil(pl.PL / PDF_MAX_MM) : 1, K = K_PT / uu;
    const INK = rgb(0.1, 0.1, 0.12), GRAY = rgb(0.5, 0.5, 0.52), WHITE = rgb(1, 1, 1), MAGENTA = rgb(0.89, 0, 0.5);
    const doc = await PDFDocument.create();
    doc.setTitle(`かくピタくん ${fmt(p.W)}×${fmt(p.H)}mm（${pl.sheets}枚）`);
    doc.setCreator('かくピタくん（のりしろ分割印刷）');
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
      if (uu > 1) page.node.set(PDFName.of('UserUnit'), PDFLib.PDFNumber.of(uu));
      const S2U = cols ? [1, 0, 0, 1, s.U0 - s.as, sg.vOff] : [-1, 0, 0, 1, s.U0 + s.ae, sg.vOff];
      const S2P = mul([K, 0, 0, -K, 0, K * sg.PL], S2U);
      const F2S = cols ? [1, 0, 0, 1, 0, 0] : [0, 1, 1, 0, 0, 0];
      const pt = (a, t) => ap(S2P, a, t);
      const pdirX = cols ? 1 : -1;  // +a 方向が用紙の右(+1)か左(-1)か
      const Z = pl.Z, zf = sg.first && Z > 0, zl = sg.last && Z > 0;          // 案内の帯があるか
      const tA = sg.first ? (Z ? -Z + 3 : 0) : sg.ps, tB = sg.last ? (Z ? L + Z - 3 : L) : sg.pe;   // この紙に入る t の範囲

      // 1) 絵（この紙が受け持つ範囲だけを切り抜いて描く）
      const key = PDFName.of('KpSrc');
      page.node.setXObject(key, source.obj.ref);
      const [x0, y0] = pt(s.cs, sg.ps), [x1, y1] = pt(s.ce, sg.pe);
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
        { type: s.startType, sp: s.vs, dir: -1, nb: s.i - 1, word: words[0], guide: s.startGuide },
        { type: s.endType, sp: s.ve, dir: 1, nb: s.i + 1, word: words[1], guide: s.endGuide },
      ];
      const hintRows = [];
      if (zf) hintRows.push(-32.5);
      if (zl) hintRows.push(L + 32.5);
      const hintW = s.c >= 160 ? 44 : 0;
      for (const sd of sides) {
        if (sd.type === 'glue') {
          const a1 = sd.sp + sd.dir * SAFE, a2 = sd.sp + sd.dir * pl.g;
          if (pl.g - SAFE >= 3) {
            box(Math.min(a1, a2), Math.max(a1, a2), sg.ps, sg.pe, WHITE, 0.55);
            const size = Math.min(7, pl.g - SAFE - 2.5), len = sg.te - sg.ts;
            if (size >= 3 && len >= 120) {
              const lab = await getLabel({ kind: 'v', text: Z ? `のりしろ　${num(sd.nb)}を重ねる` : `${num(s.i)}の紙　のりしろ　${num(sd.nb)}を重ねる`, size });
              const n = Math.max(1, Math.floor(len / 450));
              for (let k = 0; k < n; k++) put(lab, sd.sp + sd.dir * (SAFE + pl.g) / 2, sg.ts + (len * (k + 0.5)) / n);
            }
          }
          if (hintW) {
            const lab = await getLabel({ kind: 'h', lines: [{ t: sd.guide ? `${num(sd.nb)}の紙の端を線に合わせる` : `のりしろ（${num(sd.nb)}を重ねる）`, s: 3.4, b: true }], maxW: hintW });
            for (const t of hintRows) put(lab, sd.sp + sd.dir * pl.g, t, -sd.dir);
          }
          if (sd.guide) {                               // 切らずに重ねる：となりの紙の端を合わせる線（重ねると隠れる）
            const ag = sd.sp - sd.dir * (sd.guide - 0.6);
            line(ag, tA, ag, tB, { w: 0.35, color: MAGENTA });
            for (const t of [zf ? -MARK_T : null, zl ? L + MARK_T : null]) {
              if (t !== null) line(sd.sp - sd.dir * (sd.guide + 15), t, sd.sp, t);
            }
          }
        } else if (sd.type === 'lap') {
          if (hintW) {
            const lab = await getLabel({ kind: 'h', lines: [{ t: `切らずに${num(sd.nb)}の線へ重ねる`, s: 3.4, b: true, c: '#c8006e' }], maxW: hintW });
            for (const t of hintRows) put(lab, sd.sp - sd.dir * 2, t, -sd.dir);
          }
        } else if (sd.type === 'cut') {
          const ac = sd.sp + sd.dir * (pl.b + CUT_W / 2);
          line(ac, tA, ac, tB, { w: CUT_W, color: MAGENTA, dash: [3, 2] });
          if (hintW) {
            const lab = await getLabel({ kind: 'h', lines: [{ t: '✂ 点線のすぐ内側を切る', s: 3.4, b: true, c: '#c8006e' }], maxW: hintW });
            for (const t of hintRows) put(lab, sd.sp + sd.dir * (pl.b - 1), t, -sd.dir);
          }
        } else {
          if (zf) line(sd.sp, -12, sd.sp, -3, { color: GRAY });
          if (zl) line(sd.sp, L + 3, sd.sp, L + 12, { color: GRAY });
        }
        if (sd.type !== 'edge') {
          if (zf) mark(sd.sp, -MARK_T);
          if (zl) mark(sd.sp, L + MARK_T);
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
            box(s.cs, s.ce, Math.min(t1, t2), Math.max(t1, t2), WHITE, 0.55);
            const size = Math.min(5, pl.g - SAFE - 3);
            if (size >= 2.5) {
              const lab = await getLabel({ kind: 'h', maxW: Math.max(40, s.c - 30), lines: [{ t: `${name(s.i, sg.j)}　のりしろ（${name(s.i, en.nb)}を重ねる）　※となりの番号と貼る前に、先にここをつなぐ`, s: size, b: true }] });
              put(lab, (s.vs + s.ve) / 2, en.q + en.dir * (SAFE + pl.g) / 2);
            }
          }
        } else {
          const tc = en.q + en.dir * (pl.b + CUT_W / 2);
          line(Math.min(s.cs, s.as - pl.SZ), tc, Math.max(s.ce, s.ae + pl.SZ), tc, { w: CUT_W, color: MAGENTA, dash: [3, 2] });
        }
        // 切らずに重ねる側は、あとで表に残るのでマークを置かない（紙の端をまっすぐそろえて合わせる）
        if (s.startType !== 'lap') mark(s.as - 8, en.q, 5);
        if (s.endType !== 'lap') mark(s.ae + 8, en.q, 5);
      }

      // 4) 仕上がり線（最後に外周を切るとき用）
      if (zf) line(s.cs, -0.6, s.ce, -0.6, { color: GRAY, dash: [2, 2] });
      if (zl) line(s.cs, L + 0.6, s.ce, L + 0.6, { color: GRAY, dash: [2, 2] });

      // 5) 中央の案内（番号・つなぎ方・サイズ）
      const mid = (s.vs + s.ve) / 2;
      const centerW = s.c - 2 * (hintW + 4) - 14;
      const sideText = (sd) => sd.type === 'cut' ? `${sd.word}側：点線で切り、${num(sd.nb)}ののりしろに重ねる`
        : sd.type === 'lap' ? `${sd.word}側：切らずに、紙の端を${num(sd.nb)}の線に合わせて上に重ねる`
        : sd.type === 'glue' && sd.guide ? `${sd.word}側：線に${num(sd.nb)}の紙の端を合わせて上に重ねる`
        : sd.type === 'glue' ? `${sd.word}側：のりしろ（${num(sd.nb)}を上に重ねる）` : '';
      const l2 = (M > 1 ? `先に ${num(s.i)}-1〜${num(s.i)}-${M} を長さの方向につなぐ　／　` : '') +
        (sides.map(sideText).filter(Boolean).join('　／　') || (M > 1 ? '横の貼り合わせはありません' : 'この1枚で完成します'));
      const l3 = `仕上がり ${fmt(p.W)}×${fmt(p.H)}mm　用紙 ${fmt(pl.pageW)}×${fmt(sg.PL)}mm　倍率100%（実際のサイズ）で印刷` +
        (cols ? '' : '　※紙の右側が仕上がりの「上」');
      const l1 = `全${pl.sheets}枚のうち ${name(s.i, sg.j)}`;
      const rows = [];
      if (zf) rows.push([-32.5, [{ t: l1, s: 4.2, b: true }, { t: l2, s: 3.3 }, { t: l3, s: 2.7 }]]);
      if (zl) rows.push([L + 32.5, [{ t: `${l1}（紙の終わり）`, s: 3.6, b: true }, { t: l3, s: 2.7 }]]);
      for (const [row, lines] of rows) {
        if (centerW < 60) break;
        const lab = await getLabel({ kind: 'h', maxW: centerW, lines });
        const [cx, cy] = pt(mid, row);
        const w = lab.w * K, bw = 12 * K, x = cx - (w + bw) / 2;
        badge(x + 5 * K, cy, 5);
        page.drawImage(lab.img, { x: x + bw, y: cy - (lab.h * K) / 2, width: w, height: lab.h * K });
      }

      // 6) 100mm の確認線
      if (zf && s.ve - s.vs >= 150) {
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
    const W = p.rollW, H = TEST_LEN;            // 紙を節約するため、幅いっぱい × 長さ 130mm の帯にする
    const doc = await PDFDocument.create();
    doc.setTitle(`かくピタくん テスト印刷（幅${fmt(W)}mm）`);
    const font = await doc.embedFont(StandardFonts.HelveticaBold);
    const page = doc.addPage([W * K, H * K]);
    const L = (u1, v1, u2, v2, w = 0.2) => page.drawLine({ start: { x: u1 * K, y: (H - v1) * K }, end: { x: u2 * K, y: (H - v2) * K }, thickness: w * K, color: INK });
    const T = (str, u, v, size) => {
      const w = font.widthOfTextAtSize(str, size * K);
      page.drawText(str, { x: u * K - w / 2, y: (H - v) * K - size * K * 0.36, size: size * K, font, color: INK });
    };
    const tick = (n) => (n % 10 === 0 ? 6 : n % 5 === 0 ? 4 : 2.5);
    {                                           // 左右の端から 0〜30mm の目盛り
      const v0 = 58;
      L(0, v0, 30, v0); L(W - 30, v0, W, v0);
      for (let n = 0; n <= 30; n++) {
        L(n, v0, n, v0 + tick(n)); L(W - n, v0, W - n, v0 + tick(n));
        if (n % 5 === 0 && n) { T(String(n), n, v0 + 9, 2.4); T(String(n), W - n, v0 + 9, 2.4); }
      }
    }
    for (const u0 of [40, W - 55]) {            // 紙の先端・後端から 0〜30mm の目盛り
      L(u0, 0, u0, 30); L(u0, H - 30, u0, H);
      for (let n = 0; n <= 30; n++) {
        L(u0, n, u0 + tick(n), n); L(u0, H - n, u0 + tick(n), H - n);
        if (n % 5 === 0 && n) { T(String(n), u0 + 10, n, 2.4); T(String(n), u0 + 10, H - n, 2.4); }
      }
    }
    const cx = W / 2;
    const bar = Math.min(400, Math.floor((W - 180) / 100) * 100);   // 横（紙の幅の向き）の確認線
    if (bar >= 100) {
      L(cx - bar / 2, 95, cx + bar / 2, 95, 0.35);
      for (let k = 0; k <= bar / 100; k++) L(cx - bar / 2 + k * 100, 91, cx - bar / 2 + k * 100, 99, 0.35);
      T(`${bar} mm`, cx, 104, 3.2);
    }
    const ux = W - 75;                          // 縦（紙が流れる向き）の 100mm の確認線
    L(ux, 15, ux, 115, 0.35); L(ux - 4, 15, ux + 4, 15, 0.35); L(ux - 4, 115, ux + 4, 115, 0.35);
    T('100 mm', ux - 12, 65, 3.2);
    const lab = await label({ kind: 'h', maxW: Math.min(W - 200, 380), lines: [
      { t: 'テスト印刷（倍率100%・実際のサイズで印刷してください）', s: 4.6, b: true },
      { t: '① 横の長い線と、右にある縦の 100mm の線を定規で測り、目盛りどおりの長さか確かめます。', s: 3.4 },
      { t: '② 四辺の目盛りが「何mmから」印刷されているかを読みます。その数字が「印刷できない余白」です。', s: 3.4 },
      { t: `※ ロール紙の幅が ${fmt(W)}mm のときに正しく測れます。用紙サイズは 幅${fmt(W)} × 長さ${H}mm。`, s: 3 },
    ] });
    const img = await doc.embedPng(lab.bytes);
    page.drawImage(img, { x: (cx - lab.w / 2) * K, y: (H - 42 - lab.h / 2) * K, width: lab.w * K, height: lab.h * K });
    return doc.save();
  }

  return { plan, planOne, buildPdf, buildTestPdf, mul, ap, num, fmt, consts: { K, TEST_LEN, ZONE, SIDE, MARK_T, MARK_R, SAFE, CUT_W, PDF_MAX_MM } };
});
