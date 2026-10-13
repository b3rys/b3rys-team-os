/* b3-dow-trend — 다우 이론(카드 ⑦)으로 고점·저점을 하나씩 찍어 가며 추세 판정이 언제 바뀌는지 보는 단계 보기.
 * 규약: references/interactive-components.md
 * 가격은 설명용 예시 — 고정된 꺾은선(봉우리·골짜기 16개)이다.
 * 규칙(보고서 2-4): 상승 = 고점은 계속 갱신, 저점은 갱신 안 됨(봉우리·골짜기 모두 높아짐) · 하락 = 그 반대
 *                  전환 = 상승 중 직전 저점을 깨면 추세 종료, 하락 중 직전 고점을 넘으면 종료.
 * MD 사용 예: <b3-dow-trend class="ix">…정적 그림…</b3-dow-trend>
 */
(function () {
  'use strict';
  var NAME = 'b3-dow-trend';
  // [날짜, 가격, 'P'(봉우리)|'T'(골짜기)]
  var PTS = [
    [0, 100, 'T'], [8, 112, 'P'], [13, 106, 'T'], [22, 120, 'P'], [27, 113, 'T'], [36, 128, 'P'], [41, 120, 'T'], [47, 126, 'P'],
    [55, 114, 'T'], [60, 119, 'P'], [68, 108, 'T'], [73, 113, 'P'], [81, 101, 'T'], [86, 106, 'P'], [90, 103, 'T'], [99, 115, 'P']
  ];
  var LAST = PTS.length - 1;
  var KO = { up: '상승 트렌드', down: '하락 트렌드', none: '판정 없음' };

  function crossX(i, level) { // i-1 → i 구간에서 가격이 level 을 지나는 날짜
    var a = PTS[i - 1], b = PTS[i];
    return a[0] + (level - a[1]) / (b[1] - a[1]) * (b[0] - a[0]);
  }
  // 0…k 번째 점까지 보였을 때의 판정. 각 단계 i 에서 직전 고점·저점과 비교한다.
  function analyze(k) {
    var state = 'none', changes = [], msgs = [], lastP = -1, lastT = 0, prevP = -1, prevT = -1; // 출발점(100)이 첫 골짜기
    for (var i = 1; i <= k; i++) {
      var pt = PTS[i], v = pt[1], isP = pt[2] === 'P', m = [], before = state;
      if (isP) {
        var ref = lastP; // 비교할 직전 고점
        if (ref < 0) m.push('첫 고점 ' + v + ' — 아직 비교할 고점이 없다');
        else if (v > PTS[ref][1]) m.push('새 고점 ' + v + ' — 직전 고점 ' + PTS[ref][1] + '보다 높다 → <b>고점 갱신</b>');
        else m.push('새 고점 ' + v + ' — 직전 고점 ' + PTS[ref][1] + '보다 낮다 → <b>고점 미갱신</b>');
        prevP = lastP; lastP = i;
        var higherHigh = prevP >= 0 && v > PTS[prevP][1];
        var higherLow = prevT >= 0 && lastT >= 0 && PTS[lastT][1] > PTS[prevT][1];
        var lowerLow = prevT >= 0 && lastT >= 0 && PTS[lastT][1] < PTS[prevT][1];
        if (state === 'down' && higherHigh) {
          state = higherLow ? 'up' : 'none';
          changes.push({ x: crossX(i, PTS[prevP][1]), y: PTS[prevP][1], from: 'down', to: state, i: i, why: '직전 고점 ' + PTS[prevP][1] + ' 돌파' });
          m.push('하락 중에 직전 고점 ' + PTS[prevP][1] + '을 넘었다 → <b class="ix-strong">하락 추세 종료</b>(카드 ⑦ 전환 신호)');
        } else if (state === 'none' && higherHigh && higherLow) {
          state = 'up';
          changes.push({ x: crossX(i, PTS[prevP][1]), y: PTS[prevP][1], from: 'none', to: 'up', i: i, why: '고점·저점 모두 높아짐' });
        } else if (state === 'none' && prevP >= 0 && !higherHigh && lowerLow) {
          state = 'down';
          changes.push({ x: pt[0], y: v, from: 'none', to: 'down', i: i, why: '고점·저점 모두 낮아짐' });
        } else if (state === 'up' && prevP >= 0 && !higherHigh) {
          m.push('경고: 상승이 약해졌다. 하지만 전환 신호(직전 저점 ' + PTS[lastT][1] + ' 붕괴)는 아직 안 나왔다');
        }
      } else {
        var refT = lastT;
        if (refT < 0) m.push('출발점 ' + v);
        else if (v < PTS[refT][1]) m.push('새 저점 ' + v + ' — 직전 저점 ' + PTS[refT][1] + '보다 낮다 → <b>저점 갱신</b>(골짜기가 낮아짐)');
        else m.push('새 저점 ' + v + ' — 직전 저점 ' + PTS[refT][1] + '보다 높다 → <b>저점 미갱신</b>(골짜기가 높아짐)');
        prevT = lastT; lastT = i;
        var lowerLow2 = prevT >= 0 && v < PTS[prevT][1];
        var lowerHigh = prevP >= 0 && lastP >= 0 && PTS[lastP][1] < PTS[prevP][1];
        var higherHigh2 = prevP >= 0 && lastP >= 0 && PTS[lastP][1] > PTS[prevP][1];
        if (state === 'up' && lowerLow2) {
          state = lowerHigh ? 'down' : 'none';
          changes.push({ x: crossX(i, PTS[prevT][1]), y: PTS[prevT][1], from: 'up', to: state, i: i, why: '직전 저점 ' + PTS[prevT][1] + ' 붕괴' });
          m.push('상승 중에 직전 저점 ' + PTS[prevT][1] + '을 깼다 → <b class="ix-bad">상승 추세 종료</b>(카드 ⑦ 전환 신호)');
        } else if (state === 'none' && lowerLow2 && lowerHigh) {
          state = 'down';
          changes.push({ x: crossX(i, PTS[prevT][1]), y: PTS[prevT][1], from: 'none', to: 'down', i: i, why: '고점·저점 모두 낮아짐' });
        } else if (state === 'none' && prevT >= 0 && !lowerLow2 && higherHigh2) {
          state = 'up';
          changes.push({ x: pt[0], y: v, from: 'none', to: 'up', i: i, why: '고점·저점 모두 높아짐' });
        } else if (state === 'down' && prevT >= 0 && !lowerLow2) {
          m.push('경고: 하락이 약해졌다. 하지만 전환 신호(직전 고점 ' + PTS[lastP][1] + ' 돌파)는 아직 안 나왔다');
        }
      }
      if (i === k) {
        msgs = m;
        if (state !== before) msgs.push('판정: ' + (before === 'none' ? '' : KO[before] + ' → ') + '<b>' + KO[state] + '</b>' + (state === 'up' ? ' — 봉우리도 골짜기도 높아지고 있다' : state === 'down' ? ' — 봉우리도 골짜기도 낮아지고 있다' : ''));
        else if (state === 'none') msgs.push('판정: 아직 없음 — 고점과 저점이 두 개씩 모여야 비교할 수 있다');
        else msgs.push('판정: <b>' + KO[state] + '</b> 유지');
      }
    }
    if (k === 0) msgs = ['출발점 ' + PTS[0][1] + ' — 다음을 눌러 봉우리와 골짜기를 하나씩 찍어 보세요'];
    // 화면에 그을 기준선: 지금 점 바로 앞의 고점·저점
    var refHigh = -1, refLow = -1;
    for (var j = k - 1; j >= 0; j--) {
      if (PTS[j][2] === 'P' && refHigh < 0) refHigh = j;
      if (PTS[j][2] === 'T' && refLow < 0) refLow = j;
    }
    return { k: k, state: state, changes: changes, msgs: msgs, refHigh: refHigh, refLow: refLow };
  }
  function history(a) {
    if (!a.changes.length) return '판정 기록: 아직 없음';
    return '판정 기록: ' + a.changes.map(function (c) {
      return (c.from === 'none' ? '' : KO[c.from] + ' 종료(' + c.why + ') → ') + KO[c.to] + (c.from === 'none' ? '(' + c.why + ')' : '');
    }).join(' → ');
  }
  function svg(a, W, H, opts) {
    opts = opts || {};
    var text = opts.text !== false;
    var padL = 6, padR = text ? 92 : 8, padT = 12, padB = 10, lo = 96, hi = 132;
    var d0 = PTS[0][0], d1 = PTS[LAST][0];
    function X(d) { return padL + (d - d0) / (d1 - d0) * (W - padL - padR); }
    function Y(v) { return padT + (hi - v) / (hi - lo) * (H - padT - padB); }
    var o = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="설명용 예시 가격의 고점·저점과 다우 이론 판정, ' + (a.k) + '단계">';
    // 판정 구간 띠
    var endX = PTS[a.k][0], segs = [], cur = 'none', from = d0;
    a.changes.forEach(function (c) { segs.push([from, c.x, cur]); from = c.x; cur = c.to; });
    segs.push([from, endX, cur]);
    segs.forEach(function (s) {
      if (s[2] === 'none' || s[1] <= s[0]) return;
      o += '<rect class="b3dt-band" data-state="' + s[2] + '" x="' + X(s[0]).toFixed(1) + '" y="' + padT + '" width="' + (X(s[1]) - X(s[0])).toFixed(1) + '" height="' + (H - padT - padB) + '" style="fill:var(' + (s[2] === 'up' ? '--green' : '--red') + ');opacity:.12" />';
    });
    // 기준선(직전 고점·저점)
    [[a.refHigh, '직전 고점', '--green'], [a.refLow, '직전 저점', '--red']].forEach(function (r) {
      if (r[0] < 0) return;
      var y = Y(PTS[r[0]][1]).toFixed(1);
      o += '<path d="M' + X(PTS[r[0]][0]).toFixed(1) + ' ' + y + 'H' + (W - padR + 4) + '" style="stroke:var(' + r[2] + ');stroke-width:1.4;stroke-dasharray:5 4;opacity:.9" />';
      if (text) o += '<text x="' + (W - padR + 8) + '" y="' + (+y + 4) + '" class="b3dt-t">' + r[1].replace('직전 ', '') + ' ' + PTS[r[0]][1] + '</text>';
    });
    // 꺾은선
    var d = '';
    for (var i = 0; i <= a.k; i++) d += (i ? 'L' : 'M') + X(PTS[i][0]).toFixed(1) + ' ' + Y(PTS[i][1]).toFixed(1);
    o += '<path d="' + d + '" style="fill:none;stroke:var(--ink);stroke-width:2;stroke-linejoin:round;opacity:.85" />';
    for (i = 0; i <= a.k; i++) {
      var isP = PTS[i][2] === 'P';
      o += '<circle cx="' + X(PTS[i][0]).toFixed(1) + '" cy="' + Y(PTS[i][1]).toFixed(1) + '" r="' + (i === a.k ? 6 : 3.5) + '" style="fill:var(' + (isP ? '--green' : '--red') + ');stroke:var(--card);stroke-width:1.5" />';
    }
    if (text && a.k > 0) {
      var cp = PTS[a.k], cx = X(cp[0]), cy = Y(cp[1]), up = cp[2] === 'P';
      o += '<text x="' + cx.toFixed(1) + '" y="' + (up ? cy - 11 : cy + 22).toFixed(1) + '" class="b3dt-t b3dt-now" text-anchor="middle">' + cp[1] + '</text>';
    }
    // 전환 신호 자리
    a.changes.forEach(function (c) {
      if (c.from === 'none') return;
      o += '<circle class="b3dt-break" data-level="' + c.y + '" cx="' + X(c.x).toFixed(1) + '" cy="' + Y(c.y).toFixed(1) + '" r="8" style="fill:none;stroke:var(' + (c.from === 'up' ? '--red' : '--green') + ');stroke-width:2.6" />';
    });
    return o + '</svg>';
  }
  var IT = '<span style="display:inline-flex;align-items:center;gap:6px">';
  var LEGEND = '<div class="b3dt-legend" style="display:flex;flex-wrap:wrap;gap:4px 14px;font-size:13px;color:var(--mut);margin:6px 0">' +
    IT + '<i style="display:inline-block;width:16px;height:12px;border-radius:3px;background:var(--green);opacity:.35"></i>상승 트렌드 구간</span>' +
    IT + '<i style="display:inline-block;width:16px;height:12px;border-radius:3px;background:var(--red);opacity:.35"></i>하락 트렌드 구간</span>' +
    IT + '<i style="display:inline-block;width:10px;height:10px;border-radius:50%;background:var(--green)"></i>고점</span>' +
    IT + '<i style="display:inline-block;width:10px;height:10px;border-radius:50%;background:var(--red)"></i>저점</span>' +
    IT + '<i style="display:inline-block;width:12px;height:12px;border-radius:50%;border:2px solid var(--mut);box-sizing:border-box"></i>전환 신호(직전 저점·고점을 깬 곳)</span></div>';

  var core = { PTS: PTS, analyze: analyze, history: history, svg: svg, LEGEND: LEGEND };
  if (typeof module !== 'undefined' && module.exports) { module.exports = core; return; }
  if (typeof customElements === 'undefined' || customElements.get(NAME)) return;

  var CSS = NAME + '{display:block}' +
    NAME + ' .b3dt-chart{margin:6px 0 2px;min-height:120px}' +
    NAME + ' .b3dt-t{fill:var(--mut);font:500 13px/1 var(--mono);font-variant-numeric:tabular-nums}' +
    NAME + ' .b3dt-now{fill:var(--ink);font-weight:700}' +
    NAME + ' .b3dt-out{margin:6px 0;padding:0 0 0 18px;font-size:14px;line-height:1.6;color:var(--ink)}' +
    NAME + ' .b3dt-hist{margin:6px 0;font-size:13px;line-height:1.55;color:var(--mut)}' +
    NAME + ' .b3dt-step{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:4px 10px}' +
    NAME + ' .b3dt-step input[type=range]{width:100%;min-width:0}';

  customElements.define(NAME, class extends HTMLElement {
    connectedCallback() {
      if (this._ready) return;
      this._ready = true;
      if (!document.head.querySelector('style[data-b3="dow-trend"]')) {
        var st = document.createElement('style'); st.setAttribute('data-b3', 'dow-trend'); st.textContent = CSS;
        document.head.appendChild(st);
      }
      this.k = LAST; // 처음 상태 = 정적 그림과 같은 전체 그림
      var title = this.querySelector('.ix-title'), cap = this.querySelector('.ix-caption'), note = this.querySelector('.ix-note');
      [].slice.call(this.children).forEach(function (c) { if (c !== title && c !== cap && c !== note) c.remove(); });
      var ui = document.createElement('div');
      ui.innerHTML =
        '<div class="ix-seg" role="group" aria-label="단계 넘기기">' +
        '<button type="button" class="ix-btn" data-act="first">처음부터</button>' +
        '<button type="button" class="ix-btn" data-act="prev">◀ 이전</button>' +
        '<button type="button" class="ix-btn" data-act="next">다음 ▶</button></div>' +
        '<div class="ix-row b3dt-step"><input type="range" min="0" max="' + LAST + '" step="1" aria-label="단계(찍은 고점·저점 수)"><span class="ix-value" data-v="k"></span></div>' +
        '<div class="b3dt-chart"></div>' +
        LEGEND +
        '<ul class="b3dt-out" aria-live="polite"></ul>' +
        '<p class="b3dt-hist"></p>';
      var frag = document.createDocumentFragment();
      while (ui.firstChild) frag.appendChild(ui.firstChild);
      if (title && title.nextSibling) this.insertBefore(frag, title.nextSibling); else this.insertBefore(frag, this.firstChild);
      var self = this;
      this.qs = function (sel) { return self.querySelector(sel); };
      this.range = this.qs('input[type=range]');
      this.range.addEventListener('input', function () { self.k = +self.range.value; self.update(); });
      this.qs('[data-act="first"]').addEventListener('click', function () { self.k = 0; self.update(); });
      this.qs('[data-act="prev"]').addEventListener('click', function () { self.k = Math.max(0, self.k - 1); self.update(); });
      this.qs('[data-act="next"]').addEventListener('click', function () { self.k = Math.min(LAST, self.k + 1); self.update(); });
      this._w = 0;
      if (typeof ResizeObserver !== 'undefined') {
        this._ro = new ResizeObserver(function () { var w = self.qs('.b3dt-chart').clientWidth; if (w && w !== self._w) self.draw(); });
        this._ro.observe(this);
      }
      this.update();
    }
    disconnectedCallback() { if (this._ro) this._ro.disconnect(); this._ready = false; }
    update() {
      this.range.value = this.k;
      this.qs('[data-v="k"]').textContent = '단계 ' + this.k + ' / ' + LAST;
      this.qs('[data-act="prev"]').disabled = this.k === 0;
      this.qs('[data-act="next"]').disabled = this.k === LAST;
      this.a = analyze(this.k);
      this.qs('.b3dt-out').innerHTML = this.a.msgs.map(function (m) { return '<li>' + m + '</li>'; }).join('');
      this.qs('.b3dt-hist').textContent = history(this.a);
      this.draw();
    }
    draw() {
      var box = this.qs('.b3dt-chart'), W = Math.max(260, Math.round(box.clientWidth || 600));
      this._w = box.clientWidth;
      box.innerHTML = svg(this.a, W, W < 520 ? 220 : 270, { text: true });
    }
  });
})();
