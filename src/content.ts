import exercises from './exercises.json';
// Type-only — erased at compile time. The content script is built as a standalone IIFE
// (vite.content.config.ts) so VALUE imports are inlined rather than emitted as ES
// module imports, which Chrome cannot load in an injected content script.
import type { Settings } from './types';
import { localDateStr } from './types';
import { GHOST_SVG, GHOST_RIG_STYLE, OUT, TEXT, MUTED, LABEL, ACCENT, BUTTER, CARD, TRACK, DOT, SKIP_BORDER, CLOSE_X, TIP_BG } from './ghost';
import { displayedSkin, effectiveUnlocked, normalizeCounters, rollCounters, skinDef, type Counters, type Skin } from './skins';

type Lang = Settings['language'];

// Bundled locally (not a Google Fonts CDN request) — a content script injects into
// every page the user visits, so an external font request there would fire constantly
// and conflict with the extension's zero-tracking, zero-servers positioning.
const FONT_BASE = chrome.runtime.getURL('fonts/');

// Chrome never registers @font-face rules declared inside a shadow root
// (crbug.com/336876): the rule parses, the computed font-family even reports the
// declared stack, but no font loads and text silently renders in the fallback.
// So these MUST be injected into the page's own document — fonts registered at
// document level are usable from shadow DOM. Registered under extension-unique
// family names (not "IBM Plex Sans") so a page that lists IBM Plex in a font
// stack without bundling it doesn't suddenly change appearance because of us.
const FONT_CSS = `
@font-face { font-family: 'Pak-a-boo Sans'; font-weight: 500; font-display: swap; src: url('${FONT_BASE}ibm-plex-sans-latin.woff2') format('woff2'); }
@font-face { font-family: 'Pak-a-boo Sans'; font-weight: 700; font-display: swap; src: url('${FONT_BASE}ibm-plex-sans-latin.woff2') format('woff2'); }
@font-face { font-family: 'Pak-a-boo Sans Thai'; font-weight: 500; font-display: swap; src: url('${FONT_BASE}ibm-plex-sans-thai-500.woff2') format('woff2'); }
@font-face { font-family: 'Pak-a-boo Sans Thai'; font-weight: 700; font-display: swap; src: url('${FONT_BASE}ibm-plex-sans-thai-700.woff2') format('woff2'); }
`;

type BreakKind = 'micro' | 'big';
interface StepDef { id: string; secs: number; pose: string; }

const STAGE1_MS = 60_000;   // peek → float out & ask (elapsed: 1 min)
const STAGE2_MS = 120_000;  // → flops mid-screen and naps (elapsed: 3 min total, per spec)

// ---------------------------------------------------------------------------
// Copy — single-language display, picked from here by the language setting.
// Exercise names/instructions live in exercises.json (both languages, per entry);
// everything else the ghost/session card says lives here.
// ---------------------------------------------------------------------------

const COPY = {
  en: {
    ariaLabel: 'Let\'s take a break with the ghost',
    sit: ['Time to rest~', 'Your eyes need a break', 'Float up and stretch with me?'],
    flop: ["Fine — napping right here until you rest", "Boo~ I'm not leaving until you break"],
    bubbleStart: 'Break now!',
    bubbleSnooze: 'In 5 min',
    gaze: 'Look at something 20 feet away',
    blink: 'Blink slowly, five times',
    stand: 'Stand up and shake it out',
    drink: 'Take a sip of water',
    kickerEye: 'EYE BREAK',
    kickerBig: 'BIG BREAK',
    kickerDone: 'FINISHED',
    skip: 'Skip',
    next: 'Next',
    doneHeading: 'Nice work~',
    newLook: (name: string) => `Mr.Boo learned a new look — ${name}!`,
    backToWork: 'Back to work',
    breaksToday: (n: number) => (n === 1 ? '1 break today' : `${n} breaks today`),
    nextBreak: (hhmm: string) => `next break ${hhmm}`
  },
  th: {
    ariaLabel: 'มาพักกันเถอะ',
    sit: ['พักหน่อยน้า 👀', 'ตาล้าแล้วนะ มองไกล ๆ กัน 🌿', 'ลอยมาชวนยืดเส้น~ 👻'],
    flop: ['งั้นขอนอนตรงนี้เลยนะ zZ', 'ไม่พักไม่ไปน้า~ 👻'],
    bubbleStart: 'พักเลย!',
    bubbleSnooze: 'อีก 5 นาที',
    gaze: 'มองไกล ๆ สุดสายตา 🌿',
    blink: 'กะพริบตาช้า ๆ 5 ที ✨',
    stand: 'ลุกขึ้นยืนหน่อย! 👻',
    drink: 'จิบน้ำหน่อย 💧',
    kickerEye: 'พักสายตา',
    kickerBig: 'ยืดเส้นยืดสายกันหน่อย',
    kickerDone: 'เสร็จแล้ว',
    skip: 'ข้าม',
    next: 'ถัดไป',
    doneHeading: 'เก่งมากจ้า~',
    newLook: (name: string) => `มิสเตอร์บูได้ลุคใหม่ — ${name}!`,
    backToWork: 'ทำงานต่อ',
    breaksToday: (n: number) => `พักไปแล้ว ${n} ครั้งวันนี้`,
    nextBreak: (hhmm: string) => `พักครั้งถัดไป ${hhmm}`
  }
} as const;

