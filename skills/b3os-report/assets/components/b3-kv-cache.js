/* b3-kv-cache — KV head 수·대화 길이·숫자 형식·대화 수를 바꾸면 KV 캐시가 얼마나 커지고,
   언제 모델 가중치나 GPU 메모리를 넘는가.
   사용: <b3-kv-cache class="ix" data-layers="28" data-head-dim="128" data-kv-heads="28,4,1"
           data-kv-default="mha" data-len="32768" data-params="7.61e9" data-gpu-gb="40">
           제목 · 정적 기본 상태(.ix-static) · 캡션 · 안내 </b3-kv-cache>
   공식(보고서 4절과 같다):
     토큰 하나당 바이트 = 2(K·V) × 층 수 × KV head 수 × head 크기 × 숫자 하나의 바이트
     KV 캐시 = 토큰 하나당 바이트 × 대화 길이 × 대화 수
     모델 가중치 = 파라미터 수 × 2바이트(bf16) — 캐시 형식을 FP8 로 바꿔도 가중치는 그대로
   GB 는 10억 바이트(보고서와 같은 단위). 10GB 미만은 소수 둘째 자리, 이상은 첫째 자리.
   보안: data-* 값은 숫자 형식·범위를 검사하고, 화면에는 textContent 로만 넣는다(innerHTML 에는 고정 문구만).
   검사에 걸리면 정적 내용을 그대로 둔다. */
