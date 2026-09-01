// Shared with types.ts's normalizeStreak, which needs the exact same "coerce, don't
// reject" treatment for its own hand-editable integer fields — a type-only import goes
// the other way (types.ts re-exports Skin from here), so this stays a one-directional
// runtime dependency, not a cycle.
import { asCount } from './types';

// ---------------------------------------------------------------------------
// Skin registry — the single source of truth for what exists, how it unlocks, and
// where (if anywhere) it appears in the popup. Replaces the old flat
// `SKIN_MILESTONES: Record<Skin, number>` map, which could only express "unlock at N
// streak days" and had no way to say "on Oct 31" or "after 10 late-night breaks".
//
// The popup shows exactly FIVE buttons, forever:
//   1. Mr.Boo    — the default slot. What he actually WEARS is resolved at render time
//                  (see resolveDefaultLook): an event costume during its window, else
//                  the most recently earned behaviour look, else the plain sheet.
//   2..4. sprout / phones / crown — the streak ladder.
//   5. Orange Cat — legendary, 21 cumulative active days. Shows as "?" until earned.
// Behaviour and event skins deliberately have NO button of their own: they change who
// Mr.Boo is, rather than adding to a grid that would grow every release.
// ---------------------------------------------------------------------------

export type Skin =
  | 'none'
  // streak ladder
  | 'sprout' | 'phones' | 'crown'
  // legendary
  | 'cat'
  // behaviour (auto-worn in the Mr.Boo slot)
  | 'nightcap' | 'earlybird' | 'zen'
  // events (auto-worn in the Mr.Boo slot, in season)
  | 'pumpkin' | 'santa' | 'antlers' | 'party' | 'valentine' | 'bunny' | 'songkran';

export type SkinKind = 'default' | 'streak' | 'legendary' | 'behaviour' | 'event';

// Counters are plain integers in chrome.storage.local, derived from moments the
// extension already handles — no new observation, only new arithmetic. Deliberately
// NOT timestamped logs: someone inspecting storage should see a handful of small
// counts, no more revealing than the existing breaksToday. Local-only, never synced.
//
// Two lifetimes in one record:
//  - activeDaysTotal is CUMULATIVE and never resets — the legendary cat is "21 days you
//    showed up", which would be meaningless if it reset.
//  - the rest are TODAY's, stamped with `date` and zeroed on rollover (the same
//    pattern as breaksToday / breaksTodayDate). They drive Mr.Boo's mood, which is a
//    readout of how today has actually gone, not a badge earned once in October.
export interface Counters {
  activeDaysTotal: number;  // lifetime: days the ghost peeked at a present user
  date: string | null;      // local date the daily fields below belong to
  nightOwl: number;         // today: breaks completed 20:00–03:59
  earlyBird: number;        // today: breaks completed 04:00–07:59
  // Today's SETTLED focus time. Milliseconds actually spent in focus mode, not a count
  // of starts: starting focus is one click with no cooldown, so counting starts made
  // Zen Boo both unreachable honestly (10 sessions ≈ 10 hours) and trivially gameable
  // (start, cancel, repeat). Time only accrues while focus is genuinely running.
  focusMs: number;
  // The focus period currently in flight, if any. Its elapsed time is added to focusMs
  // when it ends — on cancel (a storage event) or on expiry (settled lazily, since
  // nothing fires when focusUntil simply passes).
  focusStartedAt: number | null;
  focusEndsAt: number | null;
  // Which mood was most recently satisfied today, and roughly when. Both can be met in
  // one day (early starts AND a late night) — the later one wins, so the ghost tracks
  // the day as it unfolds rather than freezing on whichever the registry lists first.
  // `lastMoodAt` exists so a MOOD THAT'S STILL RUNNING (Zen, mid-focus-session) can be
  // compared against one that was recorded by an actual event (nightOwl/earlyBird,
  // recorded the instant a break completes) — see zenCrossedAt / activeMood.
  lastMood: Skin | null;
  lastMoodAt: number | null;
  // Today's SETTLED screen time (ms) — accumulated `chrome.idle` "active" time, banked
  // the moment an idle/locked transition closes the segment. Same open-segment shape as
  // focusMs/focusStartedAt above, except this one is driven by idle transitions instead
  // of the user's own focus toggle, and never bounded by a planned end time.
  screenMs: number;
  // Anchor of the screen-time segment currently in flight, if the user is demonstrably
  // at the machine right now (per chrome.idle); null while idle/locked. Read-time
  // callers add `now - screenActiveSince` to screenMs for a live total — see
  // screenMsSoFar — rather than mutating storage on every popup refresh.
  screenActiveSince: number | null;
}

export const DEFAULT_COUNTERS: Counters = {
  activeDaysTotal: 0,
  date: null,
  nightOwl: 0,
  earlyBird: 0,
  focusMs: 0,
  focusStartedAt: null,
  focusEndsAt: null,
  lastMood: null,
  lastMoodAt: null,
  screenMs: 0,
  screenActiveSince: null
};

