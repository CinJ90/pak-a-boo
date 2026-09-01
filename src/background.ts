import { DEFAULT_SETTINGS, isStaleBreak, localDateStr, normalizeStreak, rollActiveDay, type BreakKind, type SchedulerState, type Settings, type Skin, type StreakState } from './types';
import { activeEventSkin, closeScreenSegment, earnedSkins, moodCounterForHour, normalizeCounters, openScreenSegment, rollCounters, satisfiedMoods, settleFocus, type Counters } from './skins';

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
// A single stable id, reused for every nag of the same ignored break. Re-nagging with
// a FRESH id each time (the original approach) meant only the newest one ever got
// tracked for clearing — every earlier re-nag's notification was orphaned in the OS
// tray. Reusing one id makes each new nag update the existing notification in place.
const BREAK_NOTIFICATION_ID = 'pak-a-boo-break';

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

// `accountingDate`/`now` are the day and instant the triggering event belongs to —
// captured by the CALLER at the moment the event actually happened (arrival of a
// message, a storage change), never derived from another subsystem's date logic. That
// decoupling matters: an earlier version keyed the daily mood counters off the
// STREAK's accounting date, so whether a break shown 23:59 and completed 00:01 counted
// toward the old day's or new day's mood depended on whether some unrelated event had
// already rolled the day over — the same input could produce two different outputs.
// Keying counters purely off their own wall-clock event removes that order-dependence.
async function readCounters(accountingDate: string, now: number = Date.now()): Promise<Counters> {
  const { counters } = await chrome.storage.local.get('counters') as { counters?: Partial<Counters> };
  // rollCounters settles an expired focus period whether or not the day is turning
  // over — settling BEFORE handing it a cross-day roll would let the roll discard
  // whatever got folded into the wrong (old) day's total; see its own comment.
  return rollCounters(normalizeCounters(counters), accountingDate, now);
}

// Folds newly-earned skins into what's already unlocked. Append-only: existing entries
// are never reordered or removed, so unlock ORDER is preserved — which is what makes
// "the most recently earned behaviour look" (resolveDefaultLook) simply the last one.
//
// Events are folded in here too: `unlockedSkins` doubles as a "seen once" ledger for
// anything that has no button of its own (moods AND event costumes), which is what
// lets the done card celebrate each one the FIRST time it's ever seen and stay quiet
// every time after. Nothing reads these entries to decide what is WORN — that's
// activeMood/activeEventSkin over the live counters/date — so recording an event here
// can't make it wearable outside its window.
function mergeUnlocks(streak: StreakState, counters: Counters, now: Date): { unlockedSkins: Skin[]; added: Skin[] } {
  const unlockedSkins = [...streak.unlockedSkins];
  const added: Skin[] = [];
  const event = activeEventSkin(now);
  const gained = [...earnedSkins(streak.currentStreak, counters), ...satisfiedMoods(counters, now.getTime()), ...(event ? [event] : [])];
  for (const id of gained) {
    if (!unlockedSkins.includes(id)) { unlockedSkins.push(id); added.push(id); }
  }
  return { unlockedSkins, added };
}

// Records that nightOwl/earlyBird just crossed its threshold, so the most recently
// reached mood is the one worn when two are satisfied on the same day. Zen is
// deliberately NOT handled here: while a session is still running its live crossing is
// already "satisfied" in both `before` and `after` (see skins.ts's zenCrossedAt, which
// covers that case for display), so this diff would never see it as newly gained; and
// once the session closes, `settleFocus` has already stamped it — by the time this
// runs, `before` itself already carries whatever stamp settling produced.
function noteMood(counters: Counters, before: Counters, now: number): Counters {
  const had = satisfiedMoods(before, now);
  const gained = satisfiedMoods(counters, now).filter((m) => !had.includes(m));
  return gained.length ? { ...counters, lastMood: gained[gained.length - 1], lastMoodAt: now } : counters;
}

