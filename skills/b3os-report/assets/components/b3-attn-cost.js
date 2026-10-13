/* b3-attn-cost — 프롬프트 길이 n 을 바꾸면 attention(n×n)·토큰별 처리(n)·KV 캐시가 각각 얼마나 커지나.
   사용: <b3-attn-cost class="ix" data-start="3" data-layers="32" data-q-heads="32" data-head-dim="128" data-bytes="2" data-kv-heads="8">
           제목 · 정적 기본 상태(.ix-static) · 캡션 · 안내 </b3-attn-cost>
   공식(캡션에도 적는다):
     attention 토큰 쌍 비교 = n × n   (층·head 하나 기준)
     토큰별 처리(FFN·Q/K/V 투영) = n  (층 하나 기준)
     KV 캐시 바이트 = 2(K·V) × 층 수 × KV head 수 × head 차원 × n × 원소 바이트
   층·head 수·차원·바이트는 설명용 예시 설정이다(data-* 로 바꿀 수 있다). */
(function () {
  if (customElements.get('b3-attn-cost')) return;

  var LENS = [1024, 2048, 4096, 8192, 16384, 32768, 65536, 131072];

  var CSS = [
    'b3-attn-cost .ac-sec{margin:10px 0 0;padding:10px 12px;border:1px solid var(--line);border-radius:12px;background:var(--card-2)}',
    'b3-attn-cost .ac-h{font-size:13px;font-weight:700;color:var(--mut);margin:0 0 6px}',
    'b3-attn-cost .ac-item{margin:8px 0}',
    'b3-attn-cost .ac-top{display:flex;flex-wrap:wrap;justify-content:space-between;gap:2px 10px;font-size:14px;color:var(--ink)}',
    'b3-attn-cost .ac-bar{height:14px;margin-top:4px;border-radius:7px;background:var(--line);overflow:hidden}',
    'b3-attn-cost .ac-bar b{display:block;height:100%;min-width:2px;border-radius:7px;transition:width .25s}',
    'b3-attn-cost .ac-o b{background:var(--orange)}',
    'b3-attn-cost .ac-g b{background:var(--green)}',
    'b3-attn-cost .ac-b b{background:var(--blue)}',
    'b3-attn-cost .ac-sum{margin:8px 0 0;font-size:14px;line-height:1.6;color:var(--ink)}',
    'b3-attn-cost .ac-nval{min-width:9.5em}'
  ].join('\n');

  function injectCss() {
    if (document.head.querySelector('style[data-b3="attn-cost"]')) return;
    var s = document.createElement('style');
    s.setAttribute('data-b3', 'attn-cost');
    s.textContent = CSS;
    document.head.appendChild(s);
  }
  function fmt(x) { return Math.round(x).toLocaleString('en-US'); }
  function kLabel(n) { return (n / 1024) + 'K'; }
  function bytesLabel(b) {
    var gib = b / Math.pow(2, 30);
    if (gib >= 1) return (Number.isInteger(gib) ? gib : gib.toFixed(1)) + ' GiB';
    var mib = b / Math.pow(2, 20);
    if (mib >= 1) return (Number.isInteger(mib) ? mib : mib.toFixed(1)) + ' MiB';
    var kib = b / 1024;
    return (Number.isInteger(kib) ? kib : kib.toFixed(1)) + ' KiB';
  }
  function num(el, k, d) { var v = parseFloat(el.getAttribute('data-' + k)); return isFinite(v) && v > 0 ? v : d; }

  customElements.define('b3-attn-cost', class extends HTMLElement {
    connectedCallback() {
      if (this._ready) return;
      this._ready = true;
      injectCss();
      var self = this;
      this.cfg = {
        layers: num(this, 'layers', 32),
        qHeads: num(this, 'q-heads', 32),
        headDim: num(this, 'head-dim', 128),
        bytes: num(this, 'bytes', 2)
      };
      var start = Math.min(LENS.length - 1, Math.max(0, Math.round(num(this, 'start', 3))));
      if (this.getAttribute('data-start') === '0') start = 0;
      this.kv = num(this, 'kv-heads', 8);
      var gqaHeads = this.cfg.qHeads / 4; // GQA 예: Q head 4개가 K·V head 하나를 공유

      var stat = this.querySelector('.ix-static');
      if (stat) stat.remove();
      var cap = this.querySelector('.ix-caption');

      var ui = document.createElement('div');
      ui.innerHTML =
        '<div class="ix-row"><span class="ix-label">프롬프트 길이 n</span>' +
        '<input type="range" min="0" max="' + (LENS.length - 1) + '" step="1" aria-label="프롬프트 길이 n (토큰 수)">' +
        '<span class="ix-value ac-nval"></span></div>' +
        '<div class="ac-sec" aria-live="polite"><div class="ac-h">prefill — 프롬프트를 한꺼번에 처리 (1K 대비 몇 배)</div>' +
        '<div class="ac-item"><div class="ac-top"><span>Attention 토큰 쌍 비교 (n×n)</span><span class="ix-value ix-warn ac-attn"></span></div><div class="ac-bar ac-o"><b class="ac-attn-bar"></b></div></div>' +
        '<div class="ac-item"><div class="ac-top"><span>FFN 등 토큰별 처리 (n)</span><span class="ix-value ix-strong ac-lin"></span></div><div class="ac-bar ac-g"><b class="ac-lin-bar"></b></div></div>' +
        '<p class="ac-sum"></p></div>' +
        '<div class="ac-sec"><div class="ac-h">decode — 새 토큰마다 이전 모든 K·V 를 읽는다</div>' +
        '<div class="ix-seg" role="group" aria-label="KV head 수">' +
        '<button type="button" class="ix-btn" data-kv="' + this.cfg.qHeads + '">KV head ' + this.cfg.qHeads + ' (공유 없음)</button>' +
        '<button type="button" class="ix-btn" data-kv="' + gqaHeads + '">KV head ' + gqaHeads + ' (GQA 공유)</button></div>' +
        '<div class="ac-item" aria-live="polite"><div class="ac-top"><span>KV 캐시 (요청 1개)</span><span class="ix-value ix-strong ac-kv"></span></div><div class="ac-bar ac-b"><b class="ac-kv-bar"></b></div></div>' +
        '<p class="ac-sum ac-kv-sum"></p></div>';
      if (cap) this.insertBefore(ui, cap); else this.appendChild(ui);

      this.$ = function (s) { return ui.querySelector(s); };
      this.range = this.$('input[type=range]');
      this.range.value = String(start);
      this.range.addEventListener('input', function () { self.update(); });
      this.kvBtns = Array.prototype.slice.call(ui.querySelectorAll('[data-kv]'));
      this.kvBtns.forEach(function (b) {
        b.addEventListener('click', function () { self.kv = parseFloat(b.getAttribute('data-kv')); self.update(); });
      });
      this.update();
    }
    update() {
      var i = parseInt(this.range.value, 10);
      var n = LENS[i], n0 = LENS[0], nMax = LENS[LENS.length - 1];
      var c = this.cfg, kv = this.kv;
      var lin = n / n0, quad = (n * n) / (n0 * n0);
      this.range.setAttribute('aria-valuetext', fmt(n) + ' 토큰');
      this.$('.ac-nval').textContent = fmt(n) + ' 토큰 (' + kLabel(n) + ')';
      this.$('.ac-attn').textContent = fmt(n * n) + '회 · ' + fmt(quad) + '배';
      this.$('.ac-lin').textContent = fmt(n) + '회 · ' + fmt(lin) + '배';
      this.$('.ac-attn-bar').style.width = '100%';
      this.$('.ac-lin-bar').style.width = (100 * lin / quad) + '%';
      this.$('.ac-sum').textContent = i === 0
        ? '기준 길이(1K)에서는 둘 다 1배다. 길이를 늘려 보면 차이가 벌어진다. 막대는 attention 배수를 100%로 둔 비율이다.'
        : '길이가 1K의 ' + fmt(lin) + '배가 되면 attention 비교는 ' + fmt(quad) + '배, 토큰별 처리는 ' + fmt(lin) + '배로 커진다. 길이를 2배로 늘릴 때마다 attention 은 4배, 토큰별 처리는 2배다. 막대는 attention 배수를 100%로 둔 비율이다.';
      var bytes = 2 * c.layers * kv * c.headDim * n * c.bytes;
      var maxBytes = 2 * c.layers * c.qHeads * c.headDim * nMax * c.bytes;
      this.kvBtns.forEach(function (b) { b.setAttribute('aria-pressed', parseFloat(b.getAttribute('data-kv')) === kv ? 'true' : 'false'); });
      this.$('.ac-kv').textContent = bytesLabel(bytes);
      this.$('.ac-kv-bar').style.width = (100 * bytes / maxBytes) + '%';
      var perTok = 2 * c.layers * kv * c.headDim * c.bytes;
      this.$('.ac-kv-sum').textContent = '토큰 하나당 ' + bytesLabel(perTok) + ' × ' + fmt(n) + ' 토큰. 길이에 정비례(n)하고, KV head 를 ' + c.qHeads + '개에서 ' + (c.qHeads / 4) + '개로 줄이면 4분의 1이 된다. 막대 끝 = ' + bytesLabel(maxBytes) + '(' + kLabel(nMax) + ' 토큰, KV head ' + c.qHeads + ').';
    }
  });
})();
