export type BreakKind = 'micro' | 'big';

// Accessories, not recolors — same base ghost, unlocked permanently by hitting a daily
// break-completion streak (see SKIN_MILESTONES). 'none' is always unlocked.
export type Skin = 'none' | 'sprout' | 'phones' | 'crown';

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

export interface StreakState {
  currentStreak: number;
  lastCompletedDate: string | null; // YYYY-MM-DD, local time
  unlockedSkins: Skin[];
}

export const SKIN_MILESTONES: Record<Exclude<Skin, 'none'>, number> = {
  sprout: 2,
  phones: 5,
  crown: 7
};

export const DEFAULT_STREAK: StreakState = {
  currentStreak: 0,
  lastCompletedDate: null,
  unlockedSkins: []
};

export function localDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Local calendar-day comparison (not ms-subtraction) so a DST transition's 23- or
// 25-hour day can't miscount which date "yesterday" actually was.
export function isYesterday(prevDateStr: string | null, today: Date): boolean {
  if (!prevDateStr) return false;
  const y = new Date(today);
  y.setDate(y.getDate() - 1);
  return localDateStr(y) === prevDateStr;
}