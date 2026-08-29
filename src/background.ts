import { DEFAULT_SETTINGS, SKIN_MILESTONES, localDateStr, normalizeStreak, rollActiveDay, type BreakKind, type SchedulerState, type Settings, type Skin, type StreakState } from './types';

const ALARM_NAME = 'pak-a-boo-next-break';
// chrome.idle only tracks physical mouse/keyboard input — it can't tell "genuinely away"
// apart from "sitting still watching the countdown," which looks identical to it. Never
// treat idle as "away" for less than this floor, however short the break interval is.
const MIN_AWAY_MS = 15 * 60_000;
// For streak purposes a peek only makes the day "active" if someone is demonstrably at
// the machine: system input within this many seconds. Otherwise Chrome left running on
// an empty desk over a weekend would mark Saturday active, and the streak would die for
// exactly the days-off the active-day rule exists to forgive. Kept short so input from
// just before midnight can't make the NEXT day look active either. Any click on the
// ghost (snooze / skip / take) marks the day regardless — that's presence by definition.
const PRESENCE_WINDOW_S = 60;

const NOTIFY_COPY = {
  en: {
    bigTitle: 'Big stretch break',
    bigMessage: 'Stand up, stretch, and drink some water.',
    microTitle: 'Time to Pak (rest)',
    microMessage: 'Look far away for 20 seconds.'
  },
  th: {
    bigTitle: 'ถึงเวลายืดเส้นยืดสายกันหน่อย',
    bigMessage: 'ลุกขึ้นยืน ยืดเส้นยืดสาย แล้วจิบน้ำสักหน่อย',
    microTitle: 'ถึงเวลาพักสายตา',
    microMessage: 'มองไกล ๆ สัก 20 วินาที'
  }
} as const;

async function getSettings(): Promise<Settings> {
  return { ...DEFAULT_SETTINGS, ...(await chrome.storage.sync.get(DEFAULT_SETTINGS)) } as Settings;
}

// Two independent ways reminders can be paused: a timed one-hour focus window, or
// turned off indefinitely until switched back on. Either one means "don't nag."
function isPaused(settings: Settings): boolean {
  return Boolean(settings.focusUntil && settings.focusUntil > Date.now()) || !settings.enabled;
}

async function scheduleNext(from = Date.now(), cycleStep = 0, breaksToday = 0): Promise<void> {
  assertInTransaction('scheduleNext');
  const settings = await getSettings();
  const breakKind = cycleStep === 2 ? 'big' : 'micro';
  const intervalMinutes = breakKind === 'big' ? settings.bigMinutes : settings.microMinutes;
  const state: SchedulerState = {
    nextBreakAt: from + intervalMinutes * 60_000,
    breakKind,
    cycleStep,
    snoozes: 0,
    breaksToday,
    breaksTodayDate: localDateStr(new Date(from)),
    lastBreakAt: null,
    scheduledMinutes: intervalMinutes,
    breakDueDate: null
  };
  await chrome.storage.local.set({ scheduler: state });
  await chrome.alarms.clear(ALARM_NAME);
  await chrome.alarms.create(ALARM_NAME, { when: state.nextBreakAt });
}

// Every call site that carries a persisted breaksToday forward into the next
// scheduleNext() call must go through this — breaksToday itself never auto-resets,
// so without this a count from yesterday (or last week) keeps accumulating across any
// reload/pause/resume/idle-forgiveness path that isn't a genuine new completion.
// `from` is required, not defaulted — every caller must pass the SAME timestamp it
// gives scheduleNext(), so the day-check and the write it gates can't disagree.
function effectiveBreaksToday(scheduler: SchedulerState | undefined, from: number): number {
  if (!scheduler || scheduler.breaksTodayDate !== localDateStr(new Date(from))) return 0;
  return scheduler.breaksToday;
}

