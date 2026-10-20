/* ========================================================================
   Jackery Monitor — UI v4 client.

   Responsibilities:
     • Login flow (POST /api/auth/credentials, GET /api/auth/status).
     • WebSocket /ws for live status + telemetry.
     • Tab switching: Live / Energy / Device.
     • Live chart (battery%, output W, input W).
     • Energy KPIs + Energy history chart (range picker 6h/24h/7d/30d).
     • Device dropdown (multi-device accounts).
     • Output state display (read-only — cloud API does not expose toggles).
   ======================================================================== */

const $ = (id) => document.getElementById(id);

// Canonical HTML escape. Use this whenever interpolating untrusted data
// (API responses, error messages, cloud-probed values) into innerHTML.
// Several sections also define a local `safe = ...` shim — those are
// kept for now to avoid a 100+ site rename, but they behave identically.
function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// ---------- state ----------
let lastStatus = null;
let lastDevices = [];
let energyRangeHours = 6;     // current Energy tab range selection
let energyHistoryCache = null; // last fetched series for the energy tab
let energyDailyCache = null;
// Set when the user picks a device in the picker: {id, until}. While
// pending, status frames rendered for any OTHER device are dropped so
// in-flight polls/WS frames from the previous view can't fight the new
// one (the old/new alternation re-triggered the device-change refetch
// block and the UI visibly ping-ponged for several seconds).
let _pendingViewSwitch = null;

// Loading indicator for the switch window: spinner pill in the header +
// dimmed tab content. Driven by the same lifecycle as the latch — shown
// when the user picks a device, hidden the moment the first frame of the
// NEW device's data renders (or the fail-open window expires), so "the
// spinner went away" always means "what you see is the new device".
function setDeviceSwitching(on) {
  const pill = $('switch-pill');
  if (pill) pill.hidden = !on;
  document.body.classList.toggle('device-switching', !!on);
}   // last /api/energy/daily payload (365d, per device)
let forecastCache = null;     // last /api/forecast response
let activeTab = 'live';

// ---------- chart palette ----------
// Single source of truth so the chart drawing code, hover tooltips, and
// (future) legend swatches can't drift out of sync.
const SERIES_COLORS = {
  battery:  '#fbbf24',  // amber, also matches CSS .lg-bat
  output:   '#4ade80',  // green, also matches CSS .lg-out
  input:    '#38bdf8',  // sky,   also matches CSS .lg-in
  baseline: '#38bdf8',  // sky (baseline no battery)
  grid:     '#ef4444',  // red (actual grid cost)
  net:      '#4ade80',  // green (net savings)
  temp:     '#f97316',  // orange, matches CSS .lg-temp
};

// ---------- legend / series visibility ----------
const _seriesVisible = {
  live:        { battery: true, output: true, input: true },
  'live-temp': { temp: true },
  energy:      { battery: true, output: true, input: true },
  'energy-temp': { temp: true },
  forecast:    { soc: true, load: true, solar: true },
  cost:        { baseline: true, grid: true, net: true },
};

// Adding a new chart? Just register its redraw + cache-getter here.
const _chartRedraw = {
  live: () => {
    if (lastStatus) {
      drawLiveChart(lastStatus);
      drawLiveTempChart(lastStatus);
    }
  },
  'live-temp': () => lastStatus && drawLiveTempChart(lastStatus),
  energy: () => {
    if (energyHistoryCache) {
      drawEnergyChart(energyHistoryCache);
      drawEnergyTempChart(energyHistoryCache);
    }
  },
  'energy-temp': () => energyHistoryCache && drawEnergyTempChart(energyHistoryCache),
  forecast: () => forecastCache && drawForecastChart(forecastCache),
  cost:     () => costHistoryCache && drawCostChart(costHistoryCache),
};

document.addEventListener('click', (e) => {
  const item = e.target.closest('.legend-item');
  if (!item) return;
  const chart  = item.closest('.legend')?.dataset.chart;
  const series = item.dataset.series;
  if (!chart || !series || !_seriesVisible[chart]) return;
  e.preventDefault();
  _seriesVisible[chart][series] = !_seriesVisible[chart][series];
  item.classList.toggle('off', !_seriesVisible[chart][series]);
  _chartRedraw[chart]?.();
});

// ---------- service worker ----------
// Register on next idle so it doesn't compete with first-paint. The SW
// caches the static shell so the dashboard loads fast (and works briefly
// offline) once it's installed via "Add to Home Screen".
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' })
      .catch((e) => console.warn('SW register failed:', e));
  });
}

// ---------- helpers ----------
function fmt(n, digits = 0) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return Number(n).toFixed(digits);
}
function fmtKwh(wh) {
  if (wh === null || wh === undefined || Number.isNaN(wh)) return '—';
  const k = wh / 1000;
  if (k >= 100) return k.toFixed(0);
  if (k >= 10)  return k.toFixed(1);
  return k.toFixed(2);
}

function fmtDurationAgo(seconds) {
  if (seconds == null || isNaN(seconds) || seconds < 0) return '';
  if (seconds < 60) return `${Math.round(seconds)}s ago`;
  const mins = Math.floor(seconds / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hours < 24) return remMins ? `${hours}h ${remMins}m ago` : `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}


// Charged-source split under the "kWh charged" KPI: shown only when
// BOTH solar and AC contributed meaningfully today (>=0.05 kWh each),
// so pure-solar days keep the clean single number. Shares come from
// the same samples the total does (input ≈ solar + AC + car-in), so
// they annotate rather than exactly sum to the total.
function renderChargedSplit(rowId, w) {
  const row = $(rowId);
  if (!row) return;
  const solarWh = w?.solar_wh || 0;
  const acWh = w?.ac_input_wh || 0;
  if (solarWh >= 50 && acWh >= 50) {
    const set = (id, wh) => { const el = $(id); if (el) el.textContent = fmtKwh(wh); };
    set(rowId + '-solar', solarWh);
    set(rowId + '-ac', acWh);
    row.hidden = false;
  } else {
    row.hidden = true;
  }
}
function show(el, on = true) { if (!el) return; if (on) el.removeAttribute('hidden'); else el.setAttribute('hidden', ''); }

// Animate a number element from its current value to a new one, with a brief
// amber pulse on the parent .kpi-value when the value actually changes. Used
// for "live" feel on output/input/battery KPIs without per-tick churn.
const _animState = new WeakMap();
function animateNumber(el, target, digits = 0, duration = 600) {
  if (!el || target == null || Number.isNaN(target)) return;
  const numericTarget = Number(target);
  const previous = _animState.get(el)?.value ?? Number(el.textContent.replace(/[^\-\d.]/g,''));
  if (!isFinite(previous) || previous === numericTarget) {
    el.textContent = numericTarget.toFixed(digits);
    _animState.set(el, { value: numericTarget });
    return;
  }
  // Pulse the wrapping .kpi-value (if any) to flash the colour briefly.
  const pulseHost = el.closest('.kpi-value');
  if (pulseHost) {
    pulseHost.classList.remove('changed');
    void pulseHost.offsetWidth;  // restart animation
    pulseHost.classList.add('changed');
  }
  // Cancel any previous tween still running.
  const prev = _animState.get(el);
  if (prev?.raf) cancelAnimationFrame(prev.raf);
  const start = performance.now();
  const from = previous;
  const tick = (now) => {
    const t = Math.min(1, (now - start) / duration);
    // ease-out cubic
    const k = 1 - Math.pow(1 - t, 3);
    const v = from + (numericTarget - from) * k;
    el.textContent = v.toFixed(digits);
    if (t < 1) {
      _animState.set(el, { value: v, raf: requestAnimationFrame(tick) });
    } else {
      _animState.set(el, { value: numericTarget });
    }
  };
  _animState.set(el, { value: from, raf: requestAnimationFrame(tick) });
}

// ============================================================
// LOGIN
// ============================================================
async function checkAuth() {
  try {
    const r = await fetch('/api/auth/status');
    if (!r.ok) return false;
    const j = await r.json();
    if (j.has_credentials === false) {
      showLogin();
      return false;
    }
    hideLogin();
    return true;
  } catch (e) {
    // bridge unreachable / server transient — don't trap the user; let WS retry
    hideLogin();
    return true;
  }
}
function showLogin() { show($('login-overlay'), true); setTimeout(() => $('login-email')?.focus(), 50); }
function hideLogin() { show($('login-overlay'), false); }

$('login-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('login-email').value.trim();
  const password = $('login-password').value;
  const region = $('login-region').value;
  const errEl = $('login-error');
  const btn = $('login-submit');
  errEl.hidden = true;
  btn.disabled = true;
  btn.textContent = 'Verifying…';
  try {
    const r = await fetch('/api/auth/credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, region }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.ok === false) {
      const msg = j.detail || j.error || ('HTTP ' + r.status);
      errEl.textContent = msg;
      errEl.hidden = false;
      return;
    }
    hideLogin();
  } catch (e) {
    errEl.textContent = String(e);
    errEl.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sign in';
  }
});

// ============================================================
// FORGET CREDENTIALS (Device tab > Account)
// ============================================================
// ============================================================
// PAUSE / RESUME polling — hand the cloud session to the phone app
// ============================================================
let _lastCloudMeta = null;        // last s.cloud snapshot for the countdown tick

function fmtSecsMMSS(secs) {
  if (!isFinite(secs) || secs <= 0) return '0:00';
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return m + ':' + (s < 10 ? '0' + s : s);
}

function renderPausePill() {
  const btn = $('pause-poll');
  const status = $('pause-status');
  const sel = $('pause-duration');
  if (!btn || !status) return;
  const meta = _lastCloudMeta;
  if (!meta) return;
  // Recompute remaining from absolute timestamps so we don't drift if the
  // server's payload is stale by a few seconds.
  const now = Date.now() / 1000;
  const pauseLeft = meta.pause_until ? Math.max(0, meta.pause_until - now) : 0;
  const contestedLeft = meta.contested_until ? Math.max(0, meta.contested_until - now) : 0;

  if (pauseLeft > 0) {
    btn.textContent = 'Resume polling';
    status.hidden = false;
    status.textContent = `paused — ${fmtSecsMMSS(pauseLeft)} left`;
    if (sel) sel.hidden = true;
  } else if (contestedLeft > 0) {
    btn.textContent = 'Pause polling';
    status.hidden = false;
    status.textContent = `session contested — auto-reclaiming in ${fmtSecsMMSS(contestedLeft)}`;
    if (sel) sel.hidden = false;
  } else {
    btn.textContent = 'Pause polling';
    status.hidden = true;
    status.textContent = '';
    if (sel) sel.hidden = false;
  }
}

$('pause-poll')?.addEventListener('click', async () => {
  const btn = $('pause-poll');
  const sel = $('pause-duration');
  const meta = _lastCloudMeta || {};
  const now = Date.now() / 1000;
  const isPaused = meta.pause_until && meta.pause_until > now;
  const seconds = sel ? parseInt(sel.value, 10) || 600 : 600;
  btn.disabled = true;
  try {
    const url = isPaused ? '/api/resume_polling' : '/api/pause_polling';
    const opts = { method: 'POST', headers: { 'content-type': 'application/json' } };
    if (!isPaused) opts.body = JSON.stringify({ seconds });
    await fetch(url, opts);
    // Optimistic update; the WS broadcast / next /api/status poll will reconcile.
    if (isPaused) {
      _lastCloudMeta = { ..._lastCloudMeta, pause_until: null, contested_until: null };
    } else {
      _lastCloudMeta = { ..._lastCloudMeta, pause_until: now + seconds, contested_until: null };
    }
    renderPausePill();
  } catch (e) {
    console.error('pause toggle failed', e);
  } finally {
    btn.disabled = false;
  }
});

// 1-second countdown tick so the "x:yy left" label updates live
setInterval(renderPausePill, 1000);

// ============================================================
// OUTPUT TOGGLES — click an AC/DC/USB/Car card to toggle it
// ============================================================
// After a successful toggle, we don't trust the next ~30s of telemetry to
// reflect the change — the device takes ~5-30s to apply the command and
// push the new state back to the Jackery cloud. During that window we hold
// the optimistic value and tag the button as "pending"; it clears as soon
// as telemetry matches what we asked for, or after the timeout (revert).
const PENDING_TOGGLE_MS = 30000;
const _pendingToggle = {};   // port -> { expected: bool, until: ms }

document.querySelectorAll('.switch').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const port = btn.dataset.port;
    if (!port) return;
    // If the AC button is in watchdog-error state, route the click to
    // the dismiss endpoint instead of toggling. The watchdog will start
    // a fresh retry sequence on the next AC=OFF observation.
    if (port === 'ac' && btn.classList.contains('wd-err')) {
      const viewSnDismiss = activeJackeryDevice()?.device_sn || null;
      try {
        const r = await fetch('/api/inverter_watchdog/dismiss' +
          (viewSnDismiss ? `?device_sn=${encodeURIComponent(viewSnDismiss)}` : ''),
          { method: 'POST' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        btn.classList.remove('wd-err');
        btn.title = '';
      } catch (e) {
        alert(`Failed to dismiss watchdog error: ${e.message || e}`);
      }
      return;
    }
    const lbl = $(`sw-${port}`);
    const currentState = (lbl?.textContent || '').trim();
    if (currentState !== 'ON' && currentState !== 'OFF') {
      return;  // unknown state — don't risk a blind toggle
    }
    // Route the toggle to the device the user is *viewing*, not the one
    // the bridge happens to be polling. Without this, a user with
    // per-browser view set to a non-active device would silently toggle
    // the wrong Jackery.
    const viewSn = activeJackeryDevice()?.device_sn || null;
    const turnOn = currentState === 'OFF';
    // AC has highest blast radius (powering whatever's plugged in) — confirm
    // before turning it OFF. Turning ON is fine to do without confirm.
    if (port === 'ac' && !turnOn) {
      if (!confirm('Turn AC output OFF? Anything plugged in will lose power.')) return;
    }
    btn.disabled = true;
    btn.classList.add('pending');
    const original = lbl.textContent;
    lbl.textContent = '…';
    try {
      const r = await fetch('/api/set_output', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port, on: turnOn, device_sn: viewSn }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.detail || j.error || ('HTTP ' + r.status));
      }
      // Optimistic update + remember the expectation so subsequent telemetry
      // polls can't flip the label back during the device's apply window.
      _pendingToggle[port] = { expected: turnOn, until: Date.now() + PENDING_TOGGLE_MS };
      lbl.textContent = turnOn ? 'ON' : 'OFF';
      btn.classList.toggle('on', turnOn);
    } catch (e) {
      lbl.textContent = original;
      alert(`Failed to toggle ${port.toUpperCase()}: ${e.message || e}`);
    } finally {
      btn.disabled = false;
      // Note: we keep .pending until telemetry confirms the change
    }
  });
});

$('forget-creds')?.addEventListener('click', async () => {
  const btn = $('forget-creds');
  const msg = $('forget-msg');
  if (!confirm('Wipe stored Jackery credentials? You will need to sign in again to keep monitoring.')) return;
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = 'Signing out…';
  msg.hidden = true;
  try {
    const r = await fetch('/api/auth/forget', { method: 'POST' });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.ok === false) {
      const m = j.detail || j.error || ('HTTP ' + r.status);
      msg.textContent = m + ((m && m.toLowerCase().includes('env')) ? ' — remove JACKERY_EMAIL / JACKERY_PASSWORD from your .env, then redeploy.' : '');
      msg.hidden = false;
      return;
    }
    // Show the login modal right away. Polling will also catch it within 30s.
    showLogin();
  } catch (e) {
    msg.textContent = String(e);
    msg.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
});

// ============================================================
// TABS
// ============================================================
// URL hash is the single source of truth for the active tab — refresh
// keeps state automatically (hash persists in the URL), shared links
// land on the right tab, and explicit nav to `/` always goes to Live.
// We deliberately do NOT layer localStorage on top: that fights the
// URL on explicit navigations (clearing the hash from the address bar
// would be over-ridden by the saved value, snapping back).
const VALID_TABS = new Set([
  'live', 'sinope', 'daikin', 'hilo', 'thinq', 'midea', 'tesla', 'kasa', 'energy', 'cost', 'forecast', 'device', 'automation', 'logs', 'settings',
]);

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => switchTab(tab.dataset.tab));
});

function switchTab(name, opts = {}) {
  if (!VALID_TABS.has(name)) return;
  activeTab = name;
  // Reflect the tab in the URL hash. Live is the default — keep the
  // URL clean (no hash) on that one. fromHash skips the rewrite when
  // we're already responding to a hashchange we didn't trigger.
  if (!opts.fromHash) {
    const desired = name === 'live' ? '' : '#' + name;
    if (location.hash !== desired) {
      try {
        if (desired) {
          history.pushState(null, '', desired);
        } else {
          // Strip hash without reload — fresh start at the bare URL.
          history.pushState(null, '', location.pathname + location.search);
        }
      } catch (_) { /* old browser or restricted context */ }
    }
  }
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('on', t.dataset.tab === name));
  document.querySelectorAll('.tab-panel').forEach(p => p.toggleAttribute('hidden', p.id !== `tab-${name}`));
  if (name === 'live')     { drawLiveChart(lastStatus); drawLiveTempChart(lastStatus); }
  if (name === 'sinope')   { renderSinopeTab(); }
  if (name === 'daikin')   { renderDaikinTab(true); }
  if (name === 'hilo')     { renderHiloTab(true); }
  if (name === 'thinq')    { renderThinqTab(true); }
  if (name === 'midea')    { renderMideaTab(true); }
  if (name === 'tesla')    { renderTeslaTab(true); }
  if (name === 'kasa')     { renderKasaTab(true); }
  if (name === 'energy')   { fetchEnergyHistory(); fetchEnergyAllDevices(); fetchEnergyDaily(); }
  if (name === 'cost')     { loadCostTab(); }
  if (name === 'forecast') { fetchForecast(); }
  if (name === 'settings') { loadSettings(); loadCostPlan(); initKeepAwakeToggle(); loadAnthropicKeyStatus(); loadAnthropicModelPickers(); loadAIProvider(); loadOpenAIKeyStatus(); loadOpenAIModelPickers(); loadBackupAll(); restoreSettingsSubtab(); loadKasaCreds(); loadSavedKasa(); loadSinopeCreds(); loadDaikinCreds(); loadHiloCreds(); loadThinqCreds(); loadMideaCreds(); loadTeslaCreds(); }
  if (name === 'logs')     { loadLogs(); }
  if (name === 'automation') {
    restoreAutomationSubtab();
    loadAutomation(); loadSmartCharge(); loadSolarCharge(); loadAlgorithmAdvisor(); resumeAdvisorPollIfRunning();
    // User is now looking — clear the "new insights" dot.
    setAutomationDot(false);
  }
  if (name === 'device')   { loadDeviceCapacity(); loadDeviceParams(); loadInverterWatchdogConfig(); loadHardwareSettings(); }
}

// Boot path: pull the tab from the URL hash. Defer the actual switch
// until the next microtask so all the `let`/`const` declarations later
// in this file have been initialized — calling switchTab synchronously
// here would hit TDZ errors on side-effect functions that reference
// module-level vars (e.g. loadAnthropicKeyStatus -> _anthropicHasKey).
function _initialTab() {
  const hashTab = location.hash.slice(1);
  return (hashTab && VALID_TABS.has(hashTab)) ? hashTab : 'live';
}
queueMicrotask(() => {
  const tab = _initialTab();
  if (tab !== 'live') switchTab(tab);
});

// Back/forward buttons cycle through tab history; manual hash edits in
// the address bar route to the corresponding tab. The hashchange event
// fires for our own pushState too, but the activeTab guard short-
// circuits the re-entry.
window.addEventListener('hashchange', () => {
  const target = location.hash.slice(1) || 'live';
  if (VALID_TABS.has(target) && target !== activeTab) {
    switchTab(target, { fromHash: true });
  }
});

// ---- Settings sub-tabs ---------------------------------------------------
// The Settings tab grew enough to need internal grouping (general /
// intelligence / rates / backup). Each card is wrapped in a
// <div data-settings-group="..."> in index.html; this toggles which
// group is visible. Selection persists per-browser via localStorage so
// a refresh / reload lands you back on the same view.
const SETTINGS_SUBTAB_KEY = 'jackery-settings-subtab';
const SETTINGS_SUBTABS = ['general', 'integrations', 'intelligence', 'rates', 'backup', 'notifications'];

function selectSettingsSubtab(name) {
  if (!SETTINGS_SUBTABS.includes(name)) name = 'general';
  document.querySelectorAll('.settings-subtab').forEach(btn => {
    btn.classList.toggle('on', btn.dataset.settingsTab === name);
    btn.setAttribute('aria-selected', btn.dataset.settingsTab === name ? 'true' : 'false');
  });
  document.querySelectorAll('[data-settings-group]').forEach(group => {
    group.toggleAttribute('hidden', group.dataset.settingsGroup !== name);
  });
  try { localStorage.setItem(SETTINGS_SUBTAB_KEY, name); } catch (_) {}
  if (name === 'integrations') {
    if (typeof loadKasaCreds === 'function') loadKasaCreds();
    if (typeof loadSavedKasa === 'function') loadSavedKasa();
    if (typeof loadSinopeCreds === 'function') loadSinopeCreds();
    if (typeof loadDaikinCreds === 'function') loadDaikinCreds();
    if (typeof loadHiloCreds === 'function') loadHiloCreds();
    if (typeof loadThinqCreds === 'function') loadThinqCreds();
    if (typeof loadMideaCreds === 'function') loadMideaCreds();
    if (typeof loadTeslaCreds === 'function') loadTeslaCreds();
  }
}

function restoreSettingsSubtab() {
  let saved = null;
  try { saved = localStorage.getItem(SETTINGS_SUBTAB_KEY); } catch (_) {}
  selectSettingsSubtab(saved || 'general');
  // Refresh status chips that don't auto-update via existing loaders —
  // most chips (#ak-status, #backup-creds-status, #backup-last-line,
  // #cost-status) get populated by their own loaders that already run
  // when Settings opens. Display is the odd one out — it's pure
  // localStorage.
  _refreshSettingsDisplayChip();
  if (typeof loadNotificationsSettings === 'function') loadNotificationsSettings();
}

document.querySelectorAll('.settings-subtab').forEach((btn) => {
  btn.addEventListener('click', () => selectSettingsSubtab(btn.dataset.settingsTab));
});

// ---- Collapsed history list -----------------------------------------------
// Renders `rows` into `listEl` showing only the first row by default with
// a "Show N more" toggle that reveals/hides the rest. The toggle is
// delegated below so it works for both Smart-charge and Excess-diversion
// history without per-render rebinding.
function renderCollapsedHistory(listEl, rows, rowRenderer) {
  if (!listEl) return;
  if (!rows.length) {
    listEl.innerHTML = '';
    return;
  }
  const remaining = rows.length - 1;
  if (remaining === 0) {
    listEl.innerHTML = rowRenderer(rows[0]);
    return;
  }
  listEl.innerHTML = `
    ${rowRenderer(rows[0])}
    <button class="history-toggle" type="button" data-count="${remaining}">
      Show ${remaining} more ▼
    </button>
    <div class="history-rest" hidden>
      ${rows.slice(1).map(rowRenderer).join('')}
    </div>
  `;
}

document.body.addEventListener('click', (e) => {
  const btn = e.target.closest('.history-toggle');
  if (!btn) return;
  const rest = btn.parentElement?.querySelector('.history-rest');
  if (!rest) return;
  if (rest.hidden) {
    rest.hidden = false;
    btn.textContent = 'Hide ▲';
  } else {
    rest.hidden = true;
    btn.textContent = `Show ${btn.dataset.count} more ▼`;
  }
});

// ---- Automation sub-tabs: same pattern as Settings ------------------------
// Three groups (controllers / rules / insights). Each card under
// #tab-automation carries data-automation-group; this handler hides the
// non-matching ones and tracks the choice in localStorage so a reload
// or tab switch lands the user back where they left off.
const AUTOMATION_SUBTAB_KEY = 'jackery-automation-subtab';
const AUTOMATION_SUBTABS = ['controllers', 'rules', 'insights'];

function selectAutomationSubtab(name) {
  if (!AUTOMATION_SUBTABS.includes(name)) name = 'controllers';
  const pane = document.getElementById('tab-automation');
  if (pane) pane.dataset.activeGroup = name;
  document.querySelectorAll('.automation-subtab').forEach((btn) => {
    btn.classList.toggle('on', btn.dataset.automationTab === name);
    btn.setAttribute('aria-selected', btn.dataset.automationTab === name ? 'true' : 'false');
  });
  document.querySelectorAll('#tab-automation [data-automation-group]').forEach((el) => {
    el.toggleAttribute('hidden', el.dataset.automationGroup !== name);
  });
  try { localStorage.setItem(AUTOMATION_SUBTAB_KEY, name); } catch (_) {}
}

function restoreAutomationSubtab() {
  let saved = null;
  try { saved = localStorage.getItem(AUTOMATION_SUBTAB_KEY); } catch (_) {}
  selectAutomationSubtab(saved || 'controllers');
}

document.querySelectorAll('.automation-subtab').forEach((btn) => {
  btn.addEventListener('click', () => selectAutomationSubtab(btn.dataset.automationTab));
});

// ---- Settings cards: collapsible with persisted state ---------------------
// Each card under [data-settings-group] carries a stable
// data-settings-collapse-key. Click the header to toggle, and we
// remember the state per-key in localStorage so a refresh doesn't
// re-collapse what the user just expanded. The status chip in each
// header (e.g. backup-creds-status, backup-last-line, ak-status,
// cost-status) stays visible when collapsed — that's the whole
// point: zero-click reads of "did last night's backup succeed?",
// "is Anthropic connected?", "what TOU plan am I on?".
const SETTINGS_COLLAPSE_KEY = (cardKey) => `jackery-settings-collapse:${cardKey}`;

function _persistCollapseState(cardKey, collapsed) {
  try { localStorage.setItem(SETTINGS_COLLAPSE_KEY(cardKey), collapsed ? '1' : '0'); }
  catch (_) {}
}

function _restoreCollapseStates() {
  document.querySelectorAll('[data-settings-collapse-key]').forEach((card) => {
    const key = card.dataset.settingsCollapseKey;
    let saved = null;
    try { saved = localStorage.getItem(SETTINGS_COLLAPSE_KEY(key)); }
    catch (_) {}
    if (saved === '1') card.classList.add('collapsed');
    else if (saved === '0') card.classList.remove('collapsed');
    // else: leave whatever the HTML set (default state per card).
  });
}
_restoreCollapseStates();

document.querySelectorAll('[data-settings-collapse-key] .collapsible-header')
  .forEach((header) => {
    header.addEventListener('click', (e) => {
      // Don't hijack clicks on form controls inside the header (none today,
      // but defensive — keeps space + tab keypresses from doing weird stuff).
      if (e.target.closest('input, select, button, a, textarea')) return;
      const card = header.closest('[data-settings-collapse-key]');
      if (!card) return;
      const nowCollapsed = !card.classList.contains('collapsed');
      card.classList.toggle('collapsed', nowCollapsed);
      _persistCollapseState(card.dataset.settingsCollapseKey, nowCollapsed);
    });
  });

// ---- Settings global search ---------------------------------------------
// Flat index built lazily from the DOM the first time the user types.
// Every .settings-row inside every collapsible card becomes a search
// target — labels + hints are already on the page in human-readable
// form, no parallel schema needed. Card titles themselves are also
// indexed so "backup" jumps to that group's first card.
let _settingsSearchIndex = null;
const _SETTINGS_GROUP_LABELS = {
  general: 'General',
  integrations: 'Integrations',
  intelligence: 'Intelligence',
  rates: 'Rates',
  backup: 'Backup',
  notifications: 'Notifications',
};

function _buildSettingsSearchIndex() {
  const idx = [];
  document.querySelectorAll('[data-settings-group]').forEach((group) => {
    const groupKey = group.dataset.settingsGroup;
    group.querySelectorAll('[data-settings-collapse-key]').forEach((card) => {
      const cardKey = card.dataset.settingsCollapseKey;
      const cardTitle = card.querySelector('h2')?.textContent.trim() || cardKey;
      // Card itself: lets a query like "anthropic" or "backup" match
      // even if the user doesn't remember a specific row label.
      idx.push({
        group: groupKey, cardKey, cardTitle,
        label: cardTitle, hint: '',
        el: card,
      });
      // Each labelled row.
      card.querySelectorAll('.settings-row').forEach((row) => {
        const labelEl = row.querySelector('.settings-label-text');
        const hintEl = row.querySelector('.settings-hint, .hint');
        const label = (labelEl?.textContent || '').trim();
        if (!label) return;  // skip rows with no label
        idx.push({
          group: groupKey, cardKey, cardTitle, label,
          hint: (hintEl?.textContent || '').trim(),
          el: row,
        });
      });
    });
  });
  return idx;
}

function _searchSettingsIndex(query) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  if (!_settingsSearchIndex) _settingsSearchIndex = _buildSettingsSearchIndex();
  const out = [];
  for (const entry of _settingsSearchIndex) {
    const labelHit = entry.label.toLowerCase().includes(q);
    const hintHit = entry.hint.toLowerCase().includes(q);
    if (!labelHit && !hintHit) continue;
    // Score: label hits beat hint-only hits; earlier matches beat later.
    const labelPos = labelHit ? entry.label.toLowerCase().indexOf(q) : 999;
    out.push({ ...entry, _score: (labelHit ? 0 : 1000) + labelPos });
    if (out.length >= 64) break;
  }
  out.sort((a, b) => a._score - b._score);
  return out.slice(0, 8);
}

function _highlightQuery(text, query) {
  const escaped = escapeHtml(text);
  if (!query) return escaped;
  const re = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
  return escaped.replace(re, '<mark class="settings-search-hl">$1</mark>');
}

function _renderSettingsSearchResults(results, query) {
  const ul = $('settings-search-results');
  if (!ul) return;
  if (!results.length) {
    ul.innerHTML = `<li class="settings-search-empty">No matches for “${escapeHtml(query)}”</li>`;
    ul.hidden = false;
    return;
  }
  ul.innerHTML = results.map((r, i) => `
    <li class="settings-search-result${i === 0 ? ' on' : ''}" data-idx="${i}" role="option">
      <div class="settings-search-crumb">${escapeHtml(_SETTINGS_GROUP_LABELS[r.group] || r.group)} → ${escapeHtml(r.cardTitle)}</div>
      <div class="settings-search-label">${_highlightQuery(r.label, query)}</div>
      ${r.hint ? `<div class="settings-search-hint">${_highlightQuery(r.hint, query)}</div>` : ''}
    </li>
  `).join('');
  ul.hidden = false;
  ul.querySelectorAll('.settings-search-result').forEach((li) => {
    li.addEventListener('click', () => {
      const idx = Number(li.dataset.idx);
      if (results[idx]) _settingsSearchJumpTo(results[idx]);
    });
  });
}

function _settingsSearchJumpTo(entry) {
  // Switch to the matching sub-tab.
  selectSettingsSubtab(entry.group);
  // Expand the card if currently collapsed.
  const card = document.querySelector(
    `[data-settings-collapse-key="${entry.cardKey}"]`);
  if (card && card.classList.contains('collapsed')) {
    card.classList.remove('collapsed');
    _persistCollapseState(entry.cardKey, false);
  }
  // Scroll the matching element into view + pulse-highlight.
  if (entry.el) {
    entry.el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    entry.el.classList.remove('settings-search-jumped');
    // eslint-disable-next-line no-unused-expressions
    void entry.el.offsetWidth;  // force reflow so the animation restarts
    entry.el.classList.add('settings-search-jumped');
  }
  // Reset the search UI.
  const ul = $('settings-search-results');
  if (ul) ul.hidden = true;
  const input = $('settings-search');
  if (input) input.value = '';
}

(function _wireSettingsSearch() {
  const input = $('settings-search');
  if (!input) return;
  let timer = null;
  let lastResults = [];
  input.addEventListener('input', () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      const q = input.value;
      if (!q.trim()) {
        $('settings-search-results').hidden = true;
        lastResults = [];
        return;
      }
      lastResults = _searchSettingsIndex(q);
      _renderSettingsSearchResults(lastResults, q);
    }, 100);
  });
  input.addEventListener('keydown', (e) => {
    const ul = $('settings-search-results');
    if (!ul) return;
    if (e.key === 'Escape') {
      input.value = '';
      ul.hidden = true;
      input.blur();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const onEl = ul.querySelector('.settings-search-result.on');
      if (onEl) onEl.click();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const items = [...ul.querySelectorAll('.settings-search-result')];
      if (!items.length) return;
      e.preventDefault();
      const cur = items.findIndex(li => li.classList.contains('on'));
      let next = e.key === 'ArrowDown' ? cur + 1 : cur - 1;
      if (next < 0) next = items.length - 1;
      if (next >= items.length) next = 0;
      items.forEach((li, i) => li.classList.toggle('on', i === next));
      items[next].scrollIntoView({ block: 'nearest' });
    }
  });
  // Click outside the search wrap closes the dropdown.
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.settings-search-wrap')) {
      const ul = $('settings-search-results');
      if (ul) ul.hidden = true;
    }
  });
  // Re-build the index on next search if the DOM changed (e.g. cost
  // plan rendered new TOU rows). Cheap to invalidate; ~30 entries.
  document.addEventListener('jackery-settings-dom-changed', () => {
    _settingsSearchIndex = null;
  });
})();

// "/" focuses the search input when Settings is the active tab.
// Skip when the user is already typing somewhere else, otherwise it'd
// hijack literal "/" keystrokes in number inputs / Anthropic API key
// fields / etc.
document.addEventListener('keydown', (e) => {
  if (e.key !== '/' || activeTab !== 'settings') return;
  const ae = document.activeElement;
  if (ae && ae.matches('input, select, textarea, button')) return;
  e.preventDefault();
  $('settings-search')?.focus();
});

// Populate the Display card's collapsed-header chip so the user can see
// the current temp unit + keep-awake state at a glance without expanding.
function _refreshSettingsDisplayChip() {
  const el = $('settings-display-status');
  if (!el) return;
  let unit = 'C';
  try { unit = (typeof getTempUnit === 'function') ? getTempUnit() : 'C'; }
  catch (_) {}
  let keepAwake = false;
  try { keepAwake = localStorage.getItem(KEEP_AWAKE_KEY) === '1'; }
  catch (_) {}
  const parts = [`°${unit}`];
  if (keepAwake) parts.push('keep awake');
  el.textContent = parts.join(' · ');
}

// Tab-level "new insights pending" badge. Lights up when the daily
// advisor (or a manual run) leaves pending items behind and the user
// isn't currently on the Automation tab.
function setAutomationDot(visible) {
  const dot = $('tab-automation-dot');
  if (!dot) return;
  dot.hidden = !visible;
}

async function refreshAutomationDot() {
  // Skip the network call when we're already on Automation — clicking
  // the tab clears the dot directly. Polling here would be wasted work.
  // Also reset the title so it doesn't keep a stale "1 device offline"
  // hover hint from before the user switched in.
  if (activeTab === 'automation') {
    setAutomationDot(false);
    const dot = $('tab-automation-dot');
    if (dot) dot.title = 'Automation';
    return;
  }
  try {
    const dev = activeJackeryDevice();
    const params = dev?.device_sn
      ? `?device_sn=${encodeURIComponent(dev.device_sn)}&status=pending`
      : '?status=pending';
    const [insightsR, kasaHealthR] = await Promise.all([
      fetch(`/api/algorithm/suggestions${params}`),
      fetch('/api/kasa/health'),
    ]);
    let actionableInsights = 0;
    let kasaOffline = 0;
    if (insightsR.ok) {
      const j = await insightsR.json();
      // Only count items the user can actually act on. INFO-severity
      // anomalies are observations the advisor explicitly flags as
      // "no action needed" — they belong in the list when the user
      // opens the tab, but they shouldn't trigger the dot. Counting
      // them was burying the actionable items behind a stack of pure
      // observations and made the dot meaningless.
      actionableInsights = (j.suggestions || []).filter((s) =>
        s.kind === 'config'
        || (s.kind === 'anomaly' && s.severity === 'warn')
      ).length;
    }
    if (kasaHealthR.ok) {
      const k = await kasaHealthR.json();
      kasaOffline = k.offline_count || 0;
    }
    // Re-check activeTab after the network round-trip — boot races
    // (queueMicrotask switchTab fires AFTER the IIFE that kicked off
    // the first refresh) and mid-flight tab switches would otherwise
    // light the dot back up immediately after switchTab cleared it,
    // and it'd take a full 3-min poll cycle to clear.
    if (activeTab === 'automation') {
      setAutomationDot(false);
      const dot = $('tab-automation-dot');
      if (dot) dot.title = 'Automation';
      return;
    }
    const dot = $('tab-automation-dot');
    setAutomationDot(actionableInsights > 0 || kasaOffline > 0);
    if (dot) {
      // Dynamic title so hovering reveals what actually needs attention.
      const reasons = [];
      if (actionableInsights > 0) {
        reasons.push(`${actionableInsights} AI insight(s) need attention`);
      }
      if (kasaOffline > 0) reasons.push(`${kasaOffline} Kasa device(s) offline`);
      dot.title = reasons.join(' · ') || 'Automation';
    }
  } catch { /* network blip — leave dot unchanged */ }
}

// ============================================================
// DEVICE TAB: capacity override + raw props viewer
// ============================================================
async function loadInverterWatchdogConfig() {
  const input = $('inverter-watchdog-enabled');
  const status = $('inverter-watchdog-config-status');
  if (!input) return;
  const sn = activeJackeryDevice()?.device_sn;
  input.disabled = true;
  input.dataset.deviceSn = '';
  if (!sn) return;
  try {
    const r = await fetch(`/api/inverter_watchdog/config?device_sn=${encodeURIComponent(sn)}`);
    const cfg = await r.json();
    if (!r.ok) throw new Error(cfg.detail || `HTTP ${r.status}`);
    if (activeJackeryDevice()?.device_sn !== sn) return;
    input.checked = cfg.enabled;
    input.dataset.deviceSn = sn;
    input.disabled = false;
    status.hidden = false;
    status.textContent = cfg.source === 'user' ? 'Saved for this device' : 'Default for this model';
  } catch (e) {
    if (activeJackeryDevice()?.device_sn !== sn) return;
    status.hidden = false;
    status.textContent = `Could not load: ${e.message || e}`;
  }
}

$('inverter-watchdog-enabled')?.addEventListener('change', async (event) => {
  const input = event.currentTarget;
  const status = $('inverter-watchdog-config-status');
  const sn = input.dataset.deviceSn;
  const enabled = input.checked;
  input.disabled = true;
  status.hidden = false;
  status.textContent = 'Saving…';
  try {
    const r = await fetch('/api/inverter_watchdog/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_sn: sn, enabled }),
    });
    const cfg = await r.json();
    if (!r.ok) throw new Error(cfg.detail || `HTTP ${r.status}`);
    if (activeJackeryDevice()?.device_sn !== sn) return;
    input.checked = cfg.enabled;
    status.textContent = 'Saved for this device';
  } catch (e) {
    if (activeJackeryDevice()?.device_sn !== sn) return;
    input.checked = !enabled;
    status.textContent = `Could not save: ${e.message || e}`;
  } finally {
    if (activeJackeryDevice()?.device_sn === sn) input.disabled = false;
  }
});

// ============================================================
// DEVICE TAB: Hardware settings
// ============================================================
const _pendingHardwareSettings = {}; // key -> { expected, deviceSn, until }

const HARDWARE_SETTINGS_DEFS = [
  { id: 'setting-battery-saving', key: 'battery_saving', type: 'checkbox' },
  { id: 'setting-charge-speed', key: 'charge_speed', type: 'select', isInt: true },
  { id: 'setting-super-charge', key: 'super_charge', type: 'checkbox' },
  { id: 'setting-energy-saving', key: 'energy_saving', type: 'select', isInt: true },
  { id: 'setting-screen-timeout', key: 'screen_timeout', type: 'select', isInt: true },
  { id: 'setting-auto-shutdown', key: 'auto_shutdown', type: 'select', isInt: true },
  { id: 'setting-light-mode', key: 'light_mode', type: 'select', isInt: true },
  { id: 'setting-ups-mode', key: 'ups_mode', type: 'checkbox' },
];

const MODEL_FEATURE_OVERRIDES = {
  4: { charge_speed: false, super_charge: false, ups_mode: false },
  5: { super_charge: false },
  8: { charge_speed: true, super_charge: true, ups_mode: true },
  12: { charge_speed: true, super_charge: true, ups_mode: true },
  13: { super_charge: false },
  22: { super_charge: false },
  19: { super_charge: false },
};

async function loadHardwareSettings() {
  const sn = activeJackeryDevice()?.device_sn;
  const status = $('hardware-settings-status');
  if (!sn) {
    for (const def of HARDWARE_SETTINGS_DEFS) {
      const el = $(def.id);
      if (el) el.disabled = true;
    }
    return;
  }

  // Pre-apply model overrides immediately to avoid showing unsupported controls
  renderHardwareSettings(null, sn);

  try {
    const r = await fetch(`/api/devices/settings?device_sn=${encodeURIComponent(sn)}`);
    if (!r.ok) return;
    const j = await r.json();
    if (activeJackeryDevice()?.device_sn !== sn) return;
    renderHardwareSettings(j.settings || {}, sn);
  } catch (e) {
    console.warn('hardware settings load failed', e);
  }
}

function renderHardwareSettings(settings, deviceSn) {
  const currentSn = activeJackeryDevice()?.device_sn;
  if (deviceSn && currentSn && deviceSn !== currentSn) return;
  const targetSn = deviceSn || currentSn;
  const dev = (lastStatus?.cloud?.devices || []).find((d) => d.device_sn === targetSn) || activeJackeryDevice();
  const modelCode = dev?.model_code;
  const overrides = modelCode != null ? MODEL_FEATURE_OVERRIDES[modelCode] : null;
  const now = Date.now();

  const hasSettings = settings && Object.keys(settings).length > 0;
  for (const def of HARDWARE_SETTINGS_DEFS) {
    const el = $(def.id);
    if (!el) continue;
    const row = el.closest('.settings-row');

    if (overrides && overrides[def.key] === false) {
      if (row) row.hidden = true;
      continue;
    }

    const val = settings ? settings[def.key] : undefined;

    if (hasSettings) {
      if (val === undefined || val === null) {
        if (row) row.hidden = true;
        continue;
      }
      if (row) row.hidden = false;
    }

    el.dataset.deviceSn = targetSn || '';
    el.disabled = !targetSn;

    // Check if there is an active optimistic update
    const pending = _pendingHardwareSettings[def.key];
    if (pending && pending.deviceSn === targetSn && now < pending.until) {
      continue;
    } else if (pending && now >= pending.until) {
      delete _pendingHardwareSettings[def.key];
    }

    if (val === undefined || val === null) continue;

    if (def.type === 'checkbox') {
      el.checked = Boolean(val);
    } else if (def.type === 'select') {
      el.value = String(val);
    }
  }
}

function initHardwareSettingsHandlers() {
  for (const def of HARDWARE_SETTINGS_DEFS) {
    const el = $(def.id);
    if (!el) continue;
    el.addEventListener('change', async (event) => {
      const target = event.currentTarget;
      const sn = target.dataset.deviceSn || activeJackeryDevice()?.device_sn;
      if (!sn) return;

      const rawVal = def.type === 'checkbox' ? target.checked : (def.isInt ? parseInt(target.value, 10) : target.value);
      const status = $('hardware-settings-status');
      if (status) {
        status.hidden = false;
        status.textContent = 'Saving…';
      }

      // Optimistic lock for 25s
      _pendingHardwareSettings[def.key] = {
        expected: rawVal,
        deviceSn: sn,
        until: Date.now() + 25000,
      };

      try {
        const r = await fetch('/api/devices/setting', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            device_sn: sn,
            setting: def.key,
            value: rawVal,
          }),
        });
        const res = await r.json();
        if (!r.ok || res.ok === false) {
          throw new Error(res.detail || res.error || `HTTP ${r.status}`);
        }
        if (status) {
          status.hidden = false;
          status.textContent = 'Saved to hardware';
          setTimeout(() => {
            if (status.textContent === 'Saved to hardware') status.hidden = true;
          }, 3000);
        }
      } catch (e) {
        delete _pendingHardwareSettings[def.key];
        if (status) {
          status.hidden = false;
          status.textContent = `Could not save: ${e.message || e}`;
        }
        alert(`Failed to update ${def.key.replace(/_/g, ' ')}: ${e.message || e}`);
        // Re-sync from current device state
        loadHardwareSettings();
      }
    });
  }
}
initHardwareSettingsHandlers();

async function loadDeviceCapacity() {
  try {
    const r = await fetch('/api/devices/capacity');
    if (!r.ok) return;
    const j = await r.json();
    const active = activeJackeryDevice();
    const sn = active?.device_sn;
    const dev = (j.devices || []).find(d => d.device_sn === sn) || (j.devices || [])[0];
    if (!dev) return;
    const inp = $('capacity-input');
    const def = $('capacity-default');
    // Prefer the auto-detected value (main + N x pack from the live
    // battery_packs cache) over the bare device default — it's the
    // capacity actually used by the forecaster + smart-charge.
    if (def) {
      if (dev.auto_capacity_wh) {
        def.textContent =
          `(auto-detected: ${dev.auto_capacity_wh} Wh — ${dev.pack_count} packs + main; ` +
          `override only if Jackery's pack capacity differs from spec)`;
      } else {
        def.textContent = `(device default: ${dev.default_capacity_wh} Wh)`;
      }
    }
    if (inp) inp.value = dev.capacity_wh_override ?? '';
    inp.dataset.deviceSn = dev.device_sn;
  } catch (e) {
    console.warn('capacity load failed', e);
  }
  // Refresh the unknown-model banner alongside the capacity widget.
  refreshUnknownModelBanner();
}

// Banner state — sessionStorage so a dismiss survives tab switches but
// a reload still re-flags the unknown model (intentional; we want it
// visible until the user actually fixes it).
const UNKNOWN_MODEL_DISMISS_KEY = 'jackery-umb-dismissed';

// ============================================================
// DEVICE TAB: per-device learned parameters panel
// ============================================================
// Renders the resolution-ladder result for every key in
// energy_db.DEVICE_PARAM_KEYS. Each row shows where the value came
// from (user override / fit / probe / catalog / default / unknown),
// with inline override + reset controls. Same data is exposed to the
// AI advisor so the parameter story is uniform across the app.

async function loadDeviceParams() {
  const list = $('device-params-list');
  if (!list) return;
  const dev = activeJackeryDevice();
  if (!dev?.device_sn) {
    list.innerHTML = '<div class="hint">No active device.</div>';
    return;
  }
  list.innerHTML = '<div class="hint">Loading…</div>';
  try {
    const r = await fetch(`/api/devices/params?device_sn=${encodeURIComponent(dev.device_sn)}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    renderDeviceParams(j.params || [], dev.device_sn);
  } catch (e) {
    list.innerHTML = `<div class="hint">Failed to load: ${escapeHtml(e.message || e)}</div>`;
  }
}

function renderDeviceParams(rows, deviceSn) {
  const list = $('device-params-list');
  if (!list) return;
  if (!rows.length) {
    list.innerHTML = '<div class="hint">No parameters available yet.</div>';
    return;
  }
  const safe = (s) => String(s == null ? '' : s).replace(/[<>&"]/g, (c) =>
    ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]));
  const fmtVal = (v, unit) => v == null ? '—' : (
    unit === 'ratio' ? Number(v).toFixed(3) : `${Math.round(Number(v))} ${safe(unit)}`
  );
  const sourceTag = (src) => `<span class="device-param-source device-param-source-${safe(src)}">${safe(src)}</span>`;
  // Currently only max_charge_w has a debug-samples endpoint. As more
  // fits add return_candidates support, list them here.
  const DEBUGGABLE = new Set(['max_charge_w']);
  list.innerHTML = rows.map((p) => `
    <div class="device-param-row" data-key="${safe(p.key)}">
      <div>
        <div class="device-param-label">${safe(p.label || p.key)}</div>
        <div class="device-param-desc">${safe(p.description || '')}${
          p.n_samples ? ` · fit from ${p.n_samples} samples` : ''
        }</div>
      </div>
      <div class="device-param-value">${fmtVal(p.value, p.unit)}</div>
      <div class="device-param-edit" style="display:flex; gap:6px; align-items:center">
        ${sourceTag(p.source || 'unknown')}
        ${DEBUGGABLE.has(p.key)
          ? '<button class="btn btn-ghost btn-small" data-action="debug" type="button">Inspect</button>'
          : ''}
        ${(p.source === 'fit' || p.source === 'probe' || p.source === 'catalog')
          ? '<button class="btn btn-ghost btn-small" data-action="refit" type="button" title="Drop the stored value and re-resolve from the ladder">Refit</button>'
          : ''}
        <button class="btn btn-ghost btn-small" data-action="override" type="button">Override</button>
        ${p.source === 'user' ? '<button class="btn btn-ghost btn-small" data-action="reset" type="button">Reset</button>' : ''}
      </div>
    </div>
    <div class="device-param-debug" data-debug-for="${safe(p.key)}" hidden></div>`).join('');
  list.querySelectorAll('[data-action="override"]').forEach((btn) => {
    btn.addEventListener('click', () => promptOverrideParam(btn, deviceSn, rows));
  });
  list.querySelectorAll('[data-action="reset"]').forEach((btn) => {
    btn.addEventListener('click', () => resetParam(btn, deviceSn));
  });
  list.querySelectorAll('[data-action="debug"]').forEach((btn) => {
    btn.addEventListener('click', () => inspectParam(btn, deviceSn));
  });
  list.querySelectorAll('[data-action="refit"]').forEach((btn) => {
    btn.addEventListener('click', () => refitParam(btn, deviceSn));
  });
}

async function refitParam(btn, deviceSn) {
  const row = btn.closest('.device-param-row');
  const key = row?.dataset.key;
  if (!key) return;
  const status = $('device-params-status');
  if (status) {
    status.hidden = false;
    status.textContent = 'Re-resolving…';
  }
  try {
    const r = await fetch('/api/devices/params/refit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ device_sn: deviceSn, key }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.detail || `HTTP ${r.status}`);
    if (status) {
      status.textContent = `Refit: ${j.value} (source=${j.source}${j.n_samples ? `, n=${j.n_samples}` : ''})`;
      setTimeout(() => { status.hidden = true; }, 4000);
    }
    loadDeviceParams();
  } catch (e) {
    if (status) status.textContent = `Refit failed: ${e.message || e}`;
  }
}

async function inspectParam(btn, deviceSn) {
  const row = btn.closest('.device-param-row');
  const key = row?.dataset.key;
  if (!key) return;
  const panel = document.querySelector(`.device-param-debug[data-debug-for="${key}"]`);
  if (!panel) return;
  if (!panel.hidden) { panel.hidden = true; return; }
  panel.hidden = false;
  panel.innerHTML = '<div class="hint" style="padding:8px 12px">Loading samples…</div>';
  try {
    const r = await fetch(
      `/api/devices/params?device_sn=${encodeURIComponent(deviceSn)}&debug_key=${encodeURIComponent(key)}`,
    );
    const j = await r.json();
    const dbg = j.debug || {};
    if (dbg.error) {
      panel.innerHTML = `<div class="hint" style="padding:8px 12px;color:#ef4444">Failed: ${dbg.error}</div>`;
      return;
    }
    const samples = dbg.samples || [];
    if (!samples.length) {
      panel.innerHTML = '<div class="hint" style="padding:8px 12px">No samples returned by the fit.</div>';
      return;
    }
    const safe = (s) => String(s == null ? '' : s).replace(/[<>&"]/g, (c) =>
      ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]));
    const fmtTime = (ts) => ts ? new Date(ts * 1000).toLocaleString() : '—';
    const rows_html = samples.map(s => `
      <tr>
        <td>${fmtTime(s.ts)}</td>
        <td>${Math.round(s.input_w || 0)}</td>
        <td>${Math.round(s.ac_input_w || 0)}</td>
        <td>${Math.round(s.solar_w || 0)}</td>
        <td>${s.ghi_w_m2 == null ? '—' : Math.round(s.ghi_w_m2)}</td>
        <td>${s.value_used == null ? '—' : Math.round(s.value_used)}</td>
        <td>${safe(s.path)}</td>
      </tr>`).join('');
    panel.innerHTML = `
      <div class="dd-section" style="padding:8px 12px">
        <h4>Samples used by the fit (n=${dbg.n_used_in_fit}, weather_observations=${dbg.weather_observations || 0}, tz_offset=${dbg.tz_offset_seconds}s)</h4>
        <p class="hint" style="margin:4px 0 8px">Each row is one hourly bucket. The 95th percentile of <strong>value_used</strong> gives the fitted result. Path values: <code>ac_input_w</code> = cloud-classified AC, <code>input_w_dark_ghi</code> = no-solar via weather GHI &lt; 50 W/m² (best signal), <code>input_w_night</code> = no-solar via local clock fallback when no weather, <code>skipped_solar_possible</code> = daytime with weather, <code>skipped_daytime_no_ghi</code> = daytime no weather, <code>below_min_input</code> = idle.</p>
        <div style="overflow-x:auto">
          <table class="dd-table">
            <thead><tr>
              <th>hour</th><th>input_w</th><th>ac_input_w</th><th>solar_w</th><th>GHI W/m²</th><th>value_used</th><th>path</th>
            </tr></thead>
            <tbody>${rows_html}</tbody>
          </table>
        </div>
      </div>`;
  } catch (e) {
    panel.innerHTML = `<div class="hint" style="padding:8px 12px;color:#ef4444">Failed: ${escapeHtml(e.message || e)}</div>`;
  }
}

async function promptOverrideParam(btn, deviceSn, rows) {
  const row = btn.closest('.device-param-row');
  const key = row?.dataset.key;
  if (!key) return;
  const meta = rows.find(p => p.key === key) || {};
  const cur = meta.value != null ? Number(meta.value).toString() : '';
  const v = prompt(
    `Override ${meta.label || key} (in ${meta.unit || 'units'}).\n\n` +
    `Current: ${cur || '(unknown)'}\nLeave blank to cancel.`,
    cur,
  );
  if (v === null || v.trim() === '') return;
  const num = parseFloat(v);
  if (Number.isNaN(num)) { alert('Not a number.'); return; }
  await saveDeviceParam(deviceSn, key, num);
}

async function resetParam(btn, deviceSn) {
  const row = btn.closest('.device-param-row');
  const key = row?.dataset.key;
  if (!key) return;
  if (!confirm('Clear your override and let the dashboard auto-learn this value?')) return;
  await saveDeviceParam(deviceSn, key, null);
}

async function saveDeviceParam(deviceSn, key, value) {
  const status = $('device-params-status');
  if (status) {
    status.hidden = false;
    status.textContent = value == null ? 'Resetting…' : 'Saving…';
  }
  try {
    const r = await fetch('/api/devices/params', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ device_sn: deviceSn, key, value }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.detail || `HTTP ${r.status}`);
    if (status) {
      status.textContent = 'Saved.';
      setTimeout(() => { status.hidden = true; }, 2000);
    }
    loadDeviceParams();  // re-render so "Reset" button appears/disappears
  } catch (e) {
    if (status) status.textContent = `Failed: ${e.message || e}`;
  }
}


async function refreshUnknownModelBanner() {
  const banner = $('unknown-model-banner');
  if (!banner) return;
  if (sessionStorage.getItem(UNKNOWN_MODEL_DISMISS_KEY) === '1') {
    banner.hidden = true;
    return;
  }
  try {
    const r = await fetch('/api/devices');
    if (!r.ok) { banner.hidden = true; return; }
    const j = await r.json();
    const active = activeJackeryDevice();
    const sn = active?.device_sn;
    const dev = (j.devices || []).find(d => d.device_sn === sn) || (j.devices || [])[0];
    if (!dev || dev.model_recognized !== false) {
      banner.hidden = true;
      return;
    }
    banner.hidden = false;
    $('umb-name').textContent = dev.model_name || dev.name || 'this device';
    $('umb-code').textContent = String(dev.model_code ?? '?');
    $('umb-fallback').textContent = `${dev.inferred_capacity_wh ?? '—'} Wh`;
    banner.dataset.modelCode = String(dev.model_code ?? '');
    banner.dataset.modelName = dev.model_name || '';
    banner.dataset.deviceSn  = dev.device_sn || '';
    refreshProbeCandidates(dev.device_sn);
  } catch (e) {
    console.warn('unknown-model banner refresh failed', e);
    banner.hidden = true;
  }
}

let _probePollTimer = null;
async function refreshProbeCandidates(deviceSn) {
  const status = $('umb-probe-status');
  const list = $('umb-candidates');
  if (!status || !list || !deviceSn) return;
  if (_probePollTimer) { clearTimeout(_probePollTimer); _probePollTimer = null; }
  try {
    const params = `?device_sn=${encodeURIComponent(deviceSn)}`;
    const r = await fetch(`/api/devices/probe_results${params}`);
    if (!r.ok) { status.textContent = 'Probe results unavailable.'; list.innerHTML = ''; return; }
    const j = await r.json();
    const safe = (s) => String(s || '').replace(/[<>&"]/g, (c) =>
      ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]));
    if (!j.found && j.in_flight) {
      status.textContent = 'Probing cloud for capacity hints… (~10-30s)';
      list.innerHTML = '';
      _probePollTimer = setTimeout(() => refreshProbeCandidates(deviceSn), 4000);
      return;
    }
    if (!j.found) {
      status.textContent = 'No probe yet. Click "Probe again" to try.';
      list.innerHTML = '';
      return;
    }
    if (j.error) {
      status.textContent = `Probe failed: ${j.error}`;
      list.innerHTML = '';
      return;
    }
    const cands = j.candidates || [];
    if (!cands.length) {
      status.textContent = 'Cloud probe completed but no capacity-shaped fields found. Set a manual override below.';
      list.innerHTML = '';
      return;
    }
    status.textContent = `Cloud probe found ${cands.length} capacity-shaped value(s):`;
    list.innerHTML = cands.map((c, i) => `
      <div class="probe-candidate">
        <span class="probe-cap-value">${Math.round(c.capacity_wh)} Wh</span>
        <span class="probe-cap-source hint">${safe(c.endpoint)} → <code>${safe(c.key_path)}</code> (${c.units}: ${safe(c.raw_value)})</span>
        <button class="btn btn-primary btn-small" data-cand-index="${i}" type="button">Use this value</button>
      </div>`).join('');
    list.querySelectorAll('[data-cand-index]').forEach((btn) => {
      btn.addEventListener('click', () => useProbeCandidate(deviceSn, cands[parseInt(btn.dataset.candIndex, 10)]));
    });
  } catch (e) {
    status.textContent = `Probe lookup failed: ${e.message || e}`;
    list.innerHTML = '';
  }
}

async function useProbeCandidate(deviceSn, candidate) {
  if (!candidate) return;
  const wh = Math.round(candidate.capacity_wh);
  if (!confirm(`Set capacity for this device to ${wh} Wh from ${candidate.endpoint}?`)) return;
  try {
    const r = await fetch('/api/devices/capacity', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ device_sn: deviceSn, capacity_wh: wh }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.detail || `HTTP ${r.status}`);
    const status = $('capacity-status');
    if (status) {
      status.hidden = false;
      status.textContent = `Saved ${wh} Wh from cloud probe.`;
      setTimeout(() => { status.hidden = true; }, 3000);
    }
    loadDeviceCapacity();
  } catch (e) {
    alert(`Failed to apply capacity: ${e.message || e}`);
  }
}

document.getElementById('umb-reprobe')?.addEventListener('click', async () => {
  const banner = $('unknown-model-banner');
  const sn = banner?.dataset?.deviceSn;
  if (!sn) return;
  const status = $('umb-probe-status');
  if (status) status.textContent = 'Re-probing cloud…';
  try {
    await fetch(`/api/devices/probe_now?device_sn=${encodeURIComponent(sn)}`, { method: 'POST' });
    refreshProbeCandidates(sn);
  } catch (e) {
    if (status) status.textContent = `Re-probe failed: ${e.message || e}`;
  }
});

document.getElementById('umb-dismiss')?.addEventListener('click', () => {
  sessionStorage.setItem(UNKNOWN_MODEL_DISMISS_KEY, '1');
  const banner = $('unknown-model-banner');
  if (banner) banner.hidden = true;
});

document.getElementById('umb-copy')?.addEventListener('click', async () => {
  const banner = $('unknown-model-banner');
  if (!banner) return;
  const mc = banner.dataset.modelCode || '?';
  const mn = banner.dataset.modelName || 'Unknown model';
  const inp = $('capacity-input');
  const guessedCap = inp?.value?.trim() || '<TODO: look up your model\'s nominal Wh>';
  const today = new Date().toISOString().slice(0, 10);
  const snippet = [
    `// Add this entry to models.json under "models":`,
    `"${mc}": {`,
    `  "capacity_wh": ${guessedCap},`,
    `  "name": "${mn}",`,
    `  "comment": "Auto-detected on ${today} via Device tab"`,
    `}`,
  ].join('\n');
  const status = $('capacity-status');
  try {
    await navigator.clipboard.writeText(snippet);
    if (status) {
      status.hidden = false;
      status.textContent = 'PR snippet copied — paste into models.json and open a PR.';
      setTimeout(() => { status.hidden = true; }, 5000);
    }
  } catch {
    // Clipboard blocked — drop into a textarea fallback.
    const ta = document.createElement('textarea');
    ta.value = snippet;
    ta.style.cssText = 'position:fixed;top:10vh;left:5vw;width:90vw;height:30vh;z-index:9999;font-family:monospace;font-size:13px';
    document.body.appendChild(ta);
    ta.select();
    setTimeout(() => {
      const dismiss = (ev) => {
        if (ev.target === ta) return;
        ta.remove();
        document.removeEventListener('click', dismiss, true);
      };
      document.addEventListener('click', dismiss, true);
    }, 50);
  }
});

document.getElementById('capacity-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const inp = $('capacity-input');
  const status = $('capacity-status');
  const sn = inp.dataset.deviceSn;
  if (!sn) return;
  const raw = inp.value.trim();
  const capacity_wh = raw ? parseInt(raw, 10) : null;
  status.hidden = false;
  status.textContent = 'Saving…';
  try {
    const r = await fetch('/api/devices/capacity', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ device_sn: sn, capacity_wh }),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.detail || ('HTTP ' + r.status));
    }
    status.textContent = 'Saved.';
    setTimeout(() => { status.hidden = true; }, 2500);
  } catch (err) {
    status.textContent = `Save failed: ${err.message || err}`;
  }
});

$('capacity-clear')?.addEventListener('click', async () => {
  const inp = $('capacity-input');
  inp.value = '';
  // Trigger the form's submit logic so the override gets cleared on the
  // server side.
  $('capacity-form').dispatchEvent(new Event('submit', { cancelable: true }));
});

$('cloud-probe-btn')?.addEventListener('click', async () => {
  const dump = $('cloud-probe-dump');
  const btn  = $('cloud-probe-btn');
  if (!dump) return;
  dump.hidden = false;
  btn.textContent = 'Probing…';
  btn.disabled = true;
  dump.textContent = 'Sending probe requests to the Jackery cloud (this may take 5-10 seconds)…';
  try {
    const r = await fetch('/api/debug/cloud_probe');
    const j = await r.json();
    btn.textContent = 'Probe again';
    btn.disabled = false;
    if (j.error) {
      dump.textContent = `Error: ${j.error}`;
      return;
    }
    const results = j.results || {};
    const lines = [];
    for (const [path, resp] of Object.entries(results)) {
      lines.push(`=== ${path} ===`);
      lines.push(JSON.stringify(resp, null, 2));
      lines.push('');
    }
    dump.textContent = lines.join('\n');
  } catch (e) {
    btn.textContent = 'Probe again';
    btn.disabled = false;
    dump.textContent = `Failed: ${e.message || e}`;
  }
});

$('raw-props-toggle')?.addEventListener('click', async () => {
  const dump = $('raw-props-dump');
  const btn  = $('raw-props-toggle');
  if (!dump.hidden) {
    dump.hidden = true;
    btn.textContent = 'Show';
    return;
  }
  dump.hidden = false;
  btn.textContent = 'Refresh';
  dump.textContent = 'Loading…';
  try {
    const r = await fetch('/api/debug/raw_props');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    if (j.error) {
      dump.textContent = `Error: ${j.error}`;
      return;
    }
    const props = j.props || {};
    const keys = Object.keys(props).sort();
    if (!keys.length) {
      dump.textContent = '(no properties yet — wait for the bridge to poll)';
      return;
    }
    dump.textContent = keys.map(k => `${k.padEnd(12)} = ${JSON.stringify(props[k])}`).join('\n');
  } catch (e) {
    dump.textContent = `Failed: ${e.message || e}`;
  }
});

// ============================================================
// AUTOMATION TAB
// ============================================================
let _savedKasaDevices = [];   // last loaded list of saved devices

async function loadAutomation() {
  // Load creds-status, saved devices, and rules in parallel.
  await Promise.all([loadKasaCreds(), loadSavedKasa(), loadRules()]);
}

async function loadKasaCreds() {
  const status = $('kasa-creds-status');
  const emailIn = $('kasa-creds-email');
  if (!status) return;
  try {
    const r = await fetch('/api/kasa/credentials');
    const j = await r.json();
    if (j.has_credentials) {
      status.textContent = `saved · ${j.email || ''}`;
      if (emailIn && !emailIn.value) emailIn.value = j.email || '';
    } else {
      status.textContent = 'not set';
    }
  } catch (e) {
    status.textContent = 'failed to load';
  }
}

document.getElementById('kasa-creds-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('kasa-creds-email').value.trim();
  const password = $('kasa-creds-password').value;
  const msg = $('kasa-creds-msg');
  msg.hidden = false; msg.textContent = 'Saving…';
  try {
    const r = await fetch('/api/kasa/credentials', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.detail || j.error || ('HTTP ' + r.status));
    msg.textContent = 'Saved.';
    $('kasa-creds-password').value = '';
    setTimeout(() => { msg.hidden = true; }, 2000);
    loadKasaCreds();
  } catch (err) {
    msg.textContent = 'Failed: ' + (err.message || err);
  }
});

$('kasa-creds-clear')?.addEventListener('click', async () => {
  if (!confirm('Forget saved Kasa credentials?')) return;
  await fetch('/api/kasa/credentials', { method: 'DELETE' });
  $('kasa-creds-password').value = '';
  loadKasaCreds();
});

async function loadSavedKasa() {
  const list = $('kasa-list');
  if (!list) return;
  list.innerHTML = '<div class="auto-empty">Loading devices…</div>';
  try {
    // refresh=true on the user-initiated load forces a fresh probe so
    // the first paint reflects current reality. Subsequent polls (see
    // _kasaPollTimer below) just read the reconciler-maintained cache.
    const r = await fetch('/api/kasa/saved?refresh=true');
    const j = await r.json();
    _savedKasaDevices = j.devices || [];
    renderSavedKasa(_savedKasaDevices);
  } catch (e) {
    list.innerHTML = `<div class="auto-empty">Failed to load: ${escapeHtml(e.message || e)}</div>`;
  }
  _scheduleSavedKasaPoll();
}

// Background re-sync of the Kasa list while the user is on the
// Automation tab.
//
// All-online state: poll the server's cached state every 60s (cheap).
//   The kasa_reconciler_loop keeps that cache fresh on its own
//   schedule.
// Any-offline state: poll with refresh=true (force a probe) every
//   60s. The reconciler's per-device backoff grows up to 30 min after
//   consecutive failures, so the cache can be that stale; without the
//   forced probe the UI sits on OFFLINE long after the plug has
//   recovered. Probing 1-3 plugs per minute is cheap, and we only do
//   it while the user is actively staring at the tab.
let _kasaPollTimer = null;
function _scheduleSavedKasaPoll() {
  if (_kasaPollTimer) { clearInterval(_kasaPollTimer); _kasaPollTimer = null; }
  _kasaPollTimer = setInterval(async () => {
    if (activeTab !== 'automation') {
      clearInterval(_kasaPollTimer);
      _kasaPollTimer = null;
      return;
    }
    try {
      const anyOffline = (_savedKasaDevices || []).some(
        (d) => d.online === false,
      );
      const url = anyOffline
        ? '/api/kasa/saved?refresh=true'
        : '/api/kasa/saved';
      const r = await fetch(url);
      if (!r.ok) return;
      const j = await r.json();
      const next = j.devices || [];
      // Only re-render if the displayed state actually changed.
      // Comparing on the fields the row template depends on keeps
      // arbitrary stat reorderings from triggering layout flicker.
      if (_kasaListChanged(_savedKasaDevices, next)) {
        _savedKasaDevices = next;
        renderSavedKasa(_savedKasaDevices);
      }
    } catch { /* network blip — just try again next tick */ }
  }, 60_000);
}

function _kasaListChanged(prev, next) {
  if ((prev?.length || 0) !== (next?.length || 0)) return true;
  const keysWeRender = ['host', 'alias', 'model', 'is_on', 'online',
    'error', 'last_seen_ts', 'jackery_device_sn'];
  for (let i = 0; i < next.length; i++) {
    const a = prev[i] || {};
    const b = next[i] || {};
    for (const k of keysWeRender) {
      if ((a[k] ?? null) !== (b[k] ?? null)) return true;
    }
  }
  return false;
}

function renderSavedKasa(devices) {
  const list = $('kasa-list');
  if (!devices.length) {
    list.innerHTML = '<div class="auto-empty">No Kasa devices yet. Click "+ Add device" to add one.</div>';
    return;
  }
  const safe = (s) => String(s ?? '').replace(/[<>&"]/g, (c) =>
    ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]));
  list.innerHTML = devices.map((d) => {
    const stateClass = d.online === false ? 'offline' : (d.is_on === true ? 'on' : (d.is_on === false ? 'off' : 'offline'));
    const stateText = d.online === false ? 'OFFLINE' : (d.is_on === true ? 'ON' : (d.is_on === false ? 'OFF' : '—'));
    const meta = [d.model, d.host].filter(Boolean).map((s, i) => i === 0 ? safe(s) : `<span class="host">${safe(s)}</span>`).join(' · ');
    // Resolve the assigned Jackery (if any) to a human label.
    let assignmentLabel = 'unassigned';
    if (d.jackery_device_sn) {
      const j = (lastDevices || []).find(x => x.device_sn === d.jackery_device_sn);
      assignmentLabel = j?.name || `…${d.jackery_device_sn.slice(-6)}`;
    }
    // Last-seen + error: only render when we actually have something to
    // say. A truncated error keeps the row from blowing up vertically;
    // hover the badge for the full text.
    const lastSeen = d.last_seen_ts
      ? new Date(d.last_seen_ts * 1000).toLocaleString()
      : null;
    const errLine = (d.online === false && d.error)
      ? `<div class="kr-error" title="${safe(d.error)}">⚠ ${safe(String(d.error).slice(0, 100))}${String(d.error).length > 100 ? '…' : ''}${lastSeen ? ` · last seen ${safe(lastSeen)}` : ''}</div>`
      : '';
    return `<div class="kasa-row" data-host="${safe(d.host)}">
      <span class="kr-state ${stateClass}">${stateText}</span>
      <div class="kr-name">
        <div class="kr-alias">${safe(d.alias)}</div>
        <div class="kr-meta">${meta} · <span class="kr-assignment">→ ${safe(assignmentLabel)}</span></div>
        ${errLine}
      </div>
      <div class="kasa-row-actions">
        <button class="btn btn-ghost" data-toggle="${safe(d.host)}" data-onstate="${d.is_on ? '1' : '0'}" type="button">${d.is_on ? 'Turn off' : 'Turn on'}</button>
      </div>
      <div class="kasa-row-actions">
        <button class="btn btn-ghost" data-edit-kasa="${safe(d.host)}" type="button">Edit</button>
        <button class="btn btn-ghost" data-del-kasa="${safe(d.host)}" type="button">Delete</button>
      </div>
    </div>`;
  }).join('');

  list.querySelectorAll('[data-toggle]').forEach((b) => {
    b.addEventListener('click', async () => {
      const host = b.dataset.toggle;
      const turnOn = b.dataset.onstate !== '1';
      b.disabled = true; b.textContent = '…';
      try {
        await fetch('/api/kasa/test', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ host, on: turnOn }),
        });
      } catch (e) {
        alert('Toggle failed: ' + (e.message || e));
      } finally {
        b.disabled = false;
        loadSavedKasa();
      }
    });
  });
  list.querySelectorAll('[data-edit-kasa]').forEach((b) => {
    b.addEventListener('click', () => openKasaEditor(devices.find((d) => d.host === b.dataset.editKasa)));
  });
  list.querySelectorAll('[data-del-kasa]').forEach((b) => {
    b.addEventListener('click', async () => {
      const d = devices.find((dd) => dd.host === b.dataset.delKasa);
      if (!d) return;
      if (!confirm(`Remove "${d.alias}" (${d.host})?\nAny rules using it will start failing.`)) return;
      const r = await fetch('/api/kasa/saved/' + encodeURIComponent(d.host), { method: 'DELETE' });
      const j = await r.json();
      if (j.rules_referencing && j.rules_referencing.length) {
        alert(`Removed. Note: ${j.rules_referencing.length} rule(s) still reference this device and will start logging errors.`);
      }
      loadSavedKasa();
    });
  });
}

function openKasaEditor(device) {
  const ed = $('kasa-editor');
  if (!ed) return;
  ed.hidden = false;
  $('kasa-editor-title').textContent = device ? 'Edit Kasa device' : 'Add Kasa device';
  $('kasa-host').value  = device?.host  || '';
  $('kasa-host').disabled = !!device;   // host is the primary key — locked when editing
  $('kasa-alias').value = device?.alias || '';
  // Populate the Jackery-assignment dropdown from the device picker.
  const sel = $('kasa-jackery-sn');
  if (sel) {
    sel.innerHTML = '<option value="">— unassigned (visible to all) —</option>';
    const jackerys = (lastDevices || []);
    for (const d of jackerys) {
      const opt = document.createElement('option');
      opt.value = d.device_sn || '';
      opt.textContent = `${d.name || d.device_sn} (…${(d.device_sn || '').slice(-6)})`;
      sel.appendChild(opt);
    }
    // Default: existing assignment, else the active Jackery on Add.
    if (device) {
      sel.value = device.jackery_device_sn || '';
    } else {
      sel.value = activeJackeryDevice()?.device_sn || '';
    }
  }
  $('kasa-test-result').hidden = true;
  ed.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function closeKasaEditor() {
  const ed = $('kasa-editor');
  if (ed) ed.hidden = true;
  $('kasa-host').disabled = false;
}

$('kasa-add')?.addEventListener('click', () => openKasaEditor(null));
$('kasa-cancel')?.addEventListener('click', closeKasaEditor);
$('kasa-editor-close')?.addEventListener('click', closeKasaEditor);

$('kasa-test-btn')?.addEventListener('click', async () => {
  const host = $('kasa-host').value.trim();
  const result = $('kasa-test-result');
  result.hidden = false; result.textContent = 'Connecting…';
  if (!host) { result.textContent = 'Enter an IP first.'; return; }
  try {
    const r = await fetch('/api/kasa/status?host=' + encodeURIComponent(host));
    const j = await r.json();
    if (!r.ok) throw new Error(j.detail || j.error || ('HTTP ' + r.status));
    result.textContent = `OK · ${j.alias} (${j.model || 'unknown'}) currently ${j.is_on ? 'ON' : 'OFF'}`;
    if (j.alias && !$('kasa-alias').value) $('kasa-alias').value = j.alias;
  } catch (e) {
    result.textContent = 'Failed: ' + (e.message || e);
  }
});

document.getElementById('kasa-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {
    host:  $('kasa-host').value.trim(),
    alias: $('kasa-alias').value.trim(),
    // Empty string explicitly unassigns the plug; non-empty assigns it
    // to that Jackery's smart-charge / per-device rule pickers.
    jackery_device_sn: $('kasa-jackery-sn')?.value ?? '',
  };
  if (!body.host) return;
  const result = $('kasa-test-result');
  result.hidden = false; result.textContent = 'Saving…';
  try {
    const r = await fetch('/api/kasa/saved', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.detail || j.error || ('HTTP ' + r.status));
    closeKasaEditor();
    loadSavedKasa();
  } catch (err) {
    result.textContent = 'Save failed: ' + (err.message || err);
  }
});

// Filter mode: 'active' = only rules for the currently-selected Jackery
// device (driven by the top-right Device picker). 'all' = show everything.
let _ruleFilterMode = 'active';
let _allRules = [];

async function loadRules() {
  const list = $('auto-rules');
  if (!list) return;
  list.innerHTML = '<div class="auto-empty">Loading rules…</div>';
  try {
    const r = await fetch('/api/automation/rules');
    const j = await r.json();
    _allRules = j.rules || [];
    renderRulesWithFilter();
  } catch (e) {
    list.innerHTML = `<div class="auto-empty">Failed to load: ${escapeHtml(e.message || e)}</div>`;
  }
}

function activeJackeryDevice() {
  if (!lastStatus || !lastStatus.cloud) return null;
  const sel = lastStatus.cloud.selected_device_id;
  return (lastStatus.cloud.devices || []).find((d) => d.device_id === sel) || null;
}

function renderRulesWithFilter() {
  const filterName = $('auto-rules-filter-name');
  const toggle = $('auto-rules-filter-toggle');
  const active = activeJackeryDevice();
  let displayed = _allRules;

  if (_ruleFilterMode === 'active' && active) {
    if (filterName) filterName.textContent = active.name || active.device_sn;
    if (toggle) toggle.textContent = 'Show all';
    displayed = _allRules.filter((r) =>
      r.jackery_device_sn === active.device_sn || !r.jackery_device_sn);
  } else {
    if (filterName) filterName.textContent = 'All devices';
    if (toggle) toggle.textContent = active ? `Filter to "${active.name || active.device_sn}"` : 'Filter';
  }

  renderAutomationRules(displayed);
}

$('auto-rules-filter-toggle')?.addEventListener('click', () => {
  _ruleFilterMode = (_ruleFilterMode === 'active') ? 'all' : 'active';
  renderRulesWithFilter();
});

function renderAutomationRules(rules) {
  const list = $('auto-rules');
  if (!rules.length) {
    list.innerHTML = '<div class="auto-empty">No rules yet. Click "+ New rule" to add one.</div>';
    return;
  }
  const safe = (s) => String(s).replace(/[<>&"]/g, (c) =>
    ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]));
  const opLabel = { '<':'&lt;', '<=':'&le;', '=':'=', '==':'=', '!=':'&ne;', '>=':'&ge;', '>':'&gt;' };
  const formatDayVal = (val) => {
    const map = {
      'weekend_or_holiday': 'Weekends & Holidays',
      'weekday_not_holiday': 'Weekdays (excl. holidays)',
      'weekday': 'Weekdays',
      'weekend': 'Weekends',
      'holiday': 'Holidays',
      'monday': 'Monday', 'tuesday': 'Tuesday', 'wednesday': 'Wednesday',
      'thursday': 'Thursday', 'friday': 'Friday', 'saturday': 'Saturday', 'sunday': 'Sunday',
    };
    return map[String(val).toLowerCase()] || val;
  };

  list.innerHTML = rules.map((r) => {
    const fired = r.last_fired
      ? 'last fired ' + new Date(r.last_fired * 1000).toLocaleString()
      : 'never fired';
    const errLine = r.last_error
      ? `<div class="ar-meta err">last error: ${safe(r.last_error)}</div>`
      : '';
    // Make it explicit which Jackery device drives or receives this rule.
    const jackeryName = r.jackery_device_name || r.jackery_device_sn || '(any device)';

    // Build conditions HTML
    const conds = (r.conditions && r.conditions.length)
      ? r.conditions
      : [{ type: r.trigger || 'battery_percent', operator: r.operator, value: r.value }];

    const hasDeviceSpecific = conds.some((c) => {
      const t = c.type || 'battery_percent';
      return t === 'battery_percent' || t === 'device_status' || t === 'device_online';
    });

    const condParts = conds.map((c) => {
      const op = opLabel[c.operator] || c.operator;
      if (c.type === 'device_status' || c.type === 'device_online') {
        const valLabel = (c.value === 'online' || c.value === true || c.value === '1') ? 'online' : 'offline';
        return `status <span class="op">${op}</span> <span class="val">${safe(valLabel)}</span>`;
      }
      if (c.type === 'time_of_day') {
        return `time <span class="op">${op}</span> <span class="val">${safe(c.value)}</span>`;
      }
      if (c.type === 'day_of_week' || c.type === 'weekday') {
        return `day <span class="op">${op}</span> <span class="val">${safe(formatDayVal(c.value))}</span>`;
      }
      if (c.type === 'day_of_month' || c.type === 'dom') {
        return `day of month <span class="op">${op}</span> <span class="val">${safe(c.value)}</span>`;
      }
      return `battery <span class="op">${op}</span> <span class="val">${c.value}%</span>`;
    });
    const condsText = condParts.join(' <span class="ar-and">AND</span> ');
    const devicePrefix = hasDeviceSpecific ? `<span class="device">${safe(jackeryName)}</span> ` : '';

    let actionText = '';
    if (r.action_type === 'jackery_setting' || r.setting) {
      const isEnable = r.action === 'on' || r.action === 'enable' || r.action === 'true';
      const settingLabel = r.setting === 'battery_saving' ? 'Battery Saving Mode' : (r.setting || 'Setting');
      const valLabel = isEnable ? 'ENABLE (85% eco limit)' : 'DISABLE (charge to 100%)';
      actionText = `set <span class="action ${isEnable ? 'on' : 'off'}">${safe(settingLabel)} → ${valLabel}</span> on <span class="device">${safe(jackeryName)}</span>`;
    } else {
      actionText = `turn <span class="action ${r.action}">${r.action.toUpperCase()}</span> → <span class="device">${safe(r.kasa_alias || r.kasa_host)}</span>`;
    }

    return `<div class="auto-rule ${r.enabled ? '' : 'disabled'}" data-id="${r.id}">
      <div>
        <div class="ar-title">${safe(r.name)}</div>
        <div class="ar-cond">
          when ${devicePrefix}${condsText},
          ${actionText}
        </div>
        <div class="ar-meta">${fired}</div>
        ${errLine}
      </div>
      <div class="auto-rule-actions">
        <label class="auto-toggle">
          <input type="checkbox" data-toggle="${r.id}" ${r.enabled ? 'checked' : ''} />
          ${r.enabled ? 'enabled' : 'paused'}
        </label>
        <button class="btn btn-ghost" data-history="${r.id}" type="button">History</button>
        <button class="btn btn-ghost" data-edit="${r.id}" type="button">Edit</button>
        <button class="btn btn-ghost" data-del="${r.id}" type="button">Delete</button>
      </div>
    </div>`;
  }).join('');

  // Wire per-row controls
  list.querySelectorAll('[data-history]').forEach((b) => {
    b.addEventListener('click', () =>
      openAutomationHistory(rules.find((r) => r.id === b.dataset.history)));
  });
  list.querySelectorAll('[data-edit]').forEach((b) => {
    b.addEventListener('click', () => openAutomationEditor(rules.find((r) => r.id === b.dataset.edit)));
  });
  list.querySelectorAll('[data-del]').forEach((b) => {
    b.addEventListener('click', async () => {
      const r = rules.find((rr) => rr.id === b.dataset.del);
      if (!r) return;
      if (!confirm(`Delete "${r.name}"?`)) return;
      await fetch('/api/automation/rules/' + encodeURIComponent(r.id), { method: 'DELETE' });
      loadAutomation();
    });
  });
  list.querySelectorAll('[data-toggle]').forEach((b) => {
    b.addEventListener('change', async () => {
      const r = rules.find((rr) => rr.id === b.dataset.toggle);
      if (!r) return;
      r.enabled = b.checked;
      await fetch('/api/automation/rules', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(r),
      });
      loadAutomation();
    });
  });
}

let _editorConditions = [];

function _renderEditorConditions() {
  const container = $('auto-conditions-list');
  if (!container) return;
  if (!_editorConditions.length) {
    _editorConditions = [{ type: 'battery_percent', operator: '<', value: 20 }];
  }
  const canDelete = _editorConditions.length > 1;

  container.innerHTML = _editorConditions.map((cond, idx) => {
    const isTime = cond.type === 'time_of_day';
    const isDay = cond.type === 'day_of_week' || cond.type === 'weekday';
    const isDom = cond.type === 'day_of_month' || cond.type === 'dom';
    const isStatus = cond.type === 'device_status' || cond.type === 'device_online';
    const isBatt = !isTime && !isDay && !isDom && !isStatus;
    const divider = idx > 0
      ? `<div class="auto-cond-divider"><span class="auto-cond-and">AND</span></div>`
      : '';
    return `${divider}
      <div class="auto-cond-row" data-cond-index="${idx}">
        <select class="auto-cond-type">
          <option value="battery_percent" ${isBatt ? 'selected' : ''}>Battery SOC</option>
          <option value="device_status" ${isStatus ? 'selected' : ''}>Battery Online/Offline</option>
          <option value="time_of_day" ${isTime ? 'selected' : ''}>Time of day</option>
          <option value="day_of_week" ${isDay ? 'selected' : ''}>Day of week</option>
          <option value="day_of_month" ${isDom ? 'selected' : ''}>Day of month</option>
        </select>
        <select class="auto-cond-op">
          <option value="=" ${cond.operator === '=' || cond.operator === '==' ? 'selected' : ''}>= is / equal</option>
          <option value="!=" ${cond.operator === '!=' ? 'selected' : ''}>!= is not</option>
          <option value="<" ${cond.operator === '<' ? 'selected' : ''} ${(isDay || isStatus) ? 'style="display:none"' : ''}>&lt; less than</option>
          <option value="<=" ${cond.operator === '<=' ? 'selected' : ''} ${(isDay || isStatus) ? 'style="display:none"' : ''}>&le; less or equal</option>
          <option value=">=" ${cond.operator === '>=' ? 'selected' : ''} ${(isDay || isStatus) ? 'style="display:none"' : ''}>&ge; greater or equal</option>
          <option value=">" ${cond.operator === '>' ? 'selected' : ''} ${(isDay || isStatus) ? 'style="display:none"' : ''}>&gt; greater than</option>
        </select>
        <div class="auto-cond-val-wrap">
          <div class="auto-cond-batt-wrap" ${!isBatt ? 'hidden' : ''}>
            <input type="number" class="auto-cond-val-batt" min="0" max="100" step="1" value="${isBatt ? (cond.value ?? 20) : 20}" placeholder="20" />
            <span class="auto-pct">%</span>
          </div>
          <div class="auto-cond-status-wrap" ${!isStatus ? 'hidden' : ''}>
            <select class="auto-cond-val-status">
              <option value="offline" ${(cond.value === 'offline' || cond.value === false || !cond.value) ? 'selected' : ''}>Offline (disconnected)</option>
              <option value="online" ${(cond.value === 'online' || cond.value === true) ? 'selected' : ''}>Online (connected)</option>
            </select>
          </div>
          <div class="auto-cond-time-wrap" ${!isTime ? 'hidden' : ''}>
            <input type="time" class="auto-cond-val-time" step="60" value="${isTime ? (cond.value || '20:00') : '20:00'}" />
          </div>
          <div class="auto-cond-day-wrap" ${!isDay ? 'hidden' : ''}>
            <select class="auto-cond-val-day">
              <option value="weekend_or_holiday" ${cond.value === 'weekend_or_holiday' ? 'selected' : ''}>Weekends & Holidays</option>
              <option value="weekday_not_holiday" ${cond.value === 'weekday_not_holiday' ? 'selected' : ''}>Weekdays (excl. holidays)</option>
              <option value="weekday" ${cond.value === 'weekday' ? 'selected' : ''}>Weekdays (Mon–Fri)</option>
              <option value="weekend" ${cond.value === 'weekend' ? 'selected' : ''}>Weekends (Sat–Sun)</option>
              <option value="holiday" ${cond.value === 'holiday' ? 'selected' : ''}>Statutory Holidays</option>
              <option value="monday" ${cond.value === 'monday' ? 'selected' : ''}>Monday</option>
              <option value="tuesday" ${cond.value === 'tuesday' ? 'selected' : ''}>Tuesday</option>
              <option value="wednesday" ${cond.value === 'wednesday' ? 'selected' : ''}>Wednesday</option>
              <option value="thursday" ${cond.value === 'thursday' ? 'selected' : ''}>Thursday</option>
              <option value="friday" ${cond.value === 'friday' ? 'selected' : ''}>Friday</option>
              <option value="saturday" ${cond.value === 'saturday' ? 'selected' : ''}>Saturday</option>
              <option value="sunday" ${cond.value === 'sunday' ? 'selected' : ''}>Sunday</option>
            </select>
          </div>
          <div class="auto-cond-dom-wrap" ${!isDom ? 'hidden' : ''}>
            <input type="text" class="auto-cond-val-dom" style="max-width:140px" placeholder="e.g. 1 or 1, 15 or last" value="${isDom ? (cond.value ?? '1') : '1'}" />
          </div>
        </div>
        <button type="button" class="btn btn-ghost auto-cond-del" title="Remove condition" data-cond-del="${idx}" ${canDelete ? '' : 'disabled style="opacity:0.3;cursor:not-allowed"'}>✕</button>
      </div>`;
  }).join('');

  // Wire type changes
  container.querySelectorAll('.auto-cond-row').forEach((row) => {
    const idx = parseInt(row.dataset.condIndex, 10);
    const typeSelect = row.querySelector('.auto-cond-type');
    const opSelect = row.querySelector('.auto-cond-op');
    const battWrap = row.querySelector('.auto-cond-batt-wrap');
    const statusWrap = row.querySelector('.auto-cond-status-wrap');
    const timeWrap = row.querySelector('.auto-cond-time-wrap');
    const dayWrap = row.querySelector('.auto-cond-day-wrap');
    const domWrap = row.querySelector('.auto-cond-dom-wrap');
    const battInput = row.querySelector('.auto-cond-val-batt');
    const statusSelect = row.querySelector('.auto-cond-val-status');
    const timeInput = row.querySelector('.auto-cond-val-time');
    const daySelect = row.querySelector('.auto-cond-val-day');
    const domInput = row.querySelector('.auto-cond-val-dom');

    typeSelect.addEventListener('change', () => {
      const isTime = typeSelect.value === 'time_of_day';
      const isDay = typeSelect.value === 'day_of_week';
      const isDom = typeSelect.value === 'day_of_month';
      const isStatus = typeSelect.value === 'device_status';
      const isBatt = !isTime && !isDay && !isDom && !isStatus;
      battWrap.hidden = !isBatt;
      if (statusWrap) statusWrap.hidden = !isStatus;
      timeWrap.hidden = !isTime;
      dayWrap.hidden = !isDay;
      domWrap.hidden = !isDom;
      opSelect.querySelectorAll('option').forEach((opt) => {
        if (['<', '<=', '>=', '>'].includes(opt.value)) {
          opt.style.display = (isDay || isStatus) ? 'none' : '';
        }
      });
      _editorConditions[idx].type = typeSelect.value;
      if (isTime) {
        _editorConditions[idx].value = timeInput.value || '20:00';
      } else if (isDay) {
        _editorConditions[idx].value = daySelect.value || 'weekend_or_holiday';
        if (!['=', '!='].includes(opSelect.value)) {
          opSelect.value = '=';
          _editorConditions[idx].operator = '=';
        }
      } else if (isStatus) {
        _editorConditions[idx].value = statusSelect ? statusSelect.value : 'offline';
        if (!['=', '!='].includes(opSelect.value)) {
          opSelect.value = '=';
          _editorConditions[idx].operator = '=';
        }
      } else if (isDom) {
        _editorConditions[idx].value = domInput.value || '1';
      } else {
        _editorConditions[idx].value = Number(battInput.value || 20);
      }
    });

    opSelect.addEventListener('change', () => {
      _editorConditions[idx].operator = opSelect.value;
    });

    battInput.addEventListener('input', () => {
      if (_editorConditions[idx].type === 'battery_percent') {
        _editorConditions[idx].value = Number(battInput.value);
      }
    });

    statusSelect?.addEventListener('change', () => {
      if (_editorConditions[idx].type === 'device_status') {
        _editorConditions[idx].value = statusSelect.value;
      }
    });

    timeInput.addEventListener('input', () => {
      if (_editorConditions[idx].type === 'time_of_day') {
        _editorConditions[idx].value = timeInput.value;
      }
    });

    daySelect.addEventListener('change', () => {
      if (_editorConditions[idx].type === 'day_of_week') {
        _editorConditions[idx].value = daySelect.value;
      }
    });

    domInput?.addEventListener('input', () => {
      if (_editorConditions[idx].type === 'day_of_month') {
        _editorConditions[idx].value = domInput.value;
      }
    });
  });

  // Wire delete buttons
  container.querySelectorAll('[data-cond-del]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (_editorConditions.length <= 1) return;
      const idx = parseInt(btn.dataset.condDel, 10);
      _syncEditorConditionsFromDom();
      _editorConditions.splice(idx, 1);
      _renderEditorConditions();
    });
  });
}

function _syncEditorConditionsFromDom() {
  const container = $('auto-conditions-list');
  if (!container) return;
  const rows = container.querySelectorAll('.auto-cond-row');
  const result = [];
  rows.forEach((row) => {
    const type = row.querySelector('.auto-cond-type')?.value || 'battery_percent';
    const operator = row.querySelector('.auto-cond-op')?.value || '=';
    let value;
    if (type === 'time_of_day') {
      value = row.querySelector('.auto-cond-val-time')?.value || '20:00';
    } else if (type === 'day_of_week') {
      value = row.querySelector('.auto-cond-val-day')?.value || 'weekend_or_holiday';
    } else if (type === 'day_of_month') {
      value = row.querySelector('.auto-cond-val-dom')?.value || '1';
    } else if (type === 'device_status') {
      value = row.querySelector('.auto-cond-val-status')?.value || 'offline';
    } else {
      value = Number(row.querySelector('.auto-cond-val-batt')?.value || 20);
    }
    result.push({ type, operator, value });
  });
  if (result.length) {
    _editorConditions = result;
  }
}

$('auto-cond-add')?.addEventListener('click', () => {
  _syncEditorConditionsFromDom();
  const hasBatt = _editorConditions.some((c) => c.type === 'battery_percent');
  const hasTime = _editorConditions.some((c) => c.type === 'time_of_day');
  const hasDay = _editorConditions.some((c) => c.type === 'day_of_week');
  if (!hasDay && (hasTime || hasBatt)) {
    _editorConditions.push({ type: 'day_of_week', operator: '=', value: 'weekend_or_holiday' });
  } else if (!hasTime && (hasDay || hasBatt)) {
    _editorConditions.push({ type: 'time_of_day', operator: '>=', value: '20:00' });
  } else if (!hasBatt) {
    _editorConditions.push({ type: 'battery_percent', operator: '>=', value: 30 });
  } else {
    _editorConditions.push({ type: 'day_of_week', operator: '=', value: 'weekday_not_holiday' });
  }
  _renderEditorConditions();
});

function _syncActionTypeVisibility() {
  const actionType = document.querySelector('input[name="auto-action-type"]:checked')?.value || 'kasa';
  const kasaGroup = $('auto-kasa-action-group');
  const settingGroup = $('auto-setting-action-group');
  if (kasaGroup) kasaGroup.hidden = (actionType !== 'kasa');
  if (settingGroup) settingGroup.hidden = (actionType !== 'jackery_setting');
}

document.querySelectorAll('input[name="auto-action-type"]').forEach((el) => {
  el.addEventListener('change', _syncActionTypeVisibility);
});

function openAutomationEditor(rule) {
  const ed = $('auto-editor');
  if (!ed) return;
  // Repopulate the Kasa device dropdown from the saved-devices list each
  // time so newly added devices appear without a tab switch.
  const pick = $('auto-kasa-pick');
  const hint = $('auto-kasa-pick-hint');
  if (!_savedKasaDevices.length) {
    pick.innerHTML = '<option value="">(no saved devices)</option>';
    pick.disabled = true;
    if (hint) hint.textContent = 'Add a Kasa device above before creating a plug rule.';
  } else {
    pick.disabled = false;
    pick.innerHTML = '<option value="">— choose a device —</option>' +
      _savedKasaDevices.map((d) =>
        `<option value="${d.host}">${d.alias} (${d.host})</option>`
      ).join('');
    if (hint) hint.textContent = '';
  }
  // Populate the Jackery device picker from lastStatus.cloud.devices —
  // the WS broadcast keeps that current.
  const jpick = $('auto-jackery');
  const jdevs = (lastStatus && lastStatus.cloud && lastStatus.cloud.devices) || [];
  if (!jdevs.length) {
    jpick.innerHTML = '<option value="">(no Jackery devices yet)</option>';
    jpick.disabled = true;
  } else {
    jpick.disabled = false;
    jpick.innerHTML = '<option value="">— choose a device —</option>' +
      jdevs.map((d) =>
        `<option value="${d.device_sn}">${d.name || d.model_name || d.device_sn}</option>`
      ).join('');
  }
  ed.hidden = false;
  $('auto-editor-title').textContent = rule ? 'Edit rule' : 'New rule';
  $('auto-id').value       = rule?.id || '';
  $('auto-name').value     = rule?.name || '';
  $('auto-kasa-pick').value = rule?.kasa_host || '';

  if (rule?.conditions && rule.conditions.length) {
    _editorConditions = JSON.parse(JSON.stringify(rule.conditions));
  } else if (rule && rule.operator) {
    _editorConditions = [{
      type: rule.trigger || 'battery_percent',
      operator: rule.operator,
      value: rule.value ?? 20,
    }];
  } else {
    _editorConditions = [{ type: 'battery_percent', operator: '<', value: 20 }];
  }
  _renderEditorConditions();

  // Pre-fill the Jackery picker: if editing an existing rule keep its sn,
  // otherwise default to whatever device the topbar dropdown is on so
  // creating a rule from "5000 Plus" view targets the 5000 Plus.
  const activeJackery = activeJackeryDevice();
  $('auto-jackery').value = rule?.jackery_device_sn
    || (activeJackery?.device_sn || '');
  $('auto-enabled').checked = rule ? !!rule.enabled : true;

  // Action type and values
  const actionType = rule?.action_type || (rule?.setting ? 'jackery_setting' : 'kasa');
  document.querySelectorAll('input[name="auto-action-type"]').forEach((el) => {
    el.checked = (el.value === actionType);
  });

  if (rule?.setting || actionType === 'jackery_setting') {
    if ($('auto-setting-pick')) $('auto-setting-pick').value = rule?.setting || 'battery_saving';
    const isEnable = rule?.action === 'on' || rule?.action === 'enable' || rule?.action === 'true' || rule?.action == null;
    document.querySelectorAll('input[name="auto-setting-val"]').forEach((el) => {
      el.checked = (el.value === (isEnable ? 'on' : 'off'));
    });
  } else {
    const action = rule?.action || 'off';
    document.querySelectorAll('input[name="auto-action"]').forEach((el) => {
      el.checked = (el.value === action);
    });
  }
  _syncActionTypeVisibility();
  ed.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function closeAutomationEditor() {
  const ed = $('auto-editor');
  if (ed) ed.hidden = true;
}

// ============================================================
// AUTOMATION RULE HISTORY — per-rule firing log + on-time intervals
// ============================================================
let _autoHistoryRule = null;

async function openAutomationHistory(rule) {
  if (!rule) return;
  _autoHistoryRule = rule;
  const card = $('auto-history');
  if (!card) return;
  card.hidden = false;
  $('auto-history-title').textContent = `History — ${rule.name}`;
  card.scrollIntoView({behavior: 'smooth', block: 'start'});
  await _refreshAutoHistory();
}

async function _refreshAutoHistory() {
  const rule = _autoHistoryRule;
  if (!rule) return;
  const days = parseInt($('auto-history-days')?.value || '30', 10) || 30;
  const summary = $('auto-history-summary');
  const empty = $('auto-history-empty');
  const body = $('auto-history-body');
  if (summary) summary.textContent = 'Loading…';
  if (empty) empty.hidden = true;
  if (body) body.innerHTML = '';
  try {
    const r = await fetch(
      `/api/automation/rules/${encodeURIComponent(rule.id)}/history?days=${days}`,
    );
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    _renderAutoHistory(j);
  } catch (e) {
    if (summary) summary.textContent = `Failed to load: ${e.message || e}`;
  }
}

function _renderAutoHistory(j) {
  const summary = $('auto-history-summary');
  const empty = $('auto-history-empty');
  const body = $('auto-history-body');
  const firings = j.firings || [];
  const intervals = j.intervals || [];
  if (!firings.length) {
    if (summary) summary.textContent = `No firings in the last ${j.days} days.`;
    if (empty) empty.hidden = false;
    if (body) body.innerHTML = '';
    return;
  }
  if (empty) empty.hidden = true;
  const totalH = (j.total_on_seconds || 0) / 3600;
  const openCount = intervals.filter((i) => i.open).length;
  const lines = [
    `${firings.length} firing${firings.length === 1 ? '' : 's'} in the last ${j.days} days`,
    `${intervals.length} ON interval${intervals.length === 1 ? '' : 's'} (paired across all rules on this plug)`,
    `total ON-time: ${totalH.toFixed(1)} h`,
  ];
  if (openCount) lines.push('plug currently ON (interval still open)');
  if (summary) summary.textContent = lines.join(' · ');

  const fmtTs = (ts) =>
    ts == null ? '—' : new Date(ts * 1000).toLocaleString();
  const fmtDur = (s) => {
    if (s == null) return '—';
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  };
  const safe = (s) => String(s ?? '').replace(/[<>&"]/g, (c) =>
    ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]));

  // ON intervals first (the "what actually happened on the plug" view).
  let html = '';
  if (intervals.length) {
    html += `<h3 style="margin:16px 0 6px;font-size:13px;color:var(--text-dim);text-transform:uppercase;letter-spacing:.04em">On intervals</h3>
      <table class="acc-table"><thead><tr>
        <th>Started</th><th>Ended</th><th>Duration</th><th>Opened by</th><th>Closed by</th>
      </tr></thead><tbody>` +
      intervals.slice().reverse().map((i) => `<tr>
        <td>${fmtTs(i.on_at)}</td>
        <td>${i.open ? '<em>still on</em>' : fmtTs(i.off_at)}</td>
        <td>${fmtDur(i.duration_s)}</td>
        <td>${safe(i.opened_by_rule_name || i.opened_by_rule_id || '—')}</td>
        <td>${safe(i.closed_by_rule_name || i.closed_by_rule_id || '—')}</td>
      </tr>`).join('') + '</tbody></table>';
  }
  // Raw firing log second (transparency / debugging).
  html += `<h3 style="margin:16px 0 6px;font-size:13px;color:var(--text-dim);text-transform:uppercase;letter-spacing:.04em">Firings</h3>
    <table class="acc-table"><thead><tr>
      <th>Time</th><th>Action</th><th>SOC</th><th>Threshold</th>
    </tr></thead><tbody>` +
    firings.map((f) => `<tr>
      <td>${fmtTs(f.fired_at)}</td>
      <td>${safe((f.action || '').toUpperCase())}</td>
      <td>${f.soc_at_fire == null ? '—' : Math.round(f.soc_at_fire) + '%'}</td>
      <td>${f.operator || ''} ${f.threshold == null ? '' : f.threshold + '%'}</td>
    </tr>`).join('') + '</tbody></table>';
  if (body) body.innerHTML = html;
}

$('auto-history-close')?.addEventListener('click', () => {
  const card = $('auto-history');
  if (card) card.hidden = true;
  _autoHistoryRule = null;
});

$('auto-history-days')?.addEventListener('change', () => {
  _refreshAutoHistory();
});

$('auto-add')?.addEventListener('click', () => openAutomationEditor(null));
$('auto-cancel')?.addEventListener('click', closeAutomationEditor);
$('auto-editor-close')?.addEventListener('click', closeAutomationEditor);

document.getElementById('auto-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const actionType = document.querySelector('input[name="auto-action-type"]:checked')?.value || 'kasa';
  const jackerySn = $('auto-jackery').value;
  let action = 'off';
  let host = '';
  let setting = null;

  if (actionType === 'jackery_setting') {
    action = document.querySelector('input[name="auto-setting-val"]:checked')?.value || 'on';
    setting = $('auto-setting-pick')?.value || 'battery_saving';
    if (!jackerySn) {
      alert('Pick which Jackery device to apply the setting to.');
      return;
    }
  } else {
    action = document.querySelector('input[name="auto-action"]:checked')?.value || 'off';
    host = $('auto-kasa-pick').value;
    if (!host) {
      alert('Pick a saved Kasa device first.');
      return;
    }
  }

  _syncEditorConditionsFromDom();
  if (!_editorConditions.length) {
    alert('Please add at least one condition.');
    return;
  }

  for (const c of _editorConditions) {
    if (c.type === 'battery_percent') {
      if (isNaN(c.value) || c.value < 0 || c.value > 100) {
        alert('Battery SOC must be between 0 and 100%.');
        return;
      }
    } else if (c.type === 'device_status') {
      if (!c.value || !['offline', 'online'].includes(String(c.value).toLowerCase())) {
        alert('Please choose whether device status is offline or online.');
        return;
      }
    } else if (c.type === 'time_of_day') {
      if (!c.value || !String(c.value).trim()) {
        alert('Please specify a valid time of day (e.g. 20:00).');
        return;
      }
    } else if (c.type === 'day_of_week') {
      if (!c.value || !String(c.value).trim()) {
        alert('Please select a valid day of week condition.');
        return;
      }
    } else if (c.type === 'day_of_month') {
      if (!c.value || !String(c.value).trim()) {
        alert('Please specify a valid day of month (e.g. 1 or 1, 15 or last).');
        return;
      }
    }
  }

  const hasBatt = _editorConditions.some((c) => c.type === 'battery_percent');
  const hasStatus = _editorConditions.some((c) => c.type === 'device_status');
  if ((hasBatt || hasStatus) && !jackerySn) {
    alert('Pick which Jackery device this rule should watch.');
    return;
  }

  // Look up the alias from the saved-devices cache so the rule list shows
  // the friendly name even if the device record changes later.
  const dev = _savedKasaDevices.find((d) => d.host === host);
  const jdev = ((lastStatus && lastStatus.cloud && lastStatus.cloud.devices) || [])
    .find((d) => d.device_sn === jackerySn);
  const body = {
    id: $('auto-id').value || undefined,
    name: $('auto-name').value.trim(),
    conditions: _editorConditions,
    action,
    action_type: actionType,
    setting,
    kasa_host: host,
    kasa_alias: dev?.alias || host,
    jackery_device_sn:   jackerySn || null,
    jackery_device_name: jdev?.name || jdev?.model_name || jackerySn || null,
    enabled: $('auto-enabled').checked,
  };
  const status = $('auto-status');
  status.hidden = false; status.textContent = 'Saving…';
  try {
    const r = await fetch('/api/automation/rules', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.detail || j.error || ('HTTP ' + r.status));
    status.textContent = 'Saved.';
    setTimeout(() => { status.hidden = true; }, 2000);
    closeAutomationEditor();
    loadAutomation();
  } catch (err) {
    status.textContent = 'Save failed: ' + (err.message || err);
  }
});

$('kasa-discover')?.addEventListener('click', async () => {
  const wrap = $('auto-discovered');
  const status = $('auto-status');
  status.hidden = false; status.textContent = 'Discovering…';
  wrap.hidden = false; wrap.innerHTML = 'Searching the LAN…';
  try {
    const r = await fetch('/api/kasa/devices');
    const j = await r.json();
    const devs = j.devices || [];
    if (!devs.length) {
      wrap.innerHTML = `<div>No Kasa devices found via discovery. UDP broadcast often doesn't reach Docker bridge networks. Enter the device IP manually below.</div>`;
    } else {
      wrap.innerHTML = devs.map((d) => `
        <div class="auto-disc-row">
          <span class="alias">${d.alias}</span>
          <span class="host">${d.host}</span>
          <span class="hint">${d.model || ''} · ${d.is_on ? 'on' : 'off'}</span>
          <button class="btn btn-ghost" data-add-host="${d.host}" data-add-alias="${d.alias}" type="button">Add</button>
        </div>`).join('');
      // "Add" saves the discovered device into the registry so it appears
      // in the rule editor's dropdown.
      wrap.querySelectorAll('[data-add-host]').forEach((b) => {
        b.addEventListener('click', async () => {
          b.disabled = true; b.textContent = 'Adding…';
          try {
            await fetch('/api/kasa/saved', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ host: b.dataset.addHost, alias: b.dataset.addAlias }),
            });
            loadSavedKasa();
          } catch (e) {
            alert('Failed: ' + (e.message || e));
          } finally {
            b.disabled = false; b.textContent = 'Add';
          }
        });
      });
    }
    status.hidden = true;
  } catch (e) {
    wrap.innerHTML = `<div>Discovery failed: ${escapeHtml(e.message || e)}</div>`;
    status.hidden = true;
  }
});

// ============================================================
// LOGS TAB
// ============================================================
let _logsTimer = null;

async function loadLogs() {
  const list = $('logs-list');
  if (!list) return;
  try {
    const r = await fetch('/api/events?limit=200');
    const j = await r.json();
    renderLogs(j.events || []);
  } catch (e) {
    list.innerHTML = `<div class="logs-empty">Failed to load: ${escapeHtml(e.message || e)}</div>`;
  }
  // Restart auto-refresh timer based on the checkbox state
  if (_logsTimer) { clearInterval(_logsTimer); _logsTimer = null; }
  if ($('logs-auto')?.checked && activeTab === 'logs') {
    _logsTimer = setInterval(() => {
      if (activeTab !== 'logs') { clearInterval(_logsTimer); _logsTimer = null; return; }
      loadLogs();
    }, 5000);
  }
}

function renderLogs(events) {
  const list = $('logs-list');
  const filterValue = $('logs-filter')?.value || 'all';
  // Filter: 'all', a level (error/warn/info), or a category (auth/poll/mqtt/session)
  const levelOrder = { error: 0, warn: 1, info: 2 };
  const filtered = events.filter((e) => {
    if (filterValue === 'all') return true;
    if (filterValue in levelOrder) {
      // "warn" means warn+error, "info" means everything
      return levelOrder[e.level] <= levelOrder[filterValue];
    }
    return e.category === filterValue;
  });
  if (!filtered.length) {
    list.innerHTML = '<div class="logs-empty">No events yet.</div>';
    return;
  }
  // Newest first.
  filtered.sort((a, b) => b.ts - a.ts);
  list.innerHTML = filtered.map((e) => {
    const ts = new Date(e.ts * 1000).toLocaleTimeString('en-GB', { hour12: false });
    const extras = e.extra ? ' · ' + Object.entries(e.extra).map(([k, v]) =>
      `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(' ') : '';
    const safe = (s) => String(s).replace(/[<>&]/g, (c) => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]));
    return `<div class="logs-row lvl-${e.level}">
      <span class="lr-ts">${ts}</span>
      <span class="lr-level">${e.level}</span>
      <span class="lr-cat">${safe(e.category)}</span>
      <span class="lr-msg">${safe(e.message)}${safe(extras)}</span>
    </div>`;
  }).join('');
}

$('logs-refresh')?.addEventListener('click', loadLogs);
$('logs-filter')?.addEventListener('change', () => {
  // Re-render with the same data — we kept the last result on the DOM but
  // it's cheaper to just re-fetch since the buffer is small.
  loadLogs();
});
$('logs-auto')?.addEventListener('change', loadLogs);

// ============================================================
// LOGS → DEBUG PANEL
// ============================================================
// Each button runs an ad-hoc query against the local data store,
// formats the result as a table, and writes it to #debug-output.
// Replaces the console.log / console.table workflow.

function _dbgRender(title, rows, columns) {
  const out = $('debug-output');
  if (!out) return;
  out.hidden = false;
  if (!rows || !rows.length) {
    out.innerHTML = `<div class="dbg-block"><h3>${escapeHtml(title)}</h3><p class="hint">No data.</p></div>` + out.innerHTML;
    return;
  }
  const cols = columns || Object.keys(rows[0]);
  const head = cols.map(c => `<th>${escapeHtml(c)}</th>`).join('');
  const body = rows.map(r => `<tr>${cols.map(c => `<td>${_dbgFmt(r[c])}</td>`).join('')}</tr>`).join('');
  const ts = new Date().toLocaleTimeString();
  out.innerHTML = `
    <div class="dbg-block">
      <h3>${escapeHtml(title)} <small class="hint">(${ts})</small></h3>
      <div class="dbg-table-wrap">
        <table class="dbg-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>
      </div>
    </div>` + out.innerHTML;
}

function _dbgFmt(v) {
  if (v == null) return '—';
  if (typeof v === 'number' && Number.isFinite(v)) {
    return Math.abs(v) < 1 && v !== 0 ? v.toFixed(3) : v.toString();
  }
  if (typeof v === 'object') return `<code>${escapeHtml(JSON.stringify(v).slice(0,80))}</code>`;
  return escapeHtml(String(v));
}

function _dbgSummary(title, lines) {
  const out = $('debug-output');
  if (!out) return;
  out.hidden = false;
  const ts = new Date().toLocaleTimeString();
  // Callers pass already-formatted strings (often containing intentional
  // <code> / <strong>), so don't escape `l` itself. Title comes from
  // the caller too but is always a literal here.
  const items = lines.map(l => `<div>${l}</div>`).join('');
  out.innerHTML = `
    <div class="dbg-block">
      <h3>${escapeHtml(title)} <small class="hint">(${ts})</small></h3>
      <div class="dbg-summary">${items}</div>
    </div>` + out.innerHTML;
}

async function _dbgFetch(url) {
  const status = $('debug-status');
  status.hidden = false;
  status.textContent = `Fetching ${url}…`;
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    status.hidden = true;
    return await r.json();
  } catch (e) {
    status.textContent = `Failed: ${e.message || e}`;
    return null;
  }
}

$('dbg-forecast-24h')?.addEventListener('click', async () => {
  const j = await _dbgFetch('/api/forecast/accuracy');
  if (!j) return;
  const cutoff = Date.now()/1000 - 24*3600;
  const recent = (j.samples || []).filter(s => s.target >= cutoff && s.actual_soc != null);
  if (!recent.length) {
    _dbgSummary('Forecast vs actual (last 24h)', ['No predictions with actuals in the last 24h.']);
    return;
  }
  const errs = recent.map(s => Math.abs(s.predicted_soc - s.actual_soc));
  const mae = errs.reduce((a,b)=>a+b,0) / errs.length;
  const max = Math.max(...errs);
  const overunder = recent.map(s => s.predicted_soc - s.actual_soc);
  const meanBias = overunder.reduce((a,b)=>a+b,0) / overunder.length;
  _dbgSummary(`Forecast vs actual (last 24h, ${recent.length} samples)`, [
    `<strong>MAE:</strong> ${mae.toFixed(1)}pp`,
    `<strong>Max error:</strong> ${max.toFixed(1)}pp`,
    `<strong>Bias:</strong> ${meanBias > 0 ? '+' : ''}${meanBias.toFixed(1)}pp ${meanBias > 0 ? '(over-predicting)' : '(under-predicting)'}`,
  ]);
  const rows = recent.map(s => ({
    target: new Date(s.target*1000).toLocaleString(),
    lead_h: s.lead_time_h,
    pred: Math.round(s.predicted_soc),
    actual: Math.round(s.actual_soc),
    err_pp: (s.predicted_soc - s.actual_soc).toFixed(1),
  })).sort((a,b) => a.target.localeCompare(b.target));
  _dbgRender('Predictions, sorted by target time', rows);
});

$('dbg-forecast-buckets')?.addEventListener('click', async () => {
  const j = await _dbgFetch('/api/forecast/accuracy');
  if (!j) return;
  const all = j.summary || {};
  const postFix = j.summary_post_fix || {};
  // Render both views side-by-side so it's obvious how much the
  // pre-fix stale rows are dragging the headline numbers down.
  // `summary_post_fix` only counts predictions made AT OR AFTER
  // the most recent forecaster breaking-change deploy.
  const cutoff = j.cutoff_ts
    ? new Date(j.cutoff_ts * 1000).toLocaleString()
    : '—';
  const buckets = ['≤6h', '≤24h', '≤72h', '>72h'];
  const rows = buckets.map(bucket => {
    const a = all[bucket] || { n: 0, mae: null, bias_pp: null };
    const p = postFix[bucket] || { n: 0, mae: null, bias_pp: null };
    return {
      lead_time: bucket,
      all_samples: a.n,
      all_mae_pp: a.mae,
      all_bias_pp: a.bias_pp,
      post_fix_samples: p.n,
      post_fix_mae_pp: p.mae,
      post_fix_bias_pp: p.bias_pp,
    };
  });
  _dbgSummary(
    `Forecast accuracy by lead time`,
    [
      `<strong>All-time samples:</strong> ${(j.samples||[]).length}`,
      `<strong>Post-fix cutoff:</strong> ${cutoff} (predictions made before this excluded from post-fix bucket)`,
    ],
  );
  _dbgRender('All vs post-fix', rows);
});

$('dbg-smart-charge')?.addEventListener('click', async () => {
  const j = await _dbgFetch('/api/smart_charge/analytics?days=14');
  if (!j) return;
  const s = j.summary || {};
  const lines = [
    `<strong>Window:</strong> ${j.days || 14} days`,
    `<strong>Decisions:</strong> ${s.n || 0}`,
    `<strong>Target hit rate:</strong> ${s.target_hit_rate != null ? Math.round(s.target_hit_rate * 100) + '%' : '—'}`,
    `<strong>Mean abs error:</strong> ${s.mae_pp != null ? s.mae_pp.toFixed(1) + 'pp' : '—'}`,
  ];
  _dbgSummary('Smart-charge analytics', lines);
  if (j.samples?.length) {
    _dbgRender('Recent decisions',
      j.samples.slice(0, 20).map(d => ({
        when: new Date((d.decided_at || 0) * 1000).toLocaleString(),
        action: d.action,
        mode: d.mode,
        pred_sunrise: d.predicted_sunrise_soc_pct != null ? Math.round(d.predicted_sunrise_soc_pct) : null,
        actual_sunrise: d.actual_sunrise_soc_pct != null ? Math.round(d.actual_sunrise_soc_pct) : null,
        target: d.target_sunrise_soc_pct,
        err_pp: d.prediction_error_pp != null ? d.prediction_error_pp.toFixed(1) : null,
      })));
  }
});

$('dbg-daily-summary')?.addEventListener('click', async () => {
  const j = await _dbgFetch('/api/daily_summary?days=7');
  if (!j || !j.rows?.length) {
    _dbgSummary('Daily summary', ['No rows yet.']);
    return;
  }
  const rows = j.rows.map(r => ({
    date: r.date,
    sunset_pred: r.predicted_sunset_soc_pct != null ? Math.round(r.predicted_sunset_soc_pct) : null,
    sunset_actual: r.actual_sunset_soc_pct != null ? Math.round(r.actual_sunset_soc_pct) : null,
    sunrise_pred: r.predicted_sunrise_soc_pct != null ? Math.round(r.predicted_sunrise_soc_pct) : null,
    sunrise_actual: r.actual_sunrise_soc_pct != null ? Math.round(r.actual_sunrise_soc_pct) : null,
  }));
  _dbgRender(`Daily sunset/sunrise predicted vs actual (${rows.length} days)`, rows);
});

$('dbg-battery-packs')?.addEventListener('click', async () => {
  const j = await _dbgFetch('/api/devices/battery_packs');
  if (!j) return;
  const rows = (j.packs || []).map(p => ({
    order: p.deviceOrder,
    sn_tail: String(p.deviceSn || '').slice(-7),
    soc: p.rb,
    input_w: p.ip,
    output_w: p.op,
    temp_c: p.it === 999 ? '—' : p.it,
    err: p.ec,
    needUpgrade: p.needUpgrade ?? '—',
  }));
  _dbgRender(
    `Battery packs (${rows.length}, fetched_at: ${new Date((j.fetched_at || 0) * 1000).toLocaleString()})`,
    rows,
  );
});

$('dbg-raw-props')?.addEventListener('click', async () => {
  const j = await _dbgFetch('/api/debug/raw_props');
  if (!j) return;
  const props = j.props || {};
  const rows = Object.keys(props).sort().map(k => ({ key: k, value: props[k] }));
  _dbgRender(`Raw cloud properties (${j.device_sn || ''})`, rows);
});

$('dbg-cloud-probe')?.addEventListener('click', async () => {
  const j = await _dbgFetch('/api/debug/cloud_probe');
  if (!j) return;
  const out = $('debug-output');
  out.hidden = false;
  const ts = new Date().toLocaleTimeString();
  out.innerHTML = `
    <div class="dbg-block">
      <h3>Cloud probe <small class="hint">(${ts})</small></h3>
      <pre class="dbg-pre">${escapeHtml(JSON.stringify(j.results || j, null, 2))}</pre>
    </div>` + out.innerHTML;
});

$('dbg-copy-all')?.addEventListener('click', async () => {
  const status = $('debug-status');
  status.hidden = false;
  status.textContent = 'Gathering all debug data…';
  // Run all queries in parallel — each surfaces an `error` field on
  // failure rather than rejecting, so a flaky endpoint doesn't kill
  // the whole bundle.
  const safe = (url) => fetch(url).then(r =>
    r.ok ? r.json() : { error: `HTTP ${r.status}`, url })
    .catch(e => ({ error: String(e), url }));
  const [
    forecastAccuracy,
    smartChargeAnalytics,
    dailySummary,
    batteryPacks,
    rawProps,
    cloudProbe,
    forecast,
    smartChargeStatus,
    smartChargeConfig,
    status_,
  ] = await Promise.all([
    safe('/api/forecast/accuracy'),
    safe('/api/smart_charge/analytics?days=14'),
    safe('/api/daily_summary?days=14'),
    safe('/api/devices/battery_packs'),
    safe('/api/debug/raw_props'),
    safe('/api/debug/cloud_probe'),
    safe('/api/forecast'),
    safe('/api/smart_charge/status'),
    safe('/api/smart_charge/config'),
    safe('/api/status'),
  ]);
  const bundle = {
    captured_at: new Date().toISOString(),
    active_device_sn: status_?.device?.device_sn || null,
    active_device_model: status_?.device?.model_code || null,
    active_device_name: status_?.device?.name || null,
    current_telemetry: status_?.telemetry || null,
    forecast_accuracy: forecastAccuracy,
    smart_charge_analytics: smartChargeAnalytics,
    smart_charge_status: smartChargeStatus,
    smart_charge_config: smartChargeConfig,
    daily_summary: dailySummary,
    battery_packs: batteryPacks,
    raw_cloud_props: rawProps,
    cloud_probe: cloudProbe,
    forecast: forecast,
  };
  const text = JSON.stringify(bundle, null, 2);
  try {
    await navigator.clipboard.writeText(text);
    status.textContent = `Copied ${(text.length / 1024).toFixed(1)} KB to clipboard.`;
    setTimeout(() => { status.hidden = true; }, 4000);
  } catch (e) {
    // Fallback: render in the panel so the user can manually copy.
    status.textContent = 'Clipboard blocked — bundle rendered below for manual copy.';
    const out = $('debug-output');
    out.hidden = false;
    out.innerHTML = `
      <div class="dbg-block">
        <h3>All debug data <small class="hint">(${new Date().toLocaleTimeString()})</small></h3>
        <pre class="dbg-pre" style="max-height:600px">${escapeHtml(text)}</pre>
      </div>` + out.innerHTML;
  }
});

$('dbg-clear')?.addEventListener('click', () => {
  const out = $('debug-output');
  out.innerHTML = '';
  out.hidden = true;
  $('debug-status').hidden = true;
});

// ============================================================
// SETTINGS TAB
// ============================================================
async function loadSettings() {
  const fields = $('settings-fields');
  const status = $('settings-status');
  if (!fields) return;
  status.hidden = true;
  fields.innerHTML = 'Loading…';
  try {
    const r = await fetch('/api/settings');
    const j = await r.json();
    renderSettingsFields(j.settings || []);
  } catch (e) {
    fields.innerHTML = `<div class="login-error">Failed to load: ${escapeHtml(e.message || e)}</div>`;
  }
}

function renderSettingsFields(specs) {
  const fields = $('settings-fields');
  fields.innerHTML = '';
  for (const s of specs) {
    const row = document.createElement('div');
    row.className = 'settings-row';
    const k = escapeHtml(s.key);
    row.innerHTML = `
      <label class="settings-label" for="set-${k}">
        <span class="settings-label-text">${escapeHtml(s.label)}</span>
        <span class="settings-hint">${escapeHtml(s.hint)}</span>
      </label>
      <div class="settings-control">
        <input id="set-${k}" name="${k}" type="number"
               min="${escapeHtml(s.min)}" max="${escapeHtml(s.max)}" step="1"
               value="${escapeHtml(s.value)}" required />
        <span class="settings-range">${escapeHtml(s.min)}–${escapeHtml(s.max)}</span>
      </div>
    `;
    fields.appendChild(row);
  }
  // Re-apply Anthropic-key gating now that fields exist (the advisor
  // hour input requires a saved key to be editable).
  applyAnthropicGates();
}

$('settings-reload')?.addEventListener('click', loadSettings);

document.getElementById('settings-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const status = $('settings-status');
  const inputs = document.querySelectorAll('#settings-fields input');
  const body = {};
  for (const inp of inputs) {
    body[inp.name] = parseInt(inp.value, 10);
  }
  status.hidden = false;
  status.textContent = 'Saving…';
  try {
    const r = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.detail || j.error || ('HTTP ' + r.status));
    }
    const j = await r.json();
    status.textContent = 'Saved.';
    // Re-render with the values the server actually accepted (clamped).
    if (j.settings) {
      const inputsByName = Object.fromEntries(
        [...inputs].map(i => [i.name, i])
      );
      for (const [k, v] of Object.entries(j.settings)) {
        if (inputsByName[k]) inputsByName[k].value = v;
      }
    }
    setTimeout(() => { status.hidden = true; }, 2500);
  } catch (err) {
    status.textContent = `Save failed: ${err.message || err}`;
  }
});

// ============================================================
// COST / SAVINGS SETTINGS
// ============================================================
let _costPresets = [];

async function loadCostPlan() {
  try {
    const r = await fetch('/api/cost/plan');
    if (!r.ok) return;
    const j = await r.json();
    _costPresets = j.presets || [];
    renderCostFields(j.plan);
    // Populate the collapsed-card chip so users can see what plan is
    // active without expanding the form. e.g. "TOU · 4 slots · USD" /
    // "Flat · $0.25/kWh" / "—".
    const chip = $('cost-status');
    if (chip) {
      const p = j.plan || {};
      const cur = p.currency || 'USD';
      if (p.type === 'flat') {
        const rate = p.rate_per_kwh != null
          ? `${cur === 'USD' ? '$' : ''}${Number(p.rate_per_kwh).toFixed(2)}/kWh`
          : '';
        chip.textContent = ['Flat', rate, cur === 'USD' ? null : cur]
          .filter(Boolean).join(' · ');
      } else if (p.type === 'tou') {
        const n = (p.tou_rates || p.slots || []).length;
        chip.textContent = ['TOU', `${n} slot${n === 1 ? '' : 's'}`, cur].filter(Boolean).join(' · ');
      } else {
        chip.textContent = '—';
      }
    }
  } catch (e) {
    console.warn('cost plan load failed', e);
  }
}

function renderCostFields(plan) {
  const sel = $('cost-preset');
  if (!sel) return;
  // Build the preset dropdown — every preset, plus "Custom flat rate" for
  // a single user-entered rate, plus "Custom TOU" if the saved plan is a
  // TOU schedule that doesn't match any preset (typical case after a
  // user edits a preset's rates).
  sel.innerHTML = '';
  for (const p of _costPresets) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.label;
    sel.appendChild(opt);
  }
  const flatOpt = document.createElement('option');
  flatOpt.value = '__custom_flat__';
  flatOpt.textContent = 'Custom flat rate';
  sel.appendChild(flatOpt);
  const customTouOpt = document.createElement('option');
  customTouOpt.value = '__custom_tou__';
  customTouOpt.textContent = 'Custom TOU';
  sel.appendChild(customTouOpt);

  const curInput = $('cost-currency');
  if (curInput) curInput.value = plan?.currency || 'USD';
  const calSelect = $('cost-holiday-calendar');
  if (calSelect) calSelect.value = plan?.holiday_calendar || '';
  const customHolsInput = $('cost-custom-holidays');
  if (customHolsInput) customHolsInput.value = (plan?.holidays || []).join(', ');

  // Match against presets first; fall through to "Custom TOU" or "Custom
  // flat rate" depending on the saved plan shape.
  const matchPreset = _costPresets.find((p) => deepEqualPlan(p.plan, plan));
  if (matchPreset) {
    sel.value = matchPreset.id;
  } else if (plan?.type === 'tou') {
    sel.value = '__custom_tou__';
  } else {
    sel.value = '__custom_flat__';
  }

  if (plan?.type === 'flat') {
    $('cost-flat-rate').value = plan.rate_per_kwh != null ? plan.rate_per_kwh : 0.30;
  }
  // applyCostSelection wires the visible rows to the dropdown choice. For
  // a custom TOU plan we want to render the SAVED plan's slots, not the
  // preset's, so handle that branch directly.
  if (sel.value === '__custom_tou__') {
    $('cost-flat-row').hidden = true;
    $('cost-tou-row').hidden = false;
    $('cost-holidays-row').hidden = false;
    $('cost-custom-holidays-row').hidden = false;
    renderTouEditor(JSON.parse(JSON.stringify(plan)));
  } else {
    applyCostSelection();
  }
}

function deepEqualPlan(a, b) {
  if (!a || !b || a.type !== b.type) return false;
  if ((a.currency || 'USD') !== (b.currency || 'USD')) return false;
  if (a.type === 'flat') return a.rate_per_kwh === b.rate_per_kwh;
  if (a.type === 'tou') {
    if ((a.holiday_calendar || '') !== (b.holiday_calendar || '')) return false;
    const ha = (a.holidays || []).join(',');
    const hb = (b.holidays || []).join(',');
    if (ha !== hb) return false;
    const sa = a.tou_rates || [];
    const sb = b.tou_rates || [];
    if (sa.length !== sb.length) return false;
    for (let i = 0; i < sa.length; i++) {
      if (sa[i].start_hour !== sb[i].start_hour) return false;
      if (sa[i].end_hour !== sb[i].end_hour) return false;
      if (Math.abs(sa[i].rate - sb[i].rate) > 1e-6) return false;
      const ma = (sa[i].months || []).join(',');
      const mb = (sb[i].months || []).join(',');
      if (ma !== mb) return false;
      const wa = (sa[i].weekdays || []).join(',');
      const wb = (sb[i].weekdays || []).join(',');
      if (wa !== wb) return false;
      if ((sa[i].holidays || '') !== (sb[i].holidays || '')) return false;
    }
    return true;
  }
  return false;
}

// Tracks the currently-rendered TOU plan so the save handler can recover
// the slot windows + labels.
let _costTouCurrent = null;

// Compact "Jun-Sep" / "Oct-May" / etc. label from a months list.
function _monthsToString(months) {
  if (!months || !months.length) return '';
  const NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const sorted = [...new Set(months)].sort((a, b) => a - b);
  let contiguous = true;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] !== sorted[i - 1] + 1) { contiguous = false; break; }
  }
  if (contiguous) return `${NAMES[sorted[0] - 1]}–${NAMES[sorted[sorted.length - 1] - 1]}`;
  const present = new Set(sorted);
  for (let start = 1; start <= 12; start++) {
    if (!present.has(start)) continue;
    if (present.has(start - 1 < 1 ? 12 : start - 1)) continue;
    let m = start, count = 0;
    while (present.has(m)) {
      count++;
      m = m === 12 ? 1 : m + 1;
      if (count > 12) break;
    }
    if (count === sorted.length) {
      const end = m === 1 ? 12 : m - 1;
      return `${NAMES[start - 1]}–${NAMES[end - 1]}`;
    }
  }
  return sorted.map(m => NAMES[m - 1]).join(',');
}

function _weekdaysToOption(weekdays) {
  if (!weekdays || !weekdays.length || weekdays.length === 7) return 'all';
  const sorted = [...new Set(weekdays)].sort((a, b) => a - b);
  if (sorted.length === 5 && sorted.every((v, i) => v === i + 1)) return 'weekdays';
  if (sorted.length === 2 && sorted[0] === 6 && sorted[1] === 7) return 'weekends';
  return 'custom';
}

function renderTouEditor(plan) {
  _costTouCurrent = plan;
  const wrap = $('cost-tou-slots');
  if (!wrap) return;
  wrap.innerHTML = '';
  for (const [i, slot] of (plan.tou_rates || []).entries()) {
    const row = document.createElement('div');
    row.className = 'cost-tou-slot';
    const start = String(slot.start_hour).padStart(2, '0');
    const end   = String(slot.end_hour).padStart(2, '0');
    const monthsStr = _monthsToString(slot.months);
    const timeText = monthsStr
      ? `${monthsStr} · ${start}:00–${end}:00`
      : `${start}:00–${end}:00`;

    const wdVal = _weekdaysToOption(slot.weekdays);
    const holVal = slot.holidays === 'exclude' ? 'exclude' : (slot.holidays === 'include' ? 'include' : (slot.holidays === 'only' ? 'only' : ''));

    row.innerHTML = `
      <span class="slot-time">${escapeHtml(timeText)}</span>
      <select class="slot-days" data-idx="${i}" title="Days of week">
        <option value="all"${wdVal === 'all' ? ' selected' : ''}>All days</option>
        <option value="weekdays"${wdVal === 'weekdays' ? ' selected' : ''}>Mon–Fri</option>
        <option value="weekends"${wdVal === 'weekends' ? ' selected' : ''}>Sat–Sun</option>
      </select>
      <select class="slot-holidays" data-idx="${i}" title="Holiday rule">
        <option value=""${holVal === '' ? ' selected' : ''}>Standard</option>
        <option value="exclude"${holVal === 'exclude' ? ' selected' : ''}>Excl. holidays</option>
        <option value="include"${holVal === 'include' ? ' selected' : ''}>+ Holidays</option>
        <option value="only"${holVal === 'only' ? ' selected' : ''}>Holidays only</option>
      </select>
      <span class="slot-rate-wrap">
        <input type="number" class="slot-rate" data-idx="${i}"
               step="0.00001" min="0" max="5"
               value="${slot.rate != null ? slot.rate : 0}" /> /kWh
      </span>
      <input type="text" class="slot-label-input" data-idx="${i}"
             placeholder="label (e.g. peak)" value="${escapeHtml(slot.label || '')}" />
      <button type="button" class="btn btn-ghost btn-tiny slot-del-btn" data-idx="${i}" title="Remove slot">✕</button>
    `;
    wrap.appendChild(row);
  }

  // Wire delete buttons
  wrap.querySelectorAll('.slot-del-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const idx = parseInt(e.currentTarget.getAttribute('data-idx'), 10);
      if (_costTouCurrent && _costTouCurrent.tou_rates && !isNaN(idx)) {
        _costTouCurrent.tou_rates.splice(idx, 1);
        _markAsCustomTou();
        renderTouEditor(_costTouCurrent);
      }
    });
  });

  // Wire change events to mark as custom when user edits values
  wrap.querySelectorAll('input, select').forEach(el => {
    el.addEventListener('change', () => {
      _markAsCustomTou();
    });
  });
}

function _markAsCustomTou() {
  const sel = $('cost-preset');
  if (sel && sel.value !== '__custom_tou__') {
    sel.value = '__custom_tou__';
  }
}

$('cost-add-slot')?.addEventListener('click', () => {
  if (!_costTouCurrent) {
    _costTouCurrent = {
      type: 'tou',
      currency: $('cost-currency')?.value.trim() || 'USD',
      tou_rates: [],
    };
  }
  if (!_costTouCurrent.tou_rates) _costTouCurrent.tou_rates = [];
  _costTouCurrent.tou_rates.push({
    start_hour: 0,
    end_hour: 24,
    rate: 0.15,
    label: 'new slot',
  });
  _markAsCustomTou();
  renderTouEditor(_costTouCurrent);
});

function applyCostSelection() {
  const sel = $('cost-preset');
  if (!sel) return;
  const id = sel.value;
  const flatRow = $('cost-flat-row');
  const touRow  = $('cost-tou-row');
  const holRow  = $('cost-holidays-row');
  const custHolRow = $('cost-custom-holidays-row');

  if (id === '__custom_flat__') {
    flatRow.hidden = false;
    touRow.hidden = true;
    if (holRow) holRow.hidden = true;
    if (custHolRow) custHolRow.hidden = true;
    _costTouCurrent = null;
    return;
  }
  if (id === '__custom_tou__') {
    flatRow.hidden = true;
    touRow.hidden = false;
    if (holRow) holRow.hidden = false;
    if (custHolRow) custHolRow.hidden = false;
    if (!_costTouCurrent) {
      _costTouCurrent = {
        type: 'tou',
        currency: $('cost-currency')?.value.trim() || 'USD',
        tou_rates: [
          { start_hour: 0, end_hour: 24, rate: 0.25, label: 'custom rate' },
        ],
      };
    }
    renderTouEditor(JSON.parse(JSON.stringify(_costTouCurrent)));
    return;
  }
  const preset = _costPresets.find((p) => p.id === id);
  if (!preset) return;
  if (preset.plan.type === 'flat') {
    flatRow.hidden = false;
    touRow.hidden = true;
    if (holRow) holRow.hidden = true;
    if (custHolRow) custHolRow.hidden = true;
    _costTouCurrent = null;
    $('cost-flat-rate').value = preset.plan.rate_per_kwh != null ? preset.plan.rate_per_kwh : 0.30;
    if ($('cost-currency')) $('cost-currency').value = preset.plan.currency || 'USD';
  } else if (preset.plan.type === 'tou') {
    flatRow.hidden = true;
    touRow.hidden = false;
    if (holRow) holRow.hidden = false;
    if (custHolRow) custHolRow.hidden = false;
    if ($('cost-currency')) $('cost-currency').value = preset.plan.currency || 'USD';
    if ($('cost-holiday-calendar')) $('cost-holiday-calendar').value = preset.plan.holiday_calendar || '';
    if ($('cost-custom-holidays')) $('cost-custom-holidays').value = (preset.plan.holidays || []).join(', ');
    // Deep-copy so the user editing rates doesn't mutate _costPresets.
    renderTouEditor(JSON.parse(JSON.stringify(preset.plan)));
  }
}

$('cost-preset')?.addEventListener('change', applyCostSelection);

document.getElementById('cost-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const status = $('cost-status');
  const sel = $('cost-preset');
  const id = sel.value;
  const currency = $('cost-currency')?.value.trim().toUpperCase() || 'USD';
  let plan;
  if (id === '__custom_flat__') {
    plan = {
      type: 'flat',
      rate_per_kwh: parseFloat($('cost-flat-rate').value) || 0,
      currency: currency,
    };
  } else if (_costTouCurrent) {
    const slotRows = document.querySelectorAll('#cost-tou-slots .cost-tou-slot');
    const touRates = [];
    slotRows.forEach((row, i) => {
      const slot = (_costTouCurrent.tou_rates || [])[i] || {};
      const rateInp = row.querySelector('.slot-rate');
      const labelInp = row.querySelector('.slot-label-input');
      const daysSel = row.querySelector('.slot-days');
      const holSel = row.querySelector('.slot-holidays');

      const editedRate = rateInp ? parseFloat(rateInp.value) : slot.rate;
      const editedLabel = labelInp ? labelInp.value.trim() : (slot.label || '');
      const daysVal = daysSel ? daysSel.value : 'all';
      const holVal = holSel ? holSel.value : '';

      const out = {
        start_hour: slot.start_hour != null ? slot.start_hour : 0,
        end_hour: slot.end_hour != null ? slot.end_hour : 24,
        rate: Number.isFinite(editedRate) ? editedRate : (slot.rate || 0),
        label: editedLabel,
      };
      if (slot.months && slot.months.length) {
        out.months = [...slot.months];
      }
      if (daysVal === 'weekdays') {
        out.weekdays = [1, 2, 3, 4, 5];
      } else if (daysVal === 'weekends') {
        out.weekdays = [6, 7];
      } else if (daysVal === 'custom' && slot.weekdays) {
        out.weekdays = [...slot.weekdays];
      }
      if (holVal === 'exclude') {
        out.holidays = 'exclude';
      } else if (holVal === 'include') {
        out.holidays = 'include';
      } else if (holVal === 'only') {
        out.holidays = 'only';
      }
      touRates.push(out);
    });

    plan = {
      type: 'tou',
      currency: currency,
      tou_rates: touRates,
    };

    const cal = $('cost-holiday-calendar')?.value.trim();
    if (cal) plan.holiday_calendar = cal;

    const customHolsRaw = $('cost-custom-holidays')?.value || '';
    const customHols = customHolsRaw.split(',').map(s => s.trim()).filter(Boolean);
    if (customHols.length) plan.holidays = customHols;
  } else {
    const preset = _costPresets.find((p) => p.id === id);
    if (!preset) return;
    plan = preset.plan;
  }
  status.hidden = false;
  status.textContent = 'Saving…';
  try {
    const r = await fetch('/api/cost/plan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(plan),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.detail || ('HTTP ' + r.status));
    }
    const j = await r.json();
    if (j.plan) renderCostFields(j.plan);  // re-anchor on the saved plan
    status.textContent = 'Saved.';
    setTimeout(() => { status.hidden = true; }, 2500);
  } catch (err) {
    status.textContent = `Save failed: ${err.message || err}`;
  }
});

// ============================================================
// SMART CHARGE
// ============================================================
// Load config + Kasa device list + recent decisions into the form.
// Called on Settings tab activation; re-runs are cheap.
async function loadSmartCharge() {
  // Render only when the form actually exists in the DOM (Automation tab).
  if (!$('sc-form')) return;
  const dev = activeJackeryDevice();
  const deviceSn = dev?.device_sn || '';
  const lbl = $('sc-device-label');
  if (lbl) lbl.textContent = dev?.name ? `· ${dev.name}` : '';
  if (!deviceSn) {
    // Without a selected device we can't load per-device config.
    const status = $('sc-status');
    if (status) {
      status.hidden = false;
      status.textContent = 'No active device — pick one to configure smart charge.';
    }
    return;
  }
  try {
    const q = `?device_sn=${encodeURIComponent(deviceSn)}`;
    const kasaQ = `?jackery_sn=${encodeURIComponent(deviceSn)}`;
    const [cfgRes, kasaRes, statusRes, anaRes] = await Promise.all([
      fetch(`/api/smart_charge/config${q}`),
      // Only show Kasa plugs assigned to THIS Jackery (or legacy unassigned).
      fetch(`/api/kasa/saved${kasaQ}`),
      fetch(`/api/smart_charge/status${q}`),
      fetch(`/api/smart_charge/analytics?days=14&device_sn=${encodeURIComponent(deviceSn)}`),
    ]);
    const cfgPayload = cfgRes.ok ? await cfgRes.json() : {};
    const cfg = cfgPayload.config || {};
    const conflicts = cfgPayload.conflicting_rules || [];
    const kasa = kasaRes.ok ? await kasaRes.json() : { devices: [] };
    const status = statusRes.ok ? await statusRes.json() : {};
    const ana = anaRes.ok ? await anaRes.json() : { summary: {} };

    // Populate Kasa picker. Show alias + last 4 of host so dupes don't
    // collide. Preserve current selection if the host still exists.
    const sel = $('sc-kasa-host');
    const currentHost = cfg.kasa_device_host || '';
    sel.innerHTML = '<option value="">— none —</option>';
    for (const d of (kasa.devices || [])) {
      const opt = document.createElement('option');
      opt.value = d.host;
      const label = d.alias || d.host;
      const tail = d.host ? ` (${d.host.slice(-7)})` : '';
      opt.textContent = `${label}${tail}`;
      if (d.host === currentHost) opt.selected = true;
      sel.appendChild(opt);
    }
    if (currentHost && !Array.from(sel.options).some(o => o.value === currentHost)) {
      // Saved host no longer in registry — show it anyway so the user
      // doesn't silently lose the binding.
      const opt = document.createElement('option');
      opt.value = currentHost;
      opt.textContent = `${currentHost} (not in registry)`;
      opt.selected = true;
      sel.appendChild(opt);
    }

    // Hydrate the form fields. Defaults match smart_charge.DEFAULT_CONFIG.
    $('sc-mode').value = cfg.mode || 'off';
    $('sc-target-soc').value = cfg.target_sunrise_soc_pct ?? 25;
    // Prefer a saved value; if unsaved AND the server has observed a
    // charging rate from this device's own samples, prefill that
    // instead of the population fallback.
    const observedW = status?.observed_max_charge_w ?? null;
    const observedN = status?.observed_max_charge_n ?? 0;
    const inp = $('sc-max-charge-w');
    if (cfg.max_charge_w != null) {
      inp.value = cfg.max_charge_w;
    } else if (observedW) {
      inp.value = observedW;
    } else {
      inp.value = 800;  // matches DEFAULT_CONFIG.max_charge_w
    }
    // Render the hint dynamically — show what THIS device actually
    // pulled if we've seen enough charging samples; otherwise a
    // generic "we'll learn this once you charge" message.
    const hint = $('sc-max-charge-hint');
    if (hint) {
      if (observedW && observedN >= 6) {
        hint.innerHTML =
          `Observed AC charging rate for this device: <strong>~${observedW} W</strong> ` +
          `(95th percentile across ${observedN} samples ≥ 100W). ` +
          `Set this to whatever your unit actually pulls — the prefill is what the dashboard observed, ` +
          `not the marketing max.`;
      } else {
        hint.innerHTML =
          `AC charging rate this device pulls from the wall while the smart-charge plug is on. ` +
          `The dashboard learns this from observed charging events on this device ` +
          `(${observedN}/6 samples so far) — the hint will update once we've seen a few minutes of charging.`;
      }
    }
    $('sc-max-on-min').value = cfg.max_on_duration_minutes ?? 480;
    $('sc-claude-toggle').checked = !!cfg.claude_enabled;

    // Refresh the API-key gate every time the panel loads — the user
    // may have just saved or cleared the key on Settings.
    try {
      const r = await fetch('/api/anthropic/key');
      _anthropicHasKey = r.ok ? !!(await r.json()).has_key : false;
    } catch { _anthropicHasKey = false; }
    applyClaudeToggleGate();

    renderSmartChargeHistory(status.history || []);
    renderSmartChargeAnalytics(ana);
    renderSmartChargeConflicts(conflicts, cfg.mode);
  } catch (e) {
    console.warn('smart_charge load failed', e);
  }
}

// Battery-rule conflict banner. Shown when smart-charge mode is
// "active" AND there are enabled rules controlling the same plug —
// those rules can fire on battery thresholds and undo what the
// controller just did. Hidden in any other state. The "Disable them"
// button hits POST /api/automation/rules/disable to flip enabled=false
// on every conflicting rule in one round-trip; "Ignore" hides the
// banner for this session (no persistence — it'll come back on next
// load if conflicts still exist).
function renderSmartChargeConflicts(conflicts, mode) {
  const banner = $('sc-conflict-banner');
  if (!banner) return;
  const list = conflicts || [];
  const shouldShow = mode === 'active' && list.length > 0;
  if (!shouldShow) {
    banner.hidden = true;
    return;
  }
  const text = $('sc-conflict-text');
  const ul = $('sc-conflict-list');
  if (text) {
    text.textContent = list.length === 1
      ? '1 enabled battery rule controls the same Kasa plug as smart-charge. '
        + 'It will fire on SOC thresholds and can undo charging decisions.'
      : `${list.length} enabled battery rules control the same Kasa plug as smart-charge. `
        + 'They will fire on SOC thresholds and can undo charging decisions.';
  }
  if (ul) {
    ul.innerHTML = list.map((r) => {
      const op = r.operator || '?';
      const val = r.value ?? '?';
      const action = (r.action || '').toUpperCase();
      const name = r.name || 'Unnamed rule';
      return `<li><strong>${escapeHtml(name)}</strong>: SOC ${escapeHtml(op)} ${escapeHtml(String(val))}% → ${escapeHtml(action)}</li>`;
    }).join('');
  }
  // Stash IDs on the button so the click handler doesn't re-fetch.
  const btn = $('sc-conflict-disable');
  if (btn) btn.dataset.ruleIds = JSON.stringify(list.map(r => r.id));
  banner.hidden = false;
}

document.getElementById('sc-conflict-disable')?.addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  let ids = [];
  try { ids = JSON.parse(btn.dataset.ruleIds || '[]'); } catch { ids = []; }
  if (!ids.length) return;
  btn.disabled = true;
  btn.textContent = 'Disabling…';
  try {
    const r = await fetch('/api/automation/rules/disable', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rule_ids: ids }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    // Reload the smart-charge panel so the banner clears + rule list
    // reflects the new disabled state.
    await loadSmartCharge();
  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'Disable them';
    const status = $('sc-status');
    if (status) {
      status.hidden = false;
      status.textContent = `Disable failed: ${err.message || err}`;
    }
  }
});

document.getElementById('sc-conflict-dismiss')?.addEventListener('click', () => {
  const banner = $('sc-conflict-banner');
  if (banner) banner.hidden = true;
});

function renderSmartChargeAnalytics(j) {
  const el = $('sc-analytics');
  if (!el) return;
  const s = j?.summary || {};
  if (!s.n) {
    el.hidden = true;
    return;
  }
  const hitRate = s.target_hit_rate != null
    ? `${Math.round(s.target_hit_rate * 100)}%` : '—';
  const mae = s.mae_pp != null ? `${s.mae_pp.toFixed(1)} pp` : '—';
  el.innerHTML = `
    <div class="sc-ana-grid">
      <div><span class="sc-lbl">Samples (${j.days || 14}d)</span><span>${s.n}</span></div>
      <div><span class="sc-lbl">Target hit rate</span><span>${hitRate}</span></div>
      <div><span class="sc-lbl">Mean abs error</span><span>${mae}</span></div>
    </div>`;
  el.hidden = false;
}

// Compact decision timestamp. The full toLocaleString form
// ("4/30/2026, 11:54:27 AM") wraps awkwardly in the 140px column and
// the year/seconds add no value when scanning a list. Show:
//   - Same day:  "11:54 AM"
//   - Yesterday: "Yesterday 11:54 AM"
//   - Earlier:   "Apr 30, 11:54 AM"  (year only when different year)
function _formatDecisionTime(epochS) {
  const d = new Date((epochS || 0) * 1000);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  const isYesterday = d.toDateString() === yesterday.toDateString();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (sameDay) return time;
  if (isYesterday) return `Yesterday ${time}`;
  const sameYear = d.getFullYear() === now.getFullYear();
  const date = d.toLocaleDateString([], sameYear
    ? { month: 'short', day: 'numeric' }
    : { month: 'short', day: 'numeric', year: 'numeric' });
  return `${date}, ${time}`;
}

function renderSmartChargeHistory(rows) {
  const block = $('sc-history-block');
  const list = $('sc-history');
  if (!block || !list) return;
  if (!rows.length) {
    block.hidden = true;
    return;
  }
  block.hidden = false;
  // Cap at 50 rows in the DOM — older ones live in the DB and the
  // analytics block above the list summarizes them. Collapsed by
  // default: shows only the latest decision; a "Show N more" toggle
  // reveals the rest. Details buttons inside hidden rows are wired
  // at render time and remain functional once revealed.
  const safe = (s) => String(s || '').replace(/[<>&"]/g, (c) =>
    ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]));
  const renderRow = (r) => {
    const when = _formatDecisionTime(r.decided_at);
    const fullWhen = new Date((r.decided_at || 0) * 1000).toLocaleString();
    const pred = r.predicted_sunrise_soc_pct != null
      ? `${Math.round(r.predicted_sunrise_soc_pct)}%` : '—';
    const actual = r.actual_sunrise_soc_pct != null
      ? `${Math.round(r.actual_sunrise_soc_pct)}%` : '—';
    const target = r.target_sunrise_soc_pct != null
      ? `${Math.round(r.target_sunrise_soc_pct)}%` : '—';
    const actionCls = r.action === 'on' ? 'sc-act-on'
                    : r.action === 'off' ? 'sc-act-off'
                    : 'sc-act-skip';
    const narrationLine = r.narration
      ? `<div class="sc-narration">💬 ${safe(r.narration)}</div>`
      : '';
    return `
      <div class="sc-row">
        <span class="sc-when" title="${fullWhen}">${when}</span>
        <span class="sc-action ${actionCls}">${(r.action || '?').toUpperCase()}</span>
        <span class="sc-mode">[${r.mode || '?'}]</span>
        <span class="sc-pred">predicted ${pred} → actual ${actual} (target ${target})</span>
        <span class="sc-reason" title="${safe(r.reason || '')}">${safe(r.reason || '')}</span>
        <button class="btn btn-ghost btn-small sc-detail-btn"
                data-decided-at="${r.decided_at}" type="button">Details ▾</button>
      </div>${narrationLine}
      <div class="sc-detail-panel" data-detail-for="${r.decided_at}" hidden></div>`;
  };
  renderCollapsedHistory(list, rows.slice(0, 50), renderRow);
  // Wire the Details toggles. Each click hits the decision_details
  // endpoint and renders into the matching panel. The querySelectorAll
  // also finds buttons inside the hidden .history-rest container, so
  // they work as soon as the user expands the list.
  list.querySelectorAll('[data-decided-at]').forEach((btn) => {
    btn.addEventListener('click', () => toggleDecisionDetails(btn));
  });
}

async function toggleDecisionDetails(btn) {
  const decidedAt = btn.dataset.decidedAt;
  const panel = document.querySelector(`.sc-detail-panel[data-detail-for="${decidedAt}"]`);
  if (!panel) return;
  if (!panel.hidden) {
    panel.hidden = true;
    btn.textContent = 'Details ▾';
    return;
  }
  btn.textContent = 'Details ▴';
  panel.hidden = false;
  panel.innerHTML = '<div class="hint" style="padding:8px 12px">Loading…</div>';
  try {
    const dev = activeJackeryDevice();
    const params = `?decided_at=${encodeURIComponent(decidedAt)}` +
      (dev?.device_sn ? `&device_sn=${encodeURIComponent(dev.device_sn)}` : '');
    const r = await fetch(`/api/smart_charge/decision_details${params}`);
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.detail || `HTTP ${r.status}`);
    }
    const j = await r.json();
    panel.innerHTML = renderDecisionDetailsHtml(j);
    panel.querySelector('[data-action="copy-detail"]')?.addEventListener('click', () => {
      copyDecisionDetails(j);
    });
  } catch (e) {
    panel.innerHTML = `<div class="hint" style="padding:8px 12px; color:#ef4444">Failed: ${escapeHtml(e.message || e)}</div>`;
  }
}

function renderDecisionDetailsHtml(j) {
  const safe = (s) => String(s == null ? '' : s).replace(/[<>&"]/g, (c) =>
    ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]));
  const fmtTs = (ts) => ts ? new Date(ts * 1000).toLocaleString() : '—';
  const fmtTime = (ts) => ts ? new Date(ts * 1000).toLocaleTimeString() : '—';
  const d = j.decision || {};
  const fields = [
    ['decided_at', fmtTs(d.decided_at)],
    ['mode', d.mode],
    ['action', d.action],
    ['executed', d.executed ? 'yes' : 'no'],
    ['reason', d.reason],
    ['current_soc_pct', d.current_soc_pct != null ? `${d.current_soc_pct}%` : '—'],
    ['predicted_sunrise_soc_pct', d.predicted_sunrise_soc_pct != null ? `${d.predicted_sunrise_soc_pct}%` : '—'],
    ['actual_sunrise_soc_pct', d.actual_sunrise_soc_pct != null ? `${d.actual_sunrise_soc_pct}%` : '—'],
    ['target_sunrise_soc_pct', d.target_sunrise_soc_pct != null ? `${d.target_sunrise_soc_pct}%` : '—'],
    ['deficit_kwh', d.deficit_kwh != null ? `${d.deficit_kwh.toFixed(2)} kWh` : '—'],
    ['charge_window', d.window_start && d.window_end ? `${fmtTime(d.window_start)} → ${fmtTime(d.window_end)}` : '—'],
    ['sunrise_ts', fmtTs(d.sunrise_ts)],
    ['cheapest_rate', d.cheapest_rate != null ? `$${d.cheapest_rate.toFixed(3)}/kWh` : '—'],
  ];
  const fieldsHtml = fields.map(([k, v]) => `
    <div class="dd-field"><span class="dd-key">${safe(k)}</span><span class="dd-val">${safe(v)}</span></div>`).join('');

  const params = (j.resolved_params || []).map(p => `
    <div class="dd-field"><span class="dd-key">${safe(p.label || p.key)}</span>
      <span class="dd-val">${p.value == null ? '—' : (
        p.unit === 'ratio' ? Number(p.value).toFixed(3) : `${Math.round(Number(p.value))} ${safe(p.unit)}`
      )} <small class="hint">[${safe(p.source)}${p.n_samples ? `, n=${p.n_samples}` : ''}]</small></span></div>`).join('');

  const fcRows = (j.forecast_trace || []).map(f => `
    <tr><td>${fmtTime(f.target)}</td><td>${Math.round(f.predicted_soc)}%</td></tr>`).join('');
  const fcMadeAt = j.forecast_made_at
    ? ` <small class="hint">(snapshot taken ${fmtTs(j.forecast_made_at)})</small>` : '';
  const fcTable = fcRows
    ? `<table class="dd-table"><thead><tr><th>target</th><th>predicted SOC</th></tr></thead><tbody>${fcRows}</tbody></table>${fcMadeAt}`
    : '<div class="hint">No forecast trace stored at this decision time.</div>';

  const wRows = (j.weather || []).map(w => `
    <tr><td>${fmtTime(w.ts)}</td><td>${w.ghi_w_m2 || 0}</td><td>${w.cloud_cover_pct || 0}%</td></tr>`).join('');
  const wTable = wRows
    ? `<table class="dd-table"><thead><tr><th>hour</th><th>GHI W/m²</th><th>cloud</th></tr></thead><tbody>${wRows}</tbody></table>`
    : '<div class="hint">No weather observations in window.</div>';

  const sRows = (j.samples_trace || []).map(s => `
    <tr><td>${fmtTime(s.ts)}</td><td>${s.soc != null ? `${s.soc}%` : '—'}</td>
        <td>${s.input_w || 0}W</td><td>${s.output_w || 0}W</td><td>${s.solar_w || 0}W</td></tr>`).join('');
  const sTable = sRows
    ? `<table class="dd-table"><thead><tr><th>hour</th><th>SOC</th><th>in</th><th>out</th><th>solar</th></tr></thead><tbody>${sRows}</tbody></table>`
    : '<div class="hint">No samples after this decision yet.</div>';

  return `
    <div class="dd-wrap">
      <div class="dd-actions">
        <button class="btn btn-primary btn-small" data-action="copy-detail" type="button">Copy all (paste-ready)</button>
      </div>
      <div class="dd-section"><h4>Decision row</h4><div class="dd-grid">${fieldsHtml}</div></div>
      <div class="dd-section"><h4>Resolved device parameters (current)</h4><div class="dd-grid">${params || '<div class="hint">none</div>'}</div></div>
      <div class="dd-section"><h4>Forecast trace at decision time</h4>${fcTable}</div>
      <div class="dd-section"><h4>Weather inputs (next 24h)</h4>${wTable}</div>
      <div class="dd-section"><h4>Actual SOC trajectory after decision</h4>${sTable}</div>
    </div>`;
}

async function copyDecisionDetails(j) {
  // Build a paste-ready plain-text dump. Same shape as the AI insights
  // Copy-all button so the chat assistant has a consistent format to
  // parse.
  const fmtTs = (ts) => ts ? new Date(ts * 1000).toISOString() : '—';
  const lines = [];
  const d = j.decision || {};
  lines.push(`# Smart-charge decision details — exported ${new Date().toISOString()}`);
  lines.push(`# device_sn=${j.device_sn || '?'}`);
  lines.push('');
  lines.push('## Decision row');
  for (const [k, v] of Object.entries(d)) {
    let val = v;
    if (typeof val === 'number' && k.endsWith('_at') || k === 'sunrise_ts'
        || k === 'window_start' || k === 'window_end') {
      val = `${v} (${fmtTs(v)})`;
    }
    lines.push(`- ${k}: ${val ?? '—'}`);
  }
  lines.push('');
  lines.push('## Resolved device parameters (current values)');
  for (const p of (j.resolved_params || [])) {
    lines.push(`- ${p.key}: ${p.value} ${p.unit || ''} [source=${p.source}${p.n_samples ? `, n=${p.n_samples}` : ''}]`);
  }
  lines.push('');
  lines.push(`## Forecast trace${j.forecast_made_at ? ` (snapshot taken ${fmtTs(j.forecast_made_at)})` : ''}`);
  for (const f of (j.forecast_trace || [])) {
    lines.push(`- ${fmtTs(f.target)}  predicted_soc=${f.predicted_soc}`);
  }
  if (!(j.forecast_trace || []).length) lines.push('  (none)');
  lines.push('');
  lines.push('## Weather inputs');
  for (const w of (j.weather || [])) {
    lines.push(`- ${fmtTs(w.ts)}  ghi=${w.ghi_w_m2 || 0} W/m²  cloud=${w.cloud_cover_pct || 0}%`);
  }
  if (!(j.weather || []).length) lines.push('  (none)');
  lines.push('');
  lines.push('## Actual SOC trajectory after decision');
  for (const s of (j.samples_trace || [])) {
    lines.push(`- ${fmtTs(s.ts)}  SOC=${s.soc ?? '—'}%  in=${s.input_w || 0}W  out=${s.output_w || 0}W  solar=${s.solar_w || 0}W`);
  }
  if (!(j.samples_trace || []).length) lines.push('  (none)');
  const text = lines.join('\n');
  try {
    await navigator.clipboard.writeText(text);
    const status = $('alg-status') || $('sc-status');
    if (status) {
      status.hidden = false;
      status.textContent = `Copied ${text.length} chars to clipboard.`;
      setTimeout(() => { status.hidden = true; }, 2500);
    }
  } catch {
    // Fallback: textarea overlay.
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;top:8vh;left:5vw;width:90vw;height:70vh;z-index:9999;font-family:monospace;font-size:12px';
    document.body.appendChild(ta);
    ta.select();
    setTimeout(() => {
      const dismiss = (ev) => {
        if (ev.target === ta) return;
        ta.remove();
        document.removeEventListener('click', dismiss, true);
      };
      document.addEventListener('click', dismiss, true);
    }, 50);
  }
}

function renderSmartChargePlan(plan, narration) {
  const el = $('sc-current-plan');
  if (!el) return;
  if (!plan) { el.hidden = true; return; }
  const fmtHour = (ts) => new Date(ts * 1000).toLocaleTimeString([], {
    hour: '2-digit', minute: '2-digit',
  });
  // Discontinuous schedule: render the planned hours grouped into
  // contiguous segments so a 4-hour split (e.g. 18-21 + 04-05) shows
  // as two distinct ON blocks. Falls back to legacy window_start/end
  // on older decision rows that don't carry planned_hours.
  let scheduleStr = '—';
  if (Array.isArray(plan.planned_hours) && plan.planned_hours.length) {
    const hrs = [...plan.planned_hours].sort((a, b) => a - b);
    const segments = [];
    let segStart = hrs[0];
    let segEnd = hrs[0] + 3600;
    for (let i = 1; i < hrs.length; i++) {
      if (hrs[i] === segEnd) {
        segEnd = hrs[i] + 3600;
      } else {
        segments.push([segStart, segEnd]);
        segStart = hrs[i];
        segEnd = hrs[i] + 3600;
      }
    }
    segments.push([segStart, segEnd]);
    scheduleStr = segments
      .map(([s, e]) => `${fmtHour(s)}–${fmtHour(e)}`)
      .join(', ');
  } else if (plan.window_start && plan.window_end) {
    scheduleStr = `${fmtHour(plan.window_start)}–${fmtHour(plan.window_end)}`;
  }
  const sunrise = plan.sunrise_ts ? fmtHour(plan.sunrise_ts) : '—';
  const rate = plan.cheapest_rate != null
    ? `$${plan.cheapest_rate.toFixed(3)}/kWh` : '—';
  const actionCls = plan.action === 'on' ? 'sc-act-on'
                  : plan.action === 'off' ? 'sc-act-off'
                  : 'sc-act-skip';
  const safe = (s) => String(s || '').replace(/[<>&"]/g, (c) =>
    ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]));
  const narrationLine = narration
    ? `<div class="sc-narration" style="margin-top:10px; padding-left:0">💬 ${safe(narration)}</div>`
    : '';
  // The forecast itself is now the truth (no floor), so
  // predicted_sunrise_soc_pct and baseline_predicted_sunrise_soc_pct
  // hold the same value and the counterfactual row would be redundant.
  // The "controller is doing real work" signal is now the deficit +
  // charge schedule rows below — when deficit > 0 and a window is
  // scheduled, smart-charge is actively bridging the gap.
  const baselineLine = '';
  const extensionBadge = plan.extension_active
    ? '<span class="sc-mode" title="Past planned window, holding ON until target hit">EXTENSION</span>'
    : '';
  el.innerHTML = `
    <div class="sc-plan-header">
      <span class="sc-action ${actionCls}">${(plan.action || '?').toUpperCase()}</span>
      <span class="sc-mode">[${plan.mode || '?'}]</span>${extensionBadge}
      <span class="sc-reason">${plan.reason || ''}</span>
    </div>
    <div class="sc-plan-grid">
      <div><span class="sc-lbl">Current SOC</span><span>${plan.current_soc_pct != null ? Math.round(plan.current_soc_pct) + '%' : '—'}</span></div>
      <div><span class="sc-lbl">Predicted at sunrise</span><span>${plan.predicted_sunrise_soc_pct != null ? Math.round(plan.predicted_sunrise_soc_pct) + '%' : '—'}</span></div>
      ${baselineLine}
      <div><span class="sc-lbl">Target</span><span>${Math.round(plan.target_sunrise_soc_pct)}%</span></div>
      <div><span class="sc-lbl">Deficit</span><span>${plan.deficit_kwh != null ? plan.deficit_kwh.toFixed(2) + ' kWh' : '—'}</span></div>
      <div><span class="sc-lbl">Charge schedule</span><span>${scheduleStr}</span></div>
      <div><span class="sc-lbl">Sunrise</span><span>${sunrise}</span></div>
      <div><span class="sc-lbl">Cheapest rate</span><span>${rate}</span></div>
    </div>${narrationLine}`;
  el.hidden = false;
}

// ============================================================
// Solar charge UI — inverse controller (Jackery → downstream load)
// ============================================================
async function loadSolarCharge() {
  if (!document.getElementById('solar-form')) return;
  const dev = activeJackeryDevice();
  const deviceSn = dev?.device_sn || '';
  const lbl = document.getElementById('solar-device-label');
  if (lbl) lbl.textContent = dev?.name ? `· ${dev.name}` : '';
  const statusEl = document.getElementById('solar-status');
  if (!deviceSn) {
    if (statusEl) { statusEl.hidden = false; statusEl.textContent = 'No active device — pick one to configure excess diversion.'; }
    return;
  }
  // Clear any stale "no device" message from a prior load that ran
  // before lastStatus was populated. Successful loads should always
  // reset the banner so it doesn't linger.
  if (statusEl) { statusEl.hidden = true; statusEl.textContent = ''; }
  try {
    const q = `?device_sn=${encodeURIComponent(deviceSn)}`;
    const kasaQ = `?jackery_sn=${encodeURIComponent(deviceSn)}`;
    const [cfgRes, kasaRes, statusRes, histRes] = await Promise.all([
      fetch(`/api/solar_charge/config${q}`),
      fetch(`/api/kasa/saved${kasaQ}`),
      fetch(`/api/solar_charge/status${q}`),
      fetch(`/api/solar_charge/history${q}&hours=24&limit=50`),
    ]);
    const cfgPayload = cfgRes.ok ? await cfgRes.json() : {};
    const cfg = cfgPayload.config || {};
    const kasa = kasaRes.ok ? await kasaRes.json() : { devices: [] };
    const status = statusRes.ok ? await statusRes.json() : {};
    const hist = histRes.ok ? await histRes.json() : { decisions: [] };

    // Kasa picker (same pattern as smart-charge).
    const sel = document.getElementById('solar-kasa-host');
    const currentHost = cfg.kasa_device_host || '';
    sel.innerHTML = '<option value="">— none —</option>';
    for (const d of (kasa.devices || [])) {
      const opt = document.createElement('option');
      opt.value = d.host;
      const label = d.alias || d.host;
      const tail = d.host ? ` (${d.host.slice(-7)})` : '';
      opt.textContent = `${label}${tail}`;
      if (d.host === currentHost) opt.selected = true;
      sel.appendChild(opt);
    }
    if (currentHost && !Array.from(sel.options).some(o => o.value === currentHost)) {
      const opt = document.createElement('option');
      opt.value = currentHost;
      opt.textContent = `${currentHost} (not in registry)`;
      opt.selected = true;
      sel.appendChild(opt);
    }

    // Hydrate fields with config + defaults.
    document.getElementById('solar-mode').value = cfg.mode || 'off';
    document.getElementById('solar-car-load-w').value = cfg.car_load_w ?? 1400;
    document.getElementById('solar-comfort-high').value = cfg.comfort_high_pct ?? 70;
    document.getElementById('solar-comfort-low').value = cfg.comfort_low_pct ?? 30;
    document.getElementById('solar-balance-spread').value =
      cfg.balance_spread_trigger_pp ?? 25;
    document.getElementById('solar-balance-days').value =
      cfg.balance_every_days ?? 30;
    document.getElementById('solar-min-hold').value = cfg.min_hold_s ?? 30;
    document.getElementById('solar-surplus-buffer').value = cfg.surplus_buffer_w ?? 100;
    document.getElementById('solar-on-hysteresis').value = cfg.on_hysteresis_pp ?? 3;
    document.getElementById('solar-safety-margin').value = cfg.safety_margin_pp ?? 5;
    document.getElementById('solar-max-system-load').value = cfg.max_system_load_w ?? 800;
    document.getElementById('solar-inverter-protect-load').value = cfg.inverter_protect_load_w ?? 2100;
    document.getElementById('solar-inverter-protect-cooldown').value = cfg.inverter_protect_cooldown_s ?? 1800;

    // Runtime panel: plug state + today's diverted kWh + last decision reason.
    const rt = status.runtime || {};
    const divertedKwh = ((status.diverted_wh_today || 0) / 1000).toFixed(2);
    const lastDecision = (status.recent_decisions || [])[0];
    const plugBadge = rt.plug_is_on
      ? '<span class="sc-mode" style="background:#2d5a2d">PLUG ON</span>'
      : '<span class="sc-mode" style="background:#555">PLUG OFF</span>';
    const rtPanel = document.getElementById('solar-runtime');
    if (rtPanel) {
      rtPanel.hidden = false;
      rtPanel.innerHTML = `
        <div style="display:flex; gap:14px; flex-wrap:wrap; align-items:center">
          ${plugBadge}
          <span class="hint">Today diverted: <strong>${divertedKwh} kWh</strong></span>
          ${lastDecision ? `<span class="hint">Last decision: <strong>${lastDecision.action}</strong> — ${escapeHtml(lastDecision.reason || '')}</span>` : ''}
        </div>`;
    }

    // History block (last 24h decisions). Collapsed by default: shows
    // only the latest decision with a "Show N more" toggle for the rest.
    const histBlock = document.getElementById('solar-history-block');
    const histEl = document.getElementById('solar-history');
    if (histBlock && histEl) {
      const rows = hist.decisions || [];
      histBlock.hidden = rows.length === 0;
      const renderRow = (r) => {
        const when = new Date((r.decided_at || 0) * 1000).toLocaleString();
        const action = r.action || '?';
        const modeBadge = `<span class="sc-mode">[${r.mode || '?'}]</span>`;
        const exec = r.executed ? '✓' : '·';
        const surplus = r.surplus_w != null ? `${Math.round(r.surplus_w)}W` : '—';
        const soc = r.current_soc_pct != null ? `${Math.round(r.current_soc_pct)}%` : '—';
        return `<div class="sc-history-row">
          <span class="hint" style="min-width:160px">${when}</span>
          ${modeBadge}
          <strong>${action}</strong> ${exec}
          <span class="hint">SOC ${soc} · surplus ${surplus}</span>
          <span class="hint" style="flex:1; text-align:right">${escapeHtml(r.reason || '')}</span>
        </div>`;
      };
      renderCollapsedHistory(histEl, rows, renderRow);
    }
  } catch (e) {
    console.error('loadSolarCharge', e);
    const s = document.getElementById('solar-status');
    if (s) { s.hidden = false; s.textContent = `Load failed: ${e.message || e}`; }
  }
}

document.getElementById('solar-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const status = document.getElementById('solar-status');
  const deviceSn = activeJackeryDevice()?.device_sn;
  if (!deviceSn) {
    status.hidden = false;
    status.textContent = 'No active device — cannot save.';
    return;
  }
  status.hidden = false;
  status.textContent = 'Saving…';
  const cfg = {
    mode: document.getElementById('solar-mode').value,
    kasa_device_host: document.getElementById('solar-kasa-host').value || null,
    car_load_w: parseInt(document.getElementById('solar-car-load-w').value, 10) || 1400,
    comfort_high_pct: parseInt(document.getElementById('solar-comfort-high').value, 10) || 70,
    comfort_low_pct: parseInt(document.getElementById('solar-comfort-low').value, 10) || 30,
    // 0 is a meaningful value (disables the trigger), so these cannot use
    // the `|| default` idiom the older fields do.
    balance_spread_trigger_pp: _intOr('solar-balance-spread', 25),
    balance_every_days: _intOr('solar-balance-days', 30),
    min_hold_s: parseInt(document.getElementById('solar-min-hold').value, 10) || 30,
    surplus_buffer_w: parseInt(document.getElementById('solar-surplus-buffer').value, 10) || 100,
    on_hysteresis_pp: parseInt(document.getElementById('solar-on-hysteresis').value, 10) || 3,
    safety_margin_pp: parseInt(document.getElementById('solar-safety-margin').value, 10) || 5,
    max_system_load_w: parseInt(document.getElementById('solar-max-system-load').value, 10) || 800,
    inverter_protect_load_w: parseInt(document.getElementById('solar-inverter-protect-load').value, 10) || 2100,
    inverter_protect_cooldown_s: parseInt(document.getElementById('solar-inverter-protect-cooldown').value, 10) || 1800,
  };
  try {
    const r = await fetch(`/api/solar_charge/config?device_sn=${encodeURIComponent(deviceSn)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(cfg),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.detail || `HTTP ${r.status}`);
    }
    status.textContent = 'Saved.';
    setTimeout(() => { status.hidden = true; }, 2500);
    loadSolarCharge();  // refresh runtime panel
  } catch (err) {
    status.textContent = `Save failed: ${err.message || err}`;
  }
});

document.getElementById('solar-evaluate')?.addEventListener('click', async () => {
  const status = document.getElementById('solar-status');
  const deviceSn = activeJackeryDevice()?.device_sn;
  status.hidden = false;
  status.textContent = 'Evaluating…';
  try {
    const url = deviceSn
      ? `/api/solar_charge/evaluate_now?device_sn=${encodeURIComponent(deviceSn)}`
      : '/api/solar_charge/evaluate_now';
    const r = await fetch(url, { method: 'POST' });
    const j = await r.json();
    if (j.plan) {
      status.textContent = `${j.plan.action.toUpperCase()} — ${j.plan.reason}`;
    } else {
      status.textContent = j.reason || 'No plan returned.';
    }
  } catch (e) {
    status.textContent = `Evaluate failed: ${e.message || e}`;
  }
});

document.getElementById('sc-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const status = $('sc-status');
  const deviceSn = activeJackeryDevice()?.device_sn;
  if (!deviceSn) {
    status.hidden = false;
    status.textContent = 'No active device — cannot save.';
    return;
  }
  status.hidden = false;
  status.textContent = 'Saving…';
  const cfg = {
    mode: $('sc-mode').value,
    kasa_device_host: $('sc-kasa-host').value || null,
    target_sunrise_soc_pct: parseInt($('sc-target-soc').value, 10) || 25,
    max_charge_w: parseInt($('sc-max-charge-w').value, 10) || 800,
    max_on_duration_minutes: parseInt($('sc-max-on-min').value, 10) || 480,
    claude_enabled: $('sc-claude-toggle').checked,
  };
  try {
    const r = await fetch(`/api/smart_charge/config?device_sn=${encodeURIComponent(deviceSn)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(cfg),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.detail || `HTTP ${r.status}`);
    }
    const saved = await r.json().catch(() => ({}));
    status.textContent = 'Saved.';
    // The POST response includes `conflicting_rules` keyed off the
    // saved config — render it immediately so flipping mode → active
    // surfaces the banner without a second round-trip.
    renderSmartChargeConflicts(saved.conflicting_rules || [],
                                saved.config?.mode || cfg.mode);
    setTimeout(() => { status.hidden = true; }, 2500);
  } catch (err) {
    status.textContent = `Save failed: ${err.message || err}`;
  }
});

document.getElementById('sc-evaluate')?.addEventListener('click', async () => {
  const status = $('sc-status');
  const deviceSn = activeJackeryDevice()?.device_sn;
  status.hidden = false;
  status.textContent = 'Evaluating…';
  try {
    const url = deviceSn
      ? `/api/smart_charge/evaluate_now?device_sn=${encodeURIComponent(deviceSn)}`
      : '/api/smart_charge/evaluate_now';
    const r = await fetch(url, { method: 'POST' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    renderSmartChargePlan(j.plan, j.narration);
    status.textContent = j.narration
      ? 'Plan computed + narrated.'
      : 'Plan computed (no execution).';
    setTimeout(() => { status.hidden = true; }, 3500);
  } catch (err) {
    status.textContent = `Evaluate failed: ${err.message || err}`;
  }
});

document.getElementById('sc-backtest')?.addEventListener('click', async () => {
  const status = $('sc-status');
  const deviceSn = activeJackeryDevice()?.device_sn;
  if (!deviceSn) {
    status.hidden = false;
    status.textContent = 'No active device.';
    return;
  }
  const days = parseInt($('sc-backtest-days').value, 10) || 7;
  const targetRaw = $('sc-backtest-target').value;
  const params = new URLSearchParams({ device_sn: deviceSn, days: String(days) });
  if (targetRaw) params.set('target_override', targetRaw);
  status.hidden = false;
  status.textContent = `Replaying ${days}d of decisions…`;
  try {
    const r = await fetch(`/api/smart_charge/backtest?${params}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    renderBacktestResult(j);
    status.textContent = `Replayed ${j.summary?.n || 0} decisions, ${j.summary?.n_flipped || 0} would flip.`;
    setTimeout(() => { status.hidden = true; }, 4500);
  } catch (err) {
    status.textContent = `Backtest failed: ${err.message || err}`;
  }
});

function renderBacktestResult(j) {
  const el = $('sc-backtest-result');
  if (!el) return;
  if (!j || !j.summary) { el.hidden = true; return; }
  const s = j.summary;
  const safe = (x) => String(x ?? '').replace(/[<>&"]/g, (c) =>
    ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]));
  const fmtTs = (ts) => new Date(ts * 1000).toLocaleString([], {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
  // Flip pairs as a compact key:value list.
  const flipPairsStr = Object.entries(s.flip_pairs || {})
    .map(([k, v]) => `${k}: ${v}`).join(', ') || '—';
  // Show first 30 flipped rows + first 10 errors so the user can
  // spot-check; full results are in the JSON response if they want
  // more.
  const flipped = (j.results || []).filter(r => r.would_flip).slice(0, 30);
  const errors = (j.results || []).filter(r => r.error).slice(0, 10);
  const flipRowsHtml = flipped.map(r => `
    <tr>
      <td>${fmtTs(r.ts)}</td>
      <td>${safe(r.old_action)}</td>
      <td><b>${safe(r.new_action)}</b></td>
      <td>${r.soc != null ? Math.round(r.soc) + '%' : '—'}</td>
      <td>${r.target}%</td>
      <td>${r.new_baseline_sunrise != null ? Math.round(r.new_baseline_sunrise) + '%' : '—'}</td>
      <td>${(r.planned_hours || []).length}</td>
      <td>${r.extension_active ? 'ext' : ''}</td>
      <td style="font-size:11px; color:#9aa0a6">${safe(r.new_reason)}</td>
    </tr>
  `).join('');
  const errRowsHtml = errors.map(r => `
    <tr><td>${fmtTs(r.ts)}</td><td colspan="8" style="color:#e57373">${safe(r.error)}</td></tr>
  `).join('');
  const targetNote = j.target_override != null
    ? ` <span style="color:#fbbc04">(target override: ${j.target_override}%)</span>`
    : '';
  el.innerHTML = `
    <h3 style="margin:0 0 8px; font-size:14px">Backtest — last ${j.days}d${targetNote}</h3>
    <div style="font-size:13px; line-height:1.7">
      <div><b>${s.n}</b> decisions replayed · <b>${s.n_flipped}</b> would flip · <b>${s.n_extension}</b> in extension · <b>${s.n_error}</b> errors</div>
      <div>old: ${Object.entries(s.by_action_old || {}).map(([k,v])=>`${k}=${v}`).join(', ')}</div>
      <div>new: ${Object.entries(s.by_action_new || {}).map(([k,v])=>`${k}=${v}`).join(', ')}</div>
      <div>flips: ${flipPairsStr}</div>
      <div style="margin-top:6px; color:#9aa0a6; font-size:12px">capacity ${j.capacity_wh} Wh · max charge ${j.max_charge_w} W · tz ${j.tz_offset_seconds}s</div>
    </div>
    ${flipped.length ? `
      <table style="width:100%; margin-top:10px; font-size:12px; border-collapse:collapse">
        <thead><tr style="text-align:left; color:#9aa0a6">
          <th>when</th><th>old</th><th>new</th><th>soc</th><th>target</th>
          <th>baseline</th><th>plan h</th><th></th><th>reason</th>
        </tr></thead>
        <tbody>${flipRowsHtml}</tbody>
      </table>
    ` : '<div style="margin-top:8px; color:#81c784">No flips — current code matches recorded decisions.</div>'}
    ${errors.length ? `<table style="width:100%; margin-top:10px; font-size:12px"><tbody>${errRowsHtml}</tbody></table>` : ''}
  `;
  el.hidden = false;
}

// ============================================================
// DEVICE PICKER
// ============================================================
$('device-select')?.addEventListener('change', async (e) => {
  const device_id = e.target.value;
  if (!device_id) return;
  // Latch the choice so applyStatus drops frames from the previous view
  // until the first frame for THIS device arrives (or 8s pass).
  _pendingViewSwitch = { id: String(device_id), until: Date.now() + 8000 };
  setDeviceSwitching(true);
  // Per-browser view selection — sets a cookie so this browser's UI shows
  // the chosen Jackery without changing what other browsers see, and
  // without changing which device the automation worker manages. The
  // bridge polls every device on every tick, so picking a non-bridge-
  // active device just switches which slice of cloud_meta we render.
  try {
    await fetch('/api/view/select_device', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_id }),
    });
  } catch (err) {
    _pendingViewSwitch = null;  // switch didn't happen — stop dropping frames
    setDeviceSwitching(false);
    console.warn('view/select_device failed', err);
  }
});

function renderDevicePicker(devices, selectedId) {
  const wrap = $('device-picker');
  const sel = $('device-select');
  if (!wrap || !sel) return;
  if (!devices || devices.length < 2) { show(wrap, false); return; }
  show(wrap, true);
  // Only rebuild if the option set changed (include online status in signature)
  const sig = devices.map(d => `${d.device_id}:${d.online}`).join('|') + '#' + (selectedId || '');
  if (sel.dataset.sig === sig) return;
  sel.dataset.sig = sig;
  sel.innerHTML = '';
  for (const d of devices) {
    const o = document.createElement('option');
    o.value = d.device_id;
    let label = d.name || d.model_name || d.device_sn || d.device_id;
    if (d.online === false) {
      label += ' (Offline)';
    }
    o.textContent = label;
    if (d.device_id === selectedId) o.selected = true;
    sel.appendChild(o);
  }
}

// ============================================================
// SINOPÉ SMART CLIMATE & LOADS TAB
// ============================================================
let _sinopeSelectedLocation = localStorage.getItem('sinope_selected_location') || 'all';
let lastSinopeDevices = [];
let _lastSinopePollTs = null;
const _sinopeLocHours = { maison: 24, chalet: 24 };
const _sinopeDevHours = {};
const _sinopeOpenDeviceHistories = new Set();
const _sinopeLocHistData = {};
const _sinopeDevHistData = {};
let _sinopeResizeBound = false;

function initSinopeTab() {
  document.querySelectorAll('.sinope-loc-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      _sinopeSelectedLocation = pill.dataset.loc || 'all';
      localStorage.setItem('sinope_selected_location', _sinopeSelectedLocation);
      document.querySelectorAll('.sinope-loc-pill').forEach(p => {
        p.classList.toggle('on', p.dataset.loc === _sinopeSelectedLocation);
      });
      renderSinopeTab();
    });
  });

  $('sinope-tab-poll-btn')?.addEventListener('click', async () => {
    const btn = $('sinope-tab-poll-btn');
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner" style="display:inline-block;width:12px;height:12px;border:2px solid currentColor;border-top-color:transparent;border-radius:50%;animation:spin .8s linear infinite;"></span> Polling…';
    }
    try {
      const r = await fetch('/api/sinope/poll', { method: 'POST' });
      const j = await r.json();
      if (j.devices) {
        lastSinopeDevices = j.devices;
        if (lastStatus) lastStatus.sinope_devices = j.devices;
        _lastSinopePollTs = Date.now();
      }
    } catch (e) {
      console.warn('Manual Sinopé poll error:', e);
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = '<span class="poll-icon">🔄</span> Poll now';
      }
      renderSinopeTab();
    }
  });

  if (!_sinopeResizeBound) {
    _sinopeResizeBound = true;
    window.addEventListener('resize', () => {
      if (activeTab === 'sinope') {
        Object.keys(_sinopeLocHours).forEach(lid => {
          const canvas = $('sinope-chart-loc-' + lid);
          if (canvas && canvas._redraw) canvas._redraw();
        });
        _sinopeOpenDeviceHistories.forEach(sn => {
          const canvas = $('chart-sinope-dev-' + sn);
          if (canvas && canvas._redraw) canvas._redraw();
        });
      }
    });
  }
}

function buildLocationChartHtml(lid, locName) {
  const currentHours = _sinopeLocHours[lid] || 24;
  return `
    <div class="sinope-loc-chart-card card" id="sinope-loc-card-${escapeHtml(lid)}">
      <div class="sinope-loc-chart-header">
        <div class="sinope-loc-chart-info">
          <span class="sinope-loc-chart-title">📊 ${escapeHtml(locName)} Total Energy &amp; Power Draw</span>
          <div class="sinope-loc-chart-stats">
            <span class="sinope-chart-stat"><span class="lbl">Now:</span> <b id="sinope-loc-now-${escapeHtml(lid)}">—</b></span>
            <span class="sinope-chart-stat"><span class="lbl">Period Energy:</span> <b id="sinope-loc-energy-${escapeHtml(lid)}">—</b></span>
            <span class="sinope-chart-stat"><span class="lbl">Peak:</span> <b id="sinope-loc-peak-${escapeHtml(lid)}">—</b></span>
          </div>
        </div>
        <div class="range-picker sinope-loc-range-picker" data-loc="${escapeHtml(lid)}">
          <button type="button" class="sinope-loc-range-btn ${currentHours === 6 ? 'on' : ''}" data-loc="${escapeHtml(lid)}" data-hours="6">6h</button>
          <button type="button" class="sinope-loc-range-btn ${currentHours === 12 ? 'on' : ''}" data-loc="${escapeHtml(lid)}" data-hours="12">12h</button>
          <button type="button" class="sinope-loc-range-btn ${currentHours === 24 ? 'on' : ''}" data-loc="${escapeHtml(lid)}" data-hours="24">24h</button>
          <button type="button" class="sinope-loc-range-btn ${currentHours === 168 ? 'on' : ''}" data-loc="${escapeHtml(lid)}" data-hours="168">7d</button>
        </div>
      </div>
      <div class="sinope-chart-canvas-wrap">
        <canvas id="sinope-chart-loc-${escapeHtml(lid)}" class="chart sinope-chart"></canvas>
      </div>
      <div class="legend sinope-chart-legend" id="sinope-legend-loc-${escapeHtml(lid)}">
        <span class="legend-item"><i style="background:#38ef7d"></i> Total Load (W)</span>
        <span class="legend-item"><i style="background:#ff7a18"></i> Thermostats (W)</span>
        <span class="legend-item"><i style="background:#38bdf8"></i> Controllers (W)</span>
        <span class="legend-item" id="sinope-legend-temp-${escapeHtml(lid)}"><i style="background:#a78bfa; border-radius:50%"></i> Avg Temp</span>
      </div>
    </div>
  `;
}

function drawSinopeLocationChart(locId, hist, hours) {
  const canvas = $('sinope-chart-loc-' + locId);
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  if (rect.width <= 10) return;

  const { ctx, w, h } = setCanvasSize(canvas);
  ctx.clearRect(0, 0, w, h);
  const padL = 52, padR = 48, padT = 16, padB = 30;

  if (!hist || !hist.length) {
    drawAxes(ctx, w, h, padL, padR, padT, padB);
    ctx.fillStyle = '#6b7280';
    ctx.font = '12px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Accumulating historical telemetry data for this location…', w / 2, h / 2);
    return;
  }

  let plotHist = hist;
  if (hist.length === 1) {
    const single = hist[0];
    plotHist = [{ ...single, ts: single.ts - 300 }, single];
  }

  const isF = getTempUnit() === 'F';
  const totalW = plotHist.map(r => r.total_w || 0);
  const thermW = plotHist.map(r => r.thermostat_w || 0);
  const ctrlW = plotHist.map(r => r.controller_w || 0);
  const temps = plotHist.map(r => (r.avg_temp_c != null ? (isF ? r.avg_temp_c * 9/5 + 32 : r.avg_temp_c) : null));
  const validTemps = temps.filter(t => t != null && Number.isFinite(t));
  const hasTemps = validTemps.length > 0;

  const maxW = Math.max(100, Math.ceil((Math.max(...totalW) * 1.15) / 50) * 50);
  const xs = (i) => padL + (i / Math.max(1, plotHist.length - 1)) * (w - padL - padR);
  const yWatts = (v) => (h - padB) - (v / maxW) * (h - padT - padB);
  const baseY = h - padB;

  let minT = 15, maxT = 25;
  if (hasTemps) {
    minT = Math.floor(Math.min(...validTemps) - 1);
    maxT = Math.ceil(Math.max(...validTemps) + 1);
    if (maxT - minT < 4) maxT = minT + 4;
  }
  const yTemp = (t) => (h - padB) - ((t - minT) / (maxT - minT)) * (h - padT - padB);

  // Gridlines & Axes
  ctx.strokeStyle = 'rgba(35,42,51,.7)';
  ctx.lineWidth = 1;
  for (let i = 1; i <= 4; i++) {
    const y = padT + ((h - padT - padB) * i) / 5;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
  }
  drawAxes(ctx, w, h, padL, padR, padT, padB);

  // Left Y-axis labels (Watts)
  ctx.fillStyle = '#6b7280'; ctx.font = '11px Inter, sans-serif';
  ctx.textAlign = 'right';
  for (let i = 0; i <= 4; i++) {
    const v = (maxW * (4 - i)) / 4;
    const y = padT + ((h - padT - padB) * i) / 4;
    ctx.fillText(`${Math.round(v)} W`, padL - 6, y + 3);
  }

  // Right Y-axis labels (Avg Temp if available)
  if (hasTemps) {
    ctx.textAlign = 'left';
    ctx.fillStyle = '#a78bfa';
    const midT = (minT + maxT) / 2;
    ctx.fillText(`${Math.round(maxT)}°`, w - padR + 6, yTemp(maxT) + 3);
    ctx.fillText(`${Math.round(midT)}°`, w - padR + 6, yTemp(midT) + 3);
    ctx.fillText(`${Math.round(minT)}°`, w - padR + 6, yTemp(minT) + 3);
  }

  // X-axis time ticks
  if (plotHist.length >= 2) {
    const first = plotHist[0].ts || 0, last = plotHist[plotHist.length - 1].ts || 0;
    const spanH = (last - first) / 3600;
    ctx.fillStyle = '#6b7280';
    ctx.textAlign = 'center';
    const ticks = Math.min(5, plotHist.length - 1);
    for (let i = 0; i <= ticks; i++) {
      const idx = Math.round((plotHist.length - 1) * (i / ticks));
      const ts = plotHist[idx].ts || (first + (last - first) * (i / ticks));
      const d = new Date(ts * 1000);
      const str = (spanH > 24)
        ? (d.toLocaleDateString([], { month: 'numeric', day: 'numeric' }) + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))
        : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      ctx.fillText(str, xs(idx), h - 8);
    }
    ctx.textAlign = 'start';
  }

  // Traces
  drawAreaFill(ctx, totalW, xs, yWatts, baseY, '#38ef7d', 0.18);
  drawSmoothLine(ctx, totalW, xs, yWatts, '#38ef7d', 2.5);

  if (thermW.some(v => v > 0)) {
    drawSmoothLine(ctx, thermW, xs, yWatts, '#ff7a18', 1.8);
  }
  if (ctrlW.some(v => v > 0)) {
    drawSmoothLine(ctx, ctrlW, xs, yWatts, '#38bdf8', 1.8);
  }
  if (hasTemps) {
    ctx.save();
    ctx.setLineDash([4, 4]);
    drawSmoothLine(ctx, temps, xs, yTemp, '#a78bfa', 1.6);
    ctx.restore();
  }

  canvas._redraw = () => drawSinopeLocationChart(locId, hist, hours);

  _attachChartHover(canvas, plotHist, (idx) => {
    const p = plotHist[idx];
    if (!p) return '';
    const d = new Date(p.ts * 1000);
    const tsStr = d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }) + ' ' +
                  d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const totW = Math.round(p.total_w || 0);
    const totWh = p.total_wh != null ? (p.total_wh >= 1000 ? (p.total_wh / 1000).toFixed(2) + ' kWh' : Math.round(p.total_wh) + ' Wh') : '—';
    const thW = Math.round(p.thermostat_w || 0);
    const ctW = Math.round(p.controller_w || 0);
    const tStr = p.avg_temp_c != null ? formatTemp(p.avg_temp_c, 1) : null;
    const count = p.device_count || 0;

    let rows = `
      <div class="cht-ts">${escapeHtml(tsStr)}</div>
      <div class="cht-row"><i style="background:#38ef7d"></i> Total Load: <b>${totW.toLocaleString()} W</b></div>
      <div class="cht-row"><i style="background:#ff7a18"></i> Thermostats: <b>${thW.toLocaleString()} W</b></div>
      <div class="cht-row"><i style="background:#38bdf8"></i> Controllers: <b>${ctW.toLocaleString()} W</b></div>
      <div class="cht-row"><i style="background:transparent; border:1px solid #64748b"></i> Interval Energy: <b>${totWh}</b></div>
    `;
    if (tStr != null) {
      rows += `<div class="cht-row"><i style="background:#a78bfa; border-radius:50%"></i> Avg Temp: <b>${tStr}</b></div>`;
    }
    if (count > 0) {
      rows += `<div class="cht-row" style="font-size:11px; opacity:0.8"><i style="background:transparent"></i> Devices: <b>${count}</b></div>`;
    }
    return rows;
  }, () => ({ xs, padL, padR, w, h, baseY, padT, padB }));
}

async function loadAndDrawLocationChart(locId, force = false) {
  const hours = _sinopeLocHours[locId] || 24;
  const cacheKey = `${locId}_${hours}`;
  const now = Date.now();
  let hist = null;

  if (!force && _sinopeLocHistData[cacheKey] && (now - _sinopeLocHistData[cacheKey].ts < 45000)) {
    hist = _sinopeLocHistData[cacheKey].data;
  } else {
    try {
      const r = await fetch(`/api/sinope/history/location?location_id=${encodeURIComponent(locId)}&hours=${hours}`);
      if (r.ok) {
        const j = await r.json();
        hist = j.history || [];
        _sinopeLocHistData[cacheKey] = { ts: now, data: hist };
      }
    } catch (e) {
      console.warn('Failed to load Sinope location history:', e);
    }
  }

  if (hist) {
    drawSinopeLocationChart(locId, hist, hours);

    const nowEl = $(`sinope-loc-now-${locId}`);
    const energyEl = $(`sinope-loc-energy-${locId}`);
    const peakEl = $(`sinope-loc-peak-${locId}`);

    if (nowEl) {
      const latestW = hist.length ? Math.round(hist[hist.length - 1].total_w || 0) : 0;
      nowEl.textContent = `${latestW.toLocaleString()} W`;
    }
    if (energyEl) {
      const sumWh = hist.reduce((sum, r) => sum + (r.total_wh || 0), 0);
      energyEl.textContent = sumWh >= 1000 ? `${(sumWh / 1000).toFixed(2)} kWh` : `${Math.round(sumWh)} Wh`;
    }
    if (peakEl) {
      const maxW = hist.length ? Math.max(...hist.map(r => r.total_w || 0)) : 0;
      peakEl.textContent = `${Math.round(maxW).toLocaleString()} W`;
    }
  }
}

function drawSinopeDeviceChart(sn, hist, hours) {
  const canvas = $('chart-sinope-dev-' + sn);
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  if (rect.width <= 10) return;

  const { ctx, w, h } = setCanvasSize(canvas);
  ctx.clearRect(0, 0, w, h);

  const devices = (lastStatus && lastStatus.sinope_devices) || lastSinopeDevices || [];
  const dev = devices.find(d => d.device_sn === sn) || { device_type: 'load' };
  const isThermostat = dev.device_type === 'thermostat';
  const isWaterHeater = Boolean(dev.is_water_heater || (dev.model && dev.model.startsWith('RM35')) || dev.water_temperature_c != null);

  const padL = 46, padR = ((isThermostat || isWaterHeater) ? 44 : 20), padT = 14, padB = 26;

  if (!hist || !hist.length) {
    drawAxes(ctx, w, h, padL, padR, padT, padB);
    ctx.fillStyle = '#6b7280';
    ctx.font = '12px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Accumulating history for this device…', w / 2, h / 2);
    return;
  }

  let plotHist = hist;
  if (hist.length === 1) {
    const single = hist[0];
    plotHist = [{ ...single, ts: single.ts - 300 }, single];
  }

  const isF = getTempUnit() === 'F';
  const powerW = plotHist.map(r => r.power_w || 0);
  const temps = plotHist.map(r => (r.temp_c != null ? (isF ? r.temp_c * 9/5 + 32 : r.temp_c) : null));
  const validTemps = temps.filter(t => t != null && Number.isFinite(t));
  const hasTemps = (isThermostat || isWaterHeater) && validTemps.length > 0;

  const maxW = Math.max(50, Math.ceil((Math.max(...powerW) * 1.15) / 25) * 25);
  const xs = (i) => padL + (i / Math.max(1, plotHist.length - 1)) * (w - padL - padR);
  const yWatts = (v) => (h - padB) - (v / maxW) * (h - padT - padB);
  const baseY = h - padB;

  let minT = 15, maxT = 25;
  if (hasTemps) {
    minT = Math.floor(Math.min(...validTemps) - 1);
    maxT = Math.ceil(Math.max(...validTemps) + 1);
    if (maxT - minT < 4) maxT = minT + 4;
  }
  const yTemp = (t) => (h - padB) - ((t - minT) / (maxT - minT)) * (h - padT - padB);

  // Gridlines & Axes
  ctx.strokeStyle = 'rgba(35,42,51,.7)';
  ctx.lineWidth = 1;
  for (let i = 1; i <= 3; i++) {
    const y = padT + ((h - padT - padB) * i) / 4;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
  }
  drawAxes(ctx, w, h, padL, padR, padT, padB);

  // Left Y-axis labels
  ctx.fillStyle = '#6b7280'; ctx.font = '10px Inter, sans-serif';
  ctx.textAlign = 'right';
  for (let i = 0; i <= 3; i++) {
    const v = (maxW * (3 - i)) / 3;
    const y = padT + ((h - padT - padB) * i) / 3;
    ctx.fillText(`${Math.round(v)}`, padL - 5, y + 3);
  }

  // Right Y-axis labels for temperature
  if (hasTemps) {
    ctx.textAlign = 'left';
    ctx.fillStyle = '#38bdf8';
    ctx.fillText(`${Math.round(maxT)}°`, w - padR + 5, yTemp(maxT) + 3);
    ctx.fillText(`${Math.round((minT + maxT) / 2)}°`, w - padR + 5, yTemp((minT + maxT) / 2) + 3);
    ctx.fillText(`${Math.round(minT)}°`, w - padR + 5, yTemp(minT) + 3);
  }

  // X-axis time ticks
  if (plotHist.length >= 2) {
    const first = plotHist[0].ts || 0, last = plotHist[plotHist.length - 1].ts || 0;
    const spanH = (last - first) / 3600;
    ctx.fillStyle = '#6b7280';
    ctx.textAlign = 'center';
    const ticks = Math.min(4, plotHist.length - 1);
    for (let i = 0; i <= ticks; i++) {
      const idx = Math.round((plotHist.length - 1) * (i / ticks));
      const ts = plotHist[idx].ts || (first + (last - first) * (i / ticks));
      const d = new Date(ts * 1000);
      const str = (spanH > 24)
        ? (d.toLocaleDateString([], { month: 'numeric', day: 'numeric' }) + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))
        : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      ctx.fillText(str, xs(idx), h - 7);
    }
    ctx.textAlign = 'start';
  }

  // Traces
  const primaryColor = isThermostat ? '#ff7a18' : '#38ef7d';
  drawAreaFill(ctx, powerW, xs, yWatts, baseY, primaryColor, 0.22);
  drawSmoothLine(ctx, powerW, xs, yWatts, primaryColor, 2.0);

  if (hasTemps) {
    drawSmoothLine(ctx, temps, xs, yTemp, '#38bdf8', 1.8);
  }

  canvas._redraw = () => drawSinopeDeviceChart(sn, hist, hours);

  _attachChartHover(canvas, plotHist, (idx) => {
    const p = plotHist[idx];
    if (!p) return '';
    const d = new Date(p.ts * 1000);
    const tsStr = d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }) + ' ' +
                  d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const pwr = Math.round(p.power_w || 0);
    const wh = p.energy_wh != null ? (p.energy_wh >= 1000 ? (p.energy_wh / 1000).toFixed(2) + ' kWh' : Math.round(p.energy_wh) + ' Wh') : '—';
    const tStr = p.temp_c != null ? formatTemp(p.temp_c, 1) : null;
    const stateStr = (!isThermostat) ? (pwr > 10 ? '⚡ ON' : '○ Standby') : null;
    const tempLabel = isWaterHeater ? 'Tank Temp' : 'Room Temp';

    let rows = `
      <div class="cht-ts">${escapeHtml(tsStr)}</div>
      <div class="cht-row"><i style="background:${primaryColor}"></i> Power: <b>${pwr.toLocaleString()} W</b></div>
      <div class="cht-row"><i style="background:transparent; border:1px solid #64748b"></i> Interval Energy: <b>${wh}</b></div>
    `;
    if (tStr != null && hasTemps) {
      rows += `<div class="cht-row"><i style="background:#38bdf8; border-radius:50%"></i> ${tempLabel}: <b>${tStr}</b></div>`;
    }
    if (stateStr != null) {
      rows += `<div class="cht-row"><i style="background:${pwr > 10 ? '#38ef7d' : '#64748b'}"></i> State: <b>${stateStr}</b></div>`;
    }
    return rows;
  }, () => ({ xs, padL, padR, w, h, baseY, padT, padB }));
}

async function loadAndDrawDeviceChart(sn, force = false) {
  const hours = _sinopeDevHours[sn] || 24;
  const cacheKey = `${sn}_${hours}`;
  const now = Date.now();
  let hist = null;

  if (!force && _sinopeDevHistData[cacheKey] && (now - _sinopeDevHistData[cacheKey].ts < 45000)) {
    hist = _sinopeDevHistData[cacheKey].data;
  } else {
    try {
      const r = await fetch(`/api/sinope/history/device?device_sn=${encodeURIComponent(sn)}&hours=${hours}`);
      if (r.ok) {
        const j = await r.json();
        hist = j.history || [];
        _sinopeDevHistData[cacheKey] = { ts: now, data: hist };
      }
    } catch (e) {
      console.warn('Failed to load Sinope device history:', e);
    }
  }

  if (hist) {
    drawSinopeDeviceChart(sn, hist, hours);

    const energyEl = $(`sinope-dev-energy-${sn}`);
    const peakEl = $(`sinope-dev-peak-${sn}`);
    const avgTempEl = $(`sinope-dev-avgtemp-${sn}`);

    if (energyEl) {
      const sumWh = hist.reduce((sum, r) => sum + (r.energy_wh || 0), 0);
      energyEl.textContent = sumWh >= 1000 ? `${(sumWh / 1000).toFixed(2)} kWh` : `${Math.round(sumWh)} Wh`;
    }
    if (peakEl) {
      const maxW = hist.length ? Math.max(...hist.map(r => r.power_w || 0)) : 0;
      peakEl.textContent = `${Math.round(maxW).toLocaleString()} W`;
    }
    if (avgTempEl) {
      const validTemps = hist.map(r => r.temp_c).filter(t => t != null && Number.isFinite(t));
      if (validTemps.length) {
        const avgC = validTemps.reduce((a, b) => a + b, 0) / validTemps.length;
        avgTempEl.textContent = formatTemp(avgC, 1);
      } else {
        avgTempEl.textContent = '—';
      }
    }
  }
}

function renderSinopeTab() {
  const container = $('sinope-devices-container');
  if (!container) return;

  const devices = (lastStatus && lastStatus.sinope_devices) || lastSinopeDevices || [];
  const locations = (lastStatus && lastStatus.locations) || [
    { id: 'maison', name: 'Maison', plan_id: 'hq-tarif-d-tdt' },
    { id: 'chalet', name: 'Chalet', plan_id: 'hq-tarif-flex-d' },
  ];

  // Update Location pill active classes
  document.querySelectorAll('.sinope-loc-pill').forEach(p => {
    p.classList.toggle('on', p.dataset.loc === _sinopeSelectedLocation);
  });

  // Update Last poll time
  const pollTimeEl = $('sinope-last-poll-time');
  if (pollTimeEl) {
    if (_lastSinopePollTs) {
      const elapsedM = Math.max(0, Math.round((Date.now() - _lastSinopePollTs) / 60000));
      pollTimeEl.textContent = elapsedM === 0 ? 'Last update: just now' : `Last update: ${elapsedM}m ago`;
    } else if (devices.length) {
      pollTimeEl.textContent = 'Last update: active';
    } else {
      pollTimeEl.textContent = 'Last update: —';
    }
  }

  // Filter devices based on chosen location
  const locFilter = _sinopeSelectedLocation;
  const filtered = (locFilter === 'all')
    ? devices
    : devices.filter(d => (d.location_id || '').toLowerCase() === locFilter.toLowerCase());

  // Compute KPIs
  const isF = getTempUnit() === 'F';
  let totalW = 0;
  let thermostats = [];
  let controllers = [];
  let valves = [];
  let leakSensors = [];
  let heatingCount = 0;
  let activeCtrlCount = 0;
  let temps = [];
  let leakAlertCount = 0;

  filtered.forEach(d => {
    const pwr = Math.round(d.power_w || 0);
    totalW += pwr;
    if (d.device_type === 'thermostat') {
      thermostats.push(d);
      if (d.heat_level_pct != null && d.heat_level_pct > 0) {
        heatingCount++;
      }
      if (d.room_temp_c != null) {
        temps.push(d.room_temp_c);
      }
    } else if (d.device_type === 'valve') {
      valves.push(d);
    } else if (d.device_type === 'leak_sensor') {
      leakSensors.push(d);
      const isLeak = Boolean(d.leak_status && d.leak_status.toLowerCase() !== 'ok' && d.leak_status.toLowerCase() !== 'dry');
      if (isLeak) leakAlertCount++;
    } else {
      controllers.push(d);
      const isWh = Boolean(d.is_water_heater || (d.model && d.model.startsWith('RM35')) || d.water_temperature_c != null);
      if (d.is_on && (!isWh || pwr > 10)) {
        activeCtrlCount++;
      }
    }
  });

  // Update KPI card DOM
  const kpiPower = $('sinope-kpi-power');
  if (kpiPower) kpiPower.textContent = totalW.toLocaleString();

  const kpiHeatCount = $('sinope-kpi-heating-count');
  const kpiHeatTotal = $('sinope-kpi-heating-total');
  const kpiHeatSub = $('sinope-kpi-heating-sub');
  if (kpiHeatCount) kpiHeatCount.textContent = heatingCount;
  if (kpiHeatTotal) kpiHeatTotal.textContent = `/ ${thermostats.length}`;
  if (kpiHeatSub) kpiHeatSub.textContent = `${heatingCount} heating now`;

  const kpiCtrlCount = $('sinope-kpi-ctrl-count');
  const kpiCtrlTotal = $('sinope-kpi-ctrl-total');
  const kpiCtrlSub = $('sinope-kpi-ctrl-sub');
  if (kpiCtrlCount) kpiCtrlCount.textContent = activeCtrlCount;
  if (kpiCtrlTotal) kpiCtrlTotal.textContent = `/ ${controllers.length}`;
  if (kpiCtrlSub) kpiCtrlSub.textContent = `${activeCtrlCount} active load`;

  const kpiAvgTemp = $('sinope-kpi-avg-temp');
  const kpiTempSub = $('sinope-kpi-temp-sub');
  if (temps.length) {
    const avgC = temps.reduce((a, b) => a + b, 0) / temps.length;
    if (kpiAvgTemp) kpiAvgTemp.textContent = isF ? (avgC * 9/5 + 32).toFixed(1) : avgC.toFixed(1);
    if (kpiTempSub) kpiTempSub.textContent = `Across ${temps.length} zones`;
  } else {
    if (kpiAvgTemp) kpiAvgTemp.textContent = '—';
    if (kpiTempSub) kpiTempSub.textContent = 'No temp sensors';
  }

  const kpiWaterStatus = $('sinope-kpi-water-status');
  const kpiWaterSub = $('sinope-kpi-water-sub');
  const totalWaterDevs = valves.length + leakSensors.length;
  if (kpiWaterStatus) {
    if (leakAlertCount > 0) {
      kpiWaterStatus.textContent = 'LEAK ALERT';
      kpiWaterStatus.style.color = '#ef4444';
      if (kpiWaterSub) kpiWaterSub.textContent = `${leakAlertCount} sensor(s) triggered!`;
    } else if (totalWaterDevs > 0) {
      kpiWaterStatus.textContent = 'All Dry';
      kpiWaterStatus.style.color = '#38ef7d';
      if (kpiWaterSub) kpiWaterSub.textContent = `${valves.length} valve${valves.length > 1 ? 's' : ''}, ${leakSensors.length} sensor${leakSensors.length > 1 ? 's' : ''}`;
    } else {
      kpiWaterStatus.textContent = '—';
      kpiWaterStatus.style.color = '';
      if (kpiWaterSub) kpiWaterSub.textContent = 'No water devices';
    }
  }

  // Handle empty state
  if (!devices.length) {
    container.innerHTML = `
      <div class="sinope-empty-card">
        <span style="font-size:36px">❄️</span>
        <h3>No Sinopé Devices Found</h3>
        <p>If you haven't configured your Sinopé / Neviweb account yet, add your credentials in Settings. Otherwise, click Poll Now to scan your account.</p>
        <div style="display:flex; gap:10px; margin-top:8px">
          <button type="button" class="btn btn-primary" onclick="switchTab('settings'); selectSettingsSubtab('integrations'); document.getElementById('settings-card-sinope')?.classList.remove('collapsed'); document.getElementById('settings-card-sinope')?.scrollIntoView({behavior:'smooth'});">Configure in Settings</button>
          <button type="button" class="btn btn-ghost" onclick="$('sinope-tab-poll-btn')?.click()">Poll Now</button>
        </div>
      </div>
    `;
    return;
  }

  if (!filtered.length) {
    const locObj = locations.find(l => l.id.toLowerCase() === locFilter.toLowerCase());
    const locName = locObj ? locObj.name : locFilter;
    container.innerHTML = `
      <div class="sinope-empty-card">
        <span style="font-size:32px">🏠</span>
        <h3>No devices at ${escapeHtml(locName)}</h3>
        <p>There are no Sinopé devices registered under the location "${escapeHtml(locName)}". Switch to "All Locations" to view other devices.</p>
      </div>
    `;
    return;
  }

  // Helper to build a single device card HTML
  function buildDeviceCardHtml(d) {
    const pwr = Math.round(d.power_w || 0);
    const isHeating = (d.heat_level_pct != null && d.heat_level_pct > 0);
    const isActiveLoad = (d.device_type === 'controller' && d.is_on && pwr > 10);
    const isLeakAlert = Boolean(d.device_type === 'leak_sensor' && d.leak_status && d.leak_status.toLowerCase() !== 'ok' && d.leak_status.toLowerCase() !== 'dry');
    const snEsc = escapeHtml(d.device_sn);
    const isExpanded = _sinopeOpenDeviceHistories.has(d.device_sn);
    const cardClass = [
      'sinope-dev-card',
      isHeating ? 'is-heating' : '',
      isActiveLoad ? 'is-active-load' : '',
      isLeakAlert ? 'is-leak-alert' : '',
      isExpanded ? 'has-open-history' : '',
    ].filter(Boolean).join(' ');

    let metricsHtml = '';
    let dutyHtml = '';
    let statusBadge = '';
    let canShowHistory = (d.device_type === 'thermostat' || d.device_type === 'controller');

    if (d.device_type === 'thermostat') {
      const curC = d.room_temp_c;
      const curDisplay = curC != null ? formatTemp(curC, 1) : '—';
      const setC = d.setpoint_c;
      const setDisplay = setC != null ? formatTemp(setC, 1) : '—';

      metricsHtml = `
        <div class="sinope-dev-metrics">
          <div class="sinope-temp-row">
            <span class="sinope-temp-cur">${curDisplay}</span>
            <span class="sinope-temp-target">Set: ${setDisplay}</span>
          </div>
          <span class="sinope-power-val">${pwr} W</span>
        </div>
      `;

      const pct = Math.min(100, Math.max(0, d.heat_level_pct || 0));
      dutyHtml = `
        <div class="sinope-duty-track">
          <div class="sinope-duty-bar" style="width: ${pct}%;"></div>
        </div>
        <div class="sinope-duty-label">
          <span>${pct}% duty cycle</span>
          <span>${d.load_watt ? Math.round(d.load_watt) + ' W rated' : ''}</span>
        </div>
      `;

      if (!d.is_online) {
        statusBadge = `<span class="sinope-badge off">⚠️ Offline</span>`;
      } else if (isHeating) {
        statusBadge = `<span class="sinope-badge heating">🔥 ${pct}% heat</span>`;
      } else {
        statusBadge = `<span class="sinope-badge idle">Idle</span>`;
      }
    } else if (d.is_water_heater || (d.model && d.model.startsWith('RM35')) || d.water_temperature_c != null) {
      const waterC = d.water_temperature_c;
      const waterDisplay = waterC != null ? formatTemp(waterC, 1) : '—';
      const todayKwhStr = d.today_kwh != null ? `${d.today_kwh.toFixed(1)} kWh today` : '';
      metricsHtml = `
        <div class="sinope-dev-metrics">
          <div class="sinope-temp-row">
            <span class="sinope-temp-cur">💧 ${waterDisplay}</span>
            <span class="sinope-temp-target">${d.is_on ? '⚡ Armed' : '○ Shed'}</span>
          </div>
          <span class="sinope-power-val">${pwr > 10 ? pwr + ' W' : (todayKwhStr || 'Standby')}</span>
        </div>
      `;
      dutyHtml = `
        <div class="sinope-duty-label" style="margin-top:6px">
          <span>${d.load_watt ? Math.round(d.load_watt) + ' W rated element' : 'Calypso Water Heater'}</span>
          <span>${todayKwhStr ? todayKwhStr : (d.is_on ? 'Relay Active' : 'Relay Off')}</span>
        </div>
      `;
      if (!d.is_online) {
        statusBadge = `<span class="sinope-badge off">⚠️ Offline</span>`;
      } else if (!d.is_on) {
        statusBadge = `<span class="sinope-badge off">○ Disabled / Peak Shed</span>`;
      } else if (pwr > 10) {
        statusBadge = `<span class="sinope-badge heating">🔥 Reheating (${pwr} W)</span>`;
      } else {
        statusBadge = `<span class="sinope-badge idle">⚡ Armed (Standby)</span>`;
      }
    } else if (d.device_type === 'controller') {
      metricsHtml = `
        <div class="sinope-dev-metrics">
          <span class="sinope-temp-cur" style="font-size:17px">${d.is_on ? '⚡ ON' : '○ OFF'}</span>
          <span class="sinope-power-val">${pwr} W</span>
        </div>
      `;
      dutyHtml = `
        <div class="sinope-duty-label" style="margin-top:6px">
          <span>${d.load_watt ? Math.round(d.load_watt) + ' W rated load' : 'Heavy Load Relay'}</span>
          <span>${d.is_on ? 'Active' : 'Standby'}</span>
        </div>
      `;
      if (!d.is_online) {
        statusBadge = `<span class="sinope-badge off">⚠️ Offline</span>`;
      } else {
        statusBadge = d.is_on
          ? `<span class="sinope-badge on">● Active Load</span>`
          : `<span class="sinope-badge off">○ Standby</span>`;
      }
    } else if (d.device_type === 'valve') {
      metricsHtml = `
        <div class="sinope-dev-metrics">
          <span class="sinope-temp-cur" style="font-size:17px">🛡️ Valve Open</span>
          <span class="sinope-power-val" style="font-size:13px; color:var(--text-dim)">Main Line</span>
        </div>
      `;
      dutyHtml = `
        <div class="sinope-duty-label" style="margin-top:6px">
          <span>Sedna Smart Valve</span>
          <span>Auto-shutoff</span>
        </div>
      `;
      statusBadge = d.is_online
        ? `<span class="sinope-badge valve-open">💧 Protected</span>`
        : `<span class="sinope-badge off">⚠️ Offline</span>`;
    } else if (d.device_type === 'leak_sensor') {
      const curC = d.room_temp_c;
      const curDisplay = curC != null ? formatTemp(curC, 1) : '—';
      const battDisplay = d.battery_pct != null
        ? `${d.battery_pct}%`
        : (d.battery_v != null ? `${d.battery_v.toFixed(1)}V` : (d.is_online ? 'OK' : '—'));

      metricsHtml = `
        <div class="sinope-dev-metrics">
          <div class="sinope-temp-row">
            <span class="sinope-temp-cur">${curDisplay}</span>
            <span class="sinope-temp-target">ambient</span>
          </div>
          <span class="sinope-power-val" style="font-size:13px; color:var(--text-dim)">🔋 ${battDisplay}</span>
        </div>
      `;
      dutyHtml = `
        <div class="sinope-duty-label" style="margin-top:6px">
          <span>Water Leak Detector</span>
          <span>${d.is_online ? 'Signal OK' : 'Offline'}</span>
        </div>
      `;
      if (isLeakAlert) {
        statusBadge = `<span class="sinope-badge leak-alert">🚨 LEAK DETECTED</span>`;
      } else if (!d.is_online) {
        statusBadge = `<span class="sinope-badge off">⚠️ Offline</span>`;
      } else {
        statusBadge = `<span class="sinope-badge leak-dry">✓ Dry</span>`;
      }
    } else {
      // Generic switch / load
      metricsHtml = `
        <div class="sinope-dev-metrics">
          <span class="sinope-temp-cur" style="font-size:17px">${d.is_on ? '● ON' : '○ OFF'}</span>
          <span class="sinope-power-val">${pwr} W</span>
        </div>
      `;
      dutyHtml = `
        <div class="sinope-duty-label" style="margin-top:6px">
          <span>Smart Load</span>
          <span>${d.is_on ? 'Active' : 'Standby'}</span>
        </div>
      `;
      statusBadge = d.is_on
        ? `<span class="sinope-badge on">● Active</span>`
        : `<span class="sinope-badge off">○ Standby</span>`;
    }

    if (d.dr_status && d.dr_status.toLowerCase() === 'active') {
      statusBadge += ` <span class="sinope-badge dr-peak" title="Hydro-Québec Peak Event">⚠️ DR Peak</span>`;
    }

    const devName = escapeHtml(d.name || d.device_sn);
    const devModel = escapeHtml(d.model || (d.device_type === 'thermostat' ? 'Thermostat' : 'Controller'));
    const roomBadge = (d.room_name && d.room_name.toLowerCase() !== (d.name || '').toLowerCase())
      ? ` · ${escapeHtml(d.room_name)}`
      : '';
    const locLabel = escapeHtml(d.location_name || (d.location_id ? d.location_id.toUpperCase() : ''));
    const devHours = _sinopeDevHours[d.device_sn] || 24;

    const drawerHtml = canShowHistory ? `
      <div class="sinope-dev-history-drawer" id="sinope-history-drawer-${snEsc}" ${isExpanded ? '' : 'hidden'}>
        <div class="sinope-dev-history-header">
          <div class="sinope-dev-history-title-row">
            <span class="sinope-dev-history-title">📈 ${devName} History</span>
            <div class="sinope-dev-history-stats" id="sinope-dev-stats-${snEsc}">
              <span class="sinope-chart-stat"><span class="lbl">Period Energy:</span> <b id="sinope-dev-energy-${snEsc}">—</b></span>
              <span class="sinope-chart-stat"><span class="lbl">Peak:</span> <b id="sinope-dev-peak-${snEsc}">—</b></span>
              ${d.device_type === 'thermostat' ? `<span class="sinope-chart-stat"><span class="lbl">Avg Temp:</span> <b id="sinope-dev-avgtemp-${snEsc}">—</b></span>` : ''}
            </div>
          </div>
          <div class="sinope-dev-history-controls">
            <div class="range-picker sinope-dev-range-picker" data-sn="${snEsc}">
              <button type="button" class="sinope-dev-range-btn ${devHours === 6 ? 'on' : ''}" data-sn="${snEsc}" data-hours="6">6h</button>
              <button type="button" class="sinope-dev-range-btn ${devHours === 12 ? 'on' : ''}" data-sn="${snEsc}" data-hours="12">12h</button>
              <button type="button" class="sinope-dev-range-btn ${devHours === 24 ? 'on' : ''}" data-sn="${snEsc}" data-hours="24">24h</button>
              <button type="button" class="sinope-dev-range-btn ${devHours === 168 ? 'on' : ''}" data-sn="${snEsc}" data-hours="168">7d</button>
            </div>
            <button type="button" class="btn-ghost btn-tiny sinope-dev-history-close" data-sn="${snEsc}" title="Close history">✕</button>
          </div>
        </div>
        <div class="sinope-chart-canvas-wrap">
          <canvas id="chart-sinope-dev-${snEsc}" class="chart sinope-dev-chart"></canvas>
        </div>
        <div class="legend sinope-chart-legend">
          <span class="legend-item"><i style="background:${d.device_type === 'thermostat' ? '#ff7a18' : '#38ef7d'}"></i> Power (W)</span>
          ${d.device_type === 'thermostat' ? `<span class="legend-item"><i style="background:#38bdf8; border-radius:50%"></i> Room Temp</span>` : ''}
        </div>
      </div>
    ` : '';

    return `
      <div class="${cardClass}" id="sinope-dev-card-${snEsc}">
        <div class="sinope-dev-header">
          <div>
            <div class="sinope-dev-title" title="${devName}">${devName}</div>
            <div class="sinope-dev-model">${devModel}${roomBadge}</div>
          </div>
          <div>${statusBadge}</div>
        </div>
        ${metricsHtml}
        ${dutyHtml}
        <div class="sinope-dev-footer">
          <span>${locLabel} · ${canShowHistory ? (pwr > 0 ? (pwr / 1000).toFixed(2) + ' kW' : '0 W') : (d.device_type === 'valve' ? 'Valve' : 'Sensor')}</span>
          ${canShowHistory ? `
            <button type="button" class="btn-sinope-history ${isExpanded ? 'active' : ''}" data-sn="${snEsc}" title="Toggle device history">
              ${isExpanded ? '📉 Hide History' : '📈 History'}
            </button>
          ` : ''}
        </div>
        ${drawerHtml}
      </div>
    `;
  }

  // Helper to build grouped categories of devices within a location
  function buildLocationDevicesHtml(locDevs) {
    const therms = locDevs.filter(d => d.device_type === 'thermostat');
    const ctrls = locDevs.filter(d => d.device_type === 'controller' || d.device_type === 'switch' || d.device_type === 'load');
    const water = locDevs.filter(d => d.device_type === 'valve' || d.device_type === 'leak_sensor');

    let out = '';
    if (therms.length) {
      out += `
        <div class="sinope-group-title">
          <span>🌡️ Thermostats &amp; Climate</span>
          <span class="hint">${therms.length} device${therms.length > 1 ? 's' : ''}</span>
        </div>
        <div class="sinope-loads-grid">${therms.map(buildDeviceCardHtml).join('')}</div>
      `;
    }
    if (ctrls.length) {
      out += `
        <div class="sinope-group-title">
          <span>⚡ Electrical Controllers</span>
          <span class="hint">${ctrls.length} device${ctrls.length > 1 ? 's' : ''}</span>
        </div>
        <div class="sinope-loads-grid">${ctrls.map(buildDeviceCardHtml).join('')}</div>
      `;
    }
    if (water.length) {
      out += `
        <div class="sinope-group-title">
          <span>💧 Water Protection &amp; Safety</span>
          <span class="hint">${water.length} device${water.length > 1 ? 's' : ''}</span>
        </div>
        <div class="sinope-loads-grid">${water.map(buildDeviceCardHtml).join('')}</div>
      `;
    }
    return out;
  }

  // Render grouped sections
  const visibleLocIds = [];

  if (locFilter === 'all') {
    const grouped = {};
    filtered.forEach(d => {
      const lid = (d.location_id || 'other').toLowerCase();
      if (!grouped[lid]) grouped[lid] = [];
      grouped[lid].push(d);
    });

    let fullHtml = '';
    const locationKeys = Object.keys(grouped);
    locationKeys.sort((a, b) => (a === 'maison' ? -1 : (b === 'maison' ? 1 : 0)));

    locationKeys.forEach(lid => {
      visibleLocIds.push(lid);
      const locDevs = grouped[lid];
      const locObj = locations.find(l => l.id.toLowerCase() === lid) || {};
      const locName = locObj.name || (lid.charAt(0).toUpperCase() + lid.slice(1));
      const planName = locObj.plan_id === 'hq-tarif-flex-d' ? 'Hydro-Québec Tarif Flex D' : (locObj.plan_id === 'hq-tarif-d-tdt' ? 'Hydro-Québec Tarif D TDT' : (locObj.plan_id || ''));
      const locWatts = Math.round(locDevs.reduce((sum, d) => sum + (d.power_w || 0), 0));

      fullHtml += `
        <div class="sinope-location-section">
          <div class="sinope-location-header">
            <div class="sinope-location-title">
              <span>🏠 ${escapeHtml(locName)}</span>
              ${planName ? `<span class="sinope-location-plan">${escapeHtml(planName)}</span>` : ''}
            </div>
            <span class="hint" style="font-weight:600; color:var(--text)">${locWatts.toLocaleString()} W total (${locDevs.length} devices)</span>
          </div>
          ${buildLocationChartHtml(lid, locName)}
          ${buildLocationDevicesHtml(locDevs)}
        </div>
      `;
    });
    container.innerHTML = fullHtml;
  } else {
    visibleLocIds.push(locFilter.toLowerCase());
    const locObj = locations.find(l => l.id.toLowerCase() === locFilter.toLowerCase()) || {};
    const locName = locObj.name || (locFilter.charAt(0).toUpperCase() + locFilter.slice(1));
    const planName = locObj.plan_id === 'hq-tarif-flex-d' ? 'Hydro-Québec Tarif Flex D' : (locObj.plan_id === 'hq-tarif-d-tdt' ? 'Hydro-Québec Tarif D TDT' : (locObj.plan_id || ''));
    const locWatts = Math.round(filtered.reduce((sum, d) => sum + (d.power_w || 0), 0));

    container.innerHTML = `
      <div class="sinope-location-section">
        <div class="sinope-location-header">
          <div class="sinope-location-title">
            <span>🏠 ${escapeHtml(locName)}</span>
            ${planName ? `<span class="sinope-location-plan">${escapeHtml(planName)}</span>` : ''}
          </div>
          <span class="hint" style="font-weight:600; color:var(--text)">${locWatts.toLocaleString()} W total (${filtered.length} devices)</span>
        </div>
        ${buildLocationChartHtml(locFilter.toLowerCase(), locName)}
        ${buildLocationDevicesHtml(filtered)}
      </div>
    `;
  }

  // Bind location range buttons
  container.querySelectorAll('.sinope-loc-range-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const lid = btn.dataset.loc;
      const hours = parseInt(btn.dataset.hours, 10);
      _sinopeLocHours[lid] = hours;
      container.querySelectorAll(`.sinope-loc-range-btn[data-loc="${lid}"]`).forEach(b => {
        b.classList.toggle('on', parseInt(b.dataset.hours, 10) === hours);
      });
      loadAndDrawLocationChart(lid, true);
    });
  });

  // Bind device history toggle buttons
  container.querySelectorAll('.btn-sinope-history').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const sn = btn.dataset.sn;
      if (_sinopeOpenDeviceHistories.has(sn)) {
        _sinopeOpenDeviceHistories.delete(sn);
      } else {
        _sinopeOpenDeviceHistories.add(sn);
      }
      renderSinopeTab();
    });
  });

  // Bind device history range buttons
  container.querySelectorAll('.sinope-dev-range-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const sn = btn.dataset.sn;
      const hours = parseInt(btn.dataset.hours, 10);
      _sinopeDevHours[sn] = hours;
      container.querySelectorAll(`.sinope-dev-range-btn[data-sn="${sn}"]`).forEach(b => {
        b.classList.toggle('on', parseInt(b.dataset.hours, 10) === hours);
      });
      loadAndDrawDeviceChart(sn, true);
    });
  });

  // Bind device history close buttons
  container.querySelectorAll('.sinope-dev-history-close').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const sn = btn.dataset.sn;
      _sinopeOpenDeviceHistories.delete(sn);
      renderSinopeTab();
    });
  });

  // Trigger loading & drawing for all visible location charts
  visibleLocIds.forEach(lid => {
    requestAnimationFrame(() => loadAndDrawLocationChart(lid));
  });

  // Trigger loading & drawing for any open device charts
  _sinopeOpenDeviceHistories.forEach(sn => {
    requestAnimationFrame(() => loadAndDrawDeviceChart(sn));
  });
}

async function loadSinopeCreds() {
  const status = $('sinope-creds-status');
  const emailIn = $('sinope-email');
  if (!status) return;
  try {
    const r = await fetch('/api/sinope/credentials');
    const j = await r.json();
    if (j.saved) {
      status.textContent = `saved · ${j.email || ''}`;
      if (emailIn && !emailIn.value) emailIn.value = j.email || '';
    } else {
      status.textContent = 'not set';
    }
  } catch (e) {
    status.textContent = 'failed to load';
  }
}

function initSinopeSettings() {
  loadSinopeCreds();

  $('sinope-creds-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = ($('sinope-email')?.value || '').trim();
    const password = $('sinope-password')?.value || '';
    const msg = $('sinope-msg');
    if (!email || !password) return;
    if (msg) { msg.hidden = false; msg.textContent = 'Verifying credentials with Neviweb…'; }
    try {
      const r = await fetch('/api/sinope/credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const j = await r.json();
      if (r.ok && j.ok) {
        if (msg) {
          msg.textContent = '✓ Saved successfully! Polling devices…';
          setTimeout(() => { msg.hidden = true; }, 4000);
        }
        loadSinopeCreds();
      } else {
        if (msg) msg.textContent = `Error: ${j.detail || j.error || 'Authentication rejected'}`;
      }
    } catch (err) {
      if (msg) msg.textContent = `Network error: ${err.message}`;
    }
  });

  $('sinope-clear-btn')?.addEventListener('click', async () => {
    if (!confirm('Forget saved Sinopé credentials?')) return;
    try {
      await fetch('/api/sinope/credentials', { method: 'DELETE' });
      const emailEl = $('sinope-email');
      const passEl = $('sinope-password');
      if (emailEl) emailEl.value = '';
      if (passEl) passEl.value = '';
      const msg = $('sinope-msg');
      if (msg) { msg.hidden = false; msg.textContent = 'Credentials cleared.'; setTimeout(() => { msg.hidden = true; }, 3000); }
      loadSinopeCreds();
    } catch (e) {}
  });

  $('sinope-poll-btn')?.addEventListener('click', async () => {
    const btn = $('sinope-poll-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Polling…'; }
    try {
      const r = await fetch('/api/sinope/poll', { method: 'POST' });
      const j = await r.json();
      if (j.devices) {
        renderSinopeLoads(j.devices);
      }
    } catch (e) {}
    finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Poll now'; }
    }
  });
}


// ============================================================
// DAIKIN ONE SMART THERMOSTAT & HEAT PUMP TAB
// ============================================================
let _daikinSelectedLocation = localStorage.getItem('daikin_selected_location') || 'all';
let lastDaikinDevices = [];
let _lastDaikinPollTs = null;
const _daikinDevHours = {};
const _daikinOpenDeviceHistories = new Set();
const _daikinDevHistData = {};
let _daikinResizeBound = false;
let _daikinLastRenderedSignature = '';
let _daikinAirCleanTimerInterval = null;

function formatAirCleanRemaining(sec) {
  if (sec == null || sec <= 0) return '0m';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function initDaikinTab() {
  if (!_daikinAirCleanTimerInterval) {
    _daikinAirCleanTimerInterval = setInterval(() => {
      if (activeTab !== 'daikin') return;
      document.querySelectorAll('.daikin-airclean-timer-text').forEach(el => {
        const exp = parseFloat(el.dataset.expires);
        if (!exp) return;
        const rem = Math.max(0, Math.round(exp - Date.now() / 1000));
        el.textContent = formatAirCleanRemaining(rem);
      });
    }, 5000);
  }

  document.querySelectorAll('.daikin-loc-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      _daikinSelectedLocation = pill.dataset.loc || 'all';
      localStorage.setItem('daikin_selected_location', _daikinSelectedLocation);
      document.querySelectorAll('.daikin-loc-pill').forEach(p => {
        p.classList.toggle('on', p.dataset.loc === _daikinSelectedLocation);
      });
      renderDaikinTab(true);
    });
  });

  $('daikin-tab-poll-btn')?.addEventListener('click', async () => {
    const btn = $('daikin-tab-poll-btn');
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner" style="display:inline-block;width:12px;height:12px;border:2px solid currentColor;border-top-color:transparent;border-radius:50%;animation:spin .8s linear infinite;"></span> Polling…';
    }
    try {
      const r = await fetch('/api/daikin/poll', { method: 'POST' });
      const j = await r.json();
      if (j.devices) {
        lastDaikinDevices = j.devices;
        if (lastStatus) lastStatus.daikin_devices = j.devices;
        _lastDaikinPollTs = Date.now();
      }
    } catch (e) {
      console.warn('Manual Daikin poll error:', e);
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = '<span class="poll-icon">🔄</span> Poll now';
      }
      renderDaikinTab(true);
    }
  });

  if (!_daikinResizeBound) {
    _daikinResizeBound = true;
    window.addEventListener('resize', () => {
      if (activeTab === 'daikin') {
        _daikinOpenDeviceHistories.forEach(id => {
          const canvas = $('chart-daikin-dev-' + id);
          if (canvas && canvas._redraw) canvas._redraw();
        });
      }
    });
  }
}

function drawDaikinDeviceChart(devId, hist, hours) {
  const canvas = $('chart-daikin-dev-' + devId);
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  if (rect.width <= 10) return;

  const { ctx, w, h } = setCanvasSize(canvas);
  ctx.clearRect(0, 0, w, h);

  const padL = 46, padR = 24, padT = 16, padB = 26;

  if (!hist || !hist.length) {
    drawAxes(ctx, w, h, padL, padR, padT, padB);
    ctx.fillStyle = '#6b7280';
    ctx.font = '12px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Accumulating Daikin temperature history…', w / 2, h / 2);
    return;
  }

  let plotHist = hist;
  if (hist.length === 1) {
    const single = hist[0];
    plotHist = [{ ...single, ts: single.ts - 300 }, single];
  }

  const isF = getTempUnit() === 'F';
  const indoorTemps = plotHist.map(r => (r.temp_c != null ? (isF ? r.temp_c * 9/5 + 32 : r.temp_c) : null));
  const outdoorTemps = plotHist.map(r => (r.outdoor_temp_c != null ? (isF ? r.outdoor_temp_c * 9/5 + 32 : r.outdoor_temp_c) : null));

  const allTemps = [...indoorTemps, ...outdoorTemps].filter(t => t != null && Number.isFinite(t));
  let minT = 15, maxT = 25;
  if (allTemps.length > 0) {
    minT = Math.floor(Math.min(...allTemps) - 1);
    maxT = Math.ceil(Math.max(...allTemps) + 1);
    if (maxT - minT < 4) maxT = minT + 4;
  }

  const xs = (i) => padL + (i / Math.max(1, plotHist.length - 1)) * (w - padL - padR);
  const yTemp = (t) => (h - padB) - ((t - minT) / (maxT - minT)) * (h - padT - padB);
  const baseY = h - padB;

  // Gridlines & Axes
  ctx.strokeStyle = 'rgba(35,42,51,.7)';
  ctx.lineWidth = 1;
  for (let i = 1; i <= 3; i++) {
    const y = padT + ((h - padT - padB) * i) / 4;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
  }
  drawAxes(ctx, w, h, padL, padR, padT, padB);

  // Left Y-axis labels for temperature
  ctx.fillStyle = '#6b7280'; ctx.font = '10px Inter, sans-serif';
  ctx.textAlign = 'right';
  for (let i = 0; i <= 3; i++) {
    const v = minT + ((maxT - minT) * (3 - i)) / 3;
    const y = padT + ((h - padT - padB) * i) / 3;
    ctx.fillText(`${Math.round(v)}°`, padL - 5, y + 3);
  }

  // X-axis time ticks
  if (plotHist.length >= 2) {
    const first = plotHist[0].ts || 0, last = plotHist[plotHist.length - 1].ts || 0;
    const spanH = (last - first) / 3600;
    ctx.fillStyle = '#6b7280';
    ctx.textAlign = 'center';
    const ticks = Math.min(4, plotHist.length - 1);
    for (let i = 0; i <= ticks; i++) {
      const idx = Math.round((plotHist.length - 1) * (i / ticks));
      const ts = plotHist[idx].ts || (first + (last - first) * (i / ticks));
      const d = new Date(ts * 1000);
      const str = (spanH > 24)
        ? (d.toLocaleDateString([], { month: 'numeric', day: 'numeric' }) + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))
        : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      ctx.fillText(str, xs(idx), h - 7);
    }
    ctx.textAlign = 'start';
  }

  // Traces: Outdoor (Sky blue line) & Indoor (Warm amber area & line)
  const hasOutdoor = outdoorTemps.some(t => t != null && Number.isFinite(t));
  if (hasOutdoor) {
    drawSmoothLine(ctx, outdoorTemps, xs, yTemp, '#38bdf8', 1.8);
  }

  const hasIndoor = indoorTemps.some(t => t != null && Number.isFinite(t));
  if (hasIndoor) {
    drawAreaFill(ctx, indoorTemps, xs, yTemp, baseY, '#f97316', 0.15);
    drawSmoothLine(ctx, indoorTemps, xs, yTemp, '#f97316', 2.2);
  }

  canvas._redraw = () => drawDaikinDeviceChart(devId, hist, hours);

  const eqNames = { 0: 'Idle', 1: 'Cooling', 2: 'Overcooling', 3: 'Heating', 4: 'Fan Circulate', 5: 'Defrost' };

  _attachChartHover(canvas, plotHist, (idx) => {
    const p = plotHist[idx];
    if (!p) return '';
    const d = new Date(p.ts * 1000);
    const tsStr = d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }) + ' ' +
                  d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const inT = p.temp_c != null ? formatTemp(p.temp_c, 1) : '—';
    const outT = p.outdoor_temp_c != null ? formatTemp(p.outdoor_temp_c, 1) : '—';
    const eqSt = p.equipment_status != null ? (eqNames[p.equipment_status] || 'Unknown') : 'Idle';

    let rows = `
      <div class="cht-ts">${escapeHtml(tsStr)}</div>
      <div class="cht-row"><i style="background:#f97316; border-radius:50%"></i> Indoor: <b>${inT}</b></div>
      <div class="cht-row"><i style="background:#38bdf8; border-radius:50%"></i> Outdoor: <b>${outT}</b></div>
      <div class="cht-row"><i style="background:#a855f7"></i> Equipment: <b>${escapeHtml(eqSt)}</b></div>
    `;
    if (p.power_w) {
      rows += `<div class="cht-row"><i style="background:#4ade80"></i> Power est.: <b>${Math.round(p.power_w)} W</b></div>`;
    }
    return rows;
  }, () => ({ xs, padL, padR, w, h, baseY, padT, padB }));
}

async function loadAndDrawDaikinDeviceChart(devId, force = false) {
  const hours = _daikinDevHours[devId] || 24;
  const cacheKey = `${devId}_${hours}`;
  const now = Date.now();
  let hist = null;

  if (!force && _daikinDevHistData[cacheKey] && (now - _daikinDevHistData[cacheKey].ts < 45000)) {
    hist = _daikinDevHistData[cacheKey].data;
  } else {
    try {
      const r = await fetch(`/api/daikin/history/device?device_sn=daikin_${encodeURIComponent(devId)}&hours=${hours}`);
      if (r.ok) {
        const j = await r.json();
        hist = j.history || [];
        _daikinDevHistData[cacheKey] = { ts: now, data: hist };
      }
    } catch (e) {
      console.warn('Failed to load Daikin device history:', e);
    }
  }

  if (hist) {
    drawDaikinDeviceChart(devId, hist, hours);
  }
}

function renderDaikinTab(force = false) {
  const container = $('daikin-devices-container');
  if (!container) return;

  const devices = (lastStatus && lastStatus.daikin_devices) || lastDaikinDevices || [];

  // Update Location pill active classes
  document.querySelectorAll('.daikin-loc-pill').forEach(p => {
    p.classList.toggle('on', p.dataset.loc === _daikinSelectedLocation);
  });

  // Update Last poll time
  const pollTimeEl = $('daikin-last-poll-time');
  if (pollTimeEl) {
    if (_lastDaikinPollTs) {
      const elapsedM = Math.max(0, Math.round((Date.now() - _lastDaikinPollTs) / 60000));
      pollTimeEl.textContent = elapsedM === 0 ? 'Last update: just now' : `Last update: ${elapsedM}m ago`;
    } else if (devices.length) {
      pollTimeEl.textContent = 'Last update: active';
    } else {
      pollTimeEl.textContent = 'Last update: —';
    }
  }

  // Filter devices based on chosen location
  const locFilter = _daikinSelectedLocation;
  const filtered = (locFilter === 'all')
    ? devices
    : devices.filter(d => (d.location_id || '').toLowerCase() === locFilter.toLowerCase());

  // Update KPI card DOM
  const isF = getTempUnit() === 'F';
  document.querySelectorAll('#tab-daikin .temp-unit-label').forEach(el => {
    el.textContent = '°' + getTempUnit();
  });

  const indoorTemps = filtered.map(d => d.temp_indoor_c).filter(t => t != null && Number.isFinite(t));
  const outdoorTemps = filtered.map(d => d.temp_outdoor_c).filter(t => t != null && Number.isFinite(t));
  const indoorHums = filtered.map(d => d.hum_indoor).filter(h => h != null && Number.isFinite(h));
  const outdoorHums = filtered.map(d => d.hum_outdoor).filter(h => h != null && Number.isFinite(h));

  const kpiInTemp = $('daikin-kpi-indoor-temp');
  const kpiInSub = $('daikin-kpi-indoor-sub');
  if (kpiInTemp) {
    if (indoorTemps.length) {
      const avg = indoorTemps.reduce((a, b) => a + b, 0) / indoorTemps.length;
      kpiInTemp.textContent = isF ? (avg * 9/5 + 32).toFixed(1) : avg.toFixed(1);
      if (kpiInSub) kpiInSub.textContent = `Across ${indoorTemps.length} thermostat${indoorTemps.length > 1 ? 's' : ''}`;
    } else {
      kpiInTemp.textContent = '—';
      if (kpiInSub) kpiInSub.textContent = 'Living space';
    }
  }

  const kpiOutTemp = $('daikin-kpi-outdoor-temp');
  const kpiOutSub = $('daikin-kpi-outdoor-sub');
  if (kpiOutTemp) {
    if (outdoorTemps.length) {
      const avg = outdoorTemps.reduce((a, b) => a + b, 0) / outdoorTemps.length;
      kpiOutTemp.textContent = isF ? (avg * 9/5 + 32).toFixed(1) : avg.toFixed(1);
      if (kpiOutSub) kpiOutSub.textContent = 'Heat pump sensor';
    } else {
      kpiOutTemp.textContent = '—';
      if (kpiOutSub) kpiOutSub.textContent = 'Heat pump sensor';
    }
  }

  const kpiHum = $('daikin-kpi-humidity');
  const kpiHumSub = $('daikin-kpi-humidity-sub');
  if (kpiHum) {
    if (indoorHums.length || outdoorHums.length) {
      const inStr = indoorHums.length ? `${Math.round(indoorHums[0])}%` : '—';
      const outStr = outdoorHums.length ? `${Math.round(outdoorHums[0])}%` : '—';
      kpiHum.textContent = `${inStr} / ${outStr}`;
      if (kpiHumSub) kpiHumSub.textContent = 'Indoor / Outdoor';
    } else {
      kpiHum.textContent = '—';
    }
  }

  // Equipment Status KPI
  const kpiEquip = $('daikin-kpi-equip-status');
  const kpiEquipSub = $('daikin-kpi-equip-sub');
  if (kpiEquip) {
    const isHeating = filtered.some(d => d.equipment_status === 3);
    const isCooling = filtered.some(d => d.equipment_status === 1 || d.equipment_status === 2);
    const isFan = filtered.some(d => d.equipment_status === 4);
    const isOff = filtered.every(d => d.mode === 0);

    if (isHeating) {
      kpiEquip.textContent = '🔥 Heating';
      if (kpiEquipSub) kpiEquipSub.textContent = 'Heat pump compressor active';
    } else if (isCooling) {
      kpiEquip.textContent = '❄️ Cooling';
      if (kpiEquipSub) kpiEquipSub.textContent = 'Heat pump cooling cycle';
    } else if (isFan) {
      kpiEquip.textContent = '🔄 Fan';
      if (kpiEquipSub) kpiEquipSub.textContent = 'Circulating indoor air';
    } else if (isOff) {
      kpiEquip.textContent = '○ Standby';
      if (kpiEquipSub) kpiEquipSub.textContent = 'HVAC mode off';
    } else {
      kpiEquip.textContent = '○ Idle';
      if (kpiEquipSub) kpiEquipSub.textContent = 'Setpoints satisfied';
    }
  }

  // System Mode KPI
  const kpiMode = $('daikin-kpi-mode');
  const kpiModeSub = $('daikin-kpi-mode-sub');
  if (kpiMode) {
    if (filtered.length) {
      const first = filtered[0];
      const mDesc = (first.mode_desc || 'Auto');
      kpiMode.textContent = mDesc.charAt(0).toUpperCase() + mDesc.slice(1);
      const setpoints = [];
      if (first.mode === 1 && first.heat_setpoint_c != null) {
        setpoints.push(`Heat: ${formatTemp(first.heat_setpoint_c, 1)}`);
      } else if (first.mode === 2 && first.cool_setpoint_c != null) {
        setpoints.push(`Cool: ${formatTemp(first.cool_setpoint_c, 1)}`);
      } else if (first.mode === 3) {
        if (first.heat_setpoint_c != null) setpoints.push(`H: ${formatTemp(first.heat_setpoint_c, 1)}`);
        if (first.cool_setpoint_c != null) setpoints.push(`C: ${formatTemp(first.cool_setpoint_c, 1)}`);
      }
      if (kpiModeSub) kpiModeSub.textContent = setpoints.length ? setpoints.join(' · ') : 'Target setpoints';
    } else {
      kpiMode.textContent = '—';
      if (kpiModeSub) kpiModeSub.textContent = 'Target setpoints';
    }
  }

  // Compute signature of current view state to avoid wiping DOM if unchanged
  const sig = JSON.stringify({
    loc: _daikinSelectedLocation,
    unit: isF,
    hist: Array.from(_daikinOpenDeviceHistories).sort(),
    devHours: _daikinDevHours,
    devs: filtered.map(d => ({
      id: d.id,
      name: d.name,
      mode: d.mode,
      eq: d.equipment_status,
      inT: d.temp_indoor_c,
      outT: d.temp_outdoor_c,
      hIn: d.hum_indoor,
      hOut: d.hum_outdoor,
      hSp: d.heat_setpoint_c,
      cSp: d.cool_setpoint_c,
      fan: d.fan,
      fanCirc: d.fan_circulate,
      fanSpd: d.fan_circulate_speed,
      circRt: d.fan_circulate_runtime_1h_min,
      totRt: d.fan_total_runtime_1h_min,
      sched: d.schedule_enabled,
      online: d.is_online,
      airClean: d.air_clean ? d.air_clean.active : false,
      airCleanM: d.air_clean && d.air_clean.remaining_s ? Math.floor(d.air_clean.remaining_s / 60) : 0,
    })),
  });

  const isInteracting = container.contains(document.activeElement);

  // If nothing changed in the device list and not forced, DO NOT rebuild cards!
  if (!force && sig === _daikinLastRenderedSignature) {
    return;
  }

  // If user is currently interacting with an element (e.g. an open select dropdown),
  // defer re-rendering so we don't blow away their open dropdown!
  if (!force && isInteracting) {
    return;
  }

  _daikinLastRenderedSignature = sig;

  // Render Cards or Empty State
  if (!devices.length) {
    container.innerHTML = `
      <div class="daikin-empty-card">
        <div style="font-size:36px; margin-bottom:4px">❄️🔥</div>
        <h3>No Daikin Thermostats Found</h3>
        <p>Connect your Daikin One account in <strong>Settings &rarr; Integrations &rarr; Daikin One account</strong> with your Integrator Token and API Key to monitor and control your heat pump.</p>
        <button class="btn btn-primary" onclick="switchTab('settings'); selectSettingsSubtab('integrations'); document.getElementById('settings-card-daikin')?.classList.remove('collapsed'); document.getElementById('settings-card-daikin')?.scrollIntoView({behavior:'smooth'});">Go to Settings</button>
      </div>
    `;
    return;
  }

  if (!filtered.length) {
    container.innerHTML = `
      <div class="daikin-empty-card">
        <h3>No Thermostats at this Location</h3>
        <p>No Daikin devices found for the <strong>${escapeHtml(locFilter)}</strong> location filter.</p>
      </div>
    `;
    return;
  }

  let cardsHtml = '<div class="daikin-thermostats-grid">';

  filtered.forEach(dev => {
    const isHeating = dev.equipment_status === 3;
    const isCooling = dev.equipment_status === 1 || dev.equipment_status === 2;
    const isFan = dev.equipment_status === 4;
    const isOff = dev.mode === 0;

    let cardBorderClass = '';
    if (isHeating) cardBorderClass = 'is-heating';
    else if (isCooling) cardBorderClass = 'is-cooling';

    let badgeClass = 'idle';
    let badgeIcon = '○';
    let badgeText = dev.equipment_status_desc || 'Idle';
    if (!dev.is_online) {
      badgeClass = 'off';
      badgeIcon = '⚠️';
      badgeText = 'Offline';
    } else if (isHeating) {
      badgeClass = 'heating';
      badgeIcon = '🔥';
      badgeText = 'Heating';
    } else if (isCooling) {
      badgeClass = 'cooling';
      badgeIcon = '❄️';
      badgeText = 'Cooling';
    } else if (isFan) {
      badgeClass = 'fan';
      badgeIcon = '🔄';
      badgeText = 'Fan';
    } else if (isOff) {
      badgeClass = 'off';
      badgeIcon = '○';
      badgeText = 'Off';
    }

    const indoorTempDisplay = dev.temp_indoor_c != null ? formatTemp(dev.temp_indoor_c, 1) : '—';
    const outdoorTempDisplay = dev.temp_outdoor_c != null ? formatTemp(dev.temp_outdoor_c, 1) : '—';

    let targetSub = '';
    if (dev.mode === 1 && dev.heat_setpoint_c != null) {
      targetSub = `Target: ${formatTemp(dev.heat_setpoint_c, 1)}`;
    } else if (dev.mode === 2 && dev.cool_setpoint_c != null) {
      targetSub = `Target: ${formatTemp(dev.cool_setpoint_c, 1)}`;
    } else if (dev.mode === 3) {
      targetSub = `Auto: ${formatTemp(dev.heat_setpoint_c, 1)} – ${formatTemp(dev.cool_setpoint_c, 1)}`;
    }

    // Setpoints Controls HTML
    const minSp = dev.setpoint_min != null ? dev.setpoint_min : 10.0;
    const maxSp = dev.setpoint_max != null ? dev.setpoint_max : 32.0;
    const minDisplay = formatTemp(minSp, 0);
    const maxDisplay = formatTemp(maxSp, 0);
    const heatDisplay = dev.heat_setpoint_c != null ? formatTemp(dev.heat_setpoint_c, 1) : '—';
    const coolDisplay = dev.cool_setpoint_c != null ? formatTemp(dev.cool_setpoint_c, 1) : '—';
    const deltaDisplay = dev.setpoint_delta != null ? `${dev.setpoint_delta}°C` : '2°C';

    let setpointsHtml = '';
    if (dev.mode === 1 || dev.mode === 4) {
      // Heat / Emergency Heat mode
      setpointsHtml = `
        <div class="daikin-setpoint-row">
          <div style="display:flex; flex-direction:column">
            <span style="font-size:13px; font-weight:600; color:#fb923c">🔥 Heating Target</span>
            <span class="hint" style="font-size:11px">Range: ${minDisplay} – ${maxDisplay}</span>
          </div>
          <div class="daikin-sp-controls">
            <button type="button" class="daikin-btn-step" data-dev="${dev.id}" data-type="heat" data-delta="-0.5" title="Decrease temperature">−</button>
            <span class="daikin-sp-val" id="daikin-sp-val-heat-${dev.id}">${heatDisplay}</span>
            <button type="button" class="daikin-btn-step" data-dev="${dev.id}" data-type="heat" data-delta="0.5" title="Increase temperature">+</button>
          </div>
        </div>
      `;
    } else if (dev.mode === 2) {
      // Cool mode
      setpointsHtml = `
        <div class="daikin-setpoint-row">
          <div style="display:flex; flex-direction:column">
            <span style="font-size:13px; font-weight:600; color:#38bdf8">❄️ Cooling Target</span>
            <span class="hint" style="font-size:11px">Range: ${minDisplay} – ${maxDisplay}</span>
          </div>
          <div class="daikin-sp-controls">
            <button type="button" class="daikin-btn-step" data-dev="${dev.id}" data-type="cool" data-delta="-0.5" title="Decrease temperature">−</button>
            <span class="daikin-sp-val" id="daikin-sp-val-cool-${dev.id}">${coolDisplay}</span>
            <button type="button" class="daikin-btn-step" data-dev="${dev.id}" data-type="cool" data-delta="0.5" title="Increase temperature">+</button>
          </div>
        </div>
      `;
    } else if (dev.mode === 3) {
      // Auto mode (Dual Setpoints)
      setpointsHtml = `
        <div class="daikin-setpoint-row" style="margin-bottom:6px">
          <div style="display:flex; flex-direction:column">
            <span style="font-size:13px; font-weight:600; color:#fb923c">🔥 Heat Setpoint</span>
            <span class="hint" style="font-size:11px">Auto mode (${deltaDisplay} deadband)</span>
          </div>
          <div class="daikin-sp-controls">
            <button type="button" class="daikin-btn-step" data-dev="${dev.id}" data-type="heat" data-delta="-0.5" title="Decrease heating target">−</button>
            <span class="daikin-sp-val">${heatDisplay}</span>
            <button type="button" class="daikin-btn-step" data-dev="${dev.id}" data-type="heat" data-delta="0.5" title="Increase heating target">+</button>
          </div>
        </div>
        <div class="daikin-setpoint-row">
          <div style="display:flex; flex-direction:column">
            <span style="font-size:13px; font-weight:600; color:#38bdf8">❄️ Cool Setpoint</span>
            <span class="hint" style="font-size:11px">Auto mode (${deltaDisplay} deadband)</span>
          </div>
          <div class="daikin-sp-controls">
            <button type="button" class="daikin-btn-step" data-dev="${dev.id}" data-type="cool" data-delta="-0.5" title="Decrease cooling target">−</button>
            <span class="daikin-sp-val">${coolDisplay}</span>
            <button type="button" class="daikin-btn-step" data-dev="${dev.id}" data-type="cool" data-delta="0.5" title="Increase cooling target">+</button>
          </div>
        </div>
      `;
    } else {
      // Off mode
      setpointsHtml = `
        <div style="text-align:center; padding:8px 0;">
          <span class="hint" style="font-size:12px">Thermostat mode is Off. Select Heat, Cool, or Auto above to adjust setpoints.</span>
        </div>
      `;
    }

    const isHistOpen = _daikinOpenDeviceHistories.has(dev.id);
    const histHours = _daikinDevHours[dev.id] || 24;

    const speedLabels = ['Low', 'Medium', 'High'];
    const curSpeedLabel = speedLabels[dev.fan_circulate_speed || 0] || 'Low';
    const circRuntime = dev.fan_circulate_runtime_1h_min != null ? dev.fan_circulate_runtime_1h_min : (dev.equipment_status === 4 ? 60 : 0);
    const totalRuntime = dev.fan_total_runtime_1h_min != null ? dev.fan_total_runtime_1h_min : circRuntime;

    const isAirCleanActive = Boolean(dev.air_clean && dev.air_clean.active);
    let airCleanBannerHtml = '';
    if (isAirCleanActive) {
      const remSec = dev.air_clean.remaining_s != null ? dev.air_clean.remaining_s : 0;
      const prevCircIdx = dev.air_clean.previous_fan_circulate != null ? dev.air_clean.previous_fan_circulate : 0;
      const prevSpeedIdx = dev.air_clean.previous_fan_circulate_speed != null ? dev.air_clean.previous_fan_circulate_speed : 0;
      const prevCircName = ['Auto', 'Always On', 'Fan Schedule'][prevCircIdx] || 'Auto';
      const prevSpeedName = speedLabels[prevSpeedIdx] || 'Low';
      const prevDesc = `${prevCircName} (${prevSpeedName})`;

      airCleanBannerHtml = `
        <div class="daikin-airclean-banner" id="daikin-airclean-banner-${dev.id}">
          <div class="daikin-airclean-banner-left">
            <span class="daikin-airclean-pulse-icon">🫧</span>
            <div>
              <div class="daikin-airclean-banner-title">Air Clean Active (Medium Fan)</div>
              <div class="daikin-airclean-banner-sub">
                ⏱️ <strong class="daikin-airclean-timer-text" data-dev="${dev.id}" data-expires="${dev.air_clean.expires_at || 0}">${formatAirCleanRemaining(remSec)}</strong> remaining &bull; Restores ${prevDesc}
              </div>
            </div>
          </div>
          <button type="button" class="daikin-airclean-cancel-btn" data-dev="${dev.id}" title="Cancel Air Clean and restore previous settings">Cancel</button>
        </div>
      `;
    }

    let fanSchedHtml = '';
    if (dev.fan_circulate === 2) {
      fanSchedHtml = `
        <div class="daikin-fan-sched-box">
          <div class="daikin-fan-sched-header">
            <span class="daikin-fan-sched-title">🔄 Fan Schedule Active</span>
            <span class="daikin-fan-runtime-badge">⏱️ ${circRuntime} min / hr active</span>
          </div>
          <div class="daikin-fan-sched-desc">
            Circulating air at <strong>${curSpeedLabel}</strong> speed. Thermostat automatically cycles the fan on schedule.
          </div>
          <div class="daikin-fan-sched-hint">
            💡 <em>Hourly circulation interval (5, 15, 30, or 45 min/hr) is configured on your Daikin One thermostat under Menu &rarr; Settings &rarr; Circulate Air.</em>
          </div>
        </div>
      `;
    } else if (dev.fan_circulate === 1) {
      fanSchedHtml = `
        <div class="daikin-fan-sched-box always-on">
          <div class="daikin-fan-sched-header">
            <span class="daikin-fan-sched-title">💨 Always On (Continuous Circulation)</span>
            <span class="daikin-fan-runtime-badge">⏱️ ${totalRuntime} min / hr active</span>
          </div>
          <div class="daikin-fan-sched-desc">
            Blower fan runs 24/7 at <strong>${curSpeedLabel}</strong> speed for whole-home continuous air circulation and filtration.
          </div>
        </div>
      `;
    } else {
      fanSchedHtml = `
        <div class="daikin-fan-sched-box auto">
          <div class="daikin-fan-sched-header">
            <span class="daikin-fan-sched-title">○ Auto Fan Mode</span>
            <span class="daikin-fan-runtime-badge">⏱️ ${totalRuntime} min / hr active</span>
          </div>
          <div class="daikin-fan-sched-desc">
            Blower fan only runs when heating or cooling demands are active.
          </div>
        </div>
      `;
    }

    cardsHtml += `
      <div class="daikin-card ${cardBorderClass}" id="daikin-card-${dev.id}">
        <!-- Card Header -->
        <div class="daikin-card-header">
          <div>
            <div class="daikin-card-title">
              <span>🌡️ ${escapeHtml(dev.name)}</span>
            </div>
            <div class="daikin-card-meta">
              <span>📍 ${escapeHtml(dev.location_name || dev.location_id)}</span>
              <span>·</span>
              <span>${escapeHtml(dev.model || 'Daikin One')}</span>
              ${dev.firmware_version ? `<span>· fw ${escapeHtml(dev.firmware_version)}</span>` : ''}
            </div>
          </div>
          <span class="daikin-badge ${badgeClass}">${badgeIcon} ${escapeHtml(badgeText)}</span>
        </div>

        <!-- Climate Hero Display -->
        <div class="daikin-display-hero">
          <div class="daikin-indoor-temp-block">
            <div class="daikin-indoor-temp-val">${indoorTempDisplay}</div>
            <div class="daikin-indoor-sub">
              <span>💧 ${dev.hum_indoor != null ? Math.round(dev.hum_indoor) + '% humidity' : 'Indoor'}</span>
              ${targetSub ? `<span>·</span><span>🎯 ${targetSub}</span>` : ''}
            </div>
          </div>
          ${dev.temp_outdoor_c != null ? `
            <div class="daikin-outdoor-widget">
              <span class="daikin-outdoor-label">Outdoor Heat Pump Sensor</span>
              <div class="daikin-outdoor-chip">
                <span>❄️ ${outdoorTempDisplay}</span>
                ${dev.hum_outdoor != null ? `<span style="font-size:11px; opacity:0.8">· 💧 ${Math.round(dev.hum_outdoor)}%</span>` : ''}
              </div>
            </div>
          ` : ''}
        </div>

        <!-- Mode Selector Buttons -->
        <div class="daikin-mode-group">
          <button type="button" class="daikin-mode-btn mode-off ${dev.mode === 0 ? 'on' : ''}" data-dev="${dev.id}" data-mode="0">○ Off</button>
          <button type="button" class="daikin-mode-btn mode-heat ${dev.mode === 1 ? 'on' : ''}" data-dev="${dev.id}" data-mode="1">🔥 Heat</button>
          <button type="button" class="daikin-mode-btn mode-cool ${dev.mode === 2 ? 'on' : ''}" data-dev="${dev.id}" data-mode="2">❄️ Cool</button>
          <button type="button" class="daikin-mode-btn mode-auto ${dev.mode === 3 ? 'on' : ''}" data-dev="${dev.id}" data-mode="3">⚡ Auto</button>
          ${dev.mode_em_heat_available ? `
            <button type="button" class="daikin-mode-btn mode-emheat ${dev.mode === 4 ? 'on' : ''}" data-dev="${dev.id}" data-mode="4">🚨 Aux Heat</button>
          ` : ''}
        </div>

        <!-- Setpoints Card -->
        <div class="daikin-setpoint-card">
          ${setpointsHtml}
        </div>

        <!-- Secondary Controls (Fan, Schedule) -->
        <div class="daikin-secondary-controls">
          <div class="daikin-ctrl-item">
            <span class="daikin-ctrl-label">Fan:</span>
            <select class="daikin-select daikin-fan-mode-select ${dev.fan_circulate > 0 ? 'on' : ''}" data-dev="${dev.id}" title="Fan Circulation Mode">
              <option value="0" ${dev.fan_circulate === 0 ? 'selected' : ''}>Auto</option>
              <option value="1" ${dev.fan_circulate === 1 ? 'selected' : ''}>Always On</option>
              <option value="2" ${dev.fan_circulate === 2 ? 'selected' : ''}>Fan Schedule</option>
            </select>
            <select class="daikin-select daikin-fan-speed-select" data-dev="${dev.id}" title="Fan Circulation Speed">
              <option value="0" ${dev.fan_circulate_speed === 0 ? 'selected' : ''}>Speed: Low</option>
              <option value="1" ${dev.fan_circulate_speed === 1 ? 'selected' : ''}>Speed: Med</option>
              <option value="2" ${dev.fan_circulate_speed === 2 ? 'selected' : ''}>Speed: High</option>
            </select>
          </div>

          <div class="daikin-ctrl-item">
            <span class="daikin-ctrl-label">Schedule:</span>
            <button type="button" class="daikin-btn-subtle daikin-sched-btn ${dev.schedule_enabled ? 'on' : ''}" data-dev="${dev.id}" title="Follow Programmed Schedule">
              ${dev.schedule_enabled ? '📅 Following' : '⏸️ Hold'}
            </button>
          </div>

          <div class="daikin-ctrl-item">
            <button type="button" class="daikin-btn-subtle daikin-airclean-btn ${isAirCleanActive ? 'on' : ''}" data-dev="${dev.id}" title="${isAirCleanActive ? 'Air Clean is running (Medium fan for 3h)' : 'Start Air Clean: continuous Medium fan for 3 hours, then restore previous settings'}">
              🫧 Air Clean${isAirCleanActive ? ' (Active)' : ''}
            </button>
          </div>

          <button type="button" class="daikin-btn-subtle daikin-hist-toggle-btn" data-dev="${dev.id}">
            📊 ${isHistOpen ? 'Hide History' : 'History'}
          </button>
        </div>

        <!-- Air Clean Active Banner -->
        ${airCleanBannerHtml}

        <!-- Fan Schedule & Hourly Circulation Details -->
        ${fanSchedHtml}

        <!-- History Drawer -->
        <div class="daikin-history-drawer" id="daikin-hist-drawer-${dev.id}" ${isHistOpen ? '' : 'hidden'}>
          <div class="daikin-history-header">
            <span style="font-size:12px; font-weight:600; color:var(--text-dim, #94a3b8)">Indoor vs Outdoor Temperature History</span>
            <div class="range-picker daikin-dev-range-picker" data-dev="${dev.id}">
              <button type="button" class="sinope-loc-range-btn ${histHours === 6 ? 'on' : ''}" data-dev="${dev.id}" data-hours="6">6h</button>
              <button type="button" class="sinope-loc-range-btn ${histHours === 12 ? 'on' : ''}" data-dev="${dev.id}" data-hours="12">12h</button>
              <button type="button" class="sinope-loc-range-btn ${histHours === 24 ? 'on' : ''}" data-dev="${dev.id}" data-hours="24">24h</button>
              <button type="button" class="sinope-loc-range-btn ${histHours === 168 ? 'on' : ''}" data-dev="${dev.id}" data-hours="168">7d</button>
            </div>
          </div>
          <div style="position:relative; width:100%">
            <canvas id="chart-daikin-dev-${dev.id}" class="daikin-chart"></canvas>
          </div>
        </div>
      </div>
    `;
  });

  cardsHtml += '</div>';
  container.innerHTML = cardsHtml;

  // Wire up Mode button listeners
  container.querySelectorAll('.daikin-mode-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const devId = btn.dataset.dev;
      const targetMode = parseInt(btn.dataset.mode, 10);
      const dev = lastDaikinDevices.find(d => String(d.id) === String(devId));
      if (!dev) return;

      btn.disabled = true;
      try {
        const r = await fetch(`/api/daikin/device/${encodeURIComponent(devId)}/msp`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            mode: targetMode,
            heat_setpoint: dev.heat_setpoint_c != null ? dev.heat_setpoint_c : 21.0,
            cool_setpoint: dev.cool_setpoint_c != null ? dev.cool_setpoint_c : 24.0,
          }),
        });
        if (r.ok) {
          const updated = await r.json();
          const idx = lastDaikinDevices.findIndex(d => String(d.id) === String(devId));
          if (idx !== -1) {
            if (updated && updated.id) {
              lastDaikinDevices[idx] = updated;
            } else {
              lastDaikinDevices[idx].mode = targetMode;
            }
          }
          if (lastStatus && lastStatus.daikin_devices) {
            const sIdx = lastStatus.daikin_devices.findIndex(d => String(d.id) === String(devId));
            if (sIdx !== -1) {
              if (updated && updated.id) {
                lastStatus.daikin_devices[sIdx] = updated;
              } else {
                lastStatus.daikin_devices[sIdx].mode = targetMode;
              }
            }
          }
        }
      } catch (e) {
        console.warn('Failed to update Daikin mode:', e);
      } finally {
        renderDaikinTab(true);
      }
    });
  });

  // Wire up Setpoint Step button listeners
  container.querySelectorAll('.daikin-btn-step').forEach(btn => {
    btn.addEventListener('click', async () => {
      const devId = btn.dataset.dev;
      const type = btn.dataset.type;
      const delta = parseFloat(btn.dataset.delta) || 0;
      const dev = lastDaikinDevices.find(d => String(d.id) === String(devId));
      if (!dev) return;

      const isF = getTempUnit() === 'F';
      const stepC = isF ? (delta > 0 ? (5/9) : (-5/9)) : (delta > 0 ? 0.5 : -0.5);

      let newHeat = dev.heat_setpoint_c != null ? dev.heat_setpoint_c : 21.0;
      let newCool = dev.cool_setpoint_c != null ? dev.cool_setpoint_c : 24.0;
      const minSp = dev.setpoint_min != null ? dev.setpoint_min : 10.0;
      const maxSp = dev.setpoint_max != null ? dev.setpoint_max : 32.0;
      const deadband = dev.setpoint_delta != null ? dev.setpoint_delta : 2.0;

      if (type === 'heat') {
        newHeat = Math.round((newHeat + stepC) * 10) / 10;
        newHeat = Math.max(minSp, Math.min(maxSp - deadband, newHeat));
        if (newCool - newHeat < deadband) {
          newCool = Math.round((newHeat + deadband) * 10) / 10;
        }
      } else {
        newCool = Math.round((newCool + stepC) * 10) / 10;
        newCool = Math.max(minSp + deadband, Math.min(maxSp, newCool));
        if (newCool - newHeat < deadband) {
          newHeat = Math.round((newCool - deadband) * 10) / 10;
        }
      }

      btn.disabled = true;
      try {
        const r = await fetch(`/api/daikin/device/${encodeURIComponent(devId)}/msp`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            mode: dev.mode != null ? dev.mode : 1,
            heat_setpoint: newHeat,
            cool_setpoint: newCool,
          }),
        });
        if (r.ok) {
          const updated = await r.json();
          const idx = lastDaikinDevices.findIndex(d => String(d.id) === String(devId));
          if (idx !== -1) {
            if (updated && updated.id) {
              lastDaikinDevices[idx] = updated;
            } else {
              lastDaikinDevices[idx].heat_setpoint_c = newHeat;
              lastDaikinDevices[idx].cool_setpoint_c = newCool;
            }
          }
          if (lastStatus && lastStatus.daikin_devices) {
            const sIdx = lastStatus.daikin_devices.findIndex(d => String(d.id) === String(devId));
            if (sIdx !== -1) {
              if (updated && updated.id) {
                lastStatus.daikin_devices[sIdx] = updated;
              } else {
                lastStatus.daikin_devices[sIdx].heat_setpoint_c = newHeat;
                lastStatus.daikin_devices[sIdx].cool_setpoint_c = newCool;
              }
            }
          }
        }
      } catch (e) {
        console.warn('Failed to update Daikin setpoint:', e);
      } finally {
        renderDaikinTab(true);
      }
    });
  });

  // Wire up Fan Mode select listener
  container.querySelectorAll('.daikin-fan-mode-select').forEach(sel => {
    sel.addEventListener('change', async () => {
      const devId = sel.dataset.dev;
      const dev = lastDaikinDevices.find(d => String(d.id) === String(devId));
      if (!dev) return;

      const newCirc = parseInt(sel.value, 10);
      dev.fan_circulate = newCirc;
      sel.disabled = true;
      try {
        const r = await fetch(`/api/daikin/device/${encodeURIComponent(devId)}/fan`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fan_circulate: newCirc,
            fan_circulate_speed: dev.fan_circulate_speed != null ? dev.fan_circulate_speed : 0,
          }),
        });
        if (r.ok) {
          const updated = await r.json();
          dev.air_clean = { active: false };
          const idx = lastDaikinDevices.findIndex(d => String(d.id) === String(devId));
          if (idx !== -1) {
            if (updated && updated.id) {
              lastDaikinDevices[idx] = updated;
            } else {
              lastDaikinDevices[idx].fan_circulate = newCirc;
            }
            lastDaikinDevices[idx].air_clean = { active: false };
          }
          if (lastStatus && lastStatus.daikin_devices) {
            const sIdx = lastStatus.daikin_devices.findIndex(d => String(d.id) === String(devId));
            if (sIdx !== -1) {
              if (updated && updated.id) {
                lastStatus.daikin_devices[sIdx] = updated;
              } else {
                lastStatus.daikin_devices[sIdx].fan_circulate = newCirc;
              }
              lastStatus.daikin_devices[sIdx].air_clean = { active: false };
            }
          }
        }
      } catch (e) {
        console.warn('Failed to update Daikin fan mode:', e);
      } finally {
        renderDaikinTab(true);
      }
    });
  });

  // Wire up Fan Speed select listener
  container.querySelectorAll('.daikin-fan-speed-select').forEach(sel => {
    sel.addEventListener('change', async () => {
      const devId = sel.dataset.dev;
      const dev = lastDaikinDevices.find(d => String(d.id) === String(devId));
      if (!dev) return;

      const newSpeed = parseInt(sel.value, 10);
      dev.fan_circulate_speed = newSpeed;
      sel.disabled = true;
      try {
        const r = await fetch(`/api/daikin/device/${encodeURIComponent(devId)}/fan`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fan_circulate: dev.fan_circulate != null ? dev.fan_circulate : 0,
            fan_circulate_speed: newSpeed,
          }),
        });
        if (r.ok) {
          const updated = await r.json();
          dev.air_clean = { active: false };
          const idx = lastDaikinDevices.findIndex(d => String(d.id) === String(devId));
          if (idx !== -1) {
            if (updated && updated.id) {
              lastDaikinDevices[idx] = updated;
            } else {
              lastDaikinDevices[idx].fan_circulate_speed = newSpeed;
            }
            lastDaikinDevices[idx].air_clean = { active: false };
          }
          if (lastStatus && lastStatus.daikin_devices) {
            const sIdx = lastStatus.daikin_devices.findIndex(d => String(d.id) === String(devId));
            if (sIdx !== -1) {
              if (updated && updated.id) {
                lastStatus.daikin_devices[sIdx] = updated;
              } else {
                lastStatus.daikin_devices[sIdx].fan_circulate_speed = newSpeed;
              }
              lastStatus.daikin_devices[sIdx].air_clean = { active: false };
            }
          }
        }
      } catch (e) {
        console.warn('Failed to update Daikin fan speed:', e);
      } finally {
        renderDaikinTab(true);
      }
    });
  });

  // Wire up Schedule button listener
  container.querySelectorAll('.daikin-sched-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const devId = btn.dataset.dev;
      const dev = lastDaikinDevices.find(d => String(d.id) === String(devId));
      if (!dev) return;

      const nextSched = !dev.schedule_enabled;
      btn.disabled = true;
      try {
        const r = await fetch(`/api/daikin/device/${encodeURIComponent(devId)}/schedule`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ schedule_enabled: nextSched }),
        });
        if (r.ok) {
          const updated = await r.json();
          const idx = lastDaikinDevices.findIndex(d => String(d.id) === String(devId));
          if (idx !== -1) {
            if (updated && updated.id) {
              lastDaikinDevices[idx] = updated;
            } else {
              lastDaikinDevices[idx].schedule_enabled = nextSched;
            }
          }
          if (lastStatus && lastStatus.daikin_devices) {
            const sIdx = lastStatus.daikin_devices.findIndex(d => String(d.id) === String(devId));
            if (sIdx !== -1) {
              if (updated && updated.id) {
                lastStatus.daikin_devices[sIdx] = updated;
              } else {
                lastStatus.daikin_devices[sIdx].schedule_enabled = nextSched;
              }
            }
          }
        }
      } catch (e) {
        console.warn('Failed to update Daikin schedule:', e);
      } finally {
        renderDaikinTab(true);
      }
    });
  });

  // Wire up Air Clean trigger button listener
  container.querySelectorAll('.daikin-airclean-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const devId = btn.dataset.dev;
      const dev = lastDaikinDevices.find(d => String(d.id) === String(devId));
      if (!dev) return;

      const isRunning = Boolean(dev.air_clean && dev.air_clean.active);
      btn.disabled = true;

      try {
        if (!isRunning) {
          const r = await fetch(`/api/daikin/device/${encodeURIComponent(devId)}/air-clean`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ duration_s: 10800 }),
          });
          if (r.ok) {
            const data = await r.json();
            const acState = data.air_clean || {
              active: true,
              duration_s: 10800,
              remaining_s: 10800,
              previous_fan_circulate: dev.fan_circulate || 0,
              previous_fan_circulate_speed: dev.fan_circulate_speed || 0,
            };
            dev.air_clean = acState;
            dev.fan_circulate = 1;
            dev.fan_circulate_speed = 1;
            if (lastStatus && lastStatus.daikin_devices) {
              const sDev = lastStatus.daikin_devices.find(d => String(d.id) === String(devId));
              if (sDev) {
                sDev.air_clean = acState;
                sDev.fan_circulate = 1;
                sDev.fan_circulate_speed = 1;
              }
            }
          }
        } else {
          const r = await fetch(`/api/daikin/device/${encodeURIComponent(devId)}/air-clean`, {
            method: 'DELETE',
          });
          if (r.ok) {
            const prevCirc = (dev.air_clean && dev.air_clean.previous_fan_circulate != null) ? dev.air_clean.previous_fan_circulate : 0;
            const prevSpeed = (dev.air_clean && dev.air_clean.previous_fan_circulate_speed != null) ? dev.air_clean.previous_fan_circulate_speed : 0;
            dev.air_clean = { active: false };
            dev.fan_circulate = prevCirc;
            dev.fan_circulate_speed = prevSpeed;
            if (lastStatus && lastStatus.daikin_devices) {
              const sDev = lastStatus.daikin_devices.find(d => String(d.id) === String(devId));
              if (sDev) {
                sDev.air_clean = { active: false };
                sDev.fan_circulate = prevCirc;
                sDev.fan_circulate_speed = prevSpeed;
              }
            }
          }
        }
      } catch (e) {
        console.warn('Failed to toggle Daikin air clean:', e);
      } finally {
        renderDaikinTab(true);
      }
    });
  });

  // Wire up Air Clean Banner Cancel button listener
  container.querySelectorAll('.daikin-airclean-cancel-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const devId = btn.dataset.dev;
      const dev = lastDaikinDevices.find(d => String(d.id) === String(devId));
      if (!dev) return;

      btn.disabled = true;
      try {
        const r = await fetch(`/api/daikin/device/${encodeURIComponent(devId)}/air-clean`, {
          method: 'DELETE',
        });
        if (r.ok) {
          const prevCirc = (dev.air_clean && dev.air_clean.previous_fan_circulate != null) ? dev.air_clean.previous_fan_circulate : 0;
          const prevSpeed = (dev.air_clean && dev.air_clean.previous_fan_circulate_speed != null) ? dev.air_clean.previous_fan_circulate_speed : 0;
          dev.air_clean = { active: false };
          dev.fan_circulate = prevCirc;
          dev.fan_circulate_speed = prevSpeed;
          if (lastStatus && lastStatus.daikin_devices) {
            const sDev = lastStatus.daikin_devices.find(d => String(d.id) === String(devId));
            if (sDev) {
              sDev.air_clean = { active: false };
              sDev.fan_circulate = prevCirc;
              sDev.fan_circulate_speed = prevSpeed;
            }
          }
        }
      } catch (e) {
        console.warn('Failed to cancel Daikin air clean:', e);
      } finally {
        renderDaikinTab(true);
      }
    });
  });

  // Wire up History Drawer Toggle listener
  container.querySelectorAll('.daikin-hist-toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const devId = btn.dataset.dev;
      const drawer = $('daikin-hist-drawer-' + devId);
      if (_daikinOpenDeviceHistories.has(devId)) {
        _daikinOpenDeviceHistories.delete(devId);
        if (drawer) drawer.hidden = true;
        btn.textContent = '📊 History';
      } else {
        _daikinOpenDeviceHistories.add(devId);
        if (drawer) drawer.hidden = false;
        btn.textContent = '📊 Hide History';
        requestAnimationFrame(() => loadAndDrawDaikinDeviceChart(devId));
      }
    });
  });

  // Wire up History Range Picker buttons
  container.querySelectorAll('.daikin-dev-range-picker button').forEach(btn => {
    btn.addEventListener('click', () => {
      const devId = btn.dataset.dev;
      const hours = parseInt(btn.dataset.hours, 10) || 24;
      _daikinDevHours[devId] = hours;
      container.querySelectorAll(`.daikin-dev-range-picker[data-dev="${devId}"] button`).forEach(b => {
        b.classList.toggle('on', parseInt(b.dataset.hours, 10) === hours);
      });
      loadAndDrawDaikinDeviceChart(devId, true);
    });
  });

  // Render open charts
  _daikinOpenDeviceHistories.forEach(devId => {
    requestAnimationFrame(() => loadAndDrawDaikinDeviceChart(devId));
  });
}

async function loadDaikinCreds() {
  const status = $('daikin-creds-status');
  const emailIn = $('daikin-email');
  if (!status) return;
  try {
    const r = await fetch('/api/daikin/credentials');
    const j = await r.json();
    if (j.saved) {
      status.textContent = `saved · ${j.email || ''}`;
      if (emailIn && !emailIn.value) emailIn.value = j.email || '';
    } else {
      status.textContent = 'not set';
    }
  } catch (e) {
    status.textContent = 'failed to load';
  }
}

function initDaikinSettings() {
  loadDaikinCreds();

  $('daikin-creds-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = ($('daikin-email')?.value || '').trim();
    const token = ($('daikin-token')?.value || '').trim();
    const apiKey = ($('daikin-api-key')?.value || '').trim();
    const msg = $('daikin-msg');
    const btn = $('daikin-save-btn');

    if (!email || !token || !apiKey) {
      if (msg) {
        msg.hidden = false;
        msg.textContent = 'Please provide Account Email, Integrator Token, and API Key.';
      }
      return;
    }

    if (btn) btn.disabled = true;
    if (msg) {
      msg.hidden = false;
      msg.textContent = 'Verifying credentials with Daikin Open API…';
    }

    try {
      const r = await fetch('/api/daikin/credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, integrator_token: token, api_key: apiKey }),
      });
      const j = await r.json();
      if (r.ok && j.ok) {
        if (msg) {
          const count = j.device_count || 0;
          msg.textContent = `✓ Saved successfully! Discovered ${count} Daikin device(s).`;
          setTimeout(() => { msg.hidden = true; }, 5000);
        }
        loadDaikinCreds();
        renderDaikinTab(true);
      } else {
        if (msg) msg.textContent = `Error: ${j.detail || j.error || 'Authentication rejected'}`;
      }
    } catch (err) {
      if (msg) msg.textContent = `Network error: ${err.message}`;
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  $('daikin-clear-btn')?.addEventListener('click', async () => {
    if (!confirm('Forget saved Daikin One credentials?')) return;
    try {
      await fetch('/api/daikin/credentials', { method: 'DELETE' });
      const emailEl = $('daikin-email');
      const tokEl = $('daikin-token');
      const keyEl = $('daikin-api-key');
      if (emailEl) emailEl.value = '';
      if (tokEl) tokEl.value = '';
      if (keyEl) keyEl.value = '';
      const msg = $('daikin-msg');
      if (msg) {
        msg.hidden = false;
        msg.textContent = 'Credentials cleared.';
        setTimeout(() => { msg.hidden = true; }, 3000);
      }
      loadDaikinCreds();
      renderDaikinTab(true);
    } catch (e) {}
  });

  $('daikin-poll-btn')?.addEventListener('click', async () => {
    const btn = $('daikin-poll-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Polling…'; }
    try {
      const r = await fetch('/api/daikin/poll', { method: 'POST' });
      const j = await r.json();
      if (j.devices) {
        lastDaikinDevices = j.devices;
        if (lastStatus) lastStatus.daikin_devices = j.devices;
        renderDaikinTab(true);
      }
    } catch (e) {}
    finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Poll now'; }
    }
  });
}


// ============================================================
// HILO HYDRO-QUÉBEC SMART METER & GATEWAY TAB
// ============================================================
let _hiloSelectedLocation = localStorage.getItem('hilo_selected_location') || 'all';
let _hiloCredsLoc = 'maison';
let _hiloMeterHours = 24;
let lastHiloMeters = [];
let lastHiloDevices = [];
let lastHiloChallenges = [];
let lastHiloCredsStatus = null;
let _lastHiloPollTs = null;
const _hiloMeterHistData = {};
let _hiloResizeBound = false;

function drawHiloMeterChart(hist, hours) {
  const canvas = $('chart-hilo-meter');
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  if (rect.width <= 10) return;

  const { ctx, w, h } = setCanvasSize(canvas);
  ctx.clearRect(0, 0, w, h);
  const padL = 52, padR = 24, padT = 16, padB = 30;

  if (!hist || !hist.length) {
    drawAxes(ctx, w, h, padL, padR, padT, padB);
    ctx.fillStyle = '#6b7280';
    ctx.font = '12px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Accumulating smart meter power history…', w / 2, h / 2);
    return;
  }

  let plotHist = hist;
  if (hist.length === 1) {
    const single = hist[0];
    plotHist = [{ ...single, ts: single.ts - 300 }, single];
  }

  const powerW = plotHist.map(r => r.power_w || 0);
  const maxW = Math.max(500, Math.ceil((Math.max(...powerW, 100) * 1.15) / 100) * 100);
  const xs = (i) => padL + (i / Math.max(1, plotHist.length - 1)) * (w - padL - padR);
  const yWatts = (v) => (h - padB) - (v / maxW) * (h - padT - padB);
  const baseY = h - padB;

  // Gridlines & Axes
  ctx.strokeStyle = 'rgba(35,42,51,.7)';
  ctx.lineWidth = 1;
  for (let i = 1; i <= 4; i++) {
    const y = padT + ((h - padT - padB) * i) / 5;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
  }
  drawAxes(ctx, w, h, padL, padR, padT, padB);

  // Left Y-axis labels (Watts)
  ctx.fillStyle = '#6b7280';
  ctx.font = '11px Inter, sans-serif';
  ctx.textAlign = 'right';
  for (let i = 0; i <= 4; i++) {
    const v = (maxW * (4 - i)) / 4;
    const y = padT + ((h - padT - padB) * i) / 4;
    ctx.fillText(`${Math.round(v)} W`, padL - 6, y + 3);
  }

  // X-axis time ticks
  if (plotHist.length >= 2) {
    const first = plotHist[0].ts || 0, last = plotHist[plotHist.length - 1].ts || 0;
    const spanH = (last - first) / 3600;
    ctx.fillStyle = '#6b7280';
    ctx.textAlign = 'center';
    const ticks = Math.min(5, plotHist.length - 1);
    for (let i = 0; i <= ticks; i++) {
      const idx = Math.round((plotHist.length - 1) * (i / ticks));
      const ts = plotHist[idx].ts || (first + (last - first) * (i / ticks));
      const d = new Date(ts * 1000);
      const str = (spanH > 24)
        ? (d.toLocaleDateString([], { month: 'numeric', day: 'numeric' }) + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))
        : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      ctx.fillText(str, xs(idx), h - 8);
    }
    ctx.textAlign = 'start';
  }

  // Trace: Electric blue fill and line
  drawAreaFill(ctx, powerW, xs, yWatts, baseY, '#38bdf8', 0.20);
  drawSmoothLine(ctx, powerW, xs, yWatts, '#38bdf8', 2.5);

  canvas._redraw = () => drawHiloMeterChart(hist, hours);

  _attachChartHover(canvas, plotHist, (idx) => {
    const p = plotHist[idx];
    if (!p) return '';
    const d = new Date(p.ts * 1000);
    const tsStr = d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }) + ' ' +
                  d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const pwr = Math.round(p.power_w || 0);
    const nrg = p.energy_wh != null ? (p.energy_wh >= 1000 ? (p.energy_wh / 1000).toFixed(2) + ' kWh' : Math.round(p.energy_wh) + ' Wh') : '—';

    return `
      <div class="cht-ts">${escapeHtml(tsStr)}</div>
      <div class="cht-row"><i style="background:#38bdf8"></i> Puissance compteur: <b>${pwr.toLocaleString()} W</b></div>
      <div class="cht-row"><i style="background:transparent; border:1px solid #64748b"></i> Énergie intervalle: <b>${nrg}</b></div>
    `;
  }, () => ({ xs, padL, padR, w, h, baseY, padT, padB }));
}

async function loadAndDrawHiloMeterChart(force = false) {
  const canvas = $('chart-hilo-meter');
  if (!canvas) return;

  const meters = (lastStatus && lastStatus.hilo_meters) || lastHiloMeters || [];
  const locFilter = _hiloSelectedLocation;
  const filteredMeters = (locFilter === 'all')
    ? meters
    : meters.filter(m => (m.location_id || '').toLowerCase() === locFilter.toLowerCase());

  const targetMeter = filteredMeters[0] || meters[0];
  if (!targetMeter || !targetMeter.device_sn) {
    const { ctx, w, h } = setCanvasSize(canvas);
    ctx.clearRect(0, 0, w, h);
    drawAxes(ctx, w, h, 52, 24, 16, 30);
    ctx.fillStyle = '#6b7280';
    ctx.font = '12px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Connectez la passerelle Hilo pour afficher la courbe du compteur', w / 2, h / 2);
    return;
  }

  const meterSn = targetMeter.device_sn;
  const hours = _hiloMeterHours || 24;
  const cacheKey = `${meterSn}_${hours}`;
  const now = Date.now();
  let hist = null;

  if (!force && _hiloMeterHistData[cacheKey] && (now - _hiloMeterHistData[cacheKey].ts < 45000)) {
    hist = _hiloMeterHistData[cacheKey].data;
  } else {
    try {
      const r = await fetch(`/api/hilo/history/meter?device_sn=${encodeURIComponent(meterSn)}&hours=${hours}`);
      if (r.ok) {
        const j = await r.json();
        hist = j.history || [];
        _hiloMeterHistData[cacheKey] = { ts: now, data: hist };
      }
    } catch (e) {
      console.warn('Failed to fetch Hilo meter history:', e);
    }
  }

  drawHiloMeterChart(hist, hours);
}

function initHiloTab() {
  // Location selector pills
  document.querySelectorAll('.hilo-loc-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      _hiloSelectedLocation = pill.dataset.loc || 'all';
      try { localStorage.setItem('hilo_selected_location', _hiloSelectedLocation); } catch {}
      document.querySelectorAll('.hilo-loc-pill').forEach(p => {
        p.classList.toggle('on', p.dataset.loc === _hiloSelectedLocation);
      });
      renderHiloTab();
      loadAndDrawHiloMeterChart(true);
    });
  });

  // Chart range buttons
  document.querySelectorAll('#hilo-meter-ranges .hilo-range-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      _hiloMeterHours = parseInt(btn.dataset.hours || '24', 10);
      document.querySelectorAll('#hilo-meter-ranges .hilo-range-btn').forEach(b => {
        b.classList.toggle('on', parseInt(b.dataset.hours || '24', 10) === _hiloMeterHours);
      });
      loadAndDrawHiloMeterChart(true);
    });
  });

  // Tab poll button
  $('hilo-tab-poll-btn')?.addEventListener('click', async () => {
    const btn = $('hilo-tab-poll-btn');
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="poll-icon">⏳</span> Polling…'; }
    try {
      const r = await fetch('/api/hilo/poll', { method: 'POST' });
      if (r.ok) {
        const j = await r.json();
        if (j.meters) lastHiloMeters = j.meters;
        if (j.devices) lastHiloDevices = j.devices;
        if (j.challenges) lastHiloChallenges = j.challenges;
        if (lastStatus) {
          lastStatus.hilo_meters = j.meters;
          lastStatus.hilo_devices = j.devices;
          lastStatus.hilo_challenges = j.challenges;
        }
        _lastHiloPollTs = Date.now();
        renderHiloTab(true);
      }
    } catch (e) {
      console.warn('Hilo poll error:', e);
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = '<span class="poll-icon">🔄</span> Poll now'; }
    }
  });

  // Resize redraw
  if (!_hiloResizeBound) {
    window.addEventListener('resize', () => {
      if (activeTab === 'hilo') {
        const canvas = $('chart-hilo-meter');
        if (canvas && canvas._redraw) canvas._redraw();
      }
    });
    _hiloResizeBound = true;
  }
}

async function renderHiloTab(force = false) {
  const container = $('hilo-devices-container');
  if (!container) return;

  // Initial fetch of devices if none cached yet
  if ((!lastHiloMeters.length && !lastHiloDevices.length) || force) {
    try {
      const r = await fetch('/api/hilo/devices');
      if (r.ok) {
        const j = await r.json();
        if (j.meters) lastHiloMeters = j.meters;
        if (j.devices) lastHiloDevices = j.devices;
        if (j.challenges) lastHiloChallenges = j.challenges;
        if (lastStatus) {
          lastStatus.hilo_meters = j.meters;
          lastStatus.hilo_devices = j.devices;
          lastStatus.hilo_challenges = j.challenges;
        }
      }
    } catch (e) {
      console.warn('Failed to load Hilo devices:', e);
    }
  }

  const meters = (lastStatus && lastStatus.hilo_meters) || lastHiloMeters || [];
  const devices = (lastStatus && lastStatus.hilo_devices) || lastHiloDevices || [];
  const challenges = (lastStatus && lastStatus.hilo_challenges) || lastHiloChallenges || [];

  // Update Location pill active classes
  document.querySelectorAll('.hilo-loc-pill').forEach(p => {
    p.classList.toggle('on', p.dataset.loc === _hiloSelectedLocation);
  });

  // Update Last poll time
  const pollTimeEl = $('hilo-last-poll-time');
  if (pollTimeEl) {
    if (_lastHiloPollTs) {
      const elapsedM = Math.max(0, Math.round((Date.now() - _lastHiloPollTs) / 60000));
      pollTimeEl.textContent = elapsedM === 0 ? 'Last update: just now' : `Last update: ${elapsedM}m ago`;
    } else if (meters.length) {
      pollTimeEl.textContent = 'Last update: active';
    } else {
      pollTimeEl.textContent = 'Last update: —';
    }
  }

  // Filter devices & challenges based on chosen location
  const locFilter = _hiloSelectedLocation;
  const filteredMeters = (locFilter === 'all')
    ? meters
    : meters.filter(m => (m.location_id || '').toLowerCase() === locFilter.toLowerCase());
  const filteredDevices = (locFilter === 'all')
    ? devices
    : devices.filter(d => (d.location_id || '').toLowerCase() === locFilter.toLowerCase());
  const filteredChallenges = (locFilter === 'all')
    ? challenges
    : challenges.filter(c => (c.location_id || '').toLowerCase() === locFilter.toLowerCase());

  // Défi Hilo Challenge Banner
  const banner = $('hilo-challenge-banner');
  if (banner) {
    if (filteredChallenges.length > 0) {
      const ch = filteredChallenges[0];
      banner.hidden = false;
      const titleEl = $('hilo-challenge-badge-title');
      if (titleEl) titleEl.textContent = `DÉFI HILO ${ch.period ? '— ' + ch.period : ''}`;

      const tagEl = $('hilo-challenge-progress-tag');
      if (tagEl) {
        const prog = (ch.progress || 'scheduled').toLowerCase();
        if (prog.includes('progress') || prog.includes('reduction')) {
          tagEl.textContent = 'En cours';
          tagEl.style.background = 'rgba(239,68,68,0.2)';
          tagEl.style.color = '#ef4444';
          tagEl.style.borderColor = 'rgba(239,68,68,0.4)';
        } else if (prog.includes('preheat')) {
          tagEl.textContent = 'Préchauffage';
          tagEl.style.background = 'rgba(245,158,11,0.2)';
          tagEl.style.color = '#f59e0b';
          tagEl.style.borderColor = 'rgba(245,158,11,0.4)';
        } else if (prog.includes('completed')) {
          tagEl.textContent = 'Terminé';
          tagEl.style.background = 'rgba(16,185,129,0.2)';
          tagEl.style.color = '#10b981';
          tagEl.style.borderColor = 'rgba(16,185,129,0.4)';
        } else {
          tagEl.textContent = 'Programmé';
          tagEl.style.background = 'rgba(59,130,246,0.2)';
          tagEl.style.color = '#3b82f6';
          tagEl.style.borderColor = 'rgba(59,130,246,0.4)';
        }
      }

      const timesEl = $('hilo-challenge-times');
      if (timesEl) {
        let timeStr = 'Période de réduction de la consommation';
        if (ch.reduction_start && ch.reduction_end) {
          try {
            const startD = new Date(ch.reduction_start);
            const endD = new Date(ch.reduction_end);
            timeStr = `${startD.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} – ${endD.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
            const dateStr = startD.toLocaleDateString([], { month: 'short', day: 'numeric' });
            timeStr = `${dateStr} · ${timeStr}`;
          } catch {}
        }
        timesEl.textContent = timeStr;
      }

      const locEl = $('hilo-challenge-loc-label');
      if (locEl) locEl.textContent = `${ch.location_name || ch.location_id || 'Maison'} · Mode ${ch.mode || 'standard'}`;

      const baseEl = $('hilo-challenge-baseline');
      if (baseEl) baseEl.textContent = `${ch.baseline_kwh != null ? ch.baseline_kwh.toFixed(1) : '—'} kWh`;

      const curEl = $('hilo-challenge-current');
      if (curEl) curEl.textContent = `${ch.current_kwh != null ? ch.current_kwh.toFixed(1) : '—'} kWh`;

      const rewEl = $('hilo-challenge-reward');
      if (rewEl) rewEl.textContent = `${ch.reward != null ? (ch.reward > 0 ? '+' : '') + ch.reward.toFixed(2) : '0.00'} $`;
    } else {
      banner.hidden = true;
    }
  }

  // KPIs
  let totalW = 0;
  let totalTodayKwh = 0;
  let hasOnlineMeter = false;
  let channel = null;

  filteredMeters.forEach(m => {
    totalW += (m.power_w || 0);
    if (m.today_kwh != null) totalTodayKwh += m.today_kwh;
    if (m.online) hasOnlineMeter = true;
    if (m.zigbee_channel) channel = m.zigbee_channel;
  });

  const kpiPower = $('hilo-kpi-power');
  if (kpiPower) kpiPower.textContent = Math.round(totalW).toLocaleString();

  const liveIndicator = $('hilo-live-indicator');
  if (liveIndicator) liveIndicator.style.display = hasOnlineMeter ? 'inline-block' : 'none';

  const kpiToday = $('hilo-kpi-today');
  if (kpiToday) kpiToday.textContent = totalTodayKwh.toFixed(2);

  const kpiStatus = $('hilo-kpi-status');
  if (kpiStatus) {
    if (filteredMeters.length > 0) {
      kpiStatus.textContent = hasOnlineMeter ? (channel ? `Connecté (Canal ${channel})` : 'Connecté') : 'Déconnecté';
      kpiStatus.style.color = hasOnlineMeter ? 'var(--accent, #10b981)' : 'var(--red, #ef4444)';
    } else {
      kpiStatus.textContent = 'Aucun compteur';
      kpiStatus.style.color = 'var(--text-dim, #94a3b8)';
    }
  }

  const kpiDevicesCount = $('hilo-kpi-devices-count');
  if (kpiDevicesCount) kpiDevicesCount.textContent = filteredDevices.length;

  // Power History Chart
  loadAndDrawHiloMeterChart(force);

  // Render Devices / Meters list
  if (filteredMeters.length === 0 && filteredDevices.length === 0) {
    container.innerHTML = `
      <div class="hilo-empty-card">
        <div style="font-size:36px">⚡</div>
        <h3>Passerelle Hilo non configurée</h3>
        <p>Connectez votre passerelle Hilo dans l'onglet Paramètres pour suivre la puissance instantanée de votre compteur intelligent Hydro-Québec et surveiller les événements Défi Hilo.</p>
        <button class="btn btn-primary" onclick="switchTab('settings'); selectSettingsSubtab('integrations'); document.getElementById('settings-card-hilo')?.classList.remove('collapsed'); document.getElementById('settings-card-hilo')?.scrollIntoView({behavior:'smooth'});">
          Configurer Hilo dans les paramètres
        </button>
      </div>
    `;
    return;
  }

  let html = '<div class="hilo-devices-grid">';

  // Meter cards
  filteredMeters.forEach(m => {
    const pwr = Math.round(m.power_w || 0);
    const today = m.today_kwh != null ? m.today_kwh.toFixed(2) : '0.00';
    html += `
      <div class="hilo-meter-card">
        <div class="hilo-meter-header">
          <div>
            <h3 class="hilo-meter-title">${escapeHtml(m.name || 'Compteur HQ')}</h3>
            <span class="hilo-meter-sn">${escapeHtml(m.mac || m.device_sn)}</span>
          </div>
          <span class="badge ${m.online ? 'badge-ok' : 'badge-err'}">${m.online ? 'En ligne' : 'Hors ligne'}</span>
        </div>
        <div class="hilo-meter-metrics">
          <div>
            <div class="hilo-meter-power">${pwr.toLocaleString()} <small style="font-size:14px; font-weight:400; color:var(--text-dim)">W</small></div>
            <span class="hint" style="font-size:11px">Puissance totale maison</span>
          </div>
          <div style="text-align:right">
            <div class="hilo-meter-today" style="font-size:18px; font-weight:600; color:var(--text)">${today} <small style="font-size:12px; font-weight:400; color:var(--text-dim)">kWh</small></div>
            <span class="hint" style="font-size:11px">Aujourd'hui</span>
          </div>
        </div>
        <div class="hilo-meter-meta">
          <span>Lieu: <b>${escapeHtml(m.location_name || m.location_id || 'Maison')}</b></span>
          <span>Zigbee SEP: <b>Canal ${m.zigbee_channel || '15'}</b></span>
        </div>
      </div>
    `;
  });

  // Other connected devices (thermostats, switches, etc.)
  filteredDevices.forEach(d => {
    const pwr = d.power_w != null ? Math.round(d.power_w) : null;
    html += `
      <div class="hilo-dev-card">
        <div class="hilo-dev-header">
          <span class="hilo-dev-name">${escapeHtml(d.name || d.device_sn)}</span>
          <span class="hilo-dev-type">${escapeHtml(d.device_type || 'Appareil')}</span>
        </div>
        <div class="hilo-dev-stats">
          ${pwr != null ? `<span>⚡ ${pwr} W</span>` : ''}
          ${d.temp_c != null ? `<span>🌡️ ${formatTemp(d.temp_c, 1)}</span>` : ''}
          ${d.setpoint_c != null ? `<span>🎯 ${formatTemp(d.setpoint_c, 1)}</span>` : ''}
          ${d.mode ? `<span>⚙️ ${escapeHtml(d.mode)}</span>` : ''}
        </div>
        <div class="hint" style="font-size:11px; display:flex; justify-content:space-between">
          <span>${escapeHtml(d.location_name || d.location_id || '')}</span>
          <span style="color:${d.online ? 'var(--accent, #10b981)' : 'var(--text-dim, #94a3b8)'}">${d.online ? 'Connecté' : 'Hors ligne'}</span>
        </div>
      </div>
    `;
  });

  html += '</div>';
  container.innerHTML = html;
}

async function loadHiloCreds() {
  const statusEl = $('hilo-creds-status');
  try {
    const res = await fetch('/api/hilo/credentials');
    if (!res.ok) return;
    const j = await res.json();
    lastHiloCredsStatus = j;

    if (statusEl) {
      if (j.saved) {
        const configuredNames = (j.configured || []).map(c => c.charAt(0).toUpperCase() + c.slice(1)).join(', ');
        statusEl.textContent = `configured · ${configuredNames}`;
        statusEl.style.color = 'var(--accent, #10b981)';
      } else {
        statusEl.textContent = 'not configured';
        statusEl.style.color = 'var(--text-dim, #94a3b8)';
      }
    }

    _syncHiloCredsForm();
  } catch (err) {
    if (statusEl) statusEl.textContent = 'failed to load';
  }
}

function _syncHiloCredsForm() {
  const locIndicator = $('hilo-creds-loc-indicator');
  const locTitle = _hiloCredsLoc.charAt(0).toUpperCase() + _hiloCredsLoc.slice(1);
  if (locIndicator) locIndicator.textContent = `${locTitle} credentials`;

  document.querySelectorAll('.hilo-creds-loc-pill').forEach(pill => {
    pill.classList.toggle('on', pill.dataset.loc === _hiloCredsLoc);
  });

  const emailIn = $('hilo-email');
  const passIn = $('hilo-password');
  const locData = (lastHiloCredsStatus && lastHiloCredsStatus.locations) ? lastHiloCredsStatus.locations[_hiloCredsLoc] : null;

  if (emailIn) {
    emailIn.value = (locData && locData.email) || '';
  }
  if (passIn) {
    passIn.value = '';
    passIn.placeholder = (locData && locData.saved) ? '••••••••' : '••••••••';
  }
}

function initHiloSettings() {
  loadHiloCreds();

  // Location pills switch in Settings
  document.querySelectorAll('.hilo-creds-loc-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      _hiloCredsLoc = pill.dataset.loc || 'maison';
      _syncHiloCredsForm();
    });
  });

  const form = $('hilo-creds-form');
  const msg = $('hilo-msg');
  const saveBtn = $('hilo-save-btn');
  const clearBtn = $('hilo-clear-btn');
  const pollBtn = $('hilo-poll-btn');

  function showMsg(text, isError = false, timeout = 5000) {
    if (!msg) return;
    msg.hidden = false;
    msg.textContent = text;
    msg.style.color = isError ? 'var(--red, #ef4444)' : 'var(--accent, #10b981)';
    if (timeout > 0) {
      setTimeout(() => { msg.hidden = true; }, timeout);
    }
  }

  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = ($('hilo-email')?.value || '').trim();
    const password = $('hilo-password')?.value || '';

    if (!email || !password) {
      showMsg('Please provide your Hilo account email and password.', true);
      return;
    }

    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Signing in…'; }
    showMsg('Verifying credentials with Hydro-Québec Hilo portal…', false, 0);

    try {
      const res = await fetch('/api/hilo/credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          location_id: _hiloCredsLoc,
          email,
          password,
        }),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        showMsg(`✓ Connected successfully to Hilo (${_hiloCredsLoc})! Polling smart meter…`);
        loadHiloCreds();
        renderHiloTab(true);
      } else {
        showMsg(`Error: ${data.detail || data.error || 'Authentication rejected by Hilo'}`, true, 8000);
      }
    } catch (err) {
      showMsg(`Network error: ${err.message}`, true, 8000);
    } finally {
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Sign in & Save'; }
    }
  });

  clearBtn?.addEventListener('click', async () => {
    const locTitle = _hiloCredsLoc.charAt(0).toUpperCase() + _hiloCredsLoc.slice(1);
    if (!confirm(`Forget saved Hilo credentials for ${locTitle}?`)) return;

    try {
      const res = await fetch(`/api/hilo/credentials?location_id=${encodeURIComponent(_hiloCredsLoc)}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        showMsg(`Credentials cleared for ${locTitle}.`);
        loadHiloCreds();
        renderHiloTab(true);
      }
    } catch (err) {
      showMsg(`Failed to clear: ${err.message}`, true);
    }
  });

  pollBtn?.addEventListener('click', async () => {
    if (pollBtn) { pollBtn.disabled = true; pollBtn.textContent = 'Polling…'; }
    showMsg('Polling Hilo Cloud…', false, 0);

    try {
      const res = await fetch(`/api/hilo/poll?location_id=${encodeURIComponent(_hiloCredsLoc)}`, {
        method: 'POST',
      });
      const data = await res.json();
      if (res.ok) {
        const count = (data.meters || []).length;
        showMsg(`✓ Poll completed! Discovered ${count} smart meter(s).`);
        if (data.meters) lastHiloMeters = data.meters;
        if (data.devices) lastHiloDevices = data.devices;
        if (data.challenges) lastHiloChallenges = data.challenges;
        renderHiloTab(true);
      } else {
        showMsg(`Poll error: ${data.detail || 'Failed to poll Hilo'}`, true);
      }
    } catch (err) {
      showMsg(`Network error: ${err.message}`, true);
    } finally {
      if (pollBtn) { pollBtn.disabled = false; pollBtn.textContent = 'Poll now'; }
    }
  });
}


// ============================================================
// LG THINQ SMART APPLIANCES TAB & CONTROLS
// ============================================================
let lastThinqDevices = [];
let _thinqSelectedLocation = localStorage.getItem('thinq_selected_location') || 'all';
let _thinqCredsLoc = 'maison';
let _lastThinqPollTs = 0;
let lastThinqCredsStatus = null;

function initThinqTab() {
  // Location filter pills
  document.querySelectorAll('.thinq-loc-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      _thinqSelectedLocation = pill.dataset.loc || 'all';
      try { localStorage.setItem('thinq_selected_location', _thinqSelectedLocation); } catch {}
      document.querySelectorAll('.thinq-loc-pill').forEach(p => {
        p.classList.toggle('on', p.dataset.loc === _thinqSelectedLocation);
      });
      renderThinqTab();
    });
  });

  // Manual Poll Button
  $('thinq-tab-poll-btn')?.addEventListener('click', async () => {
    const btn = $('thinq-tab-poll-btn');
    if (btn) { btn.disabled = true; btn.classList.add('loading'); }
    try {
      const url = _thinqSelectedLocation !== 'all'
        ? `/api/thinq/poll?location_id=${encodeURIComponent(_thinqSelectedLocation)}`
        : '/api/thinq/poll';
      const r = await fetch(url, { method: 'POST' });
      if (r.ok) {
        const j = await r.json();
        _lastThinqPollTs = Date.now();
        if (j.devices) {
          lastThinqDevices = j.devices;
          if (lastStatus) lastStatus.thinq_devices = j.devices;
        }
        renderThinqTab(true);
      }
    } catch (e) {
      console.warn('ThinQ poll failed:', e);
    } finally {
      if (btn) { btn.disabled = false; btn.classList.remove('loading'); }
    }
  });

  // Go to Settings button from empty state
  $('thinq-go-settings-btn')?.addEventListener('click', () => {
    switchTab('settings');
    selectSettingsSubtab('integrations');
    const card = $('settings-card-thinq');
    if (card) {
      card.scrollIntoView({ behavior: 'smooth' });
      card.classList.remove('collapsed');
    }
  });
}

async function renderThinqTab(force = false) {
  const container = $('thinq-appliances-container');
  if (!container) return;

  // Initial fetch of devices if none cached yet
  if (!lastThinqDevices.length || force) {
    try {
      const r = await fetch('/api/thinq/devices');
      if (r.ok) {
        const j = await r.json();
        if (j.devices) {
          lastThinqDevices = j.devices;
          if (lastStatus) lastStatus.thinq_devices = j.devices;
        }
      }
    } catch (e) {
      console.warn('Failed to load ThinQ devices:', e);
    }
  }

  const devices = (lastStatus && lastStatus.thinq_devices) || lastThinqDevices || [];

  // Update Location pill active classes
  document.querySelectorAll('.thinq-loc-pill').forEach(p => {
    p.classList.toggle('on', p.dataset.loc === _thinqSelectedLocation);
  });

  // Update Last poll time
  const pollTimeEl = $('thinq-last-poll-time');
  if (pollTimeEl) {
    if (_lastThinqPollTs) {
      const elapsedM = Math.max(0, Math.round((Date.now() - _lastThinqPollTs) / 60000));
      pollTimeEl.textContent = elapsedM === 0 ? 'Last update: just now' : `Last update: ${elapsedM}m ago`;
    } else if (devices.length) {
      pollTimeEl.textContent = 'Last update: active';
    } else {
      pollTimeEl.textContent = 'Last update: —';
    }
  }

  // Filter appliances based on chosen location
  const locFilter = _thinqSelectedLocation;
  const filtered = (locFilter === 'all')
    ? devices
    : devices.filter(d => (d.location_id || '').toLowerCase() === locFilter.toLowerCase());

  // Update KPI counters
  const totalEl = $('thinq-kpi-total');
  const activeEl = $('thinq-kpi-active');
  const refrigEl = $('thinq-kpi-refrig');
  const cookingEl = $('thinq-kpi-cooking');

  const activeCount = filtered.filter(d => d.is_running || d.is_cooking).length;
  const refrigList = filtered.filter(d => d.category === 'refrigeration');
  const anyDoorOpen = refrigList.some(d => d.door_opened);
  const cookingCount = filtered.filter(d => d.category === 'cooking' || d.category === 'dishwasher').length;

  if (totalEl) totalEl.textContent = String(filtered.length);
  if (activeEl) {
    activeEl.textContent = String(activeCount);
    activeEl.style.color = activeCount > 0 ? '#3b82f6' : 'var(--text)';
  }
  if (refrigEl) {
    if (anyDoorOpen) {
      refrigEl.textContent = 'Door Ajar ⚠️';
      refrigEl.style.color = '#ef4444';
    } else if (refrigList.length > 0) {
      refrigEl.textContent = `${refrigList.length} Unit(s) OK`;
      refrigEl.style.color = '#10b981';
    } else {
      refrigEl.textContent = '—';
      refrigEl.style.color = 'var(--text)';
    }
  }
  if (cookingEl) cookingEl.textContent = String(cookingCount);

  // If no appliances at all, show empty card
  const emptyEl = $('thinq-empty');
  if (filtered.length === 0) {
    if (emptyEl) emptyEl.hidden = false;
    container.innerHTML = '';
    return;
  }
  if (emptyEl) emptyEl.hidden = true;

  // Group appliances by category
  const categories = [
    { key: 'laundry', title: 'Laundry', icon: '🧺', items: filtered.filter(d => d.category === 'laundry') },
    { key: 'refrigeration', title: 'Refrigeration', icon: '🧊', items: filtered.filter(d => d.category === 'refrigeration') },
    { key: 'cooking', title: 'Cooking & Kitchen', icon: '🍳', items: filtered.filter(d => d.category === 'cooking') },
    { key: 'other', title: 'Dishwashers & Climate', icon: '🍽️', items: filtered.filter(d => d.category !== 'laundry' && d.category !== 'refrigeration' && d.category !== 'cooking') },
  ];

  let html = '';
  for (const cat of categories) {
    if (!cat.items.length) continue;
    html += `
      <section class="thinq-category-section">
        <div class="thinq-category-header">
          <h3 class="thinq-category-title">
            <span>${cat.icon}</span>
            <span>${escapeHtml(cat.title)}</span>
            <span class="thinq-category-badge">${cat.items.length}</span>
          </h3>
        </div>
        <div class="thinq-devices-grid">
    `;

    for (const d of cat.items) {
      html += renderThinqApplianceCard(d);
    }

    html += `
        </div>
      </section>
    `;
  }

  container.innerHTML = html;
}

function renderThinqApplianceCard(d) {
  const isOnline = d.online !== false;
  const isRunning = !!(d.is_running || d.is_cooking);
  const locLabel = (d.location_name || d.location_id || 'Home').toUpperCase();
  const cardClasses = ['thinq-card'];
  if (isRunning) cardClasses.push('is-active');
  if (d.door_opened) cardClasses.push('door-alert');

  let bodyHtml = '';

  if (d.category === 'laundry') {
    const cycle = d.run_state || 'STANDBY';
    const step = d.current_step || d.course || 'Ready';
    let timeDisplay = '—';
    if (d.remaining_min != null && d.remaining_min > 0) {
      const h = Math.floor(d.remaining_min / 60);
      const m = d.remaining_min % 60;
      timeDisplay = h > 0 ? `${h}h ${m}m` : `${m}m`;
    }

    bodyHtml = `
      <div class="thinq-stats-grid">
        <div class="thinq-stat-item">
          <span class="thinq-stat-label">Cycle State</span>
          <span class="thinq-stat-value" style="color:${isRunning ? '#3b82f6' : 'var(--text)'}">${escapeHtml(cycle)}</span>
        </div>
        <div class="thinq-stat-item">
          <span class="thinq-stat-label">Remaining Time</span>
          <span class="thinq-stat-value" style="color:${isRunning ? 'var(--primary)' : 'var(--text)'}">${timeDisplay}</span>
        </div>
        <div class="thinq-stat-item">
          <span class="thinq-stat-label">Sub-process / Step</span>
          <span class="thinq-stat-value">${escapeHtml(step)}</span>
        </div>
        <div class="thinq-stat-item">
          <span class="thinq-stat-label">Door Status</span>
          <span class="thinq-stat-value">${d.door_locked ? '🔒 Locked' : 'Unlocked'}</span>
        </div>
      </div>
    `;
  } else if (d.category === 'refrigeration') {
    const isF = getTempUnit() === 'F';
    const fridgeStr = isF && d.fridge_temp_f != null
      ? `${d.fridge_temp_f}°F`
      : (d.fridge_temp_c != null ? formatTemp(d.fridge_temp_c, 0) : '—');
    const freezerStr = isF && d.freezer_temp_f != null
      ? `${d.freezer_temp_f}°F`
      : (d.freezer_temp_c != null ? formatTemp(d.freezer_temp_c, 0) : '—');

    bodyHtml = `
      ${d.door_opened ? `
        <div class="thinq-door-warning">
          <span>⚠️</span> <span>Door is currently OPEN / AJAR</span>
        </div>
      ` : ''}
      <div class="thinq-stats-grid">
        <div class="thinq-stat-item">
          <span class="thinq-stat-label">Fridge Compartment</span>
          <span class="thinq-stat-value">${fridgeStr}</span>
        </div>
        <div class="thinq-stat-item">
          <span class="thinq-stat-label">Freezer Compartment</span>
          <span class="thinq-stat-value">${freezerStr}</span>
        </div>
        <div class="thinq-stat-item">
          <span class="thinq-stat-label">Express Freeze</span>
          <span class="thinq-stat-value" style="color:${d.express_freeze ? '#3b82f6' : 'var(--text-dim)'}">
            ${d.express_freeze ? '❄️ Active' : 'Off'}
          </span>
        </div>
        <div class="thinq-stat-item">
          <span class="thinq-stat-label">Eco Mode</span>
          <span class="thinq-stat-value">${d.eco_friendly ? '🌿 Eco Active' : 'Standard'}</span>
        </div>
      </div>
      <div class="thinq-controls-row">
        <button type="button" class="btn btn-ghost btn-tiny" onclick="toggleThinqExpressFreeze('${escapeHtml(d.device_id)}', '${escapeHtml(d.location_id)}', ${!d.express_freeze})">
          ${d.express_freeze ? 'Stop Express Freeze' : '❄️ Start Express Freeze'}
        </button>
      </div>
    `;
  } else if (d.category === 'cooking') {
    if (d.sub_zones && d.sub_zones.length > 0) {
      const isOven = d.sub_zones.some(z => z.zone_type === 'cavity');
      if (isOven) {
        // Multi-cavity oven (e.g. Upper & Lower cavities)
        let cavitiesHtml = '<div class="thinq-oven-cavities">';
        for (const c of d.sub_zones) {
          const cTarget = c.target_temp_c != null ? formatTemp(c.target_temp_c, 0) : '—';
          let cCurrent = c.current_temp_c != null ? formatTemp(c.current_temp_c, 0) : '—';
          if (cCurrent === '—') {
            if (c.state === 'PREHEATING') {
              cCurrent = 'Preheating…';
            } else if ((c.state === 'COOKING_IN_PROGRESS' || c.is_active) && c.target_temp_c != null) {
              cCurrent = formatTemp(c.target_temp_c, 0);
            }
          }
          let cTimer = '—';
          if (c.remaining_min != null && c.remaining_min > 0) {
            const h = Math.floor(c.remaining_min / 60);
            const m = c.remaining_min % 60;
            cTimer = h > 0 ? `${h}h ${m}m` : `${m}m`;
          }

          let cState = c.state || (c.is_active ? 'ON' : 'OFF');
          if (c.cook_mode && (cState === 'COOKING_IN_PROGRESS' || cState === 'COOKING')) {
            cState = c.cook_mode.charAt(0).toUpperCase() + c.cook_mode.slice(1).toLowerCase();
          } else if (cState === 'COOKING_IN_PROGRESS') {
            cState = c.target_temp_c != null ? 'Baking' : 'Active';
          } else if (cState === 'PREHEATING') {
            cState = 'Preheating';
          } else if (cState === 'INITIAL') {
            cState = 'Off';
          }

          cavitiesHtml += `
            <div class="thinq-cavity-card ${c.is_active ? 'is-active' : ''}">
              <div class="thinq-cavity-header">
                <span class="thinq-cavity-title">🔲 ${escapeHtml(c.name)}</span>
                <span class="thinq-pill ${c.is_active ? 'pill-active' : 'pill-offline'}">${c.is_active ? escapeHtml(cState) : 'OFF'}</span>
              </div>
              <div class="thinq-cavity-grid">
                <div class="thinq-stat-item">
                  <span class="thinq-stat-label">Target</span>
                  <span class="thinq-stat-value">${cTarget}</span>
                </div>
                <div class="thinq-stat-item">
                  <span class="thinq-stat-label">Current</span>
                  <span class="thinq-stat-value" style="color:${c.is_active ? '#22c55e' : 'var(--text)'}">${cCurrent}</span>
                </div>
                <div class="thinq-stat-item">
                  <span class="thinq-stat-label">Timer</span>
                  <span class="thinq-stat-value" style="color:${c.remaining_min ? '#f59e0b' : 'var(--text)'}">${c.remaining_min ? '⏱ ' + cTimer : '—'}</span>
                </div>
              </div>
            </div>
          `;
        }
        cavitiesHtml += '</div>';
        bodyHtml = cavitiesHtml;
      } else {
        // Multi-zone cooktop (e.g. 5 induction burners)
        let cooktopHtml = '<div class="thinq-cooktop-container">';
        cooktopHtml += '<div class="thinq-cooktop-grid">';
        for (const b of d.sub_zones) {
          let bTimer = '';
          if (b.remaining_min != null && b.remaining_min > 0) {
            const h = Math.floor(b.remaining_min / 60);
            const m = b.remaining_min % 60;
            bTimer = h > 0 ? `${h}h ${m}m` : `${m}m`;
          }
          cooktopHtml += `
            <div class="thinq-burner-card ${b.is_active ? 'is-active' : ''}">
              <div class="thinq-burner-icon">${b.is_active ? '🔥' : '⭕'}</div>
              <div class="thinq-burner-name">${escapeHtml(b.name)}</div>
              <div class="thinq-burner-power" style="color:${b.is_active ? '#f97316' : 'var(--text-dim)'}">
                ${b.power_level > 0 ? `Level ${b.power_level}` : (b.is_active ? escapeHtml(b.state) : 'Off')}
              </div>
              ${b.remaining_min ? `<div class="thinq-burner-timer">⏱ ${bTimer}</div>` : ''}
            </div>
          `;
        }
        cooktopHtml += '</div></div>';
        bodyHtml = cooktopHtml;
      }
    } else {
      // Single zone / fallback
      let cookState = d.run_state || 'OFF';
      if (cookState === 'COOKING_IN_PROGRESS') {
        cookState = 'Cooking';
      } else if (cookState === 'PREHEATING') {
        cookState = 'Preheating';
      }
      const targetStr = d.target_temp_c != null ? formatTemp(d.target_temp_c, 0) : '—';
      let currentStr = d.current_temp_c != null ? formatTemp(d.current_temp_c, 0) : '—';
      if (currentStr === '—') {
        if (d.run_state === 'PREHEATING') {
          currentStr = 'Preheating…';
        } else if ((d.run_state === 'COOKING_IN_PROGRESS' || d.is_cooking) && d.target_temp_c != null) {
          currentStr = formatTemp(d.target_temp_c, 0);
        }
      }
      let timeDisplay = '—';
      if (d.remaining_min != null && d.remaining_min > 0) {
        const h = Math.floor(d.remaining_min / 60);
        const m = d.remaining_min % 60;
        timeDisplay = h > 0 ? `${h}h ${m}m` : `${m}m`;
      }

      bodyHtml = `
        <div class="thinq-stats-grid">
          <div class="thinq-stat-item">
            <span class="thinq-stat-label">Operation</span>
            <span class="thinq-stat-value" style="color:${d.is_cooking ? '#f59e0b' : 'var(--text)'}">${escapeHtml(cookState)}</span>
          </div>
          <div class="thinq-stat-item">
            <span class="thinq-stat-label">Target Temp</span>
            <span class="thinq-stat-value">${targetStr}</span>
          </div>
          <div class="thinq-stat-item">
            <span class="thinq-stat-label">Current Cavity</span>
            <span class="thinq-stat-value" style="color:${d.is_cooking ? '#22c55e' : 'var(--text)'}">${currentStr}</span>
          </div>
          <div class="thinq-stat-item">
            <span class="thinq-stat-label">Timer</span>
            <span class="thinq-stat-value">${timeDisplay}</span>
          </div>
        </div>
      `;
    }
  } else {
    // Dishwasher / Climate / Other
    const stateStr = d.run_state || 'STANDBY';
    let timeDisplay = '—';
    if (d.remaining_min != null && d.remaining_min > 0) {
      const h = Math.floor(d.remaining_min / 60);
      const m = d.remaining_min % 60;
      timeDisplay = h > 0 ? `${h}h ${m}m` : `${m}m`;
    }

    bodyHtml = `
      <div class="thinq-stats-grid">
        <div class="thinq-stat-item">
          <span class="thinq-stat-label">Status</span>
          <span class="thinq-stat-value">${escapeHtml(stateStr)}</span>
        </div>
        <div class="thinq-stat-item">
          <span class="thinq-stat-label">Remaining Time</span>
          <span class="thinq-stat-value">${timeDisplay}</span>
        </div>
      </div>
    `;
  }

  return `
    <div class="${cardClasses.join(' ')}" id="card-${escapeHtml(d.device_sn)}">
      <div class="thinq-card-header">
        <div class="thinq-card-title-group">
          <h4 class="thinq-card-name">${escapeHtml(d.name || d.device_sn)}</h4>
          <span class="thinq-card-meta">
            <span>${escapeHtml(locLabel)}</span>
            <span>•</span>
            <span>${escapeHtml(d.model_name || d.raw_type || 'ThinQ')}</span>
          </span>
        </div>
        <div class="thinq-card-badges">
          ${isRunning ? '<span class="thinq-pill pill-active">Active</span>' : ''}
          <span class="thinq-pill ${isOnline ? 'pill-online' : 'pill-offline'}">${isOnline ? 'ONLINE' : 'OFFLINE'}</span>
        </div>
      </div>
      <div class="thinq-card-body">
        ${bodyHtml}
      </div>
    </div>
  `;
}

async function toggleThinqExpressFreeze(deviceId, locationId, turnOn) {
  try {
    const payload = {
      refrigeration: {
        expressFreeze: turnOn ? 'START' : 'STOP'
      }
    };
    const res = await fetch(`/api/thinq/device/${encodeURIComponent(deviceId)}/control`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        location_id: locationId,
        payload: payload,
      }),
    });
    if (res.ok) {
      setTimeout(() => renderThinqTab(true), 1500);
    } else {
      const err = await res.json();
      alert(`Control failed: ${err.detail || 'Could not update Express Freeze'}`);
    }
  } catch (e) {
    alert(`Network error: ${e.message}`);
  }
}

async function loadThinqCreds() {
  const statusEl = $('thinq-creds-status');
  try {
    const res = await fetch('/api/thinq/credentials');
    if (!res.ok) return;
    const data = await res.json();
    lastThinqCredsStatus = data;

    if (statusEl) {
      if (data.saved) {
        const names = (data.configured || []).map(c => c.charAt(0).toUpperCase() + c.slice(1)).join(', ');
        statusEl.textContent = `Configured (${names})`;
        statusEl.style.color = 'var(--text-success,#10b981)';
      } else {
        statusEl.textContent = 'Not configured';
        statusEl.style.color = 'var(--text-dim,#94a3b8)';
      }
    }

    syncThinqCredsForm();
  } catch (e) {
    console.warn('Failed to load ThinQ credentials:', e);
  }
}

function syncThinqCredsForm() {
  const locIndicator = $('thinq-creds-loc-indicator');
  const locTitle = _thinqCredsLoc.charAt(0).toUpperCase() + _thinqCredsLoc.slice(1);
  if (locIndicator) locIndicator.textContent = `${locTitle} credentials`;

  document.querySelectorAll('.thinq-creds-loc-pill').forEach(pill => {
    pill.classList.toggle('on', pill.dataset.loc === _thinqCredsLoc);
  });

  const tokenIn = $('thinq-token');
  const countryIn = $('thinq-country');
  const locData = (lastThinqCredsStatus && lastThinqCredsStatus.locations) ? lastThinqCredsStatus.locations[_thinqCredsLoc] : null;

  if (locData && locData.saved) {
    if (tokenIn) {
      tokenIn.value = '';
      tokenIn.placeholder = `Token saved (${locData.masked_token || '••••••••'})`;
    }
    if (countryIn && locData.country) countryIn.value = locData.country;
  } else {
    if (tokenIn) {
      tokenIn.value = '';
      tokenIn.placeholder = 'Paste your LG PAT here...';
    }
  }
}

function initThinqSettings() {
  // Location selector pills in Settings
  document.querySelectorAll('.thinq-creds-loc-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      _thinqCredsLoc = pill.dataset.loc || 'maison';
      syncThinqCredsForm();
    });
  });

  const form = $('thinq-creds-form');
  const msg = $('thinq-msg');
  const saveBtn = $('thinq-save-btn');
  const clearBtn = $('thinq-clear-btn');
  const pollBtn = $('thinq-poll-btn');

  function showMsg(text, isError = false, timeoutMs = 6000) {
    if (!msg) return;
    msg.textContent = text;
    msg.style.color = isError ? 'var(--text-danger, #ef4444)' : 'var(--text-success, #10b981)';
    msg.hidden = false;
    if (timeoutMs > 0) setTimeout(() => { msg.hidden = true; }, timeoutMs);
  }

  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const rawToken = ($('thinq-token')?.value || '').trim();
    const token = rawToken.replace(/^(?:PAT_TOKEN|token|pat)\s*=\s*/i, '').replace(/^["']|["']$/g, '').trim();
    const country = ($('thinq-country')?.value || 'CA').trim();

    if (!token) {
      showMsg('Please enter your LG Personal Access Token (PAT)', true);
      return;
    }

    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Verifying…'; }
    showMsg('Contacting LG ThinQ API to verify token…', false, 0);

    try {
      const res = await fetch('/api/thinq/credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          location_id: _thinqCredsLoc,
          token: token,
          country: country,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        showMsg(`✓ Verified & saved! Found ${data.device_count || 0} appliance(s).`);
        $('thinq-token').value = '';
        await loadThinqCreds();
        renderThinqTab(true);
      } else {
        showMsg(`Error: ${data.detail || 'Verification failed'}`, true);
      }
    } catch (err) {
      showMsg(`Network error: ${err.message}`, true);
    } finally {
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Verify & Save'; }
    }
  });

  clearBtn?.addEventListener('click', async () => {
    const locTitle = _thinqCredsLoc.charAt(0).toUpperCase() + _thinqCredsLoc.slice(1);
    if (!confirm(`Forget ThinQ credentials for ${locTitle}?`)) return;

    try {
      const res = await fetch(`/api/thinq/credentials?location_id=${encodeURIComponent(_thinqCredsLoc)}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        showMsg(`Cleared ThinQ credentials for ${locTitle}`);
        await loadThinqCreds();
        renderThinqTab(true);
      } else {
        showMsg('Failed to clear credentials', true);
      }
    } catch (err) {
      showMsg(`Network error: ${err.message}`, true);
    }
  });

  pollBtn?.addEventListener('click', async () => {
    if (pollBtn) { pollBtn.disabled = true; pollBtn.textContent = 'Polling…'; }
    showMsg('Polling LG ThinQ appliances…', false, 0);

    try {
      const res = await fetch(`/api/thinq/poll?location_id=${encodeURIComponent(_thinqCredsLoc)}`, {
        method: 'POST',
      });
      const data = await res.json();
      if (res.ok) {
        const count = (data.devices || []).length;
        showMsg(`✓ Poll completed! Discovered ${count} appliance(s).`);
        if (data.devices) {
          lastThinqDevices = data.devices;
          if (lastStatus) lastStatus.thinq_devices = data.devices;
        }
        renderThinqTab(true);
      } else {
        showMsg(`Poll error: ${data.detail || 'Failed to poll appliances'}`, true);
      }
    } catch (err) {
      showMsg(`Network error: ${err.message}`, true);
    } finally {
      if (pollBtn) { pollBtn.disabled = false; pollBtn.textContent = 'Poll now'; }
    }
  });
}


// ============================================================
// DANBY / MIDEA SMART DEHUMIDIFIERS TAB & CONTROLS
// ============================================================
let lastMideaDevices = [];
let _mideaSelectedLocation = localStorage.getItem('midea_selected_location') || 'all';
let _mideaCredsLoc = 'maison';
let _lastMideaPollTs = 0;
let lastMideaCredsStatus = null;

function initMideaTab() {
  // Location filter pills
  document.querySelectorAll('.midea-loc-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      _mideaSelectedLocation = pill.dataset.loc || 'all';
      try { localStorage.setItem('midea_selected_location', _mideaSelectedLocation); } catch {}
      document.querySelectorAll('.midea-loc-pill').forEach(p => {
        p.classList.toggle('on', p.dataset.loc === _mideaSelectedLocation);
      });
      renderMideaTab();
    });
  });

  // Manual Poll Button
  $('midea-tab-poll-btn')?.addEventListener('click', async () => {
    const btn = $('midea-tab-poll-btn');
    if (btn) { btn.disabled = true; btn.classList.add('loading'); }
    try {
      const r = await fetch('/api/midea/poll', { method: 'POST' });
      if (r.ok) {
        const j = await r.json();
        _lastMideaPollTs = Date.now();
        if (j.devices) {
          lastMideaDevices = j.devices;
          if (lastStatus) lastStatus.midea_devices = j.devices;
        }
        renderMideaTab(true);
      }
    } catch (e) {
      console.warn('Midea poll failed:', e);
    } finally {
      if (btn) { btn.disabled = false; btn.classList.remove('loading'); }
    }
  });

  // Go to Settings button from empty state
  $('midea-go-settings-btn')?.addEventListener('click', () => {
    switchTab('settings');
    selectSettingsSubtab('integrations');
    const card = $('settings-card-midea');
    if (card) {
      card.scrollIntoView({ behavior: 'smooth' });
      card.classList.remove('collapsed');
    }
  });
}

let _mideaDevHours = {};              // devId -> hours (default 24)
let _mideaDevHistData = {};           // `${devId}_${hours}` -> { ts, data, summary }
let _mideaOpenDeviceHistories = new Set(); // devId
let _mideaOpenDeviceSchedules = new Set(); // devId
let _mideaDeviceSchedules = {};       // devId -> schedule
let _mideaResizeBound = false;
let _mideaLastRenderedSignature = null;

const MIDEA_COMMON_TIMEZONES = [
  { id: 'America/Toronto', label: 'America/Toronto (Montréal / Toronto / HNE)' },
  { id: 'America/New_York', label: 'America/New_York (Eastern Time)' },
  { id: 'America/Chicago', label: 'America/Chicago (Central Time)' },
  { id: 'America/Denver', label: 'America/Denver (Mountain Time)' },
  { id: 'America/Los_Angeles', label: 'America/Los_Angeles (Pacific Time)' },
  { id: 'America/Vancouver', label: 'America/Vancouver (Pacific Time)' },
  { id: 'America/Halifax', label: 'America/Halifax (Atlantic Time)' },
  { id: 'America/St_Johns', label: 'America/St_Johns (Newfoundland Time)' },
  { id: 'Europe/Paris', label: 'Europe/Paris (Heure de Paris)' },
  { id: 'UTC', label: 'UTC (Temps universel)' },
];

function drawMideaDeviceChart(devId, hist, hours, summary) {
  const canvas = $('chart-midea-dev-' + devId);
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  if (rect.width <= 10) return;

  const { ctx, w, h } = setCanvasSize(canvas);
  ctx.clearRect(0, 0, w, h);

  const padL = 44, padR = 24, padT = 16, padB = 26;

  if (!hist || !hist.length) {
    drawAxes(ctx, w, h, padL, padR, padT, padB);
    ctx.fillStyle = '#94a3b8';
    ctx.font = '12px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Accumulation de l\'historique Danby… (1 pt/min)', w / 2, h / 2);
    return;
  }

  let plotHist = hist;
  if (hist.length === 1) {
    const single = hist[0];
    plotHist = [{ ...single, ts: single.ts - 300 }, single];
  }

  const curHums = plotHist.map(r => (r.current_humidity != null ? r.current_humidity : null));
  const tgtHums = plotHist.map(r => (r.target_humidity != null ? r.target_humidity : null));

  const allHums = [...curHums, ...tgtHums].filter(v => v != null && Number.isFinite(v));
  let minH = 20, maxH = 80;
  if (allHums.length > 0) {
    minH = Math.max(10, Math.floor(Math.min(...allHums) / 5) * 5 - 5);
    maxH = Math.min(100, Math.ceil(Math.max(...allHums) / 5) * 5 + 5);
    if (maxH - minH < 20) {
      maxH = Math.min(100, minH + 25);
    }
  }

  const xs = (i) => padL + (i / Math.max(1, plotHist.length - 1)) * (w - padL - padR);
  const yHum = (v) => (h - padB) - ((v - minH) / (maxH - minH)) * (h - padT - padB);
  const baseY = h - padB;

  // 1. Draw Operational State background vertical bands
  for (let i = 0; i < plotHist.length; i++) {
    const p = plotHist[i];
    const st = p.equipment_status;
    let fillColor = null;
    if (st === 1) {
      fillColor = 'rgba(14, 165, 233, 0.22)'; // Blue - compressor active
    } else if (st === 2) {
      fillColor = 'rgba(20, 184, 166, 0.18)'; // Teal - fan only
    } else if (st === 3) {
      fillColor = 'rgba(245, 158, 11, 0.20)'; // Amber - defrost
    } else if (st === 4) {
      fillColor = 'rgba(239, 68, 68, 0.22)'; // Red - tank full
    } else {
      fillColor = 'rgba(15, 23, 42, 0.35)'; // Off
    }

    const x1 = (i === 0) ? padL : (xs(i - 1) + xs(i)) / 2;
    const x2 = (i === plotHist.length - 1) ? (w - padR) : (xs(i) + xs(i + 1)) / 2;
    ctx.fillStyle = fillColor;
    ctx.fillRect(x1, padT, Math.max(1, x2 - x1), h - padT - padB);
  }

  // 2. Gridlines & Axes
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
  ctx.lineWidth = 1;
  const numSteps = 4;
  for (let i = 1; i <= numSteps; i++) {
    const y = padT + ((h - padT - padB) * i) / numSteps;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
  }
  drawAxes(ctx, w, h, padL, padR, padT, padB);

  // 3. Y-axis labels (% Humidity)
  ctx.fillStyle = '#94a3b8';
  ctx.font = '10px Inter, sans-serif';
  ctx.textAlign = 'right';
  for (let i = 0; i <= numSteps; i++) {
    const v = minH + ((maxH - minH) * (numSteps - i)) / numSteps;
    const y = padT + ((h - padT - padB) * i) / numSteps;
    ctx.fillText(`${Math.round(v)}%`, padL - 5, y + 3);
  }

  // 4. X-axis time ticks
  if (plotHist.length >= 2) {
    const first = plotHist[0].ts || 0, last = plotHist[plotHist.length - 1].ts || 0;
    const spanH = (last - first) / 3600;
    ctx.fillStyle = '#94a3b8';
    ctx.textAlign = 'center';
    const ticks = Math.min(4, plotHist.length - 1);
    for (let i = 0; i <= ticks; i++) {
      const idx = Math.round((plotHist.length - 1) * (i / ticks));
      const ts = plotHist[idx].ts || (first + (last - first) * (i / ticks));
      const d = new Date(ts * 1000);
      const str = (spanH > 24)
        ? (d.toLocaleDateString([], { month: 'numeric', day: 'numeric' }) + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))
        : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      ctx.fillText(str, xs(idx), h - 7);
    }
    ctx.textAlign = 'start';
  }

  // 5. Traces:
  // Trace A: Target humidity (Emerald dashed line)
  const hasTarget = tgtHums.some(v => v != null && Number.isFinite(v));
  if (hasTarget) {
    ctx.save();
    ctx.setLineDash([4, 4]);
    drawSmoothLine(ctx, tgtHums, xs, yHum, '#10b981', 1.8);
    ctx.restore();
  }

  // Trace B: Current ambient humidity (Sky blue area fill + line)
  const hasCur = curHums.some(v => v != null && Number.isFinite(v));
  if (hasCur) {
    drawAreaFill(ctx, curHums, xs, yHum, baseY, '#38bdf8', 0.12);
    drawSmoothLine(ctx, curHums, xs, yHum, '#38bdf8', 2.2);
  }

  canvas._redraw = () => drawMideaDeviceChart(devId, hist, hours, summary);

  const statusLabels = {
    0: 'Arrêt',
    1: '💧 Déshumidification (Compresseur actif)',
    2: '🌪️ Ventilation seule',
    3: '❄️ Dégivrage',
    4: '⚠️ Bac plein',
  };

  _attachChartHover(canvas, plotHist, (idx) => {
    const p = plotHist[idx];
    if (!p) return '';
    const d = new Date(p.ts * 1000);
    const tsStr = d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }) + ' ' +
                  d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const curH = p.current_humidity != null ? `${Math.round(p.current_humidity)}%` : '—';
    const tgtH = p.target_humidity != null ? `${Math.round(p.target_humidity)}%` : '—';
    const stLabel = statusLabels[p.equipment_status] || 'Inconnu';
    const tempStr = p.temp_c != null ? `${p.temp_c.toFixed(1)}°C` : '';

    let rows = `
      <div class="cht-ts">${escapeHtml(tsStr)}</div>
      <div class="cht-row"><i style="background:#38bdf8; border-radius:50%"></i> Humidité ambiante: <b>${curH}</b></div>
      <div class="cht-row"><i style="background:#10b981"></i> Consigne cible: <b>${tgtH}</b></div>
      <div class="cht-row">État: <b>${escapeHtml(stLabel)}</b></div>
    `;
    if (p.power_w) {
      rows += `<div class="cht-row"><i style="background:#fbbf24"></i> Puissance est.: <b>${Math.round(p.power_w)} W</b></div>`;
    }
    if (tempStr) {
      rows += `<div class="cht-row">Température: <b>${escapeHtml(tempStr)}</b></div>`;
    }
    return rows;
  }, () => ({ xs, padL, padR, w, h, baseY, padT, padB }));
}

async function loadAndDrawMideaDeviceChart(devId, force = false) {
  const hours = _mideaDevHours[devId] || 24;
  const cacheKey = `${devId}_${hours}`;
  const now = Date.now();
  let histData = null;

  if (!force && _mideaDevHistData[cacheKey] && (now - _mideaDevHistData[cacheKey].ts < 45000)) {
    histData = _mideaDevHistData[cacheKey];
  } else {
    try {
      const r = await fetch(`/api/midea/history/device?device_sn=midea_${encodeURIComponent(devId)}&hours=${hours}`);
      if (r.ok) {
        const j = await r.json();
        histData = { ts: now, data: j.history || [], summary: j.summary || {} };
        _mideaDevHistData[cacheKey] = histData;
      }
    } catch (e) {
      console.warn('Failed to load Midea device history:', e);
    }
  }

  if (histData) {
    drawMideaDeviceChart(devId, histData.data, hours, histData.summary);
    updateMideaRuntimeChips(devId, histData.summary);
  }
}

function updateMideaRuntimeChips(devId, summary) {
  const compEl = $(`midea-rt-comp-${devId}`);
  const fanEl = $(`midea-rt-fan-${devId}`);
  const offEl = $(`midea-rt-off-${devId}`);
  const kwhEl = $(`midea-rt-kwh-${devId}`);

  if (!summary) return;
  const compMin = summary.compressor_min || 0;
  const fanMin = summary.fan_only_min || 0;
  const offMin = summary.off_min || 0;
  const kwh = summary.energy_kwh != null ? summary.energy_kwh : 0;

  const fmtMin = (m) => {
    const h = Math.floor(m / 60);
    const rem = m % 60;
    return h > 0 ? `${h}h ${rem}m` : `${rem}m`;
  };

  if (compEl) compEl.textContent = fmtMin(compMin);
  if (fanEl) fanEl.textContent = fmtMin(fanMin);
  if (offEl) offEl.textContent = fmtMin(offMin);
  if (kwhEl) kwhEl.textContent = `${kwh.toFixed(2)} kWh`;
}

async function loadMideaDeviceSchedule(devId, force = false) {
  if (!force && _mideaDeviceSchedules[devId]) {
    renderMideaScheduleEditor(devId, _mideaDeviceSchedules[devId]);
    return;
  }
  try {
    const r = await fetch(`/api/midea/device/${encodeURIComponent(devId)}/schedule`);
    if (r.ok) {
      const j = await r.json();
      _mideaDeviceSchedules[devId] = j;
      renderMideaScheduleEditor(devId, j);
    }
  } catch (e) {
    console.warn('Failed to load Midea schedule:', e);
  }
}

function collectMideaEventsFromDom(devId) {
  const box = $(`midea-sched-body-${devId}`);
  if (!box) return [];
  const rows = box.querySelectorAll('.midea-sched-event-row');
  const evs = [];
  rows.forEach((row, idx) => {
    const id = row.dataset.id || `evt_${Math.random().toString(36).substring(2, 9)}`;
    const en = row.querySelector('.midea-ev-en-cb')?.checked ?? true;
    const name = row.querySelector('.midea-ev-name-input')?.value?.trim() || `Événement ${idx + 1}`;
    const time = row.querySelector('.midea-ev-time-input')?.value?.trim() || '08:00';
    const power = row.querySelector('.midea-ev-power-select')?.value !== 'false';
    const target_humidity = parseInt(row.querySelector('.midea-ev-hum-input')?.value, 10) || 40;
    const fan_speed = parseInt(row.querySelector('.midea-ev-fan-select')?.value, 10) || 80;
    const mode = parseInt(row.querySelector('.midea-ev-mode-select')?.value, 10) || 2;
    const days = [];
    row.querySelectorAll('.midea-day-pill.on').forEach(p => {
      const d = parseInt(p.dataset.day, 10);
      if (d >= 1 && d <= 7) days.push(d);
    });
    evs.push({
      id,
      name,
      enabled: en,
      days: days.length ? days : [1, 2, 3, 4, 5, 6, 7],
      time,
      power,
      target_humidity: Math.max(30, Math.min(80, target_humidity)),
      fan_speed: fan_speed >= 70 ? 80 : 40,
      mode: mode === 2 ? 2 : 1,
    });
  });
  return evs;
}

async function saveMideaDeviceSchedule(devId, btn = null) {
  const box = $(`midea-sched-body-${devId}`);
  if (!box) return;

  const enCb = $(`midea-sched-en-${devId}`);
  const tzSel = $(`midea-sched-tz-${devId}`);
  const isEnabled = enCb ? enCb.checked : false;
  const timezone = tzSel ? tzSel.value : 'America/Toronto';
  const events = collectMideaEventsFromDom(devId);

  const payload = {
    timezone: timezone,
    schedule_enabled: isEnabled,
    events: events,
  };

  const origText = btn ? btn.textContent : '';
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Enregistrement…';
  }

  try {
    const res = await fetch(`/api/midea/device/${encodeURIComponent(devId)}/schedule`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (res.ok) {
      const saved = await res.json();
      _mideaDeviceSchedules[devId] = saved;

      for (const d of lastMideaDevices) {
        if (String(d.device_id) === String(devId)) {
          d.schedule_enabled = isEnabled;
          d.schedule_events_count = events.length;
          break;
        }
      }

      renderMideaEventsList(devId, saved.events || events);

      if (btn) {
        btn.textContent = '✓ Enregistré !';
        btn.style.background = 'var(--accent, #10b981)';
        setTimeout(() => {
          btn.textContent = origText || '💾 Enregistrer la planification';
          btn.style.background = '';
          btn.disabled = false;
        }, 2000);
      }

      const badgeEl = $(`midea-sched-badge-${devId}`);
      if (badgeEl) {
        badgeEl.textContent = isEnabled ? `✓ Actif (${events.length} événement${events.length > 1 ? 's' : ''})` : 'Désactivé';
        badgeEl.style.color = isEnabled ? 'var(--accent, #10b981)' : 'var(--text-dim, #94a3b8)';
      }
    } else {
      const err = await res.json().catch(() => ({}));
      alert(`Erreur d'enregistrement: ${err.detail || 'Échec de la sauvegarde'}`);
      if (btn) {
        btn.textContent = origText;
        btn.disabled = false;
      }
    }
  } catch (e) {
    alert(`Erreur réseau: ${e.message}`);
    if (btn) {
      btn.textContent = origText;
      btn.disabled = false;
    }
  }
}

function getMideaEventsListHtml(devId, events) {
  const dayLabels = [
    { num: 1, label: 'Lun' },
    { num: 2, label: 'Mar' },
    { num: 3, label: 'Mer' },
    { num: 4, label: 'Jeu' },
    { num: 5, label: 'Ven' },
    { num: 6, label: 'Sam' },
    { num: 7, label: 'Dim' },
  ];

  if (!events || !events.length) {
    return `<div style="font-size:12px; color:var(--text-dim,#94a3b8); text-align:center; padding:14px; border:1px dashed rgba(255,255,255,0.12); border-radius:6px;">Aucun événement configuré. Cliquez sur "+ Ajouter un événement" pour démarrer.</div>`;
  }

  return events.map((ev, idx) => {
    const isEn = !!ev.enabled;
    const isPwr = ev.power !== false;
    const evDays = ev.days || [1, 2, 3, 4, 5, 6, 7];
    const evTime = ev.time || ev.start_time || '08:00';

    const dayPillsHtml = dayLabels.map(d =>
      `<span class="midea-day-pill ${evDays.includes(d.num) ? 'on' : ''}" data-day="${d.num}">${d.label}</span>`
    ).join('');

    return `
      <div class="midea-sched-event-row ${isEn ? '' : 'disabled'}" data-id="${escapeHtml(ev.id)}" data-idx="${idx}">
        <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap;">
          <div style="display:flex; align-items:center; gap:8px;">
            <input type="checkbox" class="midea-ev-en-cb" ${isEn ? 'checked' : ''} title="Activer cet événement" style="cursor:pointer;" />
            <input type="text" class="midea-ev-name-input" value="${escapeHtml(ev.name || `Événement ${idx + 1}`)}" placeholder="Nom de l'événement" style="background:transparent; border:none; border-bottom:1px solid rgba(255,255,255,0.15); color:var(--text,#fff); font-size:12px; font-weight:600; padding:2px 4px; width:130px;" />
          </div>

          <div style="display:flex; align-items:center; gap:6px;">
            <input type="time" class="midea-ev-time-input" value="${escapeHtml(evTime)}" style="background:var(--bg-card-sub, #1e293b); border:1px solid rgba(255,255,255,0.15); color:var(--text,#fff); font-size:12px; font-weight:600; padding:2px 6px; border-radius:4px;" />

            <select class="midea-ev-power-select" style="font-size:11px; padding:2px 6px; border-radius:4px; background:var(--bg-card-sub, #1e293b); border:1px solid rgba(255,255,255,0.15); color:var(--text,#fff);">
              <option value="true" ${isPwr ? 'selected' : ''}>▶️ Allumer</option>
              <option value="false" ${!isPwr ? 'selected' : ''}>⏹️ Arrêter</option>
            </select>

            <button type="button" class="btn btn-ghost btn-tiny midea-del-ev-btn" data-idx="${idx}" title="Supprimer cet événement" style="color:var(--red,#ef4444); padding:2px 6px;">🗑️</button>
          </div>
        </div>

        <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap; margin-top:4px;">
          <!-- Days pills -->
          <div class="midea-day-pills">
            ${dayPillsHtml}
          </div>

          <!-- Settings group when Allumer is selected -->
          <span class="midea-ev-settings-group" style="${isPwr ? 'display:inline-flex;' : 'display:none;'} align-items:center; gap:8px; font-size:11px;">
            <div style="display:flex; align-items:center; gap:4px;">
              <span style="color:var(--text-dim,#94a3b8);">Cible:</span>
              <input type="number" class="midea-ev-hum-input" min="30" max="80" step="5" value="${ev.target_humidity || 40}" style="width:48px; font-size:11px; padding:2px 4px; text-align:center; background:var(--bg-card-sub, #1e293b); border:1px solid rgba(255,255,255,0.15); color:var(--text,#fff); border-radius:4px;" />
              <span style="color:var(--text-dim,#94a3b8);">%</span>
            </div>

            <div style="display:flex; align-items:center; gap:4px;">
              <span style="color:var(--text-dim,#94a3b8);">Ventilation:</span>
              <select class="midea-ev-fan-select" style="font-size:11px; padding:2px 4px; border-radius:4px; background:var(--bg-card-sub, #1e293b); border:1px solid rgba(255,255,255,0.15); color:var(--text,#fff);">
                <option value="80" ${ev.fan_speed >= 70 ? 'selected' : ''}>Élevée (High)</option>
                <option value="40" ${ev.fan_speed < 70 ? 'selected' : ''}>Basse (Low)</option>
              </select>
            </div>

            <div style="display:flex; align-items:center; gap:4px;">
              <span style="color:var(--text-dim,#94a3b8);">Mode:</span>
              <select class="midea-ev-mode-select" style="font-size:11px; padding:2px 4px; border-radius:4px; background:var(--bg-card-sub, #1e293b); border:1px solid rgba(255,255,255,0.15); color:var(--text,#fff);">
                <option value="2" ${ev.mode === 2 ? 'selected' : ''}>Continu</option>
                <option value="1" ${ev.mode !== 2 ? 'selected' : ''}>Normal (Cible)</option>
              </select>
            </div>
          </span>
        </div>
      </div>
    `;
  }).join('');
}

function wireMideaEventsList(devId) {
  const listEl = $(`midea-events-list-${devId}`);
  if (!listEl) return;

  listEl.querySelectorAll('.midea-sched-event-row').forEach(row => {
    const idx = parseInt(row.dataset.idx, 10);

    row.querySelector('.midea-ev-en-cb')?.addEventListener('change', (e) => {
      row.classList.toggle('disabled', !e.target.checked);
    });

    row.querySelectorAll('.midea-day-pill').forEach(pill => {
      pill.addEventListener('click', () => {
        pill.classList.toggle('on');
      });
    });

    const pwrSel = row.querySelector('.midea-ev-power-select');
    const settingsGroup = row.querySelector('.midea-ev-settings-group');
    if (pwrSel && settingsGroup) {
      pwrSel.addEventListener('change', () => {
        const isTurnOn = pwrSel.value === 'true';
        settingsGroup.style.display = isTurnOn ? 'inline-flex' : 'none';
      });
    }

    row.querySelector('.midea-del-ev-btn')?.addEventListener('click', () => {
      const curEvents = collectMideaEventsFromDom(devId);
      curEvents.splice(idx, 1);
      renderMideaEventsList(devId, curEvents);
    });
  });
}

function renderMideaEventsList(devId, events) {
  const listEl = $(`midea-events-list-${devId}`);
  if (!listEl) return;
  listEl.innerHTML = getMideaEventsListHtml(devId, events);
  wireMideaEventsList(devId);
}

function getMideaScheduleEditorHtml(devId, sched) {
  const timezone = (sched && sched.timezone) || 'America/Toronto';
  const isEnabled = !!(sched && sched.schedule_enabled);
  const events = (sched && sched.events) || [];

  const tzOptions = MIDEA_COMMON_TIMEZONES.map(t =>
    `<option value="${escapeHtml(t.id)}" ${t.id === timezone ? 'selected' : ''}>${escapeHtml(t.label)}</option>`
  ).join('');

  return `
    <div class="midea-sched-top-row">
      <label style="display:flex; align-items:center; gap:8px; cursor:pointer; font-size:13px; font-weight:600;">
        <input type="checkbox" id="midea-sched-en-${escapeHtml(devId)}" ${isEnabled ? 'checked' : ''} style="width:16px; height:16px; cursor:pointer;" />
        <span>Activer la planification</span>
      </label>

      <div style="display:flex; align-items:center; gap:6px;">
        <span style="font-size:12px; color:var(--text-dim,#94a3b8);">Fuseau horaire:</span>
        <select id="midea-sched-tz-${escapeHtml(devId)}" class="midea-tz-select">
          ${tzOptions}
        </select>
      </div>
    </div>

    <div class="midea-sched-events-list" id="midea-events-list-${escapeHtml(devId)}">
      ${getMideaEventsListHtml(devId, events)}
    </div>

    <div style="display:flex; justify-content:space-between; align-items:center; gap:10px; flex-wrap:wrap; margin-top:6px;">
      <button type="button" class="btn btn-ghost btn-tiny midea-add-ev-btn" data-id="${escapeHtml(devId)}">
        ➕ Ajouter un événement
      </button>

      <button type="button" class="btn btn-primary btn-small midea-save-sched-btn" data-id="${escapeHtml(devId)}">
        💾 Enregistrer la planification
      </button>
    </div>
  `;
}

function wireMideaScheduleControls(devId) {
  const box = $(`midea-sched-body-${devId}`);
  if (!box) return;
  const badgeEl = $(`midea-sched-badge-${devId}`);

  wireMideaEventsList(devId);

  const enCb = $(`midea-sched-en-${devId}`);
  if (enCb) {
    enCb.addEventListener('change', () => {
      const curEvents = collectMideaEventsFromDom(devId);
      if (badgeEl) {
        badgeEl.textContent = enCb.checked ? `✓ Actif (${curEvents.length} événement${curEvents.length > 1 ? 's' : ''})` : 'Désactivé';
        badgeEl.style.color = enCb.checked ? 'var(--accent, #10b981)' : 'var(--text-dim, #94a3b8)';
      }
    });
  }

  box.querySelector('.midea-add-ev-btn')?.addEventListener('click', () => {
    const curEvents = collectMideaEventsFromDom(devId);
    curEvents.push({
      id: 'evt_' + Math.random().toString(36).substring(2, 9),
      name: `Événement ${curEvents.length + 1}`,
      enabled: true,
      days: [1, 2, 3, 4, 5, 6, 7],
      time: '08:00',
      power: true,
      target_humidity: 40,
      fan_speed: 80,
      mode: 2,
    });
    renderMideaEventsList(devId, curEvents);
  });

  box.querySelector('.midea-save-sched-btn')?.addEventListener('click', (e) => {
    saveMideaDeviceSchedule(devId, e.currentTarget);
  });
}

function renderMideaScheduleEditor(devId, sched) {
  const box = $(`midea-sched-body-${devId}`);
  if (!box) return;

  const isEnabled = !!(sched && sched.schedule_enabled);
  const events = (sched && sched.events) || [];

  const badgeEl = $(`midea-sched-badge-${devId}`);
  if (badgeEl) {
    badgeEl.textContent = isEnabled ? `✓ Actif (${events.length} événement${events.length > 1 ? 's' : ''})` : 'Désactivé';
    badgeEl.style.color = isEnabled ? 'var(--accent, #10b981)' : 'var(--text-dim, #94a3b8)';
  }

  box.innerHTML = getMideaScheduleEditorHtml(devId, sched);
  wireMideaScheduleControls(devId);
}

function updateMideaCardInPlace(card, d, allLocations) {
  const isFull = !!d.tank_full;
  const isRunning = !!d.power;
  const curHum = Math.round(d.current_humidity || 0);
  const targetHum = Math.round(d.target_humidity || 50);
  const tempC = d.current_temperature > 0 ? `${d.current_temperature.toFixed(1)}°C` : '';
  const fanSpeed = d.fan_speed || 40;
  const isHighFan = fanSpeed >= 70;
  const mode = d.mode || 1;
  const devId = String(d.device_id);

  // 1. Tank full banner & styling
  card.classList.toggle('midea-tank-full-card', isFull);
  let banner = card.querySelector('.midea-tank-banner');
  if (isFull) {
    if (!banner) {
      banner = document.createElement('div');
      banner.className = 'midea-tank-banner';
      banner.style.cssText = 'margin:12px 0 6px; padding:10px 14px; background:rgba(239, 68, 68, 0.15); border:1px solid var(--red, #ef4444); border-radius:8px; display:flex; align-items:center; gap:10px;';
      banner.innerHTML = '<span style="font-size:22px;">⚠️</span><div style="font-size:13px; color:var(--red, #ef4444); font-weight:600;">Le réservoir d\'eau est plein. Le compresseur est arrêté. Videz le bac d\'eau pour relancer l\'appareil.</div>';
      const header = card.querySelector('.card-header');
      if (header && header.nextSibling) {
        card.insertBefore(banner, header.nextSibling);
      }
    }
  } else if (banner) {
    banner.remove();
  }

  // 2. Status badge & online badge
  const onlineBadge = card.querySelector('.midea-online-badge');
  if (onlineBadge) {
    onlineBadge.className = `midea-badge midea-online-badge ${d.online ? 'online' : 'offline'}`;
    onlineBadge.textContent = d.online ? 'En ligne' : 'Hors ligne';
  }
  const statusContainer = card.querySelector('.midea-status-badge-container');
  if (statusContainer) {
    let statusBadgeHtml = '';
    if (!isRunning) {
      statusBadgeHtml = '<span class="midea-badge off">Arrêt</span>';
    } else if (isFull) {
      statusBadgeHtml = '<span class="midea-badge tank-full pulse">⚠️ Bac plein</span>';
    } else if (d.defrosting) {
      statusBadgeHtml = '<span class="midea-badge defrosting">❄️ Dégivrage</span>';
    } else if (d.compressor_running) {
      statusBadgeHtml = '<span class="midea-badge dehumidifying"><span class="midea-water-pulse">💧</span> Compresseur actif</span>';
    } else {
      statusBadgeHtml = '<span class="midea-badge fan-only"><span class="midea-fan-spin">🌪️</span> Ventilation seule</span>';
    }
    statusContainer.innerHTML = statusBadgeHtml;
  }

  // 3. Center humidity & temperature readout
  const curHumEl = card.querySelector('.midea-cur-hum');
  if (curHumEl) {
    curHumEl.textContent = curHum > 0 ? curHum + '%' : '—';
    curHumEl.style.color = curHum > targetHum + 5 ? 'var(--blue, #38bdf8)' : 'var(--text-bright, #fff)';
  }
  const tempEl = card.querySelector('.midea-temp-c');
  if (tempEl) {
    tempEl.textContent = tempC ? `🌡️ ${tempC}` : '';
    tempEl.style.display = tempC ? 'block' : 'none';
  }
  const tgtHumEl = card.querySelector('.midea-target-hum');
  if (tgtHumEl) {
    tgtHumEl.textContent = `${targetHum}%`;
  }
  const tgtSubEl = card.querySelector('.midea-target-subtext');
  if (tgtSubEl) {
    let targetSubtext = 'Humidité sous contrôle';
    if (!isRunning) {
      targetSubtext = 'Appareil à l\'arrêt';
    } else if (isFull) {
      targetSubtext = 'Arrêt sécurité (bac plein)';
    } else if (d.defrosting) {
      targetSubtext = 'Dégivrage du compresseur';
    } else if (mode === 2) {
      targetSubtext = 'Mode continu — Compresseur actif';
    } else if (curHum > targetHum) {
      targetSubtext = `${curHum}% > ${targetHum}% — Compresseur actif`;
    } else {
      targetSubtext = `${curHum}% ≤ ${targetHum}% — Consigne atteinte (ventilation)`;
    }
    tgtSubEl.textContent = targetSubtext;
  }

  // 4. Power button
  const pwrBtn = card.querySelector('.midea-pwr-btn');
  if (pwrBtn) {
    pwrBtn.className = `btn ${isRunning ? 'btn-danger' : 'btn-primary'} midea-pwr-btn`;
    pwrBtn.dataset.power = String(!isRunning);
    pwrBtn.textContent = isRunning ? '⏹️ Arrêter' : '▶️ Allumer';
  }

  // 5. Target Stepper
  const stepBtns = card.querySelectorAll('.midea-step-btn');
  if (stepBtns.length === 2) {
    stepBtns[0].dataset.val = String(Math.max(30, targetHum - 5));
    stepBtns[1].dataset.val = String(Math.min(80, targetHum + 5));
    const stepVal = card.querySelector('.midea-target-step-val');
    if (stepVal) stepVal.textContent = `${targetHum}%`;
  }

  // 6. Fan speed buttons
  const fanBtns = card.querySelectorAll('.midea-fan-btn');
  fanBtns.forEach(btn => {
    const spd = parseInt(btn.dataset.speed, 10);
    const active = (spd >= 70 && isHighFan) || (spd < 70 && !isHighFan);
    btn.className = `btn btn-tiny ${active ? 'btn-primary' : 'btn-ghost'} midea-fan-btn`;
  });

  // 7. Mode buttons
  const modeBtns = card.querySelectorAll('.midea-mode-btn');
  modeBtns.forEach(btn => {
    const m = parseInt(btn.dataset.mode, 10);
    const active = (m === mode);
    btn.className = `btn btn-tiny ${active ? 'btn-primary' : 'btn-ghost'} midea-mode-btn`;
  });

  // 8. Schedule badge (without touching editor)
  const cachedSched = _mideaDeviceSchedules[devId];
  const hasSchedInfo = cachedSched || (d.schedule_enabled != null);
  const schedEn = cachedSched ? !!cachedSched.schedule_enabled : !!d.schedule_enabled;
  const schedCount = cachedSched ? (cachedSched.events || []).length : (d.schedule_events_count || 0);
  const badgeEl = $(`midea-sched-badge-${devId}`);
  if (badgeEl && hasSchedInfo) {
    badgeEl.textContent = schedEn ? `✓ Actif (${schedCount} événement${schedCount > 1 ? 's' : ''})` : 'Désactivé';
    badgeEl.style.color = schedEn ? 'var(--accent, #10b981)' : 'var(--text-dim, #94a3b8)';
  }
}

async function renderMideaTab(force = false) {
  const container = $('midea-devices-container');
  if (!container) return;

  // Initial fetch of devices if none cached yet
  if (!lastMideaDevices.length || force) {
    try {
      const r = await fetch('/api/midea/devices');
      if (r.ok) {
        const j = await r.json();
        if (j.devices) {
          lastMideaDevices = j.devices;
          if (lastStatus) lastStatus.midea_devices = j.devices;
        }
      }
    } catch (e) {
      console.warn('Failed to load Midea devices:', e);
    }
  }

  const devices = (lastMideaDevices && lastMideaDevices.length) ? lastMideaDevices : ((lastStatus && lastStatus.midea_devices) || []);

  // Update Location pill active classes
  document.querySelectorAll('.midea-loc-pill').forEach(p => {
    p.classList.toggle('on', p.dataset.loc === _mideaSelectedLocation);
  });

  // Update Last poll time
  const pollTimeEl = $('midea-last-poll-time');
  if (pollTimeEl) {
    if (_lastMideaPollTs) {
      const elapsedM = Math.max(0, Math.round((Date.now() - _lastMideaPollTs) / 60000));
      pollTimeEl.textContent = elapsedM === 0 ? 'Last update: just now' : `Last update: ${elapsedM}m ago`;
    } else if (devices.length) {
      pollTimeEl.textContent = 'Last update: active';
    } else {
      pollTimeEl.textContent = 'Last update: —';
    }
  }

  // Filter devices based on chosen location
  const locFilter = _mideaSelectedLocation;
  const filtered = (locFilter === 'all')
    ? devices
    : devices.filter(d => (d.location_id || '').toLowerCase() === locFilter.toLowerCase());

  // Update KPI counters
  const totalEl = $('midea-kpi-total');
  const activeEl = $('midea-kpi-active');
  const activeSubEl = $('midea-kpi-active-sub');
  const avgHumEl = $('midea-kpi-avg-humidity');
  const tankCard = $('midea-kpi-tank-card');
  const tankStatusEl = $('midea-kpi-tanks-status');
  const tankSubEl = $('midea-kpi-tanks-sub');

  const runningCount = filtered.filter(d => d.power).length;
  const compressorCount = filtered.filter(d => d.power && d.compressor_running).length;
  const fanOnlyCount = filtered.filter(d => d.power && !d.compressor_running && !d.tank_full).length;
  const tanksFull = filtered.filter(d => d.tank_full).length;
  const hums = filtered.map(d => d.current_humidity).filter(h => h > 0);
  const avgHum = hums.length ? Math.round(hums.reduce((a, b) => a + b, 0) / hums.length) : null;

  if (totalEl) totalEl.textContent = String(filtered.length);
  if (activeEl) activeEl.textContent = String(runningCount);
  if (activeSubEl) {
    if (runningCount === 0) {
      activeSubEl.textContent = 'Tous à l\'arrêt';
    } else if (compressorCount > 0 && fanOnlyCount > 0) {
      activeSubEl.textContent = `${compressorCount} compresseur · ${fanOnlyCount} ventilation`;
    } else if (compressorCount > 0) {
      activeSubEl.textContent = `${compressorCount} compresseur${compressorCount > 1 ? 's' : ''} actif${compressorCount > 1 ? 's' : ''}`;
    } else {
      activeSubEl.textContent = `${fanOnlyCount} en ventilation seule`;
    }
  }
  if (avgHumEl) avgHumEl.textContent = avgHum !== null ? `${avgHum}%` : '—';

  if (tankCard && tankStatusEl && tankSubEl) {
    if (tanksFull > 0) {
      tankStatusEl.textContent = `⚠️ ${tanksFull} PLEIN`;
      tankStatusEl.style.color = 'var(--red, #ef4444)';
      tankSubEl.textContent = 'Vidange requise';
      tankCard.style.borderColor = 'var(--red, #ef4444)';
    } else {
      tankStatusEl.textContent = 'OK';
      tankStatusEl.style.color = 'var(--accent, #10b981)';
      tankSubEl.textContent = 'Bacs normaux';
      tankCard.style.borderColor = '';
    }
  }

  // Empty state handling
  const emptyEl = $('midea-empty');
  if (filtered.length === 0) {
    if (emptyEl) emptyEl.hidden = false;
    container.innerHTML = '';
    return;
  }
  if (emptyEl) emptyEl.hidden = true;

  // Check if cards are already rendered for the current device list
  const existingCards = container.querySelectorAll('.midea-device-card');
  const existingCardIds = Array.from(existingCards).map(c => c.dataset.deviceId);
  const currentDevIds = filtered.map(d => String(d.device_id));
  const canUpdateInPlace = !force && existingCardIds.length === currentDevIds.length && existingCardIds.every((id, idx) => id === currentDevIds[idx]);

  if (canUpdateInPlace) {
    const allLocations = (lastStatus && lastStatus.locations) || [
      { id: 'maison', name: 'Maison' },
      { id: 'chalet', name: 'Chalet' },
    ];
    filtered.forEach(d => {
      const card = container.querySelector(`.midea-device-card[data-device-id="${d.device_id}"]`);
      if (card) updateMideaCardInPlace(card, d, allLocations);
    });
    return;
  }

  // Compute signature of current view state to avoid wiping DOM if unchanged
  const sig = JSON.stringify({
    loc: _mideaSelectedLocation,
    hist: Array.from(_mideaOpenDeviceHistories).sort(),
    sched: Array.from(_mideaOpenDeviceSchedules).sort(),
    devHours: _mideaDevHours,
    devs: filtered.map(d => ({
      id: d.device_id,
      name: d.name,
      pwr: d.power,
      cr: d.compressor_running,
      fo: d.fan_only,
      st: d.operational_status,
      hum: d.current_humidity,
      tgt: d.target_humidity,
      temp: d.current_temperature,
      tank: d.tank_full,
      spd: d.fan_speed,
      mode: d.mode,
      loc: d.location_id,
      online: d.online,
      schedEn: d.schedule_enabled,
      schedCount: d.schedule_events_count,
    })),
  });

  const isInteracting = container.contains(document.activeElement);

  // If nothing changed in the device list and not forced, DO NOT rebuild cards!
  if (!force && sig === _mideaLastRenderedSignature) {
    return;
  }

  // If user is currently interacting with an element (e.g. typing in an input or selecting dropdown),
  // defer re-rendering so we don't blow away their input!
  if (!force && isInteracting) {
    return;
  }

  _mideaLastRenderedSignature = sig;

  // Render cards
  const allLocations = (lastStatus && lastStatus.locations) || [
    { id: 'maison', name: 'Maison' },
    { id: 'chalet', name: 'Chalet' },
  ];

  // Default all devices to open graph on first render
  if (_mideaOpenDeviceHistories.size === 0 && filtered.length > 0) {
    filtered.forEach(d => _mideaOpenDeviceHistories.add(String(d.device_id)));
  }

  container.innerHTML = filtered.map(d => {
    const isFull = !!d.tank_full;
    const isRunning = !!d.power;
    const curHum = Math.round(d.current_humidity || 0);
    const targetHum = Math.round(d.target_humidity || 50);
    const tempC = d.current_temperature > 0 ? `${d.current_temperature.toFixed(1)}°C` : '';
    const fanSpeed = d.fan_speed || 40;
    const isHighFan = fanSpeed >= 70;
    const mode = d.mode || 1;
    const devId = String(d.device_id);
    const isHistOpen = _mideaOpenDeviceHistories.has(devId);
    const isSchedOpen = _mideaOpenDeviceSchedules.has(devId);
    const histHours = _mideaDevHours[devId] || 24;

    const cachedSched = _mideaDeviceSchedules[devId];
    const hasSchedInfo = cachedSched || (d.schedule_enabled != null);
    const schedEn = cachedSched ? !!cachedSched.schedule_enabled : !!d.schedule_enabled;
    const schedCount = cachedSched ? (cachedSched.events || []).length : (d.schedule_events_count || 0);
    const badgeText = hasSchedInfo
      ? (schedEn ? `✓ Actif (${schedCount} événement${schedCount > 1 ? 's' : ''})` : 'Désactivé')
      : '';
    const badgeColor = schedEn ? 'var(--accent, #10b981)' : 'var(--text-dim, #94a3b8)';

    let statusBadgeHtml = '';
    if (!isRunning) {
      statusBadgeHtml = '<span class="midea-badge off">Arrêt</span>';
    } else if (isFull) {
      statusBadgeHtml = '<span class="midea-badge tank-full pulse">⚠️ Bac plein</span>';
    } else if (d.defrosting) {
      statusBadgeHtml = '<span class="midea-badge defrosting">❄️ Dégivrage</span>';
    } else if (d.compressor_running) {
      statusBadgeHtml = '<span class="midea-badge dehumidifying"><span class="midea-water-pulse">💧</span> Compresseur actif</span>';
    } else {
      statusBadgeHtml = '<span class="midea-badge fan-only"><span class="midea-fan-spin">🌪️</span> Ventilation seule</span>';
    }

    let targetSubtext = 'Humidité sous contrôle';
    if (!isRunning) {
      targetSubtext = 'Appareil à l\'arrêt';
    } else if (isFull) {
      targetSubtext = 'Arrêt sécurité (bac plein)';
    } else if (d.defrosting) {
      targetSubtext = 'Dégivrage du compresseur';
    } else if (mode === 2) {
      targetSubtext = 'Mode continu — Compresseur actif';
    } else if (curHum > targetHum) {
      targetSubtext = `${curHum}% > ${targetHum}% — Compresseur actif`;
    } else {
      targetSubtext = `${curHum}% ≤ ${targetHum}% — Consigne atteinte (ventilation)`;
    }

    const locOptions = allLocations.map(l =>
      `<option value="${escapeHtml(l.id)}" ${(d.location_id || '').toLowerCase() === l.id.toLowerCase() ? 'selected' : ''}>${escapeHtml(l.name || l.id)}</option>`
    ).join('');

    return `
      <div class="card device-card midea-device-card ${isFull ? 'midea-tank-full-card' : ''}" data-device-id="${escapeHtml(d.device_id)}">
        <div class="card-header" style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:8px;">
          <div>
            <h3 style="margin:0 0 4px 0; font-size:17px; display:flex; align-items:center; gap:6px;">
              <span>💧</span> ${escapeHtml(d.name || 'Danby Dehumidifier')}
            </h3>
            <span class="hint" style="font-size:12px;">${escapeHtml(d.model || 'Danby')} • IP: ${escapeHtml(d.ip || 'LAN')}</span>
          </div>
          <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
            <select class="midea-device-loc-select device-select" data-id="${escapeHtml(d.device_id)}" style="font-size:11px; padding:2px 6px;">
              ${locOptions}
            </select>
            <span class="midea-badge midea-online-badge ${d.online ? 'online' : 'offline'}">${d.online ? 'En ligne' : 'Hors ligne'}</span>
            <span class="midea-status-badge-container">${statusBadgeHtml}</span>
          </div>
        </div>

        ${isFull ? `
          <div class="midea-tank-banner" style="margin:12px 0 6px; padding:10px 14px; background:rgba(239, 68, 68, 0.15); border:1px solid var(--red, #ef4444); border-radius:8px; display:flex; align-items:center; gap:10px;">
            <span style="font-size:22px;">⚠️</span>
            <div style="font-size:13px; color:var(--red, #ef4444); font-weight:600;">
              Le réservoir d'eau est plein. Le compresseur est arrêté. Videz le bac d'eau pour relancer l'appareil.
            </div>
          </div>
        ` : ''}

        <!-- Center humidity readout -->
        <div class="midea-readout-center" style="display:flex; align-items:center; justify-content:space-around; padding:16px 8px; margin:12px 0; background:rgba(255,255,255,0.02); border-radius:10px; border:1px solid rgba(255,255,255,0.06);">
          <div style="text-align:center;">
            <div style="font-size:12px; color:var(--text-dim,#94a3b8); margin-bottom:2px;">Humidité ambiante</div>
            <div class="midea-cur-hum" style="font-size:38px; font-weight:700; line-height:1; color:${curHum > targetHum + 5 ? 'var(--blue, #38bdf8)' : 'var(--text-bright, #fff)'};">
              ${curHum > 0 ? curHum + '%' : '—'}
            </div>
            <div class="midea-temp-c" style="font-size:12px; color:var(--text-dim,#94a3b8); margin-top:4px; ${tempC ? '' : 'display:none;'}">${tempC ? '🌡️ ' + tempC : ''}</div>
          </div>

          <div style="width:1px; height:50px; background:rgba(255,255,255,0.1);"></div>

          <div style="text-align:center;">
            <div style="font-size:12px; color:var(--text-dim,#94a3b8); margin-bottom:2px;">Consigne cible</div>
            <div class="midea-target-hum" style="font-size:32px; font-weight:700; line-height:1; color:var(--accent, #10b981);">
              ${targetHum}%
            </div>
            <div class="midea-target-subtext" style="font-size:11px; color:var(--text-dim,#94a3b8); margin-top:4px;">
              ${targetSubtext}
            </div>
          </div>
        </div>

        <!-- Controls section -->
        <div class="midea-controls-grid" style="display:flex; flex-direction:column; gap:12px; margin-top:14px;">
          <!-- Power & Humidity Stepper Row -->
          <div style="display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap;">
            <button class="btn ${isRunning ? 'btn-danger' : 'btn-primary'} midea-pwr-btn" data-id="${escapeHtml(d.device_id)}" data-power="${!isRunning}" style="min-width:110px;">
              ${isRunning ? '⏹️ Arrêter' : '▶️ Allumer'}
            </button>

            <!-- Target Humidity Stepper -->
            <div style="display:flex; align-items:center; gap:6px;">
              <span style="font-size:12px; color:var(--text-dim,#94a3b8);">Cible:</span>
              <button class="btn btn-ghost btn-tiny midea-step-btn" data-id="${escapeHtml(d.device_id)}" data-val="${Math.max(30, targetHum - 5)}" title="Baisser la consigne (-5%)">➖</button>
              <span class="midea-target-step-val" style="font-weight:600; font-size:14px; min-width:36px; text-align:center;">${targetHum}%</span>
              <button class="btn btn-ghost btn-tiny midea-step-btn" data-id="${escapeHtml(d.device_id)}" data-val="${Math.min(80, targetHum + 5)}" title="Augmenter la consigne (+5%)">➕</button>
            </div>
          </div>

          <!-- Fan Speed & Mode Row -->
          <div style="display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap; padding-top:8px; border-top:1px solid rgba(255,255,255,0.06);">
            <!-- Fan Speed -->
            <div style="display:flex; align-items:center; gap:6px;">
              <span style="font-size:12px; color:var(--text-dim,#94a3b8);">Ventilation:</span>
              <div class="button-group" style="display:flex; gap:4px;">
                <button class="btn btn-tiny ${!isHighFan ? 'btn-primary' : 'btn-ghost'} midea-fan-btn" data-id="${escapeHtml(d.device_id)}" data-speed="40">Faible</button>
                <button class="btn btn-tiny ${isHighFan ? 'btn-primary' : 'btn-ghost'} midea-fan-btn" data-id="${escapeHtml(d.device_id)}" data-speed="80">Élevée</button>
              </div>
            </div>

            <!-- Mode -->
            <div style="display:flex; align-items:center; gap:6px;">
              <span style="font-size:12px; color:var(--text-dim,#94a3b8);">Mode:</span>
              <div class="button-group" style="display:flex; gap:4px;">
                <button class="btn btn-tiny ${mode === 1 ? 'btn-primary' : 'btn-ghost'} midea-mode-btn" data-id="${escapeHtml(d.device_id)}" data-mode="1" title="Mode normal avec consigne">Normal</button>
                <button class="btn btn-tiny ${mode === 2 ? 'btn-primary' : 'btn-ghost'} midea-mode-btn" data-id="${escapeHtml(d.device_id)}" data-mode="2" title="Fonctionnement continu">Continu</button>
              </div>
            </div>
          </div>
        </div>

        <!-- History & Operating States Graph Section -->
        <div class="midea-card-section midea-hist-section">
          <div class="midea-section-header">
            <button type="button" class="midea-section-title-btn midea-toggle-hist-btn" data-id="${escapeHtml(d.device_id)}">
              <span>${isHistOpen ? '▼' : '▶'}</span>
              <span>📈 Graphique d'utilisation (on/off/vent./comp.)</span>
            </button>
            <div class="range-picker midea-dev-range-picker" data-dev="${escapeHtml(d.device_id)}" style="${isHistOpen ? 'display:flex;' : 'display:none;'}">
              <button type="button" class="sinope-loc-range-btn ${histHours === 6 ? 'on' : ''}" data-dev="${escapeHtml(d.device_id)}" data-hours="6">6h</button>
              <button type="button" class="sinope-loc-range-btn ${histHours === 12 ? 'on' : ''}" data-dev="${escapeHtml(d.device_id)}" data-hours="12">12h</button>
              <button type="button" class="sinope-loc-range-btn ${histHours === 24 ? 'on' : ''}" data-dev="${escapeHtml(d.device_id)}" data-hours="24">24h</button>
              <button type="button" class="sinope-loc-range-btn ${histHours === 168 ? 'on' : ''}" data-dev="${escapeHtml(d.device_id)}" data-hours="168">7d</button>
            </div>
          </div>

          <div id="midea-hist-body-${escapeHtml(d.device_id)}" style="${isHistOpen ? 'display:block;' : 'display:none;'}">
            <!-- Runtime breakdown chips -->
            <div class="midea-runtime-chips">
              <span class="midea-chip midea-chip-blue" title="Durée compresseur actif">💧 Compresseur: <b id="midea-rt-comp-${escapeHtml(d.device_id)}">—</b></span>
              <span class="midea-chip midea-chip-teal" title="Durée ventilation seule">🌪️ Ventilation: <b id="midea-rt-fan-${escapeHtml(d.device_id)}">—</b></span>
              <span class="midea-chip midea-chip-slate" title="Durée à l'arrêt">⏹️ Arrêt: <b id="midea-rt-off-${escapeHtml(d.device_id)}">—</b></span>
              <span class="midea-chip midea-chip-green" title="Énergie électrique estimée consommée">⚡ Énergie: <b id="midea-rt-kwh-${escapeHtml(d.device_id)}">—</b></span>
            </div>

            <div class="midea-chart-box">
              <canvas id="chart-midea-dev-${escapeHtml(d.device_id)}" class="midea-chart"></canvas>
              <div class="midea-chart-legend">
                <span class="midea-chart-legend-item"><span style="display:inline-block; width:10px; height:10px; background:rgba(14, 165, 233, 0.45); border-radius:2px;"></span> Compresseur</span>
                <span class="midea-chart-legend-item"><span style="display:inline-block; width:10px; height:10px; background:rgba(20, 184, 166, 0.45); border-radius:2px;"></span> Ventilation</span>
                <span class="midea-chart-legend-item"><span style="display:inline-block; width:12px; height:2px; background:#38bdf8;"></span> Humidité ambiante</span>
                <span class="midea-chart-legend-item"><span style="display:inline-block; width:12px; height:0; border-top:2px dashed #10b981;"></span> Consigne</span>
              </div>
            </div>
          </div>
        </div>

        <!-- Schedule & Timezone Section -->
        <div class="midea-card-section midea-sched-section">
          <div class="midea-section-header">
            <button type="button" class="midea-section-title-btn midea-toggle-sched-btn" data-id="${escapeHtml(d.device_id)}">
              <span>${isSchedOpen ? '▼' : '▶'}</span>
              <span>📅 Planification & Fuseau horaire</span>
            </button>
            <span class="hint" style="font-size:11px; color:${badgeColor};" id="midea-sched-badge-${escapeHtml(d.device_id)}">${escapeHtml(badgeText)}</span>
          </div>

          <div id="midea-sched-body-${escapeHtml(d.device_id)}" class="midea-schedule-box" style="${isSchedOpen ? 'display:flex;' : 'display:none;'}">
            ${isSchedOpen && cachedSched ? getMideaScheduleEditorHtml(devId, cachedSched) : (cachedSched ? '' : '<div style="font-size:12px; color:var(--text-dim,#94a3b8); text-align:center; padding:12px;">Chargement de la planification…</div>')}
          </div>
        </div>
      </div>
    `;
  }).join('');

  // Wire up card action listeners
  container.querySelectorAll('.midea-pwr-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const devId = btn.dataset.id;
      const power = btn.dataset.power === 'true';
      sendMideaControl(devId, { power }, btn);
    });
  });

  container.querySelectorAll('.midea-step-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const devId = btn.dataset.id;
      const val = parseInt(btn.dataset.val, 10);
      sendMideaControl(devId, { target_humidity: val }, btn);
    });
  });

  container.querySelectorAll('.midea-fan-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const devId = btn.dataset.id;
      const speed = parseInt(btn.dataset.speed, 10);
      sendMideaControl(devId, { fan_speed: speed }, btn);
    });
  });

  container.querySelectorAll('.midea-mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const devId = btn.dataset.id;
      const mode = parseInt(btn.dataset.mode, 10);
      sendMideaControl(devId, { mode: mode }, btn);
    });
  });

  container.querySelectorAll('.midea-device-loc-select').forEach(sel => {
    sel.addEventListener('change', () => {
      const devId = sel.dataset.id;
      const locId = sel.value;
      setMideaDeviceLocation(devId, locId);
    });
  });

  // Wire up Toggle History buttons
  container.querySelectorAll('.midea-toggle-hist-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const devId = btn.dataset.id;
      const body = $(`midea-hist-body-${devId}`);
      const picker = container.querySelector(`.midea-dev-range-picker[data-dev="${devId}"]`);
      if (_mideaOpenDeviceHistories.has(devId)) {
        _mideaOpenDeviceHistories.delete(devId);
        if (body) body.style.display = 'none';
        if (picker) picker.style.display = 'none';
        btn.querySelector('span').textContent = '▶';
      } else {
        _mideaOpenDeviceHistories.add(devId);
        if (body) body.style.display = 'block';
        if (picker) picker.style.display = 'flex';
        btn.querySelector('span').textContent = '▼';
        loadAndDrawMideaDeviceChart(devId);
      }
    });
  });

  // Wire up Range picker buttons
  container.querySelectorAll('.midea-dev-range-picker button').forEach(btn => {
    btn.addEventListener('click', () => {
      const devId = btn.dataset.dev;
      const hours = parseInt(btn.dataset.hours, 10);
      _mideaDevHours[devId] = hours;
      const picker = container.querySelector(`.midea-dev-range-picker[data-dev="${devId}"]`);
      if (picker) {
        picker.querySelectorAll('button').forEach(b => b.classList.toggle('on', parseInt(b.dataset.hours, 10) === hours));
      }
      loadAndDrawMideaDeviceChart(devId, true);
    });
  });

  // Wire up Toggle Schedule buttons
  container.querySelectorAll('.midea-toggle-sched-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const devId = btn.dataset.id;
      const body = $(`midea-sched-body-${devId}`);
      if (_mideaOpenDeviceSchedules.has(devId)) {
        _mideaOpenDeviceSchedules.delete(devId);
        if (body) body.style.display = 'none';
        btn.querySelector('span').textContent = '▶';
      } else {
        _mideaOpenDeviceSchedules.add(devId);
        if (body) body.style.display = 'flex';
        btn.querySelector('span').textContent = '▼';
        if (_mideaDeviceSchedules[devId]) {
          renderMideaScheduleEditor(devId, _mideaDeviceSchedules[devId]);
        } else {
          loadMideaDeviceSchedule(devId);
        }
      }
    });
  });

  // Auto-load charts & schedules for open items, and prefetch schedules if needed
  filtered.forEach(d => {
    const devId = String(d.device_id);
    if (_mideaOpenDeviceHistories.has(devId)) {
      loadAndDrawMideaDeviceChart(devId);
    }
    if (_mideaOpenDeviceSchedules.has(devId)) {
      if (_mideaDeviceSchedules[devId]) {
        wireMideaScheduleControls(devId);
      } else {
        loadMideaDeviceSchedule(devId);
      }
    }
    // Prefetch schedule if not yet cached so badge and future expands are instant
    if (!_mideaDeviceSchedules[devId]) {
      fetch(`/api/midea/device/${encodeURIComponent(devId)}/schedule`)
        .then(r => r.ok ? r.json() : null)
        .then(j => {
          if (j) {
            _mideaDeviceSchedules[devId] = j;
            const b = $(`midea-sched-badge-${devId}`);
            if (b) {
              const isEn = !!j.schedule_enabled;
              const c = (j.events || []).length;
              b.textContent = isEn ? `✓ Actif (${c} horaire${c > 1 ? 's' : ''})` : 'Désactivé';
              b.style.color = isEn ? 'var(--accent, #10b981)' : 'var(--text-dim, #94a3b8)';
            }
            if (_mideaOpenDeviceSchedules.has(devId)) {
              renderMideaScheduleEditor(devId, j);
            }
          }
        })
        .catch(() => {});
    }
  });

  // Window resize hook
  if (!_mideaResizeBound) {
    _mideaResizeBound = true;
    window.addEventListener('resize', () => {
      if (activeTab === 'midea') {
        _mideaOpenDeviceHistories.forEach(id => {
          const canvas = $('chart-midea-dev-' + id);
          if (canvas && canvas._redraw) canvas._redraw();
        });
      }
    });
  }
}

async function sendMideaControl(deviceId, payload, btn = null) {
  if (btn) btn.disabled = true;
  try {
    const res = await fetch(`/api/midea/device/${encodeURIComponent(deviceId)}/control`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (res.ok) {
      const updated = await res.json();
      // Update local state and re-render
      for (const d of lastMideaDevices) {
        if (d.device_id === deviceId) {
          Object.assign(d, updated);
          break;
        }
      }
      renderMideaTab();
    } else {
      const err = await res.json().catch(() => ({}));
      alert(`Erreur de commande: ${err.detail || 'Échec de la commande'}`);
    }
  } catch (e) {
    alert(`Erreur réseau: ${e.message}`);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function setMideaDeviceLocation(deviceId, locationId) {
  try {
    const res = await fetch(`/api/midea/device/${encodeURIComponent(deviceId)}/location`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ location_id: locationId }),
    });
    if (res.ok) {
      for (const d of lastMideaDevices) {
        if (d.device_id === deviceId) {
          d.location_id = locationId;
          break;
        }
      }
      renderMideaTab();
    }
  } catch (e) {
    console.warn('Failed to set device location:', e);
  }
}

// ============================================================
// DANBY / MIDEA SETTINGS
// ============================================================
async function loadMideaCreds() {
  const statusEl = $('midea-creds-status');
  const locIndicator = $('midea-creds-loc-indicator');
  const emailInput = $('midea-email');
  const pwdInput = $('midea-password');
  const appSelect = $('midea-app-name');

  try {
    const res = await fetch('/api/midea/credentials');
    if (!res.ok) return;
    const data = await res.json();
    lastMideaCredsStatus = data;

    const locData = (data.locations && data.locations[_mideaCredsLoc]) || {};
    const isConfigured = !!locData.configured;

    if (statusEl) {
      if (data.has_credentials) {
        statusEl.textContent = 'Configured';
        statusEl.style.color = 'var(--accent, #10b981)';
      } else {
        statusEl.textContent = 'Not configured';
        statusEl.style.color = 'var(--text-dim, #94a3b8)';
      }
    }

    if (locIndicator) {
      locIndicator.textContent = `${_mideaCredsLoc.charAt(0).toUpperCase() + _mideaCredsLoc.slice(1)} credentials`;
    }

    if (emailInput) {
      emailInput.value = locData.email || '';
    }
    if (pwdInput) {
      pwdInput.value = '';
      pwdInput.placeholder = isConfigured ? 'Password saved (••••••••)' : 'Enter password';
    }
    if (appSelect) {
      appSelect.value = locData.app_name || 'MSmartHome';
    }
  } catch (e) {
    console.warn('Failed to load Midea creds:', e);
  }
}

function initMideaSettings() {
  const form = $('midea-creds-form');
  const msg = $('midea-msg');
  const saveBtn = $('midea-save-btn');
  const clearBtn = $('midea-clear-btn');
  const pollBtn = $('midea-poll-btn');

  function showMsg(text, isError = false, timeout = 5000) {
    if (!msg) return;
    msg.hidden = false;
    msg.textContent = text;
    msg.style.color = isError ? 'var(--red, #ef4444)' : 'var(--accent, #10b981)';
    if (timeout > 0) {
      setTimeout(() => { msg.hidden = true; }, timeout);
    }
  }

  // Location selector pills in settings
  document.querySelectorAll('.midea-creds-loc-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      _mideaCredsLoc = pill.dataset.loc || 'maison';
      document.querySelectorAll('.midea-creds-loc-pill').forEach(p => {
        p.classList.toggle('on', p.dataset.loc === _mideaCredsLoc);
      });
      loadMideaCreds();
    });
  });

  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }
    showMsg('Verifying credentials with MSmartHome cloud…', false, 0);

    const email = ($('midea-email')?.value || '').trim();
    let password = $('midea-password')?.value || '';
    const appName = $('midea-app-name')?.value || 'MSmartHome';

    const locData = (lastMideaCredsStatus && lastMideaCredsStatus.locations && lastMideaCredsStatus.locations[_mideaCredsLoc]) || {};
    const isConfigured = !!locData.configured;

    if (!password && isConfigured) {
      password = '••••••••';
    } else if (!password) {
      showMsg('Please enter your MSmartHome account password', true);
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Verify & Save'; }
      return;
    }

    try {
      const res = await fetch('/api/midea/credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          location_id: _mideaCredsLoc,
          email: email,
          password: password,
          app_name: appName,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        const appLabel = data.app_name || appName;
        showMsg(`✓ Connected to ${appLabel}! Found ${data.device_count || 0} appliance(s). Discovering on LAN…`, false, 8000);
        await loadMideaCreds();
        renderMideaTab(true);
      } else {
        showMsg(`Authentication Error: ${data.detail || 'Failed to authenticate with Midea cloud'}`, true, 8000);
      }
    } catch (err) {
      showMsg(`Network error: ${err.message}`, true, 8000);
    } finally {
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Verify & Save'; }
    }
  });

  clearBtn?.addEventListener('click', async () => {
    const locTitle = _mideaCredsLoc.charAt(0).toUpperCase() + _mideaCredsLoc.slice(1);
    if (!confirm(`Are you sure you want to forget MSmartHome credentials for ${locTitle}?`)) return;

    try {
      const res = await fetch(`/api/midea/credentials?location_id=${encodeURIComponent(_mideaCredsLoc)}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        showMsg(`Cleared MSmartHome credentials for ${locTitle}`);
        await loadMideaCreds();
        renderMideaTab(true);
      } else {
        showMsg('Failed to clear credentials', true);
      }
    } catch (err) {
      showMsg(`Network error: ${err.message}`, true);
    }
  });

  pollBtn?.addEventListener('click', async () => {
    if (pollBtn) { pollBtn.disabled = true; pollBtn.textContent = 'Polling…'; }
    showMsg('Polling Danby / Midea dehumidifiers…', false, 0);

    try {
      const res = await fetch('/api/midea/poll', { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        const count = (data.devices || []).length;
        showMsg(`✓ Poll completed! Discovered ${count} dehumidifier(s).`);
        if (data.devices) {
          lastMideaDevices = data.devices;
          if (lastStatus) lastStatus.midea_devices = data.devices;
        }
        renderMideaTab(true);
      } else {
        showMsg(`Poll error: ${data.detail || 'Failed to poll appliances'}`, true);
      }
    } catch (err) {
      showMsg(`Network error: ${err.message}`, true);
    } finally {
      if (pollBtn) { pollBtn.disabled = false; pollBtn.textContent = 'Poll now'; }
    }
  });
}


// ============================================================
// TESLA & EV CHARGERS TAB & SETTINGS
// ============================================================
let _teslaLocFilter = 'all';
let lastTeslaDevices = { wall_connectors: [], vehicles: [] };
let lastTeslaCredsStatus = null;
let _lastTeslaPollTs = null;
let _teslaClosedDeviceHistories = new Set();
let _teslaDevHours = {};
let _teslaDevHistData = {};
let _teslaResizeBound = false;

async function loadTeslaCreds() {
  const statusEl = $('tesla-creds-status');
  try {
    const res = await fetch('/api/tesla/credentials');
    if (!res.ok) return;
    const cfg = await res.json();
    lastTeslaCredsStatus = cfg;

    if (statusEl) {
      if (cfg.saved) {
        const parts = [];
        if (cfg.maison_twc_ip) parts.push('Wall Connector');
        if (cfg.has_tesla_auth) parts.push('Tesla API Connected');
        statusEl.textContent = `✓ Configured (${parts.join(', ') || 'Active'})`;
        statusEl.style.color = 'var(--accent, #10b981)';
      } else {
        statusEl.textContent = 'Not configured';
        statusEl.style.color = 'var(--text-dim, #94a3b8)';
      }
    }

    const maisonIpInput = $('tesla-maison-ip');
    if (maisonIpInput && cfg.maison_twc_ip) maisonIpInput.value = cfg.maison_twc_ip;

    const chaletIpInput = $('tesla-chalet-ip');
    if (chaletIpInput && cfg.chalet_twc_ip) chaletIpInput.value = cfg.chalet_twc_ip;

    const chaletLatInput = $('tesla-chalet-lat');
    if (chaletLatInput && cfg.chalet_lat != null) chaletLatInput.value = cfg.chalet_lat;

    const chaletLonInput = $('tesla-chalet-lon');
    if (chaletLonInput && cfg.chalet_lon != null) chaletLonInput.value = cfg.chalet_lon;

    const accessInput = $('tesla-access-token');
    if (accessInput) {
      if (cfg.has_access_token) {
        accessInput.placeholder = '•••••••• (saved)';
      } else {
        accessInput.placeholder = 'Paste Tesla access token…';
      }
    }

    const refreshInput = $('tesla-refresh-token');
    if (refreshInput) {
      if (cfg.has_refresh_token) {
        refreshInput.placeholder = '•••••••• (saved)';
      } else {
        refreshInput.placeholder = 'Paste Tesla refresh token…';
      }
    }

    const clientIdInput = $('tesla-client-id');
    if (clientIdInput && cfg.client_id) {
      clientIdInput.value = cfg.client_id;
    }

    const clientSecretInput = $('tesla-client-secret');
    if (clientSecretInput) {
      if (cfg.has_client_secret) {
        clientSecretInput.placeholder = '•••••••• (saved)';
      } else {
        clientSecretInput.placeholder = 'Leave blank if using ownerapi';
      }
    }

    const regionSelect = $('tesla-region');
    if (regionSelect && cfg.region) {
      regionSelect.value = cfg.region;
    }
  } catch (err) {
    console.warn('Failed to load Tesla credentials status:', err);
  }
}

function initTeslaSettings() {
  const form = $('tesla-creds-form');
  const msg = $('tesla-msg');
  const saveBtn = $('tesla-save-btn');
  const clearBtn = $('tesla-clear-btn');
  const pollBtn = $('tesla-poll-btn');

  function showMsg(text, isError = false, timeout = 5000) {
    if (!msg) return;
    msg.hidden = false;
    msg.textContent = text;
    msg.style.color = isError ? 'var(--red, #ef4444)' : 'var(--accent, #10b981)';
    if (timeout > 0) {
      setTimeout(() => { msg.hidden = true; }, timeout);
    }
  }

  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }
    showMsg('Validating Wall Connector and official Tesla API credentials…', false, 0);

    const accessToken = ($('tesla-access-token')?.value || '').trim();
    const refreshToken = ($('tesla-refresh-token')?.value || '').trim();
    const clientId = ($('tesla-client-id')?.value || '').trim() || 'ownerapi';
    const clientSecret = ($('tesla-client-secret')?.value || '').trim();
    const region = $('tesla-region')?.value || 'na';
    const maisonIp = ($('tesla-maison-ip')?.value || '').trim();
    const chaletIp = ($('tesla-chalet-ip')?.value || '').trim();
    const chaletLat = parseFloat($('tesla-chalet-lat')?.value) || null;
    const chaletLon = parseFloat($('tesla-chalet-lon')?.value) || null;

    try {
      const res = await fetch('/api/tesla/credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          access_token: accessToken || (lastTeslaCredsStatus?.has_access_token ? '••••••••' : ''),
          refresh_token: refreshToken || (lastTeslaCredsStatus?.has_refresh_token ? '••••••••' : ''),
          client_id: clientId,
          client_secret: clientSecret || (lastTeslaCredsStatus?.has_client_secret ? '••••••••' : ''),
          region: region,
          maison_twc_ip: maisonIp || '192.168.86.41',
          chalet_twc_ip: chaletIp,
          chalet_lat: chaletLat,
          chalet_lon: chaletLon,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        const testRes = data.test || {};
        const twcOk = testRes.wall_connector?.ok ? '✓ Wall Connector OK' : (testRes.wall_connector?.message ? `TWC: ${testRes.wall_connector.message}` : '');
        const apiOk = testRes.tesla_api?.ok ? `✓ Tesla API (${testRes.tesla_api.vehicle_count} vehicle(s))` : (testRes.tesla_api?.message ? `Tesla API: ${testRes.tesla_api.message}` : '');
        const summary = [twcOk, apiOk].filter(Boolean).join(' · ') || 'Credentials saved';
        showMsg(`✓ Saved! ${summary}`, false, 7000);
        await loadTeslaCreds();
        renderTeslaTab(true);
      } else {
        showMsg(`Error: ${data.detail || 'Failed to save Tesla credentials'}`, true, 8000);
      }
    } catch (err) {
      showMsg(`Network error: ${err.message}`, true, 8000);
    } finally {
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Verify & Save'; }
    }
  });

  clearBtn?.addEventListener('click', async () => {
    if (!confirm('Are you sure you want to forget Tesla & EV charger credentials?')) return;
    try {
      const res = await fetch('/api/tesla/credentials', { method: 'DELETE' });
      if (res.ok) {
        showMsg('Cleared Tesla credentials.');
        if ($('tesla-access-token')) $('tesla-access-token').value = '';
        if ($('tesla-refresh-token')) $('tesla-refresh-token').value = '';
        if ($('tesla-client-secret')) $('tesla-client-secret').value = '';
        if ($('tesla-chalet-ip')) $('tesla-chalet-ip').value = '';
        if ($('tesla-chalet-lat')) $('tesla-chalet-lat').value = '';
        if ($('tesla-chalet-lon')) $('tesla-chalet-lon').value = '';
        await loadTeslaCreds();
        renderTeslaTab(true);
      } else {
        showMsg('Failed to clear credentials', true);
      }
    } catch (err) {
      showMsg(`Network error: ${err.message}`, true);
    }
  });

  pollBtn?.addEventListener('click', async () => {
    if (pollBtn) { pollBtn.disabled = true; pollBtn.textContent = 'Polling…'; }
    showMsg('Polling Tesla Wall Connectors and official Tesla API…', false, 0);

    try {
      const res = await fetch('/api/tesla/poll', { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        const devs = Array.isArray(data) ? data : (data.devices || []);
        showMsg(`✓ Poll completed! Discovered ${devs.length} device(s).`);
        lastTeslaDevices = data;
        _lastTeslaPollTs = Date.now();
        renderTeslaTab(true);
      } else {
        showMsg(`Poll error: ${data.detail || 'Failed to poll Tesla devices'}`, true);
      }
    } catch (err) {
      showMsg(`Network error: ${err.message}`, true);
    } finally {
      if (pollBtn) { pollBtn.disabled = false; pollBtn.textContent = 'Poll now'; }
    }
  });
}

function initTeslaTab() {
  // Location filter pills
  document.querySelectorAll('.tesla-loc-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      _teslaLocFilter = pill.dataset.loc || 'all';
      document.querySelectorAll('.tesla-loc-pill').forEach(p => {
        p.classList.toggle('on', p.dataset.loc === _teslaLocFilter);
      });
      renderTeslaTab();
    });
  });

  // Tab poll button
  $('tesla-tab-poll-btn')?.addEventListener('click', async () => {
    const btn = $('tesla-tab-poll-btn');
    if (btn) btn.disabled = true;
    try {
      const res = await fetch('/api/tesla/poll', { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        lastTeslaDevices = data;
        _lastTeslaPollTs = Date.now();
        renderTeslaTab();
      }
    } catch (err) {
      console.warn('Failed to poll Tesla devices:', err);
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  // Empty state button
  $('tesla-go-settings-btn')?.addEventListener('click', () => {
    switchTab('settings');
    selectSettingsSubtab('integrations');
    const card = $('settings-card-tesla');
    if (card) {
      card.scrollIntoView({ behavior: 'smooth' });
      card.classList.remove('collapsed');
    }
  });
}

async function renderTeslaTab(forceRefresh = false) {
  const container = $('tesla-devices-container');
  if (!container) return;

  const devList = Array.isArray(lastTeslaDevices)
    ? lastTeslaDevices
    : (lastTeslaDevices?.devices || [
        ...(lastTeslaDevices?.wall_connectors || []),
        ...(lastTeslaDevices?.vehicles || []),
      ]);
  const hasCachedDevs = devList.length > 0;
  const needsFetch = forceRefresh || !hasCachedDevs || (devList.length <= 1 && lastTeslaCredsStatus?.has_tesla_auth);

  if (needsFetch) {
    try {
      const res = await fetch('/api/tesla/devices');
      if (res.ok) {
        lastTeslaDevices = await res.json();
        _lastTeslaPollTs = Date.now();
      }
    } catch (e) {
      console.warn('Failed to load Tesla devices:', e);
    }
  }

  // Update Last poll time
  const pollTimeEl = $('tesla-last-poll-time');
  if (pollTimeEl) {
    if (_lastTeslaPollTs) {
      const elapsedM = Math.max(0, Math.round((Date.now() - _lastTeslaPollTs) / 60000));
      pollTimeEl.textContent = elapsedM === 0 ? 'Last update: just now' : `Last update: ${elapsedM}m ago`;
    } else {
      pollTimeEl.textContent = 'Last update: active';
    }
  }

  const allDevs = Array.isArray(lastTeslaDevices)
    ? lastTeslaDevices
    : (lastTeslaDevices?.devices || [
        ...(lastTeslaDevices?.wall_connectors || []),
        ...(lastTeslaDevices?.vehicles || []),
      ]);

  const wcs = allDevs.filter(d => d.device_type === 'ev_charger' || d.charger_type === 'wall_connector');
  const vehs = allDevs.filter(d => d.device_type === 'ev_vehicle' || d.device_type === 'vehicle');

  // Location filter
  const filterLoc = _teslaLocFilter;
  const filteredWcs = (filterLoc === 'all')
    ? wcs
    : wcs.filter(w => (w.location_id || '').toLowerCase() === filterLoc.toLowerCase());

  const filteredVehs = (filterLoc === 'all')
    ? vehs
    : vehs.filter(v => (v.location_id || '').toLowerCase() === filterLoc.toLowerCase() || (v.inferred_charger && v.inferred_charger.location === filterLoc));

  // Empty state toggle
  const isEmpty = (wcs.length === 0 && vehs.length === 0);
  const emptyEl = $('tesla-empty');
  if (emptyEl) emptyEl.hidden = !isEmpty;

  // Compute KPIs
  let totalPowerW = 0;
  for (const w of filteredWcs) {
    const isChg = w.is_charging ?? w.charging;
    if (isChg && w.power_w) totalPowerW += w.power_w;
  }
  for (const v of filteredVehs) {
    const isCharging = v.is_charging ?? (v.charging_state === 'Charging' || (v.power_w && v.power_w > 100));
    const isMobileOrAway = v.charger_type?.startsWith('mobile') || v.inferred_charger?.is_mobile || v.charger_type === 'supercharger' || v.inferred_charger?.type === 'supercharger';
    if (isCharging && (isMobileOrAway || filteredWcs.length === 0)) {
      totalPowerW += (v.power_w || 0);
    }
  }

  const kpiPowerEl = $('tesla-kpi-power');
  const kpiPowerSubEl = $('tesla-kpi-power-sub');
  if (kpiPowerEl) {
    if (totalPowerW >= 1000) {
      kpiPowerEl.textContent = `${(totalPowerW / 1000).toFixed(1)} kW`;
    } else {
      kpiPowerEl.textContent = `${Math.round(totalPowerW)} W`;
    }
  }
  if (kpiPowerSubEl) {
    const activeCount = filteredWcs.filter(w => (w.is_charging ?? w.charging)).length +
                        filteredVehs.filter(v => (v.is_charging ?? (v.charging_state === 'Charging'))).length;
    kpiPowerSubEl.textContent = activeCount > 0 ? `${activeCount} session(s) active` : 'EVSE idle';
  }

  // Model Y Battery SOC%
  const kpiBattEl = $('tesla-kpi-battery');
  const kpiBattSubEl = $('tesla-kpi-battery-sub');
  const primaryVeh = vehs[0];
  if (kpiBattEl) {
    const batt = primaryVeh ? (primaryVeh.battery_level ?? primaryVeh.battery_soc) : null;
    if (batt != null) {
      kpiBattEl.textContent = `${batt}%`;
    } else {
      kpiBattEl.textContent = '—';
    }
  }
  if (kpiBattSubEl) {
    if (primaryVeh && primaryVeh.battery_range_km != null) {
      kpiBattSubEl.textContent = `~${Math.round(primaryVeh.battery_range_km)} km range`;
    } else {
      kpiBattSubEl.textContent = 'State of Charge';
    }
  }

  // Vehicle Location
  const kpiLocEl = $('tesla-kpi-location');
  const kpiLocSubEl = $('tesla-kpi-location-sub');
  if (kpiLocEl) {
    if (primaryVeh) {
      kpiLocEl.textContent = primaryVeh.location_name || primaryVeh.geofence_name || 'Away';
    } else {
      kpiLocEl.textContent = '—';
    }
  }
  if (kpiLocSubEl) {
    if (primaryVeh && primaryVeh.latitude && primaryVeh.longitude) {
      kpiLocSubEl.textContent = `${primaryVeh.latitude.toFixed(3)}°, ${primaryVeh.longitude.toFixed(3)}°`;
    } else {
      kpiLocSubEl.textContent = 'GPS Geofence';
    }
  }

  // Active Charger
  const kpiChgEl = $('tesla-kpi-charger');
  const kpiChgSubEl = $('tesla-kpi-charger-sub');
  if (kpiChgEl) {
    const isVehChg = primaryVeh && (primaryVeh.is_charging ?? (primaryVeh.charging_state === 'Charging'));
    if (isVehChg) {
      kpiChgEl.textContent = primaryVeh.charger_name || primaryVeh.inferred_charger?.name || 'Charging';
    } else {
      const activeWc = filteredWcs.find(w => (w.is_charging ?? w.charging));
      if (activeWc) {
        kpiChgEl.textContent = activeWc.name || activeWc.device_name;
      } else {
        kpiChgEl.textContent = (primaryVeh?.charging_state === 'Disconnected') ? 'Disconnected' : 'Idle';
      }
    }
  }
  if (kpiChgSubEl) {
    const isVehChg = primaryVeh && (primaryVeh.is_charging ?? (primaryVeh.charging_state === 'Charging'));
    if (isVehChg) {
      const v = primaryVeh.charger_voltage || 0;
      const a = primaryVeh.charger_actual_current || 0;
      kpiChgSubEl.textContent = `${v}V @ ${a}A · ${((primaryVeh.power_w || 0) / 1000).toFixed(1)} kW`;
    } else {
      kpiChgSubEl.textContent = 'EVSE in use';
    }
  }

  // Render cards
  let html = '';
  for (const wc of filteredWcs) {
    html += renderTeslaWallConnectorCard(wc);
  }
  for (const veh of filteredVehs) {
    html += renderTeslaVehicleCard(veh);
  }
  container.innerHTML = html;

  wireTeslaCardListeners(container);

  // Trigger loading & drawing for all open device charts
  for (const d of [...filteredWcs, ...filteredVehs]) {
    if (!_teslaClosedDeviceHistories.has(d.device_sn)) {
      requestAnimationFrame(() => loadAndDrawTeslaDeviceChart(d.device_sn));
    }
  }

  // Bind window resize listener once to keep canvas crisp
  if (!_teslaResizeBound) {
    _teslaResizeBound = true;
    window.addEventListener('resize', () => {
      if (activeTab === 'tesla') {
        container.querySelectorAll('canvas[id^="chart-tesla-dev-"]').forEach(canvas => {
          if (canvas._redraw) canvas._redraw();
        });
      }
    });
  }
}

function renderTeslaWallConnectorCard(wc) {
  const isCharging = wc.is_charging ?? wc.charging ?? false;
  const isConn = wc.vehicle_connected ?? false;
  const isHistOpen = !_teslaClosedDeviceHistories.has(wc.device_sn);
  const curHours = _teslaDevHours[wc.device_sn] || 24;
  const devName = wc.name || wc.device_name || 'Tesla Wall Connector';
  const volt = wc.grid_v ?? wc.voltage_v ?? 0;
  const curr = wc.current_a ?? 0;
  const pwr = wc.power_w ?? 0;
  const sessionKwh = wc.session_kwh ?? ((wc.session_energy_wh || 0) / 1000);
  const lifetimeKwh = wc.lifetime_kwh ?? ((wc.lifetime_energy_wh || 0) / 1000);

  const isCloudOnly = !wc.ip || wc.is_cloud;

  let voltCurrHtml = `${volt}<small>V</small> · ${curr}<small>A</small>`;
  if (isCloudOnly && wc.grid_v == null) {
    if (isCharging && pwr > 0) {
      voltCurrHtml = `~240<small>V</small> · ${Math.round(pwr / 240)}<small>A</small>`;
    } else {
      voltCurrHtml = `<span style="font-size:12px; color:var(--text-dim, #94a3b8)">— <small>(Cloud)</small></span>`;
    }
  }

  let lifetimeHtml = `${lifetimeKwh.toLocaleString([], { maximumFractionDigits: 1 })}<small>kWh</small>`;
  if (isCloudOnly && (wc.lifetime_energy_wh == null && wc.lifetime_kwh == null)) {
    lifetimeHtml = `<span style="font-size:12px; color:var(--text-dim, #94a3b8)">— <small>(LAN only)</small></span>`;
  }

  let sessionHtml = `${sessionKwh.toFixed(2)}<small>kWh</small>`;
  if (isCloudOnly && (wc.session_energy_wh == null && wc.session_kwh == null)) {
    sessionHtml = isCharging ? `${sessionKwh.toFixed(2)}<small>kWh</small>` : `<span style="font-size:12px; color:var(--text-dim, #94a3b8)">— <small>(Standby)</small></span>`;
  }

  let contactorText = wc.contactor_closed ? 'Closed (Engaged)' : (isCloudOnly ? 'Standby (Cloud)' : 'Open');
  let contactorColor = wc.contactor_closed ? '#38bdf8' : 'inherit';

  let badgeClass = 'tesla-badge-idle';
  let badgeText = 'Idle';
  if (isCharging) {
    badgeClass = 'tesla-badge-charging';
    badgeText = `⚡ Charging (${(pwr / 1000).toFixed(1)} kW)`;
  } else if (isConn) {
    badgeClass = 'tesla-badge-connected';
    badgeText = 'Vehicle Connected';
  }

  return `
    <div class="card tesla-card ${isCharging ? 'is-charging' : ''}" id="card-${escapeHtml(wc.device_sn)}">
      <div class="tesla-card-header">
        <div class="tesla-card-title-group">
          <div class="tesla-card-icon">⚡</div>
          <div>
            <h3 class="tesla-card-name">${escapeHtml(devName)}</h3>
            <div class="tesla-card-meta">
              <span class="tesla-loc-tag">${escapeHtml((wc.location_id || 'home').toUpperCase())}</span>
              <span>· ${wc.ip ? `IP: ${escapeHtml(wc.ip)}` : 'Tesla Cloud'}</span>
            </div>
          </div>
        </div>
        <span class="tesla-badge ${badgeClass}">${escapeHtml(badgeText)}</span>
      </div>

      <div class="tesla-card-body">
        <div class="tesla-metrics-grid">
          <div class="tesla-metric">
            <div class="tesla-metric-label">Active Power</div>
            <div class="tesla-metric-val">${pwr >= 1000 ? (pwr / 1000).toFixed(2) + '<small>kW</small>' : Math.round(pwr) + '<small>W</small>'}</div>
          </div>
          <div class="tesla-metric">
            <div class="tesla-metric-label">Voltage & Current</div>
            <div class="tesla-metric-val">${voltCurrHtml}</div>
          </div>
          <div class="tesla-metric">
            <div class="tesla-metric-label">Session Energy</div>
            <div class="tesla-metric-val">${sessionHtml}</div>
          </div>
          <div class="tesla-metric">
            <div class="tesla-metric-label">Lifetime Energy</div>
            <div class="tesla-metric-val">${lifetimeHtml}</div>
          </div>
        </div>

        <div style="display:flex; justify-content:space-between; align-items:center; font-size:12px; color:var(--text-dim, #94a3b8); margin-top:2px;">
          <span>Contactor: <b style="color:${contactorColor}">${contactorText}</b></span>
          ${wc.handle_temp_c != null ? `<span>Handle: <b>${Math.round(wc.handle_temp_c)}°C</b></span>` : ''}
        </div>

        <!-- History Chart Section -->
        <div style="margin-top: 10px; border-top: 1px solid rgba(255, 255, 255, 0.06); padding-top: 10px;">
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <button type="button" class="btn btn-ghost btn-tiny tesla-toggle-hist-btn" data-sn="${escapeHtml(wc.device_sn)}" style="font-size:12px;">
              <span>${isHistOpen ? '▼' : '▶'}</span> History
            </button>
            <div class="tesla-dev-range-picker" data-sn="${escapeHtml(wc.device_sn)}" style="${isHistOpen ? 'display:flex; gap:4px;' : 'display:none;'}">
              <button class="btn btn-ghost btn-tiny ${curHours === 6 ? 'active' : ''}" data-hours="6" data-sn="${escapeHtml(wc.device_sn)}">6h</button>
              <button class="btn btn-ghost btn-tiny ${curHours === 24 ? 'active' : ''}" data-hours="24" data-sn="${escapeHtml(wc.device_sn)}">24h</button>
              <button class="btn btn-ghost btn-tiny ${curHours === 168 ? 'active' : ''}" data-hours="168" data-sn="${escapeHtml(wc.device_sn)}">7d</button>
            </div>
          </div>

          <div id="tesla-hist-body-${escapeHtml(wc.device_sn)}" style="${isHistOpen ? 'display:block;' : 'display:none;'} margin-top:8px;">
            <canvas id="chart-tesla-dev-${escapeHtml(wc.device_sn)}" style="width:100%; height:160px; display:block;"></canvas>
            <div style="display:flex; justify-content:flex-end; gap:12px; font-size:11px; color:var(--text-dim, #94a3b8); margin-top:4px;">
              <span><span style="display:inline-block; width:10px; height:2px; background:#38bdf8; vertical-align:middle;"></span> Power (kW)</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderTeslaVehicleCard(veh) {
  const isCharging = veh.is_charging ?? (veh.charging_state === 'Charging' || (veh.power_w && veh.power_w > 100));
  const soc = veh.battery_level != null ? Math.round(veh.battery_level) : (veh.battery_soc != null ? Math.round(veh.battery_soc) : null);
  const rangeKm = veh.battery_range_km != null ? Math.round(veh.battery_range_km) : null;
  const isHistOpen = !_teslaClosedDeviceHistories.has(veh.device_sn);
  const curHours = _teslaDevHours[veh.device_sn] || 24;
  const devName = veh.name || veh.device_name || 'Tesla Model Y';
  const pwrW = veh.power_w || (veh.charger_power_kw ? veh.charger_power_kw * 1000 : 0);
  const chgName = veh.charger_name || veh.inferred_charger?.name || (isCharging ? 'Charging' : 'Idle');
  const isMobile = veh.charger_type?.startsWith('mobile') || veh.inferred_charger?.is_mobile;
  const locName = veh.location_name || veh.geofence_name || 'Away';
  const timeRem = veh.time_to_full_charge_hours ?? veh.time_to_full_charge_hrs ?? 0;

  let inferChipHtml = '';
  if (isCharging) {
    inferChipHtml = `
      <div class="tesla-charger-infer-chip">
        <span style="font-size:18px;">🔌</span>
        <div style="flex:1;">
          <div style="font-weight:600; font-size:13px; color:#38bdf8;">${escapeHtml(chgName)}</div>
          <div style="font-size:11px; color:var(--text-dim, #94a3b8); margin-top:1px;">
            ${escapeHtml(isMobile ? 'Mobile Connector inferred via GPS & demand pattern' : 'EVSE session')}
          </div>
        </div>
        <span class="tesla-badge tesla-badge-charging">${(pwrW / 1000).toFixed(1)} kW</span>
      </div>
    `;
  }

  let badgeClass = 'tesla-badge-idle';
  let badgeText = veh.charging_state || 'Standby';
  if (veh.is_asleep) {
    badgeClass = 'tesla-badge-idle';
    badgeText = '💤 Asleep';
  } else if (isCharging) {
    badgeClass = 'tesla-badge-charging';
    badgeText = `⚡ ${(pwrW / 1000).toFixed(1)} kW`;
  } else if (veh.charging_state === 'Complete') {
    badgeClass = 'tesla-badge-connected';
    badgeText = 'Charge Complete';
  }

  const wakeBtnHtml = veh.is_asleep && veh.vin ? `
    <button type="button" class="btn btn-ghost btn-tiny tesla-wake-vehicle-btn" data-vin="${escapeHtml(veh.vin)}" style="font-size:11px; padding:2px 8px; border-color:rgba(56,189,248,0.3); color:#38bdf8;" title="Wake car from sleep">
      ⚡ Wake Up
    </button>
  ` : '';

  return `
    <div class="card tesla-card ${isCharging ? 'is-charging' : ''}" id="card-${escapeHtml(veh.device_sn)}">
      <div class="tesla-card-header">
        <div class="tesla-card-title-group">
          <div class="tesla-card-icon">🚗</div>
          <div>
            <h3 class="tesla-card-name">${escapeHtml(devName)}</h3>
            <div class="tesla-card-meta">
              <span class="tesla-loc-tag">${escapeHtml(locName.toUpperCase())}</span>
              <span>· VIN: …${escapeHtml((veh.vin || '').slice(-6))}</span>
            </div>
          </div>
        </div>
        <div style="display:flex; align-items:center; gap:8px;">
          ${wakeBtnHtml}
          <span class="tesla-badge ${badgeClass}">${escapeHtml(badgeText)}</span>
        </div>
      </div>

      <div class="tesla-card-body">
        <!-- Battery Gauge -->
        <div class="tesla-battery-gauge">
          <div style="display:flex; justify-content:space-between; align-items:baseline;">
            <div>
              <span style="font-size:24px; font-weight:700; color:var(--text, #f8fafc);">${soc != null ? `${soc}%` : '—%'}</span>
              <span style="font-size:13px; color:var(--text-dim, #94a3b8); margin-left:6px;">${rangeKm != null ? `${rangeKm} km est.` : '—'}</span>
            </div>
            <div style="font-size:12px; color:var(--text-dim, #94a3b8);">
              Limit: <b>${veh.charge_limit_soc != null ? veh.charge_limit_soc + '%' : '—'}</b>
            </div>
          </div>
          <div class="tesla-battery-bar-track">
            <div class="tesla-battery-bar-fill ${isCharging ? 'charging' : ''}" style="width:${soc != null ? Math.min(100, Math.max(0, soc)) : 0}%;"></div>
          </div>
          ${isCharging && timeRem > 0 ? `
            <div style="font-size:11px; color:#38bdf8; text-align:right; margin-top:2px;">
              ~${timeRem.toFixed(1)}h remaining until full
            </div>
          ` : ''}
        </div>

        ${inferChipHtml}

        <div class="tesla-metrics-grid">
          <div class="tesla-metric">
            <div class="tesla-metric-label">Charge Rate</div>
            <div class="tesla-metric-val">${veh.charger_voltage || 0}<small>V</small> @ ${veh.charger_actual_current || 0}<small>A</small></div>
          </div>
          <div class="tesla-metric">
            <div class="tesla-metric-label">Power Draw</div>
            <div class="tesla-metric-val">${(pwrW / 1000).toFixed(1)}<small>kW</small></div>
          </div>
          <div class="tesla-metric">
            <div class="tesla-metric-label">Energy Added</div>
            <div class="tesla-metric-val">${(veh.charge_energy_added_kwh || 0).toFixed(1)}<small>kWh</small></div>
          </div>
          <div class="tesla-metric">
            <div class="tesla-metric-label">Location / Geofence</div>
            <div class="tesla-metric-val" style="font-size:14px; text-overflow:ellipsis; overflow:hidden; white-space:nowrap;">${escapeHtml(locName)}</div>
          </div>
        </div>

        <!-- History Chart Section -->
        <div style="margin-top: 10px; border-top: 1px solid rgba(255, 255, 255, 0.06); padding-top: 10px;">
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <button type="button" class="btn btn-ghost btn-tiny tesla-toggle-hist-btn" data-sn="${escapeHtml(veh.device_sn)}" style="font-size:12px;">
              <span>${isHistOpen ? '▼' : '▶'}</span> History
            </button>
            <div class="tesla-dev-range-picker" data-sn="${escapeHtml(veh.device_sn)}" style="${isHistOpen ? 'display:flex; gap:4px;' : 'display:none;'}">
              <button class="btn btn-ghost btn-tiny ${curHours === 6 ? 'active' : ''}" data-hours="6" data-sn="${escapeHtml(veh.device_sn)}">6h</button>
              <button class="btn btn-ghost btn-tiny ${curHours === 24 ? 'active' : ''}" data-hours="24" data-sn="${escapeHtml(veh.device_sn)}">24h</button>
              <button class="btn btn-ghost btn-tiny ${curHours === 168 ? 'active' : ''}" data-hours="168" data-sn="${escapeHtml(veh.device_sn)}">7d</button>
            </div>
          </div>

          <div id="tesla-hist-body-${escapeHtml(veh.device_sn)}" style="${isHistOpen ? 'display:block;' : 'display:none;'} margin-top:8px;">
            <canvas id="chart-tesla-dev-${escapeHtml(veh.device_sn)}" style="width:100%; height:160px; display:block;"></canvas>
            <div style="display:flex; justify-content:flex-end; gap:12px; font-size:11px; color:var(--text-dim, #94a3b8); margin-top:4px;">
              <span><span style="display:inline-block; width:10px; height:2px; background:#10b981; vertical-align:middle;"></span> SOC (%)</span>
              <span><span style="display:inline-block; width:10px; height:2px; background:#38bdf8; vertical-align:middle;"></span> Power (kW)</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}

function wireTeslaCardListeners(container) {
  container.querySelectorAll('.tesla-wake-vehicle-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const vin = btn.dataset.vin;
      if (!vin) return;
      btn.disabled = true;
      btn.textContent = '⏳ Waking...';
      try {
        const res = await fetch(`/api/tesla/vehicle/${encodeURIComponent(vin)}/wake`, { method: 'POST' });
        if (res.ok) {
          const rDevs = await fetch('/api/tesla/devices');
          if (rDevs.ok) {
            lastTeslaDevices = await rDevs.json();
            _lastTeslaPollTs = Date.now();
            renderTeslaTab();
          }
        } else {
          const err = await res.json().catch(() => ({}));
          alert(`Wake command failed: ${err.detail || res.statusText}`);
          btn.disabled = false;
          btn.textContent = '⚡ Wake Up';
        }
      } catch (err) {
        console.warn('Wake request error:', err);
        btn.disabled = false;
        btn.textContent = '⚡ Wake Up';
      }
    });
  });

  container.querySelectorAll('.tesla-toggle-hist-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const sn = btn.dataset.sn;
      const body = $(`tesla-hist-body-${sn}`);
      const picker = container.querySelector(`.tesla-dev-range-picker[data-sn="${sn}"]`);
      const arrow = btn.querySelector('span');
      if (!_teslaClosedDeviceHistories.has(sn)) {
        // Was open -> collapse it
        _teslaClosedDeviceHistories.add(sn);
        if (body) body.style.display = 'none';
        if (picker) picker.style.display = 'none';
        if (arrow) arrow.textContent = '▶';
      } else {
        // Was closed -> expand it
        _teslaClosedDeviceHistories.delete(sn);
        if (body) body.style.display = 'block';
        if (picker) picker.style.display = 'flex';
        if (arrow) arrow.textContent = '▼';
        loadAndDrawTeslaDeviceChart(sn);
      }
    });
  });

  container.querySelectorAll('.tesla-dev-range-picker button').forEach(btn => {
    btn.addEventListener('click', () => {
      const sn = btn.dataset.sn;
      const hours = parseInt(btn.dataset.hours, 10);
      _teslaDevHours[sn] = hours;
      const parent = btn.closest('.tesla-dev-range-picker');
      if (parent) {
        parent.querySelectorAll('button').forEach(b => b.classList.toggle('active', b === btn));
      }
      loadAndDrawTeslaDeviceChart(sn, true);
    });
  });
}

async function loadAndDrawTeslaDeviceChart(sn, force = false) {
  const hours = _teslaDevHours[sn] || 24;
  const cacheKey = `${sn}_${hours}`;
  const now = Date.now();
  const cached = _teslaDevHistData[cacheKey];

  // Draw cached data immediately to prevent blank canvas on periodic re-renders
  if (cached?.data) {
    drawTeslaDeviceChart(sn, cached.data, hours);
  }

  const needsFetch = force || !cached || (now - cached.ts >= 45000);
  if (needsFetch) {
    try {
      const r = await fetch(`/api/tesla/history/device?device_sn=${encodeURIComponent(sn)}&hours=${hours}`);
      if (r.ok) {
        const j = await r.json();
        const hist = j.history || [];
        _teslaDevHistData[cacheKey] = { ts: Date.now(), data: hist };
        drawTeslaDeviceChart(sn, hist, hours);
      }
    } catch (e) {
      console.warn('Failed to load Tesla device history:', e);
    }
  }
}

function drawTeslaDeviceChart(sn, hist, hours) {
  const canvas = $(`chart-tesla-dev-${sn}`);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const rect = canvas.getBoundingClientRect();
  if (rect.width < 50 && canvas.isConnected) {
    requestAnimationFrame(() => {
      const r = canvas.getBoundingClientRect();
      if (r.width >= 50) {
        drawTeslaDeviceChart(sn, hist, hours);
      }
    });
    return;
  }

  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(100, Math.floor(rect.width));
  const h = Math.max(80, Math.floor(rect.height || 160));
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr;
    canvas.height = h * dpr;
  }
  ctx.resetTransform?.();
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);

  const padL = 40, padR = 35, padT = 16, padB = 24;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;
  const baseY = h - padB;

  if (!hist || hist.length === 0) {
    ctx.fillStyle = '#6b7280';
    ctx.font = '12px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('No history data recorded yet', w / 2, h / 2);
    return;
  }

  const step = Math.max(1, Math.floor(hist.length / 180));
  const plotHist = [];
  for (let i = 0; i < hist.length; i += step) {
    plotHist.push(hist[i]);
  }

  const powersKw = plotHist.map(p => (p.power_w || 0) / 1000);
  const maxKw = Math.max(12, Math.ceil(Math.max(...powersKw, 1) / 2) * 2);
  const xs = (idx) => padL + (plotW * idx) / Math.max(1, plotHist.length - 1);
  const yPower = (kw) => baseY - (plotH * Math.max(0, Math.min(maxKw, kw))) / maxKw;

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 3; i++) {
    const y = padT + (plotH * i) / 3;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(w - padR, y);
    ctx.stroke();

    const kwVal = maxKw * (3 - i) / 3;
    ctx.fillStyle = '#6b7280';
    ctx.font = '10px Inter, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(`${kwVal.toFixed(0)}k`, padL - 5, y + 3);
  }

  if (plotHist.length >= 2) {
    const first = plotHist[0].ts || 0, last = plotHist[plotHist.length - 1].ts || 0;
    const spanH = (last - first) / 3600;
    ctx.fillStyle = '#6b7280';
    ctx.textAlign = 'center';
    const ticks = Math.min(4, plotHist.length - 1);
    for (let i = 0; i <= ticks; i++) {
      const idx = Math.round((plotHist.length - 1) * (i / ticks));
      const ts = plotHist[idx].ts || (first + (last - first) * (i / ticks));
      const d = new Date(ts * 1000);
      const str = (spanH > 24)
        ? (d.toLocaleDateString([], { month: 'numeric', day: 'numeric' }) + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))
        : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      ctx.fillText(str, xs(idx), h - 7);
    }
  }

  drawAreaFill(ctx, powersKw, xs, yPower, baseY, '#38bdf8', 0.15);
  drawSmoothLine(ctx, powersKw, xs, yPower, '#38bdf8', 2.0);

  const hasSoc = plotHist.some(p => p.battery_soc != null && Number.isFinite(p.battery_soc));
  if (hasSoc) {
    const socs = plotHist.map(p => p.battery_soc);
    const ySoc = (val) => baseY - (plotH * Math.max(0, Math.min(100, val || 0))) / 100;
    drawSmoothLine(ctx, socs, xs, ySoc, '#10b981', 1.8);

    ctx.fillStyle = '#10b981';
    ctx.font = '10px Inter, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('100%', w - padR + 5, padT + 3);
    ctx.fillText('50%', w - padR + 5, padT + plotH / 2 + 3);
    ctx.fillText('0%', w - padR + 5, baseY + 3);
  }

  canvas._redraw = () => drawTeslaDeviceChart(sn, hist, hours);

  _attachChartHover(canvas, plotHist, (idx) => {
    const p = plotHist[idx];
    if (!p) return '';
    const d = new Date(p.ts * 1000);
    const tsStr = d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }) + ' ' +
                  d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const kw = (p.power_w || 0) / 1000;
    let rows = `
      <div class="cht-ts">${escapeHtml(tsStr)}</div>
      <div class="cht-row"><i style="background:#38bdf8"></i> Power: <b>${kw.toFixed(2)} kW</b></div>
    `;
    if (p.battery_soc != null) {
      rows += `<div class="cht-row"><i style="background:#10b981"></i> SOC: <b>${Math.round(p.battery_soc)}%</b></div>`;
    }
    return rows;
  }, () => ({ xs, padL, padR, w, h, baseY, padT, padB }));
}


// ============================================================
// KASA SMART DEVICES TAB (Plugs, Switches, Interruptors)
// ============================================================
let lastKasaDevices = [];
let _lastKasaPollTs = 0;
let _kasaLocFilter = 'all';
let _kasaTypeFilter = 'all';
let _kasaAutoDiscovered = false;
let _kasaDevHours = {};
let _kasaDevHistData = {};
let _kasaExpandedDrawers = new Set();

function initKasaTab() {
  // Location filter pills
  document.querySelectorAll('#kasa-loc-pills .kasa-loc-pill').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#kasa-loc-pills .kasa-loc-pill').forEach(b => b.classList.remove('on'));
      btn.classList.add('on');
      _kasaLocFilter = btn.dataset.loc || 'all';
      renderKasaTab();
    });
  });

  // Type filter pills
  document.querySelectorAll('#kasa-type-pills .kasa-type-pill').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#kasa-type-pills .kasa-type-pill').forEach(b => b.classList.remove('on'));
      btn.classList.add('on');
      _kasaTypeFilter = btn.dataset.type || 'all';
      renderKasaTab();
    });
  });

  // Poll button
  $('kasa-tab-poll-btn')?.addEventListener('click', async () => {
    const btn = $('kasa-tab-poll-btn');
    if (btn) { btn.disabled = true; btn.classList.add('loading'); }
    try {
      const res = await fetch('/api/kasa/poll', { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        lastKasaDevices = data.devices || [];
        _lastKasaPollTs = Date.now();
        renderKasaTab();
      }
    } catch (e) {
      console.warn('Kasa poll failed:', e);
    } finally {
      if (btn) { btn.disabled = false; btn.classList.remove('loading'); }
    }
  });

  // Empty state scan button
  $('kasa-empty-scan-btn')?.addEventListener('click', () => {
    $('kasa-tab-poll-btn')?.click();
  });

  // Add Device button & Go to Settings button
  const goToSettings = () => {
    switchTab('settings');
    selectSettingsSubtab('integrations');
    const card = $('settings-card-kasa');
    if (card) {
      card.scrollIntoView({ behavior: 'smooth' });
      card.classList.remove('collapsed');
    }
  };
  $('kasa-tab-add-btn')?.addEventListener('click', goToSettings);
  $('kasa-go-settings-btn')?.addEventListener('click', goToSettings);
}

function _isKasaSwitch(dev) {
  const t = (dev.type || '').toLowerCase();
  const m = (dev.model || '').toUpperCase();
  return t.includes('switch') || t.includes('dimmer') || t.includes('wall') ||
         m.startsWith('HS2') || m.startsWith('KS2') || m.startsWith('ES2');
}

function _isKasaPlug(dev) {
  const t = (dev.type || '').toLowerCase();
  const m = (dev.model || '').toUpperCase();
  return t.includes('plug') || t.includes('outlet') ||
         m.startsWith('KP') || m.startsWith('EP') || m.startsWith('HS1');
}

async function renderKasaTab(forceRefresh = false) {
  const container = $('kasa-devices-container');
  if (!container) return;

  if (forceRefresh || !lastKasaDevices.length) {
    try {
      const res = await fetch('/api/kasa/saved?refresh=false');
      if (res.ok) {
        const j = await res.json();
        lastKasaDevices = j.devices || [];
      }
    } catch (e) {
      console.warn('Failed to fetch saved Kasa devices:', e);
    }
  }

  // Auto-discover in background if we only have <= 1 device or haven't auto-discovered yet in this session
  if (!_kasaAutoDiscovered || lastKasaDevices.length <= 1) {
    _kasaAutoDiscovered = true;
    (async () => {
      try {
        const pRes = await fetch('/api/kasa/poll', { method: 'POST' });
        if (pRes.ok) {
          const pj = await pRes.json();
          if (pj.devices && pj.devices.length) {
            lastKasaDevices = pj.devices;
            _lastKasaPollTs = Date.now();
            if (activeTab === 'kasa') renderKasaTab();
          }
        }
      } catch (err) {
        console.warn('Background Kasa auto-discovery error:', err);
      }
    })();
  }

  // Update last poll time
  if ($('kasa-last-poll-time')) {
    if (_lastKasaPollTs > 0) {
      const d = new Date(_lastKasaPollTs);
      $('kasa-last-poll-time').textContent = `Last update: ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
    } else {
      $('kasa-last-poll-time').textContent = 'Last update: active';
    }
  }

  const allDevs = lastKasaDevices || [];
  const emptyEl = $('kasa-empty');

  // KPI Calculations across all devices
  let totalCount = allDevs.length;
  let activeCount = 0;
  let switchCount = 0;
  let plugCount = 0;

  allDevs.forEach(d => {
    if (d.is_on) activeCount++;
    if (_isKasaSwitch(d)) switchCount++;
    else if (_isKasaPlug(d)) plugCount++;
    else plugCount++; // default to plug if unspecified
  });

  if ($('kasa-kpi-total')) $('kasa-kpi-total').textContent = totalCount;
  if ($('kasa-kpi-active')) $('kasa-kpi-active').textContent = activeCount;
  if ($('kasa-kpi-switches')) $('kasa-kpi-switches').textContent = switchCount;
  if ($('kasa-kpi-plugs')) $('kasa-kpi-plugs').textContent = plugCount;

  if (totalCount === 0) {
    if (emptyEl) emptyEl.hidden = false;
    container.innerHTML = '';
    return;
  }
  if (emptyEl) emptyEl.hidden = true;

  // Filter devices
  let filtered = allDevs.filter(d => {
    // Location filter
    if (_kasaLocFilter !== 'all') {
      const dLoc = (d.location_id || 'maison').toLowerCase();
      if (dLoc !== _kasaLocFilter.toLowerCase()) return false;
    }
    // Type filter
    if (_kasaTypeFilter === 'switch') {
      return _isKasaSwitch(d);
    } else if (_kasaTypeFilter === 'plug') {
      return _isKasaPlug(d) || !_isKasaSwitch(d);
    }
    return true;
  });

  if (filtered.length === 0) {
    container.innerHTML = `
      <div class="card" style="grid-column: 1 / -1; text-align: center; padding: 36px 20px;">
        <div style="font-size: 32px; margin-bottom: 8px;">🔍</div>
        <h3 style="margin: 0 0 6px 0; font-size: 16px;">No devices match the selected filters</h3>
        <p class="hint" style="margin: 0;">Try selecting "All Locations" or "All Types".</p>
      </div>
    `;
    return;
  }

  // Render cards
  container.innerHTML = filtered.map(d => {
    const isSw = _isKasaSwitch(d);
    const isOn = !!d.is_on;
    const isOnline = d.online !== false && d.status !== 'offline';
    const icon = isSw ? (isOn ? '💡' : '🔘') : '🔌';
    const typeLabel = isSw ? 'Switch' : 'Plug';
    const typeClass = isSw ? 'switch' : 'plug';
    const alias = escapeHtml(d.alias || d.host);
    const model = escapeHtml(d.model || 'Kasa Device');
    const host = escapeHtml(d.host);
    const locName = d.location_id ? (d.location_id.charAt(0).toUpperCase() + d.location_id.slice(1)) : 'Maison';
    const sn = d.device_sn || `kasa_${host.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
    const snEsc = escapeHtml(sn);
    const isExpanded = _kasaExpandedDrawers.has(sn);
    const devHours = _kasaDevHours[sn] || 24;

    let powerText = '—';
    if (d.power_w != null) {
      powerText = `${d.power_w.toFixed(1)} W`;
    } else if (isSw) {
      powerText = 'Switch only';
    } else {
      powerText = 'No power meter';
    }

    let runtimeText = '—';
    if (d.today_runtime_min != null && d.today_runtime_min > 0) {
      const rh = Math.floor(d.today_runtime_min / 60);
      const rm = d.today_runtime_min % 60;
      runtimeText = rh > 0 ? `${rh}h ${rm}m` : `${rm}m`;
    }

    let energyText = '—';
    if (d.today_kwh != null && d.today_kwh > 0) {
      energyText = `${d.today_kwh.toFixed(2)} kWh`;
    } else if (runtimeText !== '—') {
      energyText = runtimeText;
    }

    return `
      <div class="kasa-card ${isOn ? 'is-on' : ''}" id="kasa-card-${snEsc}">
        <div class="kasa-card-header">
          <div class="kasa-card-title-group">
            <span class="kasa-card-icon">${icon}</span>
            <div>
              <h3 class="kasa-card-name">${alias}</h3>
              <div class="kasa-card-meta">${model} · ${host}</div>
            </div>
          </div>
          <div class="kasa-card-badges">
            <span class="kasa-type-badge ${typeClass}">${typeLabel}</span>
            <span class="pill ${isOnline ? 'pill-online' : 'pill-offline'}" style="font-size:10px; padding:2px 6px;">
              ${isOnline ? '● Online' : '○ Offline'}
            </span>
          </div>
        </div>

        <div class="kasa-card-body">
          <div class="kasa-metrics-grid">
            <div class="kasa-metric">
              <div class="kasa-metric-label">Status</div>
              <div class="kasa-metric-val" style="color:${isOn ? 'var(--accent, #10b981)' : 'var(--text-dim, #94a3b8)'}">
                ${isOn ? '● Turned ON' : '○ Turned OFF'}
              </div>
            </div>
            <div class="kasa-metric">
              <div class="kasa-metric-label">Power Draw</div>
              <div class="kasa-metric-val">${powerText}</div>
            </div>
            <div class="kasa-metric">
              <div class="kasa-metric-label">Today's Usage</div>
              <div class="kasa-metric-val" style="color:${energyText !== '—' ? 'var(--accent, #10b981)' : 'inherit'}">${energyText}</div>
            </div>
            <div class="kasa-metric">
              <div class="kasa-metric-label">Location</div>
              <div class="kasa-metric-val">${escapeHtml(locName)}</div>
            </div>
          </div>

          <div class="kasa-card-actions">
            <button type="button" class="kasa-toggle-btn ${isOn ? 'is-on' : 'is-off'}"
                    data-host="${host}" data-on="${isOn ? 'true' : 'false'}"
                    onclick="toggleKasaDevice('${host}', ${!isOn}, this)">
              <span>${isOn ? '⚡ Turn OFF' : '○ Turn ON'}</span>
            </button>
            <button type="button" class="btn btn-ghost btn-tiny ${isExpanded ? 'active' : ''}"
                    onclick="toggleKasaDeviceHistory('${snEsc}', '${host}')" title="Toggle device history">
              ${isExpanded ? '📉 Hide' : '📈 History'}
            </button>
            <button type="button" class="btn btn-ghost btn-tiny" title="Configure in Settings"
                    onclick="switchTab('settings'); selectSettingsSubtab('integrations'); $('settings-card-kasa')?.classList.remove('collapsed'); $('settings-card-kasa')?.scrollIntoView({behavior:'smooth'});">
              ⚙️
            </button>
          </div>

          ${isExpanded ? `
            <div class="kasa-dev-history-drawer" id="kasa-history-drawer-${snEsc}">
              <div class="kasa-dev-history-header">
                <div class="kasa-dev-history-title-row">
                  <span class="kasa-dev-history-title">📈 ${alias} History</span>
                  <div class="kasa-dev-history-stats" id="kasa-dev-stats-${snEsc}">
                    <span><span class="lbl">Energy:</span> <b id="kasa-dev-energy-${snEsc}">—</b></span>
                    <span><span class="lbl">Peak:</span> <b id="kasa-dev-peak-${snEsc}">—</b></span>
                    <span><span class="lbl">Runtime:</span> <b id="kasa-dev-runtime-${snEsc}">—</b></span>
                  </div>
                </div>
                <div class="kasa-dev-history-controls">
                  <div class="kasa-dev-range-picker">
                    <button type="button" class="kasa-dev-range-btn ${devHours === 6 ? 'on' : ''}" onclick="setKasaDevHistoryHours('${snEsc}', '${host}', 6)">6h</button>
                    <button type="button" class="kasa-dev-range-btn ${devHours === 12 ? 'on' : ''}" onclick="setKasaDevHistoryHours('${snEsc}', '${host}', 12)">12h</button>
                    <button type="button" class="kasa-dev-range-btn ${devHours === 24 ? 'on' : ''}" onclick="setKasaDevHistoryHours('${snEsc}', '${host}', 24)">24h</button>
                    <button type="button" class="kasa-dev-range-btn ${devHours === 168 ? 'on' : ''}" onclick="setKasaDevHistoryHours('${snEsc}', '${host}', 168)">7d</button>
                  </div>
                  <button type="button" class="btn btn-ghost btn-tiny" onclick="toggleKasaDeviceHistory('${snEsc}', '${host}')" title="Close history">✕</button>
                </div>
              </div>
              <div class="kasa-chart-canvas-wrap">
                <canvas id="chart-kasa-dev-${snEsc}" class="kasa-dev-chart"></canvas>
              </div>
              <div class="kasa-chart-legend">
                <span><i style="display:inline-block;width:8px;height:8px;background:#10b981;border-radius:2px;margin-right:4px;"></i> ${d.power_w != null ? 'Power (W)' : 'Active State (ON)'}</span>
              </div>
            </div>
          ` : ''}
        </div>
      </div>
    `;
  }).join('');

  // Draw charts for any open drawers
  filtered.forEach(d => {
    const sn = d.device_sn || `kasa_${d.host.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
    if (_kasaExpandedDrawers.has(sn)) {
      loadKasaDeviceHistory(sn, d.host);
    }
  });
}

async function toggleKasaDeviceHistory(sn, host) {
  if (_kasaExpandedDrawers.has(sn)) {
    _kasaExpandedDrawers.delete(sn);
    renderKasaTab();
    return;
  }
  _kasaExpandedDrawers.add(sn);
  renderKasaTab();
  await loadKasaDeviceHistory(sn, host);
}

async function setKasaDevHistoryHours(sn, host, hours) {
  _kasaDevHours[sn] = hours;
  renderKasaTab();
  await loadKasaDeviceHistory(sn, host, true);
}

async function loadKasaDeviceHistory(sn, host, force = false) {
  const hours = _kasaDevHours[sn] || 24;
  const cacheKey = `${sn}_${hours}`;
  const now = Date.now();
  let hist = null;

  if (!force && _kasaDevHistData[cacheKey] && (now - _kasaDevHistData[cacheKey].ts < 45000)) {
    hist = _kasaDevHistData[cacheKey].data;
  } else {
    try {
      const res = await fetch(`/api/kasa/history/device?device_sn=${encodeURIComponent(sn)}&hours=${hours}`);
      if (res.ok) {
        const j = await res.json();
        hist = j.history || [];
        _kasaDevHistData[cacheKey] = { ts: now, data: hist };
      }
    } catch (e) {
      console.warn('Failed to load Kasa device history:', e);
    }
  }

  if (hist) {
    drawKasaDeviceChart(sn, host, hist, hours);

    const energyEl = $(`kasa-dev-energy-${sn}`);
    const peakEl = $(`kasa-dev-peak-${sn}`);
    const runtimeEl = $(`kasa-dev-runtime-${sn}`);

    if (energyEl) {
      const sumWh = hist.reduce((sum, r) => sum + (r.energy_wh || 0), 0);
      energyEl.textContent = sumWh >= 1000 ? `${(sumWh / 1000).toFixed(2)} kWh` : `${Math.round(sumWh)} Wh`;
    }
    if (peakEl) {
      const maxW = hist.length ? Math.max(...hist.map(r => r.power_w || 0)) : 0;
      peakEl.textContent = maxW > 0 ? `${Math.round(maxW).toLocaleString()} W` : '—';
    }
    if (runtimeEl) {
      const activeMin = hist.filter(r => (r.equipment_status || 0) === 1).length;
      const h = Math.floor(activeMin / 60);
      const m = activeMin % 60;
      runtimeEl.textContent = h > 0 ? `${h}h ${m}m` : `${m}m`;
    }
  }
}

function drawKasaDeviceChart(sn, host, hist, hours) {
  const canvas = $(`chart-kasa-dev-${sn}`);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const rect = canvas.getBoundingClientRect();
  if (rect.width < 50 && canvas.isConnected) {
    requestAnimationFrame(() => {
      const r = canvas.getBoundingClientRect();
      if (r.width >= 50) {
        drawKasaDeviceChart(sn, host, hist, hours);
      }
    });
    return;
  }

  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(100, Math.floor(rect.width));
  const h = Math.max(80, Math.floor(rect.height || 160));
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr;
    canvas.height = h * dpr;
  }
  ctx.resetTransform?.();
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);

  const padL = 44, padR = 24, padT = 16, padB = 24;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;
  const baseY = h - padB;

  if (!hist || hist.length === 0) {
    ctx.fillStyle = '#6b7280';
    ctx.font = '12px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Accumulating samples for this device…', w / 2, h / 2);
    return;
  }

  let plotHist = hist;
  if (hist.length === 1) {
    const s = hist[0];
    plotHist = [{ ...s, ts: s.ts - 300 }, s];
  }

  const xs = (idx) => padL + (plotW * idx) / Math.max(1, plotHist.length - 1);

  // Check if this device has power measurement
  const maxRecordedW = Math.max(...plotHist.map(r => r.power_w || 0), 0);
  const hasPowerMeter = maxRecordedW > 0;

  if (hasPowerMeter) {
    // Continuous power curve
    const powers = plotHist.map(p => Math.max(0, p.power_w || 0));
    const maxW = Math.max(25, Math.ceil((Math.max(...powers) * 1.15) / 10) * 10);
    const yVal = (wVal) => baseY - (plotH * Math.max(0, Math.min(maxW, wVal))) / maxW;

    // Gridlines & labels
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 3; i++) {
      const y = padT + (plotH * i) / 3;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(w - padR, y);
      ctx.stroke();

      const labelVal = maxW * (3 - i) / 3;
      ctx.fillStyle = '#6b7280';
      ctx.font = '10px Inter, sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText(`${Math.round(labelVal)}W`, padL - 5, y + 3);
    }

    drawAreaFill(ctx, powers, xs, yVal, baseY, '#10b981', 0.18);
    drawSmoothLine(ctx, powers, xs, yVal, '#10b981', 2.0);
  } else {
    // Stepped ON / OFF status
    const yVal = (st) => baseY - (plotH * (st ? 0.85 : 0.05));

    // Gridlines: ON / OFF
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
    ctx.lineWidth = 1;
    [0.85, 0.05].forEach((pct, idx) => {
      const y = baseY - (plotH * pct);
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(w - padR, y);
      ctx.stroke();

      ctx.fillStyle = idx === 0 ? '#10b981' : '#6b7280';
      ctx.font = '10px Inter, sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText(idx === 0 ? 'ON' : 'OFF', padL - 5, y + 3);
    });

    // Draw stepped status line
    ctx.strokeStyle = '#10b981';
    ctx.lineWidth = 2;

    ctx.beginPath();
    for (let i = 0; i < plotHist.length; i++) {
      const x = xs(i);
      const isStOn = (plotHist[i].equipment_status || 0) === 1;
      const y = yVal(isStOn);
      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        const prevSt = (plotHist[i - 1].equipment_status || 0) === 1;
        ctx.lineTo(x, yVal(prevSt));
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();
  }

  // Time X-axis labels
  if (plotHist.length >= 2) {
    const first = plotHist[0].ts || 0, last = plotHist[plotHist.length - 1].ts || 0;
    const spanH = (last - first) / 3600;
    ctx.fillStyle = '#6b7280';
    ctx.font = '10px Inter, sans-serif';
    ctx.textAlign = 'center';
    const ticks = Math.min(4, plotHist.length - 1);
    for (let i = 0; i <= ticks; i++) {
      const idx = Math.round((plotHist.length - 1) * (i / ticks));
      const ts = plotHist[idx].ts || (first + (last - first) * (i / ticks));
      const d = new Date(ts * 1000);
      const str = (spanH > 24)
        ? (d.toLocaleDateString([], { month: 'numeric', day: 'numeric' }) + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))
        : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      ctx.fillText(str, xs(idx), h - 7);
    }
  }

  canvas._redraw = () => drawKasaDeviceChart(sn, host, hist, hours);

  _attachChartHover(canvas, plotHist, (idx) => {
    const p = plotHist[idx];
    if (!p) return '';
    const d = new Date(p.ts * 1000);
    const tsStr = d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }) + ' ' +
                  d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const isStOn = (p.equipment_status || 0) === 1;
    const stLabel = isStOn ? '<span style="color:#10b981;font-weight:700">● ON</span>' : '<span style="color:#94a3b8">○ OFF</span>';
    const pwrStr = p.power_w != null && p.power_w > 0 ? `<br><b>Power:</b> ${p.power_w.toFixed(1)} W` : '';
    return `<b>${tsStr}</b><br><b>State:</b> ${stLabel}${pwrStr}`;
  });
}

async function toggleKasaDevice(host, targetOn, btnEl) {
  if (btnEl) {
    btnEl.disabled = true;
    btnEl.innerHTML = `<span class="spinner" aria-hidden="true" style="width:14px; height:14px; margin-right:6px;"></span> Switching…`;
  }
  try {
    const res = await fetch(`/api/kasa/device/${encodeURIComponent(host)}/toggle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ on: targetOn }),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.device) {
        const idx = lastKasaDevices.findIndex(d => d.host === host);
        if (idx !== -1) {
          lastKasaDevices[idx] = { ...lastKasaDevices[idx], ...data.device };
        }
      }
      renderKasaTab();
    } else {
      const err = await res.json().catch(() => ({}));
      alert(`Failed to toggle device: ${err.detail || 'Network error'}`);
      renderKasaTab();
    }
  } catch (e) {
    console.warn('Failed to toggle Kasa device:', e);
    alert(`Failed to toggle device: ${e.message || e}`);
    renderKasaTab();
  }
}


// ============================================================
// NOTIFICATIONS / EMAIL SETTINGS
// ============================================================
async function loadNotificationsSettings() {
  const statusEl = $('notif-status');
  try {
    const res = await fetch('/api/notifications/config');
    if (!res.ok) return;
    const cfg = await res.json();

    if ($('notif-enabled')) $('notif-enabled').checked = !!cfg.enabled;
    if ($('notif-username')) $('notif-username').value = cfg.username || '';
    if ($('notif-password')) $('notif-password').value = cfg.has_password ? '••••••••' : '';
    if ($('notif-recipient')) $('notif-recipient').value = cfg.recipient || '';
    if ($('notif-sender-name')) $('notif-sender-name').value = cfg.sender_name || 'Jackery Monitor';
    if ($('notif-cooldown')) $('notif-cooldown').value = cfg.cooldown_minutes || 60;
    if ($('notif-host')) $('notif-host').value = cfg.smtp_host || 'smtp.gmail.com';
    if ($('notif-port')) $('notif-port').value = cfg.smtp_port || 587;

    if ($('notif-trigger-battery')) $('notif-trigger-battery').checked = cfg.alert_on_low_battery !== false;
    if ($('notif-trigger-stall')) $('notif-trigger-stall').checked = cfg.alert_on_cloud_stall !== false;
    if ($('notif-trigger-leak')) $('notif-trigger-leak').checked = cfg.alert_on_water_leak !== false;
    if ($('notif-trigger-freeze')) $('notif-trigger-freeze').checked = cfg.alert_on_freeze !== false;
    if ($('notif-freeze-temp')) $('notif-freeze-temp').value = cfg.freeze_threshold_c != null ? cfg.freeze_threshold_c : 5.0;

    if (statusEl) {
      if (cfg.enabled && cfg.is_configured) {
        statusEl.textContent = 'Active (Enabled)';
        statusEl.style.color = 'var(--accent, #10b981)';
      } else if (cfg.is_configured) {
        statusEl.textContent = 'Configured (Disabled)';
        statusEl.style.color = 'var(--text-dim, #94a3b8)';
      } else {
        statusEl.textContent = 'Not configured';
        statusEl.style.color = 'var(--text-dim, #94a3b8)';
      }
    }
  } catch (err) {
    if (statusEl) statusEl.textContent = 'Error loading settings';
  }
}

function initNotificationsSettings() {
  loadNotificationsSettings();

  const form = $('notif-form');
  const msg = $('notif-msg');
  const saveBtn = $('notif-save-btn');
  const testBtn = $('notif-test-btn');
  const clearBtn = $('notif-clear-btn');

  function showMsg(text, isError = false, timeout = 5000) {
    if (!msg) return;
    msg.hidden = false;
    msg.textContent = text;
    msg.style.color = isError ? 'var(--red, #ef4444)' : 'var(--accent, #10b981)';
    if (timeout > 0) {
      setTimeout(() => { msg.hidden = true; }, timeout);
    }
  }

  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }

    const payload = {
      enabled: $('notif-enabled')?.checked || false,
      username: ($('notif-username')?.value || '').trim(),
      password: $('notif-password')?.value || '',
      recipient: ($('notif-recipient')?.value || '').trim(),
      sender_name: ($('notif-sender-name')?.value || '').trim(),
      cooldown_minutes: parseInt($('notif-cooldown')?.value || '60', 10),
      smtp_host: ($('notif-host')?.value || 'smtp.gmail.com').trim(),
      smtp_port: parseInt($('notif-port')?.value || '587', 10),
      alert_on_low_battery: $('notif-trigger-battery')?.checked || false,
      alert_on_cloud_stall: $('notif-trigger-stall')?.checked || false,
      alert_on_water_leak: $('notif-trigger-leak')?.checked || false,
      alert_on_freeze: $('notif-trigger-freeze')?.checked || false,
      freeze_threshold_c: parseFloat($('notif-freeze-temp')?.value || '5.0'),
    };

    try {
      const res = await fetch('/api/notifications/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        showMsg('✓ Notification settings saved successfully!');
        loadNotificationsSettings();
      } else {
        showMsg(`Error: ${data.detail || 'Failed to save settings'}`, true, 8000);
      }
    } catch (err) {
      showMsg(`Network error: ${err.message}`, true, 8000);
    } finally {
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save settings'; }
    }
  });

  testBtn?.addEventListener('click', async () => {
    if (testBtn) { testBtn.disabled = true; testBtn.textContent = 'Sending test email…'; }
    showMsg('Attempting to connect to SMTP server and send test email…', false, 0);

    const payload = {
      username: ($('notif-username')?.value || '').trim(),
      password: $('notif-password')?.value || '',
      recipient: ($('notif-recipient')?.value || '').trim(),
      sender_name: ($('notif-sender-name')?.value || '').trim(),
      smtp_host: ($('notif-host')?.value || 'smtp.gmail.com').trim(),
      smtp_port: parseInt($('notif-port')?.value || '587', 10),
    };

    try {
      const res = await fetch('/api/notifications/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        showMsg(`✓ ${data.message || 'Test email delivered successfully!'}`, false, 8000);
      } else {
        showMsg(`❌ ${data.detail || data.message || 'Test email failed'}`, true, 10000);
      }
    } catch (err) {
      showMsg(`Network error: ${err.message}`, true, 10000);
    } finally {
      if (testBtn) { testBtn.disabled = false; testBtn.textContent = 'Send test email'; }
    }
  });

  clearBtn?.addEventListener('click', async () => {
    if (!confirm('Clear all saved email notification settings?')) return;
    try {
      await fetch('/api/notifications/config', { method: 'DELETE' });
      showMsg('Notification settings cleared.');
      loadNotificationsSettings();
    } catch (err) {
      showMsg(`Error: ${err.message}`, true);
    }
  });
}


// ============================================================
// RECONNECT
// ============================================================
$('logout')?.addEventListener('click', async () => {
  if (!confirm('Sign out of the Jackery Monitor?')) return;
  try { await fetch('/api/auth/logout', { method: 'POST' }); }
  catch (_e) {}
  window.location.replace('/login');
});

$('reconnect')?.addEventListener('click', async () => {
  $('reconnect').disabled = true;
  try { await fetch('/api/reconnect', { method: 'POST' }); }
  finally { setTimeout(() => $('reconnect').disabled = false, 800); }
});

// Brand-as-home: clicking "Jackery Monitor" reloads to / (which lands
// on the Live tab — that's the default activeTab on boot). Treats it
// as the "fix it" button: same gesture as cmd+R but always lands on
// Live regardless of which tab the user was on. Modifier/middle-clicks
// fall through to the <a href="/"> default so users can open Live in
// a new tab.
$('brand-home')?.addEventListener('click', (e) => {
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
  e.preventDefault();
  // Clear hash + query first, then reload. location.assign('/') from
  // /#forecast just triggers a hashchange (no reload) because it's
  // same-origin same-path different-hash — so we replaceState to
  // strip the hash, then reload to actually refresh the page.
  if (location.hash || location.search) {
    history.replaceState(null, '', location.pathname);
  }
  location.reload();
});

// Output toggles are not supported in cloud-only mode (Jackery cloud API
// is read-only). The .switch tiles are now plain status indicators.

// ============================================================
// WEBSOCKET
// ============================================================
function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/ws`);
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'snapshot' || msg.type === 'telemetry' || msg.type === 'status') {
      applyStatus(msg.data);
    } else if (msg.type === 'alert') {
      const b = $('alert-banner');
      b.textContent = msg.data?.message || 'Alert';
      show(b, true);
      setTimeout(() => show(b, false), 8000);
    } else if (msg.type === 'kasa_updated') {
      // Server-side reconciler / probe just changed a Kasa device's
      // user-visible state (online/is_on/error). Re-fetch the cached
      // list so the row flips immediately, no waiting for the 60s poll.
      _onKasaUpdatedPush();
      // Also refresh the Automation tab dot — its only other refresh
      // is a 3-min poll, so a Kasa device coming back online (or going
      // offline) used to leave the dot stale until the next tick. That
      // produced "lit dot, nothing to act on" when the user clicked in.
      refreshAutomationDot();
    } else if (msg.type === 'automation_fired') {
      // A rule just edge-triggered. Patch our local cache so last_fired
      // updates without re-fetching, and re-render if the user is on
      // the Automation tab.
      _onAutomationFiredPush(msg.data);
    }
  };
  ws.onclose = () => setTimeout(connectWs, 2000);
  ws.onerror = () => { try { ws.close(); } catch {} };
}

// Push handlers — keep the polling fallbacks in place but free-ride
// on WS broadcasts when they arrive so the common case is real-time.
async function _onKasaUpdatedPush() {
  // Only pay the network cost when the user is actually looking. The
  // 60s background poll picks up changes whenever they navigate back.
  if (activeTab !== 'automation') return;
  try {
    const r = await fetch('/api/kasa/saved');
    if (!r.ok) return;
    const j = await r.json();
    const next = j.devices || [];
    if (typeof _kasaListChanged === 'function'
        && _kasaListChanged(_savedKasaDevices, next)) {
      _savedKasaDevices = next;
      renderSavedKasa(_savedKasaDevices);
    }
  } catch { /* WS push lost — next poll tick will catch up */ }
}

function _onAutomationFiredPush(data) {
  if (!data || !data.id) return;
  // Patch the in-memory rule cache so last_fired surfaces immediately
  // even on the dot-tab without re-fetching.
  if (Array.isArray(_allRules)) {
    const rule = _allRules.find((r) => r.id === data.id);
    if (rule) {
      rule.last_fired = data.last_fired || (Date.now() / 1000);
      rule.last_error = null;  // a fire that broadcast = a fire that succeeded
    }
  }
  // Re-render the rules list if the user is looking at it.
  if (activeTab === 'automation' && typeof renderRulesWithFilter === 'function') {
    renderRulesWithFilter();
  }
  // If the History panel is open for this rule, refresh it too.
  if (typeof _autoHistoryRule !== 'undefined' && _autoHistoryRule
      && _autoHistoryRule.id === data.id
      && typeof _refreshAutoHistory === 'function') {
    _refreshAutoHistory();
  }
  // Show a transient toast so even off-tab users see the firing.
  const b = $('alert-banner');
  if (b) {
    let actionDesc = '';
    if (data.action_type === 'jackery_setting' || data.setting) {
      const isEnable = data.action === 'on' || data.action === 'enable' || data.action === 'true';
      const targetDev = data.jackery_device_name || data.jackery_device_sn || 'Jackery';
      actionDesc = `set ${data.setting || 'battery_saving'} to ${isEnable ? 'ENABLE (85%)' : 'DISABLE (100%)'} on ${targetDev}`;
    } else {
      actionDesc = `${(data.action || '').toUpperCase()} ${data.kasa_alias || ''}`;
    }
    b.textContent = `Rule fired: ${data.name} → ${actionDesc}`;
    show(b, true);
    setTimeout(() => show(b, false), 5000);
  }
}

// ============================================================
// APPLY STATUS
// ============================================================
function applyStatus(s) {
  if (!s) return;
  // During a user-initiated device switch, ignore frames that were
  // rendered for a different device (stale in-flight REST polls, WS
  // frames from before the server-side view bump). The latch holds for
  // the WHOLE window — clearing it on the first matching frame left a
  // hole where a still-in-flight old-cookie /api/status response landed
  // right after and repainted the previous device, re-triggering the
  // device-change refetch storm (the "jumps between units for a few
  // seconds" bug, round 2). Fail-open after the window so a lost frame
  // can never wedge the UI.
  if (_pendingViewSwitch) {
    if (Date.now() > _pendingViewSwitch.until) {
      _pendingViewSwitch = null;
      setDeviceSwitching(false);       // fail-open: never wedge the dim
    } else {
      const frameId = s.cloud?.selected_device_id != null
        ? String(s.cloud.selected_device_id) : null;
      if (frameId && frameId !== String(_pendingViewSwitch.id)) {
        return;                        // stale frame from the previous view
      }
      if (frameId === String(_pendingViewSwitch.id)) {
        // First frame of the NEW device is about to render — loading done.
        setDeviceSwitching(false);
      }
      // Matching (or device-less) frame: render it, but KEEP the latch
      // until the window expires so late stragglers stay blocked.
    }
  }
  const prevDeviceSn = activeJackeryDevice()?.device_sn;
  lastStatus = s;
  // Stash for fetchBatteryPacks() — it derives the main unit's standalone
  // SOC from the combined SOC the dashboard is showing.
  window._lastStatus = s.telemetry || null;
  // If the active Jackery device changed and we're on the Automation tab,
  // re-render the rules list so the "Showing rules for: X" filter follows.
  const newDeviceSn = activeJackeryDevice()?.device_sn;
  if (activeTab === 'device' && prevDeviceSn !== newDeviceSn) {
    loadInverterWatchdogConfig();
    loadHardwareSettings();
  }
  if (activeTab === 'automation' && prevDeviceSn !== newDeviceSn) {
    if (_allRules.length) renderRulesWithFilter();
    // Smart-charge config + AI insights are per-device — reload both.
    loadSmartCharge();
    loadSolarCharge();
    loadAlgorithmAdvisor();
  }
  // Same idea for the Forecast tab: forecast is per-device (battery
  // capacity, solar regression, load profile all differ), so re-fetch on
  // device switch. The EOD badge on the battery card is also per-device.
  if (prevDeviceSn !== newDeviceSn && newDeviceSn) {
    if (activeTab === 'forecast') {
      forecastCache = null;
      fetchForecast();
    }
    if (activeTab === 'cost') {
      costSummaryCache = null;
      costDistCache = null;
      costHistoryCache = null;
      costBreakdownCache = null;
      loadCostTab();
    }
    // Daily table/records are per-device — drop the old cache so a CSV
    // export can't carry the previous device's data, and refresh in
    // place if the Energy tab is what the user is looking at.
    energyDailyCache = null;
    if (activeTab === 'energy') fetchEnergyDaily();
    fetchEodForecast();
    // Pack list is per-device — drop the previous device's cache so we
    // don't briefly show the old packs while the new fetch is in flight.
    // The next WS tick will populate cachedPacks from s.battery_packs.
    window._cachedPacks = [];
    window._cachedPackDeviceSn = null;
    window._cachedPacksMainSoc = null;
    window._cachedPacksError = null;
    window._cachedNoPacks = false;
    window._systemSoc = null;
    window._mainSoc = null;
    renderBatteryPacks();
    // AC-charge button is per-device too — hide it eagerly so the
    // user doesn't see the old device's plug state for up to 30s
    // until the next periodic refresh fires. refreshAcChargeButton()
    // re-shows it with the correct state if the new device has a
    // plug configured.
    const acBtn = $('ac-charge-toggle');
    if (acBtn) acBtn.hidden = true;
    refreshAcChargeButton().catch(() => {});
    const solBtn = $('solar-charge-toggle');
    if (solBtn) solBtn.hidden = true;
    refreshSolarChargeButton().catch(() => {});
  }

  // Pack data piggy-backs on the WS payload — the bridge has it pushed
  // from MQTT in real time, so this updates per-pack rows at the same
  // cadence as the SOC card (no separate HTTP polling needed).
  if (Array.isArray(s.battery_packs)) {
    window._cachedPacks = s.battery_packs;
    window._cachedPacksMainSoc = s.telemetry?.main_soc_pct ?? null;
    window._cachedPacksError = null;
    window._cachedNoPacks = s.battery_packs.length === 0;
  }

  // Connection pill & offline detection
  const pill = $('conn-pill');
  const txt = $('conn-text');
  pill.classList.remove('is-connected', 'is-connecting', 'is-offline', 'is-error');
  pill.removeAttribute('title');

  const isDeviceOffline = (s.device_online === false)
    || (s.telemetry?.device_online === false)
    || (s.device?.online === false);
  const offTs = s.telemetry?.device_offline_ts
    || s.telemetry?.device_last_update_ts
    || s.device?.offline_ts
    || s.device?.last_update_ts;
  const offAgo = offTs ? fmtDurationAgo(Math.max(0, Date.now() / 1000 - offTs)) : '';

  let label = s.connection_status || 'unknown';
  if (s.connection_status === 'connected') {
    if (isDeviceOffline) {
      pill.classList.add('is-offline');
      label = offAgo ? `device offline (${offAgo})` : 'device offline';
      pill.title = offTs ? `Device disconnected from Wi-Fi at ${new Date(offTs * 1000).toLocaleTimeString()} (${offAgo})` : 'Device is offline (Wi-Fi disconnected)';
    } else {
      pill.classList.add('is-connected');
      label = 'connected';
    }
  }
  else if (['scanning', 'connecting'].includes(s.connection_status)) { pill.classList.add('is-connecting'); }
  else if (s.connection_status === 'error') { pill.classList.add('is-error'); label = s.connection_error || 'error'; }
  txt.textContent = label;

  // Offline banner on Live tab
  const offlineBanner = $('device-offline-banner');
  if (offlineBanner) {
    if (isDeviceOffline && s.connection_status === 'connected') {
      show(offlineBanner, true);
      const titleEl = $('device-offline-title');
      const detailEl = $('device-offline-detail');
      const devName = s.device?.name || 'Battery';
      if (titleEl) titleEl.textContent = `${devName} Disconnected from Wi-Fi`;
      if (detailEl) {
        detailEl.textContent = offTs
          ? `Last reported fresh telemetry at ${new Date(offTs * 1000).toLocaleTimeString()} (${offAgo}). Values shown below reflect the last known snapshot.`
          : 'This device is currently offline and not pushing updates. Values shown below reflect the last known snapshot.';
      }
    } else {
      show(offlineBanner, false);
    }
  }

  // Devices dropdown (cloud meta)
  const devices = s.cloud?.devices || [];
  const selectedId = s.cloud?.selected_device_id;
  lastDevices = devices;
  renderDevicePicker(devices, selectedId);

  // Source badges
  let srcLabel = s.source ? s.source.toUpperCase() : '—';
  if (isDeviceOffline) {
    srcLabel = `${srcLabel} · OFFLINE`;
  }
  if ($('source-badge'))   $('source-badge').textContent = srcLabel;
  if ($('source-badge-2')) $('source-badge-2').textContent = srcLabel;


  // Telemetry
  const t = s.telemetry || {};
  if (t.battery_percent != null) {
    // Prefer the server-computed system SOC when packs are attached,
    // so the SOC card lands on the right number on the very first
    // paint (no main → system flash). Falls back to the raw main %
    // for single-unit devices where system_soc_pct is absent.
    const headlineSoc = t.system_soc_pct != null
      ? t.system_soc_pct
      : t.battery_percent;
    animateNumber($('battery-pct'), headlineSoc);
    $('battery-bar-fill').style.width = `${Math.max(0, Math.min(100, headlineSoc))}%`;
    // Single source of truth for the temp segment in the SOC card meta:
    // hide it whenever the telemetry tells us packs are present (the
    // host unit's temp moves to the Main row in the pack card). Show
    // it on single-unit devices where system_soc_pct is absent.
    const tempGroup = $('battery-temp-group');
    if (tempGroup) tempGroup.hidden = t.system_soc_pct != null;
    // EOD pill follows live SOC drift so it doesn't go stale between refreshes.
    maybeRefitEodOnDrift(t.battery_percent);
    // Re-render the pack card with the live main % — pack values lag
    // (server polls every 5 min) but the main % updates every tick, so
    // this keeps the Main row + system SOC overlay in sync without
    // waiting for the next pack fetch.
    renderBatteryPacks();
  }
  // Battery time label. The Jackery cloud sends two fields:
  //   time_to_full_h     -> ETA to 100% when the unit is charging
  //   time_remaining_h   -> ETA to empty when the unit is discharging
  // It populates only the relevant one; the other is 0 or stale. We pick the
  // right one based on net power flow. If neither is meaningful and the unit
  // is barely doing anything, show "Idle". As a last resort, synthesise an
  // ETA from SOC and net W.
  const inW   = Number(t.input_power_w  ?? 0);
  const outW  = Number(t.output_power_w ?? 0);
  const netW  = inW - outW;                      // + charging, - discharging
  // Use system SOC (capacity-weighted across main + packs) when present —
  // matches what the user sees on the SOC card. Fall back to main pack
  // for legacy / single-unit devices.
  const soc   = Number(t.system_soc_pct ?? t.battery_percent ?? 0);
  // System capacity from the server's _total_capacity_wh (main + every
  // expansion pack). Falls back to a single-pack default when the server
  // doesn't enrich telemetry (mock backend, very old responses).
  const capacityWh = Number(t.capacity_wh ?? 5040);
  const IDLE_W   = 25;                           // below this we call it idle
  const ttFull  = Number(t.time_to_full_h    ?? 0);
  const ttEmpty = Number(t.time_remaining_h  ?? 0);
  let timeLabel;
  if (Math.abs(netW) < IDLE_W) {
    timeLabel = 'Idle';
  } else if (netW > 0) {
    // Charging — show ETA to full so the label is never ambiguous
    if (ttFull > 0) {
      timeLabel = `${fmt(ttFull, 1)} h until full`;
    } else {
      const wh = ((100 - soc) / 100) * capacityWh;
      const eta = wh / netW;
      timeLabel = eta > 0 && isFinite(eta) ? `${fmt(eta, 1)} h until full` : 'Charging…';
    }
  } else {
    // Discharging — show ETA to empty
    if (ttEmpty > 0) {
      timeLabel = `${fmt(ttEmpty, 1)} h until empty`;
    } else {
      const wh = (soc / 100) * capacityWh;
      const eta = wh / Math.abs(netW);
      timeLabel = eta > 0 && isFinite(eta) ? `${fmt(eta, 1)} h until empty` : 'Discharging…';
    }
  }
  $('battery-time').textContent = timeLabel;
  if (t.battery_temp_c != null) $('battery-temp').textContent = formatTemp(t.battery_temp_c);

  // Animated power flow diagram (replaces the old two-column W readout).
  renderPowerFlow(t);

  // Battery card mood: charging / discharging / low / idle. Drives the soft
  // glow + bar color via CSS classes.
  const batCard = $('battery-card');
  if (batCard) {
    const inW = Number(t.input_power_w ?? 0);
    const outW = Number(t.output_power_w ?? 0);
    const net = inW - outW;
    batCard.classList.toggle('charging',    net >  25);
    batCard.classList.toggle('discharging', net < -25);
    batCard.classList.toggle('low',         (t.battery_percent ?? 100) <= 20);
  }

  // Today KPIs from energy aggregator
  if (s.energy?.today) {
    $('today-out-kwh').textContent = fmtKwh(s.energy.today.output_wh);
    $('today-in-kwh').textContent  = fmtKwh(s.energy.today.input_wh);
    renderChargedSplit('today-charged-split', s.energy.today);
    // Excess-diversion line: show only when there's something to show.
    // Threshold at 50Wh so a brief sensor blip doesn't surface the row;
    // a real diversion session is kWh-scale.
    const divWh = s.energy.today.solar_charge_diverted_wh || 0;
    const divRow = $('today-diverted-row');
    const divEl = $('today-diverted-kwh');
    if (divRow && divEl) {
      if (divWh >= 50) {
        divRow.hidden = false;
        divEl.textContent = fmtKwh(divWh);
      } else {
        divRow.hidden = true;
      }
    }
  }
  // Cost savings row in the TODAY card. Server only populates this when
  // the cost plan loads cleanly; keep the row hidden otherwise.
  if (s.energy) {
    renderSavingsRow('today',
      s.energy.today_savings,
      s.energy.cost_plan?.currency || 'USD');
  }

  // Output state. If a toggle is pending and the device hasn't propagated
  // yet, hold the expected value and keep the .pending tag so the user
  // sees the change "stick" instead of flapping back to the old state.
  const now = Date.now();
  for (const port of ['ac', 'dc', 'usb', 'car']) {
    const v = t[`${port}_on`];
    const sw = document.querySelector(`.switch[data-port="${port}"]`);
    const lbl = $(`sw-${port}`);
    if (!sw || !lbl) continue;
    const pending = _pendingToggle[port];
    if (pending && pending.until > now) {
      if (v === pending.expected) {
        // Telemetry has caught up — apply normally and clear pending.
        delete _pendingToggle[port];
        sw.classList.remove('pending');
        sw.classList.toggle('on', v);
        lbl.textContent = v ? 'ON' : 'OFF';
      } else {
        // Still propagating — hold the optimistic value, mark as pending.
        sw.classList.add('pending');
        sw.classList.toggle('on', pending.expected);
        lbl.textContent = pending.expected ? 'ON' : 'OFF';
      }
      continue;
    }
    // No (or expired) pending toggle — render the actual telemetry.
    if (pending) { delete _pendingToggle[port]; sw.classList.remove('pending'); }
    if (v === true)       { sw.classList.add('on');  lbl.textContent = 'ON';  }
    else if (v === false) { sw.classList.remove('on'); lbl.textContent = 'OFF'; }
    else                  { sw.classList.remove('on'); lbl.textContent = '—'; }
  }

  // Inverter recovery watchdog decoration on the AC button.
  // (Pure decoration — the server is doing the actual retry MQTT
  // commands; this just communicates the state visually.)
  //   - consecutive_attempts > 0, no error  → yellow wd-warn + tooltip
  //   - error_message latched               → red wd-err + tooltip; click
  //                                            dismisses the error
  //   - idle                                → clear both
  // Namespaced .wd-* so they don't collide with .switch.warn (smart-
  // charge active-mode indicator on other buttons).
  const acSw = document.querySelector('.switch[data-port="ac"]');
  const wd = s.inverter_watchdog;
  if (acSw) {
    if (wd && wd.error_message) {
      acSw.classList.remove('wd-warn');
      acSw.classList.add('wd-err');
      acSw.title = `${wd.error_message}\n\nClick AC to dismiss this error.`;
    } else if (wd && wd.consecutive_attempts > 0) {
      acSw.classList.remove('wd-err');
      acSw.classList.add('wd-warn');
      acSw.title = (
        `Inverter recovery in progress: retry ${wd.consecutive_attempts}/5. ` +
        `Sending AC-on every 10s; will surface an error after 5 attempts.`);
    } else {
      acSw.classList.remove('wd-err', 'wd-warn');
      acSw.title = '';
    }
  }

  // Device tab
  const dev = s.device || {};
  $('dev-name').textContent  = dev.name  || '—';
  $('dev-model').textContent = dev.model_code != null ? `model ${dev.model_code}` : '—';
  $('dev-sn').textContent    = dev.device_sn || '—';
  if ($('dev-wifi-status')) {
    if (isDeviceOffline) {
      const offDetail = offTs ? `since ${new Date(offTs * 1000).toLocaleTimeString()} (${offAgo})` : '';
      $('dev-wifi-status').innerHTML = `<span style="color:#fbbf24">● Disconnected / Offline ${offDetail}</span>`;
    } else {
      $('dev-wifi-status').innerHTML = '<span style="color:var(--accent)">● Connected (Online)</span>';
    }
  }
  $('src-cloud').textContent = describeSrc(s.cloud);
  _lastCloudMeta = s.cloud || null;
  renderPausePill();
  const trueUpdateTs = s.telemetry?.device_last_update_ts || s.last_update_ts;
  if (trueUpdateTs) {
    const updAgo = fmtDurationAgo(Math.max(0, Date.now() / 1000 - trueUpdateTs));
    $('dev-updated').textContent = `${new Date(trueUpdateTs * 1000).toLocaleString()}${updAgo ? ` (${updAgo})` : ''}`;
  } else {
    $('dev-updated').textContent = '—';
  }

  const devModelCode = dev.model_code;
  const devOverrides = devModelCode != null ? MODEL_FEATURE_OVERRIDES[devModelCode] : null;
  const upsSupported = !devOverrides || devOverrides.ups_mode !== false;
  const sfcSupported = !devOverrides || devOverrides.super_charge !== false;
  const upsParts = [
    (upsSupported && t.ups_on) && 'UPS',
    (sfcSupported && t.super_charge_on) && 'Super charge',
  ].filter(Boolean);
  $('dev-ups').textContent = upsParts.length ? upsParts.join(' + ')
    : ((upsSupported && t.ups_on === false) || (sfcSupported && t.super_charge_on === false)) ? 'Off' : '—';
  $('dev-err').textContent     = t.error_code != null ? String(t.error_code) : '—';

  // Hardware settings on Device tab
  if (t) {
    const sets = t.settings || {
      battery_saving: t.battery_saving,
      charge_speed: t.charge_speed,
      super_charge: t.super_charge,
      energy_saving: t.energy_saving,
      screen_timeout: t.screen_timeout,
      auto_shutdown: t.auto_shutdown,
      light_mode: t.light_mode,
      ups_mode: t.ups_on,
    };
    renderHardwareSettings(sets, dev.device_sn);
  }

  // Energy KPIs (cards on Energy tab)
  if (s.energy) renderEnergyKpis(s.energy);

  // Sinopé connected devices
  if (s.sinope_devices) {
    lastSinopeDevices = s.sinope_devices;
    if (activeTab === 'sinope') renderSinopeTab();
  }

  // Daikin connected devices
  if (s.daikin_devices) {
    lastDaikinDevices = s.daikin_devices;
    if (activeTab === 'daikin') renderDaikinTab();
  }

  // Hilo smart meter, devices & challenges
  if (s.hilo_meters || s.hilo_devices || s.hilo_challenges) {
    if (s.hilo_meters) lastHiloMeters = s.hilo_meters;
    if (s.hilo_devices) lastHiloDevices = s.hilo_devices;
    if (s.hilo_challenges) lastHiloChallenges = s.hilo_challenges;
    if (activeTab === 'hilo') renderHiloTab();
  }

  // LG ThinQ smart appliances
  if (s.thinq_devices) {
    lastThinqDevices = s.thinq_devices;
    if (activeTab === 'thinq') renderThinqTab();
  }

  // Danby / Midea smart dehumidifiers
  if (s.midea_devices) {
    lastMideaDevices = s.midea_devices;
    if (activeTab === 'midea') renderMideaTab();
  }

  // Tesla EV & Wall Connectors
  if (s.tesla_devices) {
    lastTeslaDevices = s.tesla_devices;
    if (activeTab === 'tesla') renderTeslaTab();
  }

  // Kasa smart devices (plugs & wall switches)
  if (s.kasa_devices) {
    lastKasaDevices = s.kasa_devices;
    if (activeTab === 'kasa') renderKasaTab();
  }

  // Live chart
  if (activeTab === 'live') {
    drawLiveChart(s);
    drawLiveTempChart(s);
  }
}


// parseInt that treats 0 as a real value (|| would swallow it) and falls
// back only when the field is missing or unparseable.
function _intOr(id, dflt) {
  const el = document.getElementById(id);
  if (!el) return dflt;
  const v = parseInt(el.value, 10);
  return Number.isFinite(v) ? v : dflt;
}

// ============================================================
// KASA PLUG TOGGLE (factory) — backs both the AC-charge and the
// Excess-diversion (solar_charge) buttons in the Power panel.
//
// Each button is bound to one controller's per-device config
// endpoint (smart_charge or solar_charge) and renders only when
// the user has assigned a Kasa plug to that controller. Inlined
// as the 5th/6th button in the Power row; auto-hides when no
// plug is configured.
//
// When the controller's mode is 'active' the button gets a
// yellow border + tooltip explaining the loop will re-decide on
// the next tick (Q4-A: warn but don't block). For smart_charge
// the loop is 5 min; for solar_charge it's 30s.
//
// Error path: the kasa backend already retries 3x
// (kasa_client._with_retry), so when a click bubbles back here
// the plug is genuinely unreachable. We:
//   1. Re-sync to actual plug state so the button reflects truth
//      (may have succeeded server-side even if the response was
//      lost) — user can immediately click again to retry.
//   2. Surface the error as a tooltip + yellow border, NOT as a
//      replacement button label. State stays readable.
// ============================================================
function makeKasaPlugToggle({ buttonId, stateId, controllerName,
                             configPath, revertWindow }) {
  let busy = false;
  const btn = document.getElementById(buttonId);

  async function readHost() {
    const deviceSn = activeJackeryDevice()?.device_sn;
    if (!deviceSn) return { deviceSn: null, cfg: null };
    try {
      const r = await fetch(`${configPath}?device_sn=${encodeURIComponent(deviceSn)}`);
      if (r.ok) return { deviceSn, cfg: (await r.json()).config };
    } catch (e) { /* ignore */ }
    return { deviceSn, cfg: null };
  }

  async function refresh() {
    if (!btn) return;
    const { deviceSn, cfg } = await readHost();
    if (!deviceSn) { btn.hidden = true; return; }
    const host = cfg?.kasa_device_host;
    if (!host) { btn.hidden = true; return; }
    btn.hidden = false;
    const mode = cfg.mode || 'off';
    if (mode === 'active') {
      btn.classList.add('warn');
      btn.title = `Plug ${host} · ${controllerName} ${mode}\nWarning: your manual toggle may be reverted within ${revertWindow}.`;
    } else {
      btn.classList.remove('warn');
      btn.title = `Plug ${host} · ${controllerName} ${mode}`;
    }
    // Read plug state. Failures = unknown (—). Skip while the
    // user's mid-click so optimistic state isn't clobbered.
    const stateEl = document.getElementById(stateId);
    if (!busy) {
      try {
        const r = await fetch(`/api/kasa/status?host=${encodeURIComponent(host)}`);
        if (r.ok) {
          const isOn = !!(await r.json()).is_on;
          btn.classList.toggle('on', isOn);
          if (stateEl) stateEl.textContent = isOn ? 'ON' : 'OFF';
        } else {
          btn.classList.remove('on');
          if (stateEl) stateEl.textContent = '—';
        }
      } catch (e) {
        btn.classList.remove('on');
        if (stateEl) stateEl.textContent = '—';
      }
    }
  }

  btn?.addEventListener('click', async () => {
    if (busy) return;
    const { cfg } = await readHost();
    const host = cfg?.kasa_device_host;
    if (!host) return;
    const stateEl = document.getElementById(stateId);
    const wantOn = !btn.classList.contains('on');
    busy = true;
    btn.classList.add('pending');
    if (stateEl) stateEl.textContent = wantOn ? 'ON…' : 'OFF…';
    try {
      const r = await fetch('/api/kasa/test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ host, on: wantOn }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.detail || `HTTP ${r.status}`);
      }
      // Optimistic update + clear stale error decoration. refresh()
      // fires on the next 30s tick to confirm the actual plug state.
      btn.classList.toggle('on', wantOn);
      btn.classList.remove('pending', 'warn');
      if (stateEl) stateEl.textContent = wantOn ? 'ON' : 'OFF';
      busy = false;
      refresh().catch(() => {});
    } catch (e) {
      busy = false;
      btn.classList.remove('pending');
      await refresh().catch(() => {});
      btn.classList.add('warn');
      btn.title = `Last toggle failed: ${e.message || e}\nClick to retry. Hover for details.`;
    }
  });

  // Periodic refresh — plug state changes infrequently so 30s is plenty.
  setInterval(refresh, 30_000);
  // Initial render — fire once at module load AND once when applyStatus
  // resolves an active device, so the button shows up without waiting 30s.
  refresh().catch(() => {});

  return { refresh };
}

const acChargeToggle = makeKasaPlugToggle({
  buttonId: 'ac-charge-toggle',
  stateId: 'ac-charge-state',
  controllerName: 'smart-charge',
  configPath: '/api/smart_charge/config',
  revertWindow: '5 min',
});
const solarChargeToggle = makeKasaPlugToggle({
  buttonId: 'solar-charge-toggle',
  stateId: 'solar-charge-state',
  controllerName: 'solar-charge',
  configPath: '/api/solar_charge/config',
  revertWindow: '30s',
});
const refreshAcChargeButton = acChargeToggle.refresh;
const refreshSolarChargeButton = solarChargeToggle.refresh;

// ============================================================
// POWER FLOW DIAGRAM (Tesla-app style)
// Each flow has three SVG pieces: a solid translucent CHANNEL,
// a hidden geometry PATH, and a DOT group with animateMotion that
// follows the path. When watts < 5: channel goes faint (idle), dot
// hidden. When watts ≥ 5: channel brightens, dot becomes visible
// and travels with dur set inversely to wattage. animateMotion's
// dur is updated via setAttribute on the inner <animateMotion>
// element — Chrome/Safari pick up the new duration without a
// restart hack.
// ============================================================

// Threshold — anything below ~5W is inverter rounding noise, not flow.
const FLOW_IDLE_W = 5;

function renderPowerFlow(t) {
  if (!t) return;
  const solarW = Math.max(0, Math.round(Number(t.solar_input_w ?? 0)));
  const gridW  = Math.max(0, Math.round(Number(t.ac_input_w    ?? 0)));
  const loadW  = Math.max(0, Math.round(Number(t.output_power_w ?? 0)));
  setFlow('solar', solarW);
  setFlow('grid',  gridW);
  setFlow('load',  loadW);

  // Battery node — color encodes direction. Net = sources - load.
  // Charging when sources outpace load, discharging the other way.
  const batteryNode = $('flow-node-battery');
  if (batteryNode) {
    const net = (solarW + gridW) - loadW;
    batteryNode.classList.toggle('charging',    net >  25);
    batteryNode.classList.toggle('discharging', net < -25);
  }

  // Battery SOC text. Use the same headline SOC as the main battery
  // card (system_soc_pct when available, else main %) so the two
  // numbers always agree.
  const headlineSoc = t.system_soc_pct != null
    ? t.system_soc_pct
    : t.battery_percent;
  const socEl = $('flow-soc-pct');
  if (socEl) {
    socEl.textContent = headlineSoc != null
      ? `${Math.round(headlineSoc)}%`
      : '—';
  }

  // AC voltage / Hz hint in the card eyebrow.
  const meta = $('flow-ac-meta');
  if (meta) {
    const parts = [];
    if (t.ac_output_v != null) parts.push(`${Math.round(t.ac_output_v)} V`);
    if (t.ac_output_v_l1 && t.ac_output_v_l1 > 0) {
      parts.push(`L1 ${Math.round(t.ac_output_v_l1)} V`);
    }
    if (t.ac_output_hz != null) parts.push(`${Math.round(t.ac_output_hz)} Hz`);
    meta.textContent = parts.join(' · ') || '—';
  }

  // Time-to-full (charging) / time-to-empty (discharging). Pulled
  // straight from device telemetry. Compact arrow-prefixed format
  // ("↑ 0.7h" / "↓ 9.2h") keeps the line inside the battery ring's
  // chord at this y-position even on mobile where the SVG fonts are
  // bumped up — the verbose "until full" / "remaining" text is too
  // wide there. Direction is also encoded by the green/amber color
  // matching the battery node ring, so the arrow is reinforcement
  // rather than the only signal.
  const timerEl = $('flow-timer');
  if (timerEl) {
    const ttFull  = Number(t.time_to_full_h    ?? 0);
    const ttEmpty = Number(t.time_remaining_h  ?? 0);
    // Same fallback as the hero-card "until full / until empty" label:
    // when the cloud doesn't fill ttFull/ttEmpty (common during mixed
    // solar+load operation, where net power is small or fluctuating),
    // synthesize from current SOC + net W + system capacity. Without
    // this the flow-timer permanently rendered "—" on rigs that
    // basically never trigger Jackery's own ETA computation.
    const inW = Number(t.input_power_w  ?? 0);
    const outW = Number(t.output_power_w ?? 0);
    const netW = inW - outW;
    const soc = Number(t.system_soc_pct ?? t.battery_percent ?? 0);
    const capacityWh = Number(t.capacity_wh ?? 5040);
    const synthFull  = netW >  25
      ? ((100 - soc) / 100 * capacityWh) / netW
      : 0;
    const synthEmpty = netW < -25
      ? (soc / 100 * capacityWh) / Math.abs(netW)
      : 0;
    let txt = '—';
    let cls = '';
    let title = '';
    if (ttFull > 0) {
      txt = `↑ ${ttFull.toFixed(1)}h`;
      cls = 'charging';
      title = `${ttFull.toFixed(1)} h until full`;
    } else if (ttEmpty > 0) {
      txt = `↓ ${ttEmpty.toFixed(1)}h`;
      cls = 'discharging';
      title = `${ttEmpty.toFixed(1)} h remaining`;
    } else if (synthFull > 0 && isFinite(synthFull)) {
      txt = `↑ ${synthFull.toFixed(1)}h`;
      cls = 'charging';
      title = `~${synthFull.toFixed(1)} h until full (synthesized — cloud didn't supply ETA)`;
    } else if (synthEmpty > 0 && isFinite(synthEmpty)) {
      txt = `↓ ${synthEmpty.toFixed(1)}h`;
      cls = 'discharging';
      title = `~${synthEmpty.toFixed(1)} h until empty (synthesized — cloud didn't supply ETA)`;
    }
    timerEl.textContent = txt;
    timerEl.classList.remove('charging', 'discharging');
    if (cls) timerEl.classList.add(cls);
    // SVG <title> child = native browser tooltip on hover; keeps the
    // verbose phrasing accessible without forcing it into the visible
    // glyph budget. Lazily create on first use; replace text after.
    let titleNode = timerEl.querySelector('title');
    if (title) {
      if (!titleNode) {
        titleNode = document.createElementNS(
          'http://www.w3.org/2000/svg', 'title');
        timerEl.appendChild(titleNode);
      }
      titleNode.textContent = title;
    } else if (titleNode) {
      titleNode.remove();
    }
  }
}

function setFlow(kind, watts) {
  const channel = document.getElementById(`flow-line-${kind}`);
  const node    = document.getElementById(`flow-node-${kind}`);
  const dotGrp  = document.getElementById(`flow-dot-${kind}`);
  const wEl     = document.getElementById(`flow-${kind}-w`);
  if (wEl) wEl.textContent = watts;

  const active = watts >= FLOW_IDLE_W;
  if (channel) channel.classList.toggle('active', active);
  if (node)    node.classList.toggle('active', active);
  if (dotGrp)  dotGrp.classList.toggle('active', active);

  if (dotGrp) {
    const am = dotGrp.querySelector('animateMotion');
    if (am) {
      if (active) {
        // Speed mapping: faster dot = more power, but capped so
        // 2 kW doesn't look frantic. 50 W → 4.5 s slow drift,
        // 500 W → 2.7 s, 2 kW+ → 1.2 s. Smooth log-ish curve.
        const dur = Math.max(1.2, Math.min(4.5, 4500 / Math.max(50, watts)));
        am.setAttribute('dur', `${dur.toFixed(2)}s`);
      } else {
        // Stop wasting cycles on a hidden dot.
        am.setAttribute('dur', '999s');
      }
    }
  }
}

function describeSrc(meta) {
  if (!meta) return '—';
  const parts = [];
  if (meta.state) parts.push(meta.state);
  if (meta.age_s != null) parts.push(`${meta.age_s}s ago`);
  if (meta.error) parts.push(`(${meta.error})`);
  return parts.join(' · ') || '—';
}

// ============================================================
// ENERGY KPIs
// ============================================================
function renderEnergyKpis(e) {
  const set = (id, wh) => { const el = $(id); if (el) el.textContent = fmtKwh(wh); };
  set('e-today-out', e.today?.output_wh);
  set('e-today-in',  e.today?.input_wh);
  renderChargedSplit('e-today-charged-split', e.today);
  set('e-7d-out',    e.last_7d?.output_wh);
  set('e-7d-in',     e.last_7d?.input_wh);
  set('e-30d-out',   e.last_30d?.output_wh);
  set('e-30d-in',    e.last_30d?.input_wh);
  set('e-life-out',  e.lifetime?.output_wh);
  set('e-life-in',   e.lifetime?.input_wh);

  // Cost / savings rows. Server returns today_savings + lifetime_savings
  // alongside the kWh totals when the cost plan loads cleanly. If either
  // is absent, hide the corresponding row.
  const currency = e.cost_plan?.currency || 'USD';
  renderSavingsRow('today',    e.today_savings,    currency);
  renderSavingsRow('lifetime', e.lifetime_savings, currency);
}

function fmtMoney(amount, currency = 'USD') {
  if (amount == null || Number.isNaN(amount)) return '—';
  try {
    return new Intl.NumberFormat(undefined,
      { style: 'currency', currency, maximumFractionDigits: 2 }).format(amount);
  } catch {
    return `$${Number(amount).toFixed(2)}`;
  }
}

function renderSavingsRow(prefix, savings, currency) {
  const row = $(`${prefix}-savings-row`);
  if (!row) return;
  if (!savings) { row.hidden = true; return; }
  const setText = (id, txt) => { const el = $(id); if (el) el.textContent = txt; };
  const idPrefix = prefix === 'today' ? 'today' : 'life';
  setText(`${idPrefix}-solar-savings`, `+${fmtMoney(savings.solar_savings, currency)} solar`);
  setText(`${idPrefix}-grid-cost`,     `−${fmtMoney(savings.grid_cost, currency)} grid`);
  const net = savings.net_savings ?? 0;
  setText(`${idPrefix}-net-savings`, `${net >= 0 ? '+' : ''}${fmtMoney(net, currency)} net`);
  row.hidden = false;
}

// ============================================================
// ENERGY HISTORY CHART + RANGE PICKER
// ============================================================
document.querySelectorAll('.range-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.range-btn').forEach(b => b.classList.remove('on'));
    btn.classList.add('on');
    energyRangeHours = parseInt(btn.dataset.hours, 10);
    fetchEnergyHistory();
  });
});

async function fetchEnergyHistory() {
  try {
    const histSn = activeJackeryDevice()?.device_sn;
    const r = await fetch(`/api/energy/history?hours=${energyRangeHours}`
      + (histSn ? `&device_sn=${encodeURIComponent(histSn)}` : ''));
    if (histSn && activeJackeryDevice()?.device_sn
        && histSn !== activeJackeryDevice().device_sn) return;
    if (!r.ok) return;
    const j = await r.json();
    energyHistoryCache = j;
    drawEnergyChart(j);
    drawEnergyTempChart(j);
  } catch (e) { console.warn('energy history fetch failed', e); }
}

async function fetchEnergyAllDevices() {
  try {
    const r = await fetch('/api/energy/devices');
    if (!r.ok) return;
    const j = await r.json();
    const devs = j.devices || [];
    const tbody = $('energy-devices-body');
    if (!tbody) return;
    if (devs.length < 2) { show($('energy-devices'), false); return; }
    show($('energy-devices'), true);
    tbody.innerHTML = '';
    for (const d of devs) {
      const row = document.createElement('tr');
      row.innerHTML = `
        <td>${escapeHtml(d.name || d.device_sn)}</td>
        <td>${fmtKwh(d.today?.output_wh)} / ${fmtKwh(d.today?.input_wh)} kWh</td>
        <td>${fmtKwh(d.last_7d?.output_wh)} / ${fmtKwh(d.last_7d?.input_wh)} kWh</td>
        <td>${fmtKwh(d.last_30d?.output_wh)} / ${fmtKwh(d.last_30d?.input_wh)} kWh</td>
        <td>${fmtKwh(d.lifetime?.output_wh)} / ${fmtKwh(d.lifetime?.input_wh)} kWh</td>
      `;
      tbody.appendChild(row);
    }
  } catch (e) { console.warn('energy devices fetch failed', e); }
}

// ============================================================
// ENERGY DAILY BREAKDOWN + RECORDS
// One /api/energy/daily?days=365 fetch per tab-open, cached per
// device (energyDailyCache). Range picker / search / column sort
// all re-render client-side from that cache — no refetch.
// ============================================================
let energyDailyDays = 90;                            // table range (client-side slice)
let energyDailySort = { key: 'date', dir: 'desc' };  // default: newest first
let energyDailySearch = '';
let _energyDailyRetries = 0;

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                      'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// "2026-07-13" -> "Jul 13". String parse (no Date()) so the browser's
// timezone can't shift the local-day bucket the server computed.
function fmtDayShort(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  if (!m) return String(iso || '');
  return `${MONTHS_SHORT[Number(m[2]) - 1] || m[2]} ${Number(m[3])}`;
}

// Today's YYYY-MM-DD in the DEVICE's local tz (endpoint reports tz_offset_s).
function energyDailyToday() {
  const off = Number(energyDailyCache?.tz_offset_s) || 0;
  return new Date(Date.now() + off * 1000).toISOString().slice(0, 10);
}

async function fetchEnergyDaily() {
  const deviceSn = activeJackeryDevice()?.device_sn;
  if (!deviceSn) {
    // The tab can open before the first WS status delivers the device
    // list — retry briefly while the Energy tab is still in front.
    if (activeTab === 'energy' && _energyDailyRetries < 5) {
      _energyDailyRetries++;
      setTimeout(fetchEnergyDaily, 1200);
    }
    return;
  }
  _energyDailyRetries = 0;
  // Serve from cache only while it's fresh — the daily rollup changes as
  // the day accrues, so a long-lived dashboard refetches on tab open
  // rather than freezing the Records card at first render.
  const cacheFresh = energyDailyCache
    && energyDailyCache.device_sn === deviceSn
    && (Date.now() - (energyDailyCache._fetched_at || 0)) < 10 * 60 * 1000;
  if (cacheFresh) {
    renderEnergyRecords();
    renderEnergyDailyTable();
    return;
  }
  try {
    const r = await fetch(`/api/energy/daily?device_sn=${encodeURIComponent(deviceSn)}&days=365`);
    if (!r.ok) return;
    const j = await r.json();
    if (!Array.isArray(j.daily)) return;
    if (deviceSn !== (activeJackeryDevice()?.device_sn || deviceSn)) {
      return;  // switched devices while in flight — discard
    }
    j._fetched_at = Date.now();
    energyDailyCache = j;
    renderEnergyRecords();
    renderEnergyDailyTable();
  } catch (e) { console.warn('energy daily fetch failed', e); }
}

// Day entry with the highest strictly-positive `key`, or null. Used for
// both the Records tiles and the record-row highlights in the table.
function _maxDay(daily, key) {
  let best = null;
  for (const d of daily) {
    const v = Number(d[key]);
    if (!Number.isFinite(v) || v <= 0) continue;
    if (!best || v > Number(best[key])) best = d;
  }
  return best;
}

function renderEnergyRecords() {
  const grid = $('energy-records-grid');
  const card = $('energy-records');
  if (!grid || !card) return;
  const daily = energyDailyCache?.daily || [];
  if (!daily.length) { show(card, false); return; }

  const tiles = [];
  const addRecord = (label, key) => {
    const day = _maxDay(daily, key);
    if (!day) return;
    tiles.push({ label, value: Number(day[key]).toFixed(2), sub: fmtDayShort(day.date) });
  };
  addRecord('Peak solar day',       'solar_kwh');
  addRecord('Peak consumption day', 'consumed_kwh');
  addRecord('Peak grid day',        'grid_kwh');
  addRecord('Best diversion day',   'diverted_kwh');

  // 30-day daily averages (most recent 30 local-day buckets).
  const last30 = daily.slice(-30);
  const avg = (key) =>
    last30.reduce((s, d) => s + (Number(d[key]) || 0), 0) / (last30.length || 1);
  tiles.push({ label: 'Avg solar/day',    value: avg('solar_kwh').toFixed(2),    sub: 'last 30 days' });
  tiles.push({ label: 'Avg consumed/day', value: avg('consumed_kwh').toFixed(2), sub: 'last 30 days' });

  grid.innerHTML = tiles.map((t) => `
    <div class="energy-record">
      <div class="kpi-sub rec-label">${escapeHtml(t.label)}</div>
      <div class="kpi-value">${escapeHtml(t.value)}<small>kWh</small></div>
      <div class="kpi-sub">${escapeHtml(t.sub)}</div>
    </div>`).join('');
  show(card, true);
}

// kWh cell: 0 / null renders as an em dash so real energy pops.
function _kwhCell(v) {
  const n = Number(v);
  return (!Number.isFinite(n) || n === 0) ? '—' : n.toFixed(2);
}

function _wattsCell(v) {
  const n = Number(v);
  return Number.isFinite(n) ? String(Math.round(n)) : '—';
}

// Range slice + search filter + sort over the cached 365d payload.
// Search matches the ISO date AND the human "Jul 13" form (case-insensitive).
function _energyDailyRows() {
  const daily = energyDailyCache?.daily || [];
  let rows = daily.slice(-energyDailyDays);   // payload is oldest -> newest
  const q = energyDailySearch.trim().toLowerCase();
  if (q) {
    rows = rows.filter((d) =>
      String(d.date || '').toLowerCase().includes(q) ||
      fmtDayShort(d.date).toLowerCase().includes(q));
  }
  const { key, dir } = energyDailySort;
  const sign = dir === 'asc' ? 1 : -1;
  return rows.slice().sort((a, b) => {
    if (key === 'date') return sign * String(a.date).localeCompare(String(b.date));
    // Explicit null check first: Number(null) === 0, which would sort
    // missing values mid-list instead of last.
    const av = a[key], bv = b[key];
    const an = (av == null || !Number.isFinite(Number(av))) ? -Infinity : Number(av);
    const bn = (bv == null || !Number.isFinite(Number(bv))) ? -Infinity : Number(bv);
    if (an !== bn) return sign * (an - bn);
    return String(b.date).localeCompare(String(a.date)); // deterministic tiebreak
  });
}

function renderEnergyDailyTable() {
  const body = $('energy-daily-body');
  const card = $('energy-daily');
  if (!body || !card) return;
  const daily = energyDailyCache?.daily || [];
  if (!daily.length) { show(card, false); return; }

  const rows = _energyDailyRows();
  const today = energyDailyToday();
  // Record highlights are computed on the FULL payload, not the visible
  // slice, so a record day is marked in every range that contains it.
  const peakSolarDate = _maxDay(daily, 'solar_kwh')?.date;
  const peakLoadDate  = _maxDay(daily, 'consumed_kwh')?.date;

  body.innerHTML = rows.map((d) => {
    const cls = [
      d.date === peakSolarDate && 'record-solar',
      d.date === peakLoadDate  && 'record-load',
    ].filter(Boolean).join(' ');
    const soc = (d.min_soc != null && d.max_soc != null)
      ? `${escapeHtml(d.min_soc)}–${escapeHtml(d.max_soc)}%` : '—';
    const badge = d.date === today ? ' <span class="today-badge">today</span>' : '';
    return `
      <tr${cls ? ` class="${cls}"` : ''}>
        <td title="${escapeHtml(d.date)}">${escapeHtml(fmtDayShort(d.date))}${badge}</td>
        <td class="num">${_kwhCell(d.solar_kwh)}</td>
        <td class="num">${_kwhCell(d.consumed_kwh)}</td>
        <td class="num">${_kwhCell(d.charged_kwh)}</td>
        <td class="num">${_kwhCell(d.grid_kwh)}</td>
        <td class="num">${_kwhCell(d.diverted_kwh)}</td>
        <td class="num">${_wattsCell(d.peak_solar_w)}</td>
        <td class="num">${_wattsCell(d.peak_output_w)}</td>
        <td class="num">${soc}</td>
      </tr>`;
  }).join('');
  show($('energy-daily-empty'), rows.length === 0);
  show(card, true);
}

// ---- Daily breakdown controls (static DOM, bound once at load) ----
document.querySelectorAll('.drange-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.drange-btn').forEach((b) => b.classList.toggle('on', b === btn));
    energyDailyDays = parseInt(btn.dataset.days, 10) || 90;
    renderEnergyDailyTable();
  });
});

document.querySelectorAll('.daily-table th.sortable').forEach((th) => {
  th.addEventListener('click', () => {
    const key = th.dataset.sort;
    if (energyDailySort.key === key) {
      energyDailySort.dir = energyDailySort.dir === 'asc' ? 'desc' : 'asc';
    } else {
      energyDailySort = { key, dir: 'desc' };  // new column: biggest/newest first
    }
    document.querySelectorAll('.daily-table th.sortable').forEach((t) => {
      t.classList.toggle('sort-asc',  t === th && energyDailySort.dir === 'asc');
      t.classList.toggle('sort-desc', t === th && energyDailySort.dir === 'desc');
    });
    renderEnergyDailyTable();
  });
});

$('energy-daily-search')?.addEventListener('input', (e) => {
  energyDailySearch = e.target.value || '';
  renderEnergyDailyTable();
});

// Export the CURRENTLY FILTERED rows (range + search + sort applied).
$('energy-daily-export')?.addEventListener('click', () => {
  if (!energyDailyCache) return;
  const cols = ['date', 'solar_kwh', 'consumed_kwh', 'charged_kwh', 'grid_kwh',
                'diverted_kwh', 'peak_solar_w', 'peak_output_w', 'min_soc', 'max_soc'];
  const lines = [cols.join(',')];
  for (const d of _energyDailyRows()) {
    lines.push(cols.map((c) => (d[c] == null ? '' : String(d[c]))).join(','));
  }
  const sn = String(energyDailyCache.device_sn || 'device').replace(/[^A-Za-z0-9._-]/g, '_');
  const blob = new Blob([lines.join('\n') + '\n'], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `energy-daily-${sn}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
});

// ============================================================
// CHART RENDERERS (canvas, no deps)
// ============================================================
function setCanvasSize(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.floor(rect.width * dpr));
  canvas.height = Math.max(1, Math.floor(rect.height * dpr));
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w: rect.width, h: rect.height };
}

function drawAxes(ctx, w, h, padL, padR, padT, padB) {
  ctx.strokeStyle = '#232a33';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padL, padT);
  ctx.lineTo(padL, h - padB);
  ctx.lineTo(w - padR, h - padB);
  ctx.stroke();
}

// Monotone cubic spline (Fritsch-Carlson / PCHIP) for time-series charts.
// Guarantees:
// 1. Strictly monotonic in X (dx/dt > 0, mathematically impossible to curve backward in time).
// 2. Monotonicity-preserving in Y: local extrema and flat regions (e.g. 0 W plateaus) have zero slope
//    and zero overshoot/undershoot, eliminating loops, shark-fin spikes, and negative dipping.
function _drawMonotoneRun(ctx, run, isFreshPath = true) {
  const n = run.length;
  if (n === 0) return;

  if (isFreshPath) {
    ctx.moveTo(run[0][0], run[0][1]);
  } else {
    ctx.lineTo(run[0][0], run[0][1]);
  }

  if (n === 1) return;
  if (n === 2) {
    ctx.lineTo(run[1][0], run[1][1]);
    return;
  }

  // 1. Calculate secants (slopes between adjacent points)
  const dx = new Array(n - 1);
  const delta = new Array(n - 1);
  for (let i = 0; i < n - 1; i++) {
    const h = run[i + 1][0] - run[i][0];
    dx[i] = h;
    const dy = run[i + 1][1] - run[i][1];
    delta[i] = (h > 1e-6) ? (dy / h) : 0;
  }

  // 2. Calculate tangents m at each point (PCHIP weighted harmonic mean)
  const m = new Array(n);
  for (let i = 1; i < n - 1; i++) {
    if (Math.abs(delta[i - 1]) < 1e-9 || Math.abs(delta[i]) < 1e-9 || (delta[i - 1] * delta[i] <= 0)) {
      m[i] = 0;
    } else {
      const h0 = dx[i - 1];
      const h1 = dx[i];
      const w1 = 2 * h1 + h0;
      const w2 = h1 + 2 * h0;
      m[i] = (w1 + w2) / (w1 / delta[i - 1] + w2 / delta[i]);
    }
  }

  // Boundary tangents
  m[0] = delta[0];
  if (n > 2 && (delta[0] * delta[1] <= 0)) {
    m[0] = 0;
  }

  m[n - 1] = delta[n - 2];
  if (n > 2 && (delta[n - 2] * delta[n - 3] <= 0)) {
    m[n - 1] = 0;
  }

  // 3. Fritsch-Carlson limiter to guarantee monotonicity
  for (let i = 0; i < n - 1; i++) {
    if (Math.abs(delta[i]) < 1e-9) {
      m[i] = 0;
      m[i + 1] = 0;
    } else {
      const alpha = m[i] / delta[i];
      const beta = m[i + 1] / delta[i];
      if (alpha < 0) m[i] = 0;
      if (beta < 0) m[i + 1] = 0;
      const sumSq = alpha * alpha + beta * beta;
      if (sumSq > 9) {
        const tau = 3 / Math.sqrt(sumSq);
        m[i] = tau * alpha * delta[i];
        m[i + 1] = tau * beta * delta[i];
      }
    }
  }

  // 4. Convert Hermite tangents to Cubic Bezier control points and trace
  for (let i = 0; i < n - 1; i++) {
    const p1 = run[i];
    const p2 = run[i + 1];
    const h = dx[i];
    const thirdH = h / 3;

    const cp1x = p1[0] + thirdH;
    const cp1y = p1[1] + m[i] * thirdH;
    const cp2x = p2[0] - thirdH;
    const cp2y = p2[1] - m[i + 1] * thirdH;

    ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2[0], p2[1]);
  }
}

// Build a smooth monotone path through `pts` (array of [x,y]). Skips null entries cleanly (lifts pen + restarts).
function _smoothPath(ctx, pts, isFreshPath = true) {
  if (!pts || !pts.length) return;
  let run = [];
  for (let i = 0; i <= pts.length; i++) {
    const pt = pts[i];
    if (pt && Number.isFinite(pt[0]) && Number.isFinite(pt[1])) {
      run.push(pt);
    } else {
      if (run.length > 0) {
        _drawMonotoneRun(ctx, run, isFreshPath);
        run = [];
        isFreshPath = true;
      }
    }
  }
}

// Stroke a smooth line through a series of values. `xs(i)`/`ys(v)` map
// data-space to canvas-space; null/NaN values lift the pen.
function drawSmoothLine(ctx, points, xs, ys, color, lineWidth = 2.5) {
  const pts = points.map((v, i) =>
    (v == null || Number.isNaN(v)) ? null : [xs(i), ys(v)]);
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  _smoothPath(ctx, pts);
  ctx.stroke();
}

// Same shape as drawSmoothLine, but fills the area below the curve down to
// `baseY` with a vertical gradient (color at top, transparent at bottom).
function drawAreaFill(ctx, points, xs, ys, baseY, color, alphaTop = 0.25) {
  const pts = points.map((v, i) =>
    (v == null || Number.isNaN(v)) ? null : [xs(i), ys(v)]);
  // Walk segments — we may have null gaps; fill each contiguous run
  // separately so a gap doesn't yield a polygon spanning the whole gap.
  let runStart = -1;
  for (let i = 0; i <= pts.length; i++) {
    const here = pts[i];
    if (here && runStart < 0) runStart = i;
    if ((!here || i === pts.length) && runStart >= 0) {
      const run = pts.slice(runStart, i);
      if (run.length >= 1) {
        const minY = Math.min(...run.map((p) => p[1]));
        const grad = ctx.createLinearGradient(0, minY, 0, baseY);
        grad.addColorStop(0, _withAlpha(color, alphaTop));
        grad.addColorStop(1, _withAlpha(color, 0));
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.moveTo(run[0][0], baseY);
        _drawMonotoneRun(ctx, run, false);
        ctx.lineTo(run[run.length - 1][0], baseY);
        ctx.closePath();
        ctx.fill();
      }
      runStart = -1;
    }
  }
}

function _withAlpha(color, a) {
  // accept "#RRGGBB" or "#RGB"
  if (color[0] === '#') {
    let hex = color.slice(1);
    if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    return `rgba(${r},${g},${b},${a})`;
  }
  return color;  // best-effort passthrough
}

// Backwards-compat wrapper used by the energy chart's overlay line. Same
// signature as the old drawSeries; just routes through the new smooth path.
function drawSeries(ctx, points, color, padL, padR, padT, padB, w, h, minY, maxY) {
  if (!points.length) return;
  const xs = (i) => padL + (i / Math.max(1, points.length - 1)) * (w - padL - padR);
  const ys = (v) => h - padB - ((v - minY) / Math.max(1e-6, maxY - minY)) * (h - padT - padB);
  drawSmoothLine(ctx, points, xs, ys, color);
}

// Hover tooltip — created on demand, shared by all charts. Returns a setter
// (call with {x, y, html} to position+show, or null to hide).
let _tooltipEl = null;
function _ensureTooltip() {
  if (_tooltipEl) return _tooltipEl;
  const t = document.createElement('div');
  t.className = 'chart-tooltip';
  t.hidden = true;
  document.body.appendChild(t);
  _tooltipEl = t;
  return t;
}
function chartTooltip(target) {
  const el = _ensureTooltip();
  if (!target) { el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = target.html;
  // Position relative to viewport, but offset above the cursor.
  const left = Math.min(window.innerWidth - el.offsetWidth - 8, target.x + 12);
  const top  = Math.max(8, target.y - el.offsetHeight - 12);
  el.style.left = left + 'px';
  el.style.top  = top + 'px';
}

let liveChartHours = parseInt(localStorage.getItem('live_chart_hours') || '24', 10);
const _liveSel = $('live-chart-hours');
if (_liveSel) {
  _liveSel.value = String(liveChartHours);
  _liveSel.addEventListener('change', () => {
    liveChartHours = parseInt(_liveSel.value, 10) || 24;
    localStorage.setItem('live_chart_hours', String(liveChartHours));
    if (lastStatus) {
      drawLiveChart(lastStatus);
      drawLiveTempChart(lastStatus);
    }
  });
}

function drawLiveChart(s) {
  const canvas = $('chart-live');
  if (!canvas) return;
  const { ctx, w, h } = setCanvasSize(canvas);
  ctx.clearRect(0, 0, w, h);
  const padL = 44, padR = 44, padT = 14, padB = 28;

  const rawHist = (s?.history) || [];
  if (!rawHist.length) {
    ctx.fillStyle = '#6b7280'; ctx.font = '12px Inter';
    ctx.fillText('Waiting for data…', padL + 8, padT + 16);
    return;
  }
  const lastTs = rawHist[rawHist.length - 1].ts || Math.floor(Date.now() / 1000);
  const cutoff = lastTs - liveChartHours * 3600;
  let hist = rawHist.filter(p => (p.ts || 0) >= cutoff);
  if (!hist.length) hist = rawHist;
  const out = hist.map(p => p.output_power_w);
  const inp = hist.map(p => p.input_power_w);
  const bat = hist.map(p => p.battery_percent);
  const maxW = Math.max(50, ...out, ...inp);

  const xs = (i) => padL + (i / Math.max(1, hist.length - 1)) * (w - padL - padR);
  const yWatts = (v) => (h - padB) - (v / Math.max(1e-6, maxW)) * (h - padT - padB);
  const yPct   = (v) => (h - padB) - (v / 100) * (h - padT - padB);
  const baseY  = h - padB;

  // Subtle horizontal gridlines (4)
  ctx.strokeStyle = 'rgba(35,42,51,.7)';
  ctx.lineWidth = 1;
  for (let i = 1; i <= 4; i++) {
    const y = padT + ((h - padT - padB) * i) / 5;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
  }
  drawAxes(ctx, w, h, padL, padR, padT, padB);

  // Left Y-axis labels (Watts)
  ctx.fillStyle = '#6b7280'; ctx.font = '11px Inter';
  ctx.textAlign = 'right';
  for (let i = 0; i <= 4; i++) {
    const v = (maxW * (4 - i)) / 4;
    const y = padT + ((h - padT - padB) * i) / 4;
    ctx.fillText(`${Math.round(v)}`, padL - 6, y + 3);
  }
  // Right Y-axis labels (Battery %)
  ctx.textAlign = 'left';
  ctx.fillStyle = 'rgba(251,191,36,.65)';
  for (const v of [0, 50, 100]) {
    ctx.fillText(`${v}%`, w - padR + 4, yPct(v) + 3);
  }
  ctx.textAlign = 'start';

  // X-axis time ticks — first sample timestamp ... last (clamped to "now").
  if (hist.length >= 2) {
    const first = hist[0].ts || 0, last = hist[hist.length - 1].ts || 0;
    const spanH = (last - first) / 3600;
    const fmtMs = (ms) => {
      const d = new Date(ms * 1000);
      if (spanH > 24) {
        return d.toLocaleDateString([], { month: 'numeric', day: 'numeric' }) + ' ' +
               d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      }
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    };
    ctx.fillStyle = '#6b7280';
    ctx.textAlign = 'center';
    const ticks = 5;
    for (let i = 0; i <= ticks; i++) {
      const ts = first + (last - first) * (i / ticks);
      ctx.fillText(fmtMs(ts), xs((hist.length - 1) * (i / ticks)), h - 8);
    }
    ctx.textAlign = 'start';
  }

  if (_seriesVisible.live.input) {
    drawAreaFill(ctx, inp, xs, yWatts, baseY, SERIES_COLORS.input, .22);
    drawSmoothLine(ctx, inp, xs, yWatts, SERIES_COLORS.input, 2.5);
  }
  if (_seriesVisible.live.output) {
    drawAreaFill(ctx, out, xs, yWatts, baseY, SERIES_COLORS.output, .25);
    drawSmoothLine(ctx, out, xs, yWatts, SERIES_COLORS.output, 2.5);
  }
  // Battery on its own right axis, dashed to make the different scale obvious.
  if (_seriesVisible.live.battery) {
    ctx.save();
    ctx.setLineDash([4, 4]);
    drawSmoothLine(ctx, bat, xs, yPct, SERIES_COLORS.battery, 2);
    ctx.restore();
  }

  // Hover state stored on the canvas element
  canvas._redraw = () => lastStatus && drawLiveChart(lastStatus);
  _attachChartHover(canvas, hist, (i, evt) => {
    const p = hist[i];
    const d = p.ts ? new Date(p.ts * 1000) : null;
    const ts = d
      ? (d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))
      : '';
    return `<div class="cht-ts">${ts}</div>
            <div class="cht-row"><i style="background:${SERIES_COLORS.output}"></i> Output <b>${fmt(p.output_power_w)}</b> W</div>
            <div class="cht-row"><i style="background:${SERIES_COLORS.input}"></i> Input <b>${fmt(p.input_power_w)}</b> W</div>
            <div class="cht-row"><i style="background:${SERIES_COLORS.battery}"></i> Battery <b>${fmt(p.battery_percent)}</b> %</div>`;
  }, () => ({ xs, padL, padR, w, h, baseY: h - padB, padT, padB }));
}

function drawLiveTempChart(s) {
  const canvas = $('chart-live-temp');
  if (!canvas) return;
  const { ctx, w, h } = setCanvasSize(canvas);
  ctx.clearRect(0, 0, w, h);
  const padL = 44, padR = 24, padT = 14, padB = 28;

  const rawHist = (s?.history) || [];
  if (!rawHist.length) {
    ctx.fillStyle = '#6b7280'; ctx.font = '12px Inter';
    ctx.fillText('Waiting for data…', padL + 8, padT + 16);
    return;
  }
  const lastTs = rawHist[rawHist.length - 1].ts || Math.floor(Date.now() / 1000);
  const cutoff = lastTs - liveChartHours * 3600;
  let hist = rawHist.filter(p => (p.ts || 0) >= cutoff);
  if (!hist.length) hist = rawHist;

  const isF = getTempUnit() === 'F';
  const cToDisplay = (c) => (c == null ? null : (isF ? (c * 9 / 5 + 32) : c));

  const tempsC = hist.map(p => p.battery_temp_c).filter(v => v != null && Number.isFinite(v));
  const statEl = $('live-temp-stat');

  if (!tempsC.length) {
    if (statEl) statEl.textContent = 'No temperature readings recorded yet';
    drawAxes(ctx, w, h, padL, padR, padT, padB);
    ctx.fillStyle = '#6b7280'; ctx.font = '12px Inter';
    ctx.fillText('No temperature readings recorded in this window.', padL + 8, padT + 20);
    return;
  }

  const minC = Math.min(...tempsC);
  const maxC = Math.max(...tempsC);
  const avgC = tempsC.reduce((a, b) => a + b, 0) / tempsC.length;
  const latestC = tempsC[tempsC.length - 1];

  if (statEl) {
    statEl.textContent = `Current: ${formatTemp(latestC, 1)} · Min: ${formatTemp(minC, 1)} · Max: ${formatTemp(maxC, 1)} · Avg: ${formatTemp(avgC, 1)}`;
  }

  const tempsDisp = hist.map(p => cToDisplay(p.battery_temp_c));
  const validDisp = tempsDisp.filter(v => v != null);
  let minDisp = Math.min(...validDisp);
  let maxDisp = Math.max(...validDisp);

  const spread = Math.max(isF ? 8 : 4, (maxDisp - minDisp) * 1.3);
  const midDisp = (minDisp + maxDisp) / 2;
  const minY = Math.floor(midDisp - spread / 2);
  const maxY = Math.ceil(midDisp + spread / 2);

  const xs = (i) => padL + (i / Math.max(1, hist.length - 1)) * (w - padL - padR);
  const yTemp = (v) => (h - padB) - ((v - minY) / Math.max(1e-6, maxY - minY)) * (h - padT - padB);
  const baseY = h - padB;

  // Gridlines (4)
  ctx.strokeStyle = 'rgba(35,42,51,.7)';
  ctx.lineWidth = 1;
  for (let i = 1; i <= 4; i++) {
    const y = padT + ((h - padT - padB) * i) / 5;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
  }
  drawAxes(ctx, w, h, padL, padR, padT, padB);

  // Y-axis labels
  ctx.fillStyle = '#6b7280'; ctx.font = '11px Inter';
  ctx.textAlign = 'right';
  const unitStr = isF ? '°F' : '°C';
  for (let i = 0; i <= 4; i++) {
    const v = maxY - ((maxY - minY) * i) / 4;
    const y = padT + ((h - padT - padB) * i) / 4;
    ctx.fillText(`${Math.round(v)}${unitStr}`, padL - 6, y + 3);
  }
  ctx.textAlign = 'start';

  // X-axis time ticks
  if (hist.length >= 2) {
    const first = hist[0].ts || 0, last = hist[hist.length - 1].ts || 0;
    const spanH = (last - first) / 3600;
    const fmtMs = (ms) => {
      const d = new Date(ms * 1000);
      if (spanH > 24) {
        return d.toLocaleDateString([], { month: 'numeric', day: 'numeric' }) + ' ' +
               d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      }
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    };
    ctx.fillStyle = '#6b7280';
    ctx.textAlign = 'center';
    const ticks = 5;
    for (let i = 0; i <= ticks; i++) {
      const ts = first + (last - first) * (i / ticks);
      ctx.fillText(fmtMs(ts), xs((hist.length - 1) * (i / ticks)), h - 8);
    }
    ctx.textAlign = 'start';
  }

  // Draw series if visible
  if (_seriesVisible['live-temp']?.temp) {
    drawAreaFill(ctx, tempsDisp, xs, yTemp, baseY, SERIES_COLORS.temp, .18);
    drawSmoothLine(ctx, tempsDisp, xs, yTemp, SERIES_COLORS.temp, 2.5);
  }

  // Hover state
  canvas._redraw = () => lastStatus && drawLiveTempChart(lastStatus);
  _attachChartHover(canvas, hist, (i) => {
    const p = hist[i];
    const d = p.ts ? new Date(p.ts * 1000) : null;
    const ts = d
      ? (d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))
      : '';
    const tempVal = p.battery_temp_c != null ? formatTemp(p.battery_temp_c, 1) : '—';
    return `<div class="cht-ts">${ts}</div>
            <div class="cht-row"><i style="background:${SERIES_COLORS.temp}"></i> Battery Temp <b>${tempVal}</b></div>`;
  }, () => ({ xs, padL, padR, w, h, baseY: h - padB, padT, padB }));
}

// Generic chart-hover binder. Stores the per-render data + geometry +
// tooltip-builder on the canvas element so the (one-time) listener always
// reads the freshest closures, not stale ones from when it was bound.
function _attachChartHover(canvas, hist, htmlFn, geomFn) {
  // Refresh per-render state every call.
  canvas._chartData = hist;
  canvas._chartHtml = htmlFn;
  canvas._chartGeom = geomFn();
  if (canvas._hoverBound) return;
  canvas._hoverBound = true;
  canvas.style.cursor = 'crosshair';
  const onMove = (e) => {
    const data = canvas._chartData;
    const geom = canvas._chartGeom;
    const html = canvas._chartHtml;
    if (!data?.length || !geom || !html) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    if (x < geom.padL || x > geom.w - geom.padR || y < geom.padT || y > geom.baseY) {
      chartTooltip(null);
      if (canvas._redraw) canvas._redraw();
      return;
    }
    let idx;
    if (geom.getIdx) {
      idx = geom.getIdx(x);
    } else {
      const t = (x - geom.padL) / (geom.w - geom.padL - geom.padR);
      idx = Math.max(0, Math.min(data.length - 1, Math.round(t * (data.length - 1))));
    }
    // Redraw the chart, then overlay the crosshair / highlight.
    if (canvas._redraw) canvas._redraw();
    const ctx = canvas.getContext('2d');
    if (geom.drawHover) {
      geom.drawHover(ctx, idx, geom);
    } else {
      const xPos = geom.xs(idx);
      ctx.strokeStyle = 'rgba(255,255,255,.18)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(xPos, geom.padT); ctx.lineTo(xPos, geom.baseY); ctx.stroke();
    }
    chartTooltip({ x: e.clientX, y: e.clientY, html: html(idx, e) });
  };
  const onLeave = () => {
    chartTooltip(null);
    if (canvas._redraw) canvas._redraw();
  };
  canvas.addEventListener('mousemove', onMove);
  canvas.addEventListener('mouseleave', onLeave);
}

function timeToX(t, hist, padL, totalW, bucket_s) {
  const n = hist.length;
  if (n === 0) return padL;
  const slot = totalW / n;
  if (t <= hist[0].ts) return padL;
  const lastEnd = hist[n - 1].ts + bucket_s;
  if (t >= lastEnd) return padL + totalW;

  let low = 0, high = n - 1, idx = 0;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (hist[mid].ts <= t) {
      idx = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  const bStart = hist[idx].ts;
  const bDuration = (idx < n - 1) ? (hist[idx + 1].ts - bStart) : bucket_s;
  const frac = bDuration > 0 ? Math.min(1, Math.max(0, (t - bStart) / bDuration)) : 0;
  return padL + (idx + frac) * slot;
}

function getRoundTicks(tMin, tMax) {
  const spanSec = tMax - tMin;
  const spanHours = spanSec / 3600;
  const ticks = [];
  const cur = new Date(tMin * 1000);

  if (spanHours <= 3) {
    cur.setSeconds(0, 0);
    const m = cur.getMinutes();
    cur.setMinutes(m < 30 ? 0 : 30);
    while (cur.getTime() / 1000 < tMin) cur.setMinutes(cur.getMinutes() + 30);
    while (cur.getTime() / 1000 <= tMax && ticks.length < 50) {
      const ts = Math.floor(cur.getTime() / 1000);
      const label = cur.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      ticks.push({ ts, label });
      cur.setMinutes(cur.getMinutes() + 30);
    }
  } else if (spanHours <= 8) {
    cur.setMinutes(0, 0, 0);
    while (cur.getTime() / 1000 < tMin) cur.setHours(cur.getHours() + 1);
    while (cur.getTime() / 1000 <= tMax && ticks.length < 50) {
      const ts = Math.floor(cur.getTime() / 1000);
      const label = cur.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      ticks.push({ ts, label });
      cur.setHours(cur.getHours() + 1);
    }
  } else if (spanHours <= 16) {
    cur.setMinutes(0, 0, 0);
    cur.setHours(cur.getHours() - (cur.getHours() % 2));
    while (cur.getTime() / 1000 < tMin) cur.setHours(cur.getHours() + 2);
    while (cur.getTime() / 1000 <= tMax && ticks.length < 50) {
      const ts = Math.floor(cur.getTime() / 1000);
      const label = cur.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      ticks.push({ ts, label });
      cur.setHours(cur.getHours() + 2);
    }
  } else if (spanHours <= 36) {
    cur.setMinutes(0, 0, 0);
    cur.setHours(cur.getHours() - (cur.getHours() % 4));
    while (cur.getTime() / 1000 < tMin) cur.setHours(cur.getHours() + 4);
    while (cur.getTime() / 1000 <= tMax && ticks.length < 50) {
      const ts = Math.floor(cur.getTime() / 1000);
      const label = (cur.getHours() === 0)
        ? cur.toLocaleDateString([], { month: 'short', day: 'numeric' })
        : cur.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      ticks.push({ ts, label });
      cur.setHours(cur.getHours() + 4);
    }
  } else if (spanHours <= 96) {
    cur.setMinutes(0, 0, 0);
    cur.setHours(cur.getHours() - (cur.getHours() % 12));
    while (cur.getTime() / 1000 < tMin) cur.setHours(cur.getHours() + 12);
    while (cur.getTime() / 1000 <= tMax && ticks.length < 50) {
      const ts = Math.floor(cur.getTime() / 1000);
      const label = (cur.getHours() === 0)
        ? cur.toLocaleDateString([], { month: 'short', day: 'numeric' })
        : cur.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      ticks.push({ ts, label });
      cur.setHours(cur.getHours() + 12);
    }
  } else if (spanHours <= 240) {
    cur.setHours(0, 0, 0, 0);
    while (cur.getTime() / 1000 < tMin) cur.setDate(cur.getDate() + 1);
    while (cur.getTime() / 1000 <= tMax && ticks.length < 50) {
      const ts = Math.floor(cur.getTime() / 1000);
      const label = cur.toLocaleDateString([], { month: 'short', day: 'numeric' });
      ticks.push({ ts, label });
      cur.setDate(cur.getDate() + 1);
    }
  } else if (spanHours <= 1000) {
    cur.setHours(0, 0, 0, 0);
    if (cur.getDate() % 5 !== 0) {
      cur.setDate(Math.ceil(cur.getDate() / 5) * 5 || 1);
    }
    while (cur.getTime() / 1000 < tMin) cur.setDate(cur.getDate() + 5);
    while (cur.getTime() / 1000 <= tMax && ticks.length < 50) {
      const ts = Math.floor(cur.getTime() / 1000);
      const label = cur.toLocaleDateString([], { month: 'short', day: 'numeric' });
      ticks.push({ ts, label });
      cur.setDate(cur.getDate() + 5);
    }
  } else if (spanHours <= 2500) {
    cur.setHours(0, 0, 0, 0);
    cur.setDate(cur.getDate() < 15 ? 1 : 15);
    while (cur.getTime() / 1000 < tMin) {
      if (cur.getDate() === 1) cur.setDate(15);
      else { cur.setDate(1); cur.setMonth(cur.getMonth() + 1); }
    }
    while (cur.getTime() / 1000 <= tMax && ticks.length < 50) {
      const ts = Math.floor(cur.getTime() / 1000);
      const label = cur.toLocaleDateString([], { month: 'short', day: 'numeric' });
      ticks.push({ ts, label });
      if (cur.getDate() === 1) cur.setDate(15);
      else { cur.setDate(1); cur.setMonth(cur.getMonth() + 1); }
    }
  } else {
    cur.setHours(0, 0, 0, 0);
    cur.setDate(1);
    while (cur.getTime() / 1000 < tMin) cur.setMonth(cur.getMonth() + 1);
    while (cur.getTime() / 1000 <= tMax && ticks.length < 50) {
      const ts = Math.floor(cur.getTime() / 1000);
      const label = cur.toLocaleDateString([], { month: 'short' });
      ticks.push({ ts, label });
      cur.setMonth(cur.getMonth() + 1);
    }
  }
  return ticks;
}

function drawEnergyChart(j) {
  const canvas = $('chart-energy');
  if (!canvas) return;
  const { ctx, w, h } = setCanvasSize(canvas);
  ctx.clearRect(0, 0, w, h);
  const padL = 42, padR = 16, padT = 14, padB = 28;
  drawAxes(ctx, w, h, padL, padR, padT, padB);

  const hist = (j?.history) || [];
  if (!hist.length) {
    ctx.fillStyle = '#6b7280'; ctx.font = '12px Inter';
    ctx.fillText('No energy data yet — keep the monitor running.', padL + 8, padT + 16);
    return;
  }

  const out = hist.map(p => p.output_wh || 0);
  const inp = hist.map(p => p.input_wh || 0);
  const bat = hist.map(p => (p.avg_battery_percent ?? p.battery_pct));
  const maxWh = Math.max(1, Math.max(...out, ...inp));

  // Grid + y-axis labels (Wh per bucket)
  ctx.strokeStyle = '#1c2128'; ctx.lineWidth = 1;
  ctx.fillStyle = '#6b7280'; ctx.font = '11px Inter';
  ctx.textAlign = 'right';
  for (let i = 0; i <= 4; i++) {
    const y = padT + ((h - padT - padB) * i) / 4;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
    const v = (maxWh * (4 - i)) / 4;
    ctx.fillText(`${Math.round(v)}`, padL - 6, y + 3);
  }
  ctx.textAlign = 'start';

  const n = hist.length;
  const totalW = w - padL - padR;
  const slot = totalW / n;
  const bucket_s = j?.bucket_s || (hist.length > 1 ? (hist[1].ts - hist[0].ts) : 60);
  const tMin = hist[0].ts;
  const tMax = hist[n - 1].ts + bucket_s;
  const spanSec = tMax - tMin;

  // Round-number ticks on the x-axis
  const rawTicks = getRoundTicks(tMin, tMax);
  let candidateTicks = rawTicks;
  if (candidateTicks.length > 2) {
    const avgDist = totalW / (candidateTicks.length - 1);
    if (avgDist < 48) {
      const step = Math.ceil(48 / avgDist);
      candidateTicks = candidateTicks.filter((_, idx) => idx % step === 0);
    }
  }

  const validTicks = [];
  for (const tick of candidateTicks) {
    const x = timeToX(tick.ts, hist, padL, totalW, bucket_s);
    if (x >= padL && x <= w - padR) {
      validTicks.push({ ...tick, x });
    }
  }

  // Dim dotted vertical lines for round intervals
  ctx.save();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
  ctx.lineWidth = 1;
  ctx.setLineDash([2, 3]);
  for (const tick of validTicks) {
    if (tick.x > padL + 1 && tick.x < w - padR - 1) {
      ctx.beginPath();
      ctx.moveTo(tick.x, padT);
      ctx.lineTo(tick.x, h - padB);
      ctx.stroke();
    }
  }
  ctx.restore();

  // X-axis labels
  ctx.fillStyle = '#6b7280';
  ctx.font = '11px Inter';
  for (const tick of validTicks) {
    if (tick.x - padL < 18) {
      ctx.textAlign = 'left';
      ctx.fillText(tick.label, padL, h - 8);
    } else if ((w - padR) - tick.x < 18) {
      ctx.textAlign = 'right';
      ctx.fillText(tick.label, w - padR, h - 8);
    } else {
      ctx.textAlign = 'center';
      ctx.fillText(tick.label, tick.x, h - 8);
    }
  }
  ctx.textAlign = 'start';

  // Fallback if no round ticks fit (e.g. initial few minutes of data)
  if (validTicks.length === 0 && hist.length >= 2) {
    const fmtTs = (ts) => new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    ctx.fillStyle = '#6b7280';
    ctx.font = '11px Inter';
    ctx.textAlign = 'left';
    ctx.fillText(fmtTs(hist[0].ts), padL, h - 8);
    ctx.textAlign = 'right';
    ctx.fillText(fmtTs(hist[n - 1].ts), w - padR, h - 8);
    ctx.textAlign = 'start';
  }

  // Bars: consumed (left of slot) + charged (right of slot), interleaved.
  const barW = Math.max(1, Math.min(slot * 0.4, 16));
  for (let i = 0; i < n; i++) {
    const xCenter = padL + slot * (i + 0.5);
    const yBase = h - padB;
    if (_seriesVisible.energy.output) {
      const yOut = yBase - (out[i] / maxWh) * (h - padT - padB);
      ctx.fillStyle = SERIES_COLORS.output;
      ctx.fillRect(xCenter - barW - 1, yOut, barW, yBase - yOut);
    }
    if (_seriesVisible.energy.input) {
      const yIn = yBase - (inp[i] / maxWh) * (h - padT - padB);
      ctx.fillStyle = SERIES_COLORS.input;
      ctx.fillRect(xCenter + 1, yIn, barW, yBase - yIn);
    }
  }

  if (_seriesVisible.energy.battery && bat.some(v => v != null)) {
    ctx.strokeStyle = SERIES_COLORS.battery;
    ctx.lineWidth = 2;
    ctx.beginPath();
    let started = false;
    bat.forEach((v, i) => {
      if (v == null) { started = false; return; }
      const x = padL + slot * (i + 0.5);
      const y = (h - padB) - (v / 100) * (h - padT - padB);
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }

  // Hover state stored on the canvas element
  canvas._redraw = () => energyHistoryCache && drawEnergyChart(energyHistoryCache);
  _attachChartHover(canvas, hist, (i) => {
    const p = hist[i];
    const bPct = p.avg_battery_percent ?? p.battery_pct;
    const dStart = new Date(p.ts * 1000);
    const dEnd = new Date((p.ts + bucket_s) * 1000);
    let timeStr;
    if (bucket_s >= 86400) {
      timeStr = dStart.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
    } else if (spanSec > 24 * 3600) {
      timeStr = `${dStart.toLocaleDateString([], { month: 'short', day: 'numeric' })} · ${dStart.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} – ${dEnd.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    } else {
      timeStr = `${dStart.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} – ${dEnd.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    }

    const fmtWh = (wh) => {
      if (wh == null || Number.isNaN(wh)) return '—';
      const val = Number(wh);
      if (val >= 1000) {
        return `${Math.round(val).toLocaleString()} Wh <span style="font-weight:normal;opacity:0.7;font-size:10px">(${(val / 1000).toFixed(2)} kWh)</span>`;
      }
      return `${val.toFixed(val < 10 && val > 0 ? 1 : 0)} Wh`;
    };

    let html = `<div class="cht-ts">${timeStr}</div>`;
    if (_seriesVisible.energy.output) {
      html += `<div class="cht-row"><i style="background:${SERIES_COLORS.output}"></i> Consumed <b>${fmtWh(p.output_wh || 0)}</b></div>`;
    }
    if (_seriesVisible.energy.input) {
      html += `<div class="cht-row"><i style="background:${SERIES_COLORS.input}"></i> Charged <b>${fmtWh(p.input_wh || 0)}</b></div>`;
    }
    if (_seriesVisible.energy.battery && bPct != null) {
      html += `<div class="cht-row"><i style="background:${SERIES_COLORS.battery}"></i> Battery <b>${fmt(bPct, 0)}%</b></div>`;
    }
    if ((p.solar_wh > 0 || p.ac_input_wh > 0) && _seriesVisible.energy.input) {
      html += `<div class="cht-row" style="color:#6b7280;font-size:10px;margin-top:3px">
        Solar: ${fmtWh(p.solar_wh || 0)} · Grid: ${fmtWh(p.ac_input_wh || 0)}
      </div>`;
    }
    return html;
  }, () => ({
    padL, padR, padT, padB, w, h, baseY: h - padB, slot,
    getIdx: (x) => Math.max(0, Math.min(n - 1, Math.floor((x - padL) / slot))),
    drawHover: (ctx, idx) => {
      const xSlot = padL + idx * slot;
      const xCenter = padL + slot * (idx + 0.5);
      // Subtle column slot highlight band
      ctx.fillStyle = 'rgba(255, 255, 255, 0.06)';
      ctx.fillRect(xSlot, padT, slot, h - padT - padB);
      // Center guideline
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(xCenter, padT);
      ctx.lineTo(xCenter, h - padB);
      ctx.stroke();
      // Battery dot if battery line is shown
      if (_seriesVisible.energy.battery && bat[idx] != null) {
        const yBat = (h - padB) - (bat[idx] / 100) * (h - padT - padB);
        ctx.fillStyle = SERIES_COLORS.battery;
        ctx.beginPath();
        ctx.arc(xCenter, yBat, 3.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#0f141c';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
  }));
}

function drawEnergyTempChart(j) {
  const canvas = $('chart-energy-temp');
  if (!canvas) return;
  const { ctx, w, h } = setCanvasSize(canvas);
  ctx.clearRect(0, 0, w, h);
  const padL = 42, padR = 16, padT = 14, padB = 28;

  const hist = (j?.history) || [];
  const statEl = $('energy-temp-stat');
  if (!hist.length) {
    if (statEl) statEl.textContent = '';
    drawAxes(ctx, w, h, padL, padR, padT, padB);
    ctx.fillStyle = '#6b7280'; ctx.font = '12px Inter';
    ctx.fillText('No energy data yet — keep the monitor running.', padL + 8, padT + 16);
    return;
  }

  const isF = getTempUnit() === 'F';
  const cToDisplay = (c) => (c == null ? null : (isF ? (c * 9 / 5 + 32) : c));

  const tempsC = hist.map(p => p.battery_temp_c).filter(v => v != null && Number.isFinite(v));
  if (!tempsC.length) {
    if (statEl) statEl.textContent = 'No temperature readings recorded for this period';
    drawAxes(ctx, w, h, padL, padR, padT, padB);
    ctx.fillStyle = '#6b7280'; ctx.font = '12px Inter';
    ctx.fillText('No temperature readings recorded in this window.', padL + 8, padT + 20);
    return;
  }

  const minC = Math.min(...tempsC);
  const maxC = Math.max(...tempsC);
  const avgC = tempsC.reduce((a, b) => a + b, 0) / tempsC.length;
  if (statEl) {
    statEl.textContent = `Min: ${formatTemp(minC, 1)} · Max: ${formatTemp(maxC, 1)} · Avg: ${formatTemp(avgC, 1)}`;
  }

  const tempsDisp = hist.map(p => cToDisplay(p.battery_temp_c));
  const validDisp = tempsDisp.filter(v => v != null);
  let minDisp = Math.min(...validDisp);
  let maxDisp = Math.max(...validDisp);

  const spread = Math.max(isF ? 8 : 4, (maxDisp - minDisp) * 1.3);
  const midDisp = (minDisp + maxDisp) / 2;
  const minY = Math.floor(midDisp - spread / 2);
  const maxY = Math.ceil(midDisp + spread / 2);

  const n = hist.length;
  const totalW = w - padL - padR;
  const slot = totalW / n;
  const bucket_s = j?.bucket_s || (hist.length > 1 ? (hist[1].ts - hist[0].ts) : 60);
  const tMin = hist[0].ts;
  const tMax = hist[n - 1].ts + bucket_s;
  const spanSec = tMax - tMin;

  const xs = (i) => padL + slot * (i + 0.5);
  const yTemp = (v) => (h - padB) - ((v - minY) / Math.max(1e-6, maxY - minY)) * (h - padT - padB);
  const baseY = h - padB;

  // Grid + y-axis labels
  ctx.strokeStyle = '#1c2128'; ctx.lineWidth = 1;
  ctx.fillStyle = '#6b7280'; ctx.font = '11px Inter';
  ctx.textAlign = 'right';
  const unitStr = isF ? '°F' : '°C';
  for (let i = 0; i <= 4; i++) {
    const y = padT + ((h - padT - padB) * i) / 4;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
    const v = maxY - ((maxY - minY) * i) / 4;
    ctx.fillText(`${Math.round(v)}${unitStr}`, padL - 6, y + 3);
  }
  ctx.textAlign = 'start';
  drawAxes(ctx, w, h, padL, padR, padT, padB);

  // Round-number ticks on the x-axis
  const rawTicks = getRoundTicks(tMin, tMax);
  let candidateTicks = rawTicks;
  if (candidateTicks.length > 2) {
    const avgDist = totalW / (candidateTicks.length - 1);
    if (avgDist < 48) {
      const step = Math.ceil(48 / avgDist);
      candidateTicks = candidateTicks.filter((_, idx) => idx % step === 0);
    }
  }

  const validTicks = [];
  for (const tick of candidateTicks) {
    const x = timeToX(tick.ts, hist, padL, totalW, bucket_s);
    if (x >= padL && x <= w - padR) {
      validTicks.push({ ...tick, x });
    }
  }

  // Dim dotted vertical lines
  ctx.save();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
  ctx.lineWidth = 1;
  ctx.setLineDash([2, 3]);
  for (const tick of validTicks) {
    if (tick.x > padL + 1 && tick.x < w - padR - 1) {
      ctx.beginPath();
      ctx.moveTo(tick.x, padT);
      ctx.lineTo(tick.x, h - padB);
      ctx.stroke();
    }
  }
  ctx.restore();

  // X-axis labels
  ctx.fillStyle = '#6b7280';
  ctx.font = '11px Inter';
  for (const tick of validTicks) {
    if (tick.x - padL < 18) {
      ctx.textAlign = 'left';
      ctx.fillText(tick.label, padL, h - 8);
    } else if ((w - padR) - tick.x < 18) {
      ctx.textAlign = 'right';
      ctx.fillText(tick.label, w - padR, h - 8);
    } else {
      ctx.textAlign = 'center';
      ctx.fillText(tick.label, tick.x, h - 8);
    }
  }
  ctx.textAlign = 'start';

  if (validTicks.length === 0 && hist.length >= 2) {
    const fmtTs = (ts) => new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    ctx.fillStyle = '#6b7280';
    ctx.font = '11px Inter';
    ctx.textAlign = 'left';
    ctx.fillText(fmtTs(hist[0].ts), padL, h - 8);
    ctx.textAlign = 'right';
    ctx.fillText(fmtTs(hist[n - 1].ts), w - padR, h - 8);
    ctx.textAlign = 'start';
  }

  // Draw series if visible
  if (_seriesVisible['energy-temp']?.temp) {
    drawAreaFill(ctx, tempsDisp, xs, yTemp, baseY, SERIES_COLORS.temp, .18);
    drawSmoothLine(ctx, tempsDisp, xs, yTemp, SERIES_COLORS.temp, 2.5);
  }

  // Hover state
  canvas._redraw = () => energyHistoryCache && drawEnergyTempChart(energyHistoryCache);
  _attachChartHover(canvas, hist, (i) => {
    const p = hist[i];
    const dStart = new Date(p.ts * 1000);
    const dEnd = new Date((p.ts + bucket_s) * 1000);
    let timeStr;
    if (bucket_s >= 86400) {
      timeStr = dStart.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
    } else if (spanSec > 24 * 3600) {
      timeStr = `${dStart.toLocaleDateString([], { month: 'short', day: 'numeric' })} · ${dStart.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} – ${dEnd.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    } else {
      timeStr = `${dStart.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} – ${dEnd.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    }
    const tempVal = p.battery_temp_c != null ? formatTemp(p.battery_temp_c, 1) : '—';
    return `<div class="cht-ts">${timeStr}</div>
            <div class="cht-row"><i style="background:${SERIES_COLORS.temp}"></i> Battery Temp <b>${tempVal}</b></div>`;
  }, () => ({
    padL, padR, padT, padB, w, h, baseY: h - padB, slot,
    getIdx: (x) => Math.max(0, Math.min(n - 1, Math.floor((x - padL) / slot))),
    drawHover: (hoverCtx, idx, g) => {
      const xSlot = padL + idx * slot;
      const xCenter = padL + slot * (idx + 0.5);
      hoverCtx.fillStyle = 'rgba(255, 255, 255, 0.06)';
      hoverCtx.fillRect(xSlot, padT, slot, h - padT - padB);

      hoverCtx.strokeStyle = 'rgba(255, 255, 255, 0.22)';
      hoverCtx.lineWidth = 1;
      hoverCtx.beginPath();
      hoverCtx.moveTo(xCenter, padT);
      hoverCtx.lineTo(xCenter, h - padB);
      hoverCtx.stroke();

      const val = tempsDisp[idx];
      if (val != null) {
        const yPos = yTemp(val);
        hoverCtx.fillStyle = SERIES_COLORS.temp;
        hoverCtx.beginPath();
        hoverCtx.arc(xCenter, yPos, 4, 0, Math.PI * 2);
        hoverCtx.fill();
        hoverCtx.strokeStyle = '#0f141c';
        hoverCtx.lineWidth = 1.5;
        hoverCtx.stroke();
      }
    }
  }));
}

// Redraw on resize
window.addEventListener('resize', () => {
  _chartRedraw[activeTab]?.();
});

// ============================================================
// COST TAB
// ============================================================
let costSummaryCache = null;
let costDistDays = 30;
let costDistCache = null;
let costRangeHours = 24;
let costHistoryCache = null;
let costBreakdownGroup = 'day';
let costBreakdownCache = null;
let costTableSort = { key: 'period', dir: 'desc' };
let costSearchQuery = '';
let costMode = localStorage.getItem('jackery_cost_mode') || 'battery';

const COST_MODE_HINTS = {
  battery: '<strong>Battery Arbitrage:</strong> Isolates battery cell charging and discharging. Bypasses AC grid passthrough to show true battery efficiency and time-shifting savings.',
  total: '<strong>Total Equipment:</strong> Includes AC grid passthrough in consumption and synthesizes grid draw. Shows full appliance electricity cost without inflating net savings.',
};

function updateCostModeUI() {
  document.querySelectorAll('.cost-mode-btn').forEach(btn => {
    btn.classList.toggle('on', btn.dataset.mode === costMode);
  });
  const hintEl = $('cost-mode-hint');
  if (hintEl) {
    hintEl.innerHTML = COST_MODE_HINTS[costMode] || COST_MODE_HINTS.battery;
  }
}

function fmtRate(rate, currency = 'USD') {
  if (rate == null || !Number.isFinite(Number(rate))) return '—';
  const val = Number(rate);
  if (currency === 'USD' || currency === 'CAD') {
    return `${(val * 100).toFixed(1)}¢/kWh`;
  }
  return `${fmtMoney(val, currency)}/kWh`;
}

function fmtSavingsClass(val) {
  if (val == null || !Number.isFinite(Number(val)) || Math.abs(Number(val)) < 0.005) return 'savings-zero';
  return Number(val) > 0 ? 'savings-positive' : 'savings-negative';
}

function fmtCostPeriod(period, groupBy) {
  const s = String(period || '');
  if (groupBy === 'day') {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (m) {
      return `${MONTHS_SHORT[Number(m[2]) - 1] || m[2]} ${Number(m[3])}, ${m[1]}`;
    }
    return s;
  }
  if (groupBy === 'week') {
    const m = /^(\d{4})-W(\d{1,2})$/.exec(s);
    if (m) return `Week ${m[2]}, ${m[1]}`;
    return s;
  }
  if (groupBy === 'month') {
    const m = /^(\d{4})-(\d{2})$/.exec(s);
    if (m) {
      const fullMonths = ['January', 'February', 'March', 'April', 'May', 'June',
                          'July', 'August', 'September', 'October', 'November', 'December'];
      return `${fullMonths[Number(m[2]) - 1] || m[2]} ${m[1]}`;
    }
    return s;
  }
  return s;
}

async function fetchCostSummary() {
  const sn = activeJackeryDevice()?.device_sn;
  const url = `/api/cost/summary?mode=${encodeURIComponent(costMode)}` + (sn ? `&device_sn=${encodeURIComponent(sn)}` : '');
  try {
    const r = await fetch(url);
    if (!r.ok) return;
    const j = await r.json();
    costSummaryCache = j;
    renderCostSummary(j);
  } catch (e) {
    console.warn('cost summary fetch failed', e);
  }
}

function renderCostSummary(j) {
  if (!j) return;
  const cur = j.currency || 'USD';
  const periods = [
    { key: 'today', idNet: 'cost-today-net', idGrid: 'cost-today-grid', idSolar: 'cost-today-solar', idBase: 'cost-today-baseline', idRates: 'cost-today-rates' },
    { key: 'last_7d', idNet: 'cost-7d-net', idGrid: 'cost-7d-grid', idSolar: 'cost-7d-solar', idBase: 'cost-7d-baseline', idRates: 'cost-7d-rates' },
    { key: 'last_30d', idNet: 'cost-30d-net', idGrid: 'cost-30d-grid', idSolar: 'cost-30d-solar', idBase: 'cost-30d-baseline', idRates: 'cost-30d-rates' },
    { key: 'lifetime', idNet: 'cost-life-net', idGrid: 'cost-life-grid', idSolar: 'cost-life-solar', idBase: 'cost-life-baseline', idRates: 'cost-life-rates' },
  ];

  for (const p of periods) {
    const d = j[p.key];
    const elNet = $(p.idNet);
    const elGrid = $(p.idGrid);
    const elSolar = $(p.idSolar);
    const elBase = $(p.idBase);
    const elRates = $(p.idRates);

    if (!d) {
      if (elNet) elNet.textContent = '—';
      if (elGrid) elGrid.textContent = '—';
      if (elSolar) elSolar.textContent = fmtMoney(0, cur);
      if (elBase) elBase.textContent = '—';
      if (elRates) elRates.textContent = '—';
      continue;
    }

    const net = d.net_saved ?? d.net_savings ?? 0;
    if (elNet) {
      elNet.textContent = `${net >= 0 ? '+' : ''}${fmtMoney(net, cur)}`;
      elNet.className = fmtSavingsClass(net);
    }
    if (elGrid) elGrid.textContent = fmtMoney(d.grid_cost, cur);
    if (elSolar) elSolar.textContent = fmtMoney(d.solar_cost ?? 0, cur);
    if (elBase) elBase.textContent = fmtMoney(d.baseline_cost, cur);

    if (elRates) {
      const buy = d.avg_buy_rate;
      const use = d.avg_use_rate;
      if (buy != null && use != null) {
        elRates.textContent = `${fmtRate(buy, cur)} buy → ${fmtRate(use, cur)} use`;
      } else if (buy != null) {
        elRates.textContent = `${fmtRate(buy, cur)} buy`;
      } else if (use != null) {
        elRates.textContent = `${fmtRate(use, cur)} use`;
      } else {
        elRates.textContent = '—';
      }
    }
  }
}

async function fetchCostDistribution(days = costDistDays) {
  costDistDays = days;
  const sn = activeJackeryDevice()?.device_sn;
  const url = `/api/cost/distribution?days=${days}&mode=${encodeURIComponent(costMode)}` + (sn ? `&device_sn=${encodeURIComponent(sn)}` : '');
  try {
    const r = await fetch(url);
    if (!r.ok) return;
    const j = await r.json();
    costDistCache = j;
    renderCostDistribution(j);
  } catch (e) {
    console.warn('cost distribution fetch failed', e);
  }
}

function renderCostDistribution(j) {
  const container = $('cost-tou-bars');
  const summaryEl = $('cost-arbitrage-summary');
  if (!container || !summaryEl) return;
  if (!j) {
    container.innerHTML = '<p class="hint">No data available.</p>';
    summaryEl.innerHTML = '';
    return;
  }
  const cur = j.currency || 'USD';
  const tiers = j.tiers || [];

  if (j.plan_type !== 'tou' || !tiers.length) {
    container.innerHTML = `
      <p class="hint">
        ${j.plan_type === 'flat' 
          ? 'Your active electricity plan is configured with Flat rates. Time-of-Use distribution is available for TOU plans (configure in Settings → Electricity plan).'
          : 'No TOU rate slots configured. Visit Settings → Electricity plan to configure Time-of-Use hours.'}
      </p>`;
    summaryEl.innerHTML = '';
    return;
  }

  const activeTiers = tiers.filter(t => (t.charged_kwh || 0) > 0 || (t.discharged_kwh || 0) > 0);
  const displayTiers = activeTiers.length > 0 ? activeTiers : tiers;

  container.innerHTML = displayTiers.map(t => {
    const cVal = t.charged_kwh ?? t.charge_kwh ?? 0;
    const dVal = t.discharged_kwh ?? t.discharge_kwh ?? 0;
    const chgKwh = cVal.toFixed(2);
    const disKwh = dVal.toFixed(2);
    const chgPctVal = t.charged_pct ?? t.charge_pct ?? 0;
    const disPctVal = t.discharged_pct ?? t.discharge_pct ?? 0;
    const chgPct = chgPctVal.toFixed(1);
    const disPct = disPctVal.toFixed(1);
    // Distribution percentage widths (0 - 100%)
    const chgBarWidth = Math.max(cVal > 0 ? 1 : 0, Math.min(100, Math.round(chgPctVal)));
    const disBarWidth = Math.max(dVal > 0 ? 1 : 0, Math.min(100, Math.round(disPctVal)));

    return `
      <div class="cost-bar-row">
        <div class="cost-bar-label">
          <span>${escapeHtml(t.label || t.name || t.tier_id)}</span>
          <small>${fmtRate(t.rate, cur)}</small>
        </div>
        <div class="cost-bar-track">
          <div class="cost-bar-subline">
            <span class="cost-bar-subline-label">Charge</span>
            <div class="cost-bar-outer">
              <div class="cost-bar-fill charge" style="width: ${chgBarWidth}%"></div>
            </div>
            <span class="cost-bar-val">${chgKwh} kWh (${chgPct}%)</span>
          </div>
          <div class="cost-bar-subline">
            <span class="cost-bar-subline-label">Output</span>
            <div class="cost-bar-outer">
              <div class="cost-bar-fill discharge" style="width: ${disBarWidth}%"></div>
            </div>
            <span class="cost-bar-val">${disKwh} kWh (${disPct}%)</span>
          </div>
        </div>
      </div>
    `;
  }).join('');

  const avgChg = j.avg_charge_rate ?? (j.total_charged_kwh > 0 ? (tiers.reduce((s, t) => s + (t.charged_cost || 0), 0) / j.total_charged_kwh) : null);
  const avgDis = j.avg_discharge_rate ?? (j.total_discharged_kwh > 0 ? (tiers.reduce((s, t) => s + (t.avoided_cost || 0), 0) / j.total_discharged_kwh) : null);
  const chgRateStr = fmtRate(avgChg, cur);
  const disRateStr = fmtRate(avgDis, cur);
  const scoreStr = j.arbitrage_score != null ? `${Number(j.arbitrage_score).toFixed(1)}%` : '—';
  const marginStr = (avgDis != null && avgChg != null)
    ? fmtRate(avgDis - avgChg, cur)
    : '—';

  summaryEl.innerHTML = `
    <div class="cost-summary-stat">
      <span class="stat-label">Effective buy rate:</span>
      <span class="stat-value">${chgRateStr}</span>
    </div>
    <div class="cost-summary-stat">
      <span class="stat-label">Displaced grid rate:</span>
      <span class="stat-value">${disRateStr}</span>
    </div>
    <div class="cost-summary-stat">
      <span class="stat-label">Spread margin:</span>
      <span class="stat-value savings-positive">${marginStr}</span>
    </div>
    <div class="cost-summary-stat">
      <span class="stat-label">Arbitrage efficiency score:</span>
      <span class="stat-value">${scoreStr}</span>
    </div>
  `;
}

async function fetchCostHistory(hours = costRangeHours) {
  costRangeHours = hours;
  const sn = activeJackeryDevice()?.device_sn;
  const url = `/api/cost/history?hours=${hours}&mode=${encodeURIComponent(costMode)}` + (sn ? `&device_sn=${encodeURIComponent(sn)}` : '');
  try {
    const r = await fetch(url);
    if (!r.ok) return;
    const j = await r.json();
    costHistoryCache = j;
    drawCostChart(j);
  } catch (e) {
    console.warn('cost history fetch failed', e);
  }
}

function drawCostChart(j) {
  const canvas = $('chart-cost');
  if (!canvas) return;
  const { ctx, w, h } = setCanvasSize(canvas);
  ctx.clearRect(0, 0, w, h);
  const padL = 50, padR = 24, padT = 14, padB = 28;
  drawAxes(ctx, w, h, padL, padR, padT, padB);

  const hist = (j?.history) || [];
  if (!hist.length) {
    ctx.fillStyle = '#6b7280'; ctx.font = '12px Inter';
    ctx.fillText('No cost history data for this period.', padL + 8, padT + 20);
    return;
  }

  const cur = j?.currency || 'USD';
  const baseline = hist.map(p => p.baseline_cost || 0);
  const grid = hist.map(p => p.grid_cost || 0);
  const net = hist.map(p => p.net_saved || 0);

  const activeVals = [0.01];
  if (_seriesVisible.cost.baseline) activeVals.push(...baseline);
  if (_seriesVisible.cost.grid)     activeVals.push(...grid);
  if (_seriesVisible.cost.net)      activeVals.push(...net);
  const maxVal = Math.max(...activeVals);
  const minVal = Math.min(0, ...(_seriesVisible.cost.net ? net : [0]));

  const valRange = Math.max(0.01, maxVal - minVal);
  const ys = (v) => (h - padB) - ((v - minVal) / valRange) * (h - padT - padB);
  const xs = (i) => padL + (i / Math.max(1, hist.length - 1)) * (w - padL - padR);
  const baseY = ys(0);

  ctx.strokeStyle = 'rgba(35,42,51,.7)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = padT + ((h - padT - padB) * i) / 4;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
    const v = maxVal - (valRange * i) / 4;
    ctx.fillStyle = '#6b7280'; ctx.font = '11px Inter';
    ctx.textAlign = 'right';
    ctx.fillText(fmtMoney(v, cur), padL - 6, y + 3);
  }
  ctx.textAlign = 'start';

  if (minVal < 0) {
    ctx.strokeStyle = 'rgba(255,255,255,.2)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, baseY); ctx.lineTo(w - padR, baseY);
    ctx.stroke();
  }

  if (hist.length >= 2) {
    const first = hist[0].ts || 0, last = hist[hist.length - 1].ts || 0;
    const spanH = (last - first) / 3600;
    const fmtTs = (ts) => {
      const d = new Date(ts * 1000);
      if (spanH > 24) {
        return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
      }
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    };
    const ticks = Math.min(5, hist.length - 1);
    ctx.fillStyle = '#6b7280';
    ctx.textAlign = 'center';
    for (let i = 0; i <= ticks; i++) {
      const idx = Math.floor((hist.length - 1) * (i / ticks));
      const x = xs(idx);
      ctx.fillText(fmtTs(hist[idx].ts), x, h - 8);
    }
    ctx.textAlign = 'start';
  }

  if (_seriesVisible.cost.baseline) {
    drawSmoothLine(ctx, baseline, xs, ys, SERIES_COLORS.baseline, 2);
  }
  if (_seriesVisible.cost.grid) {
    drawSmoothLine(ctx, grid, xs, ys, SERIES_COLORS.grid, 2);
  }
  if (_seriesVisible.cost.net) {
    drawAreaFill(ctx, net, xs, ys, baseY, SERIES_COLORS.net, .18);
    drawSmoothLine(ctx, net, xs, ys, SERIES_COLORS.net, 2.5);
  }

  canvas._redraw = () => drawCostChart(costHistoryCache);
  _attachChartHover(canvas, hist, (i) => {
    const p = hist[i];
    const d = p.ts ? new Date(p.ts * 1000) : null;
    const timeStr = d ? d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
    const netVal = p.net_saved ?? 0;
    return `
      <div class="cht-time">${timeStr}</div>
      <div class="cht-row"><i style="background:${SERIES_COLORS.baseline}"></i> Baseline: <b>${fmtMoney(p.baseline_cost, cur)}</b></div>
      <div class="cht-row"><i style="background:${SERIES_COLORS.grid}"></i> Grid paid: <b>${fmtMoney(p.grid_cost, cur)}</b></div>
      <div class="cht-row"><i style="background:${SERIES_COLORS.net}"></i> Net saved: <b>${netVal >= 0 ? '+' : ''}${fmtMoney(netVal, cur)}</b></div>
      <div class="cht-row" style="color:#6b7280;font-size:10px;margin-top:3px">
        Out: ${(p.output_kwh != null ? p.output_kwh : ((p.output_wh || 0) / 1000)).toFixed(2)} kWh · In: ${(p.grid_kwh != null ? p.grid_kwh : ((p.ac_input_wh || 0) / 1000)).toFixed(2)} kWh
      </div>
    `;
  }, () => ({ xs, padL, padR, w, h, baseY, padT, padB }));
}

async function fetchCostBreakdown(groupBy = costBreakdownGroup) {
  costBreakdownGroup = groupBy;
  const sn = activeJackeryDevice()?.device_sn;
  const url = `/api/cost/breakdown?group_by=${groupBy}&days=1825&mode=${encodeURIComponent(costMode)}` + (sn ? `&device_sn=${encodeURIComponent(sn)}` : '');
  try {
    const r = await fetch(url);
    if (!r.ok) return;
    const j = await r.json();
    costBreakdownCache = j;
    renderCostTable();
  } catch (e) {
    console.warn('cost breakdown fetch failed', e);
  }
}

function _costFilteredRows() {
  const rows = costBreakdownCache?.rows || [];
  const q = costSearchQuery.trim().toLowerCase();
  let filtered = rows;
  if (q) {
    filtered = rows.filter(r => {
      const p = String(r.period || '').toLowerCase();
      const humanP = String(r.label || fmtCostPeriod(r.period, costBreakdownGroup)).toLowerCase();
      return p.includes(q) || humanP.includes(q);
    });
  }
  const { key, dir } = costTableSort;
  const sign = dir === 'asc' ? 1 : -1;
  return filtered.slice().sort((a, b) => {
    if (key === 'period') return sign * String(a.period).localeCompare(String(b.period));
    const av = a[key], bv = b[key];
    const an = (av == null || !Number.isFinite(Number(av))) ? -Infinity : Number(av);
    const bn = (bv == null || !Number.isFinite(Number(bv))) ? -Infinity : Number(bv);
    if (an !== bn) return sign * (an - bn);
    return String(b.period).localeCompare(String(a.period));
  });
}

function renderCostTable() {
  const tbody = $('cost-table-body');
  const emptyEl = $('cost-table-empty');
  if (!tbody) return;
  const cur = costBreakdownCache?.currency || 'USD';
  const rows = _costFilteredRows();

  if (!rows.length) {
    tbody.innerHTML = '';
    if (emptyEl) emptyEl.hidden = false;
    return;
  }
  if (emptyEl) emptyEl.hidden = true;

  const todayStr = new Date().toISOString().slice(0, 10);

  tbody.innerHTML = rows.map(r => {
    const isToday = costBreakdownGroup === 'day' && r.period === todayStr;
    const badge = isToday ? ' <span class="today-badge">today</span>' : '';
    const humanPeriod = r.label || fmtCostPeriod(r.period, costBreakdownGroup);
    const net = r.net_saved ?? 0;
    const netClass = fmtSavingsClass(net);
    const effStr = (r.efficiency_pct != null && Number.isFinite(Number(r.efficiency_pct)))
      ? `${Number(r.efficiency_pct).toFixed(1)}%`
      : '—';

    return `
      <tr>
        <td>${escapeHtml(humanPeriod)}${badge}</td>
        <td class="num">${fmtMoney(r.grid_cost, cur)}</td>
        <td class="num">${fmtMoney(r.solar_cost ?? 0, cur)}</td>
        <td class="num">${fmtMoney(r.baseline_cost, cur)}</td>
        <td class="num ${netClass}">${net >= 0 ? '+' : ''}${fmtMoney(net, cur)}</td>
        <td class="num">${fmtRate(r.avg_buy_rate, cur)}</td>
        <td class="num">${fmtRate(r.avg_use_rate, cur)}</td>
        <td class="num">${effStr}</td>
      </tr>
    `;
  }).join('');
}

function exportCostCsv() {
  if (!costBreakdownCache) return;
  const rows = _costFilteredRows();
  const cols = [
    'period', 'grid_cost', 'solar_cost', 'baseline_cost', 'net_saved',
    'avg_buy_rate', 'avg_use_rate', 'ac_input_kwh', 'output_kwh', 'efficiency_pct'
  ];
  const lines = [cols.join(',')];
  for (const r of rows) {
    lines.push(cols.map(c => (r[c] == null ? '' : String(r[c]))).join(','));
  }
  const sn = String(costBreakdownCache.device_sn || 'device').replace(/[^A-Za-z0-9._-]/g, '_');
  const blob = new Blob([lines.join('\n') + '\n'], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `cost-breakdown-${costBreakdownGroup}-${sn}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function initCostTab() {
  updateCostModeUI();

  document.querySelectorAll('.cost-mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode;
      if (mode && mode !== costMode) {
        costMode = mode;
        localStorage.setItem('jackery_cost_mode', costMode);
        updateCostModeUI();
        loadCostTab();
      }
    });
  });

  document.querySelectorAll('.cost-dist-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.cost-dist-btn').forEach(b => b.classList.remove('on'));
      btn.classList.add('on');
      fetchCostDistribution(parseInt(btn.dataset.days, 10) || 30);
    });
  });

  document.querySelectorAll('.cost-range-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.cost-range-btn').forEach(b => b.classList.remove('on'));
      btn.classList.add('on');
      fetchCostHistory(parseInt(btn.dataset.hours, 10) || 24);
    });
  });

  document.querySelectorAll('.cbreakdown-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.cbreakdown-btn').forEach(b => b.classList.remove('on'));
      btn.classList.add('on');
      fetchCostBreakdown(btn.dataset.group || 'day');
    });
  });

  $('cost-search')?.addEventListener('input', (e) => {
    costSearchQuery = e.target.value || '';
    renderCostTable();
  });

  $('cost-export')?.addEventListener('click', exportCostCsv);

  document.querySelectorAll('.cost-table th.sortable').forEach(th => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (!key) return;
      if (costTableSort.key === key) {
        costTableSort.dir = costTableSort.dir === 'asc' ? 'desc' : 'asc';
      } else {
        costTableSort = { key, dir: 'desc' };
      }
      document.querySelectorAll('.cost-table th.sortable').forEach(t => {
        t.classList.toggle('sort-asc', t === th && costTableSort.dir === 'asc');
        t.classList.toggle('sort-desc', t === th && costTableSort.dir === 'desc');
      });
      renderCostTable();
    });
  });
}

function loadCostTab() {
  fetchCostSummary();
  fetchCostDistribution(costDistDays);
  fetchCostHistory(costRangeHours);
  fetchCostBreakdown(costBreakdownGroup);
}

// ============================================================
// FORECAST TAB
// ============================================================
async function fetchForecast() {
  const needsConfig = $('forecast-needs-config');
  const content     = $('forecast-content');
  const stats       = $('forecast-stats');
  const heading     = needsConfig.querySelector('h2');
  const body        = needsConfig.querySelector('p');
  const showNeedsConfig = (h, p) => {
    needsConfig.hidden = false;
    content.hidden = true;
    stats.hidden = true;
    if (h) heading.textContent = h;
    if (p) body.textContent = p;
  };
  try {
    // Forecast is per-device — pass the currently-viewed Jackery's SN so
    // the Forecast tab follows the per-browser picker.
    const sn = activeJackeryDevice()?.device_sn;
    const url = sn ? `/api/forecast?device_sn=${encodeURIComponent(sn)}` : '/api/forecast';
    const r = await fetch(url);
    if (!r.ok) { showNeedsConfig(); return; }
    const j = await r.json();
    if (!j.configured) {
      showNeedsConfig('Allow location to enable forecasts',
        'The forecaster needs your approximate location to know which weather to fetch. Click below to share it.');
      return;
    }
    if (j.error) {
      const detail = j.error_detail
        ? `The forecast needs weather data and can't reach the weather service right now (${j.error_detail}). It refreshes automatically once the connection is restored.`
        : body.textContent;
      showNeedsConfig(j.error, detail);
      return;
    }
    if (j.ready === false) {
      const r = j.readiness || {};
      const haveH = r.have_hours ?? 0, needH = r.needed_hours ?? 24;
      const haveW = r.have_idle_windows ?? 0, needW = r.needed_idle_windows ?? 5;
      showNeedsConfig(
        'Forecaster is calibrating',
        `Need ${needH}h of history (${haveH}h captured) and ` +
        `${needW} clean discharge windows (${haveW} so far). ` +
        `Once enough data accumulates, the forecast will appear here ` +
        `automatically — no action required.`
      );
      return;
    }
    needsConfig.hidden = true;
    content.hidden = false;
    stats.hidden = false;
    forecastCache = j;
    // Show the location these forecasts are based on. Async, fires its
    // own /api/location request — doesn't block the chart render.
    refreshForecastCurrentLoc();
    const setText = (id, v, d = 0) => { const el = $(id); if (el) el.textContent = fmt(v, d); };
    const dev = activeJackeryDevice();
    const title = $('forecast-title');
    if (title) {
      const base = dev?.name
        ? `${dev.name} — next 5 days`
        : 'State of charge — next 5 days';
      // Note the fallback when the live weather API is down: either the
      // real last-good stored forecast, or (cold start) a recent-average
      // climatology.
      const wxNote = j.weather_synthetic
        ? ' · ⚠ recent-average solar (weather service offline)'
        : j.weather_stale
          ? ' · ⚠ last-good forecast (weather service offline)'
          : '';
      title.textContent = base + wxNote;
    }
    setText('forecast-capacity', j.capacity_wh);
    setText('forecast-coeff',    j.solar_coefficient, 2);
    setText('forecast-avg-load', j.overall_load_w);
    const sub = $('forecast-coeff-sub');
    if (sub) {
      const minFit = 2;
      if (j.solar_coefficient === 0) {
        sub.textContent = 'no solar production detected on this device';
      } else if (j.fit_samples >= minFit) {
        sub.textContent = `learned from ${j.fit_samples} hourly samples`;
      } else {
        const need = Math.max(1, minFit - j.fit_samples);
        sub.textContent = `default — need ${need} more daylight hours of data to fit`;
      }
    }
    drawForecastChart(j);
    // Per-day strip above the chart — 5 compact tiles, one per day
    // in the forecast window. Same data, no extra fetch.
    renderForecastDayStrip(j);
    // Today's energy budget breakdown — same data as the chart, but
    // walks the simulator math from now to sunset so the user can
    // verify how SOC_now becomes SOC_sunset. Pure transform of `j`,
    // no extra fetch.
    renderTodayEnergyBudget(j);
    // Daily sunset/sunrise pred-vs-actual table + MAE summary. Independent
    // of the main forecast — own /api/daily_summary fetch with a user-
    // controlled window. Render is fire-and-forget; failures shouldn't
    // block the rest of the Forecast tab.
    renderDailyAccuracy().catch((err) =>
      console.warn('daily accuracy render failed', err));
  } catch (e) { console.warn('forecast fetch failed', e); }
}

// ============================================================
// Per-day strip above the forecast chart — one compact tile per
// day in the ~5-day forecast window. Headline numbers only
// (start→end SOC + solar kWh), with color + ⚠ marker when SOC
// bottoms at 0. Pure transform of /api/forecast.
// ============================================================
function renderForecastDayStrip(j) {
  const strip = $('forecast-day-strip');
  if (!strip) return;
  const fc = j?.forecast || [];
  if (!fc.length || !j.ready) {
    strip.innerHTML = '';
    strip.hidden = true;
    return;
  }
  // Group hours by local-date string. Browser timezone is what the
  // user sees on the chart x-axis, so it matches their mental model.
  const days = [];
  let currentKey = null;
  let current = null;
  for (const h of fc) {
    const d = new Date(h.ts * 1000);
    const key = d.toDateString(); // "Wed May 06 2026"
    if (key !== currentKey) {
      if (current) days.push(current);
      currentKey = key;
      current = {
        key,
        date: d,
        hours: [],
        solarWh: 0,
        minSoc: Infinity,
        maxSoc: -Infinity,
        depleted: false,
      };
    }
    current.hours.push(h);
    current.solarWh += Number(h.solar_w ?? 0);
    if (h.predicted_soc != null) {
      const s = Number(h.predicted_soc);
      if (s < current.minSoc) current.minSoc = s;
      if (s > current.maxSoc) current.maxSoc = s;
      // The simulator clamps at 0 (hard floor), so any predicted_soc
      // <= 0.5 means we ran out — flag it.
      if (s <= 0.5) current.depleted = true;
    }
  }
  if (current) days.push(current);

  // For start_soc on each day: day 0 starts at j.starting_soc_pct
  // (NOW); subsequent days inherit the previous day's end. End_soc =
  // last hour's predicted_soc (clamped to 0+).
  let prevEnd = Number(j.starting_soc_pct ?? 0);
  for (const d of days) {
    d.startSoc = prevEnd;
    const lastSoc = d.hours[d.hours.length - 1]?.predicted_soc;
    d.endSoc = lastSoc != null ? Number(lastSoc) : prevEnd;
    prevEnd = d.endSoc;
    // Sunset SOC: predicted_soc at the LAST hour with solar > 0 for
    // this day. Matches the hero "At sunset" card's calc (renderEodPill)
    // so the two surfaces show identical numbers on overlapping days.
    // Sunrise SOC: predicted_soc at the LAST dark hour BEFORE the
    // first daylight hour — the overnight low (matches hero's
    // "At sunrise" calc). Null on days where the corresponding
    // transition isn't in the window (e.g. today's tile, where
    // sunrise already happened before "now" and isn't in fc).
    let sunsetSoc = null;
    let sunriseSoc = null;
    let firstDaylightIdx = -1;
    for (let k = 0; k < d.hours.length; k++) {
      const h = d.hours[k];
      const isDay = (h.solar_w || 0) > 0;
      if (isDay && firstDaylightIdx === -1) firstDaylightIdx = k;
      if (isDay && h.predicted_soc != null) sunsetSoc = Number(h.predicted_soc);
    }
    // Sunrise = SOC at the dark hour just before the first daylight
    // hour. Skip if the day starts already in daylight (e.g. today's
    // forecast that begins mid-afternoon).
    if (firstDaylightIdx > 0) {
      const prev = d.hours[firstDaylightIdx - 1];
      if (prev?.predicted_soc != null) sunriseSoc = Number(prev.predicted_soc);
    }
    d.sunsetSoc = sunsetSoc;
    d.sunriseSoc = sunriseSoc;
  }

  // For the FIRST tile (Today), the forecast only contains hours from
  // now forward — morning solar that already happened isn't in `fc`.
  // Add today's actual solar_wh so far (from the samples table, surfaced
  // as `today_actual_solar_wh` on the response) so the "Today" label
  // reflects the FULL day's total, not just the remaining hours. Other
  // tiles stay forecast-only.
  if (days.length > 0) {
    const todayActualWh = Number(j?.today_actual_solar_wh ?? 0);
    if (todayActualWh > 0) days[0].solarWh += todayActualWh;
  }

  // Cap to the visible 5-day window. The forecaster returns ~5d so
  // this is usually a no-op; defensive against backend changes.
  const visible = days.slice(0, 5);
  if (!visible.length) {
    strip.innerHTML = '';
    strip.hidden = true;
    return;
  }
  strip.hidden = false;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const labelFor = (d) => {
    const dayStart = new Date(d.date);
    dayStart.setHours(0, 0, 0, 0);
    const diffDays = Math.round((dayStart - today) / 86400000);
    if (diffDays === 0) return 'Today';
    if (diffDays === 1) return 'Tomorrow';
    return d.date.toLocaleDateString([], {weekday: 'short', month: 'numeric', day: 'numeric'});
  };
  // Tile color: green when SOC stays >=20 all day, amber when min
  // dips into 10-19, red+⚠ when depleted. minSoc could be Infinity
  // if there were zero predicted_soc values — treat as unknown.
  const classFor = (d) => {
    if (d.depleted) return 'tile-bad';
    if (d.minSoc === Infinity) return '';
    if (d.minSoc < 20) return 'tile-warn';
    return 'tile-good';
  };

  strip.innerHTML = visible.map((d) => {
    const cls = classFor(d);
    const warnLine = d.depleted
      ? '<span class="fdt-warn">⚠ depleted</span>'
      : '';
    // Build the SOC trajectory as labeled points. The today tile
    // (first in strip) extends through midnight to also show
    // tomorrow's sunrise (overnight low), so the user can see both
    // ends of the night in one place. Other tiles show the full
    // daily arc within their own window. Rendered as a label-above-
    // value grid so each point fits compactly without wrapping —
    // an inline "78% → SUNSET 100% → MIDNIGHT 90% → SUNRISE 73%"
    // line was overflowing the 5-up tile width.
    const tileIdx = visible.indexOf(d);
    const isFirst = tileIdx === 0;
    const nextSunriseSoc = isFirst && visible[1]?.sunriseSoc != null
      ? Number(visible[1].sunriseSoc) : null;

    const points = [];
    points.push({ label: isFirst ? 'now' : 'midnight', value: d.startSoc });
    if (d.sunriseSoc != null && Math.abs(d.startSoc - d.sunriseSoc) > 2) {
      points.push({ label: 'sunrise', value: d.sunriseSoc });
    }
    const lastShown = points[points.length - 1].value;
    if (d.sunsetSoc != null
        && Math.abs(d.sunsetSoc - lastShown) > 2
        && Math.abs(d.sunsetSoc - d.endSoc) > 2) {
      points.push({ label: 'sunset', value: d.sunsetSoc });
    }
    points.push({ label: 'midnight', value: d.endSoc });
    if (nextSunriseSoc != null) {
      points.push({ label: 'sunrise', value: nextSunriseSoc });
    }

    const arc = points.map((p) => `
      <div class="fdt-pt">
        <span class="fdt-pt-label">${p.label}</span>
        <span class="fdt-pt-value">${Math.round(p.value)}<small>%</small></span>
      </div>
    `).join('');

    return `<div class="forecast-day-tile ${cls}">
      <span class="fdt-label">${labelFor(d)}</span>
      <div class="fdt-arc">${arc}</div>
      <span class="fdt-solar">${(d.solarWh / 1000).toFixed(1)} kWh ↑</span>
      ${warnLine}
    </div>`;
  }).join('');
}

// ============================================================
// Today's energy budget — narrative breakdown of the forecast.
// Walks from now to the last solar hour, summing solar + load,
// and replaying the simulator's per-hour math (charge_efficiency
// applied only to net-positive hours). load_w in the forecast
// already includes parasitic + inverter overhead.
// ============================================================
function renderTodayEnergyBudget(j) {
  const card = $('today-budget-card');
  if (!card) return;
  const fc = j?.forecast || [];
  const empty = $('today-budget-empty');
  const table = $('today-budget-table');
  const summary = $('today-budget-summary');
  if (!fc.length || !j.ready) {
    card.hidden = false;
    if (empty) empty.hidden = false;
    if (table) table.hidden = true;
    if (summary) summary.textContent = '—';
    return;
  }
  // Find the window from now to the last solar hour. fc[0] is the
  // first hour ahead. Walk to the first non-solar hour after dawn;
  // the index just before is the last daylight hour ("sunset" in
  // the EOD-pill sense).
  let i = 0;
  // Skip any leading non-solar (we're in the dark part of today
  // already — happens at night).
  while (i < fc.length && (fc[i].solar_w || 0) <= 0) i++;
  // Walk through the daylight band.
  const dawnIdx = i;
  while (i < fc.length && (fc[i].solar_w || 0) > 0) i++;
  // dawnIdx..i-1 inclusive is today's daylight band.
  if (i <= dawnIdx) {
    card.hidden = false;
    if (empty) empty.hidden = false;
    if (table) table.hidden = true;
    if (summary) summary.textContent = 'After sunset — open tomorrow';
    return;
  }
  // The "starting SOC" for the walk is whatever the simulator was at
  // before the first hour in our window. fc[dawnIdx-1].predicted_soc
  // if there's a prior hour, else j.starting_soc_pct.
  const socStart = dawnIdx > 0
    ? fc[dawnIdx - 1].predicted_soc
    : j.starting_soc_pct;
  const window = fc.slice(dawnIdx, i);
  const eff = Number(j.charge_efficiency ?? 0.85);
  const cap = Number(j.capacity_wh ?? 30240);
  let solarWh = 0;
  let loadWh = 0;
  let storedWh = 0;
  const rows = window.map((h, idx) => {
    const solar = Number(h.solar_w ?? 0);
    const load = Number(h.load_w ?? 0);
    const net = solar - load;
    const effNet = net > 0 ? net * eff : net;
    solarWh += solar;
    loadWh += load;
    storedWh += effNet;
    const dpp = effNet / cap * 100;
    return {
      h: new Date(h.ts * 1000).toLocaleTimeString([], {hour: 'numeric'}),
      solar: Math.round(solar),
      load: Math.round(load),
      net: Math.round(net),
      dpp,
      soc: h.predicted_soc,
    };
  });
  const socEnd = window[window.length - 1].predicted_soc;

  card.hidden = false;
  if (empty) empty.hidden = true;
  if (table) table.hidden = false;

  // Header summary collapsed-state hint: "16 → 40% · 20.2 kWh in"
  if (summary) {
    summary.textContent =
      `${Math.round(socStart)} → ${Math.round(socEnd)}% · `
      + `${(solarWh / 1000).toFixed(1)} kWh solar`;
  }

  const fmt1 = (n) => (Math.round(n * 10) / 10).toFixed(1);
  const setText = (id, txt) => {
    const el = $(id);
    if (el) el.textContent = txt;
  };
  setText('tb-eff', eff.toFixed(2));
  setText('tb-solar-kwh', fmt1(solarWh / 1000));
  setText('tb-solar-sub', `${rows.length} h, peak ${Math.round(Math.max(...rows.map(r => r.solar)))} W`);
  setText('tb-load-kwh', fmt1(loadWh / 1000));
  setText('tb-load-sub', `avg ${Math.round(loadWh / rows.length)} W`);
  setText('tb-net-kwh', fmt1(storedWh / 1000));
  setText('tb-net-sub',
    `${(socEnd - socStart >= 0 ? '+' : '')}${(socEnd - socStart).toFixed(1)} pp `
    + `(loss: ${fmt1((solarWh - loadWh - storedWh) / 1000)} kWh)`);

  const tbody = $('today-budget-tbody');
  if (tbody) {
    tbody.innerHTML = rows.map((r) => {
      const netCls = r.net > 0 ? 'acc-err-good' : (r.net < 0 ? 'acc-err-bad' : '');
      const dppCls = r.dpp >= 0 ? 'acc-err-good' : 'acc-err-bad';
      const sign = (n) => (n > 0 ? '+' : '') + Math.round(n);
      return `<tr>
        <td>${r.h}</td>
        <td>${r.solar}</td>
        <td>${r.load}</td>
        <td class="${netCls}">${sign(r.net)}</td>
        <td class="${dppCls}">${(r.dpp >= 0 ? '+' : '') + r.dpp.toFixed(2)}</td>
        <td>${r.soc.toFixed(1)}</td>
      </tr>`;
    }).join('');
  }
}

// ============================================================
// Daily sunset/sunrise prediction accuracy table on Forecast tab.
// Data source: /api/daily_summary, written each smart-charge tick.
// ============================================================
async function renderDailyAccuracy() {
  const card = $('daily-accuracy-card');
  if (!card) return;
  const sel = $('daily-accuracy-days');
  const days = parseInt(sel?.value || '14', 10) || 14;
  const sn = activeJackeryDevice()?.device_sn;
  const url = sn
    ? `/api/daily_summary?days=${days}&device_sn=${encodeURIComponent(sn)}`
    : `/api/daily_summary?days=${days}`;
  const r = await fetch(url);
  if (!r.ok) { card.hidden = true; return; }
  const j = await r.json();
  const rows = j.rows || [];
  card.hidden = false;
  const tbody = $('daily-accuracy-tbody');
  const table = $('daily-accuracy-table');
  const empty = $('daily-accuracy-empty');
  if (!rows.length) {
    if (tbody) tbody.innerHTML = '';
    if (table) table.hidden = true;
    if (empty) empty.hidden = false;
    _renderAccuracySummary([], [], [], []);
    return;
  }
  if (empty) empty.hidden = true;
  if (table) table.hidden = false;

  // Render newest-first. Track sunset/sunrise errors in two buckets:
  // ALL (everything visible) and POST-FIX (predictions_made_at >=
  // cutoff_ts — i.e. made by current code, not stale older code).
  // Stale rows still render so the user can see history; they're
  // visually muted and don't count toward the post-fix MAE headline.
  const cutoffTs = Number(j.cutoff_ts || 0);
  const sorted = [...rows].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const sunsetErrsAll = [];
  const sunriseErrsAll = [];
  const sunsetErrsPostFix = [];
  const sunriseErrsPostFix = [];
  const html = sorted.map((row) => {
    const date = row.date || '—';
    const sp = row.predicted_sunset_soc_pct;
    const sa = row.actual_sunset_soc_pct;
    const rp = row.predicted_sunrise_soc_pct;
    const ra = row.actual_sunrise_soc_pct;
    const sErr = (sp != null && sa != null) ? sa - sp : null;
    const rErr = (rp != null && ra != null) ? ra - rp : null;
    const madeAt = Number(row.predictions_made_at || 0);
    const isPostFix = cutoffTs > 0 && madeAt > 0 && madeAt >= cutoffTs;
    if (sErr != null) {
      sunsetErrsAll.push(sErr);
      if (isPostFix) sunsetErrsPostFix.push(sErr);
    }
    if (rErr != null) {
      sunriseErrsAll.push(rErr);
      if (isPostFix) sunriseErrsPostFix.push(rErr);
    }
    const rowCls = isPostFix ? '' : 'acc-row-stale';
    const staleBadge = isPostFix ? '' : ' <span class="acc-stale-badge" title="Predictions made by older code (before the latest forecaster fix). Excluded from the post-fix MAE.">stale</span>';
    return `<tr class="${rowCls}">
      <td>${date}${staleBadge}</td>
      <td>${_fmtPct(sp)}</td>
      <td>${_fmtPct(sa)}</td>
      ${_fmtErrCell(sErr)}
      <td>${_fmtPct(rp)}</td>
      <td>${_fmtPct(ra)}</td>
      ${_fmtErrCell(rErr)}
    </tr>`;
  }).join('');
  if (tbody) tbody.innerHTML = html;
  _renderAccuracySummary(
    sunsetErrsAll, sunriseErrsAll,
    sunsetErrsPostFix, sunriseErrsPostFix,
  );
}

function _fmtPct(v) {
  return (v == null) ? '<span class="acc-missing">—</span>' : `${Math.round(v)}%`;
}

function _fmtErrCell(err) {
  if (err == null) return '<td class="acc-missing">—</td>';
  const abs = Math.abs(err);
  const cls = abs <= 3 ? 'acc-err-good' : abs <= 8 ? 'acc-err-warn' : 'acc-err-bad';
  const sign = err > 0 ? '+' : '';
  return `<td class="${cls}">${sign}${err.toFixed(1)}</td>`;
}

function _renderAccuracySummary(sunsetErrsAll, sunriseErrsAll,
                                 sunsetErrsPostFix, sunriseErrsPostFix) {
  const mae = (xs) => xs.length
    ? (xs.reduce((s, x) => s + Math.abs(x), 0) / xs.length).toFixed(1)
    : null;
  const setText = (id, v) => { const el = $(id); if (el) el.textContent = v; };
  // Headline is post-fix when there's any post-fix data; falls back
  // to all-shown when no post-fix samples are available yet (e.g.
  // immediately after a cutoff bump). The subline always shows the
  // alternate count so the user can tell which one they're seeing.
  const hasPostFix = sunsetErrsPostFix.length + sunriseErrsPostFix.length > 0;
  const sunsetErrs = hasPostFix ? sunsetErrsPostFix : sunsetErrsAll;
  const sunriseErrs = hasPostFix ? sunriseErrsPostFix : sunriseErrsAll;
  const scopeNote = hasPostFix ? ' · post-fix' : ' · all (no post-fix yet)';

  const sunsetMae = mae(sunsetErrs);
  const sunriseMae = mae(sunriseErrs);
  setText('daily-acc-sunset-mae', sunsetMae ?? '—');
  setText('daily-acc-sunset-n', sunsetErrs.length
    ? `${sunsetErrs.length} day${sunsetErrs.length === 1 ? '' : 's'} measured${scopeNote}`
    : 'no data');
  setText('daily-acc-sunrise-mae', sunriseMae ?? '—');
  setText('daily-acc-sunrise-n', sunriseErrs.length
    ? `${sunriseErrs.length} day${sunriseErrs.length === 1 ? '' : 's'} measured${scopeNote}`
    : 'no data');
  // Hit rate = share of all measured points (sunset + sunrise) where
  // |error| ≤ 5pp. Single number across both phases gives a quick "is
  // the model basically right" read independent of which phase.
  const all = sunsetErrs.concat(sunriseErrs);
  const hits = all.filter((e) => Math.abs(e) <= 5).length;
  const hitRate = all.length ? Math.round((hits / all.length) * 100) : null;
  setText('daily-acc-hitrate', hitRate ?? '—');
  setText('daily-acc-hitrate-sub', all.length
    ? `${hits} of ${all.length} predictions within 5pp${scopeNote}`
    : 'no data');
}

// Re-render when the user picks a different window. No new server data
// per change — the API call is small and re-running keeps the summary
// in sync with whatever range is active.
$('daily-accuracy-days')?.addEventListener('change', () => {
  renderDailyAccuracy().catch((err) =>
    console.warn('daily accuracy render failed', err));
});

// Run once on app boot: if the server has no location yet AND the user
// hasn't previously denied the prompt in this browser, ask. After any
// denial, set a localStorage flag so we don't pester them on every reload.
// The Forecast tab still has a manual "Use my location" button for retry.
async function maybePromptLocationOnBoot() {
  if (localStorage.getItem('jackery-location-denied') === '1') return;
  try {
    const r = await fetch('/api/location');
    if (!r.ok) return;
    const j = await r.json();
    if (j.latitude != null && j.longitude != null) return; // already set
  } catch { return; }
  const result = await requestAndSaveGeolocation();
  if (result.denied) {
    localStorage.setItem('jackery-location-denied', '1');
  } else if (result.ok) {
    // Location just saved — populate the EOD badge right away rather than
    // waiting for the hourly tick.
    fetchEodForecast();
  }
}

// Trigger the browser geolocation prompt and POST the result to the server.
// Returns {ok, denied}. `denied` is only true when the user explicitly
// rejected the permission (code 1) — transient errors don't count.
async function requestAndSaveGeolocation() {
  const needsConfig = $('forecast-needs-config');
  const heading     = needsConfig?.querySelector('h2');
  const body        = needsConfig?.querySelector('p');
  const setMessage  = (h, p) => {
    if (heading) heading.textContent = h;
    if (body)    body.textContent    = p;
  };

  if (!('geolocation' in navigator)) {
    setMessage('Location is needed to forecast',
      'Your browser does not support geolocation. There is no other way to enable forecasts on this build.');
    return { ok: false, denied: false };
  }
  if (!window.isSecureContext) {
    setMessage('Location is needed to forecast',
      'Browser geolocation only works over HTTPS. Open the dashboard via your HTTPS (Cloudflare) URL and try again.');
    return { ok: false, denied: false };
  }

  const coords = await new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ ok: true, lat: pos.coords.latitude, lon: pos.coords.longitude }),
      (err) => resolve({ ok: false, err }),
      { timeout: 15000, maximumAge: 24 * 3600 * 1000 },
    );
  });

  if (!coords.ok) {
    const code = coords.err?.code;
    const msg = code === 1
      ? 'Location is needed to forecast. You denied the permission — re-allow it in your browser site settings, or click below to try again.'
      : code === 2
      ? 'Could not determine your location. Try again in a moment.'
      : code === 3
      ? 'Location request timed out. Click below to try again.'
      : 'Could not get your location. Click below to try again.';
    setMessage('Location is needed to forecast', msg);
    return { ok: false, denied: code === 1 };
  }

  try {
    const r = await fetch('/api/location', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ latitude: coords.lat, longitude: coords.lon }),
    });
    if (!r.ok) {
      setMessage('Could not save location', `${r.status} ${r.statusText}`);
      return { ok: false, denied: false };
    }
    return { ok: true, denied: false };
  } catch (e) {
    setMessage('Could not save location', e.message || String(e));
    return { ok: false, denied: false };
  }
}

// "Use my location" button — manual retry. Clears the denied flag so the
// user explicitly opting in unsticks any earlier dismissal.
document.addEventListener('click', async (e) => {
  if (e.target?.id !== 'forecast-geo-btn') return;
  localStorage.removeItem('jackery-location-denied');
  const result = await requestAndSaveGeolocation();
  if (result.ok) {
    fetchForecast();
    fetchEodForecast();
  }
});

// Render the "Forecasting for: <city> (lat, lon)" line that sits under
// the Forecast tab title. Reads from /api/location each time so it
// reflects whatever was last persisted (manual override or geolocation).
// Older saves won't have a `label` — we degrade gracefully to coords +
// timezone in that case.
async function refreshForecastCurrentLoc() {
  const el = $('forecast-current-loc');
  if (!el) return;
  try {
    const r = await fetch('/api/location');
    if (!r.ok) { el.textContent = ''; return; }
    const j = await r.json();
    if (j == null || j.latitude == null || j.longitude == null) {
      el.textContent = 'No location set — forecasts unavailable.';
      return;
    }
    const lat = Number(j.latitude).toFixed(4);
    const lon = Number(j.longitude).toFixed(4);
    // Build the inner HTML safely — textContent on each span avoids any
    // injection risk from a maliciously-saved label, while still letting
    // us style "name" vs "coords" differently.
    el.innerHTML = '';
    const prefix = document.createTextNode('Forecasting for: ');
    el.appendChild(prefix);
    if (j.label) {
      const name = document.createElement('span');
      name.className = 'loc-name';
      name.textContent = j.label;
      el.appendChild(name);
      el.appendChild(document.createTextNode(' — '));
    }
    const coords = document.createElement('span');
    coords.className = 'loc-coords';
    coords.textContent = `${lat}, ${lon}`;
    el.appendChild(coords);
    if (j.timezone) {
      el.appendChild(document.createTextNode(` (${j.timezone})`));
    }
  } catch {
    // Silent fail — the line is informational, not blocking.
    el.textContent = '';
  }
}

// ---- Manual location override --------------------------------------------
// Browser geolocation can give bad coords (IP fallback to ISP POP, stale
// Wi-Fi BSSID database entries, VPN, etc). The manual card lets the user
// either type a city name (server geocodes via Open-Meteo) or paste raw
// lat/lon. Both paths POST to /api/location which validates, persists,
// and busts the weather cache so the next forecast pulls fresh.

function _showManualLoc(open) {
  const card = $('forecast-manual-loc');
  if (!card) return;
  card.hidden = !open;
  if (open) {
    // Refresh the "currently using" line each time the card opens.
    fetch('/api/location').then(r => r.json()).then(j => {
      const cur = $('forecast-manual-current');
      if (!cur) return;
      if (j && j.latitude != null && j.longitude != null) {
        cur.textContent = `Currently using ${j.latitude.toFixed(4)}, ${j.longitude.toFixed(4)}` +
                          (j.timezone ? ` (${j.timezone})` : '');
      } else {
        cur.textContent = 'No location saved yet.';
      }
    }).catch(() => {});
    // Focus the city search box for quick typing (only if search mode
    // is the active pane).
    const q = $('manual-loc-q');
    const searchPane = $('manual-loc-search');
    if (q && searchPane && !searchPane.hidden) q.focus();
  }
}

// "Set manually" / "Change location" buttons — open the override card.
document.addEventListener('click', (e) => {
  const id = e.target?.id;
  if (id === 'forecast-manual-btn' || id === 'forecast-change-loc') {
    _showManualLoc(true);
  } else if (id === 'forecast-manual-close') {
    _showManualLoc(false);
  }
});

// Mode radio (search vs coords).
document.addEventListener('change', (e) => {
  if (e.target?.name !== 'manual-loc-mode') return;
  const mode = e.target.value;
  const search = $('manual-loc-search');
  const coords = $('manual-loc-coords');
  if (search) search.hidden = mode !== 'search';
  if (coords) coords.hidden = mode !== 'coords';
});

// Debounced city search. Open-Meteo's geocoding is fast (<200ms), but
// we still want to coalesce keystrokes so we don't fire on every letter.
let _manualLocSearchTimer = null;
let _manualLocLastQ = '';
document.addEventListener('input', (e) => {
  if (e.target?.id !== 'manual-loc-q') return;
  const q = e.target.value.trim();
  if (_manualLocSearchTimer) clearTimeout(_manualLocSearchTimer);
  if (q.length < 2) {
    // Clear results and the hint when the field is effectively empty —
    // a stale 1-char result list is worse than nothing.
    const ul = $('manual-loc-results');
    if (ul) ul.innerHTML = '';
    const hint = $('manual-loc-search-hint');
    if (hint) { hint.textContent = ''; hint.dataset.kind = ''; }
    _manualLocLastQ = '';
    return;
  }
  _manualLocSearchTimer = setTimeout(() => _runManualLocSearch(q), 350);
});

async function _runManualLocSearch(q) {
  if (q === _manualLocLastQ) return;
  _manualLocLastQ = q;
  const ul = $('manual-loc-results');
  const hint = $('manual-loc-search-hint');
  if (!ul) return;
  if (hint) { hint.textContent = 'Searching…'; hint.dataset.kind = ''; }
  try {
    const r = await fetch('/api/location/geocode?q=' + encodeURIComponent(q) + '&count=8');
    const j = await r.json();
    // Race-guard: if the user kept typing while this request was in
    // flight, drop the stale response.
    if (q !== _manualLocLastQ) return;
    ul.innerHTML = '';
    const results = (j && j.results) || [];
    if (!results.length) {
      if (hint) { hint.textContent = 'No matches. Try a different spelling, or switch to coordinates.'; hint.dataset.kind = ''; }
      return;
    }
    if (hint) { hint.textContent = `${results.length} match${results.length === 1 ? '' : 'es'} — click to use.`; hint.dataset.kind = ''; }
    for (const item of results) {
      const li = document.createElement('li');
      const meta = [item.admin1, item.country].filter(Boolean).join(', ');
      li.innerHTML = `<span class="loc-name"></span><span class="loc-meta"></span>`;
      li.querySelector('.loc-name').textContent = item.name || '(unnamed)';
      li.querySelector('.loc-meta').textContent =
        (meta ? meta + ' — ' : '') +
        `${item.latitude.toFixed(4)}, ${item.longitude.toFixed(4)}` +
        (item.timezone ? ` · ${item.timezone}` : '');
      // Build a richer label from the geocoder fields so the Forecast
      // tab shows "San Jose, California, US" instead of bare "San Jose".
      const richLabel = [item.name, item.admin1, item.country]
        .filter(Boolean).join(', ');
      li.addEventListener('click', () => _saveManualLocation(item.latitude, item.longitude, richLabel));
      ul.appendChild(li);
    }
  } catch (err) {
    if (hint) { hint.textContent = 'Search failed: ' + (err.message || err); hint.dataset.kind = 'err'; }
  }
}

// Coords-mode save button.
document.addEventListener('click', async (e) => {
  if (e.target?.id !== 'manual-loc-save-coords') return;
  const lat = parseFloat($('manual-loc-lat')?.value);
  const lon = parseFloat($('manual-loc-lon')?.value);
  const hint = $('manual-loc-coords-hint');
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    if (hint) { hint.textContent = 'Enter both latitude and longitude.'; hint.dataset.kind = 'err'; }
    return;
  }
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    if (hint) { hint.textContent = 'Coordinates out of range.'; hint.dataset.kind = 'err'; }
    return;
  }
  await _saveManualLocation(lat, lon, null, { hintEl: hint });
});

// Common save path used by both modes. POSTs to /api/location, refreshes
// the forecast on success, hides the card.
async function _saveManualLocation(lat, lon, label, opts) {
  opts = opts || {};
  const hintEl = opts.hintEl || $('manual-loc-search-hint');
  if (hintEl) { hintEl.textContent = 'Saving…'; hintEl.dataset.kind = ''; }
  // Forget any earlier "denied geolocation" stickiness — user has
  // explicitly chosen a location now, the boot prompt should stay quiet.
  localStorage.setItem('jackery-location-denied', '1');
  try {
    const r = await fetch('/api/location', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // Forward the optional label so the server can persist it for
      // the "Forecasting for: <city>" line. Coords-only saves leave
      // it null and the UI falls back to displaying just coords.
      body: JSON.stringify({ latitude: lat, longitude: lon, label: label || null }),
    });
    let j = {};
    try { j = await r.json(); } catch (_) {}
    if (!r.ok) {
      const msg = j.error || j.detail || `HTTP ${r.status}`;
      if (hintEl) { hintEl.textContent = 'Failed: ' + msg; hintEl.dataset.kind = 'err'; }
      return;
    }
    if (hintEl) {
      hintEl.textContent = label
        ? `Saved: ${label} (${lat.toFixed(4)}, ${lon.toFixed(4)})`
        : `Saved: ${lat.toFixed(4)}, ${lon.toFixed(4)}`;
      hintEl.dataset.kind = 'ok';
    }
    // Hide the manual card and refresh dependent UI — the server has
    // already busted the weather cache, so the next forecast call will
    // pull fresh GHI for the new coords.
    setTimeout(() => _showManualLoc(false), 800);
    fetchForecast();
    fetchEodForecast();
    // Update the "Forecasting for: …" line immediately so the user sees
    // the new place name before fetchForecast() finishes its round-trip.
    refreshForecastCurrentLoc();
  } catch (err) {
    if (hintEl) { hintEl.textContent = 'Save failed: ' + (err.message || err); hintEl.dataset.kind = 'err'; }
  }
}

// EOD-pill: predicted SOC at the next sun phase boundary.
//   • During daytime (solar > 0 right now)  → "At sunset" — the SOC at
//     the last daylight hour today (just before solar drops to 0).
//   • During nighttime (solar = 0 right now) → "At sunrise" — the SOC at
//     the last dark hour tonight (just before solar returns).
// Refit every 30 min via setInterval, OR opportunistically when the live
// telemetry shows the actual SOC has drifted >1pp from the value the
// last forecast was anchored on. Drift refits are rate-limited to 5 min
// minimum spacing so we don't hammer /api/forecast on every WS tick.
let _eodAnchorSOC = null;
let _eodLastFetchAt = 0;
const EOD_DRIFT_THRESHOLD_PCT = 1.0;
const EOD_MIN_REFRESH_INTERVAL_MS = 5 * 60_000;

async function fetchEodForecast() {
  const el = $('eod-forecast');
  if (!el) return;
  _eodLastFetchAt = Date.now();

  // Helper: surface the "still calibrating" state with progress hints
  // instead of silently hiding. The forecast tab has the same info; this
  // saves the user a tab switch to find out why the hero number is
  // missing for a freshly-added device.
  const showCalibrating = (readiness) => {
    const r = readiness || {};
    const haveH = Math.round(r.have_hours ?? 0);
    const needH = r.needed_hours ?? 24;
    const haveW = r.have_idle_windows ?? 0;
    const needW = r.needed_idle_windows ?? 5;
    el.classList.remove('eod-pair');  // drop the two-column layout if it was on
    const labelEl = el.querySelector('.eod-label');
    if (labelEl) labelEl.textContent = 'Calibrating';
    const pct = $('eod-pct');
    const trend = $('eod-trend');
    if (trend) { trend.hidden = false; trend.textContent = ''; trend.classList.remove('up', 'down'); }
    // Reuse #eod-pct as the message slot — keeps the layout stable.
    if (pct) pct.textContent = `${haveH}/${needH} h · ${haveW}/${needW} cycles`;
    el.classList.remove('low');
    el.classList.add('calibrating');
    el.title = 'Forecaster needs more history before it can predict this device. '
      + `Need ${needH}h of samples (${haveH}h captured) and ${needW} clean discharge windows (${haveW} so far).`;
    el.hidden = false;
  };

  try {
    // Forecast is per-device — pass the currently-viewed Jackery's SN so
    // the hero card's prediction follows the picker (each browser may be
    // viewing a different device).
    const sn = activeJackeryDevice()?.device_sn;
    const url = sn ? `/api/forecast?device_sn=${encodeURIComponent(sn)}` : '/api/forecast';
    const r = await fetch(url);
    if (!r.ok) { el.hidden = true; return; }
    const j = await r.json();
    if (!j.configured || j.error) { el.hidden = true; return; }
    // Readiness gate failed — show progress instead of hiding.
    if (j.ready === false) { showCalibrating(j.readiness); return; }
    if (!Array.isArray(j.forecast) || !j.forecast.length) {
      el.hidden = true;
      return;
    }
    // Ready path — clear any prior calibrating styling.
    el.classList.remove('calibrating');
    const fc = j.forecast;
    // The first forecast hour represents "now-ish"; its solar tells us
    // whether we're currently in daylight or darkness.
    const isDayNow = (fc[0]?.solar_w || 0) > 0;
    let i = 0;
    let label;
    if (isDayNow) {
      // Walk forward to the first night hour. fc[i-1] is the last
      // daylight hour = SOC at sunset.
      while (i < fc.length && (fc[i].solar_w || 0) > 0) i++;
      label = 'At sunset';
    } else {
      // Walk forward to the next daylight hour. fc[i-1] is the last
      // dark hour = SOC at sunrise (overnight low).
      while (i < fc.length && (fc[i].solar_w || 0) <= 0) i++;
      label = 'At sunrise';
    }
    if (i === 0 || i >= fc.length) {
      el.hidden = true;
      return;
    }
    const best = fc[i - 1];
    if (best.predicted_soc == null) {
      el.hidden = true;
      return;
    }
    const labelEl = el.querySelector('.eod-label');
    const pct = $('eod-pct');
    const trend = $('eod-trend');
    const start = j.starting_soc_pct ?? best.predicted_soc;
    _eodAnchorSOC = start;
    const sunsetVal = Math.round(best.predicted_soc);

    // During daytime, also surface the PEAK SOC over today's remaining
    // daylight. With afternoon shade the battery can crest mid-afternoon
    // then drain through the shaded evening (solar < house load), so the
    // last-daylight-hour value ("sunset") alone reads flat/low and hides
    // the high-water mark. Show "Peak X% · sunset Y%" when they diverge;
    // fall back to the single sunset value when they don't (no shade, or
    // SOC still rising into dusk — then peak ≈ sunset).
    let peakVal = sunsetVal;
    if (isDayNow) {
      let pk = -Infinity;
      for (let d = 0; d < i; d++) {
        if (fc[d].predicted_soc != null) pk = Math.max(pk, fc[d].predicted_soc);
      }
      if (isFinite(pk)) peakVal = Math.round(pk);
    }
    // Only frame as "Peak · sunset" when the battery will actually climb
    // ABOVE where it is now (a real peak still ahead) AND then decline to
    // a lower sunset. In the evening the day's real peak is already past
    // and only the shaded-evening decline remains, so the max over
    // remaining daylight sits at/below current SOC — showing "Peak 66%"
    // when you're at 68% is nonsensical. There, fall back to the single
    // "At sunset" (declining) value.
    const showBoth = isDayNow
      && peakVal > Math.round(start)
      && peakVal > sunsetVal + 1;

    const trailingPct = el.querySelector('.eod-row > small');
    const delta = best.predicted_soc - start;
    if (showBoth) {
      // Two-column aligned layout: the label and the value row both
      // become full-width 3-col grids (value · value) via the `eod-pair`
      // class, so "Peak" sits over the peak number and "sunset" over the
      // sunset number with the dots lined up. The trend arrow is dropped
      // here — it would offset column 1 and the peak·sunset already shows
      // the day's direction. Each number carries its own <small>%</small>
      // so the percent signs match (.eod-row small is a descendant rule).
      el.classList.add('eod-pair');
      if (trailingPct) trailingPct.hidden = true;
      if (trend) trend.hidden = true;
      if (labelEl) labelEl.innerHTML =
        '<span>Peak</span><span class="eod-dot">·</span><span>sunset</span>';
      pct.innerHTML =
        `<span>${peakVal}<small>%</small></span>`
        + '<span class="eod-dot">·</span>'
        + `<span>${sunsetVal}<small>%</small></span>`;
      el.title = `Battery peaks ~${peakVal}% today, then the shaded evening `
        + `(solar below house load) drains it to ~${sunsetVal}% by sunset. `
        + `Refits every 30 min and on live SOC drift.`;
    } else {
      // Single value (no afternoon decline, or nighttime "At sunrise").
      // The fixed trailing <small>%</small> completes the number.
      el.classList.remove('eod-pair');
      if (trailingPct) trailingPct.hidden = false;
      if (labelEl) labelEl.textContent = label;
      pct.textContent = `${sunsetVal}`;
      el.title = 'Predicted state of charge at the next sun-phase boundary '
        + '(sunset during the day, sunrise at night). Refits every 30 min '
        + 'and on live SOC drift.';
      // Trend arrow reflects the NET direction (target vs now).
      if (trend) {
        trend.hidden = false;
        trend.classList.remove('up', 'down');
        if (Math.abs(delta) < 1) {
          trend.textContent = '→';
        } else if (delta > 0) {
          trend.textContent = '↗';
          trend.classList.add('up');
        } else {
          trend.textContent = '↘';
          trend.classList.add('down');
        }
      }
    }
    // "Low" warning keys off the true end-of-day (sunset) value — that's
    // the trough that matters for "will I have enough overnight".
    const threshold = j.low_battery_threshold || 20;
    el.classList.toggle('low', best.predicted_soc < threshold);
    el.hidden = false;
  } catch (e) {
    console.warn('EOD forecast fetch failed:', e);
  }
}

// ---- Per-expansion-battery list ----
// Fetches /api/devices/battery_packs and renders one row per attached
// pack plus a "Main" row showing the host unit's actual SOC (the value
// the cloud reports as `battery_percent` on /v1/device/property).
//
// The State of Charge card shows the *combined* system SOC, computed
// here and stashed on window for applyStatus to pick up:
//   system_pct = (main_pct × main_wh + Σ pack_pct × pack_wh) / total_wh
// 5000 Plus expansion packs are 5040 Wh — same as the main unit.
// (The smaller 2042 Wh packs are for the older 1500/2000 series.)
const PACK_NOMINAL_WH = 5040;       // 5000 Plus Battery Pack 5040
const MAIN_DEFAULT_WH = 5040;       // 5000 Plus internal

function computeSystemSoc(mainPct, packs, mainWh) {
  if (mainPct == null || !packs.length || !mainWh) return null;
  const totalWh = mainWh + packs.length * PACK_NOMINAL_WH;
  let stored = mainPct * mainWh / 100;
  for (const p of packs) {
    if (p.rb != null) stored += p.rb * PACK_NOMINAL_WH / 100;
  }
  const pct = (stored / totalWh) * 100;
  if (!Number.isFinite(pct)) return null;
  return Math.max(0, Math.min(100, pct));
}

function packRow({ idx, soc, flow, flowClass, temp, label, snTitle, isMain,
                   needUpgrade }) {
  const cls = isMain ? 'pack-row pack-row-main' : 'pack-row';
  const socTxt = soc != null ? Math.round(soc) : '—';
  // Firmware-update-available badge (per-pack `needUpgrade` from the
  // cloud). Yellow accent + Space Mono to match the deck style; inline
  // so it needs no stylesheet change.
  const fwBadge = needUpgrade
    ? ' <span class="pack-fw" title="Firmware update available in the Jackery app"'
      + ' style="color:#EAF044;font:600 9px/1 \'Space Mono\',monospace;'
      + 'letter-spacing:.5px;border:1px solid #EAF044;border-radius:3px;'
      + 'padding:1px 3px;vertical-align:middle">UPD</span>'
    : '';
  return `
    <div class="${cls}">
      <span class="pack-idx">${idx}</span>
      <span class="pack-bar"><span class="pack-bar-fill" style="width:${Math.max(0, Math.min(100, soc || 0))}%"></span></span>
      <span class="pack-soc">${socTxt}<small>%</small></span>
      <span class="pack-flow ${flowClass}">${flow}</span>
      <span class="pack-temp">${temp}</span>
      <span class="pack-sn" title="${snTitle}">${label}${fwBadge}</span>
    </div>`;
}

async function fetchBatteryPacks() {
  const card = $('battery-packs-card');
  if (!card) return;
  try {
    const viewSn = activeJackeryDevice()?.device_sn;
    const r = await fetch('/api/devices/battery_packs'
      + (viewSn ? `?device_sn=${encodeURIComponent(viewSn)}` : ''));
    const j = r.ok ? await r.json() : { error: `HTTP ${r.status}` };
    // A switch may have happened while this was in flight — discard
    // rather than repaint the previous unit's packs.
    const nowSn = activeJackeryDevice()?.device_sn;
    if (viewSn && nowSn && viewSn !== nowSn) return;
    console.debug('battery_packs response', j);
    window._cachedPacks = Array.isArray(j.packs) ? j.packs : [];
    window._cachedPackDeviceSn = j.device_sn || null;
    window._cachedPacksMainSoc = j.main_soc_pct ?? null;
    window._cachedPacksError = j.error || null;
    window._cachedNoPacks = j.no_packs === true;
    renderBatteryPacks();
  } catch (e) {
    console.warn('battery packs fetch failed:', e);
    window._cachedPacksError = String(e);
    renderBatteryPacks();
  }
}

// Pure renderer for the Battery packs card. Uses whatever's in cache
// plus the live WS SOC if available. Idempotent and re-runnable any
// time inputs change — wire it from applyStatus() so the Main row
// paints as soon as the first WS tick lands instead of waiting for
// the next 30s pack-fetch interval.
function renderBatteryPacks() {
  const card = $('battery-packs-card');
  const list = $('battery-packs-list');
  const summary = $('battery-packs-summary');
  if (!card || !list) return;

  const packs = window._cachedPacks || [];
  const err = window._cachedPacksError;
  const isNoPackDevice = window._cachedNoPacks === true;

  // Device with no expansion packs (e.g. HomePower 3000): hide the
  // card cleanly and clear any system-SOC overlay so the SOC card
  // shows the main reading directly. Temp segment visibility is
  // managed centrally in applyStatus().
  if (isNoPackDevice && !packs.length && !err) {
    window._systemSoc = null;
    window._mainSoc = null;
    card.hidden = true;
    return;
  }

  if (!packs.length) {
    if (err) {
      summary.textContent = `error: ${err}`;
      list.innerHTML = '';
      card.hidden = false;
    } else {
      card.hidden = true;
    }
    return;
  }

  const mainPct =
    window._lastStatus?.battery_percent ??
    window._cachedPacksMainSoc ??
    null;
  const mainTempC = window._lastStatus?.battery_temp_c ?? null;
  const mainWh = window._capacityOverrideWh || MAIN_DEFAULT_WH;
  const systemSoc = computeSystemSoc(mainPct, packs, mainWh);
  window._mainWh = mainWh;
  window._systemSoc = systemSoc;
  window._mainSoc = mainPct;
  applySystemSocOverlay();


  const totalIn = packs.reduce((s, p) => s + (p.ip || 0), 0);
  const avgPack = packs.reduce((s, p) => s + (p.rb || 0), 0) / packs.length;
  const sysTxt = systemSoc != null ? ` · system ${Math.round(systemSoc)}%` : '';
  const upgrades = packs.filter(p => p.needUpgrade).length;
  const upgTxt = upgrades ? ` · ⬆ ${upgrades} update${upgrades > 1 ? 's' : ''}` : '';
  summary.textContent = `${packs.length} packs · avg ${Math.round(avgPack)}%${sysTxt} · ${totalIn}W in${upgTxt}`;

  const rows = [];
  if (mainPct != null) {
    rows.push(packRow({
      idx: '★',
      soc: mainPct,
      flow: '',
      flowClass: 'flow-idle',
      temp: formatPackTempHtml(mainTempC, 'main'),
      label: 'Main',
      snTitle: 'Host unit (cloud-reported SOC)',
      isMain: true,
    }));
  }
  packs.forEach((p, i) => {
    const sn = String(p.deviceSn || '');
    const ip = p.ip != null ? Math.round(p.ip) : 0;
    const op = p.op != null ? Math.round(p.op) : 0;
    // deviceOrder is the cloud's authoritative pack ordering; some
    // payload paths (older WS broadcasts, the bridge cache when it
    // hasn't seen a fresh /v1/device/property yet) omit it. Fall
    // back to the array index so the user sees 1..N instead of every
    // row labeled "1".
    const order = (typeof p.deviceOrder === 'number') ? p.deviceOrder : i;
    rows.push(packRow({
      idx: order + 1,
      soc: p.rb,
      flow: ip > 0 ? `+${ip}W` : (op > 0 ? `−${op}W` : 'idle'),
      flowClass: ip > 0 ? 'flow-in' : (op > 0 ? 'flow-out' : 'flow-idle'),
      temp: formatPackTempHtml(p.it, sn.slice(-6) || sn),
      label: `…${sn.slice(-6)}`,
      snTitle: sn,
      isMain: false,
      needUpgrade: !!p.needUpgrade,
    }));
  });
  list.innerHTML = rows.join('');
  card.hidden = false;
}

// Battery packs collapse toggle. Default is collapsed; user
// preference is sticky across reloads via localStorage. The detail
// rows aren't decision-critical at glance — the header summary
// ("5 packs · avg 75% · system 76% · 237W in") tells the user
// whether anything's wrong. Open the card only when investigating.
const PACKS_COLLAPSE_KEY = 'jackery-battery-packs-collapsed';

function applyBatteryPacksCollapseState() {
  const card = document.getElementById('battery-packs-card');
  const hdr  = document.getElementById('battery-packs-toggle');
  if (!card || !hdr) return;
  const saved = localStorage.getItem(PACKS_COLLAPSE_KEY);
  // Default to collapsed when the key has never been set.
  const collapsed = saved == null ? true : (saved === '1');
  card.classList.toggle('collapsed', collapsed);
  hdr.setAttribute('aria-expanded', String(!collapsed));
}

function toggleBatteryPacksCollapsed() {
  const card = document.getElementById('battery-packs-card');
  const hdr  = document.getElementById('battery-packs-toggle');
  if (!card || !hdr) return;
  const nowCollapsed = !card.classList.contains('collapsed');
  card.classList.toggle('collapsed', nowCollapsed);
  hdr.setAttribute('aria-expanded', String(!nowCollapsed));
  localStorage.setItem(PACKS_COLLAPSE_KEY, nowCollapsed ? '1' : '0');
}

document.getElementById('battery-packs-toggle')?.addEventListener('click', toggleBatteryPacksCollapsed);
document.getElementById('battery-packs-toggle')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    toggleBatteryPacksCollapsed();
  }
});

// Generic collapse: any card with `data-collapse-key` works the same
// way as battery-packs (default-collapsed + sticky per-key state via
// localStorage). Used by the Forecast tab's "Today's energy budget"
// and "Sunset/sunrise accuracy" cards. Distinct from
// `data-settings-collapse-key` (settings-tab-only with extra search
// indexing) so adding one of these doesn't pollute settings search.
function _collapseStorageKey(key) { return `jackery-collapse-${key}`; }
function _applyCollapseFor(card) {
  const key = card.dataset.collapseKey;
  if (!key) return;
  const saved = localStorage.getItem(_collapseStorageKey(key));
  // Default state is whatever the HTML declared (typically `collapsed`
  // class set in markup). User pref overrides if set.
  if (saved === '1') card.classList.add('collapsed');
  else if (saved === '0') card.classList.remove('collapsed');
  card.querySelector('.collapsible-header')?.setAttribute(
    'aria-expanded', String(!card.classList.contains('collapsed')),
  );
}
function _toggleCollapseFor(card) {
  const key = card.dataset.collapseKey;
  if (!key) return;
  const nowCollapsed = !card.classList.contains('collapsed');
  card.classList.toggle('collapsed', nowCollapsed);
  card.querySelector('.collapsible-header')?.setAttribute(
    'aria-expanded', String(!nowCollapsed),
  );
  localStorage.setItem(_collapseStorageKey(key), nowCollapsed ? '1' : '0');
}
document.querySelectorAll('[data-collapse-key]').forEach((card) => {
  _applyCollapseFor(card);
  const hdr = card.querySelector('.collapsible-header');
  if (!hdr) return;
  hdr.addEventListener('click', (e) => {
    // Don't hijack clicks on form controls inside the header (e.g.
    // the days-window dropdown on the accuracy card).
    if (e.target.closest('input, select, button, a, textarea')) return;
    _toggleCollapseFor(card);
  });
  hdr.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      _toggleCollapseFor(card);
    }
  });
});
// Apply persisted state on load. (Body of the function tolerates
// the elements being absent so order-of-script-load doesn't matter.)
applyBatteryPacksCollapseState();

// Apply the cached system SOC to the SOC card's big number + bar.
// applyStatus() runs on every WS tick and writes the main-only SOC; we
// re-write here so the system value wins whenever packs are present.
// Idempotent — safe to call repeatedly.
function applySystemSocOverlay() {
  const sys = window._systemSoc;
  if (sys == null) return;
  const pctEl = $('battery-pct');
  const barEl = $('battery-bar-fill');
  if (pctEl) pctEl.textContent = Math.round(sys);
  if (barEl) barEl.style.width = `${sys}%`;
}

// Called from applyStatus() on every WS telemetry tick. If the actual
// SOC has drifted enough from the last forecast's anchor, refit so the
// pill stays meaningful between scheduled refreshes.
function maybeRefitEodOnDrift(currentSocPct) {
  if (_eodAnchorSOC == null || currentSocPct == null) return;
  if (Date.now() - _eodLastFetchAt < EOD_MIN_REFRESH_INTERVAL_MS) return;
  if (Math.abs(currentSocPct - _eodAnchorSOC) < EOD_DRIFT_THRESHOLD_PCT) return;
  fetchEodForecast();
}

function drawForecastChart(j) {
  const canvas = $('chart-forecast');
  if (!canvas) return;
  const { ctx, w, h } = setCanvasSize(canvas);
  ctx.clearRect(0, 0, w, h);
  const padL = 42, padR = 50, padT = 14, padB = 28;
  drawAxes(ctx, w, h, padL, padR, padT, padB);

  const fc = j?.forecast || [];
  if (!fc.length) {
    ctx.fillStyle = '#6b7280'; ctx.font = '12px Inter';
    ctx.fillText('No forecast yet — keep the monitor running and check back.', padL + 8, padT + 16);
    return;
  }

  const totalW = w - padL - padR;
  const innerH = h - padT - padB;
  const n = fc.length;
  const xAt = (i) => padL + (i / (n - 1)) * totalW;
  const ts0 = fc[0].ts, ts1 = fc[fc.length - 1].ts;

  // Threshold band — shade where predicted SOC dips below user's low-batt %.
  const threshold = j.low_battery_threshold || 20;
  const yThreshold = padT + innerH * (1 - threshold / 100);
  ctx.fillStyle = 'rgba(248, 113, 113, 0.08)';
  ctx.fillRect(padL, yThreshold, totalW, h - padB - yThreshold);
  ctx.strokeStyle = 'rgba(248, 113, 113, 0.4)';
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(padL, yThreshold); ctx.lineTo(w - padR, yThreshold);
  ctx.stroke();
  ctx.setLineDash([]);

  const vis = _seriesVisible.forecast;
  // Right-axis grid: power scale based on whichever power series are
  // currently visible. If both are hidden, fall back to 1 so the SOC-only
  // view still draws cleanly.
  const powerSamples = [1];
  if (vis.solar) powerSamples.push(...fc.map(p => p.solar_w || 0));
  if (vis.load)  powerSamples.push(...fc.map(p => p.load_w || 0));
  const maxPower = Math.max(...powerSamples);
  const niceMax = Math.max(100, Math.ceil(maxPower / 100) * 100);

  // Left-axis: SOC % grid + labels
  ctx.strokeStyle = '#1c2128'; ctx.lineWidth = 1;
  ctx.fillStyle = '#6b7280'; ctx.font = '11px Inter';
  ctx.textAlign = 'right';
  for (let i = 0; i <= 4; i++) {
    const y = padT + (innerH * i) / 4;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
    ctx.fillText(`${100 - i * 25}%`, padL - 6, y + 3);
    ctx.fillText(`${Math.round(niceMax * (4 - i) / 4)}W`, w - padR + 36, y + 3);
  }
  ctx.textAlign = 'start';

  // X-axis labels
  const fmtTs = (ts) => {
    const d = new Date(ts * 1000);
    const span = ts1 - ts0;
    if (span > 24 * 3600) return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };
  ctx.fillStyle = '#6b7280';
  const ticks = 5;
  for (let i = 0; i <= ticks; i++) {
    const idx = Math.floor((n - 1) * (i / ticks));
    ctx.fillText(fmtTs(fc[idx].ts), xAt(idx) - 18, h - 8);
  }

  if (vis.solar) {
    ctx.strokeStyle = SERIES_COLORS.input;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    fc.forEach((p, i) => {
      const x = xAt(i);
      const y = padT + innerH * (1 - (p.solar_w || 0) / niceMax);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }

  if (vis.load) {
    // Load is dashed so it visually reads as "demand" not "production".
    ctx.strokeStyle = SERIES_COLORS.output;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    fc.forEach((p, i) => {
      const x = xAt(i);
      const y = padT + innerH * (1 - (p.load_w || 0) / niceMax);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.setLineDash([]);
  }

  if (vis.soc) {
    ctx.strokeStyle = SERIES_COLORS.battery;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    fc.forEach((p, i) => {
      const x = xAt(i);
      const y = padT + innerH * (1 - (p.predicted_soc || 0) / 100);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }
}

// ============================================================
// BOOT
// ============================================================
// ============================================================
// SCREEN WAKE LOCK ("Keep screen on" toggle for iPad kiosks)
// ============================================================
const KEEP_AWAKE_KEY = 'jackery-keep-awake';
let _wakeLock = null;

function isKeepAwakeOn() {
  return localStorage.getItem(KEEP_AWAKE_KEY) === '1';
}

async function requestWakeLock() {
  if (!('wakeLock' in navigator)) {
    return { ok: false, reason: 'not-supported' };
  }
  try {
    _wakeLock = await navigator.wakeLock.request('screen');
    _wakeLock.addEventListener('release', () => { _wakeLock = null; });
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e?.message || String(e) };
  }
}

async function releaseWakeLock() {
  if (_wakeLock) {
    try { await _wakeLock.release(); } catch {}
    _wakeLock = null;
  }
}

// Browsers release the wake lock when the tab becomes hidden. Re-acquire
// when it comes back into view, so the iPad mounted-on-wall use case
// keeps working after notifications, app switches, etc.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && isKeepAwakeOn()) {
    requestWakeLock();
  }
});

function setKeepAwakeStatus(text) {
  const el = $('keep-awake-status');
  if (el) el.textContent = text;
}

function initKeepAwakeToggle() {
  const t = $('keep-awake-toggle');
  if (!t) return;
  t.checked = isKeepAwakeOn();
  if (!('wakeLock' in navigator)) {
    setKeepAwakeStatus('— not supported on this browser (needs iOS 16.4+)');
  } else if (t.checked) {
    setKeepAwakeStatus(_wakeLock ? '— active' : '— pending');
  } else {
    setKeepAwakeStatus('');
  }
  // Reflect saved temp-unit preference on each tab open.
  syncTempUnitPills();
}

// ============================================================
// TEMPERATURE UNIT (°C / °F) — per-browser display preference
// ============================================================
// Stored in localStorage so each device/browser can have its own.
// All telemetry is captured + persisted on the server in Celsius;
// this preference only affects DISPLAY. Toggle re-renders the live
// view immediately so the user sees the change.

const TEMP_UNIT_KEY = 'jackery-temp-unit';

function getTempUnit() {
  return localStorage.getItem(TEMP_UNIT_KEY) === 'F' ? 'F' : 'C';
}

function setTempUnit(unit) {
  localStorage.setItem(TEMP_UNIT_KEY, unit === 'F' ? 'F' : 'C');
  syncTempUnitPills();
  // Re-render anything that shows a temperature so the change is
  // immediate without waiting for the next poll/MQTT push.
  if (window._lastStatus) {
    try {
      applyStatus(window._lastStatus);
      drawLiveTempChart(window._lastStatus);
    } catch { /* ignore */ }
  }
  if (typeof energyHistoryCache !== 'undefined' && energyHistoryCache) {
    try { drawEnergyTempChart(energyHistoryCache); } catch { /* ignore */ }
  }
  try { renderBatteryPacks(); } catch { /* ignore */ }
  if (activeTab === 'daikin') { try { renderDaikinTab(true); } catch { /* ignore */ } }
  if (activeTab === 'hilo') { try { renderHiloTab(true); } catch { /* ignore */ } }
  if (activeTab === 'thinq') { try { renderThinqTab(true); } catch { /* ignore */ } }
}

function syncTempUnitPills() {
  const unit = getTempUnit();
  const c = $('temp-unit-c'), f = $('temp-unit-f');
  if (c) { c.classList.toggle('on', unit === 'C'); c.setAttribute('aria-checked', String(unit === 'C')); }
  if (f) { f.classList.toggle('on', unit === 'F'); f.setAttribute('aria-checked', String(unit === 'F')); }
}

// Format a Celsius value according to the user's display preference.
// `decimals` defaults to 0 (whole degrees) since the device's BMS
// only reports integer °C anyway.
function formatTemp(celsius, decimals = 0) {
  if (celsius == null || Number.isNaN(Number(celsius))) return '—';
  const c = Number(celsius);
  if (getTempUnit() === 'F') {
    let f = c * 9 / 5 + 32;
    if (Math.abs(f) < 0.05) f = 0;
    return `${f.toFixed(decimals)}°F`;
  }
  return `${c.toFixed(decimals)}°C`;
}

// Plausible Li-ion operating range. Anything outside is almost
// certainly a fault code or unit-confused register from the BMS — the
// AI advisor's 2026-05-01 review caught two packs reporting 135°C
// while others read 76-79°C, which is thermodynamically impossible
// without thermal runaway (and the BMS would have already disconnected
// the pack at that point). We display these as "⚠?" with a tooltip
// rather than the raw number, so they don't mask real thermal issues.
const PACK_TEMP_PLAUSIBLE_C = { min: -20, max: 80 };

// Track which (pack_sn, value) combos we've already warned about so
// the console doesn't spam every render tick.
const _packTempWarned = new Set();

// Returns an HTML snippet for the pack-temp cell. Out-of-range values
// render as a "?" with a tooltip + console warning; in-range values
// pass through formatTemp so the C/F preference applies.
function formatPackTempHtml(celsius, packSn) {
  if (celsius == null || celsius === 999 || Number.isNaN(Number(celsius))) {
    return '';  // unknown / not-applicable sentinel — empty cell
  }
  const c = Number(celsius);
  if (c < PACK_TEMP_PLAUSIBLE_C.min || c > PACK_TEMP_PLAUSIBLE_C.max) {
    const key = `${packSn || 'main'}:${c}`;
    if (!_packTempWarned.has(key)) {
      _packTempWarned.add(key);
      console.warn(
        `pack temp out of range — pack ${packSn || 'main'}: ${c}°C ` +
        `(plausible band ${PACK_TEMP_PLAUSIBLE_C.min}–${PACK_TEMP_PLAUSIBLE_C.max}°C). ` +
        `Likely a BMS fault code or units mismatch on this pack's firmware.`
      );
    }
    const safe = String(c).replace(/[<>&"]/g, (ch) =>
      ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[ch]));
    const title = `Reported value ${safe}°C is outside the plausible Li-ion ` +
                  `operating range (${PACK_TEMP_PLAUSIBLE_C.min} to ${PACK_TEMP_PLAUSIBLE_C.max}°C). ` +
                  `Probably a BMS fault code or sensor glitch on this pack — ` +
                  `not a real temperature reading (display-only; not used).`;
    // Show the actual reading (amber + dotted underline = untrusted) so
    // the value is visible at a glance — the point is to eyeball whether
    // firmware fixed pack temp reporting. Not hidden behind a "⚠?".
    return `<span class="pack-temp-fault" title="${title}">${formatTemp(c)}</span>`;
  }
  return formatTemp(c);
}

document.addEventListener('click', (e) => {
  const id = e.target?.id;
  if (id === 'temp-unit-c') setTempUnit('C');
  else if (id === 'temp-unit-f') setTempUnit('F');
});

document.addEventListener('change', async (e) => {
  if (e.target?.id !== 'keep-awake-toggle') return;
  const on = e.target.checked;
  localStorage.setItem(KEEP_AWAKE_KEY, on ? '1' : '0');
  if (on) {
    const res = await requestWakeLock();
    setKeepAwakeStatus(res.ok
      ? '— active (screen will stay on while this tab is visible)'
      : (res.reason === 'not-supported'
          ? '— not supported on this browser (needs iOS 16.4+)'
          : `— failed: ${res.reason}`));
  } else {
    await releaseWakeLock();
    setKeepAwakeStatus('');
  }
});

// ============================================================
// AI INSIGHTS — daily Claude advisor review
// ============================================================
// Shows pending suggestions on the Automation tab. Each suggestion
// has Apply / Dismiss buttons; nothing auto-applies. Anomalies show
// without an Apply button (purely informational).

async function loadAlgorithmAdvisor() {
  const wrap = $('alg-suggestions');
  if (!wrap) return;
  const dev = activeJackeryDevice();
  const deviceSn = dev?.device_sn;
  // Build the query string properly. The previous code did
  // `${params}&status=pending`.replace(/^&/, '?') — that only fixes
  // the leading-`&` case if `params` is THE WHOLE URL, not when
  // `params` is empty mid-template. When deviceSn was missing (fresh
  // page load before WS populates lastStatus), the URL came out as
  // `/api/algorithm/suggestions&status=pending` and 404'd. URLSearch-
  // Params handles the joining cleanly.
  const qs = new URLSearchParams({status: 'pending'});
  if (deviceSn) qs.set('device_sn', deviceSn);
  try {
    const r = await fetch(`/api/algorithm/suggestions?${qs}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    renderAlgorithmSuggestions(j.suggestions || []);
  } catch (e) {
    wrap.innerHTML = `<div class="hint">Failed to load suggestions: ${String(e.message || e)}</div>`;
  }
}

function renderAlgorithmSuggestions(rows) {
  const wrap = $('alg-suggestions');
  const summaryEl = $('alg-summary');
  const badge = $('alg-pending-badge');
  if (!wrap) return;
  // Latest pending of kind=config has its summary surfaced; we
  // currently store it implicitly in the DB as the most recent
  // suggestion's reasoning. For now, show the count + any anomaly hints.
  const config = rows.filter(r => r.kind === 'config');
  const anomalies = rows.filter(r => r.kind === 'anomaly');

  if (badge) {
    if (rows.length) {
      badge.hidden = false;
      badge.textContent = String(rows.length);
    } else {
      badge.hidden = true;
    }
  }
  if (summaryEl) summaryEl.hidden = true;  // populated by review_now response

  if (!rows.length) {
    wrap.innerHTML = '<div class="hint">No pending suggestions. ' +
      'Click "Run review now" to ask the AI advisor for a fresh analysis.</div>';
    return;
  }

  const safe = (s) => String(s || '').replace(/[<>&"]/g, (c) =>
    ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]));

  const renderConfig = (s) => {
    const conf = s.confidence || 'medium';
    const confCls = `alg-conf alg-conf-${conf}`;
    return `
      <div class="alg-card" data-id="${s.id}">
        <div class="alg-card-head">
          <span class="alg-target">${safe(s.target)}</span>
          <span class="${confCls}">${conf}</span>
          <span class="alg-when">${new Date((s.created_at || 0) * 1000).toLocaleString()}</span>
        </div>
        <div class="alg-change-line">
          <span class="alg-num-old">${safe(s.current_value)}</span>
          <span class="alg-arrow">→</span>
          <span class="alg-num-new">${safe(s.proposed_value)}</span>
        </div>
        <div class="alg-reasoning">${safe(s.reasoning || '')}</div>
        <div class="alg-actions">
          <button class="btn btn-primary" data-alg-apply="${s.id}" type="button">Apply</button>
          <button class="btn btn-ghost" data-alg-dismiss="${s.id}" type="button">Dismiss</button>
        </div>
      </div>`;
  };
  const renderAnomaly = (s) => {
    const sev = s.severity || 'info';
    return `
      <div class="alg-card alg-anomaly alg-sev-${sev}" data-id="${s.id}">
        <div class="alg-card-head">
          <span class="alg-target">⚠ Anomaly</span>
          <span class="alg-sev-tag">${sev}</span>
          <span class="alg-when">${new Date((s.created_at || 0) * 1000).toLocaleString()}</span>
        </div>
        <div class="alg-reasoning">${safe(s.reasoning || '')}</div>
        <div class="alg-actions">
          <button class="btn btn-ghost" data-alg-dismiss="${s.id}" type="button">Acknowledge</button>
        </div>
      </div>`;
  };

  // Top action bar: Copy-all (always when there are rows) + Ack-all
  // (only when 2+ anomalies, to keep one-off anomalies from cluttering).
  const showAck = anomalies.length >= 2;
  const topBar = `
    <div class="alg-ack-all">
      <span>${rows.length} pending — ${config.length} config, ${anomalies.length} anomalies</span>
      <span style="display:flex; gap:8px">
        <button class="btn btn-ghost" data-alg-copy-all type="button">Copy all</button>
        ${showAck ? '<button class="btn btn-ghost" data-alg-ack-all type="button">Acknowledge all</button>' : ''}
      </span>
    </div>`;

  wrap.innerHTML = [
    topBar,
    ...config.map(renderConfig),
    ...anomalies.map(renderAnomaly),
  ].join('');

  wrap.querySelectorAll('[data-alg-apply]').forEach((btn) => {
    btn.addEventListener('click', () => applyAlgSuggestion(btn.dataset.algApply));
  });
  wrap.querySelectorAll('[data-alg-dismiss]').forEach((btn) => {
    btn.addEventListener('click', () => dismissAlgSuggestion(btn.dataset.algDismiss));
  });
  wrap.querySelector('[data-alg-ack-all]')?.addEventListener('click', () => {
    ackAllAnomalies(anomalies.map(a => a.id));
  });
  wrap.querySelector('[data-alg-copy-all]')?.addEventListener('click', () => {
    copyAllInsights(config, anomalies);
  });
}

async function copyAllInsights(config, anomalies) {
  const fmtDate = (ts) => new Date((ts || 0) * 1000).toISOString();
  const lines = [];
  lines.push(`# AI advisor insights — exported ${new Date().toISOString()}`);
  lines.push(`# ${config.length} config suggestion(s), ${anomalies.length} anomaly/anomalies`);
  lines.push('');
  if (config.length) {
    lines.push('## Config suggestions');
    for (const s of config) {
      lines.push(`- ${s.target}: ${s.current_value} → ${s.proposed_value} (confidence: ${s.confidence || 'medium'}, ${fmtDate(s.created_at)})`);
      if (s.reasoning) lines.push(`  reasoning: ${s.reasoning}`);
    }
    lines.push('');
  }
  if (anomalies.length) {
    lines.push('## Anomalies');
    for (const a of anomalies) {
      lines.push(`- [${(a.severity || 'info').toUpperCase()}] ${fmtDate(a.created_at)}`);
      if (a.reasoning) lines.push(`  ${a.reasoning}`);
    }
  }
  const text = lines.join('\n');
  const status = $('alg-status');
  try {
    await navigator.clipboard.writeText(text);
    if (status) {
      status.hidden = false;
      status.textContent = `Copied ${text.length} chars to clipboard.`;
      setTimeout(() => { status.hidden = true; }, 2500);
    }
  } catch (e) {
    // Clipboard API blocked (insecure context, permissions, etc.) — fall
    // back to a textarea-prompt the user can manually copy from.
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;top:10vh;left:5vw;width:90vw;height:60vh;z-index:9999;font-family:monospace;font-size:12px';
    document.body.appendChild(ta);
    ta.select();
    if (status) {
      status.hidden = false;
      status.textContent = 'Clipboard blocked — select-all + copy from the textarea, then click anywhere to dismiss.';
    }
    const dismiss = (ev) => {
      if (ev.target === ta) return;
      ta.remove();
      document.removeEventListener('click', dismiss, true);
      if (status) status.hidden = true;
    };
    setTimeout(() => document.addEventListener('click', dismiss, true), 50);
  }
}

async function ackAllAnomalies(ids) {
  if (!ids?.length) return;
  if (!confirm(`Acknowledge all ${ids.length} anomalies?`)) return;
  const status = $('alg-status');
  if (status) {
    status.hidden = false;
    status.textContent = `Acknowledging ${ids.length}…`;
  }
  try {
    await Promise.all(ids.map(id =>
      fetch(`/api/algorithm/suggestions/${id}/dismiss`, { method: 'POST' })
        .catch(e => console.warn('dismiss failed', id, e))
    ));
    if (status) {
      status.textContent = 'Acknowledged.';
      setTimeout(() => { status.hidden = true; }, 2000);
    }
    loadAlgorithmAdvisor();
  } catch (e) {
    if (status) status.textContent = `Failed: ${e.message || e}`;
  }
}

async function applyAlgSuggestion(id) {
  const status = $('alg-status');
  status.hidden = false;
  status.textContent = 'Applying…';
  try {
    const r = await fetch(`/api/algorithm/suggestions/${id}/apply`, { method: 'POST' });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.detail || `HTTP ${r.status}`);
    status.textContent = 'Applied.';
    setTimeout(() => { status.hidden = true; }, 2500);
    loadAlgorithmAdvisor();
    // If the change touched smart_charge config, refresh that panel too.
    loadSmartCharge();
  } catch (e) {
    status.textContent = `Apply failed: ${e.message || e}`;
  }
}

async function dismissAlgSuggestion(id) {
  try {
    await fetch(`/api/algorithm/suggestions/${id}/dismiss`, { method: 'POST' });
    loadAlgorithmAdvisor();
  } catch (e) {
    console.warn('dismiss failed', e);
  }
}

// Track the current poll loop so a re-click or device switch can cancel
// it instead of stacking polls.
let _advisorPollTimer = null;

// Provider-aware label for advisor status lines ("Claude (claude-opus-4-7)"
// or "ChatGPT (gpt-5.6-sol)"), refreshed from prefs before each run so a
// Settings change shows correctly without a reload.
let _aiAdvisorLabel = 'AI advisor';
async function refreshAIAdvisorLabel() {
  try {
    const r = await fetch('/api/anthropic/prefs');
    const j = r.ok ? await r.json() : {};
    const isOpenAI = j.provider === 'openai';
    const model = isOpenAI ? j.openai_advisor_model : j.advisor_model;
    const brand = isOpenAI ? 'ChatGPT' : 'Claude';
    _aiAdvisorLabel = model ? `${brand} (${model})` : brand;
  } catch { /* keep previous label */ }
  return _aiAdvisorLabel;
}

document.getElementById('alg-review-now')?.addEventListener('click', async () => {
  const status = $('alg-status');
  const summaryEl = $('alg-summary');
  const btn = $('alg-review-now');
  status.hidden = false;
  status.textContent = 'Starting AI review (60-180s)…';
  refreshAIAdvisorLabel().then((label) => {
    // Only upgrade the text if we're still in the starting phase.
    if (status.textContent.startsWith('Starting AI review')) {
      status.textContent = `Starting ${label} review (60-180s)…`;
    }
  });
  if (btn) btn.disabled = true;
  try {
    const dev = activeJackeryDevice();
    const params = dev?.device_sn
      ? `?device_sn=${encodeURIComponent(dev.device_sn)}` : '';
    // Fire-and-forget: server returns 202 immediately, we poll for the
    // result. Cloudflare 524 is what happens when we tried to wait for
    // the full review on a single HTTP request.
    const r = await fetch(`/api/algorithm/review_now${params}`, { method: 'POST' });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.detail || `HTTP ${r.status}`);
    if (j.already_running) {
      status.textContent = 'A review is already running for this device — polling for results…';
    }
    pollAdvisorJob(dev?.device_sn);
  } catch (e) {
    status.textContent = `Review failed to start: ${e.message || e}`;
    if (btn) btn.disabled = false;
  }
});

function pollAdvisorJob(deviceSn) {
  // Clear any previous loop so re-clicks don't stack.
  if (_advisorPollTimer) { clearTimeout(_advisorPollTimer); _advisorPollTimer = null; }
  const params = deviceSn ? `?device_sn=${encodeURIComponent(deviceSn)}` : '';
  const status = $('alg-status');
  const summaryEl = $('alg-summary');
  const btn = $('alg-review-now');

  const tick = async () => {
    try {
      const r = await fetch(`/api/algorithm/review_status${params}`);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.detail || `HTTP ${r.status}`);
      if (j.status === 'running') {
        const elapsed = j.elapsed_s != null ? `${Math.round(j.elapsed_s)}s elapsed` : '';
        status.textContent = `${_aiAdvisorLabel} is reviewing… ${elapsed}`;
        _advisorPollTimer = setTimeout(tick, 4000);
        return;
      }
      if (j.status === 'done') {
        const result = j.result || {};
        if (summaryEl && result.summary) {
          summaryEl.textContent = result.summary;
          summaryEl.hidden = false;
        }
        const newCount = (result.new_suggestion_ids || []).length;
        const modelTag = result.model ? ` · ${result.model}` : '';
        status.textContent = `Review complete: ${newCount} new ` +
          `(${result.turns || 0} turns, ${result.tool_calls || 0} DB queries` +
          `${modelTag}).`;
        setTimeout(() => { status.hidden = true; }, 6000);
        loadAlgorithmAdvisor();
        // Light the tab dot if user is on another tab — they'll see new
        // items waiting without needing to wait for the 3min periodic.
        refreshAutomationDot();
        if (btn) btn.disabled = false;
        return;
      }
      if (j.status === 'error') {
        status.textContent = `Review failed: ${j.error || 'unknown error'}`;
        if (btn) btn.disabled = false;
        return;
      }
      // status === 'idle' — shouldn't happen right after kicking, but
      // re-poll once just in case the task hasn't latched yet.
      _advisorPollTimer = setTimeout(tick, 1500);
    } catch (e) {
      status.textContent = `Status poll failed: ${e.message || e}`;
      if (btn) btn.disabled = false;
    }
  };
  // First poll quickly so the status text doesn't sit on "Starting…" for
  // multiple seconds; subsequent polls back off to 4s.
  _advisorPollTimer = setTimeout(tick, 800);
}

// Resume a poll if the user lands on Automation while a review is in
// flight (e.g. they kicked it, switched tabs, came back).
async function resumeAdvisorPollIfRunning() {
  const dev = activeJackeryDevice();
  if (!dev?.device_sn) return;
  try {
    const r = await fetch(`/api/algorithm/review_status?device_sn=${encodeURIComponent(dev.device_sn)}`);
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.status === 'running') {
      refreshAIAdvisorLabel();  // async; polling text picks it up next tick
      pollAdvisorJob(dev.device_sn);
    }
  } catch { /* silent — not critical */ }
}

document.getElementById('alg-show-context')?.addEventListener('click', async () => {
  const wrap = $('alg-changes');
  if (!wrap) return;
  if (!wrap.hidden && wrap.dataset.mode === 'context') {
    wrap.hidden = true;
    return;
  }
  wrap.dataset.mode = 'context';
  wrap.innerHTML = '<div class="hint">Loading…</div>';
  wrap.hidden = false;
  try {
    const dev = activeJackeryDevice();
    const params = dev?.device_sn
      ? `?device_sn=${encodeURIComponent(dev.device_sn)}` : '';
    const r = await fetch(`/api/algorithm/preview${params}`);
    const j = await r.json();
    if (!r.ok) throw new Error(j.detail || `HTTP ${r.status}`);
    const safe = (s) => String(s || '').replace(/[<>&"]/g, (c) =>
      ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]));
    const brand = j.provider === 'openai' ? 'ChatGPT' : 'Claude';
    const effortLine = j.provider === 'openai'
      ? `reasoning effort: <code>${safe(j.reasoning_effort || '—')}</code>`
      : `thinking effort: <code>${safe(j.reasoning_effort || '—')}</code>`;
    wrap.innerHTML = `
      <h3 style="margin:0 0 4px;font-size:14px">Context sent to ${brand}</h3>
      <p class="hint" style="margin:0 0 8px">
        Model: <code>${safe(j.model)}</code> · ${effortLine}.
        This is the exact text the advisor reads as the user message —
        minus the system prompt and tool schema.
      </p>
      <pre class="dbg-pre" style="max-height:520px">${safe(j.rendered)}</pre>`;
  } catch (e) {
    wrap.innerHTML = `<div class="hint">Failed: ${escapeHtml(e.message || e)}</div>`;
  }
});

document.getElementById('alg-show-history')?.addEventListener('click', async () => {
  const wrap = $('alg-changes');
  if (!wrap) return;
  if (!wrap.hidden && wrap.dataset.mode === 'history') {
    wrap.hidden = true;
    return;
  }
  wrap.dataset.mode = 'history';
  try {
    const dev = activeJackeryDevice();
    const params = dev?.device_sn
      ? `?device_sn=${encodeURIComponent(dev.device_sn)}` : '';
    const r = await fetch(`/api/algorithm/changes${params}`);
    const j = await r.json();
    const rows = j.changes || [];
    if (!rows.length) {
      wrap.innerHTML = '<div class="hint">No applied changes yet.</div>';
    } else {
      const safe = (s) => String(s || '').replace(/[<>&"]/g, (c) =>
        ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]));
      wrap.innerHTML = '<h3 style="margin:0 0 8px;font-size:14px">Applied changes</h3>' +
        rows.map(c => `
          <div class="alg-change-row">
            <span class="alg-when">${new Date((c.applied_at || 0) * 1000).toLocaleString()}</span>
            <span class="alg-target">${safe(c.target)}</span>
            <span class="alg-num-old">${safe(c.old_value)}</span>
            <span class="alg-arrow">→</span>
            <span class="alg-num-new">${safe(c.new_value)}</span>
            <span class="alg-reasoning">${safe(c.reasoning || '')}</span>
          </div>`).join('');
    }
    wrap.hidden = false;
  } catch (e) {
    wrap.innerHTML = `<div class="hint">Failed: ${escapeHtml(e.message || e)}</div>`;
    wrap.hidden = false;
  }
});

// Reload AI insights on device switch (per-device suggestions).
function _reloadAdvisorOnDeviceSwitch() {
  if (activeTab === 'automation') loadAlgorithmAdvisor();
}

// ============================================================
// ANTHROPIC API KEY (Settings → enables Claude narration)
// ============================================================
// Status banner + save-with-server-validation form. We never receive
// the saved key back from the server; the status endpoint just tells
// us whether one is present, so the form stays empty after save.

let _anthropicHasKey = false;

async function loadAnthropicKeyStatus() {
  const line = $('ak-state-line');
  const status = $('ak-status');
  if (!line) return;
  try {
    const r = await fetch('/api/anthropic/key');
    const j = r.ok ? await r.json() : { has_key: false };
    _anthropicHasKey = !!j.has_key;
    if (j.has_key) {
      line.innerHTML = j.source === 'env'
        ? '✅ <strong>Configured via env var</strong> on the bridge — UI changes here will only affect the saved-on-disk key.'
        : '✅ <strong>API key saved.</strong> Advisor + AI narration are unlocked when Anthropic is the active provider.';
    } else {
      line.innerHTML = 'No key saved. Enter one below to use Anthropic as the active provider.';
    }
    // Populate the collapsed-card chip so the user can see at a glance
    // whether they're configured. The advisor model name (when known)
    // makes this richer — see _refreshAnthropicChip below, called
    // again by loadAnthropicModelPickers once the model list resolves.
    if (status) {
      status.hidden = false;
      status.textContent = j.has_key ? 'connected' : 'not configured';
    }
  } catch (e) {
    console.warn('anthropic key status fetch failed', e);
  }
  // Also re-evaluate the smart-charge claude toggle disabled state, in
  // case the user saved a key while sitting on Settings then jumped to
  // Automation without a full reload.
  applyClaudeToggleGate();
}

function applyAnthropicGates() {
  // Anything that depends on a saved + verified key for the ACTIVE AI
  // provider gets gated here. Re-runnable on every render or status
  // change. window._aiActiveHasKey (set by loadAIProvider) reflects the
  // active provider's key; fall back to the Anthropic flag before the
  // provider status has loaded.
  const hasKey = (window._aiActiveHasKey ?? false) || _anthropicHasKey;
  const reason = 'Save an API key for the active AI provider on the Settings page first.';

  const t = $('sc-claude-toggle');
  if (t) {
    if (hasKey) {
      t.disabled = false;
      t.title = '';
    } else {
      t.disabled = true;
      if (t.checked) t.checked = false;
      t.title = reason;
    }
  }

  // Advisor daily-review hour lives in the generic settings form, so it
  // only exists after renderSettingsFields() has run.
  const hour = $('set-advisor_trigger_hour');
  if (hour) {
    const row = hour.closest('.settings-row');
    if (hasKey) {
      hour.disabled = false;
      hour.title = '';
      if (row) row.classList.remove('gated');
    } else {
      hour.disabled = true;
      hour.title = reason;
      if (row) row.classList.add('gated');
    }
  }
}

// Back-compat shim: older call sites can keep the original name.
const applyClaudeToggleGate = applyAnthropicGates;

document.getElementById('ak-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const status = $('ak-status');
  const input = $('ak-input');
  const key = input.value.trim();
  if (!key) return;
  status.hidden = false;
  status.textContent = 'Validating with Anthropic…';
  try {
    const r = await fetch('/api/anthropic/key', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ api_key: key }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.detail || j.error || `HTTP ${r.status}`);
    status.textContent = 'Saved. Test call succeeded.';
    input.value = '';
    // loadAnthropicKeyStatus() resets the chip to 'connected' / 'not
    // configured'; no timeout-hide needed any more — the chip is
    // always-on now (it's the collapsed-card status indicator).
    loadAnthropicKeyStatus();
    // Newly-saved key → re-fetch the model list so the dropdown
    // switches from fallback to the live Anthropic list.
    loadAnthropicModelPickers();
  } catch (err) {
    status.textContent = String(err.message || err);
  }
});

document.getElementById('ak-clear')?.addEventListener('click', async () => {
  const status = $('ak-status');
  if (!confirm('Forget the saved Anthropic API key? The advisor + AI narration stop working if Anthropic is the active provider.')) return;
  status.hidden = false;
  status.textContent = 'Clearing…';
  try {
    const r = await fetch('/api/anthropic/key', { method: 'DELETE' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    status.textContent = 'Forgotten.';
    loadAnthropicKeyStatus();  // resets chip to 'not configured'
  } catch (err) {
    status.textContent = String(err.message || err);
  }
});

// ============================================================
// ANTHROPIC MODEL + EFFORT PICKERS — populated from
// /api/anthropic/models (live list when an API key is saved,
// static fallback otherwise), persisted via /api/anthropic/prefs.
// Refreshes every time the Settings tab opens.
//
// 1M-context handling: models flagged supports_1m by the server
// get a synthetic "(1M context)" entry with value `${id}@1m`. On
// save, the suffix is stripped and `advisor_1m_context: true` is
// sent alongside the bare model id. Picking a non-@1m entry sets
// it false. This way "future Opus" / "future Sonnet 1M" works
// without a code change — just bump JACKERY_1M_MODEL_PATTERNS on
// the server.
// ============================================================
const ANTHROPIC_1M_SUFFIX = '@1m';

async function loadAnthropicModelPickers() {
  const advisorSel = $('ak-advisor-model');
  const narratorSel = $('ak-narrator-model');
  const effortSel = $('ak-advisor-effort');
  const statusEl = $('ak-models-status');
  if (!advisorSel || !narratorSel || !effortSel) return;
  if (statusEl) statusEl.textContent = 'Loading model list…';
  try {
    // Parallel: fetch the available list + the user's current selection.
    const [modelsR, prefsR] = await Promise.all([
      fetch('/api/anthropic/models'),
      fetch('/api/anthropic/prefs'),
    ]);
    const modelsJ = modelsR.ok ? await modelsR.json() : { models: [], source: 'fetch_failed' };
    const prefsJ = prefsR.ok ? await prefsR.json() : {};
    const models = modelsJ.models || [];
    const prefs = {
      advisor_model: prefsJ.advisor_model || '',
      advisor_1m_context: !!prefsJ.advisor_1m_context,
      advisor_thinking_effort: prefsJ.advisor_thinking_effort || 'high',
      narrator_model: prefsJ.narrator_model || '',
    };
    // Compute the dropdown value that represents the current advisor
    // selection (model + 1m flag) — if 1m is on, pick the @1m
    // variant; else pick the bare model.
    const advisorCurrent = prefs.advisor_model
      ? (prefs.advisor_1m_context
          ? `${prefs.advisor_model}${ANTHROPIC_1M_SUFFIX}`
          : prefs.advisor_model)
      : '';

    const populate = (sel, current, opts = {}) => {
      const { synthesize1m = false } = opts;
      sel.innerHTML = '';
      const seen = new Set();
      const addOpt = (id, label) => {
        if (seen.has(id)) return;
        seen.add(id);
        const o = document.createElement('option');
        o.value = id;
        o.textContent = label || id;
        if (id === current) o.selected = true;
        sel.appendChild(o);
      };
      for (const m of models) {
        addOpt(m.id, m.display_name);
        // Synthesize a 1M variant on dropdowns that should offer it
        // (advisor only). The server tells us which models support 1M
        // via the `supports_1m` flag — we don't hardcode "opus" here
        // so future families pick up the variant via the env-var
        // pattern config without a frontend change.
        if (synthesize1m && m.supports_1m) {
          const id1m = `${m.id}${ANTHROPIC_1M_SUFFIX}`;
          addOpt(id1m, `${m.display_name || m.id} (1M context)`);
        }
      }
      if (current && !seen.has(current)) {
        addOpt(current, `${current} (saved)`);
      }
      sel.disabled = false;
    };
    populate(advisorSel, advisorCurrent, { synthesize1m: true });
    populate(narratorSel, prefs.narrator_model);
    // Effort dropdown is static (Anthropic API enum); just select
    // the persisted value.
    for (const opt of effortSel.options) {
      opt.selected = opt.value === prefs.advisor_thinking_effort;
    }
    if (statusEl) {
      const sourceLabel = ({
        live: '✅ Live list from Anthropic.',
        cache: '✅ Live list (cached).',
        fallback_no_key: '⚠ No API key saved — showing well-known model aliases as a fallback.',
        fallback_no_sdk: '⚠ Anthropic SDK not in this image — showing fallback list.',
        fallback_fetch_failed: `⚠ Couldn't reach Anthropic to refresh the list — showing fallback. ${modelsJ.error || ''}`,
        fallback_empty: '⚠ Anthropic returned an empty list — showing fallback.',
      })[modelsJ.source] || `Source: ${modelsJ.source || 'unknown'}.`;
      statusEl.textContent = sourceLabel;
    }
  } catch (e) {
    if (statusEl) statusEl.textContent = `Failed to load model list: ${e.message || e}`;
  }
}

async function saveAnthropicPref(body, label) {
  const statusEl = $('ak-models-status');
  if (statusEl) statusEl.textContent = `Saving ${label}…`;
  try {
    const r = await fetch('/api/anthropic/prefs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.detail || `HTTP ${r.status}`);
    }
    if (statusEl) {
      statusEl.textContent = `Saved. ${label} applies on the next advisor/narrator call.`;
      setTimeout(() => { statusEl.textContent = ''; }, 3500);
    }
  } catch (e) {
    if (statusEl) statusEl.textContent = `Save failed: ${e.message || e}`;
  }
}

document.getElementById('ak-advisor-model')?.addEventListener('change', (e) => {
  // Parse the synthetic @1m suffix into a (model, 1m_context) tuple
  // before persisting. Picking the bare model entry explicitly turns
  // 1m off — important so a previous "@1m" save doesn't keep the
  // beta header on after the user switches to a non-1M model.
  const raw = e.target.value;
  const has1m = raw.endsWith(ANTHROPIC_1M_SUFFIX);
  const model = has1m ? raw.slice(0, -ANTHROPIC_1M_SUFFIX.length) : raw;
  saveAnthropicPref(
    { advisor_model: model, advisor_1m_context: has1m },
    `advisor model${has1m ? ' (1M)' : ''}`,
  );
});
document.getElementById('ak-narrator-model')?.addEventListener('change', (e) => {
  saveAnthropicPref({ narrator_model: e.target.value }, 'narrator model');
});
document.getElementById('ak-advisor-effort')?.addEventListener('change', (e) => {
  saveAnthropicPref({ advisor_thinking_effort: e.target.value }, 'thinking effort');
});

// ============================================================
// AI PROVIDER SELECTOR + OPENAI KEY/MODEL PICKERS
// Mirrors the Anthropic block. Provider switch → /api/ai/provider;
// key → /api/openai/{key,models}; model prefs reuse saveAnthropicPref
// (the /api/anthropic/prefs endpoint also accepts openai_* fields).
// ============================================================
async function loadAIProvider() {
  const sel = $('ai-provider-select');
  const status = $('ai-provider-status');
  if (!sel) return;
  try {
    const r = await fetch('/api/ai/provider');
    const j = r.ok ? await r.json() : {};
    if (j.provider) sel.value = j.provider;
    if (status) status.textContent = j.provider ? `active: ${j.provider}` : '';
    // Gate the narration toggle + advisor hour on the ACTIVE provider's key.
    window._aiActiveHasKey = j.provider === 'openai'
      ? !!j.openai_has_key : !!j.anthropic_has_key;
    applyAnthropicGates();
  } catch (e) { console.warn('ai provider fetch failed', e); }
}

document.getElementById('ai-provider-select')?.addEventListener('change', async (e) => {
  const status = $('ai-provider-status');
  if (status) status.textContent = 'Switching…';
  try {
    const r = await fetch('/api/ai/provider', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: e.target.value }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.detail || `HTTP ${r.status}`);
    if (status) status.textContent = `active: ${j.provider}`;
    loadAIProvider();  // refresh the active-provider key flag + re-gate
  } catch (err) {
    if (status) status.textContent = `switch failed: ${err.message || err}`;
  }
});

async function loadOpenAIKeyStatus() {
  const line = $('oa-state-line');
  const status = $('oa-status');
  if (!line) return;
  try {
    const r = await fetch('/api/openai/key');
    const j = r.ok ? await r.json() : { has_key: false };
    if (j.has_key) {
      line.innerHTML = j.source === 'env'
        ? '✅ <strong>Configured via env var</strong> on the bridge — UI changes here only affect the saved-on-disk key.'
        : '✅ <strong>API key saved.</strong>';
    } else {
      line.innerHTML = 'No key saved. Enter one below to use OpenAI as the active provider.';
    }
    if (status) { status.hidden = false; status.textContent = j.has_key ? 'connected' : 'not configured'; }
  } catch (e) { console.warn('openai key status fetch failed', e); }
}

document.getElementById('oa-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const status = $('oa-status');
  const input = $('oa-input');
  const key = input.value.trim();
  if (!key) return;
  status.hidden = false;
  status.textContent = 'Validating with OpenAI…';
  try {
    const r = await fetch('/api/openai/key', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ api_key: key }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.detail || j.error || `HTTP ${r.status}`);
    status.textContent = 'Saved. Test call succeeded.';
    input.value = '';
    loadOpenAIKeyStatus();
    loadOpenAIModelPickers();
  } catch (err) { status.textContent = String(err.message || err); }
});

document.getElementById('oa-clear')?.addEventListener('click', async () => {
  const status = $('oa-status');
  if (!confirm('Forget the saved OpenAI API key?')) return;
  status.hidden = false;
  status.textContent = 'Clearing…';
  try {
    const r = await fetch('/api/openai/key', { method: 'DELETE' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    status.textContent = 'Forgotten.';
    loadOpenAIKeyStatus();
  } catch (err) { status.textContent = String(err.message || err); }
});

async function loadOpenAIModelPickers() {
  const advisorSel = $('oa-advisor-model');
  const narratorSel = $('oa-narrator-model');
  const effortSel = $('oa-advisor-effort');
  const statusEl = $('oa-models-status');
  if (!advisorSel || !narratorSel || !effortSel) return;
  if (statusEl) statusEl.textContent = 'Loading model list…';
  try {
    const [modelsR, prefsR] = await Promise.all([
      fetch('/api/openai/models'),
      fetch('/api/anthropic/prefs'),
    ]);
    const modelsJ = modelsR.ok ? await modelsR.json() : { models: [], source: 'fetch_failed' };
    const prefsJ = prefsR.ok ? await prefsR.json() : {};
    const models = modelsJ.models || [];
    const advisorCurrent = prefsJ.openai_advisor_model || '';
    const narratorCurrent = prefsJ.openai_narrator_model || '';
    const effort = prefsJ.openai_advisor_effort || 'high';
    const populate = (sel, current) => {
      sel.innerHTML = '';
      const seen = new Set();
      const addOpt = (id, label) => {
        if (seen.has(id)) return;
        seen.add(id);
        const o = document.createElement('option');
        o.value = id;
        o.textContent = label || id;
        if (id === current) o.selected = true;
        sel.appendChild(o);
      };
      for (const m of models) addOpt(m.id, m.display_name);
      if (current && !seen.has(current)) addOpt(current, `${current} (saved)`);
      sel.disabled = false;
    };
    populate(advisorSel, advisorCurrent);
    populate(narratorSel, narratorCurrent);
    for (const opt of effortSel.options) opt.selected = opt.value === effort;
    if (statusEl) {
      const sourceLabel = ({
        live: '✅ Live list from OpenAI.',
        cache: '✅ Live list (cached).',
        fallback_no_key: '⚠ No API key saved — showing well-known models as a fallback.',
        fallback_no_sdk: '⚠ OpenAI SDK not in this image — showing fallback list.',
        fallback_fetch_failed: `⚠ Couldn't reach OpenAI to refresh — showing fallback. ${modelsJ.error || ''}`,
        fallback_empty: '⚠ OpenAI returned an empty list — showing fallback.',
      })[modelsJ.source] || `Source: ${modelsJ.source || 'unknown'}.`;
      statusEl.textContent = sourceLabel;
    }
  } catch (e) {
    if (statusEl) statusEl.textContent = `Failed to load model list: ${e.message || e}`;
  }
}

document.getElementById('oa-advisor-model')?.addEventListener('change', (e) => {
  saveAnthropicPref({ openai_advisor_model: e.target.value }, 'OpenAI advisor model');
});
document.getElementById('oa-narrator-model')?.addEventListener('change', (e) => {
  saveAnthropicPref({ openai_narrator_model: e.target.value }, 'OpenAI narrator model');
});
document.getElementById('oa-advisor-effort')?.addEventListener('change', (e) => {
  saveAnthropicPref({ openai_advisor_effort: e.target.value }, 'OpenAI reasoning effort');
});

// ============================================================
// HERO CARD REORDER (drag-and-drop, persisted per-browser)
// ============================================================
const HERO_ORDER_KEY = 'jackery-hero-order';

function applyHeroOrder() {
  const grid = $('hero-grid');
  if (!grid) return;
  let saved;
  try { saved = JSON.parse(localStorage.getItem(HERO_ORDER_KEY) || '[]'); }
  catch { return; }
  if (!Array.isArray(saved) || !saved.length) return;
  // Reorder DOM children to match saved order. Unknown card IDs are
  // skipped; new cards we haven't seen before fall to the end.
  for (const id of saved) {
    const el = grid.querySelector(`[data-card="${id}"]`);
    if (el) grid.appendChild(el);
  }
}

function initHeroSortable() {
  const grid = $('hero-grid');
  if (!grid || typeof Sortable === 'undefined') return;
  Sortable.create(grid, {
    handle: '.grab-handle',  // drag only via the handle so card content stays interactive
    animation: 180,
    ghostClass: 'sortable-ghost',
    dragClass: 'sortable-drag',
    delay: 100,              // long-press delay on touch
    delayOnTouchOnly: true,  // mouse drags fire instantly; touch needs a brief hold
    touchStartThreshold: 5,
    onEnd: () => {
      const ids = [...grid.querySelectorAll('[data-card]')].map(c => c.dataset.card);
      try { localStorage.setItem(HERO_ORDER_KEY, JSON.stringify(ids)); } catch {}
    },
  });
}

(async function boot() {
  // Restore card order BEFORE first paint so the user doesn't see a flash
  // of the default arrangement.
  applyHeroOrder();

  // Re-acquire wake lock on boot if the user previously enabled it.
  // Silent failure on unsupported browsers — toggle UI surfaces the
  // not-supported message when the user opens Settings.
  if (isKeepAwakeOn()) {
    requestWakeLock();
  }

  const ok = await checkAuth();
  // Always start the WS — server returns whatever it has, even if cloud is logging in
  connectWs();
  initHeroSortable();

  // Pre-load history so the Live chart and Energy tab have data immediately
  // (otherwise the user has to switch tabs once before history populates).
  fetchEnergyHistory();
  fetchEnergyAllDevices();
  initCostTab();
  initSinopeTab();
  initSinopeSettings();
  initDaikinTab();
  initDaikinSettings();
  initHiloTab();
  initHiloSettings();
  initThinqTab();
  initThinqSettings();
  initMideaTab();
  initMideaSettings();
  initNotificationsSettings();
  initTeslaTab();
  initTeslaSettings();
  initKasaTab();

  // Once-per-app-load geolocation prompt for the forecast feature. Skipped
  // if location is already saved or the user previously denied.
  if (ok) maybePromptLocationOnBoot();

  // EOD forecast badge on the battery card: populate once on boot, then
  // refit hourly (weather forecast itself only updates ~hourly).
  if (ok) fetchEodForecast();
  setInterval(fetchEodForecast, 30 * 60_000);

  // Per-expansion-battery list. Server caches packs (refreshed every 5min
  // by the poll loop), so a 30s UI refresh just keeps the rendered values
  // in sync with the cache without hammering the cloud.
  if (ok) fetchBatteryPacks();
  setInterval(fetchBatteryPacks, 30_000);

  // Poll /api/status every 2s as a safety net in case the WebSocket lags
  // or drops a frame. The WS still pushes telemetry as it arrives — this
  // just guarantees the UI is never more than 2 seconds stale.
  setInterval(async () => {
    try {
      const r = await fetch('/api/status', { cache: 'no-store' });
      if (r.ok) applyStatus(await r.json());
    } catch {}
  }, 2000);

  // Refresh energy history at a slower cadence — it's a heavier query and
  // doesn't change every tick. Picks up new samples for the chart.
  setInterval(fetchEnergyHistory, 30000);

  // Cost: refresh when active tab is cost
  setInterval(() => { if (activeTab === 'cost') loadCostTab(); }, 30_000);

  // Forecast: weather updates hourly, fit + simulation are cheap, refresh
  // every 5 min while the tab is visible. fetchForecast is a no-op if the
  // result hasn't changed visibly.
  setInterval(() => { if (activeTab === 'forecast') fetchForecast(); }, 5 * 60_000);

  // AI advisor pending-items badge on the Automation tab. Check on load
  // + every 3 min so the daily 8am review (or a manual run that
  // completed in another browser) lights up the dot promptly.
  refreshAutomationDot();
  setInterval(refreshAutomationDot, 3 * 60_000);

  // If auth was missing the user is in the modal — when they sign in successfully
  // the modal hides and the WS snapshot will populate the UI.
  setInterval(checkAuth, 30000);
})();

// ===========================================================================
// Backup & restore — Settings tab.
// Three logical groupings: (1) destination credentials + connectivity test,
// (2) status / run history / run-now, (3) snapshot list + restore picker.
// All UI state is derived from /api/backup/*. Polling is event-driven (only
// while the Settings tab is visible) — see loadBackupAll() above.
// ===========================================================================

async function loadBackupAll() {
  // Fan-out the three independent loads. Status & creds are cheap (local
  // file reads); snapshot listing requires mounting the remote so we leave
  // it lazy until the user clicks "List snapshots".
  await loadBackupCreds();
  loadBackupStatus();
  loadBackupSchedule();
  // After creds load we know whether to auto-discover. loadBackupCreds
  // sets _backupHasCreds; if false AND we're on SMB transport we sweep
  // the LAN once for SMB hosts (cached for the rest of the session).
  // rsync transports don't get LAN discovery — port-445 SMB scanning is
  // SMB-specific and would mislead a user who's set Transport to rsync.
  if (!_backupHasCreds && _backupTransport() === 'smb') {
    runBackupDiscovery({ force: false });
  } else {
    const panel = $('backup-discover-panel');
    if (panel) panel.hidden = true;
  }
}

// Cached state for discovery so re-entering the Settings tab doesn't
// trigger another 5-second LAN sweep. Manual "Rescan" bypasses this.
let _backupHasCreds = false;
let _backupDiscoveryRan = false;

// Required fields per transport. Mirrors the same map on the server
// side. Used to decide when the auto-test has enough input to fire and
// to validate Save before sending the body.
const _BACKUP_REQUIRED_FIELDS = {
  smb: ['host', 'share', 'username', 'password'],
  rsync_ssh: ['host', 'ssh_user', 'ssh_key', 'target_dir'],
  rsyncd: ['host', 'rsync_module', 'rsyncd_user', 'rsyncd_password'],
  rsyncd_ssh: ['host', 'ssh_user', 'ssh_password', 'rsync_module'],
};

// Every input/textarea/select that contributes to the creds body. Used
// by the Forget button to wipe state and by the auto-test wiring to
// listen for input changes regardless of which transport is active.
const _ALL_BACKUP_INPUT_IDS = [
  'backup-transport',
  'backup-host',
  // SMB
  'backup-share', 'backup-subdir', 'backup-username',
  'backup-password', 'backup-domain',
  // rsync over SSH (key auth, filesystem path)
  'backup-ssh-user', 'backup-target-dir', 'backup-ssh-key',
  // rsyncd (port 873) + rsyncd over SSH (port 22) share these
  'backup-rsync-module', 'backup-target-subpath',
  // rsyncd-only
  'backup-rsyncd-user', 'backup-rsyncd-password',
  // rsyncd-over-SSH-only
  'backup-ssh-port', 'backup-ssh-password',
];

function _backupTransport() {
  return ($('backup-transport')?.value || 'smb');
}

// Show only the rows tagged for the current transport (or the universal
// rows tagged data-transport-row="all"). Also hides the SMB-only LAN
// discovery panel for non-SMB transports.
function _applyBackupTransportVisibility() {
  const t = _backupTransport();
  document.querySelectorAll('[data-transport-row]').forEach(row => {
    const allowed = row.dataset.transportRow.split(',').map(s => s.trim());
    row.hidden = !(allowed.includes('all') || allowed.includes(t));
  });
  const panel = $('backup-discover-panel');
  if (panel && t !== 'smb') panel.hidden = true;
}

// Module discovery for rsyncd / rsyncd_ssh transports. Hits the
// /api/backup/list-rsync-modules endpoint with the current form state
// and populates the datalist + writes a hint line. Mirrors what
// Synology Hyper Backup does — the user enters host + creds, hits
// "Discover modules", and gets the available module names.
$('backup-rsync-module-discover')?.addEventListener('click', async () => {
  const btn = $('backup-rsync-module-discover');
  const hint = $('backup-rsync-module-hint');
  const dl = $('backup-rsync-module-options');
  const moduleInput = $('backup-rsync-module');
  if (!btn) return;
  const t = _backupTransport();
  if (t !== 'rsyncd' && t !== 'rsyncd_ssh') return;
  const f = _readBackupForm();
  if (!f.host) {
    if (hint) { hint.textContent = 'Enter host first.'; hint.dataset.kind = ''; }
    return;
  }
  const body = { transport: t, host: f.host };
  if (t === 'rsyncd_ssh') {
    if (!f.ssh_user || !f.ssh_password) {
      if (hint) { hint.textContent = 'Enter SSH user + password first.'; hint.dataset.kind = ''; }
      return;
    }
    Object.assign(body, {
      ssh_port: f.ssh_port || 22,
      ssh_user: f.ssh_user,
      ssh_password: f.ssh_password,
    });
  } else {
    if (!f.rsyncd_user || !f.rsyncd_password) {
      if (hint) { hint.textContent = 'Enter rsyncd user + password first.'; hint.dataset.kind = ''; }
      return;
    }
    Object.assign(body, {
      rsyncd_user: f.rsyncd_user,
      rsyncd_password: f.rsyncd_password,
    });
  }
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = 'Discovering…';
  if (hint) { hint.textContent = ''; hint.dataset.kind = ''; }
  try {
    const r = await fetch('/api/backup/list-rsync-modules', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    let j = {};
    try { j = await r.json(); } catch (_) {}
    if (!r.ok || !j.ok) {
      if (hint) {
        hint.textContent = 'Failed: ' + (j.error || j.detail || ('HTTP ' + r.status));
        hint.dataset.kind = 'err';
      }
      return;
    }
    const modules = j.modules || [];
    if (dl) {
      dl.innerHTML = '';
      for (const m of modules) {
        const o = document.createElement('option');
        o.value = m;
        dl.appendChild(o);
      }
    }
    if (hint) {
      if (modules.length === 0) {
        hint.textContent = 'No modules exposed for this account.';
        hint.dataset.kind = '';
      } else if (modules.length === 1 && moduleInput && !moduleInput.value) {
        // Only one module + the field is empty → auto-fill it.
        moduleInput.value = modules[0];
        hint.textContent = `Found 1 module — auto-filled.`;
        hint.dataset.kind = 'ok';
      } else {
        hint.textContent = `${modules.length} module${modules.length === 1 ? '' : 's'} available — click the field to pick.`;
        hint.dataset.kind = 'ok';
      }
    }
  } catch (err) {
    if (hint) {
      hint.textContent = 'Failed: ' + (err.message || err);
      hint.dataset.kind = 'err';
    }
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
});

$('backup-transport')?.addEventListener('change', () => {
  _applyBackupTransportVisibility();
  // Changing transport invalidates anything we cached about the form
  // (share lookup, last-tested signature) — let the auto-test wiring
  // pick up fresh on the next keystroke.
});

// Translate machine-readable error tokens from the backup module into
// something a normal human can act on. Anything not in this map gets
// shown verbatim (it's already a real error string from mount.cifs or
// smbclient).
function _backupHumaniseError(s) {
  if (!s) return 'unknown error';
  const map = {
    no_credentials: 'Enter NAS host, share, username, and password to test.',
  };
  return map[s] || s;
}

async function runBackupDiscovery({ force }) {
  const panel = $('backup-discover-panel');
  const list = $('backup-discover-list');
  const state = $('backup-discover-state');
  if (!panel || !list || !state) return;
  if (_backupDiscoveryRan && !force) {
    panel.hidden = false;
    return;
  }
  _backupDiscoveryRan = true;
  panel.hidden = false;
  state.textContent = 'Scanning your network…';
  state.dataset.kind = '';
  list.innerHTML = '';
  try {
    const r = await fetch('/api/backup/discover');
    const j = await r.json();
    const hosts = (j && j.hosts) || [];
    if (!hosts.length) {
      state.textContent = 'No SMB devices found. Type the NAS address below.';
      return;
    }
    state.textContent = `${hosts.length} device${hosts.length === 1 ? '' : 's'} found — click to use`;
    for (const h of hosts) {
      const li = document.createElement('li');
      const labelHost = h.name && h.name !== h.ip ? h.name : '';
      li.innerHTML = labelHost
        ? `<span class="nas-name"></span><span class="nas-ip"></span>`
        : `<span class="nas-ip"></span>`;
      const nameEl = li.querySelector('.nas-name');
      const ipEl = li.querySelector('.nas-ip');
      if (nameEl) nameEl.textContent = labelHost;
      if (ipEl) ipEl.textContent = h.ip;
      // Click chooses this host: prefer hostname when we have one (works
      // across IP changes if the NAS broadcasts a name) but fall back to
      // raw IP. Connectivity test will fire automatically once the user
      // adds username + password.
      li.addEventListener('click', () => {
        const hostInput = $('backup-host');
        if (hostInput) {
          hostInput.value = labelHost || h.ip;
          hostInput.dispatchEvent(new Event('input', { bubbles: true }));
        }
        // Hide the panel once a pick is made — it's served its purpose.
        panel.hidden = true;
        // If the user already typed creds, populating host should
        // immediately satisfy the auto-test guard; otherwise focus the
        // username field as the natural next step.
        const u = $('backup-username');
        if (u && !u.value) u.focus();
      });
      list.appendChild(li);
    }
  } catch (err) {
    state.textContent = 'Scan failed: ' + (err.message || err);
    state.dataset.kind = 'err';
  }
}

$('backup-discover-rescan')?.addEventListener('click', () => {
  runBackupDiscovery({ force: true });
});

// Share dropdown: as soon as host + username + password are all filled
// in, ask the server to enumerate shares on that host so the user can
// pick from a datalist instead of guessing the share name. Debounced
// the same way as the connectivity auto-test, but with its own signature
// so it doesn't double-fire alongside the test.
let _backupShareSig = '';
async function _maybeLoadShares() {
  const f = _readBackupForm();
  // Share enumeration uses smbclient -L, so it's SMB-specific. Other
  // transports don't have a "share" concept and the auto-test wiring
  // skips this for non-SMB anyway, but be defensive in case a caller
  // invokes _maybeLoadShares() directly.
  if (f.transport !== 'smb') return;
  if (!f.host || !f.username || !f.password) return;
  const sig = `${f.host}|${f.username}|${f.password}|${f.domain}`;
  if (sig === _backupShareSig) return;
  _backupShareSig = sig;
  const dl = $('backup-share-options');
  const hint = $('backup-share-hint');
  if (!dl) return;
  if (hint) { hint.textContent = 'Looking up available shares…'; hint.dataset.kind = ''; }
  try {
    const r = await fetch('/api/backup/list-shares', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        host: f.host, username: f.username,
        password: f.password, domain: f.domain,
      }),
    });
    let j = {};
    try { j = await r.json(); } catch (_) {}
    if (!r.ok || !j.ok) {
      // Non-fatal: user can still type the share name manually.
      if (hint) {
        hint.textContent = 'Couldn\u2019t list shares (' + (j.error || j.detail || ('HTTP ' + r.status)) + ') \u2014 type it manually.';
        hint.dataset.kind = '';
      }
      return;
    }
    const shares = j.shares || [];
    dl.innerHTML = '';
    for (const name of shares) {
      const opt = document.createElement('option');
      opt.value = name;
      dl.appendChild(opt);
    }
    if (hint) {
      if (shares.length) {
        hint.textContent = `${shares.length} share${shares.length === 1 ? '' : 's'} available — click the field to pick.`;
        hint.dataset.kind = 'ok';
      } else {
        hint.textContent = 'No shares listed for this account.';
        hint.dataset.kind = '';
      }
    }
  } catch (err) {
    if (hint) { hint.textContent = 'Share lookup failed: ' + (err.message || err); hint.dataset.kind = ''; }
  }
}

function _backupSetMsg(id, text, kind) {
  // kind: '', 'ok', 'err'. We just toggle inline color; styles in style.css.
  const el = $(id);
  if (!el) return;
  if (!text) { el.hidden = true; el.textContent = ''; el.dataset.kind = ''; return; }
  el.hidden = false;
  el.textContent = text;
  el.dataset.kind = kind || '';
}

async function loadBackupCreds() {
  const status = $('backup-creds-status');
  if (!status) return;
  try {
    const r = await fetch('/api/backup/credentials');
    const j = await r.json();
    _backupHasCreds = !!j.has_credentials;
    if (j.has_credentials && j.remote) {
      const remote = j.remote;
      const transport = remote.transport || 'smb';

      // Build a transport-aware "saved · <where>" status line so the
      // user can tell at a glance which destination is configured.
      let saved_label;
      if (transport === 'smb') {
        saved_label = `saved · \\\\${remote.host || '?'}\\${remote.share || '?'}`;
      } else if (transport === 'rsync_ssh') {
        saved_label = `saved · ${remote.ssh_user || '?'}@${remote.host || '?'}:${remote.target_dir || ''}`;
      } else if (transport === 'rsyncd') {
        const sub = remote.target_subpath ? `/${remote.target_subpath}` : '';
        saved_label = `saved · rsync://${remote.rsyncd_user || '?'}@${remote.host || '?'}/${remote.rsync_module || '?'}${sub}`;
      } else {
        saved_label = `saved · ${remote.host || '?'}`;
      }
      status.textContent = saved_label;

      // Set the transport selector and apply visibility BEFORE
      // populating fields so hidden rows don't end up with stale data.
      const sel = $('backup-transport');
      if (sel) {
        sel.value = transport;
        _applyBackupTransportVisibility();
      }

      // Pre-fill non-secret fields from the saved record so users can
      // edit a single field without re-typing everything. Secrets
      // (password / ssh_key / rsyncd_password) are never echoed back
      // from the server — the user re-pastes them when re-saving.
      const setIfEmpty = (id, value) => {
        const el = $(id);
        if (!el) return;
        if (!el.value || el.dataset.fromSaved === '1') {
          el.value = value || '';
          el.dataset.fromSaved = '1';
        }
      };
      setIfEmpty('backup-host', remote.host);
      if (transport === 'smb') {
        setIfEmpty('backup-share', remote.share);
        setIfEmpty('backup-subdir', remote.subdir || 'jackery-monitor');
        setIfEmpty('backup-username', remote.username);
        setIfEmpty('backup-domain', remote.domain || 'WORKGROUP');
      } else if (transport === 'rsync_ssh') {
        setIfEmpty('backup-ssh-user', remote.ssh_user);
        setIfEmpty('backup-target-dir', remote.target_dir);
      } else if (transport === 'rsyncd') {
        setIfEmpty('backup-rsync-module', remote.rsync_module);
        setIfEmpty('backup-target-subpath', remote.target_subpath);
        setIfEmpty('backup-rsyncd-user', remote.rsyncd_user);
      } else if (transport === 'rsyncd_ssh') {
        setIfEmpty('backup-ssh-user', remote.ssh_user);
        setIfEmpty('backup-ssh-port', String(remote.ssh_port || 22));
        setIfEmpty('backup-rsync-module', remote.rsync_module);
        setIfEmpty('backup-target-subpath', remote.target_subpath);
      }
      $('backup-state-line').textContent = 'Destination configured. Daily backup will run automatically.';
    } else {
      status.textContent = 'not configured';
      $('backup-state-line').textContent = 'No destination saved yet — fill in the form below and Test before saving.';
      _applyBackupTransportVisibility();
    }
  } catch (e) {
    status.textContent = 'failed to load';
  }
}

document.getElementById('backup-creds-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  _backupSetMsg('backup-creds-msg', 'Saving…', '');
  const body = _readBackupForm();
  // Validate per-transport required fields up-front so the user gets
  // a meaningful inline message instead of a 400 from the server.
  const required = _BACKUP_REQUIRED_FIELDS[body.transport] || [];
  const missing = required.filter(k => !body[k]);
  if (missing.length) {
    const labelMap = {
      password: 'Password',
      ssh_key: 'SSH private key',
      ssh_password: 'SSH password',
      rsyncd_password: 'rsyncd password',
      ssh_user: 'SSH user',
      target_dir: 'Target directory',
      rsync_module: 'rsync module',
      rsyncd_user: 'rsyncd user',
      host: 'Host',
      share: 'Share',
      username: 'Username',
    };
    const human = missing.map(k => labelMap[k] || k).join(', ');
    _backupSetMsg('backup-creds-msg',
      `Missing required field${missing.length === 1 ? '' : 's'}: ${human}.`, 'err');
    return;
  }
  try {
    const r = await fetch('/api/backup/credentials', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    let j = {};
    try { j = await r.json(); } catch (_) {}
    if (!r.ok) throw new Error(j.detail || j.error || ('HTTP ' + r.status));
    _backupSetMsg('backup-creds-msg', 'Saved.', 'ok');
    // Clear secret fields so they're not left in the DOM after save.
    // Non-secrets are repopulated from the server response, so leaving
    // those alone is fine.
    ['backup-password', 'backup-ssh-key', 'backup-rsyncd-password']
      .forEach(id => { const el = $(id); if (el) el.value = ''; });
    setTimeout(() => _backupSetMsg('backup-creds-msg', '', ''), 2000);
    loadBackupCreds();
    loadBackupStatus();
  } catch (err) {
    _backupSetMsg('backup-creds-msg', 'Failed: ' + (err.message || err), 'err');
  }
});

// Shared connectivity-test runner. `mode` controls how we treat partial
// form input: 'manual' (button click) tests saved creds when the form is
// blank; 'auto' (live debounce) only runs when the form is fully filled
// in to avoid noisy errors mid-typing.
async function _runBackupTest(mode = 'manual') {
  const formBody = _readBackupForm();
  const required = _BACKUP_REQUIRED_FIELDS[formBody.transport] || [];
  const completeForm = required.every(k => !!formBody[k]);
  if (mode === 'auto' && !completeForm) {
    // Quietly do nothing while the user is still typing.
    return;
  }
  // The /api/backup/test endpoint requires either a complete creds set in
  // the body OR no body at all (in which case it uses the saved creds).
  const body = completeForm ? formBody : {};
  _backupSetMsg('backup-creds-msg', 'Testing connection…', '');
  try {
    const r = await fetch('/api/backup/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    let j = {};
    try { j = await r.json(); } catch (_) { /* non-JSON body */ }
    if (r.ok && j.ok) {
      const ms = (j.latency_ms != null) ? ` (${j.latency_ms} ms)` : '';
      _backupSetMsg('backup-creds-msg', `OK — write/read probe succeeded${ms}.`, 'ok');
    } else {
      // FastAPI HTTPException returns {detail: "..."} on 4xx/5xx; our own
      // ok:false body uses {error: "..."}. Try both, then HTTP status, so
      // the user always sees something specific.
      const reason = _backupHumaniseError(j.error || j.detail || `HTTP ${r.status}`);
      _backupSetMsg('backup-creds-msg', 'Failed: ' + reason, 'err');
    }
  } catch (err) {
    _backupSetMsg('backup-creds-msg', 'Failed: ' + (err.message || err), 'err');
  }
}

$('backup-test')?.addEventListener('click', () => _runBackupTest('manual'));

// Live auto-test: as soon as the per-transport required fields are all
// non-empty, fire a connectivity check 700ms after the last keystroke.
// The debounce keeps us from hammering the NAS while the user is still
// typing and keeps the message line stable.
(function _wireBackupAutoTest() {
  let testTimer = null;
  let shareTimer = null;
  let lastSig = '';
  function schedule() {
    const f = _readBackupForm();
    // SMB share lookup is SMB-only; schedule it independently of the
    // connectivity test (which uses the full per-transport field set).
    if (f.transport === 'smb' && f.host && f.username && f.password) {
      if (shareTimer) clearTimeout(shareTimer);
      shareTimer = setTimeout(() => _maybeLoadShares(), 700);
    }
    const required = _BACKUP_REQUIRED_FIELDS[f.transport] || [];
    if (!required.every(k => !!f[k])) return;
    // JSON-stringify the body for the change-detection signature so
    // adding new transports doesn't require a custom join() format.
    const sig = JSON.stringify(f);
    if (sig === lastSig) return;
    lastSig = sig;
    if (testTimer) clearTimeout(testTimer);
    testTimer = setTimeout(() => _runBackupTest('auto'), 700);
  }
  // Listen on every transport's inputs + the transport selector
  // itself, so switching transports + filling the new fields fires
  // the auto-test on the next idle window.
  _ALL_BACKUP_INPUT_IDS.forEach(id => {
    const el = $(id);
    if (!el) return;
    const evt = (el.tagName === 'SELECT') ? 'change' : 'input';
    el.addEventListener(evt, schedule);
  });
})();

$('backup-clear')?.addEventListener('click', async () => {
  if (!confirm('Forget saved backup destination? Daily backups will stop until new credentials are saved.')) return;
  await fetch('/api/backup/credentials', { method: 'DELETE' });
  // Wipe every transport's input so a re-save starts from a clean form.
  _ALL_BACKUP_INPUT_IDS.forEach(id => {
    const el = $(id);
    if (!el) return;
    el.value = '';
    delete el.dataset.fromSaved;
  });
  // Restore defaults for fields with non-empty placeholders.
  if ($('backup-subdir')) $('backup-subdir').value = 'jackery-monitor';
  if ($('backup-domain')) $('backup-domain').value = 'WORKGROUP';
  if ($('backup-transport')) $('backup-transport').value = 'smb';
  _applyBackupTransportVisibility();
  loadBackupCreds();
  loadBackupStatus();
});

// Read the form into a creds body shaped for the API. Returns only the
// fields relevant to the currently-selected transport so unused fields
// from a previous transport don't sneak into the JSON body. `transport`
// is always present and used by the server to dispatch.
function _readBackupForm() {
  const transport = _backupTransport();
  const base = {
    transport,
    host: ($('backup-host')?.value || '').trim(),
  };
  if (transport === 'smb') {
    return {
      ...base,
      share: ($('backup-share')?.value || '').trim(),
      subdir: ($('backup-subdir')?.value || '').trim() || 'jackery-monitor',
      username: ($('backup-username')?.value || '').trim(),
      password: $('backup-password')?.value || '',
      domain: ($('backup-domain')?.value || '').trim() || 'WORKGROUP',
    };
  }
  if (transport === 'rsync_ssh') {
    return {
      ...base,
      ssh_user: ($('backup-ssh-user')?.value || '').trim(),
      target_dir: ($('backup-target-dir')?.value || '').trim(),
      // Don't .trim() ssh_key — leading/trailing whitespace in a key
      // can change its identity and break the saved value.
      ssh_key: $('backup-ssh-key')?.value || '',
    };
  }
  if (transport === 'rsyncd') {
    return {
      ...base,
      rsync_module: ($('backup-rsync-module')?.value || '').trim(),
      target_subpath: ($('backup-target-subpath')?.value || '').trim(),
      rsyncd_user: ($('backup-rsyncd-user')?.value || '').trim(),
      rsyncd_password: $('backup-rsyncd-password')?.value || '',
    };
  }
  if (transport === 'rsyncd_ssh') {
    return {
      ...base,
      ssh_port: parseInt($('backup-ssh-port')?.value, 10) || 22,
      ssh_user: ($('backup-ssh-user')?.value || '').trim(),
      ssh_password: $('backup-ssh-password')?.value || '',
      rsync_module: ($('backup-rsync-module')?.value || '').trim(),
      target_subpath: ($('backup-target-subpath')?.value || '').trim(),
    };
  }
  return base;
}

async function loadBackupStatus() {
  const wrap = $('backup-runs');
  if (!wrap) return;
  try {
    const r = await fetch('/api/backup/status');
    const j = await r.json();
    const runs = j.runs || [];
    if (j.last_ok_ts) {
      const d = new Date(j.last_ok_ts * 1000);
      $('backup-last-line').textContent = 'Last successful backup: ' + d.toLocaleString();
    } else if (j.configured) {
      $('backup-last-line').textContent = 'No successful backup yet.';
    } else {
      $('backup-last-line').textContent = 'No destination configured.';
    }
    if (!runs.length) {
      wrap.innerHTML = '<div class="hint">No runs yet. Save credentials and click <strong>Run now</strong> to validate.</div>';
      return;
    }
    wrap.innerHTML = runs.map(_renderBackupRunRow).join('');
  } catch (e) {
    wrap.innerHTML = '<div class="hint">Failed to load status.</div>';
  }
}

function _renderBackupRunRow(run) {
  const ts = run.iso || (run.ts ? new Date(run.ts * 1000).toLocaleString() : '?');
  const ok = !!run.ok;
  const skipped = run.skipped_reason ? ` (skipped: ${run.skipped_reason})` : '';
  const dur = (run.duration_s != null) ? `${run.duration_s.toFixed(1)}s` : '—';
  const bytes = run.bytes_written ? _fmtBytes(run.bytes_written) : '—';
  const files = run.files_written != null ? `${run.files_written} files` : '—';
  const tag = ok
    ? '<span class="backup-pill backup-pill-ok">success</span>'
    : (run.skipped_reason
        ? '<span class="backup-pill backup-pill-warn">skipped</span>'
        : '<span class="backup-pill backup-pill-err">failed</span>');
  const detail = ok
    ? `${files} · ${bytes} · ${dur}`
    : (run.error ? `error: ${run.error}` : skipped || 'unknown failure');
  return `<div class="backup-run">
    <div class="backup-run-head">${tag}<span class="backup-run-ts">${ts}</span></div>
    <div class="backup-run-body">${detail}</div>
  </div>`;
}

function _fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n/1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n/(1024*1024)).toFixed(1)} MB`;
  return `${(n/(1024*1024*1024)).toFixed(2)} GB`;
}

$('backup-status-reload')?.addEventListener('click', loadBackupStatus);

// Shared on-demand backup runner. Supports both the inline button (in the
// credentials card, feedback in `backup-creds-msg`) and the original
// button in the Status & history card (feedback in `backup-run-msg`).
async function _triggerBackupNow(btnId, msgId) {
  const btn = $(btnId);
  if (!btn) return;
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Running…';
  _backupSetMsg(msgId, 'Backup in progress — this may take a minute over slow links.', '');
  try {
    const r = await fetch('/api/backup/run', { method: 'POST' });
    let j = {};
    try { j = await r.json(); } catch (_) {}
    if (r.ok && j.ok) {
      _backupSetMsg(msgId, `OK — wrote ${j.files_written} files (${_fmtBytes(j.bytes_written || 0)}).`, 'ok');
    } else if (j.skipped_reason) {
      _backupSetMsg(msgId, `Skipped: ${j.skipped_reason}`, 'err');
    } else {
      const reason = j.error || j.detail || `HTTP ${r.status}`;
      _backupSetMsg(msgId, 'Failed: ' + reason, 'err');
    }
  } catch (err) {
    _backupSetMsg(msgId, 'Failed: ' + (err.message || err), 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = original;
    loadBackupStatus();
  }
}

$('backup-run-now')?.addEventListener('click',
  () => _triggerBackupNow('backup-run-now', 'backup-run-msg'));
$('backup-run-now-inline')?.addEventListener('click',
  () => _triggerBackupNow('backup-run-now-inline', 'backup-creds-msg'));

// Generic debounced auto-save for one numeric backup setting. Both the
// daily-hour input and the retention input use this — the only thing
// that changes per setting is the key, the bounds, and the formatter
// for the success message. Keeps the keystroke -> /api/settings POST
// throttled to one call per 500ms idle window.
function _wireBackupNumericSetting(inputId, msgId, settingKey, opts) {
  const el = $(inputId);
  if (!el) return;
  let timer = null;
  el.addEventListener('input', () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      const n = Number(el.value);
      if (!Number.isInteger(n) || n < opts.min || n > opts.max) {
        _backupSetMsg(msgId, opts.outOfRangeMsg, 'err');
        return;
      }
      _backupSetMsg(msgId, 'Saving…', '');
      try {
        const r = await fetch('/api/settings', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ [settingKey]: n }),
        });
        if (!r.ok) {
          let j = {};
          try { j = await r.json(); } catch (_) {}
          throw new Error(j.detail || j.error || ('HTTP ' + r.status));
        }
        _backupSetMsg(msgId, opts.okMsg(n), 'ok');
        setTimeout(() => _backupSetMsg(msgId, '', ''), 2500);
      } catch (err) {
        _backupSetMsg(msgId, 'Save failed: ' + (err.message || err), 'err');
      }
    }, 500);
  });
}

_wireBackupNumericSetting('backup-schedule-hour', 'backup-schedule-msg',
  'backup_schedule_hour', {
    min: 0, max: 23,
    outOfRangeMsg: 'Hour must be 0–23.',
    okMsg: (n) => `Saved — next run at ${String(n).padStart(2, '0')}:00.`,
  });

_wireBackupNumericSetting('backup-keep-count', 'backup-keep-msg',
  'backup_keep_count', {
    min: 1, max: 3650,
    outOfRangeMsg: 'Must be between 1 and 3650.',
    okMsg: (n) => `Saved — keeping ${n} snapshot${n === 1 ? '' : 's'}.`,
  });

// One-time: apply the initial transport visibility now so the hidden
// rsync rows are correctly hidden on first paint, before loadBackupCreds
// fires and possibly re-applies. Subsequent transport changes go
// through _applyBackupTransportVisibility() via the change handler
// registered above.
_applyBackupTransportVisibility();

async function loadBackupSchedule() {
  const hourEl = $('backup-schedule-hour');
  const keepEl = $('backup-keep-count');
  if ((!hourEl || hourEl.dataset.loaded === '1')
      && (!keepEl || keepEl.dataset.loaded === '1')) return;
  try {
    const r = await fetch('/api/settings');
    const j = await r.json();
    // /api/settings returns {settings: [{key, value, label, hint, ...}]}
    const byKey = Object.fromEntries(
      (j?.settings || []).map(s => [s.key, s]));
    const hourEntry = byKey['backup_schedule_hour'];
    if (hourEl && hourEntry && hourEntry.value != null) {
      hourEl.value = String(hourEntry.value);
      hourEl.dataset.loaded = '1';
    }
    const keepEntry = byKey['backup_keep_count'];
    if (keepEl && keepEntry && keepEntry.value != null) {
      keepEl.value = String(keepEntry.value);
      keepEl.dataset.loaded = '1';
    }
  } catch (_) { /* leave blank — user can still type */ }
}

// ---- snapshots / restore --------------------------------------------------

$('backup-snapshots-reload')?.addEventListener('click', loadBackupSnapshots);

async function loadBackupSnapshots() {
  const wrap = $('backup-snapshots');
  if (!wrap) return;
  wrap.innerHTML = '<div class="hint">Mounting remote and listing snapshots…</div>';
  try {
    const r = await fetch('/api/backup/snapshots');
    const j = await r.json();
    if (!r.ok) throw new Error(j.detail || j.error || ('HTTP ' + r.status));
    const snaps = j.snapshots || [];
    if (!snaps.length) {
      wrap.innerHTML = '<div class="hint">No snapshots found at the destination yet.</div>';
      return;
    }
    wrap.innerHTML = snaps.map(_renderSnapshotRow).join('');
    // Wire up the per-row controls.
    wrap.querySelectorAll('[data-restore-snap]').forEach(btn => {
      btn.addEventListener('click', () => _doRestore(btn.dataset.restoreSnap, btn));
    });
    wrap.querySelectorAll('[data-toggle-files]').forEach(btn => {
      btn.addEventListener('click', () => {
        const target = wrap.querySelector(`[data-files-for="${btn.dataset.toggleFiles}"]`);
        if (target) target.toggleAttribute('hidden');
      });
    });
  } catch (err) {
    wrap.innerHTML = `<div class="hint">Failed to list snapshots: ${escapeHtml(err.message || err)}</div>`;
  }
}

function _renderSnapshotRow(s) {
  if (!s.valid) {
    return `<div class="backup-snap backup-snap-bad">
      <div class="backup-snap-head">${s.dir}</div>
      <div class="backup-snap-body">Invalid snapshot: ${s.error || 'manifest unreadable'}</div>
    </div>`;
  }
  const bytes = s.total_bytes ? _fmtBytes(s.total_bytes) : '—';
  const files = (s.files || []).length;
  const ts = s.iso || s.dir;
  const filesEsc = (s.files || []).map(f => f.replace(/[<>&"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]))).join(', ');
  return `<div class="backup-snap">
    <div class="backup-snap-head">
      <strong>${ts}</strong>
      <span class="hint">${files} files · ${bytes}</span>
    </div>
    <div class="backup-snap-body">
      <label class="hint" style="display:flex; gap:6px; align-items:center; margin-bottom:8px">
        <input type="checkbox" class="backup-snap-selective" data-snap="${s.dir}" />
        Selective restore (pick files)
      </label>
      <div class="backup-snap-files" data-files-for="${s.dir}" hidden>
        <div class="hint" style="margin-bottom:6px">Uncheck files you don't want to restore:</div>
        ${(s.files || []).map(f => `<label class="backup-file-pick"><input type="checkbox" class="backup-file-cb" data-snap="${s.dir}" value="${f}" checked> <code>${f}</code></label>`).join('')}
      </div>
      <button class="btn btn-ghost" type="button" data-toggle-files="${s.dir}">Show files (${filesEsc.length > 0 ? files : 0})</button>
      <button class="btn btn-primary" type="button" data-restore-snap="${s.dir}" style="margin-left:8px">Restore this snapshot</button>
    </div>
  </div>`;
}

async function _doRestore(snapDir, btn) {
  // Selective vs full is picked per-row via the "Selective restore" checkbox.
  const wrap = $('backup-snapshots');
  const selective = wrap.querySelector(`.backup-snap-selective[data-snap="${snapDir}"]`)?.checked;
  let scope;
  if (selective) {
    const checked = Array.from(wrap.querySelectorAll(`.backup-file-cb[data-snap="${snapDir}"]:checked`)).map(cb => cb.value);
    if (!checked.length) {
      _backupSetMsg('backup-restore-msg', 'Pick at least one file for selective restore.', 'err');
      return;
    }
    scope = { files: checked };
  } else {
    scope = { full: true };
  }
  const label = scope.full ? 'a full restore' : `restore of ${scope.files.length} file(s)`;
  if (!confirm(`Run ${label} from snapshot ${snapDir}?\n\nThis overwrites the corresponding files in /data on this device.`)) return;
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = 'Restoring…';
  _backupSetMsg('backup-restore-msg', 'Restore in progress…', '');
  try {
    const r = await fetch('/api/backup/restore', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ snapshot: snapDir, scope }),
    });
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error(j.detail || j.error || ('HTTP ' + r.status));
    const restoredList = j.restored_files || [];
    const n = restoredList.length;
    _backupSetMsg('backup-restore-msg', `Restored ${n} file(s). Reload the page to pick up restored settings.`, 'ok');
  } catch (err) {
    _backupSetMsg('backup-restore-msg', 'Failed: ' + (err.message || err), 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}
