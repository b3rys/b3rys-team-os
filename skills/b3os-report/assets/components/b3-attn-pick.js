/* b3-attn-pick — 예문의 자리 하나를 고르면, 그 자리가 앞 자리(자기 포함)를 얼마나 섞어 오는지 보여 준다.
   사용: <b3-attn-pick class="ix"> 제목 · <script type="application/json" class="ix-data">…</script>
           · 정적 기본 상태(.ix-static) · 캡션 · 안내 </b3-attn-pick>
   데이터(JSON, 보고서 본문에 적힌 설명용 예시 값을 그대로 옮긴다):
     dims  : 벡터 칸 이름 (예: ["음식 쪽","사람 쪽"])
     units : [{label, x?}] 문장 순서. x(입력 벡터)가 있는 자리만 비율을 계산한다. x 가 있는 자리는 앞쪽에 연속으로 둔다.
     wq·wk·wv : dims×dims 행렬 (줄 단위)
     start : 처음 고른 자리 번호(0부터) · step : 처음 단계 0=점수 1=비율 2=섞은 값
   공식(보고서 3절과 같다):
     Q = W_Q·x, K = W_K·x, V = W_V·x
     점수_j = Q_i·K_j (j ≤ i 만 — 뒤 자리는 causal mask 로 가린다)
     비율 = softmax(점수 ÷ √칸 수)
     섞어 온 값 = Σ 비율_j × V_j,  더한 뒤 = x_i + 섞어 온 값
   x 가 없는 자리를 고르면 '볼 수 있는 자리'만 표시하고 숫자는 내지 않는다.
   데이터는 textContent 로만 화면에 넣는다. 검증에 실패하면 정적 기본 상태를 그대로 둔다. */
