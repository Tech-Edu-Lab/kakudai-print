/* かくピタくん app: 画面の操作、原稿の読み込み、PDFの作成と保存 */
(function () {
  'use strict';
  const Core = window.KakudaiCore, Labels = window.KakudaiLabels, Preview = window.KakudaiPreview;
  const $ = (id) => document.getElementById(id);
  const fmt = Core.fmt;
  const K = Core.consts.K;
  const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/';
  const STORE = 'kakudai-print:v1';
  const Editor = window.KakudaiEditor;
  const MODE = 'kakudai-print:mode';
  const S = { src: null, bmp: null, plan: null, result: null, busy: false, sizeTouched: false, mode: 'design', sizes: { design: null, file: null } };

  // ---------- 保存（claude.ai では downloads 機能、手元のファイルでは通常のダウンロード） ----------
  const downloadsReady = window.claude && typeof window.claude.use === 'function'
    ? window.claude.use('downloads').catch(() => null) : Promise.resolve(null);
  async function offerFile(filename, bytes, mime) {
    const blob = new Blob([bytes], { type: mime || 'application/pdf' });
    const d = await downloadsReady;
    if (d) {
      try { await d.save({ filename, data: blob }); return 'saved'; }
      catch (e) {
        if (e && e.code === 'declined') return 'declined';
        if (e && e.code === 'rate_limited') return 'busy';
      }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    return window.claude ? 'maybe' : 'saved';
  }
  function status(msg, kind) { const el = $('status'); el.textContent = msg; el.dataset.kind = kind || ''; }

  // ---------- 設定 ----------
  const num = (id) => parseFloat($(id).value);
  function rollWidth() { return $('rollSel').value === 'custom' ? num('rollW') : parseFloat($('rollSel').value); }
  function params() {
    return { W: num('W'), H: num('H'), rollW: rollWidth(), mSide: num('mSide'), mFeed: num('mFeed'),
      glue: num('glue'), bleed: 3, nextOnTop: $('order').value === 'next', maxLen: num('maxLen'), join: $('join').value };
  }
  function orientChoice() { return document.querySelector('input[name="orient"]:checked').value; }
  function saveSettings() {
    try {
      localStorage.setItem(STORE, JSON.stringify({ rollSel: $('rollSel').value, rollW: $('rollW').value, mSide: $('mSide').value,
        mFeed: $('mFeed').value, glue: $('glue').value, order: $('order').value, maxLen: $('maxLen').value, join: $('join').value }));
    } catch (e) { /* 保存できない環境でも動く */ }
  }
  function loadSettings() {
    try {
      const v = JSON.parse(localStorage.getItem(STORE) || 'null');
      if (!v) return;
      for (const k of ['rollSel', 'rollW', 'mSide', 'mFeed', 'glue', 'order', 'maxLen', 'join']) if (v[k] != null && $(k)) $(k).value = v[k];
    } catch (e) { /* 既定値のまま */ }
  }

  // ---------- 原稿の読み込み ----------
  function loadImg(url) {
    return new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => rej(new Error('画像を読み込めませんでした')); im.src = url; });
  }
  function canvasBytes(canvas, type, q) {
    return new Promise((res, rej) => canvas.toBlob(async (b) => (b ? res(new Uint8Array(await b.arrayBuffer())) : rej(new Error('画像の変換に失敗しました'))), type, q));
  }
  function jpegOrientation(b) {
    if (b[0] !== 0xff || b[1] !== 0xd8) return 1;
    let i = 2;
    while (i + 10 < b.length && b[i] === 0xff) {
      const marker = b[i + 1], len = (b[i + 2] << 8) | b[i + 3];
      if (marker === 0xda) break;
      if (marker === 0xe1 && String.fromCharCode(b[i + 4], b[i + 5], b[i + 6], b[i + 7]) === 'Exif') {
        const t = i + 10, le = b[t] === 0x49;
        const u16 = (o) => (le ? b[o] | (b[o + 1] << 8) : (b[o] << 8) | b[o + 1]);
        const u32 = (o) => (le ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) : ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3])) >>> 0;
        const ifd = t + u32(t + 4), n = u16(ifd);
        for (let k = 0; k < n; k++) { const e = ifd + 2 + k * 12; if (u16(e) === 0x0112) return u16(e + 8); }
        break;
      }
      i += 2 + len;
    }
    return 1;
  }
  function previewBitmap(source, w, h) {          // 画面用に縮小した絵（大きな画像でも軽く描ける）
    const s = Math.min(1, 2400 / Math.max(w, h));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * s)); c.height = Math.max(1, Math.round(h * s));
    const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.drawImage(source, 0, 0, c.width, c.height);
    return c;
  }
  async function loadImageSource(bytes, mime, name) {
    const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
    try {
      const im = await loadImg(url);
      const w = im.naturalWidth, h = im.naturalHeight;
      let outBytes = bytes, outMime = mime;
      const needsConvert = !(mime === 'image/png' || mime === 'image/jpeg') || (mime === 'image/jpeg' && jpegOrientation(bytes) !== 1);
      if (needsConvert) {                          // PNG/JPEG 以外、または回転情報つきの写真は描き直す
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        c.getContext('2d').drawImage(im, 0, 0);
        outMime = mime === 'image/jpeg' ? 'image/jpeg' : 'image/png';
        outBytes = await canvasBytes(c, outMime, 0.92);
      }
      return { kind: 'image', bytes: outBytes, mime: outMime, name, pxW: w, pxH: h, aspect: w / h, bmp: previewBitmap(im, w, h) };
    } finally { URL.revokeObjectURL(url); }
  }
  function pdfPageInfo(src) {
    const pg = src.pdfDoc.getPage(src.pageIndex), cb = pg.getCropBox();
    const rot = (((pg.getRotation().angle || 0) % 360) + 360) % 360;
    let w = cb.width, h = cb.height;
    if (rot % 180) [w, h] = [h, w];
    src.mmW = w / K; src.mmH = h / K; src.aspect = w / h;
  }
  function loadScript(src) {
    return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error(src)); document.head.appendChild(s); });
  }
  let pdfjsReady = null;
  function getPdfjs() {
    if (!pdfjsReady) {
      pdfjsReady = (async () => {
        await loadScript(PDFJS + 'pdf.min.js');
        await loadScript(PDFJS + 'pdf.worker.min.js');   // 別スレッドを使わず画面側で描く
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.min.js';
        return window.pdfjsLib;
      })().catch((e) => { pdfjsReady = null; throw e; });
    }
    return pdfjsReady;
  }
  async function renderPdfPreview(src) {
    const pdfjs = await getPdfjs();
    const doc = await pdfjs.getDocument({ data: src.bytes.slice(), isEvalSupported: false }).promise;
    try {
      const page = await doc.getPage(src.pageIndex + 1);
      const v1 = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: Math.min(6, 1800 / Math.max(v1.width, v1.height)) });
      const c = document.createElement('canvas'); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
      const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: x, viewport: vp }).promise;
      return c;
    } finally { doc.destroy(); }
  }
  async function refreshPdfPreview() {
    const src = S.src;
    S.bmp = null; schedule();
    $('srcNote').textContent = 'プレビューを準備しています…';
    try {
      const bmp = await renderPdfPreview(src);
      if (S.src === src) { S.bmp = bmp; $('srcNote').textContent = ''; schedule(); }
    } catch (e) {
      if (S.src === src) $('srcNote').textContent = 'プレビューは表示できませんでしたが、PDFは作れます。';
    }
  }

  function sniff(b) {
    if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return 'application/pdf';
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
    if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
    return 'image/other';
  }
  async function useFile(file) {
    status('');
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const mime = sniff(bytes);
      if (mime === 'application/pdf') {
        const pdfDoc = await PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true });
        const src = { kind: 'pdf', bytes, name: file.name, pdfDoc, pageIndex: 0, pageCount: pdfDoc.getPageCount(), encrypted: pdfDoc.isEncrypted };
        pdfPageInfo(src);
        setSource(src);
        refreshPdfPreview();
      } else {
        const src = await loadImageSource(bytes, mime === 'image/other' ? (file.type || 'image/png') : mime, file.name);
        setSource(src);
      }
    } catch (e) {
      status('このファイルは読み込めませんでした。PDF・PNG・JPEG の原稿を選んでください。', 'error');
    }
  }
  function setSource(src, size) {
    S.src = src; S.bmp = src.bmp || null;
    if (size) { $('W').value = size[0]; $('H').value = size[1]; S.sizeTouched = false; }
    else if (S.sizeTouched) { $('H').value = Math.round(num('W') / src.aspect); }
    else {
      const long = 1800;
      $('W').value = Math.round(src.aspect >= 1 ? long : long * src.aspect);
      $('H').value = Math.round(src.aspect >= 1 ? long / src.aspect : long);
    }
    $('lock').checked = true;
    renderSourceInfo();
    update();
  }
  function renderSourceInfo() {
    const src = S.src, info = $('srcInfo');
    $('pageRow').hidden = !(src && src.kind === 'pdf' && src.pageCount > 1);
    if (!src) { info.textContent = 'まだ選ばれていません'; return; }
    if (src.kind === 'pdf') {
      info.textContent = `${src.name}（PDF・${src.pageCount}ページ・${fmt(src.mmW)}×${fmt(src.mmH)}mm）`;
      const sel = $('page');
      if (sel.options.length !== src.pageCount) {
        sel.innerHTML = '';
        for (let i = 0; i < src.pageCount; i++) sel.add(new Option(`${i + 1}ページ目`, String(i)));
      }
      sel.value = String(src.pageIndex);
    } else {
      info.textContent = `${src.name}（画像・${fmt(src.pxW)}×${fmt(src.pxH)}ピクセル）`;
    }
  }

  // ---------- サンプル原稿 ----------
  async function makeSample() {
    const W = 7200, H = 1800, c = document.createElement('canvas');
    c.width = W; c.height = H;
    const x = c.getContext('2d');
    const g = x.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, '#0d4f63'); g.addColorStop(1, '#16807a');
    x.fillStyle = g; x.fillRect(0, 0, W, H);
    x.fillStyle = 'rgba(255,255,255,0.06)';
    for (let i = 0; i < 26; i++) { x.beginPath(); x.arc((i * 997) % W, (i * 613) % H, 80 + (i * 37) % 220, 0, Math.PI * 2); x.fill(); }
    x.strokeStyle = '#f2c94c'; x.lineWidth = 40; x.strokeRect(110, 110, W - 220, H - 220);
    const font = (px) => `700 ${px}px ${Labels.FONT}`;
    const fit = (text, px, maxW) => { x.font = font(px); const w = x.measureText(text).width; return w > maxW ? px * maxW / w : px; };
    try { await document.fonts.load(font(100), 'ようこそ文化祭へ年秋月日土・（）0123456789'); } catch (e) { /* 代わりのフォント */ }
    x.textAlign = 'center'; x.textBaseline = 'middle';
    const t1 = 'ようこそ 文化祭へ', t2 = '2026年 秋の文化祭　11月21日（土）・22日（日）';
    x.fillStyle = '#ffffff'; x.font = font(fit(t1, 640, W - 900)); x.fillText(t1, W / 2, H * 0.45);
    x.fillStyle = '#f2c94c'; x.font = font(fit(t2, 190, W - 900)); x.fillText(t2, W / 2, H * 0.8);
    const bytes = await canvasBytes(c, 'image/jpeg', 0.88);
    return { kind: 'image', bytes, mime: 'image/jpeg', name: 'サンプル原稿（文化祭の横看板）', pxW: W, pxH: H, aspect: W / H, bmp: previewBitmap(c, W, H), sample: true };
  }

  // ---------- 計算と表示 ----------
  let raf = 0;
  function schedule() { cancelAnimationFrame(raf); raf = requestAnimationFrame(drawAll); }
  function drawAll() {
    const pl = S.plan;
    $('previews').hidden = !(pl && pl.ok);
    if (!pl || !pl.ok) return;
    const bmp = S.mode === 'design' ? Editor.bitmap(2400) : S.bmp;
    if (S.mode === 'file') Preview.drawFinal($('cvFinal'), pl, bmp, 300);
    Preview.drawSheets($('cvSheets'), pl, bmp, 420);
    $('sheetsCap').textContent = pl.orient === 'cols'
      ? '縦長の紙のまま並べています。白い帯は印刷できない余白、淡い帯はのりしろ、細い実線は紙の端を合わせる線、点線は切り取り線です。'
      : '紙を寝かせて、仕上がりの向きで並べています（プリンタからは縦長に出てきます）。淡い帯はのりしろ、細い実線は紙の端を合わせる線、点線は切り取り線です。';
  }
  const orientName = { cols: '縦長の紙を横に並べる', rows: '横長の紙を縦に並べる' };
  function update() {
    const p = params();
    const countVal = parseInt($('count').value, 10);
    const r = Core.plan(p, orientChoice(), countVal > 0 ? countVal : 0);
    S.result = r; S.plan = r.chosen;
    for (const o of ['cols', 'rows']) $(o + 'N').textContent = r[o].ok ? `${r[o].sheets}枚` : '—';
    renderSummary(r, p);
    saveSettings();
    schedule();
    if (S.mode === 'design') Editor.draw();
  }
  function setCollapsed(on) {                      // デザイン欄をたたむ／開く
    $('editor').classList.toggle('is-collapsed', on);
    $('edToggle').textContent = on ? '開いて編集する ▼' : 'たたむ ▲';
    $('edToggle').setAttribute('aria-expanded', String(!on));
    try { localStorage.setItem('kakudai-print:collapsed', on ? '1' : ''); } catch (e) { /* 覚えられなくても動く */ }
    if (!on) Editor.draw();
  }
  function setMode(mode) {
    if (S.mode !== mode) {
      S.sizes[S.mode] = [num('W'), num('H')];
      S.mode = mode;
      const sz = S.sizes[mode];
      if (sz && sz[0] > 0 && sz[1] > 0) { $('W').value = Math.round(sz[0]); $('H').value = Math.round(sz[1]); }
    }
    const design = mode === 'design';
    $('modeDesign').setAttribute('aria-pressed', String(design));
    $('modeFile').setAttribute('aria-pressed', String(!design));
    $('editor').hidden = !design; $('srcSection').hidden = design;
    $('lockRow').hidden = design; $('sizeHint').hidden = !design;
    $('figFinal').hidden = design; $('designPdfBtn').hidden = !design;
    try { localStorage.setItem(MODE, mode); } catch (e) { /* 覚えられなくても動く */ }
    Editor.setActive(design);
    status('');
    update();
  }
  /** 今の設定での「貼る順番」の説明（手順欄に出す） */
  function orderText(pl) {
    const c = Core.num, N = pl.N, M = pl.M, next = pl.p.nextOnTop;
    const dir = pl.orient === 'cols' ? ['左', '右'] : ['上', '下'];
    const seq = (n, f) => Array.from({ length: n }, (_, i) => f(i));
    const chain = (names) => {
      const order = next ? names : names.slice().reverse();
      const step = (i) => (i === 0 ? `<b>${order[0]}</b>を置き` : `<b>${order[i]}</b>を${order[i - 1]}の上に重ね`);
      if (order.length <= 4) return order.map((_, i) => step(i)).join('、') + 'ます';
      return `${step(0)}、${step(1)}、${step(2)}…と、最後の<b>${order[order.length - 1]}</b>まで順に重ねます`;
    };
    if (N === 1 && M === 1) return '紙は1枚なので、貼り合わせはありません。';
    const parts = [];
    if (M > 1) {
      parts.push(`まず同じ番号どうしを長さの方向につなぎます。たとえば ${chain(seq(M, (j) => `${c(0)}-${j + 1}`))}。${N > 1 ? 'ほかの番号も同じようにつなぎます。' : ''}`);
    }
    if (N > 1) {
      const names = seq(N, (i) => c(i));
      parts.push(`${M > 1 ? '次に、つないだものどうしを' : ''}${dir[0]}から${dir[1]}へ ${N > 4 ? `${names[0]}〜${names[N - 1]}` : names.join('・')} の順に並べ、${chain(names)}。`);
      parts.push(next ? 'いつも「あとの番号の紙が上」です。' : 'いつも「前の番号の紙が上」です。');
    }
    return parts.join('');
  }
  function renderSummary(r, p) {
    const pl = r.chosen, box = $('summary'), warns = [];
    $('makeBtn').disabled = !(pl.ok && (S.mode === 'design' || S.src)) || S.busy;
    $('designPdfBtn').disabled = S.busy;
    if (!pl.ok) { box.innerHTML = `<p class="sum-error">${pl.reason}</p>`; $('warns').innerHTML = ''; return; }
    $('orderText').innerHTML = orderText(pl);
    const seamText = [pl.N > 1 ? `横 ${pl.N - 1}か所（長さ ${fmt(pl.L)}mm）` : '', pl.M > 1 ? `長さ方向 ${pl.N * (pl.M - 1)}か所` : ''].filter(Boolean).join('、') || 'なし';
    box.innerHTML = `
      <p class="sum-main"><span class="sum-n">${pl.sheets}</span>枚に分けて印刷します</p>
      <p class="sum-paper">プリンタに設定する用紙サイズ<b class="num">幅 ${fmt(pl.pageW)} mm × 長さ ${fmt(pl.PL)} mm</b><span>${pl.sheets > 1 ? 'どのページも同じ大きさです。' : ''}ドライバの「ユーザー定義の用紙サイズ」にこの数字を入れます。</span></p>
      <dl class="sum-grid">
        <div><dt>並べ方</dt><dd>${orientName[pl.orient]}</dd></div>
        <div><dt>貼り合わせ</dt><dd>${seamText}</dd></div>
        <div><dt>ロール紙の使用量</dt><dd class="num">約 ${(pl.paper / 1000).toFixed(1)} m</dd></div>
      </dl>`;
    if (S.mode === 'design') {
      warns.push(['info', '文字は輪郭の線（ベクター）で印刷するので、大きく拡大してもくっきり印刷されます。']);
      warns.push(...Editor.warnings());
    } else if (!S.src) warns.push(['info', '原稿を選ぶと、印刷用のPDFを作れます。']);
    if (pl.tooLong) warns.push(['warn', `1枚の長さが ${fmt(pl.PL)}mm で、PDFの標準の上限（5,080mm）を超えるため、PDFの拡張機能で長いページを作ります。Acrobat Reader で開いて印刷してください（ブラウザ内蔵の表示では、大きさが正しく出ないことがあります）。うまく印刷できないときは「1枚の最大の長さ」を 5,000mm 以下にすると、長さの方向にも分けます。`]);
    if (pl.M > 1) warns.push(['warn', `「1枚の最大の長さ」が ${fmt(p.maxLen)}mm のため、長さの方向にも ${pl.M} つに分けています（紙の番号は ①-1、①-2 …）。この値を ${fmt(pl.needLen)}mm 以上にすると、長さの方向には分けず ${pl.N} 枚になります。分けたままのときは、先に同じ番号どうしを長さの方向につないでから、となりの番号と貼り合わせてください。`]);
    if (pl.lap && pl.N > 1 && p.mSide > 0) warns.push(['info', `切らずに重ねるので、継ぎ目に余白の幅（約${fmt(p.mSide)}mm）の白いすじが出ます。白地なら目立ちません。色地で気になるときは、つなぎ方を「点線で切って重ねる」にしてください。`]);
    if (pl.countClamped) warns.push(['warn', `紙の幅に入らないため、${pl.nMin}枚より少なくはできません。`]);
    if (pl.N === 2 && pl.D <= pl.P + 60 && pl.D > pl.P) {
      warns.push(['info', `仕上がりの${pl.orient === 'cols' ? '幅' : '高さ'}を ${fmt(Math.floor(pl.P))}mm 以下にすると、貼り合わせなしの1枚で印刷できます。`]);
    }
    const src = S.mode === 'file' ? S.src : null;
    if (src && src.kind === 'image') {
      const dpi = Math.min(src.pxW / (p.W / 25.4), src.pxH / (p.H / 25.4));
      if (dpi < 25) warns.push(['warn', `原稿の解像度が低めです（約${Math.round(dpi)}dpi）。近くで見ると粗く見えます。大きめの画像かPDFの原稿がおすすめです。`]);
      else warns.push(['info', `画像の解像度は約${Math.round(dpi)}dpiです（数メートル離れて見る掲示物なら30〜50dpiでも見られます）。`]);
    }
    if (src && src.kind === 'pdf') {
      warns.push(['info', `PDFの原稿は拡大率 ${Math.round((p.W / src.mmW) * 100)}% です。文字や図形は拡大してもくっきり印刷されます。`]);
      if (src.encrypted) warns.push(['warn', 'このPDFには保護がかかっているため、正しく印刷できないことがあります。']);
    }
    $('warns').innerHTML = warns.map(([k, t]) => `<li data-kind="${k}">${t}</li>`).join('');
  }

  // ---------- PDF を作る ----------
  async function makePdf() {
    const pl = S.plan;
    const design = S.mode === 'design';
    if (!pl || !pl.ok || (!design && !S.src) || S.busy) return;
    S.busy = true; $('makeBtn').disabled = true; $('makeBtn').textContent = 'PDFを作っています…'; status('');
    try {
      const src = design ? { kind: 'pdf', bytes: await Editor.toPdf(), pageIndex: 0 } : S.src;
      const bytes = await Core.buildPdf(pl, src, Labels.renderLabel);
      const p = pl.p, name = `かくピタくん_${Math.round(p.W)}x${Math.round(p.H)}mm_${pl.sheets}枚.pdf`;
      const size = (bytes.length / 1048576).toFixed(1);
      const res = await offerFile(name, bytes);
      if (res === 'declined') status('保存を取り消しました。');
      else if (res === 'busy') status('保存の確認がまだ開いています。閉じてからもう一度押してください。', 'warn');
      else status(`「${name}」（${size}MB・${pl.sheets}ページ）を保存しました。プリンタの用紙サイズを 幅${fmt(pl.pageW)}mm × 長さ${fmt(pl.PL)}mm にして、Acrobat Reader から倍率100%（実際のサイズ）で印刷してください。`, 'ok');
    } catch (e) {
      console.error(e);
      status('PDFを作れませんでした。原稿のファイルを確かめて、もう一度お試しください。', 'error');
    } finally {
      S.busy = false; $('makeBtn').textContent = '印刷用PDFを作る';
      $('makeBtn').disabled = !(S.plan && S.plan.ok && (S.mode === 'design' || S.src));
    }
  }
  async function makeDesignPdf() {
    if (S.busy) return;
    const W = num('W'), H = num('H');
    S.busy = true; $('designPdfBtn').disabled = true; status('');
    try {
      const bytes = await Editor.toPdf();
      const name = `かくピタくん_仕上がり_${Math.round(W)}x${Math.round(H)}mm.pdf`;
      const res = await offerFile(name, bytes);
      if (res === 'declined') status('保存を取り消しました。');
      else if (res !== 'busy') status(`「${name}」を保存しました。仕上がりの大きさ1枚のPDFです（印刷業者に頼むときや、縮小して確かめるときに使えます）。` +
        (Math.max(W, H) > 5080 ? '一辺が5,080mmを超えるため、開けないソフトがあります。' : ''), 'ok');
    } catch (e) {
      console.error(e);
      status('PDFを作れませんでした。もう一度お試しください。', 'error');
    } finally { S.busy = false; $('designPdfBtn').disabled = false; }
  }
  async function makeTestPdf() {
    const p = params();
    if (!(p.rollW > 50)) { status('ロール紙の幅を入力してください。', 'error'); return; }
    try {
      const bytes = await Core.buildTestPdf(p, Labels.renderLabel);
      const name = `かくピタくん_テスト印刷_幅${Math.round(p.rollW)}mm.pdf`;
      const res = await offerFile(name, bytes);
      if (res !== 'declined' && res !== 'busy') status(`「${name}」を保存しました。プリンタの用紙サイズを 幅${fmt(p.rollW)}mm × 長さ${Core.consts.TEST_LEN}mm にして倍率100%で印刷し、四辺の目盛りで余白を読んでください。`, 'ok');
    } catch (e) {
      console.error(e);
      status('テスト印刷用のPDFを作れませんでした。', 'error');
    }
  }

  // ---------- イベント ----------
  function bind() {
    $('file').addEventListener('change', (e) => { const f = e.target.files && e.target.files[0]; if (f) useFile(f); e.target.value = ''; });
    const drop = $('drop');
    ['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('is-over'); }));
    ['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('is-over'); }));
    drop.addEventListener('drop', (e) => { const f = e.dataTransfer && e.dataTransfer.files[0]; if (f) useFile(f); });
    $('sampleBtn').addEventListener('click', async () => setSource(await makeSample(), [3600, 900]));
    $('page').addEventListener('change', () => {
      S.src.pageIndex = parseInt($('page').value, 10); pdfPageInfo(S.src);
      if ($('lock').checked) $('H').value = Math.round(num('W') / S.src.aspect);
      renderSourceInfo(); update(); refreshPdfPreview();
    });
    const fileLock = () => S.mode === 'file' && $('lock').checked && S.src;
    const sized = () => { update(); if (S.mode === 'design') Editor.sizeChanged(); };
    $('W').addEventListener('input', () => { S.sizeTouched = true; if (fileLock() && num('W') > 0) $('H').value = Math.round(num('W') / S.src.aspect); sized(); });
    $('H').addEventListener('input', () => { S.sizeTouched = true; if (fileLock() && num('H') > 0) $('W').value = Math.round(num('H') * S.src.aspect); sized(); });
    $('modeDesign').addEventListener('click', () => setMode('design'));
    $('modeFile').addEventListener('click', () => setMode('file'));
    $('designPdfBtn').addEventListener('click', makeDesignPdf);
    $('edToggle').addEventListener('click', () => setCollapsed(!$('editor').classList.contains('is-collapsed')));
    $('lock').addEventListener('change', () => { if ($('lock').checked && S.src) $('H').value = Math.round(num('W') / S.src.aspect); update(); });
    $('rollSel').addEventListener('change', () => { $('rollCustom').hidden = $('rollSel').value !== 'custom'; update(); });
    for (const id of ['rollW', 'mSide', 'mFeed', 'glue', 'count', 'order', 'maxLen', 'join']) $(id).addEventListener('input', update);
    document.querySelectorAll('input[name="orient"]').forEach((r) => r.addEventListener('change', update));
    $('makeBtn').addEventListener('click', makePdf);
    $('testBtn').addEventListener('click', makeTestPdf);
    let rt = 0;
    window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { schedule(); Editor.draw(); }, 120); });
  }

  loadSettings();
  $('rollCustom').hidden = $('rollSel').value !== 'custom';
  bind();
  let mode0 = 'design';
  try { if (localStorage.getItem(MODE) === 'file') mode0 = 'file'; } catch (e) { /* 既定はこの画面で作る */ }
  makeSample().then((src) => {
    if (S.src) return;
    if (S.mode === 'file') setSource(src, [3600, 900]);
    else { S.src = src; S.bmp = src.bmp; S.sizes.file = [3600, 900]; renderSourceInfo(); }
  }).catch(() => {});
  Editor.init({
    getSize: () => ({ W: num('W'), H: num('H') }),
    setSize: (W, H) => { $('W').value = Math.round(W); $('H').value = Math.round(H); update(); },
    getPlan: () => S.plan,
    onChange: () => { if (S.mode === 'design' && S.result) { renderSummary(S.result, params()); schedule(); } },
    loadImage: (bytes, mime, name) => loadImageSource(bytes, mime, name),
    status, offerFile,
  }).then((restored) => {
    try { if (localStorage.getItem('kakudai-print:collapsed')) setCollapsed(true); } catch (e) { /* 開いたまま */ }
    setMode(mode0);
    if (restored && mode0 === 'design') status('前回のデザインの続きから表示しています。');
  });
  window.KakudaiApp = { state: S, useFile, update, setMode };
})();
