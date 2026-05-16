// Popup controller. Reads/writes settings to chrome.storage.local and talks
// to the background SW over a long-lived port for live download progress.

// Whatever the parent types in the popup IS the system instruction that
// reaches Gemma — nothing is prepended or appended. Defaults must therefore
// include format + digit meanings, not just the "what to flag" directive.
const DEFAULT_PROMPT =
  "You are a friendly content moderator helping a child of around 10 years old browse the web safely on behalf of a parent.\n\n" +
  "Output format — exactly two lines, nothing else:\n" +
  "Line 1: a single digit (0, 1, or 2)\n" +
  "Line 2: a short reasoning for your digit selection to the child\n\n" +
  "1 = content is explicitly unsafe or inappropriate for a child around age 10, including suggestive image, sexual content, sexual slang, nudity, graphic violence, weapon, threats, self-harm instructions, bullying, harassment, hate, drugs/alcohol, gambling, scams, frightening content, or adult themes\n\n" +
  "2 = content mentions one of those same sensitive topics in an educational, historical, news, health, safety, or age-appropriate way that a parent may want to discuss with their child\n\n" +
  "else 0";

const DEFAULTS = {
  enabled: true,
  screeningMode: 'balanced',
  prompt: DEFAULT_PROMPT,
  processMode: 'sequence',
  contentTypes: { text: true, image: true },
  image: { maxWidth: 500, maxHeight: 500, quality: 0.85 },
  debug: false,
  dtype: 'q4',
  manuallyDisabled: false,
};

const $ = (id) => document.getElementById(id);

const ui = {
  prompt: $('prompt'),
  enabled: $('enabled'),
  screeningMode: $('screeningMode'),
  screeningNote: $('screening-note'),
  processMode: $('processMode'),
  ctText: $('ct-text'),
  ctImage: $('ct-image'),
  dtype: $('dtype'),
  debug: $('debug'),
  btnResetPrompt: $('btn-reset-prompt'),
  btnLoad: $('btn-load'),
  btnUnload: $('btn-unload'),
  statusDot: $('status-dot'),
  statusText: $('status-text'),
  statusSource: $('status-source'),
  progressFill: $('progress-fill'),
  progressPercent: $('progress-percent'),
  progressFile: $('progress-file'),
  saveState: $('save-state'),
  statTotal: $('stat-total'),
  statText: $('stat-text'),
  statImage: $('stat-image'),
  statSensitive: $('stat-sensitive'),
  statBlur: $('stat-blur'),
  statBlur2: $('stat-blur-2'),
  statHighlight: $('stat-highlight'),
  statHighlight2: $('stat-highlight-2'),
  statClear: $('stat-clear'),
  statTps: $('stat-tps'),
  statInference: $('stat-inference'),
  statFresh: $('stat-fresh'),
  pieClear: $('pie-clear'),
  pieBlur: $('pie-blur'),
  pieHighlight: $('pie-highlight'),
};

let saveTimer = null;
let imageSettings = { ...DEFAULTS.image };
let manuallyDisabled = false;

function markSaving() {
  ui.saveState.textContent = 'Saving…';
  ui.saveState.classList.remove('error');
  ui.saveState.classList.add('saving');
}
function markSaved() {
  ui.saveState.textContent = 'Saved.';
  ui.saveState.classList.remove('saving');
  ui.saveState.classList.remove('error');
}
function markPromptError() {
  ui.saveState.textContent = 'Prompt required. Extension off.';
  ui.saveState.classList.remove('saving');
  ui.saveState.classList.add('error');
}

function hasPrompt() {
  return ui.prompt.value.trim().length > 0;
}

function syncEnabledFromPrompt() {
  if (!hasPrompt()) {
    ui.enabled.checked = false;
    manuallyDisabled = false;
    markPromptError();
    return;
  }
  if (!manuallyDisabled) ui.enabled.checked = true;
}

function readUiToSettings() {
  const prompt = ui.prompt.value.trim();
  const promptPresent = prompt.length > 0;
  return {
    prompt,
    enabled: promptPresent && ui.enabled.checked,
    manuallyDisabled: promptPresent && manuallyDisabled,
    screeningMode: ui.screeningMode.checked ? 'strict' : 'balanced',
    processMode: ui.processMode.value,
    contentTypes: {
      text: ui.ctText.checked,
      image: ui.ctImage.checked,
    },
    image: { ...imageSettings },
    debug: ui.debug.checked,
    dtype: ui.dtype.value,
  };
}