// Counter bumps and unlock evaluation always land in the SAME transaction as the streak
// write that triggered them, so a skin can never be earned against a half-applied state.
//
// Newly-added skins are appended to a PERSISTED `pendingCelebration` list rather than
// just returned, and only the next completed break drains and clears it (see
// TAKE_BREAK). A plain return value was tried first and turned out to lose the
// celebration in exactly the common case: the legendary cat is usually unlocked by
// markActiveDay() during an ordinary peek, whose return value nothing was listening to
// — the very next completion would reset the in-memory value before anyone saw it, so
// the release's centerpiece unlock fired with no card, silently, for every user.
// Persisting survives that (and a service-worker restart in between) for free.
async function commitProgress(streak: StreakState, counters: Counters, now: Date = new Date()): Promise<Skin[]> {
  assertInTransaction('commitProgress');
  const { unlockedSkins, added } = mergeUnlocks(streak, counters, now);
  if (added.length === 0) {
    await chrome.storage.local.set({ streak: { ...streak, unlockedSkins }, counters });
    return added;
  }
  const { pendingCelebration } = await chrome.storage.local.get('pendingCelebration') as { pendingCelebration?: Skin[] };
  const queued = [...(Array.isArray(pendingCelebration) ? pendingCelebration : []), ...added];
  await chrome.storage.local.set({ streak: { ...streak, unlockedSkins }, counters, pendingCelebration: queued });
  return added;
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
  // Opening a day is the one moment activeDaysTotal advances — the legendary skin's
  // 21 is "21 days you actually showed up", not 21 on the calendar, so time off costs
  // nothing here just as it costs nothing in the streak. The daily mood counters are
  // read against NOW (not activeDate — see readCounters) since this is the moment the
  // day is genuinely opening; activeDate can be an older pinned date on a late re-nag.
  const now = new Date();
  const counters = await readCounters(localDateStr(now), now.getTime());
  counters.activeDaysTotal += 1;
  await commitProgress(rolled, counters, now);
  return true;
}

// Focus mode starting and stopping is what Zen Boo reads. Only the time actually spent
// in focus accrues: `focusStartedAt` opens a period, and it is closed either here (the
// user cancelled) or lazily by settleFocus (it simply expired — nothing fires then).
// `changedAt` is captured by the caller at the moment the storage change actually
// arrived (see the `storage.onChanged` listener) — not inside this queued transaction,
// which can run a noticeable moment later if the write chain is busy, and would
// otherwise risk dating a 23:59:59 focus start to the following day.
async function noteFocusChange(endsAt: number | null, changedAt: Date): Promise<void> {
  assertInTransaction('noteFocusChange');
  const now = changedAt.getTime();
  const today = localDateStr(changedAt);
  const before = await readCounters(today, now);
  let counters: Counters;
  if (endsAt !== null && endsAt > now) {
    // Started. Re-opening while one is already running keeps the original anchor, so a
    // double event can't reset the clock and lose accrued time.
    counters = before.focusStartedAt !== null ? before : { ...before, focusStartedAt: now, focusEndsAt: endsAt };
  } else {
    // Cancelled before its end — bank what was actually used, capped at the moment of
    // cancellation. Delegates to settleFocus (a temporarily-clamped focusEndsAt makes
    // its banking math produce the exact same result as the manual version this
    // replaced) rather than duplicating it, so a period that had already live-crossed
    // Zen's threshold gets the SAME closing-stamp treatment a natural expiry gets — see
    // settleFocus's own comment for why that stamp has to live in one shared place.
    counters = before.focusStartedAt === null
      ? before
      : settleFocus({ ...before, focusEndsAt: Math.min(before.focusEndsAt ?? now, now) }, now);
  }
  counters = noteMood(counters, before, now);
  await commitProgress(await readStreak(today), counters, changedAt);
}

