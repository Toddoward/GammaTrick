/*
 * gt-core.js — GammaTrick 인코더 코어 (브라우저/Node 공용, DOM 의존 없음)
 *
 * 두 가지 "숨김" 방식:
 *   - 'gama' : PNG gAMA 청크 (원본 레포와 같은 원리, 호환성 우선)
 *   - 'icc'  : PNG iCCP 청크에 3D LUT(A2B0) ICC 프로필을 넣어
 *              저장값 {256-N..255}^3 조합마다 임의의 색을 대응 (화질 우선)
 *
 * 공통: 저장되는 픽셀은 채널당 256-N..255 (거의 흰색)만 사용하고,
 *       디더링은 선형광(linear light) 공간에서 오차 확산으로 수행한다.
 */
(function (root) {
  'use strict';

  // ---------- 색 공간 ----------
  var S2L = new Float32Array(256);
  for (var i = 0; i < 256; i++) {
    var c = i / 255;
    S2L[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  function linToSrgb(l) {
    if (l <= 0) return 0;
    if (l >= 1) return 255;
    return 255 * (l <= 0.0031308 ? 12.92 * l : 1.055 * Math.pow(l, 1 / 2.4) - 0.055);
  }
  // linear sRGB -> OKLab
  function oklab(r, g, b, out) {
    var l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    var m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    var s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    out[0] = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s;
    out[1] = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
    out[2] = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
    return out;
  }
  function oklabToLin(L, a, bb, out) {
    var l = L + 0.3963377774 * a + 0.2158037573 * bb;
    var m = L - 0.1055613458 * a - 0.0638541728 * bb;
    var s = L - 0.0894841775 * a - 1.2914855480 * bb;
    l = l * l * l; m = m * m * m; s = s * s * s;
    out[0] = +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
    out[1] = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
    out[2] = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;
    return out;
  }

  // ---------- 팔레트 ----------
  /*
   * gAMA 방식: 저장값 s(=256-N..255) -> 선형광 (s/255)^(1/fileGamma)
   * 채널별로 독립, 레벨 간격은 선형광 기준 등비수열.
   * darkest: 가장 어두운 레벨의 선형광 값 (원본 레포는 sRGB 64 ≈ 선형 0.051)
   */
  function gamaPalette(N, darkest) {
    var s0 = (256 - N) / 255;
    var invG = Math.log(darkest) / Math.log(s0);        // 1/fileGamma
    var gAMA = Math.max(1, Math.round(100000 / invG));  // PNG에 들어갈 정수
    invG = 100000 / gAMA;                              // 반올림 반영
    var levels = [];
    for (var k = 0; k < N; k++) levels.push(Math.pow((256 - N + k) / 255, invG));
    return { mode: 'gama', N: N, gAMA: gAMA, levels: levels };
  }

  // 결정적 난수 (재현 가능한 결과)
  function rng(seed) {
    return function () {
      seed |= 0; seed = seed + 0x6D2B79F5 | 0;
      var t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  /*
   * ICC 방식: 이미지에 맞춘 적응형 팔레트 K색 (K = N^3), OKLab k-means
   */
  function adaptivePalette(rgba, w, h, K, iters) {
    iters = iters || 12;
    var n = w * h, maxS = 30000, step = Math.max(1, Math.floor(n / maxS));
    var pts = [], t = [0, 0, 0];
    for (var p = 0; p < n; p += step) {
      var q = p * 4;
      oklab(S2L[rgba[q]], S2L[rgba[q + 1]], S2L[rgba[q + 2]], t);
      pts.push(t[0], t[1], t[2]);
    }
    var m = pts.length / 3, rand = rng(12345);
    var C = new Float64Array(K * 3), D = new Float64Array(m).fill(Infinity);
    // k-means++ 초기화
    var first = Math.floor(rand() * m);
    C[0] = pts[first * 3]; C[1] = pts[first * 3 + 1]; C[2] = pts[first * 3 + 2];
    for (var k = 1; k < K; k++) {
      var sum = 0;
      for (var j = 0; j < m; j++) {
        var dx = pts[j * 3] - C[(k - 1) * 3], dy = pts[j * 3 + 1] - C[(k - 1) * 3 + 1], dz = pts[j * 3 + 2] - C[(k - 1) * 3 + 2];
        var d = dx * dx + dy * dy + dz * dz;
        if (d < D[j]) D[j] = d;
        sum += D[j];
      }
      var r = rand() * sum, pick = m - 1;
      for (j = 0; j < m; j++) { r -= D[j]; if (r <= 0) { pick = j; break; } }
      C[k * 3] = pts[pick * 3]; C[k * 3 + 1] = pts[pick * 3 + 1]; C[k * 3 + 2] = pts[pick * 3 + 2];
    }
    var assign = new Int32Array(m);
    for (var it = 0; it < iters; it++) {
      var S = new Float64Array(K * 3), cnt = new Float64Array(K);
      for (j = 0; j < m; j++) {
        var best = 0, bd = Infinity;
        for (k = 0; k < K; k++) {
          dx = pts[j * 3] - C[k * 3]; dy = pts[j * 3 + 1] - C[k * 3 + 1]; dz = pts[j * 3 + 2] - C[k * 3 + 2];
          d = dx * dx + dy * dy + dz * dz;
          if (d < bd) { bd = d; best = k; }
        }
        assign[j] = best; cnt[best]++;
        S[best * 3] += pts[j * 3]; S[best * 3 + 1] += pts[j * 3 + 1]; S[best * 3 + 2] += pts[j * 3 + 2];
      }
      for (k = 0; k < K; k++) {
        if (cnt[k] > 0) { C[k * 3] = S[k * 3] / cnt[k]; C[k * 3 + 1] = S[k * 3 + 1] / cnt[k]; C[k * 3 + 2] = S[k * 3 + 2] / cnt[k]; }
        else { var rp = Math.floor(rand() * m); C[k * 3] = pts[rp * 3]; C[k * 3 + 1] = pts[rp * 3 + 1]; C[k * 3 + 2] = pts[rp * 3 + 2]; }
      }
    }
    // 디더링이 전 범위를 표현할 수 있도록 순수 흑/백을 보장 (가장 가까운 클러스터를 교체)
    var colors = [];
    for (k = 0; k < K; k++) {
      var lin = oklabToLin(C[k * 3], C[k * 3 + 1], C[k * 3 + 2], [0, 0, 0]);
      colors.push([clamp01(lin[0]), clamp01(lin[1]), clamp01(lin[2])]);
    }
    ensureColor(colors, [0, 0, 0]);
    ensureColor(colors, [1, 1, 1]);
    return { mode: 'icc', N: Math.round(Math.cbrt(K)), colors: colors };
  }
  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  function ensureColor(colors, c) {
    var best = 0, bd = Infinity, t1 = [0, 0, 0], t2 = [0, 0, 0];
    oklab(c[0], c[1], c[2], t1);
    for (var k = 0; k < colors.length; k++) {
      oklab(colors[k][0], colors[k][1], colors[k][2], t2);
      var d = (t1[0] - t2[0]) ** 2 + (t1[1] - t2[1]) ** 2 + (t1[2] - t2[2]) ** 2;
      if (d < bd) { bd = d; best = k; }
    }
    if (bd > 1e-6) colors[best] = c.slice();
  }

  // ---------- 디더링 ----------
  var KERNELS = {
    floyd: { dx: [1, -1, 0, 1], dy: [0, 1, 1, 1], w: [7 / 16, 3 / 16, 5 / 16, 1 / 16] },
    jjn: {
      dx: [1, 2, -2, -1, 0, 1, 2, -2, -1, 0, 1, 2], dy: [0, 0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2],
      w: [7, 5, 3, 5, 7, 5, 3, 1, 3, 5, 3, 1].map(function (v) { return v / 48; })
    }
  };

  /*
   * 선형광 오차 확산 디더링. 반환: 픽셀별 팔레트 인덱스
   *  - gama 모드: 채널별 레벨 인덱스 (0..N-1) 3개를 r*N*N+g*N+b 로 묶어서 반환
   *  - icc  모드: 적응형 팔레트 인덱스
   */
  function dither(rgba, w, h, pal, kernelName) {
    var ker = KERNELS[kernelName] || KERNELS.floyd;
    var buf = new Float32Array(w * h * 3);
    for (var p = 0; p < w * h; p++) {
      buf[p * 3] = S2L[rgba[p * 4]]; buf[p * 3 + 1] = S2L[rgba[p * 4 + 1]]; buf[p * 3 + 2] = S2L[rgba[p * 4 + 2]];
    }
    var out = new Int32Array(w * h), N = pal.N;
    var pick, colorsLin;
    if (pal.mode === 'gama') {
      var lv = pal.levels;
      pick = function (r, g, b) { return nearestLevel(lv, r) * N * N + nearestLevel(lv, g) * N + nearestLevel(lv, b); };
      colorsLin = [];
      for (var a = 0; a < N; a++) for (var bI = 0; bI < N; bI++) for (var cI = 0; cI < N; cI++) colorsLin.push([lv[a], lv[bI], lv[cI]]);
    } else {
      colorsLin = pal.colors;
      pick = nearestLabPicker(colorsLin);
    }
    for (var y = 0; y < h; y++) {
      var ltr = (y & 1) === 0, x0 = ltr ? 0 : w - 1, dir = ltr ? 1 : -1;
      for (var x = x0; x >= 0 && x < w; x += dir) {
        var i3 = (y * w + x) * 3;
        var r = clamp01(buf[i3]), g = clamp01(buf[i3 + 1]), b = clamp01(buf[i3 + 2]);
        var idx = pick(r, g, b), col = colorsLin[idx];
        out[y * w + x] = idx;
        // 오차는 0..1로 자른 목표값 기준으로 계산 (범위 밖 오차가 누적되어 생기는 얼룩 방지)
        var er = r - col[0], eg = g - col[1], eb = b - col[2];
        for (var k = 0; k < ker.w.length; k++) {
          var xx = x + ker.dx[k] * dir, yy = y + ker.dy[k];
          if (xx < 0 || xx >= w || yy >= h) continue;
          var j3 = (yy * w + xx) * 3, wk = ker.w[k];
          buf[j3] += er * wk; buf[j3 + 1] += eg * wk; buf[j3 + 2] += eb * wk;
        }
      }
    }
    return out;
  }
  function nearestLevel(lv, v) {
    var best = 0, bd = Infinity;
    for (var k = 0; k < lv.length; k++) { var d = Math.abs(lv[k] - v); if (d < bd) { bd = d; best = k; } }
    return best;
  }
  // OKLab 최근접 색 + 캐시(선형값 6bit 양자화)로 속도 확보
  function nearestLabPicker(colors) {
    var K = colors.length, L = new Float64Array(K * 3), t = [0, 0, 0];
    for (var k = 0; k < K; k++) { oklab(colors[k][0], colors[k][1], colors[k][2], t); L[k * 3] = t[0]; L[k * 3 + 1] = t[1]; L[k * 3 + 2] = t[2]; }
    var cache = new Int16Array(1 << 18).fill(-1);
    return function (r, g, b) {
      // sRGB 코드값 기준 6bit 양자화 (지각적으로 고른 격자)
      var key = (Math.round(linToSrgb(r) / 255 * 63) << 12) | (Math.round(linToSrgb(g) / 255 * 63) << 6) | Math.round(linToSrgb(b) / 255 * 63);
      var hit = cache[key];
      if (hit >= 0) return hit;
      oklab(r, g, b, t);
      var best = 0, bd = Infinity;
      for (var k = 0; k < K; k++) {
        var dx = t[0] - L[k * 3], dy = t[1] - L[k * 3 + 1], dz = t[2] - L[k * 3 + 2];
        var d = dx * dx + dy * dy + dz * dz;
        if (d < bd) { bd = d; best = k; }
      }
      cache[key] = best;
      return best;
    };
  }

  // ---------- 저장값 배치 ----------
  /*
   * 인덱스 -> 실제 저장될 (R,G,B) 바이트
   *  gama: 레벨 k -> 256-N+k (고정)
   *  icc : 많이 쓰인 색일수록 흰색(255,255,255)에 가까운 저장값 조합에 배정해
   *        미리보기(썸네일)에 비치는 잔상을 최소화
   */
  function assignStored(pal, idx) {
    var N = pal.N, base = 256 - N;
    if (pal.mode === 'gama') {
      return { triples: null, map: function (i) { return [base + Math.floor(i / (N * N)), base + Math.floor(i / N) % N, base + i % N]; } };
    }
    var K = pal.colors.length, count = new Float64Array(K);
    for (var p = 0; p < idx.length; p++) count[idx[p]]++;
    var order = []; for (var k = 0; k < K; k++) order.push(k);
    order.sort(function (a, b) { return count[b] - count[a]; });
    var slots = [];
    for (var r = 0; r < N; r++) for (var g = 0; g < N; g++) for (var b = 0; b < N; b++) {
      var sr = 255 - r, sg = 255 - g, sb = 255 - b;
      // 저장값이 흰색에서 얼마나 어두워 보이는지 (휘도 기준)
      var cost = 1 - (0.2126 * S2L[sr] + 0.7152 * S2L[sg] + 0.0722 * S2L[sb]);
      slots.push({ s: [sr, sg, sb], cost: cost });
    }
    slots.sort(function (a, b) { return a.cost - b.cost; });
    var triples = new Array(K);
    for (k = 0; k < K; k++) triples[order[k]] = slots[k].s;
    return { triples: triples, map: function (i) { return triples[i]; } };
  }

  // ---------- ICC 프로필 (v2, A2B0 = lut16 3D CLUT) ----------
  var M_D50 = [[0.4360747, 0.3850649, 0.1430804], [0.2225045, 0.7168786, 0.0606169], [0.0139322, 0.0971045, 0.7141733]];
  function Bytes() { this.a = []; }
  Bytes.prototype.u8 = function (v) { this.a.push(v & 255); return this; };
  Bytes.prototype.u16 = function (v) { this.a.push((v >>> 8) & 255, v & 255); return this; };
  Bytes.prototype.u32 = function (v) { this.a.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255); return this; };
  Bytes.prototype.s15 = function (v) { return this.u32(Math.round(v * 65536) | 0); };
  Bytes.prototype.str = function (s) { for (var i = 0; i < s.length; i++) this.a.push(s.charCodeAt(i)); return this; };
  Bytes.prototype.zero = function (n) { for (var i = 0; i < n; i++) this.a.push(0); return this; };
  Bytes.prototype.pad4 = function () { while (this.a.length % 4) this.a.push(0); return this; };

  function iccProfile(pal, triples) {
    var N = pal.N, G = N + 1, K = pal.colors.length;
    // 격자 좌표: 0 = "256-N 미만" (테두리/글씨 → 검정), k+1 = 저장값 256-N+k
    var lut = new Array(G * G * G);
    for (var i = 0; i < lut.length; i++) lut[i] = [0, 0, 0];
    for (var k = 0; k < K; k++) {
      var s = triples[k], c = pal.colors[k];
      var gi = ((s[0] - (256 - N) + 1) * G + (s[1] - (256 - N) + 1)) * G + (s[2] - (256 - N) + 1);
      lut[gi] = [
        M_D50[0][0] * c[0] + M_D50[0][1] * c[1] + M_D50[0][2] * c[2],
        M_D50[1][0] * c[0] + M_D50[1][1] * c[1] + M_D50[1][2] * c[2],
        M_D50[2][0] * c[0] + M_D50[2][1] * c[1] + M_D50[2][2] * c[2]];
    }
    var tags = [];
    var desc = new Bytes().str('desc').zero(4).u32(10).str('GammaTrick').zero(12 + 3 + 67);
    tags.push(['desc', desc.a]);
    tags.push(['cprt', new Bytes().str('text').zero(4).str('Public Domain').u8(0).a]);
    tags.push(['wtpt', new Bytes().str('XYZ ').zero(4).s15(0.9642).s15(1).s15(0.8249).a]);
    var a2b = new Bytes().str('mft2').zero(4).u8(3).u8(3).u8(G).u8(0);
    [1, 0, 0, 0, 1, 0, 0, 0, 1].forEach(function (v) { a2b.s15(v); });
    a2b.u16(256).u16(2);
    for (var ch = 0; ch < 3; ch++) for (var v = 0; v < 256; v++) {
      var gpos = v < 256 - N ? 0 : (v - (256 - N) + 1) / (G - 1);
      a2b.u16(Math.round(gpos * 65535));
    }
    // (Chromium/skcms 실측: lut16 XYZ PCS는 1.0 = 65535 로 해석됨)
    for (i = 0; i < lut.length; i++) for (ch = 0; ch < 3; ch++) a2b.u16(Math.round(clamp01(lut[i][ch]) * 65535));
    for (ch = 0; ch < 3; ch++) a2b.u16(0).u16(65535);
    tags.push(['A2B0', a2b.a]);
    // A2B0를 모르는 CMS를 위한 대체 태그 (전부 검정 → 이미지가 드러나지 않음)
    ['rXYZ', 'gXYZ', 'bXYZ'].forEach(function (t, j) { tags.push([t, new Bytes().str('XYZ ').zero(4).s15(M_D50[0][j]).s15(M_D50[1][j]).s15(M_D50[2][j]).a]); });
    var curv = new Bytes().str('curv').zero(4).u32(2).u16(0).u16(0);
    ['rTRC', 'gTRC', 'bTRC'].forEach(function (t) { tags.push([t, curv.a]); });

    var n = tags.length, off = 128 + 4 + 12 * n, body = new Bytes(), table = new Bytes().u32(n);
    tags.forEach(function (t) {
      while ((off + body.a.length) % 4) body.u8(0);
      table.str(t[0]).u32(off + body.a.length).u32(t[1].length);
      Array.prototype.push.apply(body.a, t[1]);
    });
    body.pad4();
    var size = off + body.a.length;
    var hdr = new Bytes().u32(size).zero(4).u32(0x02100000).str('mntr').str('RGB ').str('XYZ ').zero(12)
      .str('acsp').zero(4).zero(4).zero(8).zero(8).u32(0).s15(0.9642).s15(1).s15(0.8249).zero(4).zero(16).zero(28);
    return new Uint8Array(hdr.a.concat(table.a, body.a));
  }

  // ---------- PNG ----------
  var CRC = new Int32Array(256);
  for (var n0 = 0; n0 < 256; n0++) { var c0 = n0; for (var k0 = 0; k0 < 8; k0++) c0 = c0 & 1 ? 0xEDB88320 ^ (c0 >>> 1) : c0 >>> 1; CRC[n0] = c0; }
  function crc32(bytes) { var c = -1; for (var i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; }
  function pngChunk(type, data) {
    var out = new Uint8Array(12 + data.length), dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    for (var i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
  }
  function concat(list) {
    var len = 0; list.forEach(function (a) { len += a.length; });
    var out = new Uint8Array(len), o = 0;
    list.forEach(function (a) { out.set(a, o); o += a.length; });
    return out;
  }
  /*
   * rgb: Uint8Array (w*h*3). deflate: async (Uint8Array)->Uint8Array (zlib 포맷)
   * extra: gAMA 또는 iCCP 청크 정보
   */
  function encodePNG(rgb, w, h, extra, deflate) {
    var stride = w * 3, raw = new Uint8Array((stride + 1) * h);
    for (var y = 0; y < h; y++) {
      // 필터: None / Up 중 절댓값 합이 작은 쪽
      var row = rgb.subarray(y * stride, (y + 1) * stride), prev = y > 0 ? rgb.subarray((y - 1) * stride, y * stride) : null;
      var o = y * (stride + 1), sNone = 0, sUp = 0;
      for (var i = 0; i < stride; i++) { sNone += row[i] < 128 ? row[i] : 256 - row[i]; if (prev) { var d = (row[i] - prev[i]) & 255; sUp += d < 128 ? d : 256 - d; } }
      if (prev && sUp < sNone) { raw[o] = 2; for (i = 0; i < stride; i++) raw[o + 1 + i] = (row[i] - prev[i]) & 255; }
      else { raw[o] = 0; raw.set(row, o + 1); }
    }
    var ihdr = new Uint8Array(13), dv = new DataView(ihdr.buffer);
    dv.setUint32(0, w); dv.setUint32(4, h); ihdr[8] = 8; ihdr[9] = 2;
    var jobs = [deflate(raw)];
    if (extra.icc) jobs.push(deflate(extra.icc));
    return Promise.all(jobs).then(function (res) {
      var parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', ihdr)];
      if (extra.gAMA) {
        var g = new Uint8Array(4); new DataView(g.buffer).setUint32(0, extra.gAMA);
        parts.push(pngChunk('gAMA', g));
      }
      if (extra.icc) {
        var name = [71, 97, 109, 109, 97, 84, 114, 105, 99, 107, 0, 0]; // "GammaTrick\0" + 압축방식 0
        parts.push(pngChunk('iCCP', concat([new Uint8Array(name), res[1]])));
      }
      parts.push(pngChunk('IDAT', res[0]), pngChunk('IEND', new Uint8Array(0)));
      return concat(parts);
    });
  }

  // ---------- 전체 파이프라인 ----------
  /*
   * opts: { mode:'icc'|'gama', N, darkest(gama 전용), kernel, border, overlay }
   *   overlay(선택): 테두리 영역에 찍을 글씨 마스크 (Float32Array, 최종 크기 W*H, 0..1)
   *   overlayMode : 'hide'(기본, 원본 보기에선 글씨가 사라짐) | 'show'(원본 보기에서도 보임)
   * 반환: { png, stored(Uint8Array W*H*3), shown(Float32 선형광 W*H*3), W, H, pal }
   */
  function encode(rgba, w, h, opts, deflate) {
    var N = opts.N, pal;
    if (opts.mode === 'gama') pal = gamaPalette(N, opts.darkest || 0.02);
    else pal = adaptivePalette(rgba, w, h, N * N * N);
    var idx = dither(rgba, w, h, pal, opts.kernel);
    var st = assignStored(pal, idx);
    var B = opts.border | 0, W = w + 2 * B, H = h + 2 * B;
    var stored = new Uint8Array(W * H * 3);
    for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) {
      var s = st.map(idx[y * w + x]), o = ((y + B) * W + x + B) * 3;
      stored[o] = s[0]; stored[o + 1] = s[1]; stored[o + 2] = s[2];
    }
    if (opts.overlay) {
      // 테두리 글씨. 'hide': 저장값 235 이하 회색 → 미리보기엔 흰 글씨, 원본 보기에선 검정(테두리와 같은 색)으로 사라짐
      //             'show': 원본 보기에서도 흰색으로 보이는 저장값 사용 (안티앨리어싱 없이 이진화)
      var ov = opts.overlay, show = opts.overlayMode === 'show', white = [255, 255, 255];
      if (show && pal.mode === 'icc') {
        for (var k = 0; k < pal.colors.length; k++) {
          var cc = pal.colors[k];
          if (cc[0] === 1 && cc[1] === 1 && cc[2] === 1) { white = st.triples[k]; break; }
        }
      }
      var hideVal = Math.min(235, 255 - N - 5);
      for (var p = 0; p < W * H; p++) {
        var yy = Math.floor(p / W), xx = p % W;
        if (yy >= B && yy < B + h && xx >= B && xx < B + w) continue; // 이미지 영역은 건드리지 않음
        if (show) {
          if (ov[p] >= 0.5) { stored[p * 3] = white[0]; stored[p * 3 + 1] = white[1]; stored[p * 3 + 2] = white[2]; }
        } else {
          var v = Math.round(hideVal * ov[p]);
          if (v > stored[p * 3]) stored[p * 3] = stored[p * 3 + 1] = stored[p * 3 + 2] = v;
        }
      }
    }
    var extra = pal.mode === 'gama' ? { gAMA: pal.gAMA } : { icc: iccProfile(pal, st.triples) };
    return encodePNG(stored, W, H, extra, deflate).then(function (png) {
      return { png: png, stored: stored, W: W, H: H, pal: pal, shown: simulateShown(stored, W, H, pal, st) };
    });
  }

  // 원본 보기에서 보일 선형광 값 (검증/미리보기용)
  function simulateShown(stored, W, H, pal, st) {
    var out = new Float32Array(W * H * 3), N = pal.N, base = 256 - N, lut = {};
    if (pal.mode === 'icc') st.triples.forEach(function (t, k) { lut[(t[0] << 16) | (t[1] << 8) | t[2]] = pal.colors[k]; });
    var invG = pal.mode === 'gama' ? 100000 / pal.gAMA : 0;
    for (var p = 0; p < W * H; p++) {
      var r = stored[p * 3], g = stored[p * 3 + 1], b = stored[p * 3 + 2];
      if (pal.mode === 'gama') {
        out[p * 3] = Math.pow(r / 255, invG); out[p * 3 + 1] = Math.pow(g / 255, invG); out[p * 3 + 2] = Math.pow(b / 255, invG);
      } else {
        var c = (r >= base && g >= base && b >= base) ? lut[(r << 16) | (g << 8) | b] : null;
        if (c) { out[p * 3] = c[0]; out[p * 3 + 1] = c[1]; out[p * 3 + 2] = c[2]; }
      }
    }
    return out;
  }

  var api = {
    S2L: S2L, linToSrgb: linToSrgb, oklab: oklab,
    gamaPalette: gamaPalette, adaptivePalette: adaptivePalette, dither: dither,
    assignStored: assignStored, iccProfile: iccProfile, encodePNG: encodePNG, encode: encode
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GTCore = api;
})(this);
