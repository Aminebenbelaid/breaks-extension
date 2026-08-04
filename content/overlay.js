(function () {
  'use strict';

  // Prevent duplicate script execution
  if (window.__breaksInjected) return;
  window.__breaksInjected = true;

  let overlayEl = null, shadowRoot = null, ticker = null;
  let remaining = 0, currentBgMode = 'plainDark';

  function createOverlay(data) {
    if (overlayEl) removeOverlay();

    currentBgMode = data.backgroundMode || 'plainDark';
    remaining = data.duration;

    // Blur page for blurredScreen mode
    if (currentBgMode === 'blurredScreen') {
      document.documentElement.style.transition = 'filter .8s ease';
      document.documentElement.style.filter = 'blur(6px)';
    }

    overlayEl = document.createElement('div');
    overlayEl.style.cssText = [
      'position:fixed', 'top:0', 'left:0', 'width:100vw', 'height:100vh',
      'z-index:2147483647', 'display:flex', 'align-items:center', 'justify-content:center'
    ].join(';') + ';';

    shadowRoot = overlayEl.attachShadow({ mode: 'closed' });

    const isLong  = data.type === 'long';
    const accent  = isLong ? '#d4af37' : '#4ecdc4';
    const fade    = data.slowFadeEnabled ? (isLong ? 4000 : 1500) : 500;
    const opacity = data.overlayOpacity ?? 1;

    shadowRoot.innerHTML = buildStyles(accent, fade, opacity, isLong) + buildHTML(data, isLong);
    document.documentElement.appendChild(overlayEl);

    if (data.soundEnabled) playChime();
    startCountdown(data);
  }

  function buildStyles(accent, fadeDuration, opacity, isLong) {
    return `<style>
      :host { all: initial; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
      .bg { position:absolute; inset:0; opacity:0; animation:fadeIn ${fadeDuration}ms ease forwards; }
      @keyframes fadeIn { to { opacity:${opacity}; } }
      .bg.closing { animation:fadeOut .5s ease forwards !important; }
      @keyframes fadeOut { to { opacity:0; } }
      .geo { position:absolute; top:50%; left:50%; transform:translate(-50%,-50%); width:500px; height:500px; color:#d4af37; pointer-events:none; opacity:.06; }
      .content { position:relative; z-index:1; text-align:center; max-width:${isLong?'600px':'480px'}; padding:40px 32px; opacity:0; animation:slideUp .8s ease .4s forwards; }
      @keyframes slideUp { from{opacity:0;transform:translateY(28px)} to{opacity:1;transform:none} }
      .lbl { font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:3px; color:${accent}; margin-bottom:28px; }
      .custom-text { font-size:${isLong?'20px':'16px'}; color:#dde8f0; line-height:1.6; margin-bottom:16px; }
      .divider { width:70px; height:1px; background:linear-gradient(90deg,transparent,#d4af37,transparent); margin:22px auto; }
      .ex-name { font-size:15px; font-weight:600; color:#4ecdc4; margin-bottom:12px; }
      .ex-steps { list-style:none; padding:0; text-align:left; max-width:400px; margin:0 auto; }
      .ex-steps li { font-size:13px; color:#a8b8c8; padding:5px 0 5px 26px; position:relative; line-height:1.5; }
      .ex-steps li::before { content:attr(data-n); position:absolute; left:0; color:#4ecdc4; font-weight:700; font-size:11px; }
      .timer { font-size:${isLong?'56px':'48px'}; font-weight:200; color:#fff; font-variant-numeric:tabular-nums; letter-spacing:2px; margin-bottom:28px; }
      .actions { display:flex; gap:10px; justify-content:center; flex-wrap:wrap; }
      .btn { padding:10px 22px; border:none; border-radius:8px; font-size:13px; font-weight:600; cursor:pointer; font-family:inherit; transition:transform .1s,opacity .1s; }
      .btn:hover { opacity:.85; transform:translateY(-1px); }
      .btn-postpone { background:rgba(255,255,255,.07); color:#b0c8d8; }
      .btn-skip     { background:rgba(255,255,255,.06); color:#8899aa; }
      .btn-extend   { background:rgba(212,175,55,.14);  color:#d4af37; }
      .btn-done     { background:linear-gradient(135deg,#d4af37,#b8962e); color:#0d2137; }
    </style>`;
  }

  function buildHTML(data, isLong) {
    const esc = t => { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; };
    const bg = buildBg(data);
    return `${bg}
    <div class="content">
      <div class="lbl">${isLong ? '🌙  Long Break' : '✨  Micro Break'}</div>
      ${data.customText ? `<div class="custom-text">${esc(data.customText)}</div>` : ''}
      ${data.exercise ? `
        <div class="divider"></div>
        <div class="ex-name">💪 ${esc(data.exercise.name)}</div>
        <ul class="ex-steps">${data.exercise.steps.map((s,i) => `<li data-n="${i+1}.">${esc(s)}</li>`).join('')}</ul>
      ` : ''}
      <div class="divider"></div>
      <div class="timer" id="cd">${fmt(remaining)}</div>
      <div class="actions">
        ${!data.isTest ? `<button class="btn btn-postpone" id="btnPostpone">Postpone ${data.postponeMinutes}m</button>` : ''}
        ${!data.isTest ? `<button class="btn btn-skip" id="btnSkip">Skip</button>` : ''}
        <button class="btn btn-extend" id="btnExtend">+1 min</button>
        <button class="btn btn-done"   id="btnDone">Done</button>
      </div>
    </div>`;
  }

  function buildBg(data) {
    let style;
    switch (data.backgroundMode) {
      case 'solidColor':     style = `background:#${data.solidColorHex || '1a2a3a'}`; break;
      case 'blurredScreen':  style = `background:rgba(10,20,30,.75)`; break;
      default:               style = `background:linear-gradient(135deg,#0d2137 0%,#0a3d5c 50%,#0d4f4f 100%)`;
    }
    return `<div class="bg" style="${style}">
      <svg class="geo" viewBox="0 0 400 400" fill="none" stroke="currentColor">
        <polygon points="200,40 240,120 330,130 268,190 284,280 200,238 116,280 132,190 70,130 160,120" stroke-width="1.5"/>
        <polygon points="200,40 240,120 330,130 268,190 284,280 200,238 116,280 132,190 70,130 160,120" stroke-width="1" transform="rotate(22.5 200 200)"/>
        <circle cx="200" cy="200" r="120" stroke-width=".8"/>
        <circle cx="200" cy="200" r="160" stroke-width=".5"/>
      </svg>
    </div>`;
  }

  function startCountdown(data) {
    shadowRoot.getElementById('btnPostpone')?.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'postponeBreak', breakType: data.type, minutes: data.postponeMinutes });
      closeOverlay();
    });
    shadowRoot.getElementById('btnSkip')?.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'skipBreak', breakType: data.type });
      closeOverlay();
    });
    shadowRoot.getElementById('btnExtend').addEventListener('click', () => {
      remaining += 60;
      const cd = shadowRoot.getElementById('cd');
      if (cd) cd.textContent = fmt(remaining);
    });
    shadowRoot.getElementById('btnDone').addEventListener('click', () => {
      if (!data.isTest) chrome.runtime.sendMessage({ type: 'endBreak', breakType: data.type });
      closeOverlay();
    });

    ticker = setInterval(() => {
      remaining = Math.max(0, remaining - 1);
      const cd = shadowRoot?.getElementById('cd');
      if (cd) cd.textContent = fmt(remaining);
      if (remaining <= 0) {
        if (!data.isTest) chrome.runtime.sendMessage({ type: 'endBreak', breakType: data.type });
        closeOverlay();
      }
    }, 1000);
  }

  function closeOverlay() {
    clearInterval(ticker); ticker = null;
    if (currentBgMode === 'blurredScreen') document.documentElement.style.filter = '';
    const bg = shadowRoot?.querySelector('.bg');
    if (bg) { bg.classList.add('closing'); setTimeout(removeOverlay, 500); }
    else removeOverlay();
  }

  function removeOverlay() {
    document.documentElement.style.filter = '';
    overlayEl?.parentNode?.removeChild(overlayEl);
    overlayEl = null; shadowRoot = null;
  }

  function fmt(s) {
    s = Math.max(0, Math.floor(s));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  function playChime() {
    try {
      const ctx = new AudioContext();
      const t = ctx.currentTime;
      [440, 554.37, 659.25].forEach((f, i) => {
        const osc = ctx.createOscillator(), g = ctx.createGain();
        osc.type = 'sine'; osc.frequency.value = f;
        g.gain.setValueAtTime(0, t + i * .3);
        g.gain.linearRampToValueAtTime(.15, t + i * .3 + .05);
        g.gain.exponentialRampToValueAtTime(.001, t + i * .3 + 1.2);
        osc.connect(g); g.connect(ctx.destination);
        osc.start(t + i * .3); osc.stop(t + i * .3 + 1.5);
      });
      setTimeout(() => ctx.close(), 3000);
    } catch (_) {}
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.action === 'startBreak') {
      createOverlay(msg.data);
      sendResponse({ ok: true });
    }
    return false;
  });
})();