// Idle forgiveness: the user walked away for at least a full break interval after
// the ghost peeked. If that break's day was already marked active (they were present
// when it peeked), the absence IS the rest — credit it, or an otherwise-honest day
// could later kill the streak. If the day was never marked (ghost peeked at an empty
// desk), do nothing: crediting that would hand out free streak days over weekends.
async function creditForgivenBreak(shownDate: string): Promise<void> {
  assertInTransaction('creditForgivenBreak');
  const streak = await readStreak(shownDate);
  if (streak.lastActiveDate !== shownDate) return;
  // No completedAt: an absence isn't a break taken at a particular hour, so it must not
  // feed the late/early counters — only the streak.
  await recordCompletion(shownDate);
}

// Called only when a break is genuinely completed, credited to the break's own date
// (see breakDate) FOR STREAK PURPOSES. Rolls the active day itself too: a break can be
// delivered and completed before the alarm's own notifyBreak() has marked anything.
//
// Returns whether it opened the (streak) day, same as markActiveDay.
async function recordCompletion(completedDate: string, completedAt?: Date): Promise<boolean> {
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

  // The DAILY mood counters use their own accounting date/instant — the actual
  // wall-clock moment this completion arrived (`completedAt`, or "now" for idle
  // forgiveness, which has no completedAt) — deliberately NOT `date` above. `date` can
  // be pinned to an older day (breakDueDate) or backdated by the clock-rollback guard;
  // keying the moods off it made a break shown 23:59 and completed 00:01 land on
  // different days depending on whether some unrelated event had already rolled the
  // counters over first. Reading straight off the wall clock removes that dependence.
  const counterAt = completedAt ?? new Date();
  const countersBefore = await readCounters(localDateStr(counterAt), counterAt.getTime());
  let counters = { ...countersBefore };
  if (openedDay) counters.activeDaysTotal += 1;
  // `completedAt` is absent for idle-forgiveness: an absence isn't a break taken at a
  // particular hour, so it must not colour the ghost's mood.
  const bucket = completedAt ? moodCounterForHour(completedAt.getHours()) : null;
  if (bucket) counters[bucket] += 1;
  counters = noteMood(counters, countersBefore, counterAt.getTime());

  if (streak.lastCompletedDate === date) {
    // Already counted toward the streak today, but the counters above still moved —
    // the third late-night break of one evening counts as much as the first.
    await commitProgress(streak, counters, counterAt);
    return openedDay;
  }
  const currentStreak = streak.currentStreak + 1; // rollActiveDay already zeroed a dead streak
  await commitProgress({ ...streak, currentStreak, lastCompletedDate: date }, counters, counterAt);
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
  // Two reasons to stay quiet and simply start the interval over. Neither is the user
  // ignoring us, so neither should burn a snooze or leave a ghost sitting on the page:
  //   1. The break is stale — the machine was asleep or Chrome was suspended, and this
  //      alarm is only firing now because everything overdue fires on wake.
  //   2. The screen is locked, which is unambiguously "nobody is here".
  // Plain 'idle' deliberately does NOT qualify: someone reading a long article or
  // watching a video registers as idle but is very much present — and is exactly who
  // needs the eye break.
  if (isStaleBreak(scheduler) || (await chrome.idle.queryState(PRESENCE_WINDOW_S)) === 'locked') {
    const quietNow = Date.now();
    await scheduleNext(quietNow, scheduler.cycleStep, effectiveBreaksToday(scheduler, quietNow));
    await resolveBreak(); // clear anything a previous nag left on screen
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
  // No callback passed, so @types/chrome resolves this to its void-returning overload —
  // there's nothing to await (the notification still fires; we just don't get its id).
  // Reusing BREAK_NOTIFICATION_ID updates the existing re-nag notification in place
  // instead of stacking a new one every 10 minutes.
  chrome.notifications.create(BREAK_NOTIFICATION_ID, {
    type: 'basic',
    iconUrl: 'icons/icon-128.png',
    title: isBigBreak ? n.bigTitle : n.microTitle,
    message: isBigBreak ? n.bigMessage : n.microMessage
  });
  // Re-check the pause state right before broadcasting rather than trusting the value
  // read at the top of this function — closes the narrow window where focus/off gets
  // turned on while this call is in flight.
  if (isPaused(await getSettings())) return;
  // The ghost is about to peek. That makes the break's day active for the streak —
  // but only if someone was actually here to see it (prepareShownBreak's presence
  // check); an alarm firing on an idle/locked machine must not count. Called directly,
  // not enqueued: this already IS the transaction.
  if (present) {
    await markActiveDay(dueDate);
    // Persisted separately from scheduler.breakDueDate, which the next scheduleNext()
    // call (a stale-break reschedule, a give-up, a pause) wipes back to null — idle
    // forgiveness needs to know the date of the last break actually shown to a present
    // user even after that happens. See the idle.onStateChanged listener below.
    await chrome.storage.local.set({ lastShownActiveDate: dueDate });
  }
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
  // No callback passed, so @types/chrome resolves this to its void-returning overload.
  // Clearing an id with nothing currently shown under it (no nag went out, or it was
  // already cleared) is a harmless no-op per the notifications API.
  chrome.notifications.clear(BREAK_NOTIFICATION_ID);
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
  // Same staleness rule as notifyBreak — switching tabs after a night's sleep must not
  // summon a break from yesterday. The alarm reschedules it moments later.
  if (isStaleBreak(scheduler)) return;
  // Another tab is already handling this exact break — nextBreakAt won't move until it
  // finishes, so without this a tab switch mid-session would summon a second copy.
  if (await sessionInProgress()) return;
  if (isPaused(await getSettings())) return;
  const shown = await prepareShownBreak(scheduler);
  chrome.tabs.sendMessage(tabId, { type: 'BREAK_DUE', breakKind: shown.scheduler.breakKind }, () => {
    // lastError means no content script in that tab (chrome://, store, etc.) — the
    // ghost was NOT shown, so neither the active-day mark nor the staleness anchor
    // below apply. This callback fires after the transaction has ended, so both need
    // their own.
    if (chrome.runtime.lastError) return;
    void enqueueWrite('deliverIfDue:shown', async () => {
      // A break shown here (not by the alarm) never touched lastBreakAt, so a LATER
      // alarm for this same break could measure staleness from an old/null anchor and
      // silently clear a ghost the user is looking at right now. Bump it the same way
      // notifyBreak's own nag does — showing the break IS the "acted on it" moment.
      const { scheduler: fresh } = await chrome.storage.local.get('scheduler') as { scheduler?: SchedulerState };
      // Only stamp a break that's still the SAME one just delivered — a TAKE_BREAK or
      // SNOOZE that landed in the meantime already replaced it with a new one, and
      // stamping that instead would let THIS (already-resolved) break's own later
      // alarm measure staleness from a fresh anchor and silently clear a ghost nobody
      // is looking at anymore.
      if (fresh && fresh.nextBreakAt === shown.scheduler.nextBreakAt) {
        await chrome.storage.local.set({ scheduler: { ...fresh, lastBreakAt: Date.now() } });
      }
      if (shown.present) {
        await markActiveDay(shown.dueDate);
        await chrome.storage.local.set({ lastShownActiveDate: shown.dueDate });
      }
    });
  });
}

// onInstalled fires for a fresh install AND every extension reload/update; onStartup
// fires every time Chrome itself launches. Resetting the schedule unconditionally on
// either would wipe today's progress (cycle step, breaksToday) just from reloading the
// extension or restarting the browser — reconcile against what's persisted instead,
// and only fall back to a fresh schedule when nothing exists yet.
// Brings the stored unlock list up to date with the counters, without needing a break
// to be completed first. Runs at startup so a threshold the user already passed (a new
// skin in a fresh release, or a seeded counter while testing) takes effect right away.
// Writes only when something actually changed.
async function syncUnlocks(): Promise<void> {
  assertInTransaction('syncUnlocks');
  const now = new Date();
  const today = localDateStr(now);
  const streak = await readStreak(today);
  const { counters: raw } = await chrome.storage.local.get('counters') as { counters?: Partial<Counters> };
  let counters = await readCounters(today, now.getTime());
  // Migration: a totally absent `counters` key predates this feature (v1.0.0/v1.1.0).
  // A live streak proves that many active days already happened, so seed the legendary
  // total from it — starting "21 days you've shown up" at 0 for someone who's already
  // shown up N days running in a row would read as progress being taken away. Older,
  // non-consecutive history from before any past reset can't be reconstructed and isn't
  // guessed at; this only ever raises the seed to match the CURRENT streak.
  const seeded = raw === undefined && streak.currentStreak > counters.activeDaysTotal;
  if (seeded) counters = { ...counters, activeDaysTotal: streak.currentStreak };
  if (!seeded && mergeUnlocks(streak, counters, now).added.length === 0) return;
  await commitProgress(streak, counters, now);
}

// A fresh service-worker instance can't blindly trust an OPEN screen-time segment left
// by a previous one — but whether that segment is still trustworthy depends on WHY the
// instance is fresh. If the browser was fully closed with a segment open, the closing
// idle/locked transition that would normally bank it never fires — chrome.idle only
// reports changes to a running listener — so the segment would otherwise sit open and
// silently absorb the entire closed-browser span the moment anything next reads it;
// that case must discard it. But an extension update/reload restarts the service worker
// while the browser (and the OS-level idle clock the segment's timestamp is measured
// against) never stopped — the previous instance's segment is exactly as valid as if
// this instance had opened it, so THAT case must bank it instead of losing however long
// it had already run. `bankOpenSegment` is how the two callers below tell this apart.
async function reconcileScreenTime(bankOpenSegment: boolean): Promise<void> {
  assertInTransaction('reconcileScreenTime');
  const now = new Date();
  const today = localDateStr(now);
  const raw = await readCounters(today, now.getTime());
  const settled = bankOpenSegment ? closeScreenSegment(raw, now.getTime()) : { ...raw, screenActiveSince: null };
  const state = await chrome.idle.queryState(PRESENCE_WINDOW_S);
  const counters = state === 'active' ? openScreenSegment(settled, now.getTime()) : settled;
  await chrome.storage.local.set({ counters });
}

async function reconcileSchedule(bankOpenSegment: boolean): Promise<void> {
  assertInTransaction('reconcileSchedule');
  // A fresh service-worker instance (extension reload/update, or the browser itself
  // relaunching) can't trust any idle-absence bookkeeping a PREVIOUS instance left
  // behind: if the browser was fully closed while the user was away, that absence's
  // eventual 'active' transition is never observed by anyone — chrome.idle only
  // reports state changes to a running listener — so a stale idleSince/
  // idleForgivenessDate/lastShownActiveDate would otherwise sit in storage
  // indefinitely and get consumed by whatever unrelated absence happens to end next,
  // crediting a day that has nothing to do with it.
  await chrome.storage.local.remove(['idleSince', 'idleForgivenessDate', 'lastShownActiveDate']);
  await syncUnlocks();
  await reconcileScreenTime(bankOpenSegment);
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
  if (details.reason === 'install') {
    // A fresh install also needs its screen-time segment opened against the CURRENT
    // idle state (see reconcileScreenTime) — without this, screenActiveSince stays
    // null from DEFAULT_COUNTERS until the first idle->active transition, silently
    // dropping however long the user is active before then. Nothing to bank yet, so
    // bankOpenSegment is moot here — pass false for consistency.
    void enqueueWrite('install', async () => { await scheduleNext(); await reconcileScreenTime(false); });
  } else if (details.reason === 'chrome_update') {
    // Unlike an extension-only update/reload below, 'chrome_update' means the BROWSER
    // itself just restarted — same as onStartup, so the open segment can't be trusted
    // (see reconcileScreenTime's own comment) and must be discarded, not banked.
    void enqueueWrite('reconcile', () => reconcileSchedule(false));
  } else {
    // An extension update/reload restarts the service worker without the browser itself
    // ever closing — see reconcileScreenTime's own comment for why that makes the
    // previous instance's open segment still trustworthy to bank.
    void enqueueWrite('reconcile', () => reconcileSchedule(true));
  }
  void injectIntoOpenTabs();
});
// The browser itself just relaunched — any segment left open by whatever instance was
// running before it closed can't be trusted (see reconcileScreenTime): discard it.
chrome.runtime.onStartup.addListener(() => { void enqueueWrite('reconcile', () => reconcileSchedule(false)); });
chrome.tabs.onActivated.addListener(({ tabId }) => { void enqueueWrite('deliverIfDue', () => deliverIfDue(tabId)); });

