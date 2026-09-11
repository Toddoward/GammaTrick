/* cover.js — "다른 이미지로 숨기기" 페이지. 공통 화면 코드는 common.js(GTUI), 인코딩은 gt-core.js(encodeCover) */
(function () {
  'use strict';
  var U = GTUI, $ = U.$;
  var slots = {
    hidden: { blob: null, name: '', zone: $('#hiddenZone'), input: $('#hiddenInput'), preview: $('#hiddenPreview'), label: $('#hiddenName'), url: null },
    cover: { blob: null, name: '', zone: $('#coverZone'), input: $('#coverInput'), preview: $('#coverPreview'), label: $('#coverName'), url: null }
  };
  var lastSlot = null, busy = false, again = false;

  U.initTheme();

  // ---------- 입력 ----------
  function setSlot(key, blob, name) {
    if (!U.isImage(blob)) return;
    var s = slots[key];
    s.blob = blob; s.name = (name || 'image').replace(/\.[^.]+$/, '');
    s.label.textContent = name || '붙여넣은 이미지';
    if (s.url) URL.revokeObjectURL(s.url);
    s.url = URL.createObjectURL(blob);
    s.preview.src = s.url; s.preview.hidden = false;
    run();
  }
  Object.keys(slots).forEach(function (key) {
    var s = slots[key];
    U.bindDropzone(s.zone, function (f, n) { lastSlot = key; setSlot(key, f, n); });
    s.input.addEventListener('change', function () { if (this.files[0]) { lastSlot = key; setSlot(key, this.files[0], this.files[0].name); } });
    s.zone.addEventListener('focus', function () { lastSlot = key; });
    s.zone.addEventListener('click', function () { lastSlot = key; });
  });
  // 칸 밖에 떨어뜨린 파일은 받지 않고 브라우저가 파일을 여는 것만 막는다
  window.addEventListener('dragover', function (e) { e.preventDefault(); });
  window.addEventListener('drop', function (e) { e.preventDefault(); });
  window.addEventListener('paste', function (e) {
    var f = U.pastedImage(e);
    if (!f) return;
    var key = lastSlot || (!slots.hidden.blob ? 'hidden' : !slots.cover.blob ? 'cover' : 'hidden');
    setSlot(key, f, 'pasted.png');
  });

  // ---------- 옵션 ----------
  function opts() {
    return {
      N: Math.max(2, Math.min(8, parseInt($('#levels').value, 10) || 5)),
      fit: document.querySelector('input[name=fit]:checked').value,
      textOn: $('#textOn').checked,
      textTL: $('#textTL').value.trim(),
      textBR: $('#textBR').value.trim(),
      maxSide: parseInt($('#maxside').value, 10)
    };
  }
  function refreshOptionsUI() {
    var o = opts();
    $('#levelcount').textContent = o.N * o.N * o.N;
    $('#levelhint').textContent = '원본 이미지를 ' + (o.N * o.N * o.N) + '색으로 담습니다. 단계가 많을수록 원본은 선명해지고, '
      + '위장 이미지는 채널마다 최대 ±' + Math.floor(o.N / 2) + '만큼 흔들려 조금씩 거칠어집니다.';
    $('#textOptions').hidden = !o.textOn;
  }
  $('#options').addEventListener('change', function () { refreshOptionsUI(); run(); });
  $('#options').addEventListener('submit', function (e) { e.preventDefault(); });
  refreshOptionsUI();

  // 위장 이미지 위에 안내 문구: 흰 글씨 + 1px 검은 외곽선
  function drawCaption(ctx, W, H, px, tl, br) {
    var m = Math.round(px * 0.6), maxW = W - 2 * m;
    ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
    ctx.strokeStyle = '#000'; ctx.fillStyle = '#fff';
    ctx.lineWidth = 2;   // 선의 절반(1px)은 글씨 안쪽에 덮이고, 바깥 1px만 외곽선으로 남는다
    function put(text, align, x, y) {
      if (!text) return;
      U.setFittedFont(ctx, text, px, maxW);
      ctx.textAlign = align;
      ctx.strokeText(text, x, y);
      ctx.fillText(text, x, y);
    }
    put(tl, 'left', m, m + px / 2);
    put(br, 'right', W - m, H - m - px / 2);
  }

  // ---------- 처리 ----------
  function run() {
    if (!slots.hidden.blob || !slots.cover.blob) {
      U.status(slots.hidden.blob || slots.cover.blob ? '원본 이미지와 위장 이미지를 모두 넣어 주세요.' : '');
      return;
    }
    if (busy) { again = true; return; }
    busy = true;
    var o = opts(), stop = U.startTimer();
    Promise.all([U.loadImage(slots.hidden.blob), U.loadImage(slots.cover.blob)]).then(function (imgs) {
      var sz = U.fitSize(imgs[0], o.maxSide), w = sz.w, h = sz.h;
      var hidden = U.rasterize(imgs[0], w, h).getContext('2d').getImageData(0, 0, w, h).data;
      var coverCanvas = U.rasterize(imgs[1], w, h, o.fit), cctx = coverCanvas.getContext('2d');
      var font = U.fontSizeFor(w, h);
      return U.fontReady(font, o.textTL + o.textBR).then(function () {
        if (o.textOn) drawCaption(cctx, w, h, font, o.textTL, o.textBR);
        var cover = cctx.getImageData(0, 0, w, h).data;
        return U.nextFrame().then(function () {
          return U.encodeAsync('encodeCover', [hidden, cover, w, h, { N: o.N, kernel: 'floyd' }]);
        });
      });
    }).then(function (res) {
      stop(); U.showResult(res, slots.hidden.name + '_cover.png');
    }).catch(function (e) {
      stop(); U.status('오류: ' + e.message);
    }).then(function () {
      busy = false;
      if (again) { again = false; run(); }
    });
  }
})();