// ── Serialized state writes ─────────────────────────────────────────────────────
// Every read-modify-write of the `scheduler` or `streak` key runs inside one
// transaction chain. chrome.storage has no compare-and-swap, so without this any
// handler that reads the scheduler, awaits something (settings, an idle query, a
// storage round-trip), then writes it back will silently clobber a reschedule that
// landed in between — resurrecting a break the user already took, along with its
// stale cycle position and break count. Serializing IS the fix: each handler starts
// from the state the previous one finished writing.
//
// The two keys share one chain rather than having one each: TAKE_BREAK has to update
// both atomically, and two chains would need one to await the other (a deadlock waiting
// to happen). There is no throughput to lose here — these are sub-second, user-paced
// events.
//
// RULE: enqueue at the TOP of an event handler only. Anything reachable from inside a
// transaction (scheduleNext, prepareShownBreak, recordCompletion, markActiveDay, …)
// must never enqueue — it would wait forever on the chain it is already running in.
// assertInTransaction() surfaces that mistake in the service-worker console.
let stateWrite: Promise<void> = Promise.resolve();
let inTransaction = false;

function enqueueWrite(label: string, work: () => Promise<unknown>): Promise<void> {
  return (stateWrite = stateWrite.then(async () => {
    inTransaction = true;
    try {
      await work();
    } catch (e) {
      // Swallowed, not rethrown: one failed transaction must not break the chain for
      // every write queued behind it.
      console.error(`Pak-a-boo: ${label} failed`, e);
    } finally {
      inTransaction = false;
    }
  }));
}

function assertInTransaction(fn: string): void {
  if (!inTransaction) console.error(`Pak-a-boo: ${fn}() ran outside a state transaction — see enqueueWrite`);
}

// `accountingDate` is the date of the event being applied (captured at arrival), so
// the v1.0.0 migration inside normalizeStreak judges recency against the right day
// even if this queued read runs after midnight.
async function readStreak(accountingDate: string): Promise<StreakState> {
  const { streak } = await chrome.storage.local.get('streak') as { streak?: Partial<StreakState> };
  return normalizeStreak(streak, accountingDate);
}

// Is someone demonstrably at the machine right now? System input within
// PRESENCE_WINDOW_S — but never input from before local midnight: in the first minute
// of a new day the window shrinks to the seconds elapsed since 00:00, so last night's
// typing can't vouch for today. (queryState's minimum interval is 15 s, so the first
// 15 s of a day can't auto-mark at all — clicks still can.)
async function userPresent(now: Date): Promise<boolean> {
  const sinceMidnightS = Math.floor((now.getTime() - new Date(now).setHours(0, 0, 0, 0)) / 1000);
  const window = Math.min(PRESENCE_WINDOW_S, sinceMidnightS);
  if (window < 15) return false;
  return (await chrome.idle.queryState(window)) === 'active';
}

// Called by every path that is about to show a break (alarm, tab activation, page
// load) with the CURRENT scheduler, read inside the same transaction. Two jobs:
//  1. Pin the break to today (breakDueDate) if this is its first showing.
//  2. If a PRESENT user is getting their first peek of a new active day, restart the
//     rest cycle: every day opens micro → micro → big, regardless of where yesterday
//     (or an unattended weekend of alarms cycling on an empty desk) left off. Presence
//     is what distinguishes "first peek of the day" from "alarm #37 to nobody".
// Marking the day active is left to the caller, which knows whether the ghost was
// really shown (notifyBreak has pause re-checks after this; deliverIfDue only finds
// out in its send callback).
interface ShownBreak { scheduler: SchedulerState; dueDate: string; present: boolean }

async function prepareShownBreak(current: SchedulerState): Promise<ShownBreak> {
  assertInTransaction('prepareShownBreak');
  const now = new Date();
  const dueDate = current.breakDueDate ?? localDateStr(now);
  let next: SchedulerState = current.breakDueDate ? current : { ...current, breakDueDate: dueDate };
  const present = await userPresent(now);
  if (present && next.cycleStep !== 0) {
    const streak = await readStreak(dueDate);
    const firstPeekOfNewDay = rollActiveDay(streak, dueDate) !== streak;
    if (firstPeekOfNewDay) next = { ...next, cycleStep: 0, breakKind: 'micro' };
  }
  if (next !== current) await chrome.storage.local.set({ scheduler: next });
  return { scheduler: next, dueDate, present };
}

