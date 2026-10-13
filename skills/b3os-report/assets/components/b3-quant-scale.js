// b3-quant-scale — FP4 에 저장하기 전 나눌 배율을 바꿔 보는 슬라이더.
// 규칙은 보고서 "계산을 직접 재현하기" 의 quant4(scale) 그대로다:
//   각 가중치 w 를 배율로 나눈 값에 가장 가까운 FP4 값 q 를 고른다(같은 거리면 목록 앞쪽 = 작은 값).
//   계산에 쓰는 값 = 배율 × q, 합계 = 배율 × Σ 입력 × q, 판정 = 합계 < 0 이면 3, 아니면 8.
// 부동소수점 잡음을 피하려고 가중치는 0.1 단위 정수, 배율은 0.01 단위 정수로 바꿔 정수로만 비교·계산한다.
(function () {
  var TAG = 'b3-quant-scale';
  if (customElements.get(TAG)) return;

  var CSS = [
    TAG + ' .qs-scale{font-family:var(--mono);font-size:18px;font-weight:700;color:var(--green);min-width:3.2em;text-align:right}',
    TAG + ' .qs-range{font-size:13px;color:var(--mut);margin:2px 0 10px;line-height:1.55}',
    TAG + ' .qs-range b{font-family:var(--mono);color:var(--ink)}',
    TAG + ' .qs-list{display:grid;gap:8px;margin:0 0 10px}',
    TAG + ' .qs-w{border:1px solid var(--line);border-radius:10px;padding:8px 10px;background:var(--card-2)}',
    TAG + ' .qs-chain{font-family:var(--mono);font-size:14px;line-height:1.6;color:var(--ink);overflow-wrap:anywhere;font-variant-numeric:tabular-nums}',
    TAG + ' .qs-chain .qs-arrow{color:var(--subtle)}',
    TAG + ' .qs-meta{font-size:13px;color:var(--mut);margin-top:2px}',
    TAG + ' .qs-sum{font-family:var(--mono);font-size:14px;line-height:1.6;color:var(--ink);overflow-wrap:anywhere;margin:4px 0}',
    TAG + ' .qs-verdict{font-size:15px;margin:2px 0 6px}',
    TAG + ' .qs-tag{font-size:13px;color:var(--subtle);margin:0 0 6px}',
    TAG + ' .ix-btn{min-height:36px}'
  ].join('\n');

  function addStyle() {
    if (document.head.querySelector('style[data-b3="quant-scale"]')) return;
    var st = document.createElement('style');
    st.setAttribute('data-b3', 'quant-scale');
    st.textContent = CSS;
    document.head.appendChild(st);
  }
  function fmt(v) { var r = Math.round(v * 1e6) / 1e6; if (r === 0) return '0'; return (r < 0 ? '−' : '') + String(Math.abs(r)); }
  function fmtSigned(v) { var r = Math.round(v * 1e6) / 1e6; return r > 0 ? '+' + fmt(r) : fmt(r); }

  // k = 배율 × 100 (정수). 돌려주는 값은 전부 정수 계산에서 나온다.
  function compute(data, k) {
    var w10 = data.w.map(function (v) { return Math.round(v * 10); });
    var q2s = [];                                   // FP4 값의 2배(정수), 오름차순
    data.fp4.forEach(function (v) { q2s.push(Math.round(v * 2)); if (v !== 0) q2s.push(-Math.round(v * 2)); });
    q2s.sort(function (a, b) { return a - b; });
    var rows = w10.map(function (a, i) {
      // |q − w/s| 를 비교 = |q2·k − 20·a| 를 비교 (양변에 2k > 0 을 곱함)
      var best = q2s[0], bd = Math.abs(q2s[0] * k - 20 * a);
      for (var j = 1; j < q2s.length; j++) { var d = Math.abs(q2s[j] * k - 20 * a); if (d < bd) { bd = d; best = q2s[j]; } }
      var divExact = (10000 * a) % k === 0;           // w/s 가 소수 셋째 자리 안에서 끝나는가
      return {
        w: a / 10, div: 10 * a / k, divExact: divExact, q: best / 2,
        eff: k * best / 200, err: (k * best - 20 * a) / 200,
        vanished: best === 0 && a !== 0, clipped: Math.abs(10 * a) > 6 * k, x: data.x[i], q2: best
      };
    });
    var num = rows.reduce(function (s, r) { return s + r.x * k * r.q2; }, 0);   // 합계 × 200
    return { rows: rows, sum: num / 200, decision: num < 0 ? 3 : 8, k: k };
  }

  function el(tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }

  // 입력 검사 — 숫자 배열·배율만 받는다. 어긋나면 정적 내용을 그대로 둔다(값이 innerHTML 로 들어가기 때문).
  function nums(a, lo, hi, minLen, maxLen) {
    return Array.isArray(a) && a.length >= minLen && a.length <= maxLen &&
      a.every(function (v) { return typeof v === 'number' && isFinite(v) && v >= lo && v <= hi; });
  }
  function pos(v, hi) { return typeof v === 'number' && isFinite(v) && v > 0 && v <= hi; }
  customElements.define(TAG, class extends HTMLElement {
    connectedCallback() {
      if (this._ready) return;
      var json = this.querySelector('script.ix-data');
      if (!json) return;
      var data;
      try { data = JSON.parse(json.textContent); } catch (e) { return; }
      if (!data || !(nums(data.x, -1e6, 1e6, 1, 8) && nums(data.w, -1e6, 1e6, 1, 8) && data.x.length === data.w.length && nums(data.fp4, 0, 1e6, 2, 16) && pos(data.reportScale, 100) && (data.start == null || pos(data.start, 100)) && pos(data.min, 100) && pos(data.max, 100) && pos(data.step, 100) && data.min < data.max)) return;
      this._ready = true;
      addStyle();
      var self = this;
      var reportK = Math.round(data.reportScale * 100);
      var startK = Math.round((data.start || data.reportScale) * 100);
      var origSum = data.x.reduce(function (s, v, i) { return s + v * data.w[i]; }, 0);
      var origDecision = origSum < 0 ? 3 : 8;
      var maxQ = Math.max.apply(null, data.fp4), minQ = Math.min.apply(null, data.fp4.filter(function (v) { return v > 0; }));

      var title = this.querySelector('.ix-title');
      var caption = this.querySelector('.ix-caption');
      var note = this.querySelector('.ix-note');
      [].slice.call(this.children).forEach(function (c) { if (c !== title && c !== caption && c !== note && c !== json) c.remove(); });

      var row = el('div', 'ix-row');
      var lab = el('label', 'ix-label', '배율');
      var range = document.createElement('input');
      range.type = 'range'; range.min = String(data.min * 100); range.max = String(data.max * 100); range.step = String(data.step * 100);
      range.value = String(startK);
      range.setAttribute('aria-label', '배율');
      var out = el('output', 'qs-scale');
      row.appendChild(lab); row.appendChild(range); row.appendChild(out);
      var presets = el('div', 'ix-seg');
      presets.setAttribute('role', 'group');
      presets.setAttribute('aria-label', '본문에 나온 배율');
      var pBtns = [[reportK, fmt(data.reportScale) + ' (본문 3장)'], [100, '1 = 배율 없음 (본문 2장)']].map(function (p) {
        var b = el('button', 'ix-btn', p[1]); b.type = 'button'; b.dataset.k = String(p[0]);
        b.addEventListener('click', function () { range.value = String(p[0]); render(); });
        presets.appendChild(b); return b;
      });
      var tag = el('p', 'qs-tag');
      var rangeInfo = el('p', 'qs-range');
      var live = el('div'); live.setAttribute('aria-live', 'polite');
      var list = el('div', 'qs-list');
      var sum = el('p', 'qs-sum');
      var verdict = el('p', 'qs-verdict');
      live.appendChild(list); live.appendChild(sum); live.appendChild(verdict);
      var anchor = caption || note || json;
      [row, presets, tag, rangeInfo, live].forEach(function (n) { self.insertBefore(n, anchor); });
      range.addEventListener('input', render);

      function render() {
        var k = Number(range.value), s = k / 100;
        var r = compute(data, k);
        out.textContent = s.toFixed(2);
        pBtns.forEach(function (b) { b.setAttribute('aria-pressed', Number(b.dataset.k) === k ? 'true' : 'false'); });
        tag.textContent = k === reportK ? '본문 3장의 계산과 같은 배율입니다.' : k === 100 ? '배율 1은 나누지 않은 것과 같습니다 — 본문 2장의 FP4 계산입니다.' : '본문에 없는 배율입니다. 같은 규칙으로 계산한 설명용 값입니다.';
        rangeInfo.innerHTML = '이 배율로 나타낼 수 있는 크기: 0이 아닌 가장 작은 값 <b>' + fmt(minQ * s) + '</b> (0.5×배율) · 가장 큰 값 <b>' + fmt(maxQ * s) + '</b> (6×배율)';
        list.innerHTML = r.rows.map(function (w, i) {
          var meta = [];
          if (w.vanished) meta.push('<span class="ix-bad">0이 됨 — 이 가중치가 계산에서 빠짐</span>');
          if (w.clipped) meta.push('<span class="ix-warn">±6을 넘어 가장 큰 값 6에 걸림</span>');
          var errR = Math.round(w.err * 1e6) / 1e6;
          meta.push('오차 ' + (errR === 0 ? '<span class="ix-strong">0</span>' : (Math.abs(errR) >= 0.3 ? '<span class="ix-bad">' : '<span class="ix-warn">') + fmtSigned(errR) + '</span>'));
          var div = w.divExact ? fmt(w.div) : '약 ' + fmt(Math.round(w.div * 1000) / 1000);
          return '<div class="qs-w"><div class="qs-chain">' + fmt(w.w) + ' <span class="qs-arrow">÷' + fmt(s) + ' →</span> ' + div +
            ' <span class="qs-arrow">→ FP4</span> ' + fmt(w.q) + ' <span class="qs-arrow">×' + fmt(s) + ' →</span> <b>' + fmt(w.eff) + '</b></div>' +
            '<div class="qs-meta">' + meta.join(' · ') + '</div></div>';
        }).join('');
        var terms = r.rows.map(function (w, i) { return (i === 0 ? (w.q < 0 ? '−' : '') : (w.q < 0 ? ' − ' : ' + ')) + w.x + '×' + fmt(Math.abs(w.q)); }).join('');
        sum.textContent = '합계: ' + (k === 100 ? terms : fmt(s) + ' × (' + terms + ')') + ' = ' + fmt(r.sum);
        var same = r.decision === origDecision;
        verdict.innerHTML = '판정 <span class="' + (same ? 'ix-strong' : 'ix-bad') + '">' + r.decision + '</span> — 원래 합계 ' + fmt(origSum) + '(판정 ' + origDecision + ')' +
          (same ? '과 판정이 같습니다.' : '<span class="ix-bad">에서 판정이 바뀌었습니다.</span>') + (r.sum === 0 ? ' 합계가 0이면 0보다 작지 않으므로 8입니다.' : '');
        self.dataset.k = String(k);
      }
      render();
    }
  });
})();