/** Breaks taken in these hours are what the ghost reads as a late night / early start. */
export const NIGHT_OWL_FROM_HOUR = 20;
export const NIGHT_OWL_UNTIL_HOUR = 4;   // wraps midnight: 20:00–03:59
export const EARLY_BIRD_FROM_HOUR = 4;
export const EARLY_BIRD_UNTIL_HOUR = 8;  // 04:00–07:59
/** Breaks needed inside the night / early window for that mood to show today. */
export const MOOD_BREAK_THRESHOLD = 2;
/** Focus time needed today for Zen Boo — real minutes in focus mode, not clicks. */
export const MOOD_FOCUS_MS = 90 * 60_000;

/**
 * Which daily counter a break completed at this hour feeds, if any. Night wraps past
 * midnight deliberately: someone finishing a break at 01:00 is up late, not up early —
 * reading the raw hour would have credited them as an early bird.
 */
export function moodCounterForHour(hour: number): 'nightOwl' | 'earlyBird' | null {
  if (hour >= NIGHT_OWL_FROM_HOUR || hour < NIGHT_OWL_UNTIL_HOUR) return 'nightOwl';
  if (hour >= EARLY_BIRD_FROM_HOUR && hour < EARLY_BIRD_UNTIL_HOUR) return 'earlyBird';
  return null;
}

export function normalizeCounters(raw: Partial<Counters> | undefined): Counters {
  const date = typeof raw?.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.date) ? raw.date : null;
  return {
    activeDaysTotal: asCount(raw?.activeDaysTotal),
    date,
    nightOwl: asCount(raw?.nightOwl),
    earlyBird: asCount(raw?.earlyBird),
    focusMs: asCount(raw?.focusMs),
    focusStartedAt: Number.isFinite(raw?.focusStartedAt) ? Number(raw?.focusStartedAt) : null,
    focusEndsAt: Number.isFinite(raw?.focusEndsAt) ? Number(raw?.focusEndsAt) : null,
    lastMood: typeof raw?.lastMood === 'string' ? (raw.lastMood as Skin) : null,
    lastMoodAt: Number.isFinite(raw?.lastMoodAt) ? Number(raw?.lastMoodAt) : null,
    screenMs: asCount(raw?.screenMs),
    screenActiveSince: Number.isFinite(raw?.screenActiveSince) ? Number(raw?.screenActiveSince) : null
  };
}

/**
 * Folds a finished focus period into today's total. Nothing fires when `focusUntil`
 * simply passes, so expiry is settled lazily here instead — every read goes through it.
 * Clamped to the period's own length so a clock jump can't mint focus time.
 *
 * Also the ONE place that stamps `lastMood`/`lastMoodAt` for Zen. A running period can
 * satisfy Zen "live" (see zenCrossedAt, used for display while it's still going) with
 * no event ever firing — but the moment it closes, `focusStartedAt` goes null and
 * there's nothing left to compute that crossing from. Every closure passes through
 * here — a plain read settling a naturally-expired period, or an explicit cancel that
 * reuses this function (see noteFocusChange) — so stamping it here is what makes
 * `lastMood` ever actually become `'zen'` at all, rather than only ever being
 * *displayable* live and never *recorded*.
 */
export function settleFocus(c: Counters, now: number): Counters {
  const { focusStartedAt: from, focusEndsAt: until } = c;
  if (from === null || until === null || until > now) return c;
  const elapsed = Math.max(0, Math.min(until, now) - from);
  const focusMs = c.focusMs + elapsed;
  let lastMood = c.lastMood;
  let lastMoodAt = c.lastMoodAt;
  const zen = skinDef('zen');
  // Only stamp if THIS closure is what crosses the threshold (guards against
  // recomputing/overwriting a crossing that already happened and was already stamped
  // earlier today, e.g. by an unrelated later period).
  if (zen && zen.unlock.type === 'focusTime' && c.focusMs < zen.unlock.minMs && focusMs >= zen.unlock.minMs) {
    const crossedAt = from + (zen.unlock.minMs - c.focusMs);
    if (crossedAt <= now && crossedAt >= (lastMoodAt ?? -Infinity)) {
      lastMood = 'zen';
      lastMoodAt = crossedAt;
    }
  }
  return { ...c, focusMs, focusStartedAt: null, focusEndsAt: null, lastMood, lastMoodAt };
}

/**
 * Today's focus time INCLUDING a period still running, so Zen Boo can appear partway
 * through a session rather than only once it ends.
 */
export function focusMsSoFar(c: Counters, now: number): number {
  const settled = settleFocus(c, now);
  const running = settled.focusStartedAt !== null ? Math.max(0, now - settled.focusStartedAt) : 0;
  return settled.focusMs + running;
}

/** Opens a screen-time segment. Idempotent — a second 'active' transition while one is
 *  already running (shouldn't happen, but chrome.idle gives no hard guarantee against a
 *  duplicate) must not reanchor it and lose the time already elapsed. */