// The date a break belongs to for streak accounting: the day it was first shown, or —
// for a break delivered by deliverIfDue/CONTENT_READY before notifyBreak ever ran for
// it — the day of the interaction itself. Callers must read the scheduler BEFORE
// rescheduling, since scheduleNext() resets breakDueDate.
function breakDate(scheduler: SchedulerState | undefined, fallback: Date): string {
  return scheduler?.breakDueDate ?? localDateStr(fallback);
}

// Makes `activeDate` count as an active day. Idempotent — persists only when the day
// actually rolls, so repeated nags/clicks within a day write nothing.
// Returns whether this call is what OPENED the day (rolled it), which is also the
// signal to restart the rest cycle — see the callers. Only the first mark of a day
// returns true.
async function markActiveDay(activeDate: string): Promise<boolean> {
  assertInTransaction('markActiveDay');
  const streak = await readStreak(activeDate);
  const rolled = rollActiveDay(streak, activeDate);
  if (rolled === streak) return false;
  await chrome.storage.local.set({ streak: rolled });
  return true;
}

// Idle forgiveness: the user walked away for at least a full break interval after
// the ghost peeked. If that break's day was already marked active (they were present
// when it peeked), the absence IS the rest — credit it, or an otherwise-honest day
// could later kill the streak. If the day was never marked (ghost peeked at an empty
// desk), do nothing: crediting that would hand out free streak days over weekends.
async function creditForgivenBreak(shownDate: string): Promise<void> {
  const streak = await readStreak(shownDate);
  if (streak.lastActiveDate !== shownDate) return;
  await recordCompletion(shownDate); // the day is already open; nothing to reset
}

// Called only when a break is genuinely completed, credited to the break's own date
// (see breakDate). Rolls the active day itself too: a break can be delivered and
// completed before the alarm's own notifyBreak() has marked anything.
// Returns whether it opened the day, same as markActiveDay.
async function recordCompletion(completedDate: string): Promise<boolean> {
  assertInTransaction('recordCompletion');
  const before = await readStreak(completedDate);
  // A completion dated BEFORE the newest active day means the clock moved backward:
  // westward travel (the local date repeats) or a fast clock being corrected. Credit
  // it to that day instead of dropping it — dropping would leave the streak unable to
  // advance, or even to restart from 1, until real time caught back up. The
  // already-counted guard below still prevents a double count.
  const date = before.lastActiveDate !== null && completedDate < before.lastActiveDate
    ? before.lastActiveDate
    : completedDate;
  const streak = rollActiveDay(before, date);
  const openedDay = streak !== before;
  if (streak.lastCompletedDate === date) {
    if (openedDay) await chrome.storage.local.set({ streak }); // persist the roll only
    return openedDay; // already counted
  }
  const currentStreak = streak.currentStreak + 1; // rollActiveDay already zeroed a dead streak
  const unlockedSkins = [...streak.unlockedSkins];
  for (const [skin, threshold] of Object.entries(SKIN_MILESTONES) as [Skin, number][]) {
    if (currentStreak >= threshold && !unlockedSkins.includes(skin)) unlockedSkins.push(skin);
  }
  await chrome.storage.local.set({ streak: { ...streak, currentStreak, lastCompletedDate: date, unlockedSkins } });
  return openedDay;
}