// Resolves a step's display text at render time (not baked in at build time) so an
// in-progress session can relabel itself live if the language changes mid-break.
function stepCopy(id: string, lang: Lang): { label: string; cue: string } {
  const c = COPY[lang];
  if (id === 'gaze') return { label: c.gaze, cue: '' };
  if (id === 'blink') return { label: c.blink, cue: '' };
  if (id === 'stand') return { label: c.stand, cue: '' };
  if (id === 'drink') return { label: c.drink, cue: '' };
  const ex = exercises.find((e) => e.id === id);
  if (!ex) return { label: id, cue: '' };
  return {
    label: lang === 'th' ? `${ex.th} ~` : ex.en,
    cue: (lang === 'th' ? ex.cueTh : ex.cueEn) ?? ''
  };
}

// ---------------------------------------------------------------------------
// Styles — the rig comes from ghost.ts; only this surface's own chrome lives here.
// ---------------------------------------------------------------------------

const STYLE = `
  :host { all: initial; }
  * { box-sizing: border-box; font-family: inherit; }
  .root { font-family: 'Pak-a-boo Sans', 'Pak-a-boo Sans Thai', system-ui, -apple-system, sans-serif; }

${GHOST_RIG_STYLE}

  @keyframes pulse { 0%, 100% { transform: scale(1.3); } 50% { transform: scale(1.6); } }
  @keyframes drift-in { from { transform: translateX(56vw) translateY(-10px); } to { transform: translateX(0) translateY(0); } }

  /* ---- mascot placement + escalation ---- */
  .mascot { position: fixed; right: 26px; bottom: -220px; z-index: 2147483647; cursor: pointer; transition: bottom .65s cubic-bezier(.34,1.56,.64,1); }
  .mascot svg.ghost { width: 150px; height: 160px; }
  .root[data-stage="peek"] .mascot { bottom: -76px; }
  .root[data-stage="sit"] .mascot { bottom: -10px; }

  .flopper { position: fixed; left: 50%; margin-left: -105px; bottom: -180px; z-index: 2147483647; cursor: pointer; transition: bottom .4s ease-out; }
  .flopper svg.ghost { width: 190px; height: 203px; }
  .root[data-stage="flop"] .flopper { bottom: -14px; }
  .root[data-stage="flop"] .flop-walk { animation: drift-in 2.6s ease-out both; }

  /* ---- speech bubble ---- */
  .bubble { position: absolute; bottom: calc(100% + 10px); right: 6px; width: max-content; max-width: 240px;
    padding: 11px 13px; border: 3px solid ${OUT}; border-radius: 16px; border-bottom-right-radius: 4px;
    background: ${CARD}; color: ${TEXT}; font-size: 13px; font-weight: 700; line-height: 1.35;
    box-shadow: 0 3px 0 rgba(62,87,80,.12);
    opacity: 0; transform: translateY(8px) scale(.9); transform-origin: 100% 100%; transition: .3s .1s; pointer-events: none; }
  .bubble.on { opacity: 1; transform: none; pointer-events: auto; }
  .flopper .bubble { right: auto; left: 50%; transform-origin: 50% 100%; transform: translate(-50%, 8px) scale(.9); }
  .flopper .bubble.on { transform: translateX(-50%); }
  .bubble-actions { display: flex; gap: 7px; margin-top: 10px; }
  .bubble-actions button { padding: 7px 11px; border-radius: 11px; cursor: pointer;
    font: 800 12px 'Pak-a-boo Sans', 'Pak-a-boo Sans Thai', system-ui, sans-serif; color: ${TEXT};
    background: ${BUTTER}; border: 2.5px solid ${OUT}; box-shadow: 0 2px 0 ${OUT}; }
  .bubble-actions button[data-act="snooze"] { background: transparent; border-color: ${SKIP_BORDER}; box-shadow: none; color: ${MUTED}; }
  .bubble-actions button:hover { filter: brightness(1.05); }
  .bubble-actions button:active { transform: translateY(2px); box-shadow: none; }

  /* ---- break session card (SessionCard.dc.html) ---- */
  .session { position: fixed; right: 22px; bottom: 22px; z-index: 2147483647; width: 330px;
    border: 3px solid ${OUT}; border-radius: 28px; background: ${CARD}; color: ${TEXT};
    box-shadow: 0 6px 0 rgba(62,87,80,.13), 0 22px 44px rgba(62,87,80,.15); padding: 16px 18px 16px;
    opacity: 0; pointer-events: none; transform: translateY(14px) scale(.96); transition: .35s cubic-bezier(.34,1.4,.64,1); }
  .session.on { opacity: 1; pointer-events: auto; transform: none; }
  .session-head { display: flex; justify-content: space-between; align-items: center; }
  .session-kicker { font-size: 11px; font-weight: 900; letter-spacing: 1.4px; color: ${ACCENT}; }
  .session.done .session-kicker { color: ${LABEL}; }
  .session-close { border: 0; background: none; cursor: pointer; font-size: 15px; font-weight: 800; color: ${CLOSE_X}; padding: 2px 4px; }
  .session-body { display: flex; align-items: center; gap: 6px; margin-top: 6px; }
  .stage { flex: 1; height: 152px; display: flex; justify-content: center; }
  .stage svg.ghost { width: 140px; height: 152px; }
  .ring-wrap { position: relative; width: 68px; height: 68px; flex: none; }
  .ring-wrap svg { width: 68px; height: 68px; transform: rotate(-90deg); display: block; }
  .ring-bg { fill: none; stroke: ${TRACK}; stroke-width: 7; }
  .ring-fg { fill: none; stroke: ${ACCENT}; stroke-width: 7; stroke-linecap: round; transition: stroke-dashoffset .25s linear; }
  .ring-num { position: absolute; inset: 0; display: grid; place-items: center; font-size: 20px; font-weight: 900; }
  .step-label { margin-top: 10px; font-size: 17px; font-weight: 800; text-align: center; }
  .step-cue { margin-top: 10px; padding: 9px 12px; border-radius: 12px; background: ${TIP_BG};
    border: 1.5px dashed ${SKIP_BORDER}; text-align: center; font-size: 12px; font-weight: 700; color: ${TEXT}; line-height: 1.45; }
  .step-cue:empty { display: none; margin: 0; padding: 0; border: none; }
  .dots { display: flex; justify-content: center; gap: 7px; margin-top: 13px; }
  .dots i { width: 9px; height: 9px; border-radius: 50%; background: ${DOT}; }
  .dots i.done { background: ${ACCENT}; }
  .dots i.now { background: ${ACCENT}; animation: pulse 1.6s ease-in-out infinite; }
  .session-actions { display: flex; gap: 9px; margin-top: 15px; }
  .session-actions button { flex: 1; padding: 10px 0; border-radius: 14px; cursor: pointer; text-align: center;
    font: 800 12.5px 'Pak-a-boo Sans', 'Pak-a-boo Sans Thai', system-ui, sans-serif; }
  .btn-skip { background: transparent; border: 2.5px solid ${SKIP_BORDER}; color: ${MUTED}; }
  .btn-next { background: ${BUTTER}; border: 3px solid ${OUT}; color: ${TEXT}; box-shadow: 0 3px 0 ${OUT}; }
  .btn-next:active { transform: translateY(3px); box-shadow: none; }
  .session-actions button:hover { filter: brightness(1.04); }

  /* finished state */
  .session-run { display: block; }
  .session-done-body { display: none; }
  .session.done .session-run { display: none; }
  .session.done .session-done-body { display: flex; align-items: center; gap: 10px; margin-top: 8px; }
  .done-ghost svg.ghost { width: 150px; height: 160px; }
  .done-th { font-size: 21px; font-weight: 900; }
  .done-sub { font-size: 13px; color: ${MUTED}; margin-top: 4px; line-height: 1.5; }
  .done-new { font-size: 12.5px; font-weight: 800; color: ${ACCENT}; margin-top: 5px; line-height: 1.45; }
  .done-new:empty { display: none; }
  .btn-done { display: inline-block; margin-top: 12px; padding: 9px 16px; border-radius: 14px; cursor: pointer;
    font: 800 12.5px 'Pak-a-boo Sans', 'Pak-a-boo Sans Thai', system-ui, sans-serif; color: ${TEXT};
    background: ${BUTTER}; border: 3px solid ${OUT}; box-shadow: 0 3px 0 ${OUT}; }
  .btn-done:active { transform: translateY(3px); box-shadow: none; }
`;

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

