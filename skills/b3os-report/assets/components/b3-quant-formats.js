// b3-quant-formats — 같은 입력·같은 판정 규칙에서 가중치 저장 방식만 바꿔 보는 전환기.
// 계산 규칙은 보고서 "계산을 직접 재현하기" 의 파이썬 코드와 같다:
//   FP4 = 목록에서 가장 가까운 값(같은 거리면 목록 앞쪽 = 작은 값), 배율이 있으면 w/배율 을 바꾼 뒤 배율을 곱한다.
//   세 값 = 배율 s = 절댓값 평균, round(w/s)(파이썬 round = 짝수 쪽 반올림) 을 −1~+1 로 제한.
//   두 값 = w >= 0 이면 +1, 아니면 −1, 배율 s.
//   판정 = 합계 < 0 이면 3, 아니면 8.
// 입력 값은 태그 안 <script type="application/json" class="ix-data"> 에서 읽는다.
(function () {
  var TAG = 'b3-quant-formats';
  if (customElements.get(TAG)) return;

  var CSS = [
    TAG + ' .qf-mode{margin:4px 0 10px;font-size:14px;line-height:1.6;color:var(--ink)}',
    TAG + ' .qf-allowed{font-size:13px;color:var(--mut);margin:0 0 10px;line-height:1.55}',
    TAG + ' .qf-allowed b{font-family:var(--mono);font-weight:600;color:var(--ink)}',
    TAG + ' .qf-table{display:table;width:100%;margin:0 0 10px;border-collapse:separate;border-spacing:0;border:1px solid var(--line);border-radius:10px;overflow:hidden;box-shadow:none;font-size:13px;table-layout:fixed}',
    TAG + ' .qf-table th,' + TAG + ' .qf-table td{min-width:0;padding:7px 6px;text-align:right;font-family:var(--mono);font-variant-numeric:tabular-nums;vertical-align:middle;overflow-wrap:anywhere}',
    TAG + ' .qf-table th{font:700 13px/1.35 var(--sans);color:var(--mut)}',
    TAG + ' .qf-table th:first-child,' + TAG + ' .qf-table td:first-child{text-align:left;font-weight:600;color:var(--mut)}',
    TAG + ' .qf-table tr:hover td{background:transparent}',
    TAG + ' .qf-sum{margin:6px 0 4px;font-family:var(--mono);font-size:14px;line-height:1.6;color:var(--ink);overflow-wrap:anywhere}',
    TAG + ' .qf-verdict{font-size:15px;margin:2px 0 12px}',
    TAG + ' .qf-bars{display:grid;gap:6px;margin:6px 0 4px}',
    TAG + ' .qf-axis,' + TAG + ' .qf-bar{display:grid;grid-template-columns:minmax(0,7.6em) minmax(0,1fr) 4.6em;gap:8px;align-items:center}',
    TAG + ' .qf-axis span{font-size:13px;color:var(--subtle)}',
    TAG + ' .qf-axis .qf-zones{display:flex;justify-content:space-between;gap:4px;font-size:13px;color:var(--mut)}',
    TAG + ' .qf-name{font-size:13px;color:var(--mut);line-height:1.3}',
    TAG + ' .qf-track{position:relative;height:20px;border-radius:6px;background:linear-gradient(90deg,color-mix(in srgb,var(--card-2) 86%,var(--green) 14%) 0 var(--z),color-mix(in srgb,var(--card-2) 86%,var(--orange) 14%) var(--z) 100%)}',
    TAG + ' .qf-track::after{content:"";position:absolute;left:var(--z);top:-3px;bottom:-3px;width:2px;margin-left:-1px;background:var(--ink);opacity:.55}',
    TAG + ' .qf-fill{position:absolute;top:4px;bottom:4px;border-radius:3px;background:var(--mut);min-width:3px}',
    TAG + ' .qf-num{font-family:var(--mono);font-size:13px;text-align:right;white-space:nowrap;color:var(--ink);font-variant-numeric:tabular-nums}',
    TAG + ' .qf-bar.is-sel .qf-name{color:var(--ink);font-weight:700}',
    TAG + ' .qf-bar.is-sel .qf-fill{background:var(--green)}',
    TAG + ' .qf-bar.is-flip .qf-fill{background:var(--red)}',
    TAG + ' .qf-bar.is-flip .qf-num{color:var(--red);font-weight:700}',
    TAG + ' .ix-seg .ix-btn{flex:1 1 auto}',
    '@media(max-width:520px){' + TAG + ' .qf-axis,' + TAG + ' .qf-bar{grid-template-columns:minmax(0,5.6em) minmax(0,1fr) 4.4em;gap:6px}' + TAG + ' .qf-table th,' + TAG + ' .qf-table td{padding:6px 4px}}'
  ].join('\n');

  function addStyle() {
    if (document.head.querySelector('style[data-b3="quant-formats"]')) return;
    var st = document.createElement('style');
    st.setAttribute('data-b3', 'quant-formats');
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  // 표시용 숫자: 부동소수점 잡음(−0.10000000000000031)을 지우고 마이너스는 보고서처럼 '−'.
  function fmt(v) {
    var r = Math.round(v * 1e6) / 1e6;
    if (r === 0) return '0';
    var s = String(Math.abs(r));
    return (r < 0 ? '−' : '') + s;
  }
  function fmtSigned(v) { var r = Math.round(v * 1e6) / 1e6; return r > 0 ? '+' + fmt(r) : fmt(r); }
  // 파이썬 round() 와 같은 짝수 쪽 반올림
  function roundHalfEven(v) {
    var f = Math.floor(v), d = v - f;
    if (d > 0.5) return f + 1;
    if (d < 0.5) return f;
    return f % 2 === 0 ? f : f + 1;
  }
  function nearest(list, v) { // list 오름차순, 같은 거리면 앞쪽(파이썬 min 과 같다)
    var best = list[0], bd = Math.abs(list[0] - v);
    for (var i = 1; i < list.length; i++) { var d = Math.abs(list[i] - v); if (d < bd) { bd = d; best = list[i]; } }
    return best;
  }

  // 보고서의 다섯 방법을 계산한다. 돌려주는 것: 저장값 q, 배율 scale, 계산에 쓴 값 eff, 합계 sum.
  function compute(data) {
    var x = data.x, w = data.w;
    var fp4 = [];
    data.fp4.forEach(function (v) { fp4.push(v); if (v !== 0) fp4.push(-v); });
    fp4.sort(function (a, b) { return a - b; });
    var s = w.reduce(function (a, v) { return a + Math.abs(v); }, 0) / w.length;
    var methods = [
      { id: 'orig', btn: '원래 값', name: '원래 소수', scale: null, q: w.slice(),
        mode: '기준이 되는 원래 가중치로 계산합니다. 수학적 기준값이며 FP32 비트 단위 재현은 아닙니다.',
        allowed: '제한 없음 (기준값)' },
      { id: 'fp4', btn: 'FP4', name: 'FP4', scale: 1, q: w.map(function (v) { return nearest(fp4, v); }),
        mode: '목록에서 가장 가까운 FP4 값으로 바꿉니다. 목록에 0.1이 없어 가장 가까운 0이 됩니다.',
        allowed: 'FP4 E2M1 값 <b>0, ±0.5, ±1, ±1.5, ±2, ±3, ±4, ±6</b>' },
      { id: 'fp4s', btn: 'FP4 + 배율 ' + fmt(data.fp4Scale), name: 'FP4 + 배율 ' + fmt(data.fp4Scale), scale: data.fp4Scale,
        q: w.map(function (v) { return nearest(fp4, v / data.fp4Scale); }),
        mode: fmt(data.fp4Scale) + '로 나눈 값을 FP4로 저장하고, 계산할 때 ' + fmt(data.fp4Scale) + '를 다시 곱합니다. 0.1은 남지만 0.9는 0.8이 됩니다.',
        allowed: '같은 FP4 값 × 배율 <b>' + fmt(data.fp4Scale) + '</b>' },
      { id: 'tern', btn: '세 값 −1·0·+1', name: '세 값', scale: s,
        q: w.map(function (v) { return Math.max(-1, Math.min(1, roundHalfEven(v / s))); }),
        mode: '배율 = 절댓값 평균 ' + fmt(s) + '. ' + fmt(s) + '으로 나눠 정수로 반올림한 뒤 −1~+1로 제한합니다. 작은 0.1은 0으로 빠집니다.',
        allowed: '<b>−1, 0, +1</b> × 배율 <b>' + fmt(s) + '</b>' },
      { id: 'bin', btn: '두 값 −1·+1', name: '두 값', scale: s,
        q: w.map(function (v) { return v >= 0 ? 1 : -1; }),
        mode: '양수는 +1, 음수는 −1로 바꾸고 같은 배율 ' + fmt(s) + '을 씁니다. 0이 없어서 0.1도 +1이 되고, 계산에 쓰는 값이 ' + fmt(s) + '으로 커집니다.',
        allowed: '<b>−1, +1</b> × 배율 <b>' + fmt(s) + '</b> (0 없음)' }
    ];
    methods.forEach(function (m) {
      var sc = m.scale === null ? 1 : m.scale;
      m.eff = m.q.map(function (q) { return sc * q; });
      m.prod = m.eff.map(function (e, i) { return x[i] * e; });
      m.err = m.eff.map(function (e, i) { return e - w[i]; });
      var dot = m.q.reduce(function (a, q, i) { return a + x[i] * q; }, 0);
      m.sum = m.scale === null ? m.prod.reduce(function (a, v) { return a + v; }, 0) : sc * dot;
      m.decision = m.sum < 0 ? 3 : 8;
    });
    return methods;
  }

  function formula(m, x) {
    var parts;
    if (m.scale === null) {
      parts = m.prod.map(function (p, i) { var r = Math.round(p * 1e6) / 1e6; return (i === 0 ? (r < 0 ? '−' : '') : (r < 0 ? ' − ' : ' + ')) + fmt(Math.abs(r)); });
      return parts.join('') + ' = ' + fmt(m.sum);
    }
    parts = m.q.map(function (q, i) { return (i === 0 ? (q < 0 ? '−' : '') : (q < 0 ? ' − ' : ' + ')) + x[i] + '×' + fmt(Math.abs(q)); });
    var inner = parts.join('');
    return (m.scale === 1 ? inner : fmt(m.scale) + ' × (' + inner + ')') + ' = ' + fmt(m.sum);
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
      if (!data || !(nums(data.x, -1e6, 1e6, 1, 8) && nums(data.w, -1e6, 1e6, 1, 8) && data.x.length === data.w.length && nums(data.fp4, 0, 1e6, 2, 16) && pos(data.fp4Scale, 100))) return;
      this._ready = true;
      addStyle();
      var self = this, x = data.x, w = data.w;
      var methods = compute(data);
      var ref = methods[0];
      var title = this.querySelector('.ix-title');
      var caption = this.querySelector('.ix-caption');
      var note = this.querySelector('.ix-note');
      [].slice.call(this.children).forEach(function (c) { if (c !== title && c !== caption && c !== note && c !== json) c.remove(); });

      var seg = el('div', 'ix-seg');
      seg.setAttribute('role', 'group');
      seg.setAttribute('aria-label', '가중치 저장 방식');
      var btns = methods.map(function (m) {
        var b = el('button', 'ix-btn', m.btn);
        b.type = 'button';
        b.dataset.method = m.id;
        b.addEventListener('click', function () { show(m.id); });
        seg.appendChild(b);
        return b;
      });
      var mode = el('p', 'qf-mode');
      var allowed = el('p', 'qf-allowed');
      var live = el('div');
      live.setAttribute('aria-live', 'polite');
      var table = el('table', 'qf-table');
      var sum = el('p', 'qf-sum');
      var verdict = el('p', 'qf-verdict');
      live.appendChild(table); live.appendChild(sum); live.appendChild(verdict);

      // 다섯 방법의 합계를 0 기준선 위에 나란히 — 정적 기본 상태와 같은 그림
      var bars = buildBars(methods);

      var anchor = caption || note || json;
      [seg, mode, allowed, live, el('div', 'ix-label', '다섯 방법의 합계 (0보다 작으면 3, 아니면 8)'), bars.root].forEach(function (n) { self.insertBefore(n, anchor); });

      function show(id) {
        var m = methods.filter(function (k) { return k.id === id; })[0];
        btns.forEach(function (b) { b.setAttribute('aria-pressed', b.dataset.method === id ? 'true' : 'false'); });
        mode.textContent = m.mode;
        allowed.innerHTML = '쓸 수 있는 값: ' + m.allowed;
        var ints = m.id === 'tern' || m.id === 'bin';
        var effHead = m.scale === null ? '쓴 값' : '쓴 값<br>(×' + fmt(m.scale) + ')';
        var rows = '<thead><tr><th scope="col">입력</th><th scope="col">원래</th><th scope="col">저장값</th><th scope="col">' + effHead + '</th><th scope="col">오차</th><th scope="col">입력<br>×쓴 값</th></tr></thead><tbody>';
        w.forEach(function (v, i) {
          var q = m.q[i];
          var err = Math.round(m.err[i] * 1e6) / 1e6;
          var errCls = err === 0 ? '' : (Math.abs(err) >= 0.3 ? 'ix-bad' : 'ix-warn');
          var stored = ints ? (q > 0 ? '+1' : q < 0 ? '−1' : '0') : fmt(q);
          rows += '<tr><td>' + x[i] + '</td><td>' + fmt(v) + '</td><td>' + stored + '</td><td>' + fmt(m.eff[i]) +
            '</td><td class="' + errCls + '">' + (err === 0 ? '0' : fmtSigned(err)) + '</td><td>' + fmt(m.prod[i]) + '</td></tr>';
        });
        table.innerHTML = rows + '</tbody>';
        sum.textContent = '합계: ' + formula(m, x);
        var same = m.decision === ref.decision;
        verdict.innerHTML = '판정 <span class="' + (same ? 'ix-strong' : 'ix-bad') + '">' + m.decision + '</span> — ' +
          (m.id === 'orig' ? '기준 판정입니다.' : same ? '원래 판정 ' + ref.decision + '과 같습니다. 원래 합계 ' + fmt(ref.sum) + '과의 차이 ' + fmtSigned(m.sum - ref.sum) + '.' :
            '<span class="ix-bad">원래 판정 ' + ref.decision + '에서 바뀌었습니다.</span> 합계가 ' + fmt(ref.sum) + '에서 ' + fmt(m.sum) + '로 부호까지 바뀌었습니다.');
        bars.rows.forEach(function (r) { r.classList.toggle('is-sel', r.dataset.method === id); });
        self.dataset.selected = id;
      }
      show('orig');
    }
  });

  function buildBars(methods) {
    var lo = -1.2, hi = 2.6, span = hi - lo;
    var z = ((0 - lo) / span * 100).toFixed(2) + '%';
    var root = el('div', 'qf-bars');
    var axis = el('div', 'qf-axis');
    axis.innerHTML = '<span></span><span class="qf-zones" style="--z:' + z + '"><span>← 3</span><span>8 →</span></span><span></span>';
    root.appendChild(axis);
    var rows = methods.map(function (m) {
      var r = el('div', 'qf-bar' + (m.decision !== methods[0].decision ? ' is-flip' : ''));
      r.dataset.method = m.id;
      var left = (Math.min(0, m.sum) - lo) / span * 100, width = Math.abs(m.sum) / span * 100;
      r.innerHTML = '<span class="qf-name">' + m.name + '</span><span class="qf-track" style="--z:' + z + '"><span class="qf-fill" style="left:' + left.toFixed(2) + '%;width:' + width.toFixed(2) + '%"></span></span><span class="qf-num">' + fmt(m.sum) + ' → ' + m.decision + '</span>';
      root.appendChild(r);
      return r;
    });
    return { root: root, rows: rows };
  }
})();