async function notifyBreak(): Promise<void> {
  assertInTransaction('notifyBreak');
  const { scheduler } = await chrome.storage.local.get('scheduler') as { scheduler?: SchedulerState };
  const settings = await getSettings();
  if (!scheduler) {
    await scheduleNext();
    return;
  }
  if (isPaused(settings)) {
    await chrome.storage.local.set({ pausedLastCheck: true });
    // Timed focus expires on its own and is worth polling; off mode only ends through
    // the storage change listener, so it needs no background alarm.
    if (settings.focusUntil && settings.focusUntil > Date.now()) {
      await chrome.alarms.create(ALARM_NAME, { delayInMinutes: 5 });
    } else {
      await chrome.alarms.clear(ALARM_NAME);
    }
    return;
  }
  // Another tab is already handling this break, so defer without notifying or
  // counting another ignored nag.
  if (await sessionInProgress()) {
    await chrome.alarms.create(ALARM_NAME, { delayInMinutes: 2 });
    return;
  }
  const { pausedLastCheck } = await chrome.storage.local.get('pausedLastCheck') as { pausedLastCheck?: boolean };
  if (pausedLastCheck) {
    // A pause (usually focus mode) just lapsed on its own, without the user touching
    // anything — nextBreakAt has been sitting stale/overdue this whole time. Give a
    // fresh interval instead of immediately notifying for whatever built up.
    await chrome.storage.local.remove('pausedLastCheck');
    const lapseNow = Date.now();
    await scheduleNext(lapseNow, scheduler.cycleStep, effectiveBreaksToday(scheduler, lapseNow));
    return;
  }
  // Ghost gives up after enough ignored nags: skip to the next cycle instead of sulking forever.
  if (scheduler.snoozes >= 3) {
    const giveUpNow = Date.now();
    await scheduleNext(giveUpNow, (scheduler.cycleStep + 1) % 3, effectiveBreaksToday(scheduler, giveUpNow));
    await resolveBreak();
    return;
  }

  // Pins the date on the first nag (re-nags, even past midnight, keep it) and may
  // restart the cycle for a new day.
  const { scheduler: current, dueDate, present } = await prepareShownBreak(scheduler);
  const isBigBreak = current.breakKind === 'big';
  await chrome.storage.local.set({
    scheduler: { ...current, snoozes: current.snoozes + 1, lastBreakAt: Date.now() }
  });
  // Arm the re-nag alarm FIRST — if notifications.create or the broadcast throws below,
  // the cycle must not get permanently stuck with no future alarm to wake it back up.
  await chrome.alarms.create(ALARM_NAME, { delayInMinutes: 10 });
  const n = NOTIFY_COPY[settings.language];
  // The OS notification has its own race window if focus/off changes while this call
  // is in flight, so check again immediately before creating it.
  if (isPaused(await getSettings())) return;
  const notificationId = `break-${Date.now()}`;
  // No callback passed, so @types/chrome resolves this to its void-returning overload —
  // there's nothing to await (the notification still fires; we just don't get its id).
  chrome.notifications.create(notificationId, {
    type: 'basic',
    iconUrl: 'icons/icon-128.png',
    title: isBigBreak ? n.bigTitle : n.microTitle,
    message: isBigBreak ? n.bigMessage : n.microMessage
  });
  // Tracked so resolveBreak() can clear it later, whichever path resolves this break.
  await chrome.storage.local.set({ currentNotificationId: notificationId });
  // Re-check the pause state right before broadcasting rather than trusting the value
  // read at the top of this function — closes the narrow window where focus/off gets
  // turned on while this call is in flight.
  if (isPaused(await getSettings())) return;
  // The ghost is about to peek. That makes the break's day active for the streak —
  // but only if someone was actually here to see it (prepareShownBreak's presence
  // check); an alarm firing on an idle/locked machine must not count. Called directly,
  // not enqueued: this already IS the transaction.
  if (present) await markActiveDay(dueDate);
  await broadcast({ type: 'BREAK_DUE', breakKind: current.breakKind });
}

// Sends a message to every open tab (best-effort — most tabs have no content script
// listening, e.g. chrome:// pages, and that's expected, not an error). The ghost's
// state is per-tab local, so this is how the background keeps every tab in sync:
// BREAK_DUE shows it wherever the user is actually looking, not just the tab that
// happened to be focused when the alarm fired; BREAK_RESOLVED hides it everywhere
// once the break is taken, skipped, or snoozed from whichever tab the user acted in.
async function broadcast(message: { type: string; breakKind?: 'micro' | 'big' }): Promise<void> {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (!tab.id) continue;
    chrome.tabs.sendMessage(tab.id, message, () => {
      void chrome.runtime.lastError; // expected for tabs without a content script; ignore
    });
  }
}

