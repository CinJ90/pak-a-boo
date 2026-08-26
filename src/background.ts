import { DEFAULT_SETTINGS, DEFAULT_STREAK, SKIN_MILESTONES, isYesterday, localDateStr, type SchedulerState, type Settings, type Skin, type StreakState } from './types';

const ALARM_NAME = 'pak-a-boo-next-break';
// chrome.idle only tracks physical mouse/keyboard input — it can't tell "genuinely away"
// apart from "sitting still watching the countdown," which looks identical to it. Never
// treat idle as "away" for less than this floor, however short the break interval is.
const MIN_AWAY_MS = 15 * 60_000;

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
  const settings = await getSettings();
  const breakKind = cycleStep === 2 ? 'big' : 'micro';
  const intervalMinutes = breakKind === 'big' ? settings.bigMinutes : settings.microMinutes;
  const state: SchedulerState = {
    nextBreakAt: from + intervalMinutes * 60_000,
    breakKind,
    cycleStep,
    snoozes: 0,
    breaksToday,
    lastBreakAt: null,
    scheduledMinutes: intervalMinutes
  };
  await chrome.storage.local.set({ scheduler: state });
  await chrome.alarms.clear(ALARM_NAME);
  await chrome.alarms.create(ALARM_NAME, { when: state.nextBreakAt });
}

// Called only when a break is genuinely completed. Lives in its own storage key
// rather than SchedulerState, which scheduleNext() fully replaces from 8 different
// call sites — folding streak fields in there would mean threading them through
// every one of those just to avoid clobbering them on the next unrelated reschedule.
// `today` is captured when the completion message arrives, not when this runs, so a
// write delayed past local midnight still counts toward the day the break happened.
let streakWrite: Promise<void> = Promise.resolve();

async function recordCompletion(today: Date): Promise<void> {
  const { streak } = await chrome.storage.local.get({ streak: DEFAULT_STREAK }) as { streak: StreakState };
  const todayStr = localDateStr(today);
  if (streak.lastCompletedDate === todayStr) return; // already counted today
  const currentStreak = isYesterday(streak.lastCompletedDate, today) ? streak.currentStreak + 1 : 1;
  const unlockedSkins = [...streak.unlockedSkins];
  for (const [skin, threshold] of Object.entries(SKIN_MILESTONES) as [Skin, number][]) {
    if (currentStreak >= threshold && !unlockedSkins.includes(skin)) unlockedSkins.push(skin);
  }
  await chrome.storage.local.set({ streak: { currentStreak, lastCompletedDate: todayStr, unlockedSkins } });
}

