// Safe Scroll background service worker — pure router.
//
// MV3 SWs lack XMLHttpRequest, can't compile WASM under the default CSP, and
// have no DOM, so they can't host transformers.js / onnxruntime-web. The
// pipeline lives in offscreen/offscreen.js. This file just routes:
//
//   content script ──(scan)──▶ bg ──(target:'offscreen')──▶ offscreen
//                  ◀─────────────── result ─────────────────
//
//   popup ──(load-model / get-status / unload-model)──▶ bg ──▶ offscreen
//        ◀──────────── progress events (port) ──────── bg ◀── offscreen

const OFFSCREEN_PATH = 'offscreen/offscreen.html';

const DEFAULT_SETTINGS = {
  enabled: true,
  screeningMode: 'balanced',
  prompt: '',
  processMode: 'sequence',
  contentTypes: { text: true, image: true },
  image: { maxWidth: 500, maxHeight: 500, quality: 0.85 },
  debug: false,
  dtype: 'q4',
};

function mergeSettings(base, patch = {}) {
  return {
    ...base,
    ...patch,
    contentTypes: { ...base.contentTypes, ...(patch.contentTypes || {}) },
    image: { ...base.image, ...(patch.image || {}) },
  };
}

function promptIsReady() {
  return typeof settings.prompt === 'string' && settings.prompt.trim().length > 0;
}

let settings = mergeSettings(DEFAULT_SETTINGS);
let modelReady = false;
let creatingOffscreen = null;

// ─── Offscreen lifecycle ─────────────────────────────────────────────────────

async function hasOffscreen() {
  if (chrome.offscreen?.hasDocument) return chrome.offscreen.hasDocument();
  // Fallback for older Chrome — query matched contexts.
  if (chrome.runtime?.getContexts) {
    const ctxs = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    return ctxs.length > 0;
  }
  return false;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  if (creatingOffscreen) return creatingOffscreen;
  creatingOffscreen = chrome.offscreen
    .createDocument({
      url: OFFSCREEN_PATH,
      reasons: ['WORKERS'],
      justification:
        'Hosts the on-device Gemma classifier (transformers.js + WebGPU) — requires DOM/XHR/WASM APIs that MV3 service workers do not provide.',
    })
    .catch((err) => {
      // Race: another invocation may have created it between the check and create.
      if (String(err).includes('Only a single offscreen')) return;
      throw err;
    })
    .finally(() => {
      creatingOffscreen = null;
    });
  return creatingOffscreen;
}

async function forwardToOffscreen(msg) {
  await ensureOffscreen();
  // Always attach the current settings so offscreen never needs storage access.
  return chrome.runtime.sendMessage({ ...msg, target: 'offscreen', settings });
}

// ─── Persisted modelReady flag ───────────────────────────────────────────────

chrome.storage.local.get(['settings', 'modelReady']).then(({ settings: s, modelReady: m }) => {
  if (s) settings = mergeSettings(DEFAULT_SETTINGS, s);
  if (m) {
    modelReady = true;
    // Pre-warm: spin up offscreen and have it rehydrate the pipeline from
    // the Cache API. No-op if files are missing — the popup will recover.
    forwardToOffscreen({ type: 'load-model' }).catch(() => {});
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.settings) settings = mergeSettings(DEFAULT_SETTINGS, changes.settings.newValue || {});
  if (changes.modelReady) modelReady = !!changes.modelReady.newValue;
});

// ─── Scan priority queue ─────────────────────────────────────────────────────
// All tabs route through the same offscreen pipeline, so without a queue
// here the active tab competes with background tabs in arrival order. We
// keep a per-tab bucket and always pick from the active tab first.

let activeTabId = null;
let inFlight = false;
/** @type {Map<number, Array<{msg: any, sendResponse: Function, enqueuedAt: number}>>} */
const pendingByTab = new Map();
const statsByTab = new Map();
let lastStats = null;

function emptyStats() {
  return {
    startedAt: performance.now(),
    elapsedMs: 0,
    total: 0,
    processed: 0,
    fresh: 0,
    cached: 0,
    errors: 0,
    byContentType: { text: 0, image: 0 },
    byElementType: {},
    byAction: { 0: 0, 1: 0, 2: 0 },
    sensitive: 0,
    avgInferenceMs: 0,
    avgGenerateMs: 0,
    avgTokensPerSec: 0,
    lastEntries: [],
  };
}

chrome.tabs?.query?.({ active: true, lastFocusedWindow: true }).then((tabs) => {
  if (tabs && tabs[0]) activeTabId = tabs[0].id;
}).catch(() => {});

chrome.tabs?.onActivated?.addListener(({ tabId }) => {
  activeTabId = tabId;
  const stats = statsByTab.get(tabId);
  broadcastStats(stats || emptyStats());
  // The newly-active tab might have pending scans — kick the dispatcher.
  dispatchNext();
});

chrome.tabs?.onUpdated?.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== 'loading') return;
  statsByTab.delete(tabId);
  if (activeTabId === tabId) broadcastStats(emptyStats());
});

chrome.tabs?.onRemoved?.addListener((tabId) => {
  // Drop pending scans for closed tabs. Their content scripts are gone,
  // so sendResponse would be a no-op anyway, but we don't want the queue
  // growing forever.
  pendingByTab.delete(tabId);
  if (activeTabId === tabId) activeTabId = null;
});