// chrome.runtime.sendMessage throws SYNCHRONOUSLY (not via lastError) once this
// script's context has been invalidated by an extension reload/update — the DOM this
// boot() built is replaced on the next injection (see the orphaned-element comment
// above), but this tab's OLD listeners (visibilitychange, the due-timer chain) live on
// until the page itself reloads, and every one of them eventually calls back in here.
// Without this, each of those exchanges an uncaught exception rather than the
// lastError this file's callbacks already know how to ignore.
function safeSendMessage(message: unknown, callback?: (response: any) => void): void {
  try {
    if (callback) chrome.runtime.sendMessage(message, callback);
    else chrome.runtime.sendMessage(message);
  } catch {
    // Orphaned — nothing left to do; the caller's own chain (armDueTimer, the
    // TAKE_BREAK response handling, …) simply never resumes, same as it would if
    // lastError had fired instead.
  }
}

async function getLang(): Promise<Lang> {
  const { language } = await chrome.storage.sync.get({ language: 'en' as Lang }) as { language: Lang };
  return language;
}

async function getSkin(): Promise<Skin> {
  const { skin } = await chrome.storage.sync.get({ skin: 'none' as Skin }) as { skin: Skin };
  return skin;
}

// Stored unlocks UNIONED with what the counters already qualify for — the stored list
// alone lags until the next completed break (see effectiveUnlocked).
// Both keys decide what the ghost wears: `streak` holds the permanent unlocks, and
// `counters` holds today's mood. Read together so neither can be stale.
async function getSkinState(): Promise<{ unlocked: Skin[]; counters: Counters }> {
  const { streak, counters } = await chrome.storage.local.get(['streak', 'counters']) as
    { streak?: Partial<{ unlockedSkins: Skin[]; currentStreak: number }>; counters?: Partial<Counters> };
  const now = new Date();
  // rollCounters settles an expired focus period itself (whether or not the day is
  // also turning over) — pre-settling here would let a cross-midnight roll discard
  // whatever got folded into the wrong (old) day's total; see its own comment.
  const rolled = rollCounters(normalizeCounters(counters), localDateStr(now), now.getTime());
  return {
    unlocked: effectiveUnlocked(
      Array.isArray(streak?.unlockedSkins) ? streak.unlockedSkins : [],
      Number(streak?.currentStreak) || 0,
      rolled
    ),
    counters: rolled
  };
}

