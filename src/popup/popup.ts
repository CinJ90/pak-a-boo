import '../popup/style.css';
import { CHARACTER_REGISTRY, DEFAULT_SETTINGS, isStreakAlive, localDateStr, normalizeStreak, type Character, type SchedulerState, type Settings, type Skin, type StreakState } from '../types';
import { COLLECTABLE, STREAK_MILESTONES, effectiveUnlocked, normalizeCounters, resolveDefaultLook, rollCounters, screenMsSoFar, skinDef, type Counters } from '../skins';

type Lang = Settings['language'];

const COPY = {
  en: {
    tagline: (charName: string) => `${charName} will make you Pak (rest).`,
    nextPeek: 'NEXT PEEK',
    focusEnds: 'FOCUS ENDS IN',
    bodyThanks: 'Your body will thank you.',
    focusOn: 'Focus for 1 hour',
    focusOff: 'Cancel focus',
    turnOff: 'Turn off',
    turnOn: 'Turn on',
    breaksToday: 'breaks today',
    screenTimeToday: 'screen time today',
    onSchedule: 'On schedule',
    focusStatus: 'Focus mode — breaks paused',
    offStatus: 'Off — no reminders',
    cocoa: 'Buy me a cocoa ☕',
    infoLink: 'Visit the Pak-a-boo website',
    resetCycle: 'Reset cycle',
    streakCaption: (n: number, daysToNext: number | null) => {
      if (n === 0) return 'Start a streak!';
      if (daysToNext !== null) return `${daysToNext} ${daysToNext === 1 ? 'day' : 'days'} to next skin`;
      return 'day streak';
    },
    skinLocked: (n: number) => `Unlock at ${n}-day streak`,
    mystery: 'A secret look — keep resting to find it',
    streakHelp: 'How the streak works',
    streakHelpText: 'Counts days you actually worked. Days you’re away (weekends, holidays) don’t break it — only a working day with no breaks does.'
  },
  th: {
    tagline: (charName: string) => `${charName}คอยเตือนให้คุณได้พัก`,
    nextPeek: 'จะมาตามไปพักใน',
    focusEnds: 'ยกเลิกโฟกัสใน',
    bodyThanks: 'พักเพื่อสุขภาพของคุณ',
    focusOn: 'โฟกัส 1 ชั่วโมง',
    focusOff: 'ยกเลิกโฟกัส',
    turnOff: 'ปิดการเตือน',
    turnOn: 'เปิดการเตือน',
    breaksToday: 'พักแล้ววันนี้',
    screenTimeToday: 'เวลาหน้าจอวันนี้',
    onSchedule: 'โหมดปกติ',
    focusStatus: 'โหมดโฟกัส — พักหยุดชั่วคราว',
    offStatus: 'ปิดอยู่ — ไม่มีการเตือน',
    cocoa: 'เติมโกโก้ให้เรา ☕',
    infoLink: 'ไปที่เว็บไซต์ Pak-a-boo',
    resetCycle: 'รีเซ็ตรอบพัก',
    streakCaption: (n: number, daysToNext: number | null) => {
      if (n === 0) return 'เริ่มสตรีคกันเถอะ!';
      if (daysToNext !== null) return `อีก ${daysToNext} วัน ปลดล็อกสกินถัดไป`;
      return 'วันติดต่อกัน';
    },
    skinLocked: (n: number) => `ปลดล็อกที่สตรีค ${n} วัน`,
    mystery: 'สกินลับ ~ พักไปเรื่อย ๆ แล้วจะเจอ',
    streakHelp: 'สตรีคนับอย่างไร',
    streakHelpText: 'นับเฉพาะวันที่คุณทำงานจริง วันที่ไม่ได้ใช้งาน (เสาร์-อาทิตย์ วันหยุด) ไม่ทำให้สตรีคขาด — ขาดเฉพาะเมื่อทำงานทั้งวันแต่ไม่ได้พักเลย'
  }
} as const;

