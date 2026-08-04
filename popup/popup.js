'use strict';

const CIRC = 364.4; // 2π × 58
let settings = {};
let currentTab = 'timers';

// ── Safe message send ─────────────────────────────────────────────────────────
function send(msg, cb) {
  chrome.runtime.sendMessage(msg, response => {
    if (chrome.runtime.lastError) { cb && cb(null); return; }
    cb && cb(response);
  });
}

// ── View switching ────────────────────────────────────────────────────────────
document.getElementById('settingsBtn').addEventListener('click', () => showView('settingsView'));
document.getElementById('backBtn').addEventListener('click', () => showView('mainView'));

function showView(id) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  if (id === 'settingsView') loadSettings();
}

// ── Main view ─────────────────────────────────────────────────────────────────
function fmt(ms) {
  if (ms <= 0) return '0:00';
  const s = Math.ceil(ms / 1000), m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

function updateMain() {
  send({ type: 'getState' }, res => {
    if (!res) return;
    const { state = {}, settings: s = {}, stats = {}, alarms = [] } = res;
    settings = s;
    const now = Date.now();
    const paused = !!state.isPaused;

    // Status
    const dot = document.getElementById('statusDot');
    const txt = document.getElementById('statusText');
    if (dot) dot.className = 'status-dot' + (paused ? ' paused' : '');
    if (txt) txt.textContent = paused ? 'Paused' : 'Running';

    // Pause button
    const pi = document.getElementById('pauseIcon');
    const pl = document.getElementById('pauseLabel');
    if (pi) pi.textContent = paused ? '▶' : '⏸';
    if (pl) pl.textContent = paused ? 'Resume' : 'Pause';

    // Rings
    if (paused) {
      setRing('micro', '--:--', 0);
      setRing('long',  '--:--', 0);
    } else {
      const microAlarm = alarms.find(a => a.name === 'break_micro');
      const longAlarm  = alarms.find(a => a.name === 'break_long');
      if (microAlarm) {
        const rem = microAlarm.scheduledTime - now;
        setRing('micro', fmt(rem), rem / (state.microIntervalMs || (s.microIntervalMin || 20) * 60000));
      }
      if (longAlarm) {
        const rem = longAlarm.scheduledTime - now;
        setRing('long', fmt(rem), rem / (state.longIntervalMs || (s.longIntervalMin || 60) * 60000));
      }
    }

    // Stats
    const el = id => document.getElementById(id);
    if (el('statTaken'))     el('statTaken').textContent     = stats.breaksTaken     ?? 0;
    if (el('statPostponed')) el('statPostponed').textContent = stats.breaksPostponed ?? 0;
    if (el('statSkipped'))   el('statSkipped').textContent   = stats.breaksSkipped   ?? 0;
  });
}

function setRing(type, time, fraction) {
  const timeEl = document.getElementById(`${type}Time`);
  const ringEl = document.getElementById(`${type}Ring`);
  if (timeEl) timeEl.textContent = time;
  if (ringEl) {
    const offset = CIRC * (1 - Math.max(0, Math.min(1, 1 - fraction)));
    ringEl.style.strokeDashoffset = offset;
  }
}

// Pause / Resume
document.getElementById('pauseBtn').addEventListener('click', () => {
  const isPaused = document.getElementById('pauseLabel').textContent === 'Resume';
  send({ type: isPaused ? 'resume' : 'pause' }, () => updateMain());
});

// Take a Break
let pickerOpen = false;
document.getElementById('breakNowBtn').addEventListener('click', () => {
  pickerOpen = !pickerOpen;
  document.getElementById('breakTypePicker').classList.toggle('hidden', !pickerOpen);
});
document.querySelectorAll('.pick-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    send({ type: 'triggerBreak', breakType: btn.dataset.type });
    pickerOpen = false;
    document.getElementById('breakTypePicker').classList.add('hidden');
    window.close();
  });
});

updateMain();
setInterval(updateMain, 1000);

// ── Settings ──────────────────────────────────────────────────────────────────
function loadSettings() {
  send({ type: 'getState' }, res => {
    if (!res) return;
    const { settings: s = {}, stats = {} } = res;
    settings = { ...s };
    renderTab(currentTab, stats);
  });
}

// Tabs
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    currentTab = tab.dataset.tab;
    send({ type: 'getState' }, res => renderTab(currentTab, res?.stats));
  });
});

// Save
document.getElementById('saveBtn').addEventListener('click', () => {
  const intervalsChanged = settings._origMicroInterval !== settings.microIntervalMin
                        || settings._origLongInterval  !== settings.longIntervalMin;
  const toSave = { ...settings };
  delete toSave._origMicroInterval;
  delete toSave._origLongInterval;
  delete toSave._opacityPct;
  chrome.storage.sync.set({ settings: toSave }, () => {
    send({ type: 'settingsChanged', intervalsChanged });
    const btn = document.getElementById('saveBtn');
    btn.textContent = '✓'; btn.classList.add('saved');
    setTimeout(() => { btn.textContent = 'Save'; btn.classList.remove('saved'); }, 1500);
  });
});