export function openScreenSegment(c: Counters, now: number): Counters {
  return c.screenActiveSince !== null ? c : { ...c, screenActiveSince: now };
}

/** Closes a screen-time segment, banking its elapsed time into screenMs. Idempotent — a
 *  second closing transition (idle -> locked, both closing) with nothing open is a
 *  no-op rather than banking a negative/duplicate span. */
export function closeScreenSegment(c: Counters, now: number): Counters {
  if (c.screenActiveSince === null) return c;
  return { ...c, screenMs: c.screenMs + Math.max(0, now - c.screenActiveSince), screenActiveSince: null };
}

/**
 * Today's screen time INCLUDING a segment still running, so the popup's live number
 * moves every second without a background write on every refresh — same shape as
 * focusMsSoFar above.
 */
export function screenMsSoFar(c: Counters, now: number): number {
  const running = c.screenActiveSince !== null ? Math.max(0, now - c.screenActiveSince) : 0;
  return c.screenMs + running;
}

// The local-midnight epoch that starts a 'YYYY-MM-DD' date. Parsed as components (not
// `new Date(dateStr)`, which reads a bare date as UTC) so this lines up with every
// other local-date computation in the app.
function localMidnight(dateStr: string): number {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
}

/**
 * The single correct way to bring a stored Counters record up to date for `todayStr`/
 * `now`: an ordinary same-day read just settles any expired focus period; a day
 * turning over resets the daily fields AND — if a period was running (or had just
 * ended) exactly as it did — splits that period at the actual local-midnight boundary.
 *
 * The split matters: naively settling first and rolling second (what this used to do)
 * discards whatever the settle folded into the OLD day's focusMs, silently losing every
 * minute the session ran on the new side of midnight. Naively re-anchoring the period's
 * start to whatever instant happens to call this is just as wrong the other way — the
 * total then depends on WHEN it's read, and a tab reading at 00:05 vs the background
 * reading at 00:40 would disagree about how much of the new day's focus is banked. A
 * ≤60-minute focus period can straddle at most one midnight, so only the immediate
 * next day ever needs the split; a multi-day gap (laptop closed for a week) rolls
 * straight past it — the period ended long before the new day's midnight, so nothing
 * carries, same as any other stale daily count.
 */
export function rollCounters(c: Counters, todayStr: string, now: number = Date.now()): Counters {
  if (c.date === todayStr) return settleFocus(c, now);
  if (c.date !== null && todayStr < c.date) {
    // The local date moved backward — westward travel (the day repeats) or the system
    // clock got corrected. Unlike the streak (which must never roll back a real
    // accomplishment), these are just today's mood readout: leaving them stamped on a
    // date that, from here, hasn't happened yet would freeze today's mood on whatever
    // "tomorrow" last showed until the calendar catches back up. Reset the daily
    // fields to the earlier date, same as an ordinary rollover; activeDaysTotal
    // (cumulative, never day-scoped) is untouched. Any focus period recorded under the
    // now-future date is dropped rather than banked — it belongs to a day that, from
    // this vantage point, is still ahead.
    return { ...DEFAULT_COUNTERS, activeDaysTotal: c.activeDaysTotal, date: todayStr };
  }
  const midnight = localMidnight(todayStr);
  let focusMs = 0;
  let focusStartedAt: number | null = null;
  let focusEndsAt: number | null = null;
  if (c.focusStartedAt !== null && c.focusEndsAt !== null && c.focusEndsAt > midnight) {
    const carryFrom = Math.max(c.focusStartedAt, midnight);
    if (c.focusEndsAt <= now) {
      // Already elapsed by "now" — bank just the post-midnight share as today's
      // opening total. (No Zen-stamp check here: the carried fragment is at most one
      // session's length, well under the threshold on its own, and the OLD day it also
      // touched is being discarded anyway — there's no one left to celebrate it for.)
      focusMs = Math.max(0, c.focusEndsAt - carryFrom);
    } else {
      // Still running — keep it open, anchored at the boundary it crossed rather than
      // at whatever moment happens to be reading this.
      focusStartedAt = carryFrom;
      focusEndsAt = c.focusEndsAt;
    }
  }
  // A screen-time segment has no planned end (unlike focus's focusEndsAt), so unlike
  // the split above there's no "already elapsed by now" case to bank early — it's
  // always still running here, just possibly anchored before today. Reanchor it at the
  // boundary it crossed, same reasoning as the focus carry: the OLD day's share is
  // being discarded anyway (screenMs resets below), so only the post-midnight portion
  // is banked whenever this segment eventually closes.
  const screenActiveSince = c.screenActiveSince !== null ? Math.max(c.screenActiveSince, midnight) : null;
  // activeDaysTotal is carried through untouched via the spread — it's the one
  // cumulative field, unaffected by which day's record this is.
  return { ...c, date: todayStr, nightOwl: 0, earlyBird: 0, focusMs, focusStartedAt, focusEndsAt, screenMs: 0, screenActiveSince, lastMood: null, lastMoodAt: null };
}

