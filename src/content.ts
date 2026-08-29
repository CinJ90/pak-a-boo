import exercises from './exercises.json';
// Type-only — erased at compile time, so this never pulls a runtime import into the
// bundle. Content scripts must stay a single self-contained script (not an ES module),
// so DEFAULT_SETTINGS is intentionally NOT imported here; see getLang() below.
import type { Settings } from './types';

type Lang = Settings['language'];
type Skin = Settings['skin'];

// Palette — cool sage/teal, chosen for relaxation and eye rest (green sits at the peak
// of human eye sensitivity and reads as calm rather than the old warm coral/cocoa theme).
const OUT = '#3E5750';    // outlines (scene props, accessories)
const INK = '#000000';    // ghost silhouette — bold black contour around body + arms
const TEXT = '#2E4038';   // headings/body text
const EYE = '#1F2B2E';
const MUTED = '#6E8880';
const LABEL = '#5C8577';
const ACCENT = '#4F9C82';
const PHONE = '#ABB3B1';     // headphones band + earcups
const PHONE_HL = '#E0E5E3';  // headphone ear pads
const BUTTER = '#BFE3C7';
const CARD = '#F6FBF8';
const TRACK = '#DCEEE4';
const DOT = '#D5E8DD';
const SKIP_BORDER = '#B9D4C8';
const GBODY = '#FBFFFC';
const BLUSH = '#E5AFAC';  // kept a soft dusty rose — pure-green cheeks read as sickly, not cute
const SILL = '#D8E8D3';
const SKY = '#CDE9F3';    // the window-gaze scene's sky — the one moment worth leaning cooler
const STEAM = '#9DBBAF';
const MUG = '#7FC3DC';    // a small deliberate accent, distinct from the sage body
const CLOSE_X = '#9DBBAF';
const TIP_BG = '#E7F3EC';
const GOLD = '#F3A93B';   // sparkles + crown — the same amber used for the popup's streak card
const HEM_HL = '#E3EFF7'; // subtle inner-hem highlight, new rig
const MUG_HL = '#CDE9F3'; // mug rim highlight

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
// The ghost rig — one SVG, poses via CSS classes (ported from Ghost.dc.html)
// ---------------------------------------------------------------------------