function renderTab(tab, stats) {
  const c = document.getElementById('tabContent');
  if (!c) return;
  settings._origMicroInterval = settings._origMicroInterval ?? settings.microIntervalMin;
  settings._origLongInterval  = settings._origLongInterval  ?? settings.longIntervalMin;
  settings._opacityPct        = Math.round((settings.overlayOpacity ?? 1) * 100);
  switch (tab) {
    case 'timers':   c.innerHTML = timersHTML();   wireTimers();   break;
    case 'look':     c.innerHTML = lookHTML();     wireLook();     break;
    case 'content':  c.innerHTML = contentHTML();  wireContent();  break;
    case 'schedule': c.innerHTML = scheduleHTML(); wireSchedule(); break;
    case 'stats':    c.innerHTML = statsHTML(stats); wireStats(stats); break;
  }
}

// ── Shared helpers ────────────────────────────────────────────────────────────
function card(title, inner) {
  return `<div class="card"><div class="card-title">${title}</div>${inner}</div>`;
}
function freeRow(label, key, unit) {
  const val = settings[key] ?? 0;
  return `<div class="s-row">
    <span class="s-label">${label}</span>
    <input class="num-input" type="number" min="0" data-key="${key}" value="${val}">
    <span class="unit">${unit}</span>
    <div class="stepper">
      <button data-step="1"  data-key="${key}">▲</button>
      <button data-step="-1" data-key="${key}">▼</button>
    </div>
  </div>`;
}
function toggleRow(label, key) {
  return `<div class="s-row">
    <span class="s-label">${label}</span>
    <label class="toggle">
      <input type="checkbox" data-key="${key}" ${settings[key] ? 'checked' : ''}>
      <span class="toggle-track"></span>
    </label>
  </div>`;
}
function wireNumInputs() {
  document.querySelectorAll('.num-input[data-key]').forEach(inp => {
    inp.addEventListener('input', () => {
      const v = Math.max(0, parseInt(inp.value) || 0);
      settings[inp.dataset.key] = v;
      // Sync overlayOpacity from _opacityPct
      if (inp.dataset.key === '_opacityPct') settings.overlayOpacity = Math.max(0.4, Math.min(1, v / 100));
    });
  });
  document.querySelectorAll('.stepper button[data-key]').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.key, step = parseInt(btn.dataset.step);
      settings[key] = Math.max(0, (settings[key] || 0) + step);
      if (key === '_opacityPct') settings.overlayOpacity = Math.max(0.4, Math.min(1, settings[key] / 100));
      const inp = document.querySelector(`.num-input[data-key="${key}"]`);
      if (inp) inp.value = settings[key];
    });
  });
}
function wireToggles() {
  document.querySelectorAll('input[type=checkbox][data-key]').forEach(inp => {
    inp.addEventListener('change', () => { settings[inp.dataset.key] = inp.checked; });
  });
}
function escHtml(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

// ── Timers Tab ────────────────────────────────────────────────────────────────
function timersHTML() {
  return card('Micro Break', freeRow('Every', 'microIntervalMin', 'min') + freeRow('Duration', 'microDurationSec', 'sec'))
       + card('Long Break',  freeRow('Every', 'longIntervalMin',  'min') + freeRow('Duration', 'longDurationSec',  'sec'))
       + card('Behavior',
           freeRow('Warn before break', 'warningMinutes', 'min')
         + freeRow('Postpone by', 'postponeMinutes', 'min')
         + toggleRow('Natural break detection', 'naturalBreakEnabled')
         + toggleRow('Slow fade-in', 'slowFadeEnabled')
         + toggleRow('Sound', 'soundEnabled')
       )
       + `<button class="preview-btn" id="previewBtn">▶ Preview Break (10s)</button>`;
}
function wireTimers() {
  wireNumInputs(); wireToggles();
  document.getElementById('previewBtn')?.addEventListener('click', () => {
    send({ type: 'triggerBreak', breakType: 'micro', testDuration: 10 });
    window.close();
  });
}

// ── Look Tab ──────────────────────────────────────────────────────────────────
function lookHTML() {
  const modes = [['plainDark','Plain Dark'],['blurredScreen','Blurred Screen'],['solidColor','Solid Color']];
  const opts = modes.map(([v,l]) => `<option value="${v}" ${settings.backgroundMode===v?'selected':''}>${l}</option>`).join('');
  const colorRow = settings.backgroundMode === 'solidColor'
    ? `<div class="s-row"><span class="s-label">Color</span><input type="color" class="color-well" id="colorWell" value="#${settings.solidColorHex || '1a2a3a'}"></div>`
    : '';
  return card('Background',
      `<div class="s-row"><span class="s-label">Mode</span>
       <select class="setting-select" id="bgMode">${opts}</select></div>${colorRow}`)
    + card('Overlay', freeRow('Opacity %', '_opacityPct', '%'));
}
function wireLook() {
  document.getElementById('bgMode')?.addEventListener('change', e => {
    settings.backgroundMode = e.target.value;
    const c = document.getElementById('tabContent');
    c.innerHTML = lookHTML(); wireLook();
  });
  document.getElementById('colorWell')?.addEventListener('input', e => {
    settings.solidColorHex = e.target.value.replace('#', '');
  });
  wireNumInputs();
}

// ── Content Tab ───────────────────────────────────────────────────────────────
function contentHTML() {
  const items = (settings.customTexts || []).map((t, i) =>
    `<div class="custom-item"><span>${escHtml(t)}</span><button class="del-btn" data-idx="${i}">×</button></div>`
  ).join('');
  return card('Extras', toggleRow('Show exercises', 'showExercises'))
       + card('Custom Reminders',
           `<div class="hint">Shown randomly on your break screen</div>
            <div class="s-row">
              <input class="text-input" id="newText" placeholder="Add reminder…">
              <button class="add-btn" id="addTextBtn">Add</button>
            </div>
            <div class="custom-list">${items}</div>`);
}
function wireContent() {
  wireToggles();
  document.getElementById('addTextBtn')?.addEventListener('click', () => {
    const inp = document.getElementById('newText');
    const v = inp.value.trim();
    if (!v) return;
    settings.customTexts = [...(settings.customTexts || []), v];
    inp.value = '';
    const c = document.getElementById('tabContent');
    c.innerHTML = contentHTML(); wireContent();
  });
  document.getElementById('newText')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('addTextBtn')?.click();
  });
  document.querySelectorAll('.del-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      settings.customTexts.splice(parseInt(btn.dataset.idx), 1);
      const c = document.getElementById('tabContent');
      c.innerHTML = contentHTML(); wireContent();
    });
  });
}