function writeSettingsToUi(s) {
  imageSettings = { ...DEFAULTS.image, ...(s.image || {}) };
  ui.prompt.value = s.prompt ?? DEFAULTS.prompt;
  manuallyDisabled = !!s.manuallyDisabled || (s.enabled === false && !!ui.prompt.value.trim());
  ui.enabled.checked = !!ui.prompt.value.trim() && s.enabled !== false;
  if (!ui.prompt.value.trim()) markPromptError();
  ui.screeningMode.checked = (s.screeningMode ?? DEFAULTS.screeningMode) === 'strict';
  updateScreeningNote();
  ui.processMode.value = s.processMode ?? DEFAULTS.processMode;
  ui.ctText.checked = s.contentTypes?.text !== false;
  ui.ctImage.checked = s.contentTypes?.image !== false;
  ui.dtype.value = s.dtype ?? DEFAULTS.dtype;
  ui.debug.checked = s.debug ?? DEFAULTS.debug;
}

function persist() {
  syncEnabledFromPrompt();
  markSaving();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    chrome.storage.local.set({ settings: readUiToSettings() }, () => {
      if (hasPrompt()) markSaved();
      else markPromptError();
    });
  }, 250);
}

function persistNow() {
  syncEnabledFromPrompt();
  markSaving();
  clearTimeout(saveTimer);
  chrome.storage.local.set({ settings: readUiToSettings() }, () => {
    if (hasPrompt()) markSaved();
    else markPromptError();
  });
}

// ─── Initial load ─────────────────────────────────────────────────────────────

(async function init() {
  const { settings = {} } = await chrome.storage.local.get('settings');
  writeSettingsToUi({ ...DEFAULTS, ...settings });
  if (settings.prompt == null || !hasPrompt()) persistNow();

  ui.prompt.addEventListener('input', persist);
  ui.prompt.addEventListener('change', persist);

  for (const el of [ui.processMode, ui.screeningMode, ui.dtype]) {
    el.addEventListener('input', persist);
    el.addEventListener('change', persist);
  }
  ui.screeningMode.addEventListener('change', updateScreeningNote);
  ui.enabled.addEventListener('change', () => {
    if (!hasPrompt()) {
      ui.enabled.checked = false;
      manuallyDisabled = false;
      persistNow();
      return;
    }
    manuallyDisabled = !ui.enabled.checked;
    persistNow();
  });
  for (const el of [ui.ctText, ui.ctImage, ui.debug]) {
    el.addEventListener('change', persist);
  }

  ui.btnResetPrompt.addEventListener('click', () => {
    ui.prompt.value = DEFAULT_PROMPT;
    if (!manuallyDisabled) ui.enabled.checked = true;
    persistNow();
  });

  ui.btnLoad.addEventListener('click', () => {
    // Save settings (e.g. dtype) before kicking off load.
    syncEnabledFromPrompt();
    chrome.storage.local.set({ settings: readUiToSettings() }, () => {
      if (hasPrompt()) markSaved();
      else markPromptError();
      ui.btnLoad.disabled = true;
      chrome.runtime.sendMessage({ type: 'load-model' }, (res) => {
        ui.btnLoad.disabled = false;
        if (res && res.ok === false) {
          renderStatus({ status: 'error', error: res.error });
        }
      });
    });
  });

  ui.btnUnload.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'unload-model' }, () => {
      renderStatus({ status: 'idle', percent: 0 });
    });
  });

  // Pull initial status.
  chrome.runtime.sendMessage({ type: 'get-status' }, (res) => {
    if (res?.progress) renderStatus(res.progress, res.loaded);
  });

  chrome.runtime.sendMessage({ type: 'get-scan-stats' }, (res) => {
    if (res?.stats) renderStats(res.stats);
  });
  setInterval(refreshStats, 1000);

  // Live progress over a port.
  const port = chrome.runtime.connect({ name: 'safescroll-popup' });
  port.onMessage.addListener((msg) => {
    if (msg.type === 'progress') renderStatus(msg.progress);
    if (msg.type === 'scan-stats') renderStats(msg.stats);
  });
})();

function refreshStats() {
  chrome.runtime.sendMessage({ type: 'get-scan-stats' }, (res) => {
    if (res?.stats) renderStats(res.stats);
  });
}