const countdown = document.querySelector('#countdown') as HTMLElement;
const breaks = document.querySelector('#breaks') as HTMLElement;
const screenTime = document.querySelector('#screen-time') as HTMLElement;
const screenTimeLabel = document.querySelector('#screen-time-label') as HTMLElement;
const status = document.querySelector('#status') as HTMLElement;
const focusBtn = document.querySelector('#focus') as HTMLButtonElement;
const powerBtn = document.querySelector('#power') as HTMLButtonElement;
const resetBtn = document.querySelector('#reset') as HTMLButtonElement;
const tagline = document.querySelector('#tagline') as HTMLElement;
const nextPeekLabel = document.querySelector('#next-peek-label') as HTMLElement;
const breakLabel = document.querySelector('#break-label') as HTMLElement;
const breaksLabel = document.querySelector('#breaks-label') as HTMLElement;
const cocoaLink = document.querySelector('#cocoa-link') as HTMLElement;
const infoLink = document.querySelector('#info-link') as HTMLElement;
const versionLabel = document.querySelector('#version') as HTMLElement;
const langButtons = document.querySelectorAll<HTMLButtonElement>('.lang-btn');
const streakCount = document.querySelector('#streak-count') as HTMLElement;
const streakCaption = document.querySelector('#streak-caption') as HTMLElement;
const streakDots = document.querySelectorAll<HTMLElement>('.streak-dot');
const streakHelp = document.querySelector('#streak-help') as HTMLButtonElement;
const characterButtons = document.querySelectorAll<HTMLButtonElement>('.character-btn');

// Ascending [skin, days] pairs (2/5/7 for sprout/phones/crown), derived from the
// registry rather than restated here, so the progress dots and the "days to next skin"
// hint can't drift from the unlock logic. Only STREAK unlocks belong on the dots — the
// legendary slot is counter-based and would otherwise miscount them.
const MILESTONES = [...STREAK_MILESTONES].sort((a, b) => a[1] - b[1]);
const MILESTONE_THRESHOLDS = MILESTONES.map(([, days]) => days);

const skinRow = document.querySelector('.skin-row') as HTMLElement;

// Flat accessory glyph, not the whole ghost — the buttons are ~19px and the accessory
// alone reads better at that size (and keeps the popup bundle small).
function icon(skin: Skin): string {
  const glyph = skinDef(skin)?.icon ?? '';
  return `<svg viewBox="0 0 24 24" width="19" height="19" aria-hidden="true">${glyph}</svg>`;
}

// Five slots, always. Slot 1 is Mr.Boo wearing whatever today resolved to (an event
// costume in season, else the most recent behaviour look); slots 2-4 are the streak
// ladder; slot 5 is the legendary, shown as "?" until earned so its existence is
// visible but its identity isn't.
//
// refresh() runs every second, so this must NOT unconditionally replace the row's
// innerHTML — a full replace destroys whatever DOM node currently has keyboard focus,
// which meant tabbing onto a skin button and it losing focus within a second, making
// the row impossible to operate by keyboard at all. Build the HTML and only touch the
// DOM when it actually differs from what's already there.
let lastSkinRowHtml = '';
function renderSkinRow(lang: Lang, selected: Skin, unlocked: readonly Skin[], counters: Counters, now: Date, charName: string): void {
  const c = COPY[lang];
  // Slot 1 is a live readout of today, not a stored selection — an event costume in
  // season, else the mood today's breaks have put the character in, else the plain sheet.
  const defaultLook = resolveDefaultLook(counters, now);
  const cells = [
    { id: 'none' as Skin, look: defaultLook, unlockedHere: true, title: skinDef(defaultLook)?.label[lang](charName) ?? '' },
    ...COLLECTABLE.map((def) => {
      const has = unlocked.includes(def.id);
      const streakDays = MILESTONES.find(([id]) => id === def.id)?.[1];
      return {
        id: def.id,
        look: has ? def.id : def.kind === 'legendary' ? null : def.id,
        unlockedHere: has,
        title: has
          ? def.label[lang](charName)
          : def.kind === 'legendary'
            ? (def.hint?.[lang](charName) ?? c.mystery)
            : streakDays !== undefined ? c.skinLocked(streakDays) : ''
      };
    })
  ];
  const html = cells.map((cell) => {
    const active = cell.id === selected;
    const body = cell.look === null ? '<span class="skin-mystery">?</span>' : icon(cell.look);
    return `<button type="button" class="skin-btn${active ? ' active' : ''}" data-skin="${cell.id}"` +
      `${cell.unlockedHere ? '' : ' disabled'} aria-pressed="${active}" title="${cell.title}" aria-label="${cell.title}">${body}</button>`;
  }).join('');
  if (html === lastSkinRowHtml) return;
  lastSkinRowHtml = html;
  skinRow.innerHTML = html;
}