// ── Schedule Tab ──────────────────────────────────────────────────────────────
const DAY_LABELS = ['Su','Mo','Tu','We','Th','Fr','Sa'];
function scheduleHTML() {
  const days = DAY_LABELS.map((d, i) => {
    const on = (settings.workDays || []).includes(i) ? 'on' : '';
    return `<button class="day-btn ${on}" data-day="${i}">${d}</button>`;
  }).join('');
  const hrOpts = sel => Array.from({length:24}, (_,i) =>
    `<option value="${i}" ${i===sel?'selected':''}>${i}:00</option>`).join('');
  return card('Work Hours',
    toggleRow('Only break during work hours', 'workHoursEnabled')
    + (settings.workHoursEnabled ? `
      <div class="s-divider"></div>
      <div class="s-row"><span class="s-label">Start</span>
        <select class="setting-select" id="startHr">${hrOpts(settings.workStartHour)}</select></div>
      <div class="s-row"><span class="s-label">End</span>
        <select class="setting-select" id="endHr">${hrOpts(settings.workEndHour)}</select></div>
      <div class="days-row">${days}</div>` : ''));
}
function wireSchedule() {
  wireToggles();
  document.querySelector('input[data-key="workHoursEnabled"]')?.addEventListener('change', () => {
    document.getElementById('tabContent').innerHTML = scheduleHTML(); wireSchedule();
  });
  document.getElementById('startHr')?.addEventListener('change', e => { settings.workStartHour = +e.target.value; });
  document.getElementById('endHr')?.addEventListener('change',   e => { settings.workEndHour   = +e.target.value; });
  document.querySelectorAll('.day-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const d = +btn.dataset.day;
      const days = settings.workDays || [];
      settings.workDays = days.includes(d) ? days.filter(x => x !== d) : [...days, d];
      btn.classList.toggle('on');
    });
  });
}

// ── Stats Tab ─────────────────────────────────────────────────────────────────
function statsHTML(stats) {
  const s = stats || {};
  const row = (color, label, val) =>
    `<div class="s-stat-row">
       <div class="s-stat-dot" style="background:${color}"></div>
       <span class="s-stat-label">${label}</span>
       <span class="s-stat-val" style="color:${color}">${val || 0}</span>
     </div>`;
  return card('Today',
      row('#4ecdc4', 'Breaks taken',    s.breaksTaken)
    + row('#d4af37', 'Natural breaks',  s.naturalBreaks)
    + row('#f0a050', 'Postponed',       s.breaksPostponed)
    + row('#e07a5f', 'Skipped',         s.breaksSkipped)
  ) + `<button class="reset-btn" id="resetStats">Reset today's stats</button>`;
}
function wireStats() {
  document.getElementById('resetStats')?.addEventListener('click', () => {
    send({ type: 'resetStats' }, () => {
      send({ type: 'getState' }, res => {
        document.getElementById('tabContent').innerHTML = statsHTML(res?.stats);
        wireStats();
        updateMain();
      });
    });
  });
}

// Listen for background notifications
chrome.runtime.onMessage.addListener(msg => {
  if (msg && msg.type === 'stateChanged') updateMain();
});