const GHOST_SVG = `
<svg class="ghost" viewBox="0 0 200 214" aria-hidden="true">
  <g class="window-scene">
    <rect x="16" y="-6" width="168" height="176" rx="16" fill="${SKY}" stroke="${OUT}" stroke-width="5.5"/>
    <g class="clouds">
      <ellipse cx="70" cy="40" rx="19" ry="10" fill="${CARD}" opacity=".95"/>
      <ellipse cx="86" cy="35" rx="12" ry="8" fill="${CARD}" opacity=".95"/>
      <ellipse cx="132" cy="72" rx="14" ry="7.5" fill="${CARD}" opacity=".75"/>
    </g>
    <path d="M40 0 V166 M160 0 V166" stroke="${OUT}" stroke-width="4.5" opacity=".7"/>
  </g>
  <ellipse class="gshadow" cx="100" cy="198" rx="38" ry="6" fill="${OUT}"/>
  <g class="gbody">
    <g class="ghead">
      <g class="hem">
        <path d="M106 38 C142 38 160 70 160 108 C160 134 156 154 152 168 C150 177 141 179 137 170 C133 160 124 160 120 170 C116 180 107 180 103 170 C99 160 90 160 86 170 C82 179 72 179 68 169 C64 159 55 160 50 167 C44 176 35 173 33 162 C31 148 38 126 44 110 C48 68 72 38 106 38 Z" fill="${GBODY}"/>
        <path d="M44 110 C38 126 31 148 33 162 C35 173 44 176 50 167 C55 160 64 159 68 169 C72 179 82 179 86 170 C88 165 92 162 96 162 C72 156 54 136 50 112 Z" fill="${HEM_HL}"/>
        <path d="M62 78 C70 60 84 50 100 48 C86 56 74 68 68 84 Z" fill="#FFFFFF"/>
        <path d="M106 38 C142 38 160 70 160 108 C160 134 156 154 152 168 C150 177 141 179 137 170 C133 160 124 160 120 170 C116 180 107 180 103 170 C99 160 90 160 86 170 C82 179 72 179 68 169 C64 159 55 160 50 167 C44 176 35 173 33 162 C31 148 38 126 44 110 C48 68 72 38 106 38 Z" fill="none" stroke="${INK}" stroke-width="7" stroke-linejoin="round"/>
      </g>
      <ellipse cx="72" cy="98" rx="11" ry="7" fill="${BLUSH}" opacity=".55"/>
      <ellipse cx="132" cy="98" rx="11" ry="7" fill="${BLUSH}" opacity=".55"/>
      <g class="arm-l">
        <path d="M56 120 C34 116 16 124 16 135 C16 146 34 152 56 147 Z" fill="${GBODY}"/>
        <path d="M56 120 C34 116 16 124 16 135 C16 146 34 152 56 147" fill="none" stroke="${INK}" stroke-width="7" stroke-linecap="round"/>
      </g>
      <g class="arm-r">
        <path d="M146 120 C168 116 186 124 186 135 C186 146 168 152 146 147 Z" fill="${GBODY}"/>
        <path d="M146 120 C168 116 186 124 186 135 C186 146 168 152 146 147" fill="none" stroke="${INK}" stroke-width="7" stroke-linecap="round"/>
        <g class="mug">
          <path d="M186 128 q13 7 0 14" fill="none" stroke="${OUT}" stroke-width="5"/>
          <rect x="154" y="120" width="34" height="32" rx="8" fill="${MUG}" stroke="${OUT}" stroke-width="5"/>
          <rect x="159" y="127" width="23" height="7" rx="3.5" fill="${MUG_HL}"/>
          <path class="steam" d="M162 112 q4 -7 0 -14 M179 112 q-4 -7 0 -14" fill="none" stroke="${STEAM}" stroke-width="3.5" stroke-linecap="round"/>
        </g>
      </g>
      <g class="eyes">
        <g class="eyes-open">
          <g class="eo-in">
            <ellipse cx="86" cy="98" rx="11" ry="14" fill="${EYE}"/>
            <circle cx="90" cy="90" r="4.2" fill="#fff"/>
            <circle cx="82" cy="104" r="2.4" fill="#fff" opacity=".75"/>
            <ellipse cx="126" cy="98" rx="11" ry="14" fill="${EYE}"/>
            <circle cx="130" cy="90" r="4.2" fill="#fff"/>
            <circle cx="122" cy="104" r="2.4" fill="#fff" opacity=".75"/>
          </g>
          <g class="ec-in">
            <path d="M75 98 Q86 107 97 98" fill="none" stroke="${EYE}" stroke-width="5.5" stroke-linecap="round"/>
            <path d="M115 98 Q126 107 137 98" fill="none" stroke="${EYE}" stroke-width="5.5" stroke-linecap="round"/>
          </g>
          <path d="M97 118 Q106 128 115 118" fill="none" stroke="${EYE}" stroke-width="5" stroke-linecap="round"/>
        </g>
        <g class="eyes-happy">
          <path d="M75 102 Q86 86 97 102" fill="none" stroke="${EYE}" stroke-width="6" stroke-linecap="round"/>
          <path d="M115 102 Q126 86 137 102" fill="none" stroke="${EYE}" stroke-width="6" stroke-linecap="round"/>
          <path d="M95 118 Q106 132 117 118" fill="none" stroke="${EYE}" stroke-width="5" stroke-linecap="round"/>
        </g>
        <g class="eyes-sleep">
          <path d="M75 96 Q86 106 97 96" fill="none" stroke="${EYE}" stroke-width="5.5" stroke-linecap="round"/>
          <path d="M115 96 Q126 106 137 96" fill="none" stroke="${EYE}" stroke-width="5.5" stroke-linecap="round"/>
          <path d="M99 118 Q106 124 113 118" fill="none" stroke="${EYE}" stroke-width="4.5" stroke-linecap="round"/>
        </g>
      </g>
      <g class="skin-sprout">
        <path d="M106 46 V26" fill="none" stroke="${OUT}" stroke-width="5" stroke-linecap="round"/>
        <g class="leaf-sway">
          <path d="M106 30 C106 18 116 10 128 12 C127 24 118 32 106 30 Z" fill="${ACCENT}" stroke="${OUT}" stroke-width="4.5" stroke-linejoin="round"/>
          <path d="M106 34 C106 24 97 17 86 19 C87 29 95 36 106 34 Z" fill="${BUTTER}" stroke="${OUT}" stroke-width="4.5" stroke-linejoin="round"/>
        </g>
      </g>
      <g class="skin-phones">
        <path d="M52 100 C52 62 76 42 106 42 C136 42 158 64 158 100" fill="none" stroke="${OUT}" stroke-width="13" stroke-linecap="round"/>
        <path d="M52 100 C52 62 76 42 106 42 C136 42 158 64 158 100" fill="none" stroke="${PHONE}" stroke-width="6.5" stroke-linecap="round"/>
        <rect x="38" y="92" width="27" height="35" rx="13" fill="${PHONE}" stroke="${OUT}" stroke-width="5.5"/>
        <rect x="145" y="92" width="27" height="35" rx="13" fill="${PHONE}" stroke="${OUT}" stroke-width="5.5"/>
        <rect x="45" y="101" width="13" height="18" rx="6.5" fill="${PHONE_HL}"/>
        <rect x="152" y="101" width="13" height="18" rx="6.5" fill="${PHONE_HL}"/>
      </g>
      <g class="skin-crown">
        <path d="M70 60 L75 28 L88 44 L106 22 L124 44 L137 28 L142 60 Z" fill="${GOLD}" stroke="${OUT}" stroke-width="5.5" stroke-linejoin="round"/>
        <circle cx="75" cy="28" r="4.5" fill="${GBODY}" stroke="${OUT}" stroke-width="3"/>
        <circle cx="106" cy="22" r="5" fill="${GBODY}" stroke="${OUT}" stroke-width="3"/>
        <circle cx="137" cy="28" r="4.5" fill="${GBODY}" stroke="${OUT}" stroke-width="3"/>
        <path class="crown-shine" d="M82 54 H130" stroke="${GBODY}" stroke-width="4.5" stroke-linecap="round"/>
      </g>
    </g>
  </g>
  <g class="wisp"><ellipse cx="26" cy="158" rx="7" ry="5" fill="${GBODY}" stroke="${INK}" stroke-width="4" opacity=".8"/></g>
  <rect class="sill" x="6" y="182" width="188" height="20" rx="10" fill="${SILL}" stroke="${OUT}" stroke-width="5"/>
  <path class="ledge" d="M-14 156 H214 V220 H-14 Z" fill="${TRACK}" stroke="${OUT}" stroke-width="5"/>
  <g class="sparkles" fill="${GOLD}" stroke="${OUT}" stroke-width="2">
    <path class="sp1" d="M26 62 l5 11 11 5 -11 5 -5 11 -5 -11 -11 -5 11 -5 Z"/>
    <path class="sp2" d="M172 42 l4 9 9 4 -9 4 -4 9 -4 -9 -9 -4 9 -4 Z"/>
    <path class="sp3" d="M166 132 l3.5 8 8 3.5 -8 3.5 -3.5 8 -3.5 -8 -8 -3.5 8 -3.5 Z"/>
  </g>
  <g class="zzz" fill="${MUTED}" font-family="'Pak-a-boo Sans', sans-serif" font-weight="800">
    <text class="z1" x="150" y="120" font-size="18">z</text>
    <text class="z2" x="150" y="120" font-size="14">z</text>
  </g>
</svg>`;