async function notifyBreak(): Promise<void> {
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
    await scheduleNext(Date.now(), scheduler.cycleStep, scheduler.breaksToday);
    return;
  }
  // Ghost gives up after enough ignored nags: skip to the next cycle instead of sulking forever.
  if (scheduler.snoozes >= 3) {
    await scheduleNext(Date.now(), (scheduler.cycleStep + 1) % 3, scheduler.breaksToday);
    await resolveBreak();
    return;
  }

  const isBigBreak = scheduler.breakKind === 'big';
  await chrome.storage.local.set({
    scheduler: { ...scheduler, snoozes: scheduler.snoozes + 1, lastBreakAt: Date.now() }
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
  await broadcast({ type: 'BREAK_DUE', breakKind: scheduler.breakKind });
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
  const { scheduler } = await chrome.storage.local.get('scheduler') as { scheduler?: SchedulerState };
  if (!scheduler || scheduler.nextBreakAt > Date.now()) return;
  // Another tab is already handling this exact break — nextBreakAt won't move until it
  // finishes, so without this a tab switch mid-session would summon a second copy.
  if (await sessionInProgress()) return;
  if (isPaused(await getSettings())) return;
  chrome.tabs.sendMessage(tabId, { type: 'BREAK_DUE', breakKind: scheduler.breakKind }, () => {
    void chrome.runtime.lastError; // tab without a content script — expected, ignore
  });
}

// onInstalled fires for a fresh install AND every extension reload/update; onStartup
// fires every time Chrome itself launches. Resetting the schedule unconditionally on
// either would wipe today's progress (cycle step, breaksToday) just from reloading the
// extension or restarting the browser — reconcile against what's persisted instead,
// and only fall back to a fresh schedule when nothing exists yet.
async function reconcileSchedule(): Promise<void> {
  const { scheduler } = await chrome.storage.local.get('scheduler') as { scheduler?: SchedulerState };
  if (!scheduler) { await scheduleNext(); return; }
  const settings = await getSettings();
  const configuredMinutes = scheduler.breakKind === 'big' ? settings.bigMinutes : settings.microMinutes;
  if (scheduler.scheduledMinutes !== configuredMinutes || scheduler.nextBreakAt <= Date.now()) {
    // The interval changed or the persisted break is already overdue — recompute from
    // now, but keep the cycle position and today's count, same as any other reload.
    await scheduleNext(Date.now(), scheduler.cycleStep, scheduler.breaksToday);
    return;
  }
  await chrome.alarms.create(ALARM_NAME, { when: scheduler.nextBreakAt });
}

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') void scheduleNext();
  else void reconcileSchedule();
  void injectIntoOpenTabs();
});
chrome.runtime.onStartup.addListener(() => { void reconcileSchedule(); });
chrome.tabs.onActivated.addListener(({ tabId }) => { void deliverIfDue(tabId); });

// Pausing (focus OR turning off) should feel immediate, not laggy by up to 5 minutes:
// pausing hides a ghost that's already showing right now instead of leaving it up until
// the next re-check alarm; unpausing re-delivers a break that's already due instead of
// making the user wait for that same re-check.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  if (changes.focusUntil) {
    const newlyPaused = Boolean(changes.focusUntil.newValue && (changes.focusUntil.newValue as number) > Date.now());
    void reactToPauseChange(newlyPaused);
  }
  if (changes.enabled) {
    void reactToPauseChange(changes.enabled.newValue === false);
  }
});

