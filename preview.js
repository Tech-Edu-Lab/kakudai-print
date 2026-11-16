/* 拡大プリント preview: 画面上のプレビュー（仕上がり／印刷される紙）を canvas に描く */
(function (root) {
  'use strict';
  const Core = root.KakudaiCore;

  function fitCanvas(canvas, w, h) {
    const dpr = Math.min(2, root.devicePixelRatio || 1);
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(h * dpr));
    canvas.style.width = Math.round(w) + 'px';
    canvas.style.height = Math.round(h) + 'px';
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return ctx;
  }
  const token = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  function badge(ctx, x, y, r, text) {
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = '#1b2420'; ctx.fill();
    ctx.lineWidth = 1.5; ctx.strokeStyle = '#ffffff'; ctx.stroke();
    ctx.fillStyle = '#ffffff'; ctx.font = `700 ${Math.round(r * (text.length > 2 ? 0.8 : 1.15))}px "IBM Plex Mono", ui-monospace, monospace`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(text, x, y + 0.5);
  }

  /** 仕上がりのイメージと継ぎ目の位置 */
  function drawFinal(canvas, pl, bmp, maxH) {
    const p = pl.p, boxW = innerWidth(canvas.parentElement);
    let k = boxW / p.W;
    if (p.H * k > maxH) k = maxH / p.H;
    const w = p.W * k, h = p.H * k;
    const ctx = fitCanvas(canvas, w, h);
    if (bmp) ctx.drawImage(bmp, 0, 0, w, h); else { ctx.fillStyle = '#c9d2cc'; ctx.fillRect(0, 0, w, h); }
    const cols = pl.orient === 'cols';
    for (const sv of pl.seams) {
      const pos = sv * k;
      ctx.save();
      ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.beginPath(); cols ? (ctx.moveTo(pos, 0), ctx.lineTo(pos, h)) : (ctx.moveTo(0, pos), ctx.lineTo(w, pos)); ctx.stroke();
      ctx.lineWidth = 2; ctx.strokeStyle = token('--cut') || '#d6007a'; ctx.setLineDash([6, 4]);
      ctx.beginPath(); cols ? (ctx.moveTo(pos, 0), ctx.lineTo(pos, h)) : (ctx.moveTo(0, pos), ctx.lineTo(w, pos)); ctx.stroke();
      ctx.restore();
    }
    const r = Math.max(9, Math.min(15, (cols ? w : h) / pl.N / 4));
    for (const s of pl.strips) {
      const m = ((s.vs + s.ve) / 2) * k;
      cols ? badge(ctx, m, Math.min(h / 2, r + 8), r, String(s.i + 1)) : badge(ctx, Math.min(w / 2, r + 8), m, r, String(s.i + 1));
    }
  }

  /** 印刷される紙。縦長の紙は横に並べ、横長に使う紙は寝かせて仕上がりの向きで積む。長さ方向に分けた紙は流れの順に並べる */
  function drawSheets(canvas, pl, bmp, maxH) {
    const p = pl.p, N = pl.N, M = pl.M, boxW = innerWidth(canvas.parentElement), gap = 12, pad = 2;
    const cols = pl.orient === 'cols', lay = !cols;
    const sumPL = pl.segs.reduce((a, g) => a + g.PL, 0);
    const k = lay
      ? Math.min((boxW - pad * 2 - gap * (M - 1)) / sumPL, (maxH - gap * (N - 1) - pad * 2) / (N * pl.pageW))
      : Math.min((maxH - gap * (M - 1)) / sumPL, (boxW - gap * (N - 1) - pad * 2) / (N * pl.pageW));
    const pw = pl.pageW * k, along = sumPL * k + gap * (M - 1), across = N * pw + gap * (N - 1);
    const ctx = lay ? fitCanvas(canvas, along + pad * 2, across + pad * 2) : fitCanvas(canvas, across + pad * 2, along + pad * 2);
    const { ZONE, MARK_T, SAFE, CUT_W } = Core.consts;
    const cut = token('--cut') || '#d6007a';
    let off = 0;
    pl.segs.forEach((sg) => {
      pl.strips.forEach((s, i) => {
        const ox = lay ? pad + off : pad + i * (pw + gap), oy = lay ? pad + i * (pw + gap) : pad + off;
        const toScreen = lay ? (u, v) => [ox + v * k, oy + (pl.pageW - u) * k] : (u, v) => [ox + u * k, oy + v * k];
        const tA = sg.first ? -ZONE + 3 : sg.ps, tB = sg.last ? pl.L + ZONE - 3 : sg.pe, px = 1 / k;
        ctx.save();
        if (lay) { ctx.translate(ox, oy + pw); ctx.rotate(-Math.PI / 2); } else ctx.translate(ox, oy);
        ctx.scale(k, k);                                     // ここから用紙座標（mm）
        ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, pl.pageW, sg.PL);
        ctx.fillStyle = 'rgba(120,130,125,0.22)';            // 印刷できない余白
        ctx.fillRect(0, 0, p.mSide, sg.PL); ctx.fillRect(pl.pageW - p.mSide, 0, p.mSide, sg.PL);
        ctx.fillRect(0, 0, pl.pageW, p.mFeed); ctx.fillRect(0, sg.PL - p.mFeed, pl.pageW, p.mFeed);
        const S2U = cols ? [1, 0, 0, 1, s.U0 - s.as, sg.vOff] : [-1, 0, 0, 1, s.U0 + s.ae, sg.vOff];
        const F2S = cols ? [1, 0, 0, 1, 0, 0] : [0, 1, 1, 0, 0, 0];
        ctx.save();                                          // 絵（この紙の受け持ち範囲）
        ctx.beginPath(); ctx.rect(s.clipU0, sg.vOff + sg.ps, s.clipW, sg.pe - sg.ps); ctx.clip();
        ctx.transform(...Core.mul(S2U, F2S));
        if (bmp) ctx.drawImage(bmp, 0, 0, p.W, p.H); else { ctx.fillStyle = '#c9d2cc'; ctx.fillRect(0, 0, p.W, p.H); }
        ctx.restore();
        if (pl.lap && p.mSide > 0) {                         // 紙の端までのばした絵のうち、印刷できない余白は白く残る
          for (const u of [0, pl.pageW - p.mSide]) {
            ctx.fillStyle = '#ffffff'; ctx.fillRect(u, 0, p.mSide, sg.PL);
            ctx.fillStyle = 'rgba(120,130,125,0.22)'; ctx.fillRect(u, 0, p.mSide, sg.PL);
          }
        }
        ctx.save();                                          // ここから帯座標（a, t）
        ctx.transform(...S2U);
        const dash = (x1, y1, x2, y2) => {
          ctx.strokeStyle = cut; ctx.lineWidth = Math.max(CUT_W, 1.5 * px); ctx.setLineDash([6 * px, 4 * px]);
          ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); ctx.setLineDash([]);
        };
        const dot = (a, t) => { ctx.strokeStyle = '#1b2420'; ctx.lineWidth = px; ctx.beginPath(); ctx.arc(a, t, Math.max(5, 3 * px), 0, Math.PI * 2); ctx.stroke(); };
        ctx.fillStyle = 'rgba(255,255,255,0.55)';
        for (const [type, sp, dir, guide] of [[s.startType, s.vs, -1, s.startGuide], [s.endType, s.ve, 1, s.endGuide]]) {
          if (type === 'glue') {
            const a1 = sp + dir * SAFE, a2 = sp + dir * pl.g;
            ctx.fillStyle = 'rgba(255,255,255,0.55)';
            ctx.fillRect(Math.min(a1, a2), sg.ps, Math.abs(a2 - a1), sg.pe - sg.ps);
            if (guide) {                                     // となりの紙の端を合わせる線
              const a = sp - dir * guide;
              ctx.strokeStyle = cut; ctx.lineWidth = Math.max(0.35, 1.5 * px);
              ctx.beginPath(); ctx.moveTo(a, tA); ctx.lineTo(a, tB); ctx.stroke();
            }
          }
          else if (type === 'cut') { const a = sp + dir * (pl.b + CUT_W / 2); dash(a, tA, a, tB); }
          if (type !== 'edge') { if (sg.first) dot(sp, -MARK_T); if (sg.last) dot(sp, pl.L + MARK_T); }
        }
        for (const [type, q, dir] of [[sg.startType, sg.ts, -1], [sg.endType, sg.te, 1]]) {
          if (type === 'edge') continue;
          if (type === 'glue') { const t1 = q + dir * SAFE, t2 = q + dir * pl.g; ctx.fillStyle = 'rgba(255,255,255,0.55)'; ctx.fillRect(s.cs, Math.min(t1, t2), s.clipW, Math.abs(t2 - t1)); }
          else { const t = q + dir * (pl.b + CUT_W / 2); dash(Math.min(s.cs, s.as - pl.SZ), t, Math.max(s.ce, s.ae + pl.SZ), t); }
          if (s.startType !== 'lap') dot(s.as - 8, q);
          if (s.endType !== 'lap') dot(s.ae + 8, q);
        }
        ctx.restore();
        ctx.strokeStyle = 'rgba(27,36,32,0.35)'; ctx.lineWidth = px;
        ctx.strokeRect(0, 0, pl.pageW, sg.PL);
        ctx.restore();
        const [bx, by] = toScreen(pl.pageW / 2, Math.min(sg.PL / 2, p.mFeed + Math.max(14, 12 / k)));
        badge(ctx, bx, by, Math.max(8, Math.min(13, pw / 6)), M > 1 ? `${s.i + 1}-${sg.j + 1}` : String(s.i + 1));
      });
      off += sg.PL * k + gap;
    });
  }
  function innerWidth(el) {
    const cs = getComputedStyle(el);
    return el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  }

  root.KakudaiPreview = { drawFinal, drawSheets };
})(typeof self !== 'undefined' ? self : this);