// 'MM-DD'..'MM-DD'; `to` before `from` means the window wraps the new year.
export interface DateWindow { from: string; to: string }

export type Unlock =
  | { type: 'always' }
  | { type: 'streak'; days: number }              // consecutive active days
  | { type: 'counter'; key: 'activeDaysTotal'; min: number }   // cumulative, permanent
  | { type: 'daily'; key: 'nightOwl' | 'earlyBird'; min: number }
  | { type: 'focusTime'; minMs: number }                       // today's focus minutes
  | { type: 'window'; window: DateWindow }        // event — never "earned", just in season
  | { type: 'easter'; padBefore: number; padAfter: number };

export interface SkinDef {
  id: Skin;
  kind: SkinKind;
  /** Display name, as a function of the current character's display name (Boo/Blob/
   *  Buggy). The default slot and every behaviour/event skin are named after whoever's
   *  wearing them ("Sleepy Boo" -> "Sleepy Blob"); the streak-ladder and legendary item
   *  skins don't reference the character and ignore the argument. */
  label: { en: (charName: string) => string; th: (charName: string) => string };
  /** How it's earned, shown as the locked tooltip / hint. Same character-name shape as
   *  label above. */
  hint?: { en: (charName: string) => string; th: (charName: string) => string };
  unlock: Unlock;
  /** Flat 24x24 accessory glyph for the popup buttons — the accessory alone, not the
   *  whole ghost, so the row stays readable at ~19px. The mascot itself is drawn from
   *  the shared rig (ghost.ts); these are only the picker's icons. */
  icon: string;
}

