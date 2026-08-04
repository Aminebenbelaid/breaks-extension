'use strict';

// ── Defaults ────────────────────────────────────────────────────────────────
const DEFAULTS = {
  microIntervalMin: 20,
  longIntervalMin: 60,
  microDurationSec: 30,
  longDurationSec: 300,
  showExercises: true,
  customTexts: [],
  soundEnabled: true,
  backgroundMode: 'plainDark',   // plainDark | solidColor | blurredScreen
  solidColorHex: '1a2a3a',
  overlayOpacity: 1.0,
  slowFadeEnabled: true,
  postponeMinutes: 5,
  warningMinutes: 1,
  naturalBreakEnabled: true,
  workHoursEnabled: false,
  workStartHour: 9,
  workEndHour: 18,
  workDays: [1, 2, 3, 4, 5],    // 0=Sun, 1=Mon … 6=Sat
};

// ── Helpers ──────────────────────────────────────────────────────────────────
function todayKey() { return new Date().toISOString().slice(0, 10); }

async function getSettings() {
  const { settings } = await chrome.storage.sync.get({ settings: {} });
  return { ...DEFAULTS, ...settings };
}

async function getState() {
  const { state } = await chrome.storage.local.get({ state: {} });
  return state;
}

async function patchState(patch) {
  const s = await getState();
  await chrome.storage.local.set({ state: { ...s, ...patch } });
}

async function getStats() {
  const { stats } = await chrome.storage.local.get({ stats: null });
  if (!stats || stats.date !== todayKey()) {
    const fresh = { breaksTaken: 0, breaksPostponed: 0, breaksSkipped: 0, naturalBreaks: 0, date: todayKey() };
    await chrome.storage.local.set({ stats: fresh });
    return fresh;
  }
  return stats;
}

async function saveStats(stats) {
  await chrome.storage.local.set({ stats: { ...stats, date: todayKey() } });
}

function isWithinWorkHours(settings) {
  if (!settings.workHoursEnabled) return true;
  const now = new Date();
  const day = now.getDay();
  const hr = now.getHours();
  return settings.workDays.includes(day) && hr >= settings.workStartHour && hr < settings.workEndHour;
}

// ── Alarm Setup ──────────────────────────────────────────────────────────────
async function setupAlarms(remainingMs = null) {
  const settings = await getSettings();
  const state = await getState();
  if (state.isPaused || state.isOnBreak) return;

  const now = Date.now();
  const microMs = remainingMs?.micro  ?? (state.microAlarmTime ? Math.max(0, state.microAlarmTime - now) : settings.microIntervalMin * 60000);
  const longMs  = remainingMs?.long   ?? (state.longAlarmTime  ? Math.max(0, state.longAlarmTime  - now) : settings.longIntervalMin * 60000);

  const microAlarmTime = now + microMs;
  const longAlarmTime  = now + longMs;
  await patchState({ microAlarmTime, longAlarmTime,
                     microIntervalMs: settings.microIntervalMin * 60000,
                     longIntervalMs:  settings.longIntervalMin  * 60000 });

  await chrome.alarms.clearAll();
  chrome.alarms.create('break_micro', { when: microAlarmTime });
  chrome.alarms.create('break_long',  { when: longAlarmTime });

  if (settings.warningMinutes > 0) {
    const warnMs = settings.warningMinutes * 60000;
    if (microAlarmTime - warnMs > now) chrome.alarms.create('warn_micro', { when: microAlarmTime - warnMs });
    if (longAlarmTime  - warnMs > now) chrome.alarms.create('warn_long',  { when: longAlarmTime  - warnMs });
  }
}

// ── Break Trigger ────────────────────────────────────────────────────────────
async function triggerBreak(type) {
  const settings = await getSettings();
  const state    = await getState();
  if (state.isOnBreak) return;

  if (!isWithinWorkHours(settings)) { await setupAlarms(); return; }

  // Natural break detection: idle > 5 min
  if (settings.naturalBreakEnabled) {
    const idleState = await new Promise(r => chrome.idle.queryState(300, r));
    if (idleState === 'idle' || idleState === 'locked') {
      const stats = await getStats();
      await saveStats({ ...stats, naturalBreaks: stats.naturalBreaks + 1 });
      await endBreak(type, true);
      return;
    }
  }

  const exercises  = await loadExercises();
  const matching   = exercises.filter(e => e.duration === type);
  const exercise   = settings.showExercises && matching.length ? matching[Math.floor(Math.random() * matching.length)] : null;
  const customText = settings.customTexts.length ? settings.customTexts[Math.floor(Math.random() * settings.customTexts.length)] : null;
  const duration   = type === 'long' ? settings.longDurationSec : settings.microDurationSec;

  const breakData = {
    type, duration, exercise, customText,
    backgroundMode: settings.backgroundMode,
    solidColorHex:  settings.solidColorHex,
    overlayOpacity: settings.overlayOpacity,
    slowFadeEnabled: settings.slowFadeEnabled,
    soundEnabled:   settings.soundEnabled,
    postponeMinutes: settings.postponeMinutes,
  };

  await chrome.storage.local.set({ currentBreak: breakData });
  await patchState({ isOnBreak: true, currentBreakType: type });

  // Inject into active tab
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id && tab.url && !tab.url.startsWith('chrome://') && !tab.url.startsWith('chrome-extension://')) {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content/overlay.js'] }).catch(() => {});
      await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['content/overlay.css'] }).catch(() => {});
      await new Promise(r => setTimeout(r, 100));
      await chrome.tabs.sendMessage(tab.id, { action: 'startBreak', data: breakData });
      return;
    }
  } catch (_) {}
}