// ---------------------------------------------------------------------------
// Styles — keyframes ported verbatim from Ghost.dc.html
// ---------------------------------------------------------------------------

const STYLE = `
  :host { all: initial; }
  * { box-sizing: border-box; font-family: inherit; }
  .root { font-family: 'Pak-a-boo Sans', 'Pak-a-boo Sans Thai', system-ui, -apple-system, sans-serif; }
  svg.ghost { display: block; overflow: visible; }

  @keyframes breathe2 { 0%, 100% { transform: translateY(0) scale(1, 1); } 30% { transform: translateY(-6px) scale(.985, 1.02); } 62% { transform: translateY(2px) scale(1.018, .984); } }
  @keyframes bob { 0%, 100% { transform: translate(0, 0) rotate(0); } 24% { transform: translate(-2px, -2px) rotate(-3deg); } 52% { transform: translate(0, 2px) rotate(1deg); } 78% { transform: translate(2px, -1px) rotate(2.6deg); } }
  @keyframes lookaround { 0%, 34%, 100% { transform: rotate(-5deg) translateY(0); } 12% { transform: rotate(-8deg) translateY(-3px); } 52% { transform: rotate(6deg) translateY(-1px); } 78% { transform: rotate(-2deg) translateY(1px); } }
  @keyframes hop { 0%, 100% { transform: translateY(0) scale(1, 1); } 14% { transform: translateY(2px) scale(1.09, .9); } 46% { transform: translateY(-22px) scale(.9, 1.12); } 74% { transform: translateY(2px) scale(1.07, .93); } 88% { transform: translateY(-3px) scale(.99, 1.01); } }
  @keyframes peekup { 0%, 100% { transform: translateY(14px) rotate(-4deg); } 50% { transform: translateY(-2px) rotate(4deg); } }
  @keyframes openup { 0%, 100% { transform: scale(1, 1) translateY(0); } 50% { transform: scale(1.07, 1.02) translateY(-4px); } }
  @keyframes stretchup { 0%, 100% { transform: scale(1, 1) translateY(0); } 50% { transform: scale(.93, 1.1) translateY(-8px); } }
  @keyframes flopk { 0%, 100% { transform: translateY(24px) scale(1.18, .68); } 50% { transform: translateY(26px) scale(1.12, .72); } }
  @keyframes hemwave { 0%, 100% { transform: skewX(0) scaleY(1); } 35% { transform: skewX(3.5deg) scaleY(1.06); } 70% { transform: skewX(-3deg) scaleY(.96); } }
  @keyframes shadowpulse { 0%, 100% { transform: scale(1, 1); opacity: .14; } 30% { transform: scale(.86, 1); opacity: .09; } }
  @keyframes blinkO { 0%, 90%, 100% { opacity: 1; } 93%, 97% { opacity: 0; } }
  @keyframes blinkC { 0%, 90%, 100% { opacity: 0; } 93%, 97% { opacity: 1; } }
  @keyframes wispy { 0%, 100% { transform: rotate(0) translateY(0); } 50% { transform: rotate(-7deg) translateY(-3px); } }
  @keyframes sipk { 0%, 50%, 100% { transform: rotate(0) translateY(0); } 68%, 84% { transform: rotate(-9deg) translateY(5px); } }
  @keyframes drinkR { 0%, 100% { transform: rotate(12deg) scaleX(.9); } 55% { transform: rotate(24deg) scaleX(.9); } }
  @keyframes steamk { 0% { opacity: 0; transform: translateY(4px) scale(.9); } 40% { opacity: .9; } 100% { opacity: 0; transform: translateY(-10px) scale(1.1); } }
  @keyframes chink { 0%, 100% { transform: translateY(0); } 45%, 62% { transform: translateY(10px); } }
  @keyframes tiltk { 0%, 100% { transform: rotate(0); } 25% { transform: rotate(-20deg); } 75% { transform: rotate(20deg); } }
  @keyframes shrugk { 0%, 100% { transform: translateY(0); } 30% { transform: translateY(-5px); } }
  @keyframes rollL { 0%, 100% { transform: rotate(-6deg); } 30% { transform: rotate(46deg); } 65% { transform: rotate(14deg); } }
  @keyframes rollR { 0%, 100% { transform: rotate(6deg); } 30% { transform: rotate(-46deg); } 65% { transform: rotate(-14deg); } }
  @keyframes wristL { 0%, 100% { transform: rotate(22deg) scaleX(1.1); } 50% { transform: rotate(44deg) scaleX(1.1); } }
  @keyframes wristR { 0%, 100% { transform: rotate(-22deg) scaleX(1.1); } 50% { transform: rotate(-44deg) scaleX(1.1); } }
  @keyframes reachL { 0%, 100% { transform: rotate(52deg) scaleX(1.35); } 50% { transform: rotate(62deg) scaleX(1.5); } }
  @keyframes reachR { 0%, 100% { transform: rotate(-52deg) scaleX(1.35); } 50% { transform: rotate(-62deg) scaleX(1.5); } }
  @keyframes clapL { 0%, 100% { transform: rotate(178deg) scaleX(1.2); } 50% { transform: rotate(182deg) scaleX(1.82); } }
  @keyframes clapR { 0%, 100% { transform: rotate(-176deg) scaleX(1.28); } 50% { transform: rotate(-180deg) scaleX(1.9); } }
  @keyframes wiggle { 0%, 100% { transform: rotate(-4deg) translateY(0); } 50% { transform: rotate(4deg) translateY(-4px); } }
  @keyframes sparkk { 0%, 100% { opacity: 0; transform: scale(.3) rotate(0); } 45% { opacity: 1; transform: scale(1.15) rotate(75deg); } }
  @keyframes zzzk { 0% { opacity: 0; transform: translate(0, 0) scale(.5); } 25% { opacity: 1; } 100% { opacity: 0; transform: translate(16px, -30px) scale(1.15); } }
  @keyframes clouddrift { from { transform: translateX(-14px); } to { transform: translateX(16px); } }
  @keyframes pulse { 0%, 100% { transform: scale(1.3); } 50% { transform: scale(1.6); } }
  @keyframes drift-in { from { transform: translateX(56vw) translateY(-10px); } to { transform: translateX(0) translateY(0); } }
  /* ---- accessory wobble (worn, not pasted on) ---- */
  @keyframes accwob { 0%, 100% { transform: rotate(-3deg) translateY(0); } 50% { transform: rotate(3deg) translateY(-1.5px); } }
  @keyframes leafsway { 0%, 100% { transform: rotate(-6deg); } 50% { transform: rotate(6deg); } }
  @keyframes crownshine { 0%, 100% { opacity: .25; } 50% { opacity: .85; } }

  /* ---- base rig ---- */
  .gbody { transform-origin: 100px 190px; animation: breathe2 4.6s ease-in-out infinite; }
  .ghead { transform-origin: 100px 130px; animation: bob 5.4s ease-in-out infinite; }
  .hem { transform-origin: 100px 60px; animation: hemwave 5.2s ease-in-out infinite; }
  .gshadow { transform-origin: 100px 198px; opacity: .14; animation: shadowpulse 4.6s ease-in-out infinite; }
  .wisp { transform-origin: 100px 120px; animation: wispy 6.4s ease-in-out infinite; }
  .arm-l { transform-origin: 50px 135px; transform: rotate(7deg); }
  .arm-r { transform-origin: 152px 135px; transform: rotate(-4.5deg); }
  .eo-in { animation: blinkO 4.8s infinite; }
  .ec-in { opacity: 0; animation: blinkC 4.8s infinite; }
  .eyes { transition: transform .5s; }
  .window-scene, .sill, .ledge, .mug, .sparkles, .zzz, .eyes-happy, .eyes-sleep, .skin-sprout, .skin-phones, .skin-crown { display: none; }
  .clouds { animation: clouddrift 9s ease-in-out infinite alternate; }
  .steam { animation: steamk 1.7s ease-out infinite; }
  .sp1 { transform-origin: 26px 78px; animation: sparkk 1.8s ease-in-out infinite; }
  .sp2 { transform-origin: 172px 55px; animation: sparkk 1.8s .5s ease-in-out infinite; }
  .sp3 { transform-origin: 166px 143px; animation: sparkk 1.8s 1s ease-in-out infinite; }
  .z1 { animation: zzzk 2.8s ease-out infinite; }
  .z2 { animation: zzzk 2.8s 1.1s ease-out infinite; }

  /* ---- poses (values from SessionCard.dc.html pose table) ---- */
  .pose-peek .gbody { animation: peekup 3.2s ease-in-out infinite; }
  .pose-peek .eyes { transform: translate(-4px, -2px); }
  .pose-peek .ledge { display: block; }
  .pose-window .window-scene, .pose-window .sill { display: block; }
  .pose-window .ghead { animation: lookaround 7s ease-in-out infinite; }
  .pose-window .eyes { transform: translate(-6px, -3px); }
  .pose-blink .eo-in { animation: blinkO .6s infinite; }
  .pose-blink .ec-in { animation: blinkC .6s infinite; }
  .pose-flop .gbody { animation: flopk 5.2s ease-in-out infinite; }
  .pose-flop .ghead { animation: bob 7s ease-in-out infinite; }
  .pose-flop .eyes-open { display: none; }
  .pose-flop .eyes-sleep { display: block; }
  .pose-flop .zzz { display: block; }
  .pose-stand .gbody { animation: hop 1.15s ease-in-out infinite; }
  .pose-stand .arm-l { transform: rotate(32deg); }
  .pose-stand .arm-r { transform: rotate(-32deg); }
  .pose-happy .gbody { animation: hop .95s ease-in-out infinite; }
  .pose-happy .arm-l { transform: rotate(44deg); }
  .pose-happy .arm-r { transform: rotate(-44deg); }
  .pose-happy .eyes-open { display: none; }
  .pose-happy .eyes-happy { display: block; }
  .pose-happy .sparkles { display: block; }
  .pose-drink .mug { display: block; }
  .pose-drink .arm-r { transform: none; animation: drinkR 2.6s ease-in-out infinite; }
  .pose-drink .ghead { animation: sipk 2.6s ease-in-out infinite; }
  .pose-chin-tuck .ghead { animation: chink 2.8s ease-in-out infinite; }
  .pose-neck-tilt .ghead { animation: tiltk 4s ease-in-out infinite; }
  .pose-shoulder-rolls .arm-l { transform: none; animation: rollL 1.7s ease-in-out infinite; }
  .pose-shoulder-rolls .arm-r { transform: none; animation: rollR 1.7s ease-in-out infinite; }
  .pose-shoulder-rolls .ghead { animation: shrugk 1.7s ease-in-out infinite; }
  .pose-wrist-stretch .arm-l { transform: none; animation: wristL 1.9s ease-in-out infinite; }
  .pose-wrist-stretch .arm-r { transform: none; animation: wristR 1.9s ease-in-out infinite; }
  .pose-chest-opener .arm-l { transform: rotate(46deg); }
  .pose-chest-opener .arm-r { transform: rotate(-46deg); }
  .pose-chest-opener .gbody { animation: openup 2.4s ease-in-out infinite; }
  .pose-reach .arm-l { transform: none; animation: reachL 2.2s ease-in-out infinite; }
  .pose-reach .arm-r { transform: none; animation: reachR 2.2s ease-in-out infinite; }
  .pose-reach .gbody { animation: stretchup 2.2s ease-in-out infinite; }
  .pose-clap .arm-l { transform: none; animation: clapL .7s ease-in-out infinite; }
  .pose-clap .arm-r { transform: none; animation: clapR .7s ease-in-out infinite; }
  .pose-clap .gbody { animation: wiggle 1.4s ease-in-out infinite; }
  .pose-clap .eyes-open { display: none; }
  .pose-clap .eyes-happy { display: block; }
  .pose-clap .sparkles { display: block; }

  /* ---- skins (streak unlocks) — accessories wobble independently behind the head
     bob so they feel worn rather than pasted on. ---- */
  .skin-sprout { transform-origin: 106px 44px; animation: accwob 4.4s ease-in-out infinite; }
  .leaf-sway { transform-origin: 106px 28px; animation: leafsway 3.6s ease-in-out infinite; }
  .skin-phones { transform-origin: 104px 80px; animation: accwob 6.2s ease-in-out infinite; }
  .skin-crown { transform-origin: 106px 56px; animation: accwob 5.2s ease-in-out infinite; }
  .crown-shine { animation: crownshine 3s ease-in-out infinite; }
  .root[data-skin="sprout"] .skin-sprout { display: block; }
  .root[data-skin="phones"] .skin-phones { display: block; }
  .root[data-skin="crown"] .skin-crown { display: block; }

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
  .btn-done { display: inline-block; margin-top: 12px; padding: 9px 16px; border-radius: 14px; cursor: pointer;
    font: 800 12.5px 'Pak-a-boo Sans', 'Pak-a-boo Sans Thai', system-ui, sans-serif; color: ${TEXT};
    background: ${BUTTER}; border: 3px solid ${OUT}; box-shadow: 0 3px 0 ${OUT}; }
  .btn-done:active { transform: translateY(3px); box-shadow: none; }
`;

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

