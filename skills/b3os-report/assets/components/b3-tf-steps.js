/* b3-tf-steps — 짧은 문장 하나가 transformer 단계를 지나는 모습을 한 단계씩 넘겨 본다.
   사용: <b3-tf-steps class="ix"> 제목 · 정적 목록(.ix-static) · 캡션 · 안내 </b3-tf-steps>
   단계 이름은 보고서 1절 흐름(텍스트 → 토큰화 → 임베딩(+위치) → [① Attention → ② FFN] × N → LM head → 출력)을 그대로 쓴다.
   토큰을 자른 모양·벡터 막대·attention 굵기·다음 토큰 확률은 설명용 예시 값이다(캡션에 적는다). */
(function () {
  if (customElements.get('b3-tf-steps')) return;

  var CSS = [
    'b3-tf-steps .tf-stages{display:flex;flex-wrap:wrap;gap:6px;margin:4px 0 10px}',
    'b3-tf-steps .tf-stages .ix-btn{padding:6px 10px;font-size:13px;min-height:36px}',
    'b3-tf-steps .tf-panel{display:grid;border:1px solid var(--line);border-radius:12px;background:var(--card-2);padding:12px}',
    'b3-tf-steps .tf-step{grid-area:1/1;min-width:0}',
    'b3-tf-steps .tf-step[hidden]{display:block;visibility:hidden}',
    'b3-tf-steps .tf-ui{position:relative}',
    'b3-tf-steps .tf-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}',
    'b3-tf-steps .tf-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 10px;margin:0 0 8px}',
    'b3-tf-steps .tf-name{font-weight:700;font-size:15px;color:var(--ink)}',
    'b3-tf-steps .tf-shape{font-family:var(--mono);font-size:13px;color:var(--green)}',
    'b3-tf-steps .tf-loop{display:inline-block;margin:0 0 8px;padding:3px 8px;border:1px dashed var(--green);border-radius:8px;font-size:13px;color:var(--green)}',
    'b3-tf-steps .tf-chips{display:flex;flex-wrap:wrap;gap:8px;margin:4px 0 8px}',
    'b3-tf-steps .tf-chip{display:flex;flex-direction:column;align-items:center;gap:4px;min-width:58px;padding:6px 8px;border:1px solid var(--line-strong);border-radius:10px;background:var(--card);font-size:14px;color:var(--ink)}',
    'b3-tf-steps .tf-chip.is-q{border-color:var(--orange);box-shadow:0 0 0 2px color-mix(in srgb,var(--orange) 30%,transparent)}',
    'b3-tf-steps .tf-chip.is-new{border-color:var(--green);color:var(--green);font-weight:700}',
    'b3-tf-steps .tf-text{font-size:15px;padding:8px 12px}',
    'b3-tf-steps .tf-pos{font-family:var(--mono);font-size:13px;color:var(--mut)}',
    'b3-tf-steps .tf-vec{display:flex;align-items:flex-end;gap:2px;height:24px}',
    'b3-tf-steps .tf-vec i{display:block;width:5px;border-radius:2px;background:var(--green);transition:height .25s}',
    'b3-tf-steps .tf-vec.v2 i{background:var(--blue)}',
    'b3-tf-steps .tf-vec.v3 i{background:var(--orange)}',
    'b3-tf-steps .tf-bars{display:grid;grid-template-columns:auto 1fr auto;gap:6px 8px;align-items:center;margin:4px 0 8px;font-size:14px}',
    'b3-tf-steps .tf-bar{height:12px;border-radius:6px;background:var(--line);overflow:hidden}',
    'b3-tf-steps .tf-bar b{display:block;height:100%;border-radius:6px;background:var(--orange);transition:width .25s}',
    'b3-tf-steps .tf-bar.g b{background:var(--green)}',
    'b3-tf-steps .tf-pct{font-family:var(--mono);font-size:13px;color:var(--ink);font-variant-numeric:tabular-nums;text-align:right;min-width:3.2em}',
    'b3-tf-steps .tf-desc{margin:6px 0 0;font-size:14px;line-height:1.6;color:var(--ink)}',
    'b3-tf-steps .tf-nav{display:flex;align-items:center;gap:8px;margin:10px 0 0}',
    'b3-tf-steps .ix-btn:disabled{opacity:.45;cursor:default}',
    'b3-tf-steps .tf-count{font-family:var(--mono);font-size:13px;color:var(--mut);margin-left:auto}'
  ].join('\n');

  function injectCss() {
    if (document.head.querySelector('style[data-b3="tf-steps"]')) return;
    var s = document.createElement('style');
    s.setAttribute('data-b3', 'tf-steps');
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  // 설명용 예시 문장·토큰. 실제로 자르는 모양은 토크나이저마다 다르다.
  var SENT = '고양이가 의자 위에';
  var TOKENS = ['고양이', '가', '의자', '위에'];
  // 설명용 예시 값: 마지막 토큰 '위에'가 각 토큰을 얼마나 보는지(softmax 결과라 합이 100%).
  var ATTN = [15, 5, 55, 25];
  // 설명용 예시 값: LM head 가 낸 다음 토큰 후보 확률(합 100%).
  var NEXT = [['앉았다', 62], ['있다', 21], ['누웠다', 9], ['그 밖의 토큰', 8]];
  var PICK = '앉았다';

  // 벡터 막대 높이(모양만 보여 주는 설명용, 숫자는 화면에 내지 않는다).
  function vec(t, layer) {
    var out = [];
    for (var k = 0; k < 6; k++) {
      var v = Math.abs(Math.sin((t + 1) * 1.7 + k * 2.3 + layer * 0.9));
      out.push(4 + Math.round(v * 18));
    }
    return out;
  }
  function vecHtml(t, layer) {
    return '<span class="tf-vec v' + (layer + 1) + '" aria-hidden="true">' +
      vec(t, layer).map(function (h) { return '<i style="height:' + h + 'px"></i>'; }).join('') + '</span>';
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  var LOOP = '<span class="tf-loop">Transformer 층 × N — ① Attention → ② FFN 묶음을 층마다 반복</span>';

  var STEPS = [
    {
      name: '입력', shape: '텍스트 1줄',
      body: function () { return '<div class="tf-chips"><span class="tf-chip tf-text">' + esc(SENT) + '</span></div>'; },
      desc: '모델이 받는 것은 아직 글자 줄 하나다. 이 문장 다음에 올 말을 예측하는 것이 목표다.'
    },
    {
      name: '토큰화', shape: '토큰 ' + TOKENS.length + '개',
      body: function () {
        return '<div class="tf-chips">' + TOKENS.map(function (t) { return '<span class="tf-chip">' + esc(t) + '</span>'; }).join('') + '</div>';
      },
      desc: '글을 토큰 단위로 자른다. 자르는 방식은 토크나이저마다 다르다.'
    },
    {
      name: '임베딩(+위치)', shape: '토큰 ' + TOKENS.length + '개 → 벡터 ' + TOKENS.length + '개',
      body: function () {
        return '<div class="tf-chips">' + TOKENS.map(function (t, i) {
          return '<span class="tf-chip">' + esc(t) + vecHtml(i, 0) + '<span class="tf-pos">위치 ' + (i + 1) + '</span></span>';
        }).join('') + '</div>';
      },
      desc: '토큰마다 숫자 벡터(막대 묶음)로 바꾸고, 몇 번째 토큰인지 위치 정보를 더한다. 여기서부터는 벡터가 층을 지난다.'
    },
    {
      name: '① Attention', shape: '벡터 ' + TOKENS.length + '개 → 벡터 ' + TOKENS.length + '개', loop: true,
      body: function () {
        var last = TOKENS.length - 1;
        var chips = '<div class="tf-chips">' + TOKENS.map(function (t, i) {
          return '<span class="tf-chip' + (i === last ? ' is-q' : '') + '">' + esc(t) + vecHtml(i, 1) + '</span>';
        }).join('') + '</div>';
        var bars = '<div class="tf-bars" role="list" aria-label="\'' + esc(TOKENS[last]) + '\'가 각 토큰을 보는 비율">' + TOKENS.map(function (t, i) {
          return '<span role="listitem">' + esc(t) + '</span><span class="tf-bar"><b style="width:' + ATTN[i] + '%"></b></span><span class="tf-pct">' + ATTN[i] + '%</span>';
        }).join('') + '</div>';
        return chips + '<div class="ix-label">\'' + esc(TOKENS[last]) + '\'가 각 토큰을 보는 비율 (설명용 예시 값)</div>' + bars;
      },
      desc: '토큰끼리 서로 참고해 정보를 모은다. 예를 들어 \'위에\'는 \'의자\'를 가장 많이 본다. 그래서 같은 \'위에\'라도 앞에 무엇이 왔는지에 따라 벡터가 달라진다(막대 모양·색이 바뀐 이유). 어떻게 고르는지(Q·K·V)는 2절.'
    },
    {
      name: '② FFN', shape: '벡터 ' + TOKENS.length + '개 → 벡터 ' + TOKENS.length + '개', loop: true,
      body: function () {
        return '<div class="tf-chips">' + TOKENS.map(function (t, i) {
          return '<span class="tf-chip">' + esc(t) + vecHtml(i, 2) + '</span>';
        }).join('') + '</div>';
      },
      desc: 'FFN(MLP)은 토큰마다 혼자 가공한다. 토큰끼리 섞지 않고, 같은 가공을 각 벡터에 따로 적용한다. ①과 ② 묶음이 층 하나이고, 이것을 N개 층에서 반복한다.'
    },
    {
      name: 'LM head', shape: '마지막 벡터 1개 → 다음 토큰 확률',
      body: function () {
        return '<div class="ix-label">\'' + esc(SENT) + '\' 다음 토큰 확률 (설명용 예시 값)</div><div class="tf-bars" role="list" aria-label="다음 토큰 확률">' + NEXT.map(function (c) {
          return '<span role="listitem">' + esc(c[0]) + '</span><span class="tf-bar g"><b style="width:' + c[1] + '%"></b></span><span class="tf-pct">' + c[1] + '%</span>';
        }).join('') + '</div>';
      },
      desc: '마지막 토큰 자리의 벡터를 받아, 사전에 있는 토큰마다 다음에 올 확률을 낸다.'
    },
    {
      name: '출력', shape: '토큰 1개 선택',
      body: function () {
        return '<div class="tf-chips">' + TOKENS.map(function (t) { return '<span class="tf-chip">' + esc(t) + '</span>'; }).join('') +
          '<span class="tf-chip is-new">' + esc(PICK) + '</span></div>';
      },
      desc: '여기서는 확률이 가장 높은 \'' + PICK + '\'를 골랐다. 추론에서 여기까지(프롬프트를 한꺼번에 처리)가 prefill 이고, 이후 decode 는 새 토큰을 입력 끝에 붙여 한 토큰씩 다시 단계를 지난다.'
    }
  ];

  customElements.define('b3-tf-steps', class extends HTMLElement {
    connectedCallback() {
      if (this._ready) return;
      this._ready = true;
      injectCss();
      var self = this;
      var stat = this.querySelector('.ix-static');
      if (stat) stat.remove();
      var cap = this.querySelector('.ix-caption');

      var ui = document.createElement('div');
      ui.className = 'tf-ui';
      var stages = document.createElement('div');
      stages.className = 'tf-stages';
      stages.setAttribute('role', 'group');
      stages.setAttribute('aria-label', '단계 고르기');
      STEPS.forEach(function (s, i) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'ix-btn';
        b.textContent = (i + 1) + '. ' + s.name;
        b.addEventListener('click', function () { self.go(i); });
        stages.appendChild(b);
      });
      var panel = document.createElement('div');
      panel.className = 'tf-panel';
      // 모든 단계를 같은 칸에 겹쳐 두고 지금 단계만 보인다 → 칸 높이 = 가장 긴 단계, 넘겨도 버튼 위치가 안 흔들린다.
      STEPS.forEach(function (s, i) {
        var d = document.createElement('div');
        d.className = 'tf-step';
        d.innerHTML = '<div class="tf-head"><span class="tf-name">' + (i + 1) + '. ' + esc(s.name) + '</span><span class="tf-shape">' + esc(s.shape) + '</span></div>' +
          (s.loop ? LOOP : '') + s.body() + '<p class="tf-desc">' + esc(s.desc) + '</p>';
        panel.appendChild(d);
      });
      var live = document.createElement('div');
      live.className = 'tf-sr';
      live.setAttribute('aria-live', 'polite');
      var nav = document.createElement('div');
      nav.className = 'tf-nav';
      nav.innerHTML = '<button type="button" class="ix-btn tf-prev">◀ 이전</button><button type="button" class="ix-btn tf-next">다음 ▶</button><span class="tf-count"></span>';
      ui.appendChild(stages); ui.appendChild(panel); ui.appendChild(nav); ui.appendChild(live);
      this._live = live;
      if (cap) this.insertBefore(ui, cap); else this.appendChild(ui);

      this._btns = Array.prototype.slice.call(stages.children);
      this._panel = panel;
      this._prev = nav.querySelector('.tf-prev');
      this._next = nav.querySelector('.tf-next');
      this._count = nav.querySelector('.tf-count');
      this._prev.addEventListener('click', function () { self.go(self._i - 1); });
      this._next.addEventListener('click', function () { self.go(self._i + 1); });
      this.go(0);
    }
    go(i) {
      if (i < 0 || i >= STEPS.length) return;
      this._i = i;
      var s = STEPS[i];
      this._btns.forEach(function (b, k) { b.setAttribute('aria-pressed', k === i ? 'true' : 'false'); });
      Array.prototype.forEach.call(this._panel.children, function (d, k) {
        if (k === i) { d.removeAttribute('hidden'); d.removeAttribute('aria-hidden'); }
        else { d.setAttribute('hidden', ''); d.setAttribute('aria-hidden', 'true'); }
      });
      this._live.textContent = (i + 1) + '단계 ' + s.name + ': ' + s.shape + '. ' + s.desc;
      this._prev.disabled = i === 0;
      this._next.disabled = i === STEPS.length - 1;
      this._count.textContent = (i + 1) + ' / ' + STEPS.length;
    }
  });
})();
