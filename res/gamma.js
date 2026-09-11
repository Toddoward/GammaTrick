/* gamma.js — 화면(UI) 담당. 실제 인코딩은 gt-core.js (GTCore) */
(function () {
  'use strict';
  var $ = function (s) { return document.querySelector(s); };
  var FONT_STACK = '"Noto Sans", "Noto Sans KR", "Noto Sans JP", "Noto Sans SC", "Noto Sans CJK KR", sans-serif';
  var GAMA_DARKEST = 0.005;   // gAMA 방식의 가장 어두운 레벨 (선형광). 실험으로 고른 값
  var srcBlob = null, srcName = 'image', lastUrl = null, busy = false, again = false;

  // ---------- 테마 (라이트 ☀️ / 다크 🌙) ----------
  var root = document.documentElement, mq = window.matchMedia('(prefers-color-scheme: dark)');
  function savedTheme() { try { return localStorage.getItem('gt-theme'); } catch (e) { return null; } }
  function applyTheme(t) {
    root.setAttribute('data-theme', t);
    var btn = $('#themeToggle'), dark = t === 'dark';
    btn.textContent = dark ? '☀️' : '🌙';               // 누르면 바뀔 모드를 보여줌
    btn.title = dark ? '라이트 모드로 전환' : '다크 모드로 전환';
    btn.setAttribute('aria-label', btn.title);
  }
  applyTheme(root.getAttribute('data-theme') === 'dark' ? 'dark' : 'light');
  $('#themeToggle').addEventListener('click', function () {
    var t = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem('gt-theme', t); } catch (e) {}
    applyTheme(t);
  });
  // 직접 고른 적이 없으면 브라우저 설정이 바뀔 때 따라감
  var onScheme = function (e) { if (!savedTheme()) applyTheme(e.matches ? 'dark' : 'light'); };
  if (mq.addEventListener) mq.addEventListener('change', onScheme); else if (mq.addListener) mq.addListener(onScheme);

  // ---------- 입력 ----------
  function setSource(blob, name) {
    if (!blob || !/^image\//.test(blob.type || 'image/')) return;
    srcBlob = blob;
    srcName = (name || 'image').replace(/\.[^.]+$/, '');
    $('#filename').textContent = name || '붙여넣은 이미지';
    run();
  }
  var dz = $('#dropzone');
  window.addEventListener('dragover', function (e) { e.preventDefault(); dz.classList.add('over'); });
  window.addEventListener('dragleave', function () { dz.classList.remove('over'); });
  window.addEventListener('drop', function (e) {
    e.preventDefault(); dz.classList.remove('over');
    var f = e.dataTransfer.files[0];
    if (f) setSource(f, f.name);
  });
  window.addEventListener('paste', function (e) {
    var items = (e.clipboardData || {}).items || [];
    for (var i = 0; i < items.length; i++) {
      if (items[i].type.indexOf('image/') === 0) { setSource(items[i].getAsFile(), 'pasted.png'); return; }
    }
  });
  $('#fileinput').addEventListener('change', function () { if (this.files[0]) setSource(this.files[0], this.files[0].name); });
  $('#sample').addEventListener('click', function () { if (window.img_blob) setSource(window.img_blob, 'sample.png'); });

  // ---------- 옵션 ----------
  function opts() {
    return {
      mode: document.querySelector('input[name=mode]:checked').value,
      N: Math.max(2, Math.min(8, parseInt($('#levels').value, 10) || 5)),
      textOn: $('#textOn').checked,
      textTL: $('#textTL').value.trim(),
      textBR: $('#textBR').value.trim(),
      textHide: $('#textHide').checked,
      maxSide: parseInt($('#maxside').value, 10)
    };
  }
  function refreshOptionsUI() {
    var o = opts();
    $('#levelcount').textContent = o.N * o.N * o.N;
    $('#modehint').textContent = o.mode === 'icc'
      ? '이미지에 맞춘 ' + (o.N * o.N * o.N) + '색 팔레트를 ICC 프로필에 담습니다. 화질이 훨씬 좋습니다.'
      : '채널마다 ' + o.N + '단계로 고정된 색만 씁니다. 원래 레포와 같은 방식이라 지원 환경이 가장 넓습니다.';
    $('#textOptions').hidden = !o.textOn;
    var cvs = $('#palettepreview'), ctx = cvs.getContext('2d');
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, 80, 60);
    var d = 256 - o.N;
    ctx.fillStyle = 'rgb(' + d + ',' + d + ',' + d + ')'; ctx.fillRect(80, 0, 80, 60);
  }
  // 방식별 기본 단계: 썸네일 잔상이 원래 레포(4단계)보다 진하지 않은 선에서 가장 좋은 값
  var DEFAULT_LEVELS = { icc: 5, gama: 4 };
  $('#options').addEventListener('change', function (e) {
    if (e.target.name === 'mode') $('#levels').value = DEFAULT_LEVELS[e.target.value];
    refreshOptionsUI(); run();
  });
  $('#options').addEventListener('submit', function (e) { e.preventDefault(); });
  refreshOptionsUI();

  // ---------- 처리 ----------
  function status(msg) { $('#status').textContent = msg; }

  function loadImage(blob) {
    return new Promise(function (resolve, reject) {
      var img = new Image(), url = URL.createObjectURL(blob);
      img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('이미지를 읽을 수 없습니다.')); };
      img.src = url;
    });
  }

  function deflate(u8) {
    if (typeof CompressionStream === 'undefined') return Promise.reject(new Error('이 브라우저는 압축 기능(CompressionStream)을 지원하지 않습니다. 최신 Chrome/Edge/Firefox/Safari를 써주세요.'));
    var stream = new Blob([u8]).stream().pipeThrough(new CompressionStream('deflate'));
    return new Response(stream).arrayBuffer().then(function (b) { return new Uint8Array(b); });
  }

  // ---------- Web Worker ----------
  // 큰 이미지도 화면이 멈추지 않도록 인코딩은 워커에서 한다.
  // gt-core.js를 소스 문자열로 워커에 넣으므로 file:// 로 열어도 동작한다. 워커를 못 쓰면 화면 스레드에서 처리.
  var worker = null, workerFailed = false, jobId = 0;
  function workerMain() {
    var GT = GTCoreFactory();
    function deflateW(u8) {
      var st = new Blob([u8]).stream().pipeThrough(new CompressionStream('deflate'));
      return new Response(st).arrayBuffer().then(function (b) { return new Uint8Array(b); });
    }
    self.onmessage = function (e) {
      var d = e.data;
      GT.encode(d.rgba, d.w, d.h, d.opts, deflateW).then(function (r) {
        self.postMessage({ id: d.id, png: r.png, stored: r.stored, W: r.W, H: r.H }, [r.png.buffer, r.stored.buffer]);
      }).catch(function (err) { self.postMessage({ id: d.id, error: String((err && err.message) || err) }); });
    };
  }
  function encodeAsync(rgba, w, h, o) {
    if (!worker && !workerFailed) {
      try {
        var src = GTCoreFactory.toString() + '\n(' + workerMain.toString() + ')();';
        worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
      } catch (e) { workerFailed = true; worker = null; }
    }
    if (!worker) return GTCore.encode(rgba, w, h, o, deflate);
    return new Promise(function (resolve, reject) {
      var id = ++jobId;
      worker.onmessage = function (e) {
        if (e.data.id !== id) return;
        if (e.data.error) reject(new Error(e.data.error)); else resolve(e.data);
      };
      worker.onerror = function (e) {
        if (e.preventDefault) e.preventDefault();
        workerFailed = true; worker = null;
        GTCore.encode(rgba, w, h, o, deflate).then(resolve, reject);
      };
      worker.postMessage({ id: id, rgba: rgba, w: w, h: h, opts: o });
    });
  }

  function layout(w, h, textOn) {
    // 글씨 크기는 이미지 크기에 비례, 테두리는 글씨가 들어갈 만큼
    var font = Math.max(11, Math.min(32, Math.round(Math.min(w, h) * 0.028)));
    var border = textOn ? Math.max(15, Math.round(font * 1.7)) : 15;
    return { font: font, border: border };
  }

  function fontReady(px, text) {
    if (!document.fonts || !document.fonts.load) return Promise.resolve();
    var timeout = new Promise(function (r) { setTimeout(r, 3000); });
    return Promise.race([document.fonts.load('700 ' + px + 'px ' + FONT_STACK, text || 'A'), timeout]).catch(function () {});
  }

  // 테두리 글씨 마스크 (W*H, 0..1)
  function textMask(W, H, B, px, tl, br) {
    var c = document.createElement('canvas'); c.width = W; c.height = H;
    var x = c.getContext('2d');
    x.fillStyle = '#000'; x.fillRect(0, 0, W, H);
    x.fillStyle = '#fff'; x.textBaseline = 'middle';
    var maxW = W - 2 * B;
    function draw(text, align, px0, py) {
      if (!text) return;
      var size = px;
      x.font = '700 ' + size + 'px ' + FONT_STACK;
      while (size > 8 && x.measureText(text).width > maxW) { size--; x.font = '700 ' + size + 'px ' + FONT_STACK; }
      x.textAlign = align;
      x.fillText(text, px0, py);
    }
    draw(tl, 'left', B, B / 2);
    draw(br, 'right', W - B, H - B / 2);
    var d = x.getImageData(0, 0, W, H).data, m = new Float32Array(W * H);
    for (var i = 0; i < W * H; i++) m[i] = d[i * 4] / 255;
    return m;
  }

  function run() {
    if (!srcBlob) return;
    if (busy) { again = true; return; }
    busy = true;
    var o = opts(), t0 = Date.now();
    status('처리 중…');
    var timer = setInterval(function () { status('처리 중… ' + Math.round((Date.now() - t0) / 1000) + '초'); }, 1000);
    loadImage(srcBlob).then(function (img) {
      var w = img.naturalWidth, h = img.naturalHeight, s = 1;
      if (o.maxSide > 0 && Math.max(w, h) > o.maxSide) s = o.maxSide / Math.max(w, h);
      w = Math.max(1, Math.round(w * s)); h = Math.max(1, Math.round(h * s));
      var c = document.createElement('canvas'); c.width = w; c.height = h;
      var ctx = c.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);          // 투명 부분은 흰색으로
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, w, h);
      var rgba = ctx.getImageData(0, 0, w, h).data;
      var L = layout(w, h, o.textOn), W = w + 2 * L.border, H = h + 2 * L.border;
      return fontReady(L.font, o.textTL + o.textBR).then(function () {
        var overlay = o.textOn && (o.textTL || o.textBR) ? textMask(W, H, L.border, L.font, o.textTL, o.textBR) : null;
        return new Promise(function (r) { setTimeout(r, 30); }).then(function () {   // '처리 중' 표시가 먼저 그려지도록
          return encodeAsync(rgba, w, h, {
            mode: o.mode, N: o.N, darkest: GAMA_DARKEST, kernel: 'floyd',
            border: L.border, overlay: overlay, overlayMode: o.textHide ? 'hide' : 'show'
          });
        });
      });
    }).then(function (res) { clearInterval(timer); show(res); }).catch(function (e) {
      clearInterval(timer);
      status('오류: ' + e.message);
    }).then(function () {
      clearInterval(timer);
      busy = false;
      if (again) { again = false; run(); }
    });
  }

  function show(res) {
    // 1) 썸네일 모습 = 저장된 픽셀 그대로 (색 관리 없이 canvas에 직접)
    var tc = $('#viewThumb'); tc.width = res.W; tc.height = res.H;
    var tctx = tc.getContext('2d'), id = tctx.createImageData(res.W, res.H);
    for (var p = 0; p < res.W * res.H; p++) {
      id.data[p * 4] = res.stored[p * 3]; id.data[p * 4 + 1] = res.stored[p * 3 + 1];
      id.data[p * 4 + 2] = res.stored[p * 3 + 2]; id.data[p * 4 + 3] = 255;
    }
    tctx.putImageData(id, 0, 0);

    // 2) 원본 모습 = 실제 PNG 파일을 브라우저가 해석한 결과
    if (lastUrl) URL.revokeObjectURL(lastUrl);
    lastUrl = URL.createObjectURL(new Blob([res.png], { type: 'image/png' }));
    var img = $('#viewOrig');
    img.onload = function () { checkSupport(img, res); };
    img.src = lastUrl;
    $('#viewLink').href = lastUrl;
    var dl = $('#download');
    dl.href = lastUrl; dl.download = srcName + '_gamma.png';
    $('#result').hidden = false;
    status('완료 · ' + res.W + '×' + res.H + ' · ' + Math.round(res.png.length / 1024) + 'KB');
  }

  // 이 브라우저가 숨김을 풀어서 보여주는지 확인 (그린 결과가 저장값과 같으면 미지원)
  function checkSupport(img, res) {
    var warn = $('#support');
    try {
      var c = document.createElement('canvas'); c.width = res.W; c.height = res.H;
      var x = c.getContext('2d'); x.drawImage(img, 0, 0);
      var d = x.getImageData(0, 0, res.W, res.H).data, diff = 0, n = 0;
      for (var p = 0; p < res.W * res.H; p += 97) { diff += Math.abs(d[p * 4 + 1] - res.stored[p * 3 + 1]); n++; }
      if (diff / n < 2) {
        warn.textContent = '이 브라우저는 숨긴 이미지를 풀어서 보여주지 않습니다. 다른 방식이나 다른 브라우저로 확인해 보세요.';
        warn.hidden = false;
      } else warn.hidden = true;
    } catch (e) { warn.hidden = true; }
  }
})();