// Every path that resolves a break (snooze, complete, skip, pause, give-up, manual
// reset) broadcasts BREAK_RESOLVED — route them all through here so the OS notification
// (if any is still showing) gets cleared too. Without this, a break resolved from the
// in-page UI can leave its notification sitting in the OS tray indefinitely, and a few
// re-nags each create their own notification, so they'd pile up.
async function resolveBreak(): Promise<void> {
  const { currentNotificationId } = await chrome.storage.local.get('currentNotificationId') as { currentNotificationId?: string };
  if (currentNotificationId) {
    // No callback passed, so @types/chrome resolves this to its void-returning overload.
    chrome.notifications.clear(currentNotificationId);
    await chrome.storage.local.remove('currentNotificationId');
  }
  await broadcast({ type: 'BREAK_RESOLVED' });
}

// Chrome only auto-injects content scripts into pages loaded AFTER the extension
// starts — tabs already open at install/reload time silently have no ghost until
// refreshed. Inject into them explicitly so no tab needs a manual refresh.
// (content.ts's boot() guard makes double-injection a no-op.)
async function injectIntoOpenTabs(): Promise<void> {
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  for (const tab of tabs) {
    if (!tab.id) continue;
    chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] })
      .catch(() => { /* restricted page (chrome web store, etc.) — expected, ignore */ });
  }
}

// Self-expiring (not a plain boolean) so a tab closed mid-session without ever sending
// TAKE_BREAK can't leave this stuck "in progress" forever — it just times out.
async function sessionInProgress(): Promise<boolean> {
  const { sessionInProgressUntil } = await chrome.storage.local.get('sessionInProgressUntil') as { sessionInProgressUntil?: number };
  return typeof sessionInProgressUntil === 'number' && sessionInProgressUntil > Date.now();
}

// If a break is pending, (re)deliver it to one specific tab. Used on tab activation:
// a tab that was asleep (Memory Saver) or otherwise missed the fire-time broadcast
// gets the ghost the moment the user switches to it. The content script ignores the
// message if the ghost is already visible, so re-delivery is harmless.
async function deliverIfDue(tabId: number): Promise<void> {
  assertInTransaction('deliverIfDue');
  const { scheduler } = await chrome.storage.local.get('scheduler') as { scheduler?: SchedulerState };
  if (!scheduler || scheduler.nextBreakAt > Date.now()) return;
  // Another tab is already handling this exact break — nextBreakAt won't move until it
  // finishes, so without this a tab switch mid-session would summon a second copy.
  if (await sessionInProgress()) return;
  if (isPaused(await getSettings())) return;
  const shown = await prepareShownBreak(scheduler);
  chrome.tabs.sendMessage(tabId, { type: 'BREAK_DUE', breakKind: shown.scheduler.breakKind }, () => {
    // lastError means no content script in that tab (chrome://, store, etc.) — the
    // ghost was NOT shown, so the day isn't marked active for it. This callback fires
    // after the transaction has ended, so the mark needs its own.
    if (chrome.runtime.lastError) return;
    if (shown.present) void enqueueWrite('markActiveDay', () => markActiveDay(shown.dueDate));
  });
}

// onInstalled fires for a fresh install AND every extension reload/update; onStartup
// fires every time Chrome itself launches. Resetting the schedule unconditionally on
// either would wipe today's progress (cycle step, breaksToday) just from reloading the
// extension or restarting the browser — reconcile against what's persisted instead,
// and only fall back to a fresh schedule when nothing exists yet.
async function reconcileSchedule(): Promise<void> {
  assertInTransaction('reconcileSchedule');
  const { scheduler } = await chrome.storage.local.get('scheduler') as { scheduler?: SchedulerState };
  if (!scheduler) { await scheduleNext(); return; }
  const settings = await getSettings();
  const configuredMinutes = scheduler.breakKind === 'big' ? settings.bigMinutes : settings.microMinutes;
  if (scheduler.scheduledMinutes !== configuredMinutes || scheduler.nextBreakAt <= Date.now()) {
    // The interval changed or the persisted break is already overdue — recompute from
    // now, but keep the cycle position and today's count, same as any other reload.
    const reconcileNow = Date.now();
    await scheduleNext(reconcileNow, scheduler.cycleStep, effectiveBreaksToday(scheduler, reconcileNow));
    return;
  }
  await chrome.alarms.create(ALARM_NAME, { when: scheduler.nextBreakAt });
}

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') void enqueueWrite('install', () => scheduleNext());
  else void enqueueWrite('reconcile', reconcileSchedule);
  void injectIntoOpenTabs();
});
chrome.runtime.onStartup.addListener(() => { void enqueueWrite('reconcile', reconcileSchedule); });
chrome.tabs.onActivated.addListener(({ tabId }) => { void enqueueWrite('deliverIfDue', () => deliverIfDue(tabId)); });