async function refresh(): Promise<void> {
  const { scheduler, sessionInProgressUntil, streak: rawStreak, counters: rawCounters } = await chrome.storage.local.get(['scheduler', 'sessionInProgressUntil', 'streak', 'counters']) as { scheduler?: SchedulerState; sessionInProgressUntil?: number; streak?: Partial<StreakState>; counters?: Partial<Counters> };
  const settings = { ...DEFAULT_SETTINGS, ...(await chrome.storage.sync.get(DEFAULT_SETTINGS)) } as Settings;
  // Guards against a value from an older/foreign build this version doesn't recognize
  // (e.g. a stale 'bean' left over from before the Buggy rename) — falls back to the
  // default rather than leaving every character button unhighlighted and the tagline
  // naming a character that no longer exists. content.ts guards the same way in
  // getCharacter(); this is the popup's own read of the same storage key.
  if (!CHARACTER_REGISTRY.some((d) => d.id === settings.character)) settings.character = DEFAULT_SETTINGS.character;
  const lang: Lang = settings.language;
  const c = COPY[lang];
  document.documentElement.lang = lang;
  const charName = CHARACTER_REGISTRY.find((d) => d.id === settings.character)?.label[lang] ?? settings.character;

  tagline.textContent = c.tagline(charName);
  breakLabel.textContent = c.bodyThanks;
  breaksLabel.textContent = c.breaksToday;
  screenTimeLabel.textContent = c.screenTimeToday;
  cocoaLink.textContent = c.cocoa;
  // Icon-only link — the label lives in aria-label/title, same pattern as streakHelp below.
  infoLink.setAttribute('aria-label', c.infoLink);
  infoLink.title = c.infoLink;
  // Read straight from the manifest so this can't drift from the shipped version again.
  versionLabel.textContent = `v${chrome.runtime.getManifest().version}`;
  powerBtn.textContent = settings.enabled ? c.turnOff : c.turnOn;
  resetBtn.setAttribute('aria-label', c.resetCycle);
  resetBtn.title = c.resetCycle;
  // The explanation lives in the tooltip; the label names the button for screen readers.
  streakHelp.setAttribute('aria-label', c.streakHelp);
  streakHelp.title = c.streakHelpText;
  langButtons.forEach((btn) => btn.classList.toggle('active', btn.dataset.lang === lang));
  characterButtons.forEach((btn) => {
    const def = CHARACTER_REGISTRY.find((d) => d.id === btn.dataset.character);
    btn.textContent = def?.label[lang] ?? '';
    btn.classList.toggle('active', btn.dataset.character === settings.character);
  });

  // Streak/skins are independent of the schedule state (on/off/focus) and every
  // early-return branch below, so render them before any of those returns.
  // The stored streak only resets lazily (on the background's next active-day roll),
  // so gate the DISPLAYED value on isStreakAlive: it's dead once an active day before
  // today ended with no completion. Inactive days (weekend, holiday) don't count
  // against it. Unlocks are permanent and unaffected by this.
  const now = new Date();
  const streak = normalizeStreak(rawStreak, localDateStr(now));
  // The "day in progress" is the pending break's own date when one has been shown
  // (breakDueDate) — so a break peeked at 23:59 and not yet taken keeps the streak
  // looking alive at 00:01, matching the day the background will credit it to.
  const openDate = scheduler?.breakDueDate ?? localDateStr(now);
  const currentStreak = isStreakAlive(streak, openDate) ? streak.currentStreak : 0;
  // breaksToday never auto-resets in storage — it only advances via a genuine
  // completion, same as currentStreak above — so a scheduler doc left over from
  // before today's first background event (reload, pause/resume, etc.) still shows
  // yesterday's count until breaksTodayDate says otherwise.
  const todaysBreaks = scheduler && scheduler.breaksTodayDate === localDateStr(now) ? scheduler.breaksToday : 0;
  streakCount.textContent = String(currentStreak);
  // Rolled at read time so the mood clears at local midnight even if the popup has
  // been sitting open (it re-renders once a second) and no background write has landed.
  // rollCounters settles an expired focus period itself (whether or not the day is
  // also turning over) — pre-settling here would let a cross-midnight roll discard
  // whatever got folded into the wrong (old) day's total; see its own comment.
  const counters = rollCounters(normalizeCounters(rawCounters), localDateStr(now), now.getTime());
  // Live, not just what's settled in storage — a segment still running (the ordinary
  // case whenever this popup is open) contributes its elapsed time too, same as the
  // countdown below recomputes from nextBreakAt every tick rather than waiting for a
  // background write.
  const screenMs = screenMsSoFar(counters, now.getTime());
  const screenHours = Math.floor(screenMs / 3_600_000);
  const screenMinutes = Math.floor((screenMs % 3_600_000) / 60_000);
  screenTime.textContent = screenHours > 0 ? `${screenHours}h ${screenMinutes}m` : `${screenMinutes}m`;
  // Stored unlocks UNIONED with whatever the counters already qualify for — see
  // effectiveUnlocked for why the stored list alone isn't enough.
  const unlocked = effectiveUnlocked(streak.unlockedSkins, streak.currentStreak, counters);
  // One dot per unlock milestone: filled once reached, pulsing on whichever is next
  // (the anticipation cue), plain otherwise.
  const nextIndex = MILESTONE_THRESHOLDS.findIndex((threshold) => currentStreak < threshold);
  // The caption's "N days to next skin" hint targets the first STILL-LOCKED skin, not
  // just the next threshold above currentStreak — unlocks are permanent (see
  // `unlocked` above) but the displayed streak isn't (it expires — see streakAlive),
  // so after a reset this must skip skins already owned rather than re-counting toward
  // one the user already has.
  const nextLockedMilestone = MILESTONES.find(([skin]) => !unlocked.includes(skin));
  const daysToNext = nextLockedMilestone ? Math.max(0, nextLockedMilestone[1] - currentStreak) : null;
  streakCaption.textContent = c.streakCaption(currentStreak, daysToNext);
  streakDots.forEach((dot, i) => {
    dot.classList.toggle('reached', currentStreak >= MILESTONE_THRESHOLDS[i]);
    dot.classList.toggle('current', i === nextIndex);
  });
  // The selection syncs across devices but unlocks are device-local, so a synced skin
  // this device hasn't earned shows the default slot as active instead — the same rule
  // the content script applies when rendering the ghost.
  const effectiveSkin: Skin =
    settings.skin !== 'none' && unlocked.includes(settings.skin) ? settings.skin : 'none';
  renderSkinRow(lang, effectiveSkin, unlocked, counters, now, charName);

  const focusActive = Boolean(settings.focusUntil && settings.focusUntil > Date.now());
  focusBtn.textContent = focusActive ? c.focusOff : c.focusOn;
  focusBtn.disabled = !settings.enabled;
  // Resetting only means something while breaks are actually on schedule — during focus
  // there's no live countdown to restart (resuming from focus already gives a fresh one),
  // and during an active break session the background refuses the reset anyway (it would
  // corrupt the cycle position under that session) — mirror that refusal here so the
  // click isn't a silent no-op.
  const sessionActive = typeof sessionInProgressUntil === 'number' && sessionInProgressUntil > Date.now();
  resetBtn.disabled = !settings.enabled || focusActive || sessionActive;

  function formatRemaining(untilMs: number): string {
    const remaining = Math.max(0, untilMs - Date.now());
    const minutes = Math.floor(remaining / 60_000).toString().padStart(2, '0');
    const seconds = Math.floor((remaining % 60_000) / 1_000).toString().padStart(2, '0');
    return `${minutes}:${seconds}`;
  }

  if (!settings.enabled) {
    nextPeekLabel.textContent = c.nextPeek;
    countdown.textContent = '--:--';
    status.textContent = c.offStatus;
    breaks.textContent = String(todaysBreaks);
    return;
  }
  breaks.textContent = String(todaysBreaks);
  if (focusActive && settings.focusUntil) {
    // While focus is active, the underlying scheduled break isn't going to fire —
    // showing a countdown toward it (which just freezes at 00:00 once it passes) is
    // confusing. Show time remaining in focus instead.
    nextPeekLabel.textContent = c.focusEnds;
    countdown.textContent = formatRemaining(settings.focusUntil);
    status.textContent = c.focusStatus;
    return;
  }
  nextPeekLabel.textContent = c.nextPeek;
  if (!scheduler) return;
  countdown.textContent = formatRemaining(scheduler.nextBreakAt);
  status.textContent = c.onSchedule;
}

powerBtn.addEventListener('click', async () => {
  const { enabled } = await chrome.storage.sync.get({ enabled: true }) as { enabled: boolean };
  await chrome.storage.sync.set({ enabled: !enabled });
  await refresh();
});
focusBtn.addEventListener('click', async () => {
  const { focusUntil } = await chrome.storage.sync.get('focusUntil') as { focusUntil?: number | null };
  const active = Boolean(focusUntil && focusUntil > Date.now());
  await chrome.storage.sync.set({ focusUntil: active ? null : Date.now() + 60 * 60_000 });
  await refresh();
});
resetBtn.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'RESET_CYCLE' });
  await refresh();
});
langButtons.forEach((btn) => {
  btn.addEventListener('click', async () => {
    await chrome.storage.sync.set({ language: btn.dataset.lang as Lang });
    await refresh();
  });
});
characterButtons.forEach((btn) => {
  btn.addEventListener('click', async () => {
    await chrome.storage.sync.set({ character: btn.dataset.character as Character });
    await refresh();
  });
});
skinRow.addEventListener('click', async (e) => {
  const btn = (e.target as HTMLElement).closest('.skin-btn') as HTMLButtonElement | null;
  if (!btn || btn.disabled) return;
  await chrome.storage.sync.set({ skin: btn.dataset.skin as Skin });
  await refresh();
});

void refresh();
setInterval(() => void refresh(), 1_000);