// Order matters twice over: the streak ladder renders in this order, and for events the
// FIRST matching window wins — so narrow windows (Christmas week, New Year) must be
// listed before wide ones (all of December).
//
// Songkran is listed before Easter deliberately. Easter drifts and lands inside the
// Apr 13-15 Songkran window in 2028, 2031, 2036, 2047 and 2058; in those years Songkran
// takes the ghost, because Thai identity is this extension's differentiator and Easter
// is the more generic of the two.
export const SKIN_REGISTRY: SkinDef[] = [
  {
    id: 'none', kind: 'default',
    label: { en: (name) => name, th: (name) => name },
    unlock: { type: 'always' },
    icon: `<path d="M6 20 C6 10 8 4 12 4 C16 4 18 10 18 20 C18 21 17 21 16 20 C15 19 14 21 13 20 C12 19 11 21 10 20 C9 19 8 21 7 20 C6 21 6 21 6 20 Z" fill="#FBFFFC" stroke="#3E5750" stroke-width="1.6" stroke-linejoin="round"/><circle cx="9.5" cy="11" r="1.3" fill="#2B3A3C"/><circle cx="14.5" cy="11" r="1.3" fill="#2B3A3C"/>`
  },
  {
    id: 'sprout', kind: 'streak',
    label: { en: () => 'Sprout', th: () => 'ต้นอ่อน' },
    unlock: { type: 'streak', days: 2 },
    icon: `<path d="M12 17 C12 10 16 6 20 7 C19 12 16 16 12 17 Z" fill="#4F9C82" stroke="#3E5750" stroke-width="1.5" stroke-linejoin="round"/><path d="M12 17 C12 12 8 9 4 10 C5 14 8 16 12 17 Z" fill="#BFE3C7" stroke="#3E5750" stroke-width="1.5" stroke-linejoin="round"/><path d="M12 20 L12 17" stroke="#3E5750" stroke-width="1.5" stroke-linecap="round"/>`
  },
  {
    id: 'phones', kind: 'streak',
    label: { en: () => 'Headphones', th: () => 'หูฟัง' },
    unlock: { type: 'streak', days: 5 },
    icon: `<path d="M5 15 V11 a7 7 0 0 1 14 0 V15" fill="none" stroke="#3E5750" stroke-width="1.8" stroke-linecap="round"/><rect x="3.5" y="13" width="5" height="7" rx="2.2" fill="#ABB3B1" stroke="#3E5750" stroke-width="1.5"/><rect x="15.5" y="13" width="5" height="7" rx="2.2" fill="#ABB3B1" stroke="#3E5750" stroke-width="1.5"/>`
  },
  {
    id: 'crown', kind: 'streak',
    label: { en: () => 'Crown', th: () => 'มงกุฎ' },
    unlock: { type: 'streak', days: 7 },
    icon: `<path d="M4 16 L6 6 L10 11 L12 4 L14 11 L18 6 L20 16 Z" fill="#F3A93B" stroke="#3E5750" stroke-width="1.6" stroke-linejoin="round"/><circle cx="6" cy="6" r="1" fill="#3E5750"/><circle cx="12" cy="4" r="1.1" fill="#3E5750"/><circle cx="18" cy="6" r="1" fill="#3E5750"/>`
  },
  {
    id: 'cat', kind: 'legendary',
    label: { en: () => 'Orange Cat', th: () => 'แมวส้ม' },
    hint: { en: (name) => `Rest with ${name} on 21 different days`, th: (name) => `พักกับ${name}ให้ครบ 21 วัน` },
    unlock: { type: 'counter', key: 'activeDaysTotal', min: 21 },
    icon: `<path d="M6.5 9 L5.5 3.5 L10 6 Z" fill="#F0964B" stroke="#3E5750" stroke-width="1.5" stroke-linejoin="round"/><path d="M17.5 9 L18.5 3.5 L14 6 Z" fill="#F0964B" stroke="#3E5750" stroke-width="1.5" stroke-linejoin="round"/><path d="M4 13.5 C4 9.5 7.5 7.5 12 7.5 C16.5 7.5 20 9.5 20 13.5 C20 15.6 17 16.5 12 16.5 C7 16.5 4 15.6 4 13.5 Z" fill="#F0964B" stroke="#3E5750" stroke-width="1.6" stroke-linejoin="round"/><path d="M7.5 12 Q9 13.6 10.5 12" fill="none" stroke="#3E5750" stroke-width="1.4" stroke-linecap="round"/><path d="M13.5 12 Q15 13.6 16.5 12" fill="none" stroke="#3E5750" stroke-width="1.4" stroke-linecap="round"/><path d="M11 13.8 L13 13.8 L12 15 Z" fill="#E5AFAC" stroke="#3E5750" stroke-width="1"/>`
  },
  // ── behaviour ──────────────────────────────────────────────────────────────,
  // Each one celebrates the REST, never the vice: Sleepy Boo counts breaks you took,
  // late, not hours you worked late. Nothing here is earned by snoozing or skipping —,
  // the ghost never has a look that means "you've been bad".,
  {
    id: 'nightcap', kind: 'behaviour',
    label: { en: (name) => `Sleepy ${name}`, th: (name) => `${name}นอนดึก` },
    unlock: { type: 'daily', key: 'nightOwl', min: MOOD_BREAK_THRESHOLD },
    icon: `<path d="M4 15 C4 9 7.5 5.5 12 5.5 C15.4 5.5 18 7.5 19 10.5 L19 15 Z" fill="#8C93D8" stroke="#3E5750" stroke-width="1.6" stroke-linejoin="round"/><rect x="3" y="14" width="17" height="4" rx="2" fill="#FBFFFC" stroke="#3E5750" stroke-width="1.5"/><path d="M17 7 C20 5.5 22 7 21 9" fill="none" stroke="#8C93D8" stroke-width="2.2" stroke-linecap="round"/><circle cx="21" cy="10.5" r="2" fill="#FBFFFC" stroke="#3E5750" stroke-width="1.4"/>`
  },
  {
    id: 'earlybird', kind: 'behaviour',
    label: { en: () => 'Early Bird', th: (name) => `${name}ตื่นเช้า` },
    unlock: { type: 'daily', key: 'earlyBird', min: MOOD_BREAK_THRESHOLD },
    icon: `<circle cx="12" cy="13.5" r="6.5" fill="#FBFFFC" stroke="#3E5750" stroke-width="1.6"/><path d="M12 13.5 V9.5 M12 13.5 L15 15.5" fill="none" stroke="#3E5750" stroke-width="1.5" stroke-linecap="round"/><circle cx="6.5" cy="5.5" r="2.3" fill="#7FC3DC" stroke="#3E5750" stroke-width="1.5"/><circle cx="17.5" cy="5.5" r="2.3" fill="#7FC3DC" stroke="#3E5750" stroke-width="1.5"/><path d="M8.5 7.5 L10 9 M15.5 7.5 L14 9" stroke="#3E5750" stroke-width="1.5" stroke-linecap="round"/>`
  },
  {
    id: 'zen', kind: 'behaviour',
    label: { en: (name) => `Zen ${name}`, th: (name) => `${name}สมาธิ` },
    unlock: { type: 'focusTime', minMs: MOOD_FOCUS_MS },
    icon: `<path d="M12 17 C8.8 17 6.4 15 6 11.5 C9.2 11 11.4 13 12 17 Z" fill="#F6C8D8" stroke="#3E5750" stroke-width="1.4" stroke-linejoin="round"/><path d="M12 17 C15.2 17 17.6 15 18 11.5 C14.8 11 12.6 13 12 17 Z" fill="#F6C8D8" stroke="#3E5750" stroke-width="1.4" stroke-linejoin="round"/><path d="M12 17 C10.4 14 10.8 8.5 12 5.5 C13.2 8.5 13.6 14 12 17 Z" fill="#F6C8D8" stroke="#3E5750" stroke-width="1.4" stroke-linejoin="round"/><circle cx="12" cy="15" r="1.7" fill="#F3A93B" stroke="#3E5750" stroke-width="1.2"/>`
  },
  // ── events ─────────────────────────────────────────────────────────────────,
  {
    id: 'pumpkin', kind: 'event',
    label: { en: (name) => `Jack ${name}`, th: (name) => `${name}ฮาโลวีน` },
    unlock: { type: 'window', window: { from: '10-25', to: '11-01' } },
    icon: `<path d="M11 5.5 C11 3.8 12.6 3.2 13.6 4.4" fill="none" stroke="#4F9C82" stroke-width="1.8" stroke-linecap="round"/><ellipse cx="12" cy="14" rx="8" ry="5.8" fill="#E8842B" stroke="#3E5750" stroke-width="1.6"/><path d="M9 9.4 C8.1 11 8.1 17 9 18.6 M15 9.4 C15.9 11 15.9 17 15 18.6" fill="none" stroke="#C4661C" stroke-width="1.2" stroke-linecap="round"/><path d="M8.8 12 L11.2 12 L10 14.4 Z" fill="#FFD37A" stroke="#3E5750" stroke-width="1" stroke-linejoin="round"/><path d="M12.8 12 L15.2 12 L14 14.4 Z" fill="#FFD37A" stroke="#3E5750" stroke-width="1" stroke-linejoin="round"/>`
  },
  {
    id: 'party', kind: 'event',
    label: { en: (name) => `Party ${name}`, th: (name) => `${name}ปาร์ตี้` },
    unlock: { type: 'window', window: { from: '12-31', to: '01-02' } },
    icon: `<path d="M12 3.5 L18 17.5 L6 17.5 Z" fill="#E9668F" stroke="#3E5750" stroke-width="1.6" stroke-linejoin="round"/><path d="M8.6 14.5 H15.4 M10 10.5 H14" fill="none" stroke="#FBFFFC" stroke-width="1.5" stroke-linecap="round"/><circle cx="12" cy="3.5" r="2.1" fill="#F3A93B" stroke="#3E5750" stroke-width="1.3"/>`
  },
  {
    id: 'santa', kind: 'event',
    label: { en: (name) => `Santa ${name}`, th: (name) => `${name}ซานต้า` },
    unlock: { type: 'window', window: { from: '12-20', to: '12-26' } },
    icon: `<path d="M4 15 C4 9 7.5 5.5 12 5.5 C15.4 5.5 18 7.5 19 10.5 L19 15 Z" fill="#D6453C" stroke="#3E5750" stroke-width="1.6" stroke-linejoin="round"/><rect x="3" y="14" width="17" height="4" rx="2" fill="#FBFFFC" stroke="#3E5750" stroke-width="1.5"/><path d="M17 7 C20 5.5 22 7 21 9" fill="none" stroke="#D6453C" stroke-width="2.2" stroke-linecap="round"/><circle cx="21" cy="10.5" r="2" fill="#FBFFFC" stroke="#3E5750" stroke-width="1.4"/>`
  },
  {
    id: 'antlers', kind: 'event',
    label: { en: (name) => `Reindeer ${name}`, th: (name) => `${name}เรนเดียร์` },
    unlock: { type: 'window', window: { from: '12-01', to: '12-31' } },
    icon: `<path d="M9.5 18 C7.5 13 6 10.5 3.5 8.5 M6.5 11.5 C5 10 3.5 9.5 2.5 10 M8 14 C6.5 13 5 13.2 4 14.2 M14.5 18 C16.5 13 18 10.5 20.5 8.5 M17.5 11.5 C19 10 20.5 9.5 21.5 10 M16 14 C17.5 13 19 13.2 20 14.2" fill="none" stroke="#8A5A3B" stroke-width="1.8" stroke-linecap="round"/><circle cx="11" cy="8" r="1.6" fill="#D6453C" stroke="#3E5750" stroke-width="1.1"/><circle cx="13.6" cy="6.6" r="1.4" fill="#D6453C" stroke="#3E5750" stroke-width="1.1"/>`
  },
  {
    id: 'valentine', kind: 'event',
    label: { en: (name) => `Sweetheart ${name}`, th: (name) => `${name}วาเลนไทน์` },
    unlock: { type: 'window', window: { from: '02-13', to: '02-15' } },
    icon: `<path d="M8 16 C3.6 12.2 4.8 7.6 8 10.4 C11.2 7.6 12.4 12.2 8 16 Z" fill="#E0507E" stroke="#3E5750" stroke-width="1.4" stroke-linejoin="round"/><path d="M16 16 C11.6 12.2 12.8 7.6 16 10.4 C19.2 7.6 20.4 12.2 16 16 Z" fill="#E0507E" stroke="#3E5750" stroke-width="1.4" stroke-linejoin="round"/>`
  },
  {
    id: 'songkran', kind: 'event',
    label: { en: (name) => `Malai ${name}`, th: (name) => `${name}สงกรานต์` },
    unlock: { type: 'window', window: { from: '04-13', to: '04-15' } },
    icon: `<path d="M4 17 C4 10.4 7.6 6.5 12 6.5 C16.4 6.5 20 10.4 20 17" fill="none" stroke="#3E5750" stroke-width="4.6" stroke-linecap="round" stroke-dasharray="0.4 3.1" opacity=".35"/><path d="M4 17 C4 10.4 7.6 6.5 12 6.5 C16.4 6.5 20 10.4 20 17" fill="none" stroke="#FBFFFC" stroke-width="3.2" stroke-linecap="round" stroke-dasharray="0.4 3.1"/><circle cx="4" cy="17" r="1.9" fill="#F3A93B" stroke="#3E5750" stroke-width="1.2"/><circle cx="20" cy="17" r="1.9" fill="#F3A93B" stroke="#3E5750" stroke-width="1.2"/><circle cx="12" cy="5.6" r="1.7" fill="#E9668F" stroke="#3E5750" stroke-width="1.2"/>`
  },
  {
    id: 'bunny', kind: 'event',
    label: { en: (name) => `Spring ${name}`, th: (name) => `${name}อีสเตอร์` },
    unlock: { type: 'easter', padBefore: 2, padAfter: 1 },
    icon: `<path d="M9.6 17 C7.6 11 8.2 4.4 10.4 3.4 C12.4 2.9 12.9 8.6 11.6 17 Z" fill="#FBFFFC" stroke="#3E5750" stroke-width="1.5" stroke-linejoin="round"/><path d="M13.4 17 C14.6 11 16.8 5.4 18.8 5.4 C20.4 6 18.6 11.6 15.4 18 Z" fill="#FBFFFC" stroke="#3E5750" stroke-width="1.5" stroke-linejoin="round"/><path d="M10.4 13 C9.6 9 9.9 5.6 10.7 5.2" fill="none" stroke="#E5AFAC" stroke-width="1.6" stroke-linecap="round"/>`
  }
];

