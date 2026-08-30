// ---------------------------------------------------------------------------
// The ghost rig — ONE SVG, shared by every full-size ghost the content script draws:
// the mascot, the flopped nap, and the session/done cards. Poses and skins are toggled
// by CSS classes / data-skin, so every one of THOSE surfaces renders the same art from
// the same source. Ported from Ghost.dc.html in the design project; keep the geometry
// in sync with it.
//
// The popup does NOT use this rig — its skin-picker buttons are ~19px, too small for
// the full mascot to read, so they draw a flat 24x24 accessory-only glyph per skin
// (SkinDef.icon, in skins.ts) instead.
//
// Skin display is scoped to a WRAPPER's data-skin, not the shadow root: every ghost
// instance sits inside an element carrying its own data-skin (`.mascot`, `.stage`,
// `.done-ghost`…), so two ghosts on one surface can wear different looks — the done
// card celebrating a new unlock while the mascot keeps the crown.
// ---------------------------------------------------------------------------

import { SKIN_REGISTRY, type Skin } from './skins';

// Palette — cool sage/teal, chosen for relaxation and eye rest (green sits at the peak
// of human eye sensitivity and reads as calm rather than the old warm coral/cocoa theme).
export const OUT = '#3E5750';    // outlines (scene props, accessories)
export const INK = '#000000';    // ghost silhouette — bold black contour around body + arms
export const TEXT = '#2E4038';   // headings/body text
export const EYE = '#1F2B2E';
export const MUTED = '#6E8880';
export const LABEL = '#5C8577';
export const ACCENT = '#4F9C82';
export const PHONE = '#ABB3B1';     // headphones band + earcups
export const PHONE_HL = '#E0E5E3';  // headphone ear pads
export const BUTTER = '#BFE3C7';
export const CARD = '#F6FBF8';
export const TRACK = '#DCEEE4';
export const DOT = '#D5E8DD';
export const SKIP_BORDER = '#B9D4C8';
export const GBODY = '#FBFFFC';
export const BLUSH = '#E5AFAC';  // kept a soft dusty rose — pure-green cheeks read as sickly, not cute
export const SILL = '#D8E8D3';
export const SKY = '#CDE9F3';    // the window-gaze scene's sky — the one moment worth leaning cooler
export const STEAM = '#9DBBAF';
export const MUG = '#7FC3DC';    // a small deliberate accent, distinct from the sage body
export const CLOSE_X = '#9DBBAF';
export const TIP_BG = '#E7F3EC';
export const GOLD = '#F3A93B';   // sparkles + crown — the same amber used for the popup's streak card
export const HEM_HL = '#E3EFF7'; // subtle inner-hem highlight, new rig
export const MUG_HL = '#CDE9F3'; // mug rim highlight

// Skin colours (from the design project)
const LAVENDER = '#8C93D8';  // nightcap
const SANTA_RED = '#D6453C';
const ANTLER = '#8A5A3B';
const PUMPKIN = '#E8842B';
const PUMPKIN_RIB = '#C4661C';
const CANDLE = '#FFD37A';
const PARTY_PINK = '#E9668F';
const HEART = '#E0507E';
const CAT = '#F0964B';
const CAT_STRIPE = '#D97A2E';
const LOTUS = '#F6C8D8';