// Pausing (focus OR turning off) should feel immediate, not laggy by up to 5 minutes:
// pausing hides a ghost that's already showing right now instead of leaving it up until
// the next re-check alarm; unpausing re-delivers a break that's already due instead of
// making the user wait for that same re-check.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  if (changes.focusUntil) {
    const newlyPaused = Boolean(changes.focusUntil.newValue && (changes.focusUntil.newValue as number) > Date.now());
    void enqueueWrite('pauseChange', () => reactToPauseChange(newlyPaused));
  }
  if (changes.enabled) {
    void enqueueWrite('pauseChange', () => reactToPauseChange(changes.enabled.newValue === false));
  }
});

async function reactToPauseChange(newlyPaused: boolean): Promise<void> {
  assertInTransaction('reactToPauseChange');
  const { scheduler } = await chrome.storage.local.get('scheduler') as { scheduler?: SchedulerState };
  if (!scheduler) return;
  if (newlyPaused) {
    // Reset the countdown the moment a pause starts — the interval that was already
    // ticking down shouldn't keep silently expiring in the background while paused,
    // only to surface as an overdue break the instant you come back.
    const pauseNow = Date.now();
    await scheduleNext(pauseNow, scheduler.cycleStep, effectiveBreaksToday(scheduler, pauseNow));
    await resolveBreak();
    return;
  }
  // One pause mechanism just cleared, but the other might still be active — check
  // the combined state before resuming anything, not just the single field that changed.
  const settings = await getSettings();
  if (isPaused(settings)) return;
  // Clear this here too, not just where notifyBreak consumes it — otherwise a pause
  // ended explicitly (rather than caught by notifyBreak's own poll) leaves it stale,
  // and the next genuinely-due break would be mistaken for a lapsed pause and deferred.
  await chrome.storage.local.remove('pausedLastCheck');
  // Resuming always starts the next-peek countdown fresh from right now, whether the
  // pause was short (nextBreakAt still ahead) or long (already overdue) — coming back
  // from a pause should feel like a clean restart, not "pick up wherever it was".
  const resumeNow = Date.now();
  await scheduleNext(resumeNow, scheduler.cycleStep, effectiveBreaksToday(scheduler, resumeNow));
}
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) void enqueueWrite('notifyBreak', notifyBreak);
});