const byId = new Map(SKIN_REGISTRY.map((s) => [s.id, s]));
export function skinDef(id: Skin): SkinDef | undefined { return byId.get(id); }

/** The four earnable, collectable skins, in ladder order — the popup's buttons 2..5. */
export const COLLECTABLE = SKIN_REGISTRY.filter((s) => s.kind === 'streak' || s.kind === 'legendary');
/** Streak thresholds only — what the streak card's dots and "days to next" count toward. */
export const STREAK_MILESTONES = SKIN_REGISTRY
  .filter((s): s is SkinDef & { unlock: { type: 'streak'; days: number } } => s.unlock.type === 'streak')
  .map((s) => [s.id, s.unlock.days] as const);

// ---------------------------------------------------------------------------
// Dates — all offline. No calendar service, no network, consistent with the
// "nothing is ever sent anywhere" promise.
// ---------------------------------------------------------------------------

/** Anonymous Gregorian computus. Returns Easter Sunday for a local year. */
export function easterSunday(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);   // 3 = March, 4 = April
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(year, month - 1, day, 12);
}

function mmdd(d: Date): string {
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Inclusive on both ends; a `to` earlier than `from` wraps the year end. */
export function inWindow(w: DateWindow, date: Date): boolean {
  const today = mmdd(date);
  return w.from <= w.to
    ? today >= w.from && today <= w.to
    : today >= w.from || today <= w.to;
}

function inEaster(padBefore: number, padAfter: number, date: Date): boolean {
  const e = easterSunday(date.getFullYear());
  const from = new Date(e); from.setDate(from.getDate() - padBefore);
  const to = new Date(e); to.setDate(to.getDate() + padAfter);
  const t = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12).getTime();
  return t >= new Date(from.getFullYear(), from.getMonth(), from.getDate(), 12).getTime()
    && t <= new Date(to.getFullYear(), to.getMonth(), to.getDate(), 12).getTime();
}

