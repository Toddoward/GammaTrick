/* common.js — 두 페이지(gamma.html, cover.html)가 함께 쓰는 화면 코드: 테마, 이미지 읽기, 워커, 글꼴, 결과 표시 */
(function (root) {
  'use strict';
  var $ = function (s) { return document.querySelector(s); };
  var FONT_STACK = '"Noto Sans", "Noto Sans KR", "Noto Sans JP", "Noto Sans SC", "Noto Sans CJK KR", sans-serif';

  // ---------- 테마 (라이트 ☀️ / 다크 🌙) ----------
  // 첫 방문은 <head>의 짧은 스크립트가 브라우저 설정으로 data-theme을 정한다. 여기서는 버튼과 전환만 담당.
  function initTheme() {
    var html = document.documentElement, mq = window.matchMedia('(prefers-color-scheme: dark)'), btn = $('#themeToggle');
    function saved() { try { return localStorage.getItem('gt-theme'); } catch (e) { return null; } }
    function apply(t) {
      html.setAttribute('data-theme', t);
      var dark = t === 'dark';
      btn.textContent = dark ? '☀️' : '🌙';               // 누르면 바뀔 모드를 보여줌
      btn.title = dark ? '라이트 모드로 전환' : '다크 모드로 전환';
      btn.setAttribute('aria-label', btn.title);
    }
    apply(html.getAttribute('data-theme') === 'dark' ? 'dark' : 'light');
    btn.addEventListener('click', function () {
      var t = html.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      try { localStorage.setItem('gt-theme', t); } catch (e) {}
      apply(t);
    });
    // 직접 고른 적이 없으면 브라우저 설정이 바뀔 때 따라감
    var onScheme = function (e) { if (!saved()) apply(e.matches ? 'dark' : 'light'); };
    if (mq.addEventListener) mq.addEventListener('change', onScheme); else if (mq.addListener) mq.addListener(onScheme);
  }

  // ---------- 이미지 ----------
  function loadImage(blob) {
    return new Promise(function (resolve, reject) {
      var img = new Image(), url = URL.createObjectURL(blob);
      img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('이미지를 읽을 수 없습니다.')); };
      img.src = url;
    });
  }
  // 긴 변 제한을 반영한 크기
  function fitSize(img, maxSide) {
    var w = img.naturalWidth, h = img.naturalHeight, s = 1;
    if (maxSide > 0 && Math.max(w, h) > maxSide) s = maxSide / Math.max(w, h);
    return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
  }
  /*
   * 이미지를 w×h 캔버스에 그린다. 투명 부분은 흰색.
   * fit: 'stretch'(늘리기, 기본) | 'crop'(잘라서 채우기) | 'contain'(전체 보이기, 남는 곳은 검정)
   */
  function rasterize(img, w, h, fit) {
    var c = document.createElement('canvas'); c.width = w; c.height = h;
    var ctx = c.getContext('2d'), iw = img.naturalWidth, ih = img.naturalHeight;
    ctx.imageSmoothingQuality = 'high';
    if (fit === 'contain') { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h); }
    else { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); }
    if (fit === 'crop' || fit === 'contain') {
      var s = fit === 'crop' ? Math.max(w / iw, h / ih) : Math.min(w / iw, h / ih);
      var dw = iw * s, dh = ih * s;
      if (fit === 'contain') { ctx.fillStyle = '#fff'; ctx.fillRect((w - dw) / 2, (h - dh) / 2, dw, dh); }
      ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
    } else ctx.drawImage(img, 0, 0, w, h);
    return c;
  }

  // ---------- 압축 ----------
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
      GT[d.fn].apply(null, d.args.concat([deflateW])).then(function (r) {
        self.postMessage({ id: d.id, png: r.png, stored: r.stored, W: r.W, H: r.H }, [r.png.buffer, r.stored.buffer]);
      }).catch(function (err) { self.postMessage({ id: d.id, error: String((err && err.message) || err) }); });
    };
  }
  // fn: 'encode' | 'encodeCover', args: deflate를 뺀 인자 목록
  function encodeAsync(fn, args) {
    var local = function () { return GTCore[fn].apply(null, args.concat([deflate])); };
    if (!worker && !workerFailed) {
      try {
        var src = GTCoreFactory.toString() + '\n(' + workerMain.toString() + ')();';
        worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
      } catch (e) { workerFailed = true; worker = null; }
    }
    if (!worker) return local();
    return new Promise(function (resolve, reject) {
      var id = ++jobId;
      worker.onmessage = function (e) {
        if (e.data.id !== id) return;
        if (e.data.error) reject(new Error(e.data.error)); else resolve(e.data);
      };
      worker.onerror = function (e) {
        if (e.preventDefault) e.preventDefault();
        workerFailed = true; worker = null;
        local().then(resolve, reject);
      };
      worker.postMessage({ id: id, fn: fn, args: args });
    });
  }

  // ---------- 글꼴 ----------
  function fontReady(px, text) {
    if (!document.fonts || !document.fonts.load) return Promise.resolve();
    var timeout = new Promise(function (r) { setTimeout(r, 3000); });
    return Promise.race([document.fonts.load('700 ' + px + 'px ' + FONT_STACK, text || 'A'), timeout]).catch(function () {});
  }
  // 이미지 크기에 비례한 글씨 크기
  function fontSizeFor(w, h) { return Math.max(11, Math.min(32, Math.round(Math.min(w, h) * 0.028))); }
  // 주어진 폭을 넘지 않도록 글씨 크기를 줄여서 font 문자열을 설정
  function setFittedFont(ctx, text, px, maxW) {
    var size = px;
    ctx.font = '700 ' + size + 'px ' + FONT_STACK;
    while (size > 8 && ctx.measureText(text).width > maxW) { size--; ctx.font = '700 ' + size + 'px ' + FONT_STACK; }
    return size;
  }

  // ---------- 진행 상태 ----------
  function status(msg) { $('#status').textContent = msg; }
  function startTimer() {
    var t0 = Date.now();
    status('처리 중…');
    var id = setInterval(function () { status('처리 중… ' + Math.round((Date.now() - t0) / 1000) + '초'); }, 1000);
    return function () { clearInterval(id); };
  }
  // '처리 중' 표시가 먼저 그려지도록 한 박자 쉼
  function nextFrame() { return new Promise(function (r) { setTimeout(r, 30); }); }

  // ---------- 결과 표시 ----------
  var lastUrl = null;
  function showResult(res, fileName) {
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
    dl.href = lastUrl; dl.download = fileName;
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

  // ---------- 결과 파일 이름 ----------
  /*
   * 게시판 다운로드 주소에는 파일 이름이 그대로 들어간다. #, & 같은 문자가 있으면
   * 주소가 중간에서 잘려 다운로드가 실패하므로 미리 지운다.
   * 그리고 어떤 설정으로 만든 파일인지 알 수 있게 요약을 덧붙인다. 예) 사진_w4_white_hint.png
   */
  function safeName(name) {
    return String(name || 'image')
      .replace(/\.[^.]+$/, '')
      .replace(/[#&?%+/\\:*"'<>|=@]/g, '')   // 주소를 깨뜨릴 수 있는 문자 제거
      .replace(/\s+/g, '_')
      .replace(/_{2,}/g, '_')
      .replace(/^[_.]+|[_.]+$/g, '')
      .slice(0, 60) || 'image';
  }
  function outputName(name, parts) {
    return safeName(name) + '_' + parts.filter(Boolean).join('_') + '.png';
  }

  // ---------- 파일 입력 도우미 ----------
  function isImage(f) { return f && /^image\//.test(f.type || 'image/'); }
  // 드롭존 하나에 클릭·끌어다 놓기를 연결
  function bindDropzone(zone, onFile) {
    zone.addEventListener('dragover', function (e) { e.preventDefault(); e.stopPropagation(); zone.classList.add('over'); });
    zone.addEventListener('dragleave', function () { zone.classList.remove('over'); });
    zone.addEventListener('drop', function (e) {
      e.preventDefault(); e.stopPropagation(); zone.classList.remove('over');
      var f = e.dataTransfer.files[0];
      if (isImage(f)) onFile(f, f.name);
    });
  }
  function pastedImage(e) {
    var items = (e.clipboardData || {}).items || [];
    for (var i = 0; i < items.length; i++) if (items[i].type.indexOf('image/') === 0) return items[i].getAsFile();
    return null;
  }

  root.GTUI = {
    $: $, FONT_STACK: FONT_STACK, initTheme: initTheme, loadImage: loadImage, fitSize: fitSize, rasterize: rasterize,
    encodeAsync: encodeAsync, fontReady: fontReady, fontSizeFor: fontSizeFor, setFittedFont: setFittedFont,
    status: status, startTimer: startTimer, nextFrame: nextFrame, showResult: showResult,
    isImage: isImage, bindDropzone: bindDropzone, pastedImage: pastedImage,
    safeName: safeName, outputName: outputName
  };
})(this);