function pickNext() {
  // Active tab wins.
  if (activeTabId != null) {
    const q = pendingByTab.get(activeTabId);
    if (q && q.length) return q.shift();
  }
  // Otherwise any tab with pending work, oldest enqueue first.
  let oldest = null;
  let oldestQ = null;
  for (const q of pendingByTab.values()) {
    if (q.length && (oldest == null || q[0].enqueuedAt < oldest)) {
      oldest = q[0].enqueuedAt;
      oldestQ = q;
    }
  }
  return oldestQ ? oldestQ.shift() : null;
}

async function dispatchNext() {
  if (inFlight) return;
  const item = pickNext();
  if (!item) return;
  inFlight = true;
  try {
    const res = await forwardToOffscreen(item.msg);
    try { item.sendResponse(res); } catch {}
  } catch (err) {
    try { item.sendResponse({ classID: item.msg.classId, actionID: 0, error: String(err) }); } catch {}
  } finally {
    inFlight = false;
    dispatchNext();
  }
}

function enqueueScan(msg, sender, sendResponse) {
  const tabId = sender?.tab?.id ?? -1;
  let q = pendingByTab.get(tabId);
  if (!q) { q = []; pendingByTab.set(tabId, q); }
  q.push({ msg, sendResponse, enqueuedAt: performance.now() });
  dispatchNext();
}

// ─── Popup port for live progress ────────────────────────────────────────────

const popupPorts = new Set();

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'safescroll-popup') return;
  popupPorts.add(port);
  // Send the current snapshot so a freshly opened popup isn't blank.
  forwardToOffscreen({ type: 'get-status' })
    .then((s) => {
      if (s?.progress) port.postMessage({ type: 'progress', progress: s.progress });
    })
    .catch(() => {});
  getActiveTabStats()
    .then((stats) => {
      if (stats) port.postMessage({ type: 'scan-stats', stats });
      else port.postMessage({ type: 'scan-stats', stats: emptyStats() });
    })
    .catch(() => {});
  port.onDisconnect.addListener(() => popupPorts.delete(port));
});

function broadcastProgress(p) {
  for (const port of popupPorts) {
    try { port.postMessage({ type: 'progress', progress: p }); } catch {}
  }
}

function broadcastStats(stats) {
  for (const port of popupPorts) {
    try { port.postMessage({ type: 'scan-stats', stats }); } catch {}
  }
}

async function getActiveTabStats() {
  let tab = null;
  try {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    tab = tabs && tabs[0];
  } catch {}
  if (!tab?.id) return lastStats;
  const cached = statsByTab.get(tab.id);
  try {
    const res = await chrome.tabs.sendMessage(tab.id, { type: 'get-scan-stats' });
    if (res?.stats) {
      statsByTab.set(tab.id, res.stats);
      lastStats = res.stats;
      return res.stats;
    }
  } catch {}
  return cached || null;
}

// ─── Message routing ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return false;

  // Messages aimed at offscreen — let offscreen's listener handle them.
  if (msg.target === 'offscreen') return false;

  // Progress events from offscreen → popup.
  if (msg.target === 'background' && msg.type === 'progress') {
    if (msg.progress?.status === 'ready' && !modelReady) {
      modelReady = true;
      chrome.storage.local.set({ modelReady: true });
    }
    broadcastProgress(msg.progress);
    return false;
  }

  if (msg.target === 'background' && msg.type === 'scan-stats') {
    const tabId = sender?.tab?.id;
    if (tabId != null) statsByTab.set(tabId, msg.stats);
    lastStats = msg.stats;
    if (tabId != null && tabId === activeTabId) broadcastStats(msg.stats);
    return false;
  }

  // Offscreen handshake.
  if (msg.target === 'background' && msg.type === 'offscreen-ready') {
    return false;
  }

  // From content script: scan request. Goes through the per-tab priority
  // queue so the currently-viewed tab always jumps ahead of background tabs.
  if (msg.type === 'scan') {
    if (!modelReady || settings.enabled === false || !promptIsReady()) {
      sendResponse({
        classID: msg.classId,
        actionID: 0,
        reasoning: '',
        skipped: !promptIsReady()
          ? 'prompt-empty'
          : settings.enabled === false ? 'extension-disabled' : 'model-not-loaded',
      });
      return false;
    }
    enqueueScan(msg, sender, sendResponse);
    return true;
  }

  // From popup: control messages.
  // Content script asks bg to inject contentScanner.js into its tab once
  // modelReady is true. Keeps the DOM walk + MutationObserver out of the
  // page until the parent has actually loaded the classifier.
  if (msg.type === 'inject-scanner') {
    const tabId = sender?.tab?.id;
    if (!tabId) {
      sendResponse({ ok: false, error: 'no-tab-id' });
      return false;
    }
    chrome.scripting
      .executeScript({
        target: { tabId, frameIds: [sender.frameId ?? 0] },
        files: ['content/contentScanner.js'],
      })
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  if (msg.type === 'unload-model') {
    modelReady = false;
    chrome.storage.local.set({ modelReady: false });
    forwardToOffscreen(msg)
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  if (msg.type === 'load-model' || msg.type === 'get-status') {
    forwardToOffscreen(msg)
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  if (msg.type === 'get-scan-stats') {
    getActiveTabStats()
      .then((stats) => sendResponse({ ok: true, stats }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  return false;
});