/** The event costume in season today, if any. First match in registry order wins. */
export function activeEventSkin(date: Date): Skin | null {
  for (const s of SKIN_REGISTRY) {
    if (s.kind !== 'event') continue;
    if (s.unlock.type === 'window' && inWindow(s.unlock.window, date)) return s.id;
    if (s.unlock.type === 'easter' && inEaster(s.unlock.padBefore, s.unlock.padAfter, date)) return s.id;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Unlocking
// ---------------------------------------------------------------------------

/**
 * Every skin the user has now EARNED (streak ladder + legendary + behaviour). Event
 * costumes are never "earned" — they appear in season and go back in the closet, so
 * they're excluded here. Append-only by contract: callers merge this with what's
 * already stored and never remove, so an unlock is permanent.
 */
export function earnedSkins(streakDays: number, counters: Counters): Skin[] {
  const out: Skin[] = [];
  for (const s of SKIN_REGISTRY) {
    const u = s.unlock;
    if (u.type === 'streak' && streakDays >= u.days) out.push(s.id);
    else if (u.type === 'counter' && counters[u.key] >= u.min) out.push(s.id);
  }
  return out;
}

/** Moods whose condition today's counters already satisfy, in registry order. */
export function satisfiedMoods(counters: Counters, now: number = Date.now()): Skin[] {
  return SKIN_REGISTRY
    .filter((s) => (s.unlock.type === 'daily' && counters[s.unlock.key] >= s.unlock.min)
      || (s.unlock.type === 'focusTime' && focusMsSoFar(counters, now) >= s.unlock.minMs))
    .map((s) => s.id);
}

/**
 * When Zen's threshold was (or will be) crossed by a session that's simply still
 * running, computed directly from its start time — no event needs to fire exactly at
 * the crossing instant. Returns null if Zen isn't satisfied, or if it's satisfied purely
 * by already-banked time with nothing running right now — in which case `settleFocus`
 * already stamped `lastMood`/`lastMoodAt` itself, the moment that period closed.
 */
function zenCrossedAt(counters: Counters, now: number): number | null {
  const zen = skinDef('zen');
  if (!zen || zen.unlock.type !== 'focusTime') return null;
  // Settle first: a caller may pass counters with an EXPIRED but not-yet-settled
  // period, which must not be mistaken for "still running" here.
  const settled = settleFocus(counters, now);
  if (settled.focusStartedAt === null) return null; // nothing running right now
  if (settled.focusMs >= zen.unlock.minMs) return null; // already satisfied without this period
  const crossAt = settled.focusStartedAt + (zen.unlock.minMs - settled.focusMs);
  return crossAt <= now ? crossAt : null;
}

/**
 * The mood Mr.Boo is in right now, or null. When more than one is satisfied the most
 * recently reached wins.
 *
 * `lastMood`/`lastMoodAt` are set by `noteMood` the instant an EVENT crosses a
 * threshold (a break completes, focus is cancelled) — but Zen can also cross purely by
 * time passing during a session nobody interacts with, which no event observes. So Zen
 * gets a second, independent check here: if it's satisfied and its (computable)
 * crossing time is more recent than the recorded `lastMoodAt`, Zen wins even though no
 * write ever recorded that. This is what lets the ghost's mood update mid-session
 * instead of freezing on whichever mood was reached earlier in the day.
 */
export function activeMood(counters: Counters, now: number = Date.now()): Skin | null {
  const met = satisfiedMoods(counters, now);
  if (met.length === 0) return null;
  if (met.includes('zen')) {
    const crossedAt = zenCrossedAt(counters, now);
    if (crossedAt !== null && crossedAt >= (counters.lastMoodAt ?? -Infinity)) return 'zen';
  }
  if (counters.lastMood && met.includes(counters.lastMood)) return counters.lastMood;
  return met[met.length - 1];
}

/**
 * What the user effectively owns: everything ever stored, PLUS anything the current
 * streak and counters already qualify for.
 *
 * The stored array is the permanence record — it's what keeps sprout after a streak
 * resets to 0 — but it must not be the only source of truth for display, or a skin
 * stays invisible until the next event happens to run the unlock check. That gap bites
 * twice: a release that adds a skin whose threshold the user already passed wouldn't
 * show it until their next break, and hand-seeding a counter to test does nothing at
 * all. Deriving the union at read time closes both; the background still persists it.
 *
 * Stored order comes first so unlock ORDER survives — resolveDefaultLook depends on it.
 */
export function effectiveUnlocked(
  stored: readonly Skin[], streakDays: number, counters: Counters
): Skin[] {
  const out = [...stored];
  for (const id of earnedSkins(streakDays, counters)) if (!out.includes(id)) out.push(id);
  return out;
}

/**
 * What Mr.Boo wears in the default slot right now: an event costume in season, else
 * today's mood, else the plain sheet. Moods are NOT read from `unlockedSkins` — they
 * are a live readout of today, so they appear when earned and are gone tomorrow.
 * An event costume outranks a mood because it is the rarer, time-limited thing.
 */
export function resolveDefaultLook(counters: Counters, date: Date): Skin {
  return activeEventSkin(date) ?? activeMood(counters, date.getTime()) ?? 'none';
}

/**
 * The skin actually rendered. The default slot resolves to whatever Mr.Boo is wearing;
 * any other selection must be (a) earned on THIS device (unlocks are per-device) and
 * (b) an actually WEARABLE collectable — moods/events live in `unlockedSkins` too (as
 * their "seen once" ledger, see mergeUnlocks), but they're never selectable by id, so a
 * mood id sitting in `chrome.storage.sync.skin` (hand-edited storage, or a foreign
 * build that once let this happen) must fall back to the default slot rather than
 * being worn forever with no popup button showing it as active.
 */
export function displayedSkin(
  selected: Skin, unlocked: readonly Skin[], counters: Counters, date: Date
): Skin {
  const kind = skinDef(selected)?.kind;
  const selectable = kind === 'streak' || kind === 'legendary';
  if (selectable && unlocked.includes(selected)) return selected;
  return resolveDefaultLook(counters, date);
}
