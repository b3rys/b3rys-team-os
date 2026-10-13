/* b3-ma-cross — 이동평균선 두 개의 기간을 바꿔 가며 골든크로스·데드크로스가 어디서 생기는지 보는 차트.
 * 규약: references/interactive-components.md
 * 가격은 설명용 예시 — 고정된 씨앗(seed) 목록으로 만든 무작위 걸음(매일 오를지 내릴지를 무작위로 정한 가격)이다.
 * 이동평균 = 최근 N일 종가의 산술평균(SMA). 교차 = (단기선 − 장기선)의 부호가 바뀐 날.
 * 장기선 방향 = 그날 장기선 값이 전날보다 높으면 상향, 낮으면 하향(이 그림의 약속).
 * MD 사용 예: <b3-ma-cross class="ix" data-short="5" data-long="50" data-flow="1">…정적 그림…</b3-ma-cross>
 */
(function () {
  'use strict';
  var NAME = 'b3-ma-cross';
  var SEEDS = [3, 13, 90210, 15, 19, 101];
  var N = 440;          // 만드는 날 수
  var S = 200;          // 보여 주는 첫날(이 앞은 200일선을 계산하려고 깔아 두는 과거)
  var SHORT_MIN = 2, SHORT_MAX = 60, LONG_MIN = 10, LONG_MAX = 200;
  var PRESETS = [ // 보고서 2-2 표(카드 ⑤): 단기 매매 5·50 / 중기 매매 10·100 / 장기 매매 20·200
    { label: '단기 매매 5·50', s: 5, l: 50 },
    { label: '중기 매매 10·100', s: 10, l: 100 },
    { label: '장기 매매 20·200', s: 20, l: 200 }
  ];

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  // 하루 변동률 표준편차 1.6%, 평균 0 — 방향에 치우침이 없는 무작위 걸음
  function series(seed) {
    var r = mulberry32(seed), p = 100, out = [];
    for (var i = 0; i < N; i++) {
      if (i > 0) {
        var u = r() || 1e-12, v = r();
        var z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
        p = p * Math.exp(0.016 * z);
      }
      out.push(Math.round(p * 100) / 100);
    }
    return out;
  }
  // 단순이동평균: i일의 값 = i-n+1 … i 일 종가의 산술평균. 앞쪽 n-1일은 값이 없다(null).
  function sma(arr, n) {
    var out = new Array(arr.length).fill(null), sum = 0;
    for (var i = 0; i < arr.length; i++) {
      sum += arr[i];
      if (i >= n) sum -= arr[i - n];
      if (i >= n - 1) out[i] = sum / n;
    }
    return out;
  }
  function compute(seedIdx, s, l) {
    var p = series(SEEDS[seedIdx]);
    var a = sma(p, s), b = sma(p, l), crosses = [], last = 0;
    for (var t = S - 1; t < N; t++) {
      var d = a[t] - b[t], sg = d > 0 ? 1 : d < 0 ? -1 : 0;
      if (sg === 0) continue;
      if (last !== 0 && sg !== last && t >= S) {
        var slope = b[t] - b[t - 1];
        var type = sg > 0 ? 'golden' : 'dead';
        crosses.push({
          t: t, type: type, longDir: slope > 0 ? 1 : slope < 0 ? -1 : 0,
          // 카드 ⑤ 아래 두 칸: 골든크로스여도 장기선이 하향이면 '사지 마', 데드크로스여도 상향이면 '팔지 마'
          filtered: (type === 'golden' && slope < 0) || (type === 'dead' && slope > 0),
          y: (a[t] + b[t]) / 2
        });
      }
      last = sg;
    }
    var g = crosses.filter(function (c) { return c.type === 'golden'; });
    var dd = crosses.filter(function (c) { return c.type === 'dead'; });
    return {
      p: p, a: a, b: b, s: s, l: l, seedIdx: seedIdx, crosses: crosses,
      golden: g.length, goldenFiltered: g.filter(function (c) { return c.filtered; }).length,
      dead: dd.length, deadFiltered: dd.filter(function (c) { return c.filtered; }).length
    };
  }

  function f1(v) { return (Math.round(v * 10) / 10).toFixed(1); }
  // 차트 SVG 문자열. opts.text=false 면 글자를 넣지 않는다(정적 그림용 — 좁은 화면에서 글자가 줄어 보이지 않게).
  function svg(m, W, H, opts) {
    opts = opts || {};
    var text = opts.text !== false;
    var padL = 6, padR = text ? 44 : 6, padT = 10, padB = text ? 26 : 8;
    var lo = Infinity, hi = -Infinity;
    for (var t = S; t < N; t++) {
      [m.p[t], m.a[t], m.b[t]].forEach(function (v) { if (v < lo) lo = v; if (v > hi) hi = v; });
    }
    var span = hi - lo || 1; lo -= span * 0.06; hi += span * 0.06;
    function X(t) { return padL + (t - S) / (N - 1 - S) * (W - padL - padR); }
    function Y(v) { return padT + (hi - v) / (hi - lo) * (H - padT - padB); }
    function path(arr) {
      var d = '';
      for (var t = S; t < N; t++) d += (t === S ? 'M' : 'L') + X(t).toFixed(1) + ' ' + Y(arr[t]).toFixed(1);
      return d;
    }
    var o = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="설명용 예시 가격과 ' + m.s + '일선·' + m.l + '일선, 골든크로스 ' + m.golden + '번·데드크로스 ' + m.dead + '번">';
    // 가로 눈금 — 1·2·2.5·5×10ⁿ 간격의 반올림한 값에 긋는다
    var raw = (hi - lo) / 4, mag = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10)), fr = raw / mag;
    var step = (fr <= 1 ? 1 : fr <= 2 ? 2 : fr <= 2.5 ? 2.5 : fr <= 5 ? 5 : 10) * mag;
    for (var gv = Math.ceil(lo / step) * step; gv <= hi; gv += step) {
      var gy = Y(gv).toFixed(1);
      o += '<path d="M' + padL + ' ' + gy + 'H' + (W - padR) + '" style="stroke:var(--line);stroke-width:1" />';
      if (text) o += '<text x="' + (W - padR + 6) + '" y="' + (+gy + 4) + '" class="b3ma-t">' + (+gv.toFixed(2)) + '</text>';
    }
    // 교차한 날 세로 점선
    m.crosses.forEach(function (c) {
      o += '<path d="M' + X(c.t).toFixed(1) + ' ' + padT + 'V' + (H - padB) + '" style="stroke:var(' + (c.type === 'golden' ? '--green' : '--red') + ');stroke-width:1;stroke-dasharray:3 4;opacity:.55" />';
    });
    o += '<path d="' + path(m.p) + '" style="fill:none;stroke:var(--mut);stroke-width:1.1;opacity:.75" />';
    o += '<path d="' + path(m.b) + '" style="fill:none;stroke:var(--orange);stroke-width:2.4" />';
    o += '<path d="' + path(m.a) + '" style="fill:none;stroke:var(--green);stroke-width:2.2" />';
    m.crosses.forEach(function (c) {
      var col = c.type === 'golden' ? 'var(--green)' : 'var(--red)';
      o += '<circle class="b3ma-x" data-t="' + c.t + '" data-type="' + c.type + '" data-filtered="' + c.filtered + '" cx="' + X(c.t).toFixed(1) + '" cy="' + Y(c.y).toFixed(1) + '" r="6" style="' +
        (c.filtered ? 'fill:var(--card);stroke:' + col + ';stroke-width:2.4' : 'fill:' + col + ';stroke:var(--card);stroke-width:1.5') + '" />';
    });
    if (text) {
      o += '<text x="' + padL + '" y="' + (H - 6) + '" class="b3ma-t">' + (N - S) + '일 전</text>';
      o += '<text x="' + (W - padR) + '" y="' + (H - 6) + '" class="b3ma-t" text-anchor="end">오늘 →</text>';
    }
    return o + '</svg>';
  }
  function readout(m) {
    return '<span class="b3ma-line" style="display:block"><b class="ix-strong">골든크로스 ' + m.golden + '번</b> — 그중 장기선이 내려가던 때 ' + m.goldenFiltered + '번(카드: 사지 마)</span>' +
      '<span class="b3ma-line" style="display:block"><b class="ix-bad">데드크로스 ' + m.dead + '번</b> — 그중 장기선이 오르던 때 ' + m.deadFiltered + '번(카드: 팔지 마)</span>';
  }
  var SW = 'display:inline-block;width:16px;height:3px;border-radius:2px;background:';
  var DOT = 'display:inline-block;width:10px;height:10px;border-radius:50%;box-sizing:border-box;';
  var IT = '<span style="display:inline-flex;align-items:center;gap:6px">';
  // 범례는 인라인 스타일 — 스크립트가 안 도는 정적 그림에서도 같은 모양
  var LEGEND = '<div class="b3ma-legend" style="display:flex;flex-wrap:wrap;gap:4px 14px;font-size:13px;color:var(--mut);margin:6px 0">' +
    IT + '<i style="' + SW + 'var(--mut)"></i>가격</span>' +
    IT + '<i style="' + SW + 'var(--green)"></i>단기선</span>' +
    IT + '<i style="' + SW + 'var(--orange)"></i>장기선</span>' +
    IT + '<i style="' + DOT + 'background:var(--green)"></i>골든크로스</span>' +
    IT + '<i style="' + DOT + 'background:var(--red)"></i>데드크로스</span>' +
    IT + '<i style="' + DOT + 'border:2px solid var(--mut);background:var(--card)"></i>장기선 방향과 어긋난 교차</span></div>';

  var core = { SEEDS: SEEDS, N: N, S: S, PRESETS: PRESETS, series: series, sma: sma, compute: compute, svg: svg, readout: readout, LEGEND: LEGEND };
  if (typeof module !== 'undefined' && module.exports) { module.exports = core; return; }
  if (typeof customElements === 'undefined' || customElements.get(NAME)) return;

  var CSS = NAME + '{display:block}' +
    NAME + ' .b3ma-chart{margin:6px 0 2px;min-height:120px}' +
    NAME + ' .b3ma-t{fill:var(--mut);font:500 13px/1 var(--mono);font-variant-numeric:tabular-nums}' +
    NAME + ' .b3ma-out{margin:6px 0;font-size:14px;line-height:1.6;color:var(--ink)}' +
    NAME + ' .b3ma-ctl{display:grid;grid-template-columns:auto minmax(0,1fr) 3.6em;align-items:center;gap:4px 10px;margin:8px 0}' +
    NAME + ' .b3ma-ctl input[type=range]{width:100%;min-width:0}' +
    NAME + ' .b3ma-ctl .ix-value{text-align:right}';

  customElements.define(NAME, class extends HTMLElement {
    connectedCallback() {
      if (this._ready) return;
      this._ready = true;
      if (!document.head.querySelector('style[data-b3="ma-cross"]')) {
        var st = document.createElement('style'); st.setAttribute('data-b3', 'ma-cross'); st.textContent = CSS;
        document.head.appendChild(st);
      }
      var clamp = function (v, a, b) { return Math.max(a, Math.min(b, v)); };
      this.s = clamp(parseInt(this.dataset.short, 10) || 5, SHORT_MIN, SHORT_MAX);
      this.l = clamp(parseInt(this.dataset.long, 10) || 50, LONG_MIN, LONG_MAX);
      if (this.s >= this.l) this.l = Math.min(LONG_MAX, this.s + 1);
      this.flow = clamp((parseInt(this.dataset.flow, 10) || 1) - 1, 0, SEEDS.length - 1);
      var uid = 'b3ma' + Math.random().toString(36).slice(2, 8);
      var title = this.querySelector('.ix-title'), cap = this.querySelector('.ix-caption'), note = this.querySelector('.ix-note');
      [].slice.call(this.children).forEach(function (c) { if (c !== title && c !== cap && c !== note) c.remove(); });
      var ui = document.createElement('div');
      ui.innerHTML =
        '<div class="ix-seg" role="group" aria-label="카드 ⑤ 표의 기간 조합">' +
        PRESETS.map(function (p, i) { return '<button type="button" class="ix-btn" data-preset="' + i + '">' + p.label + '</button>'; }).join('') + '</div>' +
        '<div class="b3ma-ctl"><label class="ix-label" for="' + uid + 's">단기선</label><input id="' + uid + 's" type="range" min="' + SHORT_MIN + '" max="' + SHORT_MAX + '" step="1" aria-label="단기선 기간(일)" data-k="s"><span class="ix-value" data-v="s"></span>' +
        '<label class="ix-label" for="' + uid + 'l">장기선</label><input id="' + uid + 'l" type="range" min="' + LONG_MIN + '" max="' + LONG_MAX + '" step="1" aria-label="장기선 기간(일)" data-k="l"><span class="ix-value" data-v="l"></span></div>' +
        '<div class="b3ma-chart"></div>' +
        LEGEND +
        '<p class="b3ma-out" aria-live="polite"></p>' +
        '<div class="ix-row"><button type="button" class="ix-btn" data-act="flow">다른 가격 흐름 ↻</button><span class="ix-label" data-v="flow"></span></div>';
      var frag = document.createDocumentFragment();
      while (ui.firstChild) frag.appendChild(ui.firstChild);
      if (title && title.nextSibling) this.insertBefore(frag, title.nextSibling); else this.insertBefore(frag, this.firstChild);
      var self = this;
      this.qs = function (sel) { return self.querySelector(sel); };
      this.inS = this.qs('input[data-k="s"]'); this.inL = this.qs('input[data-k="l"]');
      this.inS.addEventListener('input', function () {
        self.s = +self.inS.value; if (self.s >= self.l) self.l = Math.min(LONG_MAX, self.s + 1); self.update();
      });
      this.inL.addEventListener('input', function () {
        self.l = +self.inL.value; if (self.l <= self.s) self.s = Math.max(SHORT_MIN, self.l - 1); self.update();
      });
      [].slice.call(this.querySelectorAll('[data-preset]')).forEach(function (btn) {
        btn.addEventListener('click', function () { var p = PRESETS[+btn.dataset.preset]; self.s = p.s; self.l = p.l; self.update(); });
      });
      this.qs('[data-act="flow"]').addEventListener('click', function () { self.flow = (self.flow + 1) % SEEDS.length; self.update(); });
      this._w = 0;
      if (typeof ResizeObserver !== 'undefined') {
        this._ro = new ResizeObserver(function () { var w = self.qs('.b3ma-chart').clientWidth; if (w && w !== self._w) self.draw(); });
        this._ro.observe(this);
      }
      this.update();
    }
    disconnectedCallback() { if (this._ro) this._ro.disconnect(); this._ready = false; }
    update() {
      this.inS.value = this.s; this.inL.value = this.l;
      this.qs('[data-v="s"]').textContent = this.s + '일';
      this.qs('[data-v="l"]').textContent = this.l + '일';
      var s = this.s, l = this.l;
      [].slice.call(this.querySelectorAll('[data-preset]')).forEach(function (btn) {
        var p = PRESETS[+btn.dataset.preset]; btn.setAttribute('aria-pressed', String(p.s === s && p.l === l));
      });
      this.qs('[data-v="flow"]').textContent = '흐름 ' + (this.flow + 1) + ' / ' + SEEDS.length;
      this.model = compute(this.flow, s, l);
      this.qs('.b3ma-out').innerHTML = readout(this.model);
      this.draw();
    }
    draw() {
      var box = this.qs('.b3ma-chart'), W = Math.max(260, Math.round(box.clientWidth || 600));
      this._w = box.clientWidth;
      var H = W < 520 ? 230 : 300;
      box.innerHTML = svg(this.model, W, H, { text: true });
    }
  });
})();
