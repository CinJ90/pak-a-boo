export type BreakKind = 'micro' | 'big';

// Accessories, not recolors — same base ghost. What exists and how each one unlocks
// lives in skins.ts; re-exported here so the rest of the app keeps importing `Skin`
// from one place.
export type { Skin } from './skins';
import type { Skin } from './skins';

export interface Settings {
  microMinutes: number;
  bigMinutes: number;
  focusUntil: number | null;
  // Indefinite pause, distinct from focusUntil's timed one-hour pause — stays off until
  // the user explicitly turns it back on.
  enabled: boolean;
  language: 'en' | 'th';
  skin: Skin;
}

export interface SchedulerState {
  nextBreakAt: number;
  breakKind: BreakKind;
  cycleStep: number;
  snoozes: number;
  breaksToday: number;
  // Local calendar date (YYYY-MM-DD) breaksToday was last counted for. Lets any reader
  // tell "still today's count" apart from "stale count from before a day rollover" —
  // breaksToday itself never auto-resets (scheduleNext's callers just carry the old
  // value forward), so this is what actually detects the boundary.
  breaksTodayDate: string;
  lastBreakAt: number | null;
  // The interval (minutes) actually used to compute nextBreakAt. Lets reconcileSchedule
  // tell "settings changed since this was scheduled" apart from "just reloaded, nothing
  // changed" — the former should recompute, the latter must not wipe today's progress.
  scheduledMinutes: number;
  // Local date (YYYY-MM-DD) this break was first shown to the user; null until then.
  // A break BELONGS to that date for all streak accounting — marking the day active
  // and crediting its completion — so a break shown at 23:59 and completed at 00:01
  // counts toward the day it was shown, not the day after. Reset by every
  // scheduleNext(), since that always means a new break.
  breakDueDate: string | null;
}

// How long a break can sit unattended before it counts as STALE rather than ignored.
// Comfortably above the 10-minute re-nag interval so ordinary escalation never trips
// it, and far below the hours a sleeping machine racks up.
export const STALE_GRACE_MS = 15 * 60_000;

// A sleeping machine (or a suspended Chrome) fires every overdue alarm the instant it
// wakes. Without this the first thing you see on opening the laptop is a ghost already
// mid-escalation for a break that came due hours ago — an ambush, and the reason the
// morning ghost was often found flopped mid-screen.
//
// Measured from the last time we actually ACTED on the break (`lastBreakAt`, set on
// every nag) and only falling back to `nextBreakAt` before the first nag. Measuring
// from nextBreakAt alone would be wrong: it stays put across re-nags, so a perfectly
// normal escalation would look stale after half an hour of the user ignoring it.
export function isStaleBreak(s: SchedulerState, now = Date.now()): boolean {
  return now - (s.lastBreakAt ?? s.nextBreakAt) > STALE_GRACE_MS;
}

export const DEFAULT_SETTINGS: Settings = {
  // Per the plan's rhythm: breaks land at absolute clock marks :20/:40/:60 — every gap
  // between consecutive breaks (including the one before the big break) is 20 minutes.
  // bigMinutes is the GAP before the big break, not the absolute :60 mark itself, so
  // it must equal microMinutes here, not 60.
  microMinutes: 20,
  bigMinutes: 20,
  focusUntil: null,
  enabled: true,
  language: 'en',
  skin: 'none'
};

// The streak counts consecutive ACTIVE days, not calendar days. An active day is one
// where the ghost peeked while the user was demonstrably present (recent system input,
// or they clicked the ghost). Days with no such activity (weekends, public holidays,
// sick days, vacation — or Chrome left running on an empty desk) are neutral: they
// neither extend nor break the streak. The streak dies only when an active day ends
// with zero completed breaks. Needs no country/holiday data; keeps the app offline.
export interface StreakState {
  currentStreak: number;
  lastCompletedDate: string | null; // YYYY-MM-DD, local time
  // Most recent active date. `lastActiveDate !== lastCompletedDate` (and not the day
  // still in progress) means an active day was missed.
  lastActiveDate: string | null;
  // Append-only, and never filtered against the known-skin list: an id written by a
  // NEWER version must survive a downgrade untouched rather than being silently
  // dropped. Unlocks are permanent.
  unlockedSkins: Skin[];
}