// Pausing (focus OR turning off) should feel immediate, not laggy by up to 5 minutes:
// pausing hides a ghost that's already showing right now instead of leaving it up until
// the next re-check alarm; unpausing re-delivers a break that's already due instead of
// making the user wait for that same re-check.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  if (changes.focusUntil) {
    // Captured HERE, synchronously, not inside the queued transaction below — the write
    // chain can be busy, and dating the change by when its transaction happens to run
    // (rather than when it actually fired) could push a 23:59:59 focus start onto the
    // wrong day's counters.
    const changedAt = new Date();
    const newlyPaused = Boolean(changes.focusUntil.newValue && (changes.focusUntil.newValue as number) > changedAt.getTime());
    const endsAt = typeof changes.focusUntil.newValue === 'number' ? changes.focusUntil.newValue : null;
    void enqueueWrite('focusChange', () => noteFocusChange(endsAt, changedAt));
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
    // A session already open in some tab is mid-break, not idly counting down — it
    // ignores BREAK_RESOLVED and keeps running until its own TAKE_BREAK (content.ts).
    // Rescheduling out from under it would null scheduler.breakDueDate, so a
    // completion landing after the pause starts would get credited to whatever day it
    // happens to finish on instead of the day the break was actually shown. Leave it
    // alone — TAKE_BREAK reschedules for real once that session ends either way.
    if (await sessionInProgress()) return;
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
    // Enqueued like every other reader of `scheduler`: a bare (unserialized) read here
    // raced a concurrent TAKE_BREAK/SNOOZE/notifyBreak transaction that's mid-write to
    // it, and — worse — the read/check/set was three separate steps with no lock
    // between them, so an idle→locked transition landing while the first snapshot's
    // set() was still in flight could see a not-yet-written idleSince and take a
    // second, conflicting snapshot.
    void enqueueWrite('idleSnapshot', async () => {
      const { idleSince, scheduler, lastShownActiveDate } = await chrome.storage.local.get(
        ['idleSince', 'scheduler', 'lastShownActiveDate']
      ) as { idleSince?: number; scheduler?: SchedulerState; lastShownActiveDate?: string };
      // idle → locked is a SECOND transition for the same absence (screen lock follows
      // idle) — don't overwrite the original snapshot, or the away duration
      // undercounts and a fresh read here could clobber the candidate this absence
      // actually started with.
      if (typeof idleSince === 'number') return;
      // Snapshotted at the moment THIS absence BEGINS, not re-read when it ends — by
      // the time 'active' fires, an alarm firing during the absence could have
      // rescheduled scheduler.breakDueDate to something unrelated (a stale reschedule,
      // a give-up cycling overnight), or lastShownActiveDate could have moved on from
      // an unrelated later peek. Tying the forgiveness candidate to absence START, not
      // absence END, is what makes it impossible for a LATER, unrelated absence to
      // ever reuse a pointer left over from this one.
      const idleForgivenessDate = scheduler?.breakDueDate
        ?? (typeof lastShownActiveDate === 'string' ? lastShownActiveDate : null);
      // lastShownActiveDate is consumed HERE, unconditionally — not only when it was
      // actually the source used above. Once any absence begins, the old "last shown"
      // signal is either already captured into idleForgivenessDate, or (if
      // breakDueDate was the source instead) superseded by that fresher signal either
      // way; leaving it in storage past this point is exactly what let a later,
      // unrelated absence's snapshot fall back to it.
      await chrome.storage.local.remove('lastShownActiveDate');
      await chrome.storage.local.set({ idleSince: Date.now(), idleForgivenessDate });
    });
    // Independent of the forgiveness bookkeeping above (own enqueueWrite, not folded
    // into it, so a future change to either can't accidentally couple them) — banks
    // whatever screen-time segment was running into today's total. Same serialized
    // chain, so this can't race a concurrent counters write from elsewhere.
    void enqueueWrite('closeScreenTime', async () => {
      const now = new Date();
      const today = localDateStr(now);
      const counters = closeScreenSegment(await readCounters(today, now.getTime()), now.getTime());
      await chrome.storage.local.set({ counters });
    });
    return;
  }
  if (newState === 'active') {
    void enqueueWrite('idleForgiveness', async () => {
      const { idleSince, idleForgivenessDate, scheduler } = await chrome.storage.local.get(
        ['idleSince', 'idleForgivenessDate', 'scheduler']
      ) as { idleSince?: number; idleForgivenessDate?: string | null; scheduler?: SchedulerState };
      // Removed unconditionally, before the pause/threshold checks below — this
      // snapshot belongs ONLY to the absence that just ended, whether or not it turns
      // out long enough to forgive, and whether or not reminders happen to be paused
      // right now. Leaving it past this point is exactly what let a later, unrelated
      // absence reuse it.
      await chrome.storage.local.remove(['idleSince', 'idleForgivenessDate']);
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
        const shownDate = idleForgivenessDate ?? null;
        const forgiveNow = Date.now();
        await scheduleNext(forgiveNow, ((s?.cycleStep ?? 0) + 1) % 3, effectiveBreaksToday(s, forgiveNow));
        await resolveBreak();
        // Streak credit only if the ghost had actually peeked at a present user — see
        // creditForgivenBreak for why an un-marked day must not be credited.
        if (shownDate) await creditForgivenBreak(shownDate);
      }
    });
    // Same independence as closeScreenTime above — opens a fresh segment now that the
    // user is demonstrably back, regardless of whether this absence was long enough to
    // forgive a break.
    void enqueueWrite('openScreenTime', async () => {
      const now = new Date();
      const today = localDateStr(now);
      const counters = openScreenSegment(await readCounters(today, now.getTime()), now.getTime());
      await chrome.storage.local.set({ counters });
    });
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'SNOOZE') {
    const snoozedAt = new Date();
    void enqueueWrite('SNOOZE', async () => {
      let snoozeUntil: number | null = null;
      try {
        // A break resolved through real interaction no longer needs an idle-forgiveness
        // fallback — leaving it would let an unrelated LATER absence (one that never
        // itself goes through an idle/locked transition to consume it first, see the
        // idle.onStateChanged listener) reuse this stale pointer and credit the wrong day.
        await chrome.storage.local.remove('lastShownActiveDate');
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
          // Snoozing IS acting on the break — the same thing lastBreakAt already means
          // for a nag (see its own comment on SchedulerState). Without this, a snooze
          // clicked a while after the last nag could measure as stale by the time its
          // own alarm fires and get silently rescheduled instead of delivered — the
          // "in 5 min" the user explicitly asked for just never arrives.
          //
          // snoozes is also reset to 0 here: it's notifyBreak's give-up counter, and an
          // explicit "in 5 min" is the opposite of ignoring the ghost. Without this, 3
          // prior ignored nags followed by this one snooze would make the give-up check
          // (scheduler.snoozes >= 3) skip the very break the user just asked to see
          // again — the promised return never arrives.
          await chrome.storage.local.set({ scheduler: { ...opened, nextBreakAt, lastBreakAt: snoozedAt.getTime(), snoozes: 0 } });
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
    // Enqueued like every other state write — an unserialized write here could land
    // between a concurrent transaction's read and write of scheduler/streak and be
    // invisible to it, reopening the very double-completion window this exists to
    // close. The sender doesn't pass a callback, so responding synchronously (rather
    // than waiting on the queued write) changes nothing it observes.
    void enqueueWrite('SESSION_STARTED', async () => {
      await chrome.storage.local.set({ sessionInProgressUntil: Date.now() + 10 * 60_000 });
      await resolveBreak();
    });
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
        // Same reasoning as SNOOZE: a break resolved through real interaction (complete
        // OR skip — either is an explicit resolution) no longer needs an idle-
        // forgiveness fallback sitting around for an unrelated later absence to reuse.
        await chrome.storage.local.remove(['sessionInProgressUntil', 'lastShownActiveDate']);
        const { scheduler } = await chrome.storage.local.get('scheduler') as { scheduler?: SchedulerState };
        const date = breakDate(scheduler, completedAt);
        const openedDay = completed ? await recordCompletion(date, completedAt) : await markActiveDay(date);
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
        let unlocked: Skin[] = [];
        try {
          ({ scheduler: fresh } = await chrome.storage.local.get('scheduler') as { scheduler?: SchedulerState });
          // Drain the celebration queue only on a genuine, SUCCEEDED completion — a
          // skip has no done card to show it on, and a failed transaction has nothing
          // to report, so either way anything queued is left for the next one rather
          // than being silently discarded here. This is what makes the "seen once"
          // ledger (mergeUnlocks/commitProgress) actually reach the screen: whatever
          // unlocked a skin — a peek that opened day 21, a cancelled focus session, a
          // startup sync — none of those have a UI moment of their own, so the reveal
          // always waits for whichever completed break happens next.
          //
          // Only the OLDEST entry is taken, not the whole queue: the done card can only
          // show one skin, and taking everything at once — as an earlier version did —
          // marked every queued skin "seen" while displaying just the last of them, so
          // anything queued alongside it (the legendary cat unlocked in the same
          // transaction as a mood or event, say) was celebrated exactly nowhere. One at
          // a time means a backlog drains one completed break at a time instead, which
          // is a small delay, never a silent loss.
          if (completed && ok) {
            const { pendingCelebration } = await chrome.storage.local.get('pendingCelebration') as { pendingCelebration?: Skin[] };
            if (Array.isArray(pendingCelebration) && pendingCelebration.length > 0) {
              const [next, ...rest] = pendingCelebration;
              unlocked = [next];
              if (rest.length > 0) await chrome.storage.local.set({ pendingCelebration: rest });
              else await chrome.storage.local.remove('pendingCelebration');
            }
          }
        } catch { /* answer with what we know rather than leaving the tab hanging */ }
        sendResponse({ ok, nextBreakAt: fresh?.nextBreakAt ?? null, breaksToday: fresh?.breaksToday ?? 0, unlocked });
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
        if (s && s.nextBreakAt <= Date.now() && !isStaleBreak(s) && !paused && !inSession) {
          const shown = await prepareShownBreak(s);
          response = { breakDue: true, breakKind: shown.scheduler.breakKind };
          // The content script shows the ghost on this response — same reasoning as
          // deliverIfDue: bump lastBreakAt so a later alarm for this same break can't
          // measure staleness from a stale/null anchor and silently clear it.
          await chrome.storage.local.set({ scheduler: { ...shown.scheduler, lastBreakAt: Date.now() } });
          if (shown.present) {
            await markActiveDay(shown.dueDate);
            await chrome.storage.local.set({ lastShownActiveDate: shown.dueDate });
          }
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
