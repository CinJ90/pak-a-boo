export type BreakKind = 'micro' | 'big';

export interface Settings {
  microMinutes: number;
  bigMinutes: number;
  focusUntil: number | null;
  // Indefinite pause, distinct from focusUntil's timed one-hour pause — stays off until
  // the user explicitly turns it back on.
  enabled: boolean;
  language: 'en' | 'th';
}

export interface SchedulerState {
  nextBreakAt: number;
  breakKind: BreakKind;
  cycleStep: number;
  snoozes: number;
  breaksToday: number;
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
  language: 'en'
};