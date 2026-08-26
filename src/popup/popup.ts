import '../popup/style.css';
import { DEFAULT_SETTINGS, SKIN_MILESTONES, isYesterday, localDateStr, type SchedulerState, type Settings, type Skin, type StreakState } from '../types';

type Lang = Settings['language'];

const COPY = {
  en: {
    tagline: 'Mr.Boo will make you Pak (rest).',
    nextPeek: 'NEXT PEEK',
    focusEnds: 'FOCUS ENDS IN',
    bodyThanks: 'Your body will thank you.',
    focusOn: 'Focus for 1 hour',
    focusOff: 'Cancel focus',
    turnOff: 'Turn off',
    turnOn: 'Turn on',
    breaksToday: 'breaks today',
    onSchedule: 'On schedule',
    focusStatus: 'Focus mode — breaks paused',
    offStatus: 'Off — no reminders',
    cocoa: 'Buy me a cocoa ☕',
    resetCycle: 'Reset cycle',
    streakCaption: (n: number) => (n === 0 ? 'Start a streak!' : 'day streak'),
    skinLocked: (n: number) => `Unlock at ${n}-day streak`
  },
  th: {
    tagline: 'Mr.Boo คอยเตือนให้คุณได้พัก',
    nextPeek: 'จะมาตามไปพักใน',
    focusEnds: 'ยกเลิกโฟกัสใน',
    bodyThanks: 'พักเพื่อสุขภาพของคุณ',
    focusOn: 'โฟกัส 1 ชั่วโมง',
    focusOff: 'ยกเลิกโฟกัส',
    turnOff: 'ปิดการเตือน',
    turnOn: 'เปิดการเตือน',
    breaksToday: 'พักแล้ววันนี้',
    onSchedule: 'โหมดปกติ',
    focusStatus: 'โหมดโฟกัส — พักหยุดชั่วคราว',
    offStatus: 'ปิดอยู่ — ไม่มีการเตือน',
    cocoa: 'เติมโกโก้ให้เรา ☕',
    resetCycle: 'รีเซ็ตรอบพัก',
    streakCaption: (n: number) => (n === 0 ? 'เริ่มสตรีคกันเถอะ!' : 'วันติดต่อกัน'),
    skinLocked: (n: number) => `ปลดล็อกที่สตรีค ${n} วัน`
  }
} as const;

const countdown = document.querySelector('#countdown') as HTMLElement;
const breaks = document.querySelector('#breaks') as HTMLElement;
const status = document.querySelector('#status') as HTMLElement;
const focusBtn = document.querySelector('#focus') as HTMLButtonElement;
const powerBtn = document.querySelector('#power') as HTMLButtonElement;
const resetBtn = document.querySelector('#reset') as HTMLButtonElement;
const tagline = document.querySelector('#tagline') as HTMLElement;
const nextPeekLabel = document.querySelector('#next-peek-label') as HTMLElement;
const breakLabel = document.querySelector('#break-label') as HTMLElement;
const breaksLabel = document.querySelector('#breaks-label') as HTMLElement;
const cocoaLink = document.querySelector('#cocoa-link') as HTMLElement;
const langButtons = document.querySelectorAll<HTMLButtonElement>('.lang-btn');
const streakCount = document.querySelector('#streak-count') as HTMLElement;
const streakCaption = document.querySelector('#streak-caption') as HTMLElement;
const streakDots = document.querySelectorAll<HTMLElement>('.streak-dot');
const skinButtons = document.querySelectorAll<HTMLButtonElement>('.skin-btn');

// Ascending unlock thresholds (currently 1/3/5) — derived from SKIN_MILESTONES rather
// than hardcoded again, so the streak-progress dots can't drift out of sync with the
// actual unlock logic in background.ts.
const MILESTONE_THRESHOLDS = Object.values(SKIN_MILESTONES).sort((a, b) => a - b);

async function refresh(): Promise<void> {
  const { scheduler, sessionInProgressUntil, streak } = await chrome.storage.local.get(['scheduler', 'sessionInProgressUntil', 'streak']) as { scheduler?: SchedulerState; sessionInProgressUntil?: number; streak?: StreakState };
  const settings = { ...DEFAULT_SETTINGS, ...(await chrome.storage.sync.get(DEFAULT_SETTINGS)) } as Settings;
  const lang: Lang = settings.language;
  const c = COPY[lang];
  document.documentElement.lang = lang;

  tagline.textContent = c.tagline;
  breakLabel.textContent = c.bodyThanks;
  breaksLabel.textContent = c.breaksToday;
  cocoaLink.textContent = c.cocoa;
  powerBtn.textContent = settings.enabled ? c.turnOff : c.turnOn;
  resetBtn.setAttribute('aria-label', c.resetCycle);
  resetBtn.title = c.resetCycle;
  langButtons.forEach((btn) => btn.classList.toggle('active', btn.dataset.lang === lang));

  // Streak/skins are independent of the schedule state (on/off/focus) and every
  // early-return branch below, so render them before any of those returns.
  // The stored streak only resets lazily (on the next completed break), so gate the
  // DISPLAYED value on recency: a streak is alive only if the last completion was
  // today or yesterday. Unlocks are permanent and unaffected by this.
  const now = new Date();
  const last = streak?.lastCompletedDate ?? null;
  const streakAlive = last !== null && (last === localDateStr(now) || isYesterday(last, now));
  const currentStreak = streakAlive ? (streak?.currentStreak ?? 0) : 0;
  streakCount.textContent = String(currentStreak);
  streakCaption.textContent = c.streakCaption(currentStreak);
  // One dot per unlock milestone: filled once reached, pulsing on whichever is next
  // (the anticipation cue), plain otherwise.
  const nextIndex = MILESTONE_THRESHOLDS.findIndex((threshold) => currentStreak < threshold);
  streakDots.forEach((dot, i) => {
    dot.classList.toggle('reached', currentStreak >= MILESTONE_THRESHOLDS[i]);
    dot.classList.toggle('current', i === nextIndex);
  });
  const unlocked = streak?.unlockedSkins ?? [];
  // The selection syncs across devices but unlocks are device-local, so a synced
  // skin this device hasn't earned falls back to showing 'none' as active — same
  // rule the content script applies when rendering the ghost.
  const effectiveSkin: Skin =
    settings.skin === 'none' || unlocked.includes(settings.skin) ? settings.skin : 'none';
  skinButtons.forEach((btn) => {
    const id = btn.dataset.skin as Skin;
    const isUnlocked = id === 'none' || unlocked.includes(id);
    btn.disabled = !isUnlocked;
    btn.title = isUnlocked ? '' : c.skinLocked(SKIN_MILESTONES[id as Exclude<Skin, 'none'>]);
    btn.classList.toggle('active', id === effectiveSkin);
  });

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
    if (scheduler) breaks.textContent = String(scheduler.breaksToday);
    return;
  }
  if (scheduler) breaks.textContent = String(scheduler.breaksToday);
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
skinButtons.forEach((btn) => {
  btn.addEventListener('click', async () => {
    if (btn.disabled) return;
    await chrome.storage.sync.set({ skin: btn.dataset.skin as Skin });
    await refresh();
  });
});

void refresh();
setInterval(() => void refresh(), 1_000);