async function endBreak(type, skipped = false) {
  const settings = await getSettings();
  const state    = await getState();
  const now      = Date.now();

  await patchState({ isOnBreak: false, currentBreakType: null });
  await chrome.storage.local.remove('currentBreak');

  if (!skipped) {
    const stats = await getStats();
    await saveStats({ ...stats, breaksTaken: stats.breaksTaken + 1 });
  }

  // Long break resets both; micro only resets micro
  const microMs = settings.microIntervalMin * 60000;
  const longMs  = type === 'long'
    ? settings.longIntervalMin * 60000
    : Math.max(0, (state.longAlarmTime || now) - now);

  await setupAlarms({ micro: microMs, long: longMs });
  notifyPopup({ type: 'stateChanged' });
}

async function postponeBreak(breakType, minutes) {
  const settings = await getSettings();
  const state    = await getState();
  const now      = Date.now();

  const stats = await getStats();
  await saveStats({ ...stats, breaksPostponed: stats.breaksPostponed + 1 });

  await patchState({ isOnBreak: false, currentBreakType: null });
  await chrome.storage.local.remove('currentBreak');

  const postponeMs = minutes * 60000;
  const microMs = breakType === 'micro' ? postponeMs : Math.max(0, (state.microAlarmTime || now) - now);
  const longMs  = breakType === 'long'  ? postponeMs : Math.max(0, (state.longAlarmTime  || now) - now);

  await setupAlarms({ micro: microMs, long: longMs });
  notifyPopup({ type: 'stateChanged' });
}

// ── Exercises ────────────────────────────────────────────────────────────────
let _exercisesCache = null;
async function loadExercises() {
  if (_exercisesCache) return _exercisesCache;
  const r = await fetch(chrome.runtime.getURL('data/exercises.json'));
  _exercisesCache = await r.json();
  return _exercisesCache;
}

// ── Alarm Handler ────────────────────────────────────────────────────────────
chrome.alarms.onAlarm.addListener(async ({ name }) => {
  if (name === 'break_long')  await triggerBreak('long');
  else if (name === 'break_micro') await triggerBreak('micro');
  else if (name === 'warn_micro' || name === 'warn_long') {
    const settings = await getSettings();
    const label = name === 'warn_long' ? 'Long' : 'Micro';
    // Show a subtle badge update — no notification permission needed
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({ color: '#d4af37' });
    setTimeout(() => chrome.action.setBadgeText({ text: '' }), settings.warningMinutes * 60000);
  }
});

// ── Message Handler ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case 'getState': {
        const [state, settings, stats, alarms] = await Promise.all([
          getState(), getSettings(), getStats(), chrome.alarms.getAll()
        ]);
        sendResponse({ state, settings, stats, alarms: alarms.map(a => ({ name: a.name, scheduledTime: a.scheduledTime })) });
        break;
      }
      case 'pause': {
        const state = await getState();
        const now = Date.now();
        await patchState({
          isPaused: true,
          microRemainingMs: Math.max(0, (state.microAlarmTime || now) - now),
          longRemainingMs:  Math.max(0, (state.longAlarmTime  || now) - now),
        });
        await chrome.alarms.clearAll();
        sendResponse({ ok: true });
        break;
      }
      case 'resume': {
        const state = await getState();
        await patchState({ isPaused: false });
        await setupAlarms({ micro: state.microRemainingMs, long: state.longRemainingMs });
        sendResponse({ ok: true });
        break;
      }
      case 'triggerBreak':   await triggerBreak(msg.breakType);                          sendResponse({ ok: true }); break;
      case 'endBreak':       await endBreak(msg.breakType, msg.skipped || false);        sendResponse({ ok: true }); break;
      case 'postponeBreak':  await postponeBreak(msg.breakType, msg.minutes);            sendResponse({ ok: true }); break;
      case 'settingsChanged': {
        if (msg.intervalsChanged) {
          const s = await getSettings();
          await patchState({ microAlarmTime: null, longAlarmTime: null });
          await setupAlarms({ micro: s.microIntervalMin * 60000, long: s.longIntervalMin * 60000 });
        }
        sendResponse({ ok: true });
        break;
      }
      case 'resetStats': await saveStats({ breaksTaken: 0, breaksPostponed: 0, breaksSkipped: 0, naturalBreaks: 0, date: todayKey() }); sendResponse({ ok: true }); break;
      case 'skipBreak': {
        const stats = await getStats();
        await saveStats({ ...stats, breaksSkipped: stats.breaksSkipped + 1 });
        await endBreak(msg.breakType, true);
        sendResponse({ ok: true });
        break;
      }
    }
  })();
  return true;
});

// ── Startup ──────────────────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(async () => {
  const { settings } = await chrome.storage.sync.get({ settings: null });
  if (!settings) await chrome.storage.sync.set({ settings: DEFAULTS });
  await setupAlarms();
});

chrome.runtime.onStartup.addListener(async () => {
  const state = await getState();
  if (!state.isPaused) await setupAlarms();
});

function notifyPopup(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}