async function getLang(): Promise<Lang> {
  const { language } = await chrome.storage.sync.get({ language: 'en' as Lang }) as { language: Lang };
  return language;
}

async function getSkin(): Promise<Skin> {
  const { skin } = await chrome.storage.sync.get({ skin: 'none' as Skin }) as { skin: Skin };
  return skin;
}

async function getUnlockedSkins(): Promise<Skin[]> {
  const { streak } = await chrome.storage.local.get('streak') as { streak?: { unlockedSkins?: Skin[] } };
  return streak?.unlockedSkins ?? [];
}

// The selection syncs across devices but unlocks are earned per device, so a synced
// skin this device hasn't unlocked renders as the plain ghost instead.
function allowedSkin(selected: Skin, unlocked: Skin[]): Skin {
  return selected === 'none' || unlocked.includes(selected) ? selected : 'none';
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
  let unlockedSkins: Skin[] = await getUnlockedSkins();
  const skin: Skin = allowedSkin(selectedSkin, unlockedSkins);

  const host = document.createElement('div');
  host.id = 'pak-a-boo-host';
  const shadow = host.attachShadow({ mode: 'closed' });
  shadow.innerHTML = `
    <style>${STYLE}</style>
    <div class="root" data-stage="hidden" data-skin="${skin}">
      <div class="mascot" role="button" tabindex="0">
        <div class="bubble mascot-bubble"></div>
        <div class="mascot-pose">${GHOST_SVG}</div>
      </div>
      <div class="flopper" role="button" tabindex="0">
        <div class="bubble flop-bubble"></div>
        <div class="flop-walk"><div class="pose-flop">${GHOST_SVG}</div></div>
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
          <div class="done-ghost"><div class="pose-happy">${GHOST_SVG}</div></div>
          <div>
            <div class="done-th"></div>
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
  const skipBtn = shadow.querySelector('.btn-skip') as HTMLElement;
  const nextBtn = shadow.querySelector('.btn-next') as HTMLElement;
  const doneHeading = shadow.querySelector('.done-th') as HTMLElement;
  const doneBtn = shadow.querySelector('.btn-done') as HTMLElement;

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
    pendingKind = kind;
    setStage('peek');
    escalateT1 = setTimeout(showSit, STAGE1_MS);
  }

  function showSit(): void {
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
    chrome.runtime.sendMessage({ type: 'SNOOZE' }, (response) => {
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
    stageEl.innerHTML = `<div class="pose-${pose}">${GHOST_SVG}</div>`;
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
    chrome.runtime.sendMessage({ type: 'SESSION_STARTED' });
  }

  function hideSession(): void {
    if (doneT) clearTimeout(doneT);
    session.classList.remove('on', 'done');
  }

  function endSession(completed: boolean): void {
    if (stepTimer) clearInterval(stepTimer);
    sessionActive = false;
    // completed distinguishes "actually did the break" from "skipped/closed it" —
    // the schedule advances either way (so it doesn't nag again in 10 min), but only
    // a real completion should count toward the breaksToday stat.
    chrome.runtime.sendMessage({ type: 'TAKE_BREAK', completed }, (response) => {
      if (chrome.runtime.lastError) return;
      // Re-armed before the !completed bail: a SKIPPED break reschedules too, and
      // letting the timer chain end here would put the next ghost back at the mercy
      // of a late alarm.
      armDueTimer(response?.nextBreakAt);
      if (!completed) return;
      const c = COPY[lang];
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
    if (area === 'local' && changes.streak) {
      const next = changes.streak.newValue as { unlockedSkins?: Skin[] } | undefined;
      unlockedSkins = next?.unlockedSkins ?? [];
      root.dataset.skin = allowedSkin(selectedSkin, unlockedSkins);
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
      root.dataset.skin = allowedSkin(selectedSkin, unlockedSkins);
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
    chrome.runtime.sendMessage({ type: 'CONTENT_READY' }, (response) => {
      if (chrome.runtime.lastError) return; // extension reloaded — this script is orphaned
      if (response?.breakDue) { showPeek(response.breakKind === 'big' ? 'big' : 'micro'); return; }
      armDueTimer(response?.nextBreakAt);
    });
  }
  // Becoming visible asks straight away — that covers a break that came due while this
  // tab was in the background, without the tab having polled for it.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') askIfDue();
    else if (dueT) { clearTimeout(dueT); dueT = undefined; }
  });
  askIfDue();
}

void boot();