(function () {
  var TAG = 'b3-kv-cache';
  if (customElements.get(TAG)) return;

  var LENS = [1024, 2048, 4096, 8192, 16384, 32768, 65536, 131072];
  var KINDS = [
    { key: 'mha', name: 'MHA', note: '가정' },
    { key: 'gqa', name: 'GQA', note: '실제' },
    { key: 'mqa', name: 'MQA', note: '가정' }
  ];
  var FORMATS = [{ key: 'bf16', name: 'bf16', bytes: 2 }, { key: 'fp8', name: 'FP8 캐시', bytes: 1 }];
  var CONVS = [1, 10];
  var WEIGHT_BYTES = 2;   // 보고서: 가중치 = 7.61B개 × 2바이트(bf16)
  var BASE_LEN = 32768;   // config.json 기본 상한. 이보다 길면 YaRN 전제(보고서 1절)

  var CSS = [
    TAG + ' .kc-ctl{display:grid;gap:8px;margin:0 0 10px}',
    TAG + ' .kc-ctl .ix-label{min-width:5.5em}',
    TAG + ' .kc-len{min-width:8.5em}',
    TAG + ' .kc-sec{margin:10px 0 0;padding:10px 12px;border:1px solid var(--line);border-radius:12px;background:var(--card-2)}',
    TAG + ' .kc-f{font-family:var(--mono);font-size:14px;line-height:1.65;color:var(--ink);overflow-wrap:anywhere;font-variant-numeric:tabular-nums;margin:2px 0}',
    TAG + ' .kc-f mark{background:var(--glow);color:var(--green);font-weight:700;border-radius:4px;padding:0 3px;white-space:nowrap}',
    TAG + ' .kc-item{margin:10px 0 0}',
    TAG + ' .kc-top{display:flex;flex-wrap:wrap;justify-content:space-between;gap:2px 10px;font-size:14px;color:var(--ink)}',
    TAG + ' .kc-track{position:relative;height:14px;margin-top:4px;border-radius:7px;background:var(--line)}',
    TAG + ' .kc-bar{position:absolute;top:0;bottom:0;left:0;border-radius:7px;min-width:2px;transition:width .25s,left .25s}',
    TAG + ' .kc-w{background:var(--mut)}',
    TAG + ' .kc-c{background:var(--orange)}',
    TAG + ' .kc-c.is-over{background:var(--red)}',
    TAG + ' .kc-gpu{position:absolute;top:-4px;bottom:-4px;width:0;border-left:2px dashed var(--ink)}',
    TAG + ' .kc-scale{display:flex;justify-content:space-between;font-size:13px;color:var(--mut);margin-top:6px}',
    TAG + ' .kc-say{margin:10px 0 0;font-size:15px;line-height:1.6;color:var(--ink)}',
    TAG + ' .kc-sub{margin:4px 0 0;font-size:13px;line-height:1.55;color:var(--mut)}'
  ].join('\n');

  function addStyle() {
    if (document.head.querySelector('style[data-b3="kv-cache"]')) return;
    var st = document.createElement('style');
    st.setAttribute('data-b3', 'kv-cache');
    st.textContent = CSS;
    document.head.appendChild(st);
  }
  function int(n) { return Math.round(n).toLocaleString('en-US'); }
  function gb(b) { var g = b / 1e9; return (g >= 10 ? g.toFixed(1) : g.toFixed(2)) + 'GB'; }
  function ratio(r) { return '1/' + (Number.isInteger(r) ? r : r.toFixed(1)); }

  // 숫자만 받는다: 형식(숫자·소수점·지수만) → 유한 → 범위 → (필요하면) 정수
  function numAttr(el, k, lo, hi, intOnly) {
    var s = el.getAttribute('data-' + k);
    if (s == null || !/^\s*\d+(\.\d+)?([eE][+]?\d+)?\s*$/.test(s)) return NaN;
    var v = Number(s);
    if (!isFinite(v) || v < lo || v > hi || (intOnly && !Number.isInteger(v))) return NaN;
    return v;
  }
  function readCfg(el) {
    var c = {
      layers: numAttr(el, 'layers', 1, 1000, true),
      headDim: numAttr(el, 'head-dim', 1, 4096, true),
      params: numAttr(el, 'params', 1e6, 1e13, false),
      gpu: numAttr(el, 'gpu-gb', 1, 10000, false),
      len: numAttr(el, 'len', 1, 1e7, true)
    };
    var kvs = String(el.getAttribute('data-kv-heads') || '').split(',').map(function (s) {
      return /^\s*\d+\s*$/.test(s) ? Number(s) : NaN;
    });
    var ok = kvs.length === 3 && kvs.every(function (v) { return isFinite(v) && v >= 1 && v <= 1000; }) &&
      kvs[0] > kvs[1] && kvs[1] > kvs[2];
    for (var k in c) if (!isFinite(c[k])) ok = false;
    if (!ok || LENS.indexOf(c.len) < 0) return null;
    c.kv = { mha: kvs[0], gqa: kvs[1], mqa: kvs[2] };
    var d = String(el.getAttribute('data-kv-default') || 'mha');
    c.kind = c.kv.hasOwnProperty(d) ? d : 'mha';
    return c;
  }

  function mk(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function seg(label, items, onPick) {
    var row = mk('div', 'ix-row');
    row.appendChild(mk('span', 'ix-label', label));
    var g = mk('div', 'ix-seg');
    g.setAttribute('role', 'group');
    g.setAttribute('aria-label', label);
    var btns = items.map(function (it) {
      var b = mk('button', 'ix-btn', it.text);
      b.type = 'button';
      b.addEventListener('click', function () { onPick(it.value); });
      b._v = it.value;
      g.appendChild(b);
      return b;
    });
    row.appendChild(g);
    return { row: row, btns: btns };
  }
  function barItem(title) {
    var item = mk('div', 'kc-item');
    var top = mk('div', 'kc-top');
    top.appendChild(mk('span', null, title));
    var val = mk('span', 'ix-value');
    top.appendChild(val);
    var track = mk('div', 'kc-track');
    item.appendChild(top);
    item.appendChild(track);
    return { item: item, val: val, track: track };
  }

  customElements.define(TAG, class extends HTMLElement {
    connectedCallback() {
      if (this._ready) return;
      var c = readCfg(this);
      if (!c) return;               // 값이 이상하면 정적 기본 상태를 그대로 둔다
      this._ready = true;
      addStyle();
      var self = this;
      this.c = c;
      this.st = { kind: c.kind, li: LENS.indexOf(c.len), bytes: 2, conv: 1 };
      this.scaleMax = 2 * c.gpu * 1e9;   // 막대 끝 = GPU 메모리의 2배

      var stat = this.querySelector('.ix-static');
      if (stat) stat.remove();
      var cap = this.querySelector('.ix-caption');
      var ui = mk('div');

      // 조작
      var ctl = mk('div', 'kc-ctl');
      this.kindSeg = seg('KV head', KINDS.map(function (k) {
        return { value: k.key, text: k.name + ' ' + c.kv[k.key] + '개 (' + k.note + ')' };
      }), function (v) { self.st.kind = v; self.update(); });
      ctl.appendChild(this.kindSeg.row);
      var lr = mk('div', 'ix-row');
      lr.appendChild(mk('span', 'ix-label', '대화 길이'));
      this.range = document.createElement('input');
      this.range.type = 'range';
      this.range.min = '0';
      this.range.max = String(LENS.length - 1);
      this.range.step = '1';
      this.range.value = String(this.st.li);
      this.range.setAttribute('aria-label', '대화 길이 (토큰 수)');
      this.range.addEventListener('input', function () { self.st.li = parseInt(self.range.value, 10); self.update(); });
      lr.appendChild(this.range);
      this.lenVal = mk('span', 'ix-value kc-len');
      lr.appendChild(this.lenVal);
      ctl.appendChild(lr);
      this.fmtSeg = seg('캐시 형식', FORMATS.map(function (f) {
        return { value: f.bytes, text: f.name + ' (' + f.bytes + '바이트)' };
      }), function (v) { self.st.bytes = v; self.update(); });
      ctl.appendChild(this.fmtSeg.row);
      this.convSeg = seg('동시 대화', CONVS.map(function (n) {
        return { value: n, text: '대화 ' + n + '개' };
      }), function (v) { self.st.conv = v; self.update(); });
      ctl.appendChild(this.convSeg.row);
      ui.appendChild(ctl);

      // 공식
      var fs = mk('div', 'kc-sec');
      this.f1 = mk('p', 'kc-f');
      this.f2 = mk('p', 'kc-f');
      fs.appendChild(this.f1);
      fs.appendChild(this.f2);
      ui.appendChild(fs);

      // 막대 (눈금 고정: 0 ~ scaleMax)
      var bs = mk('div', 'kc-sec');
      this.bCache = barItem('KV 캐시');
      this.cBar = mk('b', 'kc-bar kc-c');
      this.bCache.track.appendChild(this.cBar);
      this.bW = barItem('모델 가중치 (bf16, 그대로)');
      this.wBar = mk('b', 'kc-bar kc-w');
      this.bW.track.appendChild(this.wBar);
      this.bSum = barItem('합계 (가중치 + 캐시) · 점선 = ' + c.gpu + 'GB GPU');
      this.sW = mk('b', 'kc-bar kc-w');
      this.sC = mk('b', 'kc-bar kc-c');
      var gpuLine = mk('i', 'kc-gpu');
      gpuLine.style.left = (100 * c.gpu * 1e9 / this.scaleMax) + '%';
      this.bSum.track.appendChild(this.sW);
      this.bSum.track.appendChild(this.sC);
      this.bSum.track.appendChild(gpuLine);
      [this.bCache, this.bW, this.bSum].forEach(function (x) { bs.appendChild(x.item); });
      var sc = mk('div', 'kc-scale');
      sc.appendChild(mk('span', null, '0'));
      sc.appendChild(mk('span', null, c.gpu + 'GB'));
      sc.appendChild(mk('span', null, (2 * c.gpu) + 'GB'));
      bs.appendChild(sc);
      this.say = mk('p', 'kc-say');
      this.say.setAttribute('aria-live', 'polite');
      this.sub = mk('p', 'kc-sub');
      bs.appendChild(this.say);
      bs.appendChild(this.sub);
      ui.appendChild(bs);

      if (cap) this.insertBefore(ui, cap); else this.appendChild(ui);
      this.update();
    }

    perToken(kv, bytes) { return 2 * this.c.layers * kv * this.c.headDim * bytes; }

    update() {
      var c = this.c, s = this.st;
      var n = LENS[s.li], kv = c.kv[s.kind];
      var per = this.perToken(kv, s.bytes);
      var cache = per * n * s.conv;
      var w = c.params * WEIGHT_BYTES;
      var total = w + cache, gpu = c.gpu * 1e9, max = this.scaleMax;
      var kindName = KINDS.filter(function (k) { return k.key === s.kind; })[0].name;

      [[this.kindSeg, s.kind], [this.fmtSeg, s.bytes], [this.convSeg, s.conv]].forEach(function (p) {
        p[0].btns.forEach(function (b) { b.setAttribute('aria-pressed', b._v === p[1] ? 'true' : 'false'); });
      });
      this.range.setAttribute('aria-valuetext', int(n) + ' 토큰');
      this.lenVal.textContent = int(n) + '토큰 (' + (n / 1024) + 'K)';

      // 공식: 바뀐 칸(KV head 수·바이트)을 표시
      this.f1.textContent = '';
      this.f1.appendChild(document.createTextNode('2 × ' + c.layers + '층 × '));
      this.f1.appendChild(mk('mark', null, kv + ' KV head'));
      this.f1.appendChild(document.createTextNode(' × ' + c.headDim + ' × '));
      this.f1.appendChild(mk('mark', null, s.bytes + '바이트'));
      this.f1.appendChild(document.createTextNode(' = ' + int(per) + '바이트/토큰'));
      this.f2.textContent = int(per) + ' × ' + int(n) + '토큰 × 대화 ' + s.conv + '개 = ' + int(cache) + '바이트 ≈ ' + gb(cache);

      // 막대
      var pc = function (x) { return Math.min(100, 100 * x / max); };
      this.bCache.val.textContent = gb(cache) + (cache > max ? ' (막대 끝 넘음)' : '');
      this.bCache.val.className = 'ix-value ' + (total > gpu ? 'ix-bad' : cache > w ? 'ix-warn' : 'ix-strong');
      this.cBar.style.width = pc(cache) + '%';
      this.cBar.classList.toggle('is-over', total > gpu);
      this.bW.val.textContent = gb(w);
      this.wBar.style.width = pc(w) + '%';
      this.bSum.val.textContent = gb(total) + (total > max ? ' (막대 끝 넘음)' : '');
      this.bSum.val.className = 'ix-value ' + (total > gpu ? 'ix-bad' : 'ix-strong');
      this.sW.style.width = pc(w) + '%';
      this.sC.style.left = pc(w) + '%';
      this.sC.style.width = Math.max(0, pc(total) - pc(w)) + '%';
      this.sC.classList.toggle('is-over', total > gpu);

      // 해석 한 문장 — 보고서의 숫자(가중치·GPU 40GB·공식)만 쓴다
      var say;
      if (total > gpu) {
        say = '가중치와 합치면 ' + gb(total) + '로, 4절에 나온 ' + c.gpu + 'GB GPU 한 장을 넘습니다.';
      } else if (cache > w) {
        say = '이 상태에서는 KV 캐시(' + gb(cache) + ')가 모델 가중치(' + gb(w) + ')보다 큽니다.';
      } else {
        var p = 100 * cache / w;
        say = 'KV 캐시(' + gb(cache) + ')는 모델 가중치(' + gb(w) + ')의 ' + (p < 1 ? '1% 미만' : Math.round(p) + '%') + '입니다.';
      }
      var sub;
      if (s.kind === 'mha') {
        var g = per / kv * c.kv.gqa * n * s.conv, q = per / kv * c.kv.mqa * n * s.conv;
        sub = '같은 조건에서 GQA(실제 Qwen2.5-7B)는 ' + gb(g) + '로 ' + ratio(c.kv.mha / c.kv.gqa) +
          ', MQA 가정은 ' + gb(q) + '로 ' + ratio(c.kv.mha / c.kv.mqa) + '입니다. 가중치 막대는 그대로입니다.';
      } else {
        var m = per / kv * c.kv.mha * n * s.conv;
        sub = '같은 조건의 MHA 가정(' + gb(m) + ')의 ' + ratio(c.kv.mha / kv) + '입니다. ' + kindName + '도 길이에 비례해 늘어납니다.';
      }
      if (n > BASE_LEN) sub += ' ' + int(BASE_LEN) + '토큰을 넘는 길이는 YaRN 설정을 켰다고 가정한 값입니다.';
      this.say.textContent = say;
      this.sub.textContent = sub;
    }
  });
})();
