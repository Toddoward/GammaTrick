/* gamma.js — "흰 화면으로 숨기기" 페이지. 공통 화면 코드는 common.js(GTUI), 인코딩은 gt-core.js */
(function () {
  'use strict';
  var U = GTUI, $ = U.$;
  var GAMA_DARKEST = 0.005;   // gAMA 방식의 가장 어두운 레벨 (선형광). 실험으로 고른 값
  var srcBlob = null, srcName = 'image', busy = false, again = false;

  U.initTheme();

  // ---------- 입력 ----------
  function setSource(blob, name) {
    if (!U.isImage(blob)) return;
    srcBlob = blob;
    srcName = (name || 'image').replace(/\.[^.]+$/, '');
    $('#filename').textContent = name || '붙여넣은 이미지';
    run();
  }
  var dz = $('#dropzone');
  U.bindDropzone(dz, setSource);
  // 드롭존 밖에 떨어뜨려도 받아준다
  window.addEventListener('dragover', function (e) { e.preventDefault(); });
  window.addEventListener('drop', function (e) {
    e.preventDefault();
    var f = e.dataTransfer.files[0];
    if (U.isImage(f)) setSource(f, f.name);
  });
  window.addEventListener('paste', function (e) { var f = U.pastedImage(e); if (f) setSource(f, 'pasted.png'); });
  $('#fileinput').addEventListener('change', function () { if (this.files[0]) setSource(this.files[0], this.files[0].name); });
  $('#sample').addEventListener('click', function () { if (window.img_blob) setSource(window.img_blob, 'sample.png'); });

  // ---------- 옵션 ----------
  function opts() {
    var mode = document.querySelector('input[name=mode]:checked').value;
    return {
      mode: mode,
      N: Math.max(2, Math.min(8, parseInt($('#levels').value, 10) || 5)),
      inset: mode === 'icc' && $('#inset').checked,
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
    // '원본 크기 그대로 테두리 생성'은 ICC 방식에서만 가능
    var inset = $('#inset');
    inset.disabled = o.mode !== 'icc';
    if (inset.disabled) inset.checked = false;
    $('#insetLabel').classList.toggle('disabled', inset.disabled);
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

  // ---------- 테두리 ----------
  function borderWidth(font, textOn) { return textOn ? Math.max(15, Math.round(font * 1.7)) : 15; }

  // 테두리 글씨 마스크 (W*H, 0..1). W,H는 최종 PNG 크기, B는 테두리 두께
  function textMask(W, H, B, px, tl, br) {
    var c = document.createElement('canvas'); c.width = W; c.height = H;
    var x = c.getContext('2d');
    x.fillStyle = '#000'; x.fillRect(0, 0, W, H);
    x.fillStyle = '#fff'; x.textBaseline = 'middle';
    var maxW = W - 2 * B;
    if (tl) { U.setFittedFont(x, tl, px, maxW); x.textAlign = 'left'; x.fillText(tl, B, B / 2); }
    if (br) { U.setFittedFont(x, br, px, maxW); x.textAlign = 'right'; x.fillText(br, W - B, H - B / 2); }
    var d = x.getImageData(0, 0, W, H).data, m = new Float32Array(W * H);
    for (var i = 0; i < W * H; i++) m[i] = d[i * 4] / 255;
    return m;
  }

  // ---------- 처리 ----------
  function run() {
    if (!srcBlob) return;
    if (busy) { again = true; return; }
    busy = true;
    var o = opts(), stop = U.startTimer();
    U.loadImage(srcBlob).then(function (img) {
      var sz = U.fitSize(img, o.maxSide), w = sz.w, h = sz.h;
      var rgba = U.rasterize(img, w, h).getContext('2d').getImageData(0, 0, w, h).data;
      var font = U.fontSizeFor(w, h), B = borderWidth(font, o.textOn);
      // 원본 크기 그대로 테두리면 PNG 크기 = 이미지 크기, 아니면 테두리만큼 커짐
      var W = o.inset ? w : w + 2 * B, H = o.inset ? h : h + 2 * B;
      return U.fontReady(font, o.textTL + o.textBR).then(function () {
        var overlay = o.textOn && (o.textTL || o.textBR) ? textMask(W, H, B, font, o.textTL, o.textBR) : null;
        return U.nextFrame().then(function () {
          return U.encodeAsync('encode', [rgba, w, h, {
            mode: o.mode, N: o.N, darkest: GAMA_DARKEST, kernel: 'floyd',
            border: B, insetBorder: o.inset, overlay: overlay, overlayMode: o.textHide ? 'hide' : 'show'
          }]);
        });
      });
    }).then(function (res) {
      stop(); U.showResult(res, srcName + '_gamma.png');
    }).catch(function (e) {
      stop(); U.status('오류: ' + e.message);
    }).then(function () {
      busy = false;
      if (again) { again = false; run(); }
    });
  }
})();