// Every accessory lives in its own <g class="skin-…"> hidden by default and shown by
// the wrapper's data-skin. Motion is inline (transform-origin + animation) exactly as
// designed; the keyframes are in GHOST_RIG_STYLE.
export const GHOST_SVG = `
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
        <!-- Sweetheart (Valentine's): the eyes themselves become the accessory. -->
        <g class="eyes-heart">
          <g style="transform-origin: 86px 99px; animation: heartpop 1.5s ease-in-out infinite;">
            <path d="M86 112 C70 100 74 83 86 93 C98 83 102 100 86 112 Z" fill="${HEART}" stroke="${EYE}" stroke-width="4.5" stroke-linejoin="round"/>
            <circle cx="80" cy="94" r="2.8" fill="#FFFFFF" opacity=".85"/>
          </g>
          <g style="transform-origin: 126px 99px; animation: heartpop 1.5s .3s ease-in-out infinite;">
            <path d="M126 112 C110 100 114 83 126 93 C138 83 142 100 126 112 Z" fill="${HEART}" stroke="${EYE}" stroke-width="4.5" stroke-linejoin="round"/>
            <circle cx="120" cy="94" r="2.8" fill="#FFFFFF" opacity=".85"/>
          </g>
          <path d="M96 120 Q106 131 116 120" fill="none" stroke="${EYE}" stroke-width="5" stroke-linecap="round"/>
        </g>
      </g>

      <!-- ── streak skins ── -->
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

      <!-- ── legendary: Orange Cat — an orange loaf asleep on the head ── -->
      <g class="skin-cat" style="transform-origin: 105px 54px; animation: accwob 7.4s ease-in-out infinite;">
        <path d="M74 30 L67 8 L89 20 Z" fill="${CAT}" stroke="${INK}" stroke-width="6" stroke-linejoin="round"/>
        <path d="M136 30 L143 8 L121 20 Z" fill="${CAT}" stroke="${INK}" stroke-width="6" stroke-linejoin="round"/>
        <path d="M78 25 L74 14" fill="none" stroke="${BLUSH}" stroke-width="4" stroke-linecap="round"/>
        <path d="M132 25 L136 14" fill="none" stroke="${BLUSH}" stroke-width="4" stroke-linecap="round"/>
        <g style="transform-origin: 105px 44px; animation: catbreath 3.6s ease-in-out infinite;">
          <path d="M62 44 C62 24 81 14 105 14 C129 14 148 24 148 44 C148 52 134 56 105 56 C76 56 62 52 62 44 Z" fill="${CAT}" stroke="${INK}" stroke-width="6.5" stroke-linejoin="round"/>
          <path d="M84 30 C86 23 90 19 96 17" fill="none" stroke="${CAT_STRIPE}" stroke-width="5.5" stroke-linecap="round"/>
          <path d="M104 28 C106 21 111 17 117 16" fill="none" stroke="${CAT_STRIPE}" stroke-width="5.5" stroke-linecap="round"/>
          <path d="M124 32 C127 26 132 23 138 22" fill="none" stroke="${CAT_STRIPE}" stroke-width="5" stroke-linecap="round"/>
          <path d="M79 38 Q85 44 91 38" fill="none" stroke="${INK}" stroke-width="5" stroke-linecap="round"/>
          <path d="M119 38 Q125 44 131 38" fill="none" stroke="${INK}" stroke-width="5" stroke-linecap="round"/>
          <path d="M100 40 L110 40 L105 46 Z" fill="${BLUSH}" stroke="${INK}" stroke-width="3.4" stroke-linejoin="round"/>
        </g>
      </g>

      <!-- ── behaviour skins ── -->
      <g class="skin-nightcap" style="transform-origin: 106px 68px; animation: accwob 5.8s ease-in-out infinite;">
        <path d="M150 34 C176 26 196 42 188 60" fill="none" stroke="${INK}" stroke-width="17" stroke-linecap="round"/>
        <path d="M150 34 C176 26 196 42 188 60" fill="none" stroke="${LAVENDER}" stroke-width="9" stroke-linecap="round"/>
        <g style="transform-origin: 188px 58px; animation: pomswing 3.4s ease-in-out infinite;">
          <circle cx="188" cy="70" r="12" fill="${GBODY}" stroke="${INK}" stroke-width="6"/>
        </g>
        <path d="M54 64 C54 34 78 16 106 16 C136 16 158 38 158 64 Z" fill="${LAVENDER}" stroke="${INK}" stroke-width="6.5" stroke-linejoin="round"/>
        <path d="M76 34 C86 24 97 20 108 21 C95 25 84 32 79 42 Z" fill="#FFFFFF" opacity=".45"/>
        <rect x="44" y="55" width="126" height="22" rx="11" fill="${GBODY}" stroke="${INK}" stroke-width="6"/>
      </g>
      <g class="skin-earlybird" style="transform-origin: 106px 62px; animation: ringk 3.4s ease-in-out infinite;">
        <circle cx="74" cy="26" r="13" fill="${MUG}" stroke="${INK}" stroke-width="6"/>
        <circle cx="138" cy="26" r="13" fill="${MUG}" stroke="${INK}" stroke-width="6"/>
        <path d="M86 34 L96 26 M126 34 L116 26" fill="none" stroke="${INK}" stroke-width="6" stroke-linecap="round"/>
        <circle cx="106" cy="46" r="29" fill="${GBODY}" stroke="${INK}" stroke-width="6.5"/>
        <path d="M106 46 V30 M106 46 L119 52" fill="none" stroke="${EYE}" stroke-width="5" stroke-linecap="round"/>
        <circle cx="106" cy="46" r="4" fill="${EYE}"/>
        <path d="M106 22 V26 M130 46 H126 M106 70 V66 M82 46 H86" fill="none" stroke="${STEAM}" stroke-width="3.6" stroke-linecap="round"/>
      </g>
      <g class="skin-zen" style="transform-origin: 106px 46px; animation: lotusbreath 5.2s ease-in-out infinite;">
        <path d="M106 46 C88 46 74 36 72 20 C88 18 102 30 106 46 Z" fill="${LOTUS}" stroke="${INK}" stroke-width="5.5" stroke-linejoin="round"/>
        <path d="M106 46 C124 46 138 36 140 20 C124 18 110 30 106 46 Z" fill="${LOTUS}" stroke="${INK}" stroke-width="5.5" stroke-linejoin="round"/>
        <path d="M106 46 C97 32 99 14 106 4 C113 14 115 32 106 46 Z" fill="${LOTUS}" stroke="${INK}" stroke-width="5.5" stroke-linejoin="round"/>
        <path d="M106 48 C91 50 79 44 75 33 C90 31 103 36 106 48 Z" fill="${GBODY}" stroke="${INK}" stroke-width="5.5" stroke-linejoin="round"/>
        <path d="M106 48 C121 50 133 44 137 33 C122 31 109 36 106 48 Z" fill="${GBODY}" stroke="${INK}" stroke-width="5.5" stroke-linejoin="round"/>
        <circle cx="106" cy="42" r="7.5" fill="${GOLD}" stroke="${INK}" stroke-width="4.5"/>
        <circle cx="106" cy="42" r="2.6" fill="${GBODY}" style="animation: glowk 3s ease-in-out infinite;"/>
      </g>
      <!-- ── event skins ── -->
      <g class="skin-pumpkin" style="transform-origin: 106px 56px; animation: accwob 6s ease-in-out infinite;">
        <path d="M100 14 C100 4 110 -1 117 4" fill="none" stroke="${INK}" stroke-width="13" stroke-linecap="round"/>
        <path d="M100 14 C100 4 110 -1 117 4" fill="none" stroke="${ACCENT}" stroke-width="6.5" stroke-linecap="round"/>
        <ellipse cx="106" cy="42" rx="46" ry="28" fill="${PUMPKIN}" stroke="${INK}" stroke-width="6.5"/>
        <path d="M88 18 C82 27 82 57 88 66 M124 18 C130 27 130 57 124 66" fill="none" stroke="${PUMPKIN_RIB}" stroke-width="4.5" stroke-linecap="round"/>
        <g style="animation: glowk 2.6s ease-in-out infinite;">
          <path d="M84 34 L96 34 L90 46 Z" fill="${CANDLE}" stroke="${INK}" stroke-width="3.4" stroke-linejoin="round"/>
          <path d="M116 34 L128 34 L122 46 Z" fill="${CANDLE}" stroke="${INK}" stroke-width="3.4" stroke-linejoin="round"/>
        </g>
      </g>
      <g class="skin-santa" style="transform-origin: 106px 68px; animation: accwob 5.6s ease-in-out infinite;">
        <path d="M150 32 C177 25 195 42 187 60" fill="none" stroke="${INK}" stroke-width="17" stroke-linecap="round"/>
        <path d="M150 32 C177 25 195 42 187 60" fill="none" stroke="${SANTA_RED}" stroke-width="9" stroke-linecap="round"/>
        <g style="transform-origin: 187px 58px; animation: pomswing 3.2s ease-in-out infinite;">
          <circle cx="187" cy="70" r="12.5" fill="${GBODY}" stroke="${INK}" stroke-width="6"/>
        </g>
        <path d="M56 62 C56 32 79 14 106 14 C135 14 158 36 158 62 Z" fill="${SANTA_RED}" stroke="${INK}" stroke-width="6.5" stroke-linejoin="round"/>
        <path d="M78 32 C88 23 98 20 108 20 C96 24 85 31 80 40 Z" fill="#FFFFFF" opacity=".4"/>
        <rect x="44" y="54" width="126" height="23" rx="11.5" fill="${GBODY}" stroke="${INK}" stroke-width="6"/>
      </g>
      <g class="skin-antlers" style="transform-origin: 106px 48px; animation: accwob 6.4s ease-in-out infinite;">
        <path d="M76 46 C68 32 62 24 52 18 M64 28 C58 22 51 20 45 21 M70 36 C64 33 57 34 51 38 M136 46 C144 32 150 24 160 18 M148 28 C154 22 161 20 167 21 M142 36 C148 33 155 34 161 38" fill="none" stroke="${INK}" stroke-width="12" stroke-linecap="round"/>
        <path d="M76 46 C68 32 62 24 52 18 M64 28 C58 22 51 20 45 21 M70 36 C64 33 57 34 51 38 M136 46 C144 32 150 24 160 18 M148 28 C154 22 161 20 167 21 M142 36 C148 33 155 34 161 38" fill="none" stroke="${ANTLER}" stroke-width="5.5" stroke-linecap="round"/>
        <path d="M100 30 C100 20 109 13 119 15 C118 25 110 32 100 30 Z" fill="${ACCENT}" stroke="${INK}" stroke-width="4.5" stroke-linejoin="round"/>
        <circle cx="96" cy="30" r="5.5" fill="${SANTA_RED}" stroke="${INK}" stroke-width="3.4"/>
        <circle cx="88" cy="24" r="4.6" fill="${SANTA_RED}" stroke="${INK}" stroke-width="3.2"/>
      </g>
      <g class="skin-party" style="transform-origin: 106px 58px; animation: accwob 5s ease-in-out infinite;">
        <path d="M106 8 L136 58 L76 58 Z" fill="${PARTY_PINK}" stroke="${INK}" stroke-width="6.5" stroke-linejoin="round"/>
        <path d="M92 46 H121 M99 32 H113" fill="none" stroke="${GBODY}" stroke-width="5" stroke-linecap="round"/>
        <circle cx="106" cy="8" r="8.5" fill="${GOLD}" stroke="${INK}" stroke-width="5"/>
        <path d="M56 30 l3 7 7 3 -7 3 -3 7 -3 -7 -7 -3 7 -3 Z" fill="${GOLD}" stroke="${INK}" stroke-width="2.6" style="transform-origin: 56px 40px; animation: sparkk 2s ease-in-out infinite;"/>
        <path d="M158 22 l3 7 7 3 -7 3 -3 7 -3 -7 -7 -3 7 -3 Z" fill="${ACCENT}" stroke="${INK}" stroke-width="2.6" style="transform-origin: 158px 32px; animation: sparkk 2s .6s ease-in-out infinite;"/>
        <path d="M164 56 l2.5 6 6 2.5 -6 2.5 -2.5 6 -2.5 -6 -6 -2.5 6 -2.5 Z" fill="${PARTY_PINK}" stroke="${INK}" stroke-width="2.4" style="transform-origin: 164px 64px; animation: sparkk 2s 1.2s ease-in-out infinite;"/>
      </g>
      <g class="skin-bunny" style="transform-origin: 106px 60px; animation: accwob 6.8s ease-in-out infinite;">
        <g style="transform-origin: 96px 46px; animation: earflop 3.8s ease-in-out infinite;">
          <path d="M94 48 C84 26 86 8 96 4 C106 1 108 20 104 46 Z" fill="${GBODY}" stroke="${INK}" stroke-width="6" stroke-linejoin="round"/>
          <path d="M97 38 C92 24 93 13 97 11 C101 10 101 22 100 37 Z" fill="${BLUSH}"/>
        </g>
        <g style="transform-origin: 122px 48px; animation: earflop 3.8s .5s ease-in-out infinite;">
          <path d="M120 48 C126 26 134 10 143 10 C151 11 146 30 130 50 Z" fill="${GBODY}" stroke="${INK}" stroke-width="6" stroke-linejoin="round"/>
          <path d="M124 42 C129 27 135 18 139 18 C143 19 138 31 128 44 Z" fill="${BLUSH}"/>
        </g>
      </g>
      <g class="skin-songkran" style="transform-origin: 106px 70px; animation: accwob 6.2s ease-in-out infinite;">
        <path d="M54 76 C54 42 77 24 106 24 C135 24 158 42 158 76" fill="none" stroke="${INK}" stroke-width="15" stroke-linecap="round" stroke-dasharray="2.5 13"/>
        <path d="M54 76 C54 42 77 24 106 24 C135 24 158 42 158 76" fill="none" stroke="${GBODY}" stroke-width="9.5" stroke-linecap="round" stroke-dasharray="2.5 13"/>
        <circle cx="54" cy="76" r="9.5" fill="${GOLD}" stroke="${INK}" stroke-width="5"/>
        <circle cx="158" cy="76" r="9.5" fill="${GOLD}" stroke="${INK}" stroke-width="5"/>
        <circle cx="106" cy="22" r="8" fill="${PARTY_PINK}" stroke="${INK}" stroke-width="4.6"/>
        <g fill="${MUG}" stroke="${INK}" stroke-width="3">
          <path d="M40 34 C46 42 46 48 40 48 C34 48 34 42 40 34 Z" style="animation: dropk 2.2s ease-in infinite;"/>
          <path d="M170 26 C176 34 176 40 170 40 C164 40 164 34 170 26 Z" style="animation: dropk 2.2s .8s ease-in infinite;"/>
          <path d="M148 8 C153 15 153 20 148 20 C143 20 143 15 148 8 Z" style="animation: dropk 2.2s 1.5s ease-in infinite;"/>
        </g>
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

// All accessory layer classes. Hidden unless the enclosing [data-skin] names them.
// Derived from the registry (the single source of truth for what skins exist) rather
// than restated here, so a skin added to SKIN_REGISTRY can't silently render with NO
// accessory just because this list wasn't updated to match. Two ids are deliberately
// excluded: 'none' has no accessory at all, and 'valentine' is a pure eyes-heart swap
// (see the <g class="eyes-heart"> above) with no <g class="skin-…"> layer of its own.
export const SKIN_LAYERS = SKIN_REGISTRY
  .map((s) => s.id)
  .filter((id): id is Exclude<Skin, 'none' | 'valentine'> => id !== 'none' && id !== 'valentine');

// Keyframes + rig + poses + skin visibility. Surface-specific chrome (mascot placement,
// bubbles, the session/done card) lives with each surface.
export const GHOST_RIG_STYLE = `
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
  @keyframes trapHead { 0%, 100% { transform: rotate(0); } 14% { transform: rotate(-24deg); } 40% { transform: rotate(-27deg); } 50% { transform: rotate(0); } 64% { transform: rotate(24deg); } 90% { transform: rotate(27deg); } }
  @keyframes trapBody { 0%, 100% { transform: rotate(0) translateY(0); } 14% { transform: rotate(-4deg) translateY(-2px); } 40% { transform: rotate(-5deg) translateY(-2px); } 50% { transform: rotate(0) translateY(0); } 64% { transform: rotate(4deg) translateY(-2px); } 90% { transform: rotate(5deg) translateY(-2px); } }
  @keyframes trapL { 0%, 100% { transform: rotate(8deg); } 14% { transform: translate(50px, -70px) rotate(-16deg); } 40% { transform: translate(50px, -73px) rotate(-18deg); } 50% { transform: rotate(8deg); } 64% { transform: rotate(-2deg); } 90% { transform: rotate(-4deg); } }
  @keyframes trapR { 0%, 100% { transform: rotate(-8deg); } 14% { transform: rotate(2deg); } 40% { transform: rotate(4deg); } 50% { transform: rotate(-8deg); } 64% { transform: translate(-38px, -70px) rotate(16deg); } 90% { transform: translate(-38px, -73px) rotate(18deg); } }
  @keyframes twistBody { 0%, 100% { transform: scaleX(1) translateX(0) rotate(0); } 12% { transform: scaleX(.84) translateX(-7px) rotate(-4deg); } 38% { transform: scaleX(.84) translateX(-7px) rotate(-4deg); } 50% { transform: scaleX(1) translateX(0) rotate(0); } 62% { transform: scaleX(.84) translateX(7px) rotate(4deg); } 88% { transform: scaleX(.84) translateX(7px) rotate(4deg); } }
  @keyframes twistHead { 0%, 100% { transform: scaleX(1) rotate(0); } 12% { transform: scaleX(.7) translateX(-9px) rotate(-9deg); } 38% { transform: scaleX(.7) translateX(-9px) rotate(-9deg); } 50% { transform: scaleX(1) rotate(0); } 62% { transform: scaleX(.7) translateX(9px) rotate(9deg); } 88% { transform: scaleX(.7) translateX(9px) rotate(9deg); } }
  @keyframes twistL { 0%, 100% { transform: rotate(10deg) scaleX(1); } 12% { transform: rotate(-6deg) scaleX(1.5) translateX(4px); } 38% { transform: rotate(-8deg) scaleX(1.55) translateX(4px); } 50% { transform: rotate(10deg) scaleX(1); } 62% { transform: rotate(34deg) scaleX(1.25); } 88% { transform: rotate(36deg) scaleX(1.3); } }
  @keyframes twistR { 0%, 100% { transform: rotate(-10deg) scaleX(1); } 12% { transform: rotate(-34deg) scaleX(1.25); } 38% { transform: rotate(-36deg) scaleX(1.3); } 50% { transform: rotate(-10deg) scaleX(1); } 62% { transform: rotate(6deg) scaleX(1.5) translateX(-4px); } 88% { transform: rotate(8deg) scaleX(1.55) translateX(-4px); } }
  @keyframes bendBody { 0%, 100% { transform: rotate(0) skewX(0); } 14% { transform: rotate(13deg) skewX(-6deg); } 38% { transform: rotate(15deg) skewX(-7deg); } 50% { transform: rotate(0) skewX(0); } 64% { transform: rotate(-13deg) skewX(6deg); } 88% { transform: rotate(-15deg) skewX(7deg); } }
  @keyframes bendHead { 0%, 100% { transform: rotate(0); } 14% { transform: rotate(9deg) translateX(4px); } 38% { transform: rotate(11deg) translateX(5px); } 50% { transform: rotate(0); } 64% { transform: rotate(-9deg) translateX(-4px); } 88% { transform: rotate(-11deg) translateX(-5px); } }
  @keyframes bendL { 0%, 100% { transform: rotate(14deg) scaleX(1); } 14% { transform: rotate(66deg) scaleX(1.45); } 38% { transform: rotate(72deg) scaleX(1.55); } 50% { transform: rotate(14deg) scaleX(1); } 64% { transform: rotate(-20deg) scaleX(1.05); } 88% { transform: rotate(-24deg) scaleX(1.1); } }
  @keyframes bendR { 0%, 100% { transform: rotate(-14deg) scaleX(1); } 14% { transform: rotate(20deg) scaleX(1.05); } 38% { transform: rotate(24deg) scaleX(1.1); } 50% { transform: rotate(-14deg) scaleX(1); } 64% { transform: rotate(-66deg) scaleX(1.45); } 88% { transform: rotate(-72deg) scaleX(1.55); } }
  @keyframes clapL { 0%, 100% { transform: rotate(178deg) scaleX(1.2); } 50% { transform: rotate(182deg) scaleX(1.82); } }
  @keyframes clapR { 0%, 100% { transform: rotate(-176deg) scaleX(1.28); } 50% { transform: rotate(-180deg) scaleX(1.9); } }
  @keyframes wiggle { 0%, 100% { transform: rotate(-4deg) translateY(0); } 50% { transform: rotate(4deg) translateY(-4px); } }
  @keyframes sparkk { 0%, 100% { opacity: 0; transform: scale(.3) rotate(0); } 45% { opacity: 1; transform: scale(1.15) rotate(75deg); } }
  @keyframes zzzk { 0% { opacity: 0; transform: translate(0, 0) scale(.5); } 25% { opacity: 1; } 100% { opacity: 0; transform: translate(16px, -30px) scale(1.15); } }
  @keyframes clouddrift { from { transform: translateX(-14px); } to { transform: translateX(16px); } }
  /* ---- accessory motion (worn, not pasted on) ---- */
  @keyframes accwob { 0%, 100% { transform: rotate(-3deg) translateY(0); } 50% { transform: rotate(3deg) translateY(-1.5px); } }
  @keyframes leafsway { 0%, 100% { transform: rotate(-6deg); } 50% { transform: rotate(6deg); } }
  @keyframes crownshine { 0%, 100% { opacity: .25; } 50% { opacity: .85; } }
  @keyframes ringk { 0%, 100% { transform: rotate(-4deg); } 12% { transform: rotate(5deg); } 24% { transform: rotate(-4deg); } 36% { transform: rotate(4deg); } 48%, 99% { transform: rotate(0); } }
  @keyframes lotusbreath { 0%, 100% { transform: scale(1) rotate(-1.5deg); } 50% { transform: scale(1.035) rotate(1.5deg); } }
  @keyframes heartpop { 0%, 100% { transform: scale(1) rotate(-5deg); } 50% { transform: scale(1.14) rotate(5deg); } }
  @keyframes dropk { 0% { opacity: 0; transform: translateY(-6px) scale(.7); } 30% { opacity: 1; } 100% { opacity: 0; transform: translateY(20px) scale(1.05); } }
  @keyframes glowk { 0%, 100% { opacity: .5; } 50% { opacity: 1; } }
  @keyframes earflop { 0%, 100% { transform: rotate(-4deg); } 50% { transform: rotate(5deg); } }
  @keyframes catbreath { 0%, 100% { transform: scale(1, 1); } 50% { transform: scale(1.02, .97); } }
  @keyframes pomswing { 0%, 100% { transform: rotate(-13deg); } 50% { transform: rotate(13deg); } }

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
  .window-scene, .sill, .ledge, .mug, .sparkles, .zzz, .eyes-happy, .eyes-sleep, .eyes-heart { display: none; }
  ${SKIN_LAYERS.map((s) => `.skin-${s}`).join(', ')} { display: none; }
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
  /* class names use the exercise ids from exercises.json (upper-trap / thoracic-twist / side-bend),
     not the design tool's shorter internal names (trap / twist / sidebend) — the keyframes
     above keep those names since they're just animation identifiers, not tied to a
     specific pose id. */
  .pose-upper-trap .gbody { animation: trapBody 6s ease-in-out infinite; }
  .pose-upper-trap .ghead { animation: trapHead 6s ease-in-out infinite; }
  .pose-upper-trap .arm-l { transform: none; animation: trapL 6s ease-in-out infinite; }
  .pose-upper-trap .arm-r { transform: none; animation: trapR 6s ease-in-out infinite; }
  .pose-chest-opener .arm-l { transform: rotate(46deg); }
  .pose-chest-opener .arm-r { transform: rotate(-46deg); }
  .pose-chest-opener .gbody { animation: openup 2.4s ease-in-out infinite; }
  .pose-reach .arm-l { transform: none; animation: reachL 2.2s ease-in-out infinite; }
  .pose-reach .arm-r { transform: none; animation: reachR 2.2s ease-in-out infinite; }
  .pose-reach .gbody { animation: stretchup 2.2s ease-in-out infinite; }
  .pose-thoracic-twist .gbody { animation: twistBody 6s ease-in-out infinite; }
  .pose-thoracic-twist .ghead { animation: twistHead 6s ease-in-out infinite; }
  .pose-thoracic-twist .arm-l { transform: none; animation: twistL 6s ease-in-out infinite; }
  .pose-thoracic-twist .arm-r { transform: none; animation: twistR 6s ease-in-out infinite; }
  .pose-thoracic-twist .eyes { transform: translate(0, -1px); }
  .pose-side-bend .gbody { animation: bendBody 6s ease-in-out infinite; }
  .pose-side-bend .ghead { animation: bendHead 6s ease-in-out infinite; }
  .pose-side-bend .arm-l { transform: none; animation: bendL 6s ease-in-out infinite; }
  .pose-side-bend .arm-r { transform: none; animation: bendR 6s ease-in-out infinite; }
  .pose-clap .arm-l { transform: none; animation: clapL .7s ease-in-out infinite; }
  .pose-clap .arm-r { transform: none; animation: clapR .7s ease-in-out infinite; }
  .pose-clap .gbody { animation: wiggle 1.4s ease-in-out infinite; }
  .pose-clap .eyes-open { display: none; }
  .pose-clap .eyes-happy { display: block; }
  .pose-clap .sparkles { display: block; }

  /* ---- skins — accessories wobble independently behind the head bob so they feel
     worn rather than pasted on. Scoped to the nearest [data-skin] wrapper. ---- */
  .skin-sprout { transform-origin: 106px 44px; animation: accwob 4.4s ease-in-out infinite; }
  .leaf-sway { transform-origin: 106px 28px; animation: leafsway 3.6s ease-in-out infinite; }
  .skin-phones { transform-origin: 104px 80px; animation: accwob 6.2s ease-in-out infinite; }
  .skin-crown { transform-origin: 106px 56px; animation: accwob 5.2s ease-in-out infinite; }
  .crown-shine { animation: crownshine 3s ease-in-out infinite; }
  ${SKIN_LAYERS.map((s) => `[data-skin="${s}"] .skin-${s} { display: block; }`).join('\n  ')}
  /* Sweetheart swaps the eyes rather than adding a hat — except while asleep. */
  [data-skin="valentine"] .eyes-open, [data-skin="valentine"] .eyes-happy { display: none; }
  [data-skin="valentine"] .eyes-heart { display: block; }
  /* Compound (no space) selectors — every ghost wrapper carries its pose class and its
     data-skin on the SAME element (see content.ts), never as ancestor/descendant, so
     the flop override below has to match same-element too or it silently never fires
     and a napping Valentine ghost shows heart-eyes and sleep-eyes at once. */
  [data-skin="valentine"].pose-flop .eyes-heart { display: none; }
  [data-skin="valentine"].pose-flop .eyes-sleep { display: block; }
`;