async function reactToPauseChange(newlyPaused: boolean): Promise<void> {
  const { scheduler } = await chrome.storage.local.get('scheduler') as { scheduler?: SchedulerState };
  if (!scheduler) return;
  if (newlyPaused) {
    // Reset the countdown the moment a pause starts — the interval that was already
    // ticking down shouldn't keep silently expiring in the background while paused,
    // only to surface as an overdue break the instant you come back.
    await scheduleNext(Date.now(), scheduler.cycleStep, scheduler.breaksToday);
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
  await scheduleNext(Date.now(), scheduler.cycleStep, scheduler.breaksToday);
}
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) void notifyBreak();
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
    void chrome.storage.local.get(['idleSince', 'scheduler']).then(async ({ idleSince, scheduler }) => {
      await chrome.storage.local.remove('idleSince');
      // A short pause (checking your phone, thinking, or just watching the countdown
      // without touching the mouse) should NOT reset it — only forgive it as "break
      // taken" for a genuinely long absence.
      const settings = await getSettings();
      if (isPaused(settings)) return;
      const s = scheduler as SchedulerState | undefined;
      const thresholdMinutes = s?.breakKind === 'big' ? settings.bigMinutes : settings.microMinutes;
      const awayMs = typeof idleSince === 'number' ? Date.now() - idleSince : 0;
      if (awayMs >= Math.max(thresholdMinutes * 60_000, MIN_AWAY_MS)) {
        // "Forgiven" means this break counts as taken — advance one cycle step like
        // TAKE_BREAK does, not a full reset back to step 0 (which was also silently
        // wiping the whole day's breaksToday count on every long absence).
        await scheduleNext(Date.now(), ((s?.cycleStep ?? 0) + 1) % 3, s?.breaksToday ?? 0);
        await resolveBreak();
      }
    });
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'SNOOZE') {
    void chrome.storage.local.get('scheduler').then(async ({ scheduler }) => {
      const s = scheduler as SchedulerState | undefined;
      // Snooze DELAYS whatever's pending — it must never pull a break EARLIER. If the
      // next break isn't due for another 18 minutes, "snooze 5 min" should add 5
      // minutes to that, not replace it with "5 minutes from now".
      const base = Math.max(s?.nextBreakAt ?? 0, Date.now());
      const nextBreakAt = base + 5 * 60_000;
      if (s) await chrome.storage.local.set({ scheduler: { ...s, nextBreakAt } });
      await chrome.alarms.create(ALARM_NAME, { when: nextBreakAt });
      await resolveBreak();
    });
    sendResponse({ ok: true });
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
    // Capture arrival time up front: recordCompletion runs later (and serialized), and
    // a completion that arrives at 23:59 must count toward that day even if the write
    // itself lands after midnight.
    const completedAt = new Date();
    // Default missing/malformed data to "not completed" — safer to undercount than
    // to let a malformed message inflate the stat.
    const completed = message.completed === true;
    // Enqueue SYNCHRONOUSLY, before any await, so completions join the serialized
    // chain in arrival order — enqueueing later (after the scheduler read/write)
    // would let two messages' async work race and enqueue out of order. The catch
    // both logs the failure and keeps the chain usable for the next completion.
    const pendingStreak = completed
      ? (streakWrite = streakWrite
          .then(() => recordCompletion(completedAt))
          .catch((e) => console.error('Pak-a-boo: streak update failed', e)))
      : null;
    void chrome.storage.local.remove('sessionInProgressUntil');
    void chrome.storage.local.get('scheduler').then(async ({ scheduler }) => {
      const s = scheduler as SchedulerState | undefined;
      await scheduleNext(Date.now(), ((s?.cycleStep ?? 0) + 1) % 3, (s?.breaksToday ?? 0) + (completed ? 1 : 0));
      if (pendingStreak) await pendingStreak;
      void resolveBreak();
      const { scheduler: fresh } = await chrome.storage.local.get('scheduler') as { scheduler?: SchedulerState };
      sendResponse({ ok: true, nextBreakAt: fresh?.nextBreakAt ?? null, breaksToday: fresh?.breaksToday ?? 0 });
    });
  }
  if (message.type === 'RESET_CYCLE') {
    void getSettings().then(async (settings) => {
      // The popup already disables this button while paused, but the background must
      // not just trust that — a click landing right as focus/off toggles shouldn't be
      // able to move the cycle position while reminders are supposed to be silent.
      if (isPaused(settings)) { sendResponse({ ok: false }); return; }
      // A session already open in some tab isn't tied to the reset — it ignores
      // BREAK_RESOLVED while active (see content.ts), so resetting out from under it
      // would leave that tab's eventual TAKE_BREAK advancing the wrong cycle position.
      // Decline instead, same as notifyBreak() deferring its re-nag in this situation.
      if (await sessionInProgress()) { sendResponse({ ok: false }); return; }
      // A manual restart — same cleanup as a completed break (clear any stuck
      // in-progress/lapsed-pause flags) but back to cycle step 0 instead of +1, and
      // today's completed-break count is untouched since that's a separate stat.
      await chrome.storage.local.remove(['sessionInProgressUntil', 'pausedLastCheck']);
      const { scheduler } = await chrome.storage.local.get('scheduler') as { scheduler?: SchedulerState };
      await scheduleNext(Date.now(), 0, scheduler?.breaksToday ?? 0);
      await resolveBreak();
      sendResponse({ ok: true });
    });
  }
  if (message.type === 'CONTENT_READY') {
    void chrome.storage.local.get('scheduler').then(async ({ scheduler }) => {
      const s = scheduler as SchedulerState | undefined;
      const settings = await getSettings();
      const inSession = await sessionInProgress();
      if (s && s.nextBreakAt <= Date.now() && !isPaused(settings) && !inSession) {
        sendResponse({ breakDue: true, breakKind: s.breakKind });
      } else {
        sendResponse({ breakDue: false });
      }
    });
  }
  return true;
});