(function () {
  if (customElements.get('b3-attn-pick')) return;

  var CSS = [
    'b3-attn-pick .ap-ui{min-width:0}',
    'b3-attn-pick .ap-chips{display:flex;flex-wrap:wrap;gap:6px;margin:2px 0 10px}',
    'b3-attn-pick .ap-chips .ix-btn{min-width:44px;padding:6px 12px}',
    'b3-attn-pick .ap-steps{margin:0 0 10px}',
    'b3-attn-pick .ap-steps .ix-btn{padding:6px 10px;font-size:13px}',
    'b3-attn-pick .ix-btn:disabled{opacity:.45;cursor:default}',
    'b3-attn-pick .ap-panel{border:1px solid var(--line);border-radius:12px;background:var(--card-2);padding:10px 12px}',
    'b3-attn-pick .ap-formula{margin:0 0 8px;font-size:13px;line-height:1.5;color:var(--mut);overflow-wrap:anywhere}',
    'b3-attn-pick .ap-rows{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:6px 10px;align-items:center;font-size:14px}',
    'b3-attn-pick .ap-name{color:var(--ink);white-space:nowrap}',
    'b3-attn-pick .ap-name small{font-size:13px;color:var(--mut);margin-left:3px}',
    'b3-attn-pick .ap-track{position:relative;height:12px;border-radius:6px;background:var(--line);overflow:hidden}',
    'b3-attn-pick .ap-track b{position:absolute;top:0;bottom:0;left:0;border-radius:6px;background:var(--orange);transition:width .25s,left .25s}',
    'b3-attn-pick .ap-track.is-top b{background:var(--green)}',
    'b3-attn-pick .ap-track.is-div::after{content:"";position:absolute;left:50%;top:-2px;bottom:-2px;width:1px;background:var(--mut)}',
    'b3-attn-pick .ap-track.is-div b{border-radius:0}',
    'b3-attn-pick .ap-track.is-see{background:transparent;border:1px dashed var(--green)}',
    'b3-attn-pick .ap-track.is-mask{background:transparent;border:1px dashed var(--line-strong)}',
    'b3-attn-pick .ap-val{font-family:var(--mono);font-size:13px;color:var(--ink);font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap}',
    'b3-attn-pick .ap-val.is-top{color:var(--green);font-weight:700}',
    'b3-attn-pick .is-masked{opacity:.45}',
    'b3-attn-pick .ap-sum{margin:10px 0 0;font-family:var(--mono);font-size:13px;line-height:1.6;color:var(--ink);overflow-wrap:anywhere}',
    'b3-attn-pick .ap-read{margin:10px 0 0;font-size:14px;line-height:1.6;color:var(--ink)}'
  ].join('\n');

  function injectCss() {
    if (document.head.querySelector('style[data-b3="attn-pick"]')) return;
    var s = document.createElement('style');
    s.setAttribute('data-b3', 'attn-pick');
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  // ── 데이터 검증 ── 하나라도 어긋나면 null (정적 기본 상태 유지)
  function isStr(v, max) { return typeof v === 'string' && v.trim().length > 0 && v.length <= max; }
  function isNum(v) { return typeof v === 'number' && isFinite(v) && Math.abs(v) <= 1e6; }
  function isVec(v, n) { return Array.isArray(v) && v.length === n && v.every(isNum); }
  function isMat(m, n) { return Array.isArray(m) && m.length === n && m.every(function (r) { return isVec(r, n); }); }
  function validate(d) {
    if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
    var dims = d.dims, units = d.units;
    if (!Array.isArray(dims) || dims.length < 1 || dims.length > 8 || !dims.every(function (s) { return isStr(s, 12); })) return null;
    var D = dims.length;
    if (!Array.isArray(units) || units.length < 2 || units.length > 24) return null;
    var nVal = 0, gap = false;
    for (var i = 0; i < units.length; i++) {
      var u = units[i];
      if (!u || typeof u !== 'object' || !isStr(u.label, 12)) return null;
      if (u.x !== undefined) {
        if (gap || !isVec(u.x, D)) return null;  // x 가 있는 자리는 앞쪽에 연속으로
        nVal++;
      } else gap = true;
    }
    if (nVal < 1) return null;
    if (!isMat(d.wq, D) || !isMat(d.wk, D) || !isMat(d.wv, D)) return null;
    var start = d.start === undefined ? 0 : d.start, step = d.step === undefined ? 1 : d.step;
    if (!Number.isInteger(start) || start < 0 || start >= units.length) return null;
    if (!Number.isInteger(step) || step < 0 || step > 2) return null;
    return { dims: dims.slice(), labels: units.map(function (u) { return u.label; }),
      X: units.slice(0, nVal).map(function (u) { return u.x.slice(); }),
      wq: d.wq, wk: d.wk, wv: d.wv, start: start, step: step };
  }

  // ── 계산 ──
  function mv(M, x) { return M.map(function (row) { return row.reduce(function (s, m, k) { return s + m * x[k]; }, 0); }); }
  function dot(a, b) { return a.reduce(function (s, v, k) { return s + v * b[k]; }, 0); }
  function compute(m, i) {
    var x = m.X[i], Q = mv(m.wq, x), sc = Math.sqrt(m.dims.length);
    var K = [], V = [], S = [], E = [], j;
    for (j = 0; j <= i; j++) { K.push(mv(m.wk, m.X[j])); V.push(mv(m.wv, m.X[j])); }
    for (j = 0; j <= i; j++) S.push(dot(Q, K[j]));
    var mx = Math.max.apply(null, S.map(function (s) { return s / sc; }));
    for (j = 0; j <= i; j++) E.push(Math.exp(S[j] / sc - mx));
    var sum = E.reduce(function (a, b) { return a + b; }, 0);
    var W = E.map(function (e) { return e / sum; });
    var C = W.map(function (w, k) { return V[k].map(function (v) { return w * v; }); });
    var mix = x.map(function (_, c) { return C.reduce(function (s, r) { return s + r[c]; }, 0); });
    var res = x.map(function (v, c) { return v + mix[c]; });
    return { Q: Q, K: K, V: V, S: S, W: W, C: C, mix: mix, res: res, x: x };
  }

  // ── 표기 ── 보고서 본문과 같은 모양: 소수 셋째 자리, 음수는 '−'
  function n3(v) {
    var s = (Math.round(v * 1000) / 1000).toFixed(3).replace(/\.?0+$/, '');
    if (s === '-0') s = '0';
    return s.replace('-', '−');
  }
  function w3(v) { return Math.abs(v - 1) < 5e-10 ? '1' : v.toFixed(3); }
  function vec(a) { return '[' + a.map(n3).join(', ') + ']'; }
  function q(s) { return "'" + s + "'"; }
  function topic(word) {  // 'X'은 / 'X'는 — 받침은 따옴표가 아니라 낱말 끝 글자로 판단한다
    var c = word.charCodeAt(word.length - 1);
    var has = c >= 0xAC00 && c <= 0xD7A3 && (c - 0xAC00) % 28 !== 0;
    return q(word) + (has ? '은' : '는');
  }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  var STEP_NAMES = ['① 점수 (Q·K)', '② 비율 (softmax)', '③ 섞은 값 (비율×V)'];

  customElements.define('b3-attn-pick', class extends HTMLElement {
    connectedCallback() {
      if (this._ready) return;
      var src = this.querySelector('script.ix-data');
      var m = null;
      try { m = validate(JSON.parse(src ? src.textContent : '')); } catch (e) { m = null; }
      if (!m) { this.setAttribute('data-ix-error', 'data'); return; }  // 정적 기본 상태 유지
      this._ready = true;
      this.m = m;
      injectCss();
      var self = this;
      var stat = this.querySelector('.ix-static');
      if (stat) stat.remove();
      var cap = this.querySelector('.ix-caption');

      var ui = el('div', 'ap-ui');
      ui.appendChild(el('div', 'ix-label', '자리를 누르면 그 자리가 섞어 오는 앞 자리가 보인다'));
      var chips = el('div', 'ap-chips');
      chips.setAttribute('role', 'group');
      chips.setAttribute('aria-label', '고를 자리');
      this.chipBtns = m.labels.map(function (lab, i) {
        var b = el('button', 'ix-btn', lab);
        b.type = 'button';
        b.addEventListener('click', function () { self.pick(i); });
        chips.appendChild(b);
        return b;
      });
      var steps = el('div', 'ix-seg ap-steps');
      steps.setAttribute('role', 'group');
      steps.setAttribute('aria-label', '계산 단계');
      this.stepBtns = STEP_NAMES.map(function (name, k) {
        var b = el('button', 'ix-btn', name);
        b.type = 'button';
        b.addEventListener('click', function () { self.setStep(k); });
        steps.appendChild(b);
        return b;
      });
      var panel = el('div', 'ap-panel');
      this.formula = el('p', 'ap-formula');
      this.rows = el('div', 'ap-rows');
      this.rows.setAttribute('role', 'list');
      this.sum = el('p', 'ap-sum');
      panel.appendChild(this.formula); panel.appendChild(this.rows); panel.appendChild(this.sum);
      this.read = el('p', 'ap-read');
      this.read.setAttribute('aria-live', 'polite');
      ui.appendChild(chips); ui.appendChild(steps); ui.appendChild(panel); ui.appendChild(this.read);
      if (cap) this.insertBefore(ui, cap); else this.appendChild(ui);

      this.i = m.start;
      this.step = m.step;
      this.render();
    }
    pick(i) { this.i = i; this.render(); }
    setStep(k) { this.step = k; this.render(); }
    render() {
      var m = this.m, i = this.i, step = this.step, L = m.labels, n = L.length;
      var has = i < m.X.length;
      var r = has ? compute(m, i) : null;
      this.chipBtns.forEach(function (b, k) { b.setAttribute('aria-pressed', k === i ? 'true' : 'false'); });
      this.stepBtns.forEach(function (b, k) {
        b.disabled = !has;
        b.setAttribute('aria-pressed', has && k === step ? 'true' : 'false');
      });

      var top = 0, low = 0, j;
      if (has) for (j = 0; j <= i; j++) { if (r.W[j] > r.W[top]) top = j; if (r.W[j] < r.W[low]) low = j; }
      var maxAbs = has ? Math.max.apply(null, r.S.map(Math.abs)) || 1 : 1;

      // 단계 설명 한 줄
      if (!has) this.formula.textContent = q(L[i]) + ' 자리의 예시 값은 보고서에서 정하지 않았다. 볼 수 있는 자리만 표시한다.';
      else if (step === 0) this.formula.textContent = '점수 = Q(' + L[i] + ')·K · Q(' + L[i] + ') = W_Q·x = ' + vec(r.Q);
      else if (step === 1) this.formula.textContent = '비율 = 점수를 √' + m.dims.length + ' 로 나눈 뒤 softmax · 합 1';
      else this.formula.textContent = '섞어 온 값 = Σ 비율 × V · V = W_V·x · 칸 = [' + m.dims.join(', ') + ']';

      // 자리별 줄
      this.rows.textContent = '';
      for (j = 0; j < n; j++) {
        var masked = j > i;
        var name = el('span', 'ap-name' + (masked ? ' is-masked' : ''), L[j]);
        name.setAttribute('role', 'listitem');
        if (j === i) name.appendChild(el('small', '', '(자기)'));
        var track = el('span', 'ap-track');
        var val = el('span', 'ap-val');
        var bar = el('b');
        if (masked) {
          track.className += ' is-mask is-masked';
          val.className += ' is-masked';
          val.textContent = '가려짐';
          name.setAttribute('aria-label', L[j] + ': 뒤 자리라 가려짐');
        } else if (!has) {
          track.className += ' is-see';
          val.textContent = '보임';
          name.setAttribute('aria-label', L[j] + ': 볼 수 있음');
        } else if (step === 0) {
          var s = r.S[j], half = 50 * Math.abs(s) / maxAbs;
          track.className += ' is-div' + (j === top ? ' is-top' : '');
          bar.style.left = (s >= 0 ? 50 : 50 - half) + '%';
          bar.style.width = half + '%';
          track.appendChild(bar);
          val.textContent = n3(s);
          name.setAttribute('aria-label', L[j] + ': 점수 ' + n3(s));
        } else {
          var w = r.W[j];
          if (j === top) { track.className += ' is-top'; val.className += ' is-top'; }
          bar.style.width = (100 * w) + '%';
          track.appendChild(bar);
          val.textContent = step === 1 ? w3(w) : vec(r.C[j]);
          name.setAttribute('aria-label', L[j] + (step === 1 ? ': 비율 ' + w3(w) : ': 비율 ' + w3(w) + ' × V ' + vec(r.V[j]) + ' = ' + vec(r.C[j])));
        }
        track.setAttribute('aria-hidden', 'true');
        this.rows.appendChild(name); this.rows.appendChild(track); this.rows.appendChild(val);
      }

      // 합계 줄 (③ 단계)
      this.sum.hidden = !(has && step === 2);
      this.sum.textContent = has && step === 2
        ? '섞어 온 값 ' + vec(r.mix) + ' · x ' + vec(r.x) + ' 에 더하면 ' + vec(r.res)
        : '';

      // 해석 한 문장
      var later = n - 1 - i, laterTxt = later > 0 ? ' 뒤의 ' + later + '자리(' + L.slice(i + 1).join('·') + ')는 causal mask 로 가려져 계산에 들어가지 않는다.' : ' 마지막 자리라 가려지는 자리가 없다.';
      var t;
      if (!has) {
        t = topic(L[i]) + ' 앞의 ' + i + '자리와 자기를 볼 수 있다.' + laterTxt + ' 이 자리의 비율은 예시 값을 정하지 않아 표시하지 않는다.';
      } else if (i === 0) {
        t = topic(L[i]) + ' 첫 자리라 볼 수 있는 자리가 자기뿐이어서 비율 1 이 모두 자기에게 간다.' + laterTxt;
      } else if (step === 0) {
        t = '점수가 가장 높은 자리는 ' + q(L[top]) + '(' + n3(r.S[top]) + '), 가장 낮은 자리는 ' + q(L[low]) + '(' + n3(r.S[low]) + ')이다. 점수가 높을수록 다음 단계의 비율이 커진다.';
      } else if (step === 1) {
        t = topic(L[i]) + ' 볼 수 있는 ' + (i + 1) + '자리 중 ' + q(L[top]) + (top === i ? '(자기)' : '') + '에 가장 많이(' + w3(r.W[top]) + '), ' + q(L[low]) + '에 가장 적게(' + w3(r.W[low]) + ') 기댄다.' + laterTxt;
      } else {
        // 비율이 가장 큰 자리를 말한다(벡터 크기로 '가장 큰 몫'을 고르지 않는다). 공동 최댓값이면 '중 하나'.
        var tie = r.W.slice(0, i + 1).filter(function (w) { return w === r.W[top]; }).length > 1;
        t = '섞어 온 값 ' + vec(r.mix) + ' 에서 비율이 가장 큰 자리' + (tie ? ' 중 하나' : '') + '인 ' + q(L[top]) + '의 기여는 V ' + vec(r.V[top]) + ' × ' + w3(r.W[top]) + ' = ' + vec(r.C[top]) + ' 이다.';
      }
      this.read.textContent = t;
    }
  });
})();
