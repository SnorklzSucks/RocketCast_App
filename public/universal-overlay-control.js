/*
 * Rocket Cast — universal overlay control
 *
 * Injected into every overlay the app serves. Overlays written for Rocket Cast
 * implement applyOverrides() themselves and are left completely alone. For any
 * other overlay this script finds the pieces by inspecting the live DOM, then
 * drives them from Match Settings: the four element toggles, team names,
 * scores, colours, series score and header text.
 *
 * It reports what it did and did not find back over the socket, so the control
 * panel can flag the fields it has no target for rather than silently no-oping.
 */
(() => {
  if (window.__RC_UNIVERSAL_CONTROL_INSTALLED__) return;
  window.__RC_UNIVERSAL_CONTROL_INSTALLED__ = true;

  const MARK = '__rcUniversal';
  const NATIVE_KEYS = /showHud|showBoostWheel|showPlayerCard|showNameplates|hideScoreboard|hideBoostWheel|hideBottomPlayerCard|hideSidePlayerCards/;

  /* ---------------------------------------------------------------- helpers */

  const vis = el => {
    if (!el || !el.getBoundingClientRect) return false;
    if (el[MARK] !== undefined) return true;   // hidden by us, still ours
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden';
  };

  // Everything an element might be called, as one lowercase haystack.
  const nameOf = el => [
    el.id || '',
    typeof el.className === 'string' ? el.className : '',
    el.getAttribute && (el.getAttribute('data-rc') || el.getAttribute('data-role') || el.getAttribute('data-name')) || ''
  ].join(' ').toLowerCase();

  const candidates = () => Array.from(document.body.querySelectorAll('*')).filter(vis);

  // Highest scoring match wins; ties break toward the outermost element so we
  // grab a whole component rather than one label inside it.
  function pick(list, score) {
    let best = null, bestScore = 0;
    for (const el of list) {
      const s = score(el);
      if (s <= 0) continue;
      if (s > bestScore || (s === bestScore && best && best.contains(el) === false && el.contains(best))) {
        best = el; bestScore = s;
      }
    }
    return bestScore > 0 ? best : null;
  }

  const R = {
    scoreboard: /score-?board|score-?bug|scorebar|match-?bar|\bhud\b|top-?bar|header-?bar/,
    boost: /boost/,
    wheelish: /wheel|meter|circle|gauge|dial|ring/,
    bottomCard: /player-?card|spectat|target-?card|bottom-?card|focus-?card|current-?player/,
    sideCards: /nameplate|name-?plate|player-?list|roster|team-?col|side-?card|player-?col/,
    blue: /\bblue\b|team-?1|home|left/,
    orange: /\borange\b|team-?2|away|right/,
    name: /name|team/,
    score: /score|goals/,
    header: /series|event|header|title|tournament|league|subtitle/
  };

  /* ------------------------------------------------------- element groups */

  function findGroups() {
    const all = candidates();
    const w = innerWidth || 1920, h = innerHeight || 1080;

    const scoreboard = pick(all, el => {
      const n = nameOf(el);
      let s = 0;
      if (R.scoreboard.test(n)) s += 10;
      if (s) {
        const r = el.getBoundingClientRect();
        // a scorebug lives across the top and is wider than it is tall
        if (r.top < h * 0.3) s += 3;
        if (r.width > r.height * 2) s += 2;
      }
      return s;
    });

    const boostWheel = pick(all, el => {
      const n = nameOf(el);
      let s = 0;
      if (R.boost.test(n) && R.wheelish.test(n)) s += 10;
      else if (R.boost.test(n)) s += 4;
      if (s) {
        const r = el.getBoundingClientRect();
        // roughly square is the giveaway for a wheel vs a boost bar
        if (Math.abs(r.width - r.height) < Math.max(r.width, r.height) * 0.25) s += 4;
      }
      return s;
    });

    const bottomPlayerCard = pick(all, el => {
      const n = nameOf(el);
      let s = 0;
      if (R.bottomCard.test(n)) s += 10;
      if (s) {
        const r = el.getBoundingClientRect();
        if (r.top > h * 0.55) s += 3;
      }
      return s;
    });

    // Side cards usually come as a matched pair of columns, so collect all of
    // them rather than picking a single winner.
    const sidePlayerCards = all.filter(el => {
      if (!R.sideCards.test(nameOf(el))) return false;
      // keep only outermost matches
      return !all.some(other => other !== el && R.sideCards.test(nameOf(other)) && other.contains(el));
    });

    return { scoreboard, boostWheel, bottomPlayerCard, sidePlayerCards };
  }

  /* ------------------------------------------------------- editable fields */

  // Team-side text: prefer an explicit blue/orange name hook, else fall back to
  // the leftmost/rightmost text inside the scoreboard.
  function findSideText(side, kind, scoreboard) {
    const re = side === 'blue' ? R.blue : R.orange;
    const kindRe = kind === 'name' ? R.name : R.score;
    const scope = scoreboard ? Array.from(scoreboard.querySelectorAll('*')).filter(vis) : candidates();

    const direct = pick(scope, el => {
      const n = nameOf(el);
      if (!re.test(n)) return 0;
      if (!kindRe.test(n)) return 0;
      // Must be a true leaf. Writing textContent on a wrapper deletes its
      // children, so a one-child wrapper is not safe to target either.
      if (el.children.length > 0) return 0;
      let s = 8;
      if (kind === 'score' && /^\d{1,2}$/.test((el.textContent || '').trim())) s += 4;
      return s;
    });
    if (direct) return direct;

    if (!scoreboard) return null;
    // geometric fallback within the scorebug
    const sb = scoreboard.getBoundingClientRect();
    const mid = sb.left + sb.width / 2;
    const leaves = scope.filter(el => el.children.length === 0 && (el.textContent || '').trim());
    const wanted = leaves.filter(el => {
      const r = el.getBoundingClientRect();
      const onSide = side === 'blue' ? r.left + r.width / 2 < mid : r.left + r.width / 2 > mid;
      if (!onSide) return false;
      const txt = (el.textContent || '').trim();
      return kind === 'score' ? /^\d{1,2}$/.test(txt) : txt.length > 1 && !/^\d+$/.test(txt);
    });
    if (!wanted.length) return null;
    // the name is the widest text on that side; the score the one nearest centre
    wanted.sort((a, b) => {
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      if (kind === 'name') return rb.width - ra.width;
      return Math.abs(ra.left - mid) - Math.abs(rb.left - mid);
    });
    return wanted[0];
  }

  function findHeader(scoreboard) {
    const scope = scoreboard ? Array.from(scoreboard.querySelectorAll('*')).filter(vis) : candidates();
    return pick(scope, el => {
      const n = nameOf(el);
      if (!R.header.test(n)) return 0;
      if (el.children.length > 0) return 0;
      return 8;
    });
  }

  // Anything painted in (close to) the team colour, so a colour change can
  // follow through to bars, plates and accents rather than just text.
  function colourTargets(root, hex) {
    const target = hexToRgb(hex);
    if (!target || !root) return [];
    const out = [];
    for (const el of [root, ...root.querySelectorAll('*')]) {
      const cs = getComputedStyle(el);
      for (const prop of ['backgroundColor', 'color', 'borderTopColor', 'fill']) {
        const rgb = parseRgb(cs[prop]);
        if (rgb && dist(rgb, target) < 60) { out.push({ el, prop }); break; }
      }
    }
    return out;
  }

  const hexToRgb = h => {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(h || '').trim());
    if (!m) return null;
    const n = parseInt(m[1], 16);
    return [n >> 16 & 255, n >> 8 & 255, n & 255];
  };
  const parseRgb = v => {
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(String(v || ''));
    return m ? [+m[1], +m[2], +m[3]] : null;
  };
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

  /* -------------------------------------------------------------- applying */

  const groups = { scoreboard: null, boostWheel: null, bottomPlayerCard: null, sidePlayerCards: [] };
  const fields = { blueName: null, orangeName: null, blueScore: null, orangeScore: null, headerText: null };
  let baseBlue = null, baseOrange = null;   // the overlay's own team colours

  function setHidden(el, hidden) {
    if (!el) return;
    if (hidden) {
      if (el[MARK] === undefined) el[MARK] = el.style.visibility || '';
      el.style.visibility = 'hidden';
    } else if (el[MARK] !== undefined) {
      el.style.visibility = el[MARK];
      delete el[MARK];
    }
  }

  function setText(el, value) {
    if (!el || value === undefined || value === null) return;
    if (el.children.length > 0) return;   // never clobber child elements
    const next = String(value);
    if (el.textContent !== next) el.textContent = next;
  }

  function recolour(root, fromHex, toHex) {
    if (!root || !fromHex || !toHex) return;
    for (const { el, prop } of colourTargets(root, fromHex)) {
      if (prop === 'fill') el.setAttribute('fill', toHex);
      else el.style[prop] = toHex;
    }
  }

  const held = el => el && el.isConnected;

  function detect() {
    const found = findGroups();
    // Only replace a handle we have lost. Overlays hide and rebuild parts of
    // themselves mid-match, and re-deriving every pass makes the toggles flap.
    if (!held(groups.scoreboard)) groups.scoreboard = found.scoreboard;
    if (!held(groups.boostWheel)) groups.boostWheel = found.boostWheel;
    if (!held(groups.bottomPlayerCard)) groups.bottomPlayerCard = found.bottomPlayerCard;
    groups.sidePlayerCards = groups.sidePlayerCards.filter(held);
    if (!groups.sidePlayerCards.length) groups.sidePlayerCards = found.sidePlayerCards;

    if (!held(fields.blueName)) fields.blueName = findSideText('blue', 'name', groups.scoreboard);
    if (!held(fields.orangeName)) fields.orangeName = findSideText('orange', 'name', groups.scoreboard);
    if (!held(fields.blueScore)) fields.blueScore = findSideText('blue', 'score', groups.scoreboard);
    if (!held(fields.orangeScore)) fields.orangeScore = findSideText('orange', 'score', groups.scoreboard);
    if (!held(fields.headerText)) fields.headerText = findHeader(groups.scoreboard);
    report();
  }

  function apply(data) {
    if (!data || typeof data !== 'object') return;

    // toggles — accept either convention
    const hidden = key => {
      const hide = data['hide' + key];
      if (hide !== undefined) return !!hide;
      const showKey = { Scoreboard: 'showHud', BoostWheel: 'showBoostWheel',
                        BottomPlayerCard: 'showPlayerCard', SidePlayerCards: 'showNameplates' }[key];
      return data[showKey] === undefined ? undefined : !data[showKey];
    };
    const h1 = hidden('Scoreboard'), h2 = hidden('BoostWheel'),
          h3 = hidden('BottomPlayerCard'), h4 = hidden('SidePlayerCards');
    if (h1 !== undefined) setHidden(groups.scoreboard, h1);
    if (h2 !== undefined) setHidden(groups.boostWheel, h2);
    if (h3 !== undefined) setHidden(groups.bottomPlayerCard, h3);
    if (h4 !== undefined) groups.sidePlayerCards.forEach(el => setHidden(el, h4));

    // text
    if (data.blueName !== undefined) setText(fields.blueName, data.blueName);
    if (data.orangeName !== undefined) setText(fields.orangeName, data.orangeName);
    const header = [data.headerTextFull, data.headerText].filter(v => String(v || '').trim()).join(' ');
    if (header) setText(fields.headerText, header);

    // colours, relative to whatever the overlay shipped with
    if (data.blueColor && baseBlue && data.blueColor !== baseBlue) {
      recolour(document.body, baseBlue, data.blueColor); baseBlue = data.blueColor;
    }
    if (data.orangeColor && baseOrange && data.orangeColor !== baseOrange) {
      recolour(document.body, baseOrange, data.orangeColor); baseOrange = data.orangeColor;
    }
  }

  /* -------------------------------------------------------------- reporting */

  let socketRef = null;
  function report() {
    const detected = {
      scoreboard: !!groups.scoreboard,
      boostWheel: !!groups.boostWheel,
      bottomPlayerCard: !!groups.bottomPlayerCard,
      sidePlayerCards: groups.sidePlayerCards.length > 0,
      blueName: !!fields.blueName,
      orangeName: !!fields.orangeName,
      blueScore: !!fields.blueScore,
      orangeScore: !!fields.orangeScore,
      headerText: !!fields.headerText,
      // A colour only counts as detected if something on the page is actually
      // painted in it -- otherwise changing it would silently do nothing.
      blueColor: colourTargets(document.body, baseBlue).length > 0,
      orangeColor: colourTargets(document.body, baseOrange).length > 0
    };
    window.__RC_DETECTION__ = detected;
    try { socketRef && socketRef.emit('overlay-detection', { native: false, detected }); } catch {}
  }

  /* ------------------------------------------------------------------ boot */

  function nativeOverlay() {
    const fn = window.applyOverrides;
    return typeof fn === 'function' && NATIVE_KEYS.test(String(fn));
  }

  // A genuinely third-party overlay has no socket.io of its own, so pull it
  // from the origin already serving this page rather than giving up.
  function withSocketIo(done) {
    if (typeof io === 'function') return done();
    const existing = document.querySelector('script[data-rc-socket-io]');
    if (existing) return existing.addEventListener('load', () => done(), { once: true });
    const tag = document.createElement('script');
    tag.src = '/socket.io/socket.io.js';
    tag.dataset.rcSocketIo = '1';
    tag.addEventListener('load', () => done(), { once: true });
    tag.addEventListener('error', () => done(), { once: true });
    document.head.appendChild(tag);
  }

  function start() {
    withSocketIo(boot);
  }

  function boot() {
    if (typeof io !== 'function') {
      // No transport, but detection is still worth running so the page can be
      // inspected and so a later manual call has something to work with.
      detect();
      return;
    }
    try { socketRef = io(); } catch { return; }

    if (nativeOverlay()) {
      // The overlay drives itself; stay out of its way entirely.
      window.__RC_DETECTION__ = { native: true };
      try { socketRef.emit('overlay-detection', { native: true }); } catch {}
      return;
    }

    baseBlue = baseBlue || '#21afd7';
    baseOrange = baseOrange || '#fd5b00';
    detect();

    socketRef.on('overrides', apply);
    socketRef.on('connect', () => report());

    // Overlays build themselves at different speeds, and some swap chunks of
    // DOM as the match runs, so re-detect on a settle timer rather than once.
    let settle = null;
    new MutationObserver(() => {
      clearTimeout(settle);
      settle = setTimeout(detect, 400);
    }).observe(document.body, { childList: true, subtree: true });
    setTimeout(detect, 1200);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