function updateScreeningNote() {
  if (!ui.screeningNote) return;
  ui.screeningNote.textContent = ui.screeningMode.checked
    ? 'Strict mode keeps blurred elements locked.'
    : 'Blurred elements can be viewed anyway in balanced mode.';
}

function renderStatus(p, loaded) {
  if (!p) return;
  const pct = Math.max(0, Math.min(100, p.percent || 0));
  ui.progressFill.style.width = pct + '%';
  ui.progressPercent.textContent = pct + '%';
  ui.progressFile.textContent = p.file || '';

  ui.statusDot.classList.remove('ready', 'loading', 'error');
  ui.statusSource.textContent = '';

  switch (p.status) {
    case 'idle':
      ui.statusText.textContent = loaded ? 'Loaded' : 'Not loaded';
      if (loaded) ui.statusDot.classList.add('ready');
      break;
    case 'checking':
      ui.statusText.textContent = 'Checking…';
      ui.statusDot.classList.add('loading');
      break;
    case 'downloading':
      ui.statusText.textContent = pct >= 100 ? 'Initializing model…' : 'Downloading model';
      ui.statusDot.classList.add('loading');
      if (p.source) ui.statusSource.textContent = p.source;
      break;
    case 'initializing':
      ui.statusText.textContent = 'Initializing model…';
      ui.statusDot.classList.add('loading');
      if (p.source) ui.statusSource.textContent = p.source;
      break;
    case 'ready':
      ui.statusText.textContent = 'Ready';
      ui.statusDot.classList.add('ready');
      if (p.source) ui.statusSource.textContent = p.source;
      break;
    case 'error':
      ui.statusText.textContent = 'Error: ' + (p.error || 'unknown');
      ui.statusDot.classList.add('error');
      break;
    default:
      ui.statusText.textContent = p.status || '—';
  }
}

function setText(el, value) {
  if (el) el.textContent = value;
}

function polarToCartesian(cx, cy, radius, angle) {
  const radians = (angle - 90) * Math.PI / 180;
  return {
    x: cx + radius * Math.cos(radians),
    y: cy + radius * Math.sin(radians),
  };
}

function describeSlice(cx, cy, radius, startAngle, endAngle) {
  const span = endAngle - startAngle;
  if (span <= 0.001) return '';
  if (span >= 359.999) {
    return `M ${cx} ${cy - radius} A ${radius} ${radius} 0 1 1 ${cx - 0.01} ${cy - radius} Z`;
  }
  const start = polarToCartesian(cx, cy, radius, startAngle);
  const end = polarToCartesian(cx, cy, radius, endAngle);
  const largeArc = span > 180 ? 1 : 0;
  return `M ${cx} ${cy} L ${start.x} ${start.y} A ${radius} ${radius} 0 ${largeArc} 1 ${end.x} ${end.y} Z`;
}

function renderPie(clear, blur, highlight) {
  const total = clear + blur + highlight;
  const slices = [
    { value: clear, path: ui.pieClear },
    { value: blur, path: ui.pieBlur },
    { value: highlight, path: ui.pieHighlight },
  ];
  let angle = 0;
  for (const slice of slices) {
    const start = angle;
    const end = total > 0 ? angle + (slice.value / total) * 360 : angle;
    if (slice.path) slice.path.setAttribute('d', total > 0 ? describeSlice(75, 75, 63, start, end) : '');
    angle = end;
  }
}

function renderStats(stats) {
  if (!stats) return;
  const byAction = stats.byAction || {};
  const byType = stats.byContentType || {};
  const clear = byAction[0] || 0;
  const blur = byAction[1] || 0;
  const highlight = byAction[2] || 0;
  const total = stats.processed || stats.total || (clear + blur + highlight);

  setText(ui.statTotal, total);
  setText(ui.statText, byType.text || 0);
  setText(ui.statImage, byType.image || 0);
  setText(ui.statSensitive, stats.sensitive || (blur + highlight));
  setText(ui.statBlur, blur);
  setText(ui.statBlur2, blur);
  setText(ui.statHighlight, highlight);
  setText(ui.statHighlight2, highlight);
  setText(ui.statClear, clear);
  setText(ui.statTps, Number(stats.avgTokensPerSec || 0).toFixed(1));
  setText(ui.statInference, Math.round(stats.avgInferenceMs || 0));
  setText(ui.statFresh, stats.fresh || 0);

  renderPie(clear, blur, highlight);
}