chrome.idle.onStateChanged.addListener((newState) => {
  if (newState === 'idle' || newState === 'locked') {
    // idle → locked is a SECOND transition for the same absence (screen lock follows
    // idle) — don't overwrite the original idleSince, or the away duration undercounts.
    void chrome.storage.local.get('idleSince').then(({ idleSince }) => {
      if (typeof idleSince !== 'number') void chrome.storage.local.set({ idleSince: Date.now() });
    });
    return;
  }
  if (newState === 'active') {
    void enqueueWrite('idleForgiveness', async () => {
      const { idleSince, scheduler } = await chrome.storage.local.get(['idleSince', 'scheduler']) as { idleSince?: number; scheduler?: SchedulerState };
      await chrome.storage.local.remove('idleSince');
      // A short pause (checking your phone, thinking, or just watching the countdown
      // without touching the mouse) should NOT reset it — only forgive it as "break
      // taken" for a genuinely long absence.
      const settings = await getSettings();
      if (isPaused(settings)) return;
      const s = scheduler;
      const thresholdMinutes = s?.breakKind === 'big' ? settings.bigMinutes : settings.microMinutes;
      const awayMs = typeof idleSince === 'number' ? Date.now() - idleSince : 0;
      if (awayMs >= Math.max(thresholdMinutes * 60_000, MIN_AWAY_MS)) {
        // "Forgiven" means this break counts as taken — advance one cycle step like
        // TAKE_BREAK does, not a full reset back to step 0 (which was also silently
        // wiping the whole day's breaksToday count on every long absence).
        // Capture the break's date before scheduleNext() resets it.
        const shownDate = s?.breakDueDate ?? null;
        const forgiveNow = Date.now();
        await scheduleNext(forgiveNow, ((s?.cycleStep ?? 0) + 1) % 3, effectiveBreaksToday(s, forgiveNow));
        await resolveBreak();
        // Streak credit only if the ghost had actually peeked at a present user — see
        // creditForgivenBreak for why an un-marked day must not be credited.
        if (shownDate) await creditForgivenBreak(shownDate);
      }
    });
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'SNOOZE') {
    const snoozedAt = new Date();
    void enqueueWrite('SNOOZE', async () => {
      let snoozeUntil: number | null = null;
      try {
        const { scheduler: s } = await chrome.storage.local.get('scheduler') as { scheduler?: SchedulerState };
        // Snooze DELAYS whatever's pending — it must never pull a break EARLIER. If the
        // next break isn't due for another 18 minutes, "snooze 5 min" should add 5
        // minutes to that, not replace it with "5 minutes from now".
        const nextBreakAt = Math.max(s?.nextBreakAt ?? 0, Date.now()) + 5 * 60_000;
        // Clicking snooze is presence — this break's day is active whether or not the
        // idle check at peek time agreed.
        const openedDay = await markActiveDay(breakDate(s, snoozedAt));
        if (s) {
          // If this click is what opened the day, restart the rhythm here too. The peek
          // that preceded it could not: prepareShownBreak only resets when it can SEE
          // the user, and a first-thing-in-the-morning peek at someone reading (no input
          // in the last minute) reads as absent. Once the day has rolled, nothing else
          // would ever reset it — so yesterday's leftover big break would keep re-nagging
          // as big, all day.
          const opened: SchedulerState = openedDay ? { ...s, cycleStep: 0, breakKind: 'micro' } : s;
          await chrome.storage.local.set({ scheduler: { ...opened, nextBreakAt } });
        }
        await chrome.alarms.create(ALARM_NAME, { when: nextBreakAt });
        await resolveBreak();
        snoozeUntil = nextBreakAt;
      } finally {
        // The tab re-arms its precise due-timer against this — see content.ts armDueTimer.
        sendResponse({ ok: snoozeUntil !== null, nextBreakAt: snoozeUntil });
      }
    });
  }
  if (message.type === 'SESSION_STARTED') {
    // A break is being handled in the sending tab right now — stop it escalating in
    // any OTHER tab immediately, rather than waiting for that session to finish
    // minutes later (which left a window for the same break to be completed twice).
    // Also record it so a tab activated/opened WHILE this session runs doesn't get
    // re-delivered the same still-overdue break (deliverIfDue/CONTENT_READY check this).
    void chrome.storage.local.set({ sessionInProgressUntil: Date.now() + 10 * 60_000 });
    void resolveBreak();
    sendResponse({ ok: true });
  }
  if (message.type === 'TAKE_BREAK') {
    // Capture arrival time up front: the streak write runs later (and serialized), and
    // the fallback date for an un-pinned break must be when it was acted on, not when
    // the write lands.
    const completedAt = new Date();
    // Default missing/malformed data to "not completed" — safer to undercount than
    // to let a malformed message inflate the stat.
    const completed = message.completed === true;
    // The WHOLE transaction — clear the session flag, read the scheduler, apply the
    // streak, reschedule — is enqueued synchronously on arrival, so two TAKE_BREAKs are
    // processed strictly in arrival order and neither can read a scheduler the other is
    // mid-way through replacing. The break's date must come from the scheduler BEFORE
    // scheduleNext() resets it. Acting on the ghost at all (skip included) is presence,
    // so the day is marked active either way; completion also credits it.
    void enqueueWrite('TAKE_BREAK', async () => {
      let ok = false;
      try {
        await chrome.storage.local.remove('sessionInProgressUntil');
        const { scheduler } = await chrome.storage.local.get('scheduler') as { scheduler?: SchedulerState };
        const date = breakDate(scheduler, completedAt);
        const openedDay = completed ? await recordCompletion(date) : await markActiveDay(date);
        // Same reason as SNOOZE: if acting on this ghost is what opened the day, the
        // break just handled belonged to yesterday's cycle, so the new day's rhythm
        // starts fresh from the next one rather than continuing the old count.
        const nextStep = openedDay ? 0 : ((scheduler?.cycleStep ?? 0) + 1) % 3;
        await scheduleNext(completedAt.getTime(), nextStep, effectiveBreaksToday(scheduler, completedAt.getTime()) + (completed ? 1 : 0));
        await resolveBreak(); // other tabs are cleared before the sender hears back
        ok = true;
      } finally {
        // Always answer — the content script is waiting on this. The read is guarded
        // separately so a failing storage call can't be what stops the reply going out.
        let fresh: SchedulerState | undefined;
        try {
          ({ scheduler: fresh } = await chrome.storage.local.get('scheduler') as { scheduler?: SchedulerState });
        } catch { /* answer with what we know rather than leaving the tab hanging */ }
        sendResponse({ ok, nextBreakAt: fresh?.nextBreakAt ?? null, breaksToday: fresh?.breaksToday ?? 0 });
      }
    });
  }
  if (message.type === 'RESET_CYCLE') {
    void enqueueWrite('RESET_CYCLE', async () => {
      let ok = false;
      try {
        const settings = await getSettings();
        // The popup already disables this button while paused, but the background must
        // not just trust that — a click landing right as focus/off toggles shouldn't be
        // able to move the cycle position while reminders are supposed to be silent.
        if (isPaused(settings)) return;
        // A session already open in some tab isn't tied to the reset — it ignores
        // BREAK_RESOLVED while active (see content.ts), so resetting out from under it
        // would leave that tab's eventual TAKE_BREAK advancing the wrong cycle position.
        // Decline instead, same as notifyBreak() deferring its re-nag in this situation.
        if (await sessionInProgress()) return;
        // A manual restart — same cleanup as a completed break (clear any stuck
        // in-progress/lapsed-pause flags) but back to cycle step 0 instead of +1, and
        // today's completed-break count is untouched since that's a separate stat.
        await chrome.storage.local.remove(['sessionInProgressUntil', 'pausedLastCheck']);
        const { scheduler } = await chrome.storage.local.get('scheduler') as { scheduler?: SchedulerState };
        const resetNow = Date.now();
        await scheduleNext(resetNow, 0, effectiveBreaksToday(scheduler, resetNow));
        await resolveBreak();
        ok = true;
      } finally {
        sendResponse({ ok }); // the popup awaits this — always answer
      }
    });
  }
  if (message.type === 'CONTENT_READY') {
    void enqueueWrite('CONTENT_READY', async () => {
      // nextBreakAt lets the page arm its own precise timer for the moment the break is
      // due (alarms can fire late — see content.ts askIfDue). Withheld while paused,
      // when that time is meaningless.
      let response: { breakDue: boolean; breakKind?: BreakKind; nextBreakAt?: number | null } = { breakDue: false, nextBreakAt: null };
      try {
        const { scheduler: s } = await chrome.storage.local.get('scheduler') as { scheduler?: SchedulerState };
        const paused = isPaused(await getSettings());
        const inSession = await sessionInProgress();
        if (s && s.nextBreakAt <= Date.now() && !paused && !inSession) {
          const shown = await prepareShownBreak(s);
          response = { breakDue: true, breakKind: shown.scheduler.breakKind };
          // The content script shows the ghost on this response.
          if (shown.present) await markActiveDay(shown.dueDate);
        } else {
          response = { breakDue: false, nextBreakAt: s && !paused ? s.nextBreakAt : null };
        }
      } finally {
        sendResponse(response);
      }
    });
  }
  return true;
});