async function boot(): Promise<void> {
  // An element left over from BEFORE an extension reload/update is orphaned — its
  // script's chrome.runtime is invalidated, but the DOM it built stays in the page.
  // Replace it rather than bailing, or the ghost silently never works in that tab
  // again until a manual page refresh (exactly what auto-injection exists to avoid).
  document.getElementById('pak-a-boo-host')?.remove();

  // Same stale-element treatment for the font registration, which must live in the
  // page's document (not the shadow root) — see the FONT_CSS comment for why. A
  // reloaded extension gets a new chrome-extension:// base URL for the woff2 files,
  // so the old style element's URLs would be dead anyway.
  document.getElementById('pak-a-boo-fonts')?.remove();
  const fontStyle = document.createElement('style');
  fontStyle.id = 'pak-a-boo-fonts';
  fontStyle.textContent = FONT_CSS;
  (document.head ?? document.documentElement).append(fontStyle);

  let lang: Lang = await getLang();
  let selectedSkin: Skin = await getSkin();
  let { unlocked: unlockedSkins, counters: skinCounters } = await getSkinState();
  const skin: Skin = displayedSkin(selectedSkin, unlockedSkins, skinCounters, new Date());

  const host = document.createElement('div');
  host.id = 'pak-a-boo-host';
  const shadow = host.attachShadow({ mode: 'closed' });
  shadow.innerHTML = `
    <style>${STYLE}</style>
    <div class="root" data-stage="hidden">
      <div class="mascot" role="button" tabindex="0">
        <div class="bubble mascot-bubble"></div>
        <div class="mascot-pose" data-skin="${skin}">${GHOST_SVG}</div>
      </div>
      <div class="flopper" role="button" tabindex="0">
        <div class="bubble flop-bubble"></div>
        <div class="flop-walk"><div class="pose-flop" data-skin="${skin}">${GHOST_SVG}</div></div>
      </div>
      <div class="session">
        <div class="session-head">
          <span class="session-kicker">PAK-A-BOO</span>
          <button class="session-close" type="button" aria-label="Close">✕</button>
        </div>
        <div class="session-run">
          <div class="session-body">
            <div class="stage"></div>
            <div class="ring-wrap">
              <svg viewBox="0 0 64 64"><circle class="ring-bg" cx="32" cy="32" r="26"/><circle class="ring-fg" cx="32" cy="32" r="26"/></svg>
              <span class="ring-num"></span>
            </div>
          </div>
          <div class="step-label"></div>
          <div class="step-cue"></div>
          <div class="dots"></div>
          <div class="session-actions">
            <button class="btn-skip" type="button"></button>
            <button class="btn-next" type="button"></button>
          </div>
        </div>
        <div class="session-done-body">
          <div class="done-ghost"><div class="pose-happy" data-skin="${skin}">${GHOST_SVG}</div></div>
          <div>
            <div class="done-th"></div>
            <div class="done-new"></div>
            <div class="done-sub"></div>
            <button class="btn-done" type="button"></button>
          </div>
        </div>
      </div>
    </div>`;
  document.documentElement.append(host);

  const root = shadow.querySelector('.root') as HTMLElement;
  const mascot = shadow.querySelector('.mascot') as HTMLElement;
  const mascotPose = shadow.querySelector('.mascot-pose') as HTMLElement;
  const flopper = shadow.querySelector('.flopper') as HTMLElement;
  const mascotBubble = shadow.querySelector('.mascot-bubble') as HTMLElement;
  const flopBubble = shadow.querySelector('.flop-bubble') as HTMLElement;
  const session = shadow.querySelector('.session') as HTMLElement;
  const kicker = shadow.querySelector('.session-kicker') as HTMLElement;
  const stageEl = shadow.querySelector('.stage') as HTMLElement;
  const ringFg = shadow.querySelector('.ring-fg') as SVGCircleElement;
  const ringNum = shadow.querySelector('.ring-num') as HTMLElement;
  const stepLabel = shadow.querySelector('.step-label') as HTMLElement;
  const stepCue = shadow.querySelector('.step-cue') as HTMLElement;
  const dotsEl = shadow.querySelector('.dots') as HTMLElement;
  const doneSub = shadow.querySelector('.done-sub') as HTMLElement;
  const doneNew = shadow.querySelector('.done-new') as HTMLElement;
  const skipBtn = shadow.querySelector('.btn-skip') as HTMLElement;
  const nextBtn = shadow.querySelector('.btn-next') as HTMLElement;
  const doneHeading = shadow.querySelector('.done-th') as HTMLElement;
  const doneBtn = shadow.querySelector('.btn-done') as HTMLElement;

  const flopPose = shadow.querySelector('.flop-walk > .pose-flop') as HTMLElement;
  const doneGhost = shadow.querySelector('.done-ghost > .pose-happy') as HTMLElement;

  // What Mr.Boo is wearing right now. Applied per ghost rather than once on .root:
  // the skin CSS matches on the nearest [data-skin] ancestor, so a single attribute up
  // top would leak the mascot's accessory onto a done card celebrating a different one.
  let currentSkin: Skin = skin;
  // True while the done card is showing a just-earned skin (see endSession). While
  // true, applySkin leaves doneGhost alone: every refreshSkin call in that ~8s window
  // (a storage event the completion's OWN write triggers, the 60s backstop timer,
  // visibilitychange) would otherwise recompute the ghost's ORDINARY current look —
  // which for a just-unlocked COLLECTABLE is never what's being celebrated, since
  // collectables aren't auto-worn — and stomp the reveal while its caption still
  // claims it. hideSession is the only place that clears this.
  let celebrating = false;
  function applySkin(next: Skin): void {
    currentSkin = next;
    mascotPose.dataset.skin = next;
    flopPose.dataset.skin = next;
    if (!celebrating) doneGhost.dataset.skin = next;
    if (stageEl.firstElementChild) (stageEl.firstElementChild as HTMLElement).dataset.skin = next;
  }
  // Re-rolls the in-memory counters against the current instant before recomputing the
  // look. Without this, a tab left open across local midnight (or one where Zen's
  // 90-minute threshold is crossed purely by a focus session continuing to run, with no
  // storage write to notice) keeps showing whatever mood/date it booted with until some
  // UNRELATED storage change happens to refresh it — which might be hours later, or
  // never for an idle tab. Called on a periodic timer below and right before a peek is
  // shown, so the ghost the user actually sees is never stale by more than a minute.
  function refreshSkin(): void {
    const now = new Date();
    // rollCounters settles an expired focus period itself (whether or not the day is
    // also turning over) — pre-settling here would let a cross-midnight roll discard
    // whatever got folded into the wrong (old) day's total; see its own comment.
    skinCounters = rollCounters(skinCounters, localDateStr(now), now.getTime());
    applySkin(displayedSkin(selectedSkin, unlockedSkins, skinCounters, now));
  }

  const RING_C = 2 * Math.PI * 26;
  ringFg.style.strokeDasharray = String(RING_C);

  let pendingKind: BreakKind = 'micro';
  let currentSessionKind: BreakKind | null = null;
  let escalateT1: ReturnType<typeof setTimeout> | undefined;
  let escalateT2: ReturnType<typeof setTimeout> | undefined;
  let doneT: ReturnType<typeof setTimeout> | undefined;
  let dueT: ReturnType<typeof setTimeout> | undefined;
  let stepTimer: ReturnType<typeof setInterval> | undefined;
  let sessionActive = false;

  function pick<T>(arr: readonly T[]): T { return arr[Math.floor(Math.random() * arr.length)]; }

  // Static labels that don't depend on any in-progress state — re-applied on boot
  // and whenever the language changes.
  function renderStaticLabels(): void {
    const c = COPY[lang];
    mascot.setAttribute('aria-label', c.ariaLabel);
    flopper.setAttribute('aria-label', c.ariaLabel);
    skipBtn.textContent = c.skip;
    nextBtn.textContent = c.next;
    doneHeading.textContent = c.doneHeading;
    doneBtn.textContent = c.backToWork;
  }

  function renderKicker(): void {
    const c = COPY[lang];
    if (session.classList.contains('done')) { kicker.textContent = c.kickerDone; return; }
    kicker.textContent = currentSessionKind === 'big' ? c.kickerBig : c.kickerEye;
  }

  function clearEscalation(): void {
    if (escalateT1) clearTimeout(escalateT1);
    if (escalateT2) clearTimeout(escalateT2);
    escalateT1 = escalateT2 = undefined;
  }

  function setStage(stage: string): void {
    root.dataset.stage = stage;
    mascotPose.className = 'mascot-pose' + (stage === 'peek' ? ' pose-peek' : '');
    mascotBubble.classList.remove('on');
    flopBubble.classList.remove('on');
  }

  function bubbleHtml(line: string, start: string, snooze: string): string {
    return `${line}<div class="bubble-actions"><button type="button" data-act="start">${start}</button><button type="button" data-act="snooze">${snooze}</button></div>`;
  }

  // ---- escalation ----

  function renderSitBubble(): void {
    const c = COPY[lang];
    mascotBubble.innerHTML = bubbleHtml(pick(c.sit), c.bubbleStart, c.bubbleSnooze);
  }

  function renderFlopBubble(): void {
    const c = COPY[lang];
    flopBubble.innerHTML = bubbleHtml(pick(c.flop), c.bubbleStart, c.bubbleSnooze);
  }

  function showPeek(kind: BreakKind): void {
    if (sessionActive || root.dataset.stage !== 'hidden') return;
    // The moment the ghost is actually about to be SEEN is the one that matters most —
    // re-resolve the look right now rather than trusting whatever it last happened to
    // be, so a tab that's been open and idle (no storage event to notice a midnight
    // rollover or a passing Zen threshold) still shows an up-to-date mood.
    refreshSkin();
    pendingKind = kind;
    setStage('peek');
    escalateT1 = setTimeout(showSit, STAGE1_MS);
  }

  function showSit(): void {
    // A setTimeout callback already queued by the event loop can't be cancelled by a
    // clearTimeout() that runs after it's dequeued — if the ghost was dismissed
    // (retreat()) in that narrow window, this must not resurrect it into 'sit'.
    if (root.dataset.stage !== 'peek') return;
    setStage('sit');
    renderSitBubble();
    // requestAnimationFrame never fires while the tab is backgrounded — if the stage
    // has already moved on (or been dismissed) by the time this finally runs, it must
    // NOT reveal a bubble that no longer belongs to the current stage. Without this
    // check, a stale queued callback could re-show it on return to the tab, stuck
    // half off-screen with nothing left to properly hide it.
    requestAnimationFrame(() => { if (root.dataset.stage === 'sit') mascotBubble.classList.add('on'); });
    escalateT2 = setTimeout(showFlop, STAGE2_MS);
  }

  function showFlop(): void {
    // Same reasoning as showSit()'s guard — a queued callback outliving a dismissal
    // must not resurrect the ghost into 'flop'.
    if (root.dataset.stage !== 'sit') return;
    setStage('flop');
    renderFlopBubble();
    setTimeout(() => { if (root.dataset.stage === 'flop') flopBubble.classList.add('on'); }, 2700);
  }

  function retreat(): void {
    clearEscalation();
    setStage('hidden');
  }

  function snooze(): void {
    retreat();
    // The response carries the new nextBreakAt so the precise timer can be re-armed —
    // without it the snoozed break comes back on the (possibly very late) alarm alone,
    // which is exactly the lag armDueTimer exists to hide.
    safeSendMessage({ type: 'SNOOZE' }, (response) => {
      if (chrome.runtime.lastError) return;
      armDueTimer(response?.nextBreakAt);
    });
  }

  // ---- break session ----

  function buildSteps(kind: BreakKind): StepDef[] {
    if (kind === 'micro') {
      return [
        { id: 'gaze', secs: 20, pose: 'window' },
        { id: 'blink', secs: 6, pose: 'blink' }
      ];
    }
    const pool = [...exercises].sort(() => Math.random() - 0.5).slice(0, 3);
    return [
      { id: 'stand', secs: 8, pose: 'stand' },
      { id: 'drink', secs: 8, pose: 'drink' },
      ...pool.map((ex) => ({ id: ex.id, secs: ex.seconds, pose: ex.id }))
    ];
  }

  let steps: StepDef[] = [];
  let stepIndex = 0;

  function renderPose(pose: string): void {
    stageEl.innerHTML = `<div class="pose-${pose}" data-skin="${currentSkin}">${GHOST_SVG}</div>`;
  }

  function renderDots(): void {
    dotsEl.innerHTML = steps.map((_, i) =>
      `<i class="${i < stepIndex ? 'done' : i === stepIndex ? 'now' : ''}"></i>`).join('');
  }

  function renderStepText(): void {
    const step = steps[stepIndex];
    if (!step) return;
    const copy = stepCopy(step.id, lang);
    stepLabel.textContent = copy.label;
    stepCue.textContent = copy.cue;
  }

  function runStep(): void {
    const step = steps[stepIndex];
    renderStepText();
    renderPose(step.pose);
    renderDots();
    const endAt = Date.now() + step.secs * 1000;
    if (stepTimer) clearInterval(stepTimer);
    ringNum.textContent = String(step.secs);
    ringFg.style.strokeDashoffset = '0';
    stepTimer = setInterval(() => {
      const left = Math.max(0, endAt - Date.now());
      ringNum.textContent = String(Math.ceil(left / 1000));
      ringFg.style.strokeDashoffset = String(RING_C * (1 - left / (step.secs * 1000)));
      if (left <= 0) nextStep();
    }, 120);
  }

  function nextStep(): void {
    if (stepTimer) clearInterval(stepTimer);
    stepIndex += 1;
    if (stepIndex >= steps.length) { endSession(true); return; }
    runStep();
  }

  function startSession(kind: BreakKind): void {
    clearEscalation();
    if (doneT) clearTimeout(doneT);
    // A new session cuts short whatever the PREVIOUS done card was showing — the same
    // moment hideSession() normally handles. If a celebration was up, this has to drop
    // it exactly like hideSession() would, or `celebrating` stays stuck true forever:
    // applySkin() then refuses to ever touch doneGhost again for the rest of the tab's
    // life, freezing every future done card on whatever skin was last celebrated.
    doneNew.textContent = '';
    celebrating = false;
    doneGhost.dataset.skin = currentSkin;
    setStage('hidden');
    sessionActive = true;
    currentSessionKind = kind;
    session.classList.remove('done');
    steps = buildSteps(kind);
    stepIndex = 0;
    session.classList.add('on');
    renderKicker();
    runStep();
    // The break is being handled here — tell other tabs to stop escalating their own
    // copy of it now, not just once this session finishes minutes from now. Without
    // this, the same break could get completed a second time from another tab.
    safeSendMessage({ type: 'SESSION_STARTED' });
  }

  function hideSession(): void {
    if (doneT) clearTimeout(doneT);
    session.classList.remove('on', 'done');
    doneNew.textContent = '';
    celebrating = false;
    doneGhost.dataset.skin = currentSkin; // drop the celebration override
  }

  function endSession(completed: boolean): void {
    // Reentrancy guard: without it, a step timer tick and a "Next"/"Skip" click landing
    // in the same instant (or a double click once stepIndex is already past the last
    // step) each independently reach this function and would each send their own
    // TAKE_BREAK — double-counting breaksToday/mood counters and advancing the cycle
    // an extra step. sessionActive is exactly "is there a session left to end", so
    // checking it here (before this call sets it false) makes every call after the
    // first a no-op.
    if (!sessionActive) return;
    if (stepTimer) clearInterval(stepTimer);
    sessionActive = false;
    // completed distinguishes "actually did the break" from "skipped/closed it" —
    // the schedule advances either way (so it doesn't nag again in 10 min), but only
    // a real completion should count toward the breaksToday stat.
    safeSendMessage({ type: 'TAKE_BREAK', completed }, (response) => {
      if (chrome.runtime.lastError) return;
      // Re-armed before the !completed bail: a SKIPPED break reschedules too, and
      // letting the timer chain end here would put the next ghost back at the mercy
      // of a late alarm.
      armDueTimer(response?.nextBreakAt);
      if (!completed) return;
      const c = COPY[lang];
      // A just-earned skin is worn by the done-card ghost immediately, ahead of
      // whatever's selected — this is the reveal, and for behaviour/event looks it is
      // the ONLY reveal, since they never appear as a button. The background queues
      // at most one per completion (see TAKE_BREAK), so there's never more than one
      // to show here — any backlog drains one completed break at a time.
      const unlockedNow = Array.isArray(response?.unlocked) ? (response.unlocked as Skin[]) : [];
      const fresh = unlockedNow[0];
      if (fresh) {
        unlockedSkins = [...unlockedSkins, ...unlockedNow];
        celebrating = true;
        doneGhost.dataset.skin = fresh;
        doneNew.textContent = c.newLook(skinDef(fresh)?.label[lang] ?? fresh);
      } else {
        doneNew.textContent = '';
      }
      const parts: string[] = [];
      if (typeof response?.breaksToday === 'number') parts.push(c.breaksToday(response.breaksToday));
      if (typeof response?.nextBreakAt === 'number') {
        const t = new Date(response.nextBreakAt);
        parts.push(c.nextBreak(`${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`));
      }
      doneSub.textContent = parts.join(' · ');
    });
    if (!completed) { hideSession(); return; }
    session.classList.add('done');
    renderKicker();
    doneSub.textContent = '';
    doneT = setTimeout(hideSession, 8000);
  }

  // ---- events ----

  shadow.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const act = target.closest('[data-act]') as HTMLElement | null;
    if (act) {
      e.stopPropagation();
      if (act.dataset.act === 'snooze') snooze();
      else startSession(pendingKind);
      return;
    }
    if (target.closest('.session-close') || target.closest('.btn-done')) { hideSession(); if (sessionActive) endSession(false); return; }
    if (target.closest('.btn-skip')) { endSession(false); return; }
    if (target.closest('.btn-next')) { nextStep(); return; }
    if (target.closest('.mascot') || target.closest('.flopper')) {
      if (root.dataset.stage === 'hidden') return;
      startSession(pendingKind);
    }
  });

  const keyActivate = (e: KeyboardEvent): void => {
    // Only the mascot/flopper container itself, not a descendant control (the bubble's
    // own Snooze/Break-now buttons) — otherwise Enter on Snooze bubbles up here and
    // starts a session instead, since preventDefault() suppresses the button's own click.
    if (e.target !== e.currentTarget) return;
    if ((e.key === 'Enter' || e.key === ' ') && root.dataset.stage !== 'hidden') {
      e.preventDefault();
      startSession(pendingKind);
    }
  };
  mascot.addEventListener('keydown', keyActivate);
  flopper.addEventListener('keydown', keyActivate);

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'BREAK_DUE') showPeek(message.breakKind === 'big' ? 'big' : 'micro');
    // The break was taken, skipped, or snoozed from a different tab — don't linger here.
    // Never interrupt a session actually in progress on this tab.
    if (message.type === 'BREAK_RESOLVED' && !sessionActive) {
      retreat();
      // Whatever resolved it (another tab, a pause, the ghost giving up) rescheduled —
      // re-arm against the new time so this tab's precise timer chain never dead-ends.
      askIfDue();
    }
  });

  // Live language/skin switch — re-render whatever's currently visible without
  // resetting timers, so an open tab updates the moment the setting changes, no
  // refresh needed. Each field is gated independently (not a single "return if this
  // field is missing" at the top) so a skin-only change isn't swallowed by the
  // language check, and vice versa.
  chrome.storage.onChanged.addListener((changes, area) => {
    // Unlocks live in storage.local; re-gate when they change so a milestone earned
    // while this tab is open puts the (already-selected) accessory on immediately.
    // Either key can change what's unlocked, so re-derive from storage rather than
    // reading the changed value alone.
    if (area === 'local' && (changes.streak || changes.counters)) {
      void getSkinState().then((next) => {
        unlockedSkins = next.unlocked; skinCounters = next.counters; refreshSkin();
      });
      return;
    }
    if (area !== 'sync') return;
    if (changes.language) {
      const next = changes.language.newValue as Lang | undefined;
      if (next) {
        lang = next;
        renderStaticLabels();
        if (root.dataset.stage === 'sit') renderSitBubble();
        if (root.dataset.stage === 'flop') renderFlopBubble();
        if (sessionActive || session.classList.contains('on')) {
          renderKicker();
          if (sessionActive) renderStepText();
        }
      }
    }
    if (changes.skin) {
      // A removed key (sync cleared) falls back to 'none' rather than being ignored,
      // so open tabs don't keep wearing a deselected accessory until reload.
      selectedSkin = (changes.skin.newValue as Skin | undefined) ?? 'none';
      refreshSkin();
    }
  });

  renderStaticLabels();

  // Chrome batches MV3 alarms and can fire them tens of seconds late, which reads as
  // "the popup's countdown hit 00:00 and nothing happened" until a refresh. The page
  // has a precise clock, so on the tab the user is actually looking at, ask the
  // background the moment the break is due. The background applies every one of its
  // usual guards (pause, session in another tab), so this can't show a break the alarm
  // path wouldn't; and if it isn't due after all, the response carries the new
  // nextBreakAt to re-arm against. With no usable time (paused, or a session open
  // elsewhere), fall back to a slow poll rather than spinning.
  //
  // ONLY the visible tab does this. Every ask costs a serialized transaction in the
  // background, and 50 tabs restored at browser start — or worse, 50 tabs all holding
  // the same nextBreakAt and firing at the same instant — would queue up behind each
  // other for no benefit: a hidden tab has nobody to show a ghost to. Hidden tabs are
  // already covered by the alarm's broadcast (which reaches every tab, so the ghost is
  // waiting when you return) and by tabs.onActivated.
  function armDueTimer(nextBreakAt: number | null | undefined): void {
    if (dueT) clearTimeout(dueT);
    dueT = undefined;
    if (document.visibilityState !== 'visible') return;
    const delay = typeof nextBreakAt === 'number' && nextBreakAt > Date.now()
      ? nextBreakAt - Date.now() + 250
      : 60_000;
    dueT = setTimeout(askIfDue, delay);
  }
  function askIfDue(): void {
    if (document.visibilityState !== 'visible') return;
    safeSendMessage({ type: 'CONTENT_READY' }, (response) => {
      if (chrome.runtime.lastError) return; // extension reloaded — this script is orphaned
      if (response?.breakDue) { showPeek(response.breakKind === 'big' ? 'big' : 'micro'); return; }
      armDueTimer(response?.nextBreakAt);
    });
  }
  // Becoming visible asks straight away — that covers a break that came due while this
  // tab was in the background, without the tab having polled for it.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { askIfDue(); refreshSkin(); }
    else if (dueT) { clearTimeout(dueT); dueT = undefined; }
  });
  askIfDue();

  // A low-frequency backstop for the look itself, independent of any break event: the
  // mascot on a tab that's simply sitting open should still cross local midnight and
  // pick up a passively-reached Zen without waiting for the next peek or an unrelated
  // storage write. One minute is frequent enough that nobody could notice the lag, and
  // infrequent enough that it costs nothing on a page left open all day.
  setInterval(() => { if (document.visibilityState === 'visible') refreshSkin(); }, 60_000);
}

void boot();