export const DEFAULT_STREAK: StreakState = {
  currentStreak: 0,
  lastCompletedDate: null,
  lastActiveDate: null,
  unlockedSkins: []
};

// Reads a stored streak, migrating records written by v1.0.0 (which had no
// lastActiveDate and used strict calendar-day continuity). The migration preserves
// exactly what the old popup DISPLAYED: a streak whose last completion was today or
// yesterday stays alive; anything older was already showing 0, so zero it rather than
// resurrecting a count the user believed was gone. Background and popup both read
// through this so they can't disagree about what the stored record means.
// `todayStr` is the accounting date of whatever event triggered the read — captured at
// arrival, not at write time — so a queued write that lands after midnight migrates
// against the day the event belongs to.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function asDate(v: unknown): string | null {
  return typeof v === 'string' && DATE_RE.test(v) ? v : null;
}
// Coerces rather than rejects, so a hand-seeded "5" still means 5 — but anything that
// isn't a finite number lands on 0 instead of poisoning the arithmetic downstream.
// Exported: skins.ts's normalizeCounters needs the exact same coercion and used to
// carry its own copy — see that file for why sharing one is worth the cross-module
// import.
export function asCount(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}

export function normalizeStreak(raw: Partial<StreakState> | undefined, todayStr: string): StreakState {
  // Every field is coerced rather than trusted. This record is hand-editable (the plan
  // doc documents seeding it from DevTools to test milestones), and the popup re-reads
  // it once a second: a string count would make `currentStreak + 1` concatenate — "5"
  // becomes "51" and crosses every skin threshold at once — and a non-array
  // unlockedSkins would throw inside the spread, blanking the popup permanently.
  const streak: StreakState = {
    ...DEFAULT_STREAK,
    ...raw,
    currentStreak: asCount(raw?.currentStreak),
    lastCompletedDate: asDate(raw?.lastCompletedDate),
    lastActiveDate: asDate(raw?.lastActiveDate),
    unlockedSkins: Array.isArray(raw?.unlockedSkins) ? [...raw.unlockedSkins] : []
  };
  if (raw?.lastActiveDate === undefined) {
    const last = streak.lastCompletedDate;
    const wasAlive = last !== null && (last === todayStr || last === prevLocalDate(todayStr));
    streak.currentStreak = wasAlive ? streak.currentStreak : 0;
    streak.lastActiveDate = last;
  }
  return streak;
}

// Alive = no active day before `openDate` has ended without a completed break.
// `openDate` is the day still in progress — normally today, but callers holding an
// unresolved break pass that break's own date (SchedulerState.breakDueDate) so a
// break shown at 23:59 stays "in progress" past midnight rather than looking missed.
// Storage only resets lazily (on the next active-day roll), so readers must gate the
// DISPLAYED count on this rather than trusting currentStreak alone.
export function isStreakAlive(streak: StreakState, openDate: string): boolean {
  const { lastActiveDate, lastCompletedDate } = streak;
  if (lastCompletedDate === null) return false;
  if (lastActiveDate === null || lastActiveDate === lastCompletedDate) return true;
  return lastActiveDate === openDate;
}

// Advances the streak record to a new active day. Idempotent within a day, and never
// rolls backward (a late event for an older break can't rewind a newer active day).
// If the previous active day had no completion the streak is dead — zero it here so
// the count in storage matches what isStreakAlive() already reports.
export function rollActiveDay(streak: StreakState, activeDate: string): StreakState {
  if (streak.lastActiveDate !== null && activeDate <= streak.lastActiveDate) return streak;
  const currentStreak = isStreakAlive(streak, activeDate) ? streak.currentStreak : 0;
  return { ...streak, currentStreak, lastActiveDate: activeDate };
}

export function localDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// The local calendar date before `dateStr`. Goes through a local-noon Date and
// setDate (not ms-subtraction) so a DST transition's 23- or 25-hour day can't
// miscount which date "yesterday" actually was.
export function prevLocalDate(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d, 12);
  dt.setDate(dt.getDate() - 1);
  return localDateStr(dt);
}