// Safe Scroll content-script glue. The ONLY content script in the manifest.
// contentScanner.js is held back and injected dynamically by the bg once
// modelReady flips, so the DOM walk + MutationObserver never start before
// the classifier is actually loaded.
//
// Responsibilities:
//   1. Pre-populate window.ssConfig from chrome.storage so the subsequently-
//      injected contentScanner.js (which does `ssConfig = ssConfig || {…}`)
//      respects the parent's settings from the start.
//   2. Define window.scanThroughAI to route inference through the background
//      service worker (which forwards to the offscreen-hosted pipeline).
//   3. Implement window.ssApplyAction + register window.ssOnResult so each
//      scanned element gets blurred / highlighted based on the model's verdict.
//   4. Wait for modelReady, then ask the bg to inject contentScanner.js.

(() => {
  // ─── Sync settings into ssConfig ───────────────────────────────────────────

  // Seed ssConfig before contentScanner.js is injected — its first action is
  // `window.ssConfig = window.ssConfig || {…defaults…}`, so whatever we set
  // here survives.
  window.ssConfig = window.ssConfig || {
    enabled: true,
    screeningMode: 'balanced',
    prompt: '',
    processMode: 'sequence',
    logging: false,
    contentTypes: { text: true, image: true },
    image: { maxWidth: 500, maxHeight: 500, quality: 0.85 },
  };

  function applySettingsToConfig(s) {
    if (!s) return;
    const wasDisabled = window.ssConfig.enabled === false;
    const wasPromptEmpty = !String(window.ssConfig.prompt || '').trim();
    if (typeof s.enabled === 'boolean') window.ssConfig.enabled = s.enabled;
    if (s.screeningMode) window.ssConfig.screeningMode = s.screeningMode;
    if (typeof s.prompt === 'string') window.ssConfig.prompt = s.prompt;
    if (s.processMode) window.ssConfig.processMode = s.processMode;
    if (typeof s.debug === 'boolean') window.ssConfig.logging = s.debug;
    if (s.contentTypes) {
      window.ssConfig.contentTypes = {
        text:  s.contentTypes.text  !== false,
        image: s.contentTypes.image !== false,
      };
    }
    if (s.image) {
      window.ssConfig.image = { ...window.ssConfig.image, ...s.image };
    }
    if (window.ssConfig.enabled === false || !String(window.ssConfig.prompt || '').trim()) {
      clearAllActions();
      return;
    }
    if (window.ssConfig.screeningMode === 'strict') clearRevealedBlurStates();
    if ((wasDisabled || wasPromptEmpty) && typeof window.ssScanElements === 'function') {
      window.ssScanElements(document);
      if (typeof window.ssTriggerProcessing === 'function') window.ssTriggerProcessing();
    }
    syncActionOverlays();
  }

  chrome.storage.local.get('settings').then(({ settings }) => {
    applySettingsToConfig(settings);
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings) {
      applySettingsToConfig(changes.settings.newValue);
    }
  });

  // ─── modelReady gate + scanner injection ───────────────────────────────────
  // Hold every scan and the contentScanner.js injection itself until the bg
  // confirms the model is loaded. Without this, contentScanner would walk
  // the DOM on document_idle, queue work, and fire scan messages that the
  // bg can only bounce with skipped:'model-not-loaded'.

  let modelReady = false;
  let scannerInjected = false;
  let readyResolve;
  const readyPromise = new Promise((resolve) => { readyResolve = resolve; });

  async function injectScannerOnce() {
    if (scannerInjected) return;
    scannerInjected = true;
    try {
      const res = await chrome.runtime.sendMessage({ type: 'inject-scanner' });
      if (res?.ok === false) {
        console.warn('[Safe Scroll] contentScanner injection failed:', res.error);
        scannerInjected = false; // allow retry
      }
    } catch (err) {
      console.warn('[Safe Scroll] contentScanner injection error:', err);
      scannerInjected = false;
    }
  }

  function markReady() {
    if (modelReady) return;
    modelReady = true;
    readyResolve();
    injectScannerOnce();
  }

  // Initial probe. If the bg already pre-warmed the pipeline (e.g. SW restart
  // after a previous successful load), this resolves immediately.
  chrome.storage.local.get('modelReady').then(({ modelReady: m }) => {
    if (m) markReady();
  });

  // Listen for the flip that bg writes once offscreen reports 'ready'.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.modelReady?.newValue) markReady();
  });

  // ─── scanThroughAI → background SW ─────────────────────────────────────────

  const IMAGE_TAGS = new Set(['img', 'picture', 'canvas']);

  window.scanThroughAI = async function (classId, elementType, priority, payload) {
    if (window.ssConfig.enabled === false) return { classID: classId, actionID: 0 };
    if (!String(window.ssConfig.prompt || '').trim()) return { classID: classId, actionID: 0, skipped: 'prompt-empty' };
    const contentType = IMAGE_TAGS.has(elementType) ? 'image' : 'text';

    // Park the scan until the parent has loaded the model from the popup.
    if (!modelReady) await readyPromise;

    noteEnqueued(classId);
    try {
      const res = await chrome.runtime.sendMessage({
        type: 'scan', classId, elementType, priority, payload, contentType,
      });
      if (!res) return { classID: classId, actionID: 0 };
      // Logging is centralized in ssOnResult so cache/in-flight hits also
      // produce a line — they don't go through scanThroughAI.
      return {
        classID: classId,
        actionID: res.actionID || 0,
        reasoning: res.reasoning || '',
        debug: res.debug,
      };
    } catch (err) {
      // Service worker may have been suspended/restarted mid-flight, or the
      // tab is closing. Treat as no-action.
      return { classID: classId, actionID: 0, error: String(err) };
    }
  };

  // ─── Action dispatch ───────────────────────────────────────────────────────

  const SS_ATTR = 'data-ss-action';
  const SS_REASON = 'data-ss-reason';
  const SS_REVEALED = 'data-ss-revealed';
  const OVERLAY_ROOT_ID = 'ss-overlay-root';
  const activeActions = new Map();
  let overlayRoot = null;
  let hoveredClassId = null;
  let statsBroadcastTimer = null;

  function ensureOverlayRoot() {
    if (overlayRoot && document.documentElement.contains(overlayRoot)) return overlayRoot;
    overlayRoot = document.getElementById(OVERLAY_ROOT_ID);
    if (!overlayRoot) {
      overlayRoot = document.createElement('div');
      overlayRoot.id = OVERLAY_ROOT_ID;
      overlayRoot.setAttribute('aria-hidden', 'true');
      document.documentElement.appendChild(overlayRoot);
    }
    return overlayRoot;
  }

  function getPrimaryElement(classId) {
    const els = document.querySelectorAll(`.${CSS.escape(classId)}`);
    if (!els.length) return null;
    return Array.from(els).find((el) => el.getClientRects().length) || els[0];
  }

  function placeTooltip(tooltip, rect) {
    const margin = 10;
    const width = Math.min(340, Math.max(220, window.innerWidth - margin * 2));
    tooltip.style.width = `${width}px`;
    let left = Math.max(margin, Math.min(rect.left, window.innerWidth - width - margin));
    let top = rect.top - tooltip.offsetHeight - 10;
    if (top < margin) top = Math.min(window.innerHeight - tooltip.offsetHeight - margin, rect.bottom + 10);
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${Math.max(margin, top)}px`;
  }

  function isElementOnTop(el, rect) {
    const inset = 2;
    const left = Math.max(0, rect.left + inset);
    const right = Math.min(window.innerWidth - 1, rect.right - inset);
    const top = Math.max(0, rect.top + inset);
    const bottom = Math.min(window.innerHeight - 1, rect.bottom - inset);
    const points = [
      [left, top],
      [right, top],
      [left + (right - left) / 2, top + (bottom - top) / 2],
    ];
    return points.every(([x, y]) => {
      const topEl = document.elementsFromPoint(x, y)
        .find((node) => node.id !== OVERLAY_ROOT_ID && !node.closest?.(`#${OVERLAY_ROOT_ID}`));
      return !topEl || topEl === el || el.contains(topEl) || topEl.contains(el);
    });
  }

  function syncActionOverlays() {
    const root = ensureOverlayRoot();
    root.textContent = '';

    for (const [classId, data] of activeActions.entries()) {
      const el = getPrimaryElement(classId);
      if (!el || !document.documentElement.contains(el)) continue;
      if (data.revealed) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0 || rect.bottom < 0 || rect.right < 0 ||
          rect.top > window.innerHeight || rect.left > window.innerWidth) {
        continue;
      }
      if (!isElementOnTop(el, rect)) continue;

      const box = document.createElement('div');
      box.className = 'ss-overlay-box';
      box.dataset.ssOverlayAction = data.action;
      box.style.left = `${Math.max(0, rect.left)}px`;
      box.style.top = `${Math.max(0, rect.top)}px`;
      box.style.width = `${rect.width}px`;
      box.style.height = `${rect.height}px`;
      root.appendChild(box);

      if (hoveredClassId === classId) {
        const tooltip = document.createElement('div');
        tooltip.className = 'ss-overlay-tooltip';
        tooltip.dataset.ssVisible = 'true';
        const canReveal = data.action === 'blur' && window.ssConfig.screeningMode !== 'strict';
        const suffix = canReveal ? ' Right-click to view anyway.' : '';
        tooltip.textContent = `${data.reason || 'Flagged content'}${suffix}`;
        root.appendChild(tooltip);
        placeTooltip(tooltip, rect);
      }
    }
  }

  function attachOverlayEvents(el, classId) {
    if (el.dataset.ssOverlayEvents === '1') return;
    el.dataset.ssOverlayEvents = '1';
    el.addEventListener('mouseenter', () => {
      hoveredClassId = classId;
      syncActionOverlays();
    });
    el.addEventListener('mouseleave', () => {
      if (hoveredClassId === classId) hoveredClassId = null;
      syncActionOverlays();
    });
    el.addEventListener('focusin', () => {
      hoveredClassId = classId;
      syncActionOverlays();
    });
    el.addEventListener('focusout', () => {
      if (hoveredClassId === classId) hoveredClassId = null;
      syncActionOverlays();
    });
    el.addEventListener('contextmenu', (event) => {
      const data = activeActions.get(classId);
      if (!data || data.action !== 'blur' || window.ssConfig.screeningMode === 'strict') return;
      event.preventDefault();
      revealBlurredElement(classId);
    });
  }

  window.addEventListener('scroll', syncActionOverlays, { passive: true, capture: true });
  window.addEventListener('resize', syncActionOverlays);

  function clearAllActions() {
    document.querySelectorAll(`[${SS_ATTR}]`).forEach((el) => {
      el.removeAttribute(SS_ATTR);
      el.removeAttribute(SS_REASON);
      el.removeAttribute(SS_REVEALED);
    });
    activeActions.clear();
    hoveredClassId = null;
    if (overlayRoot) overlayRoot.textContent = '';
  }

  function clearRevealedBlurStates() {
    document.querySelectorAll(`[${SS_REVEALED}]`).forEach((el) => {
      el.removeAttribute(SS_REVEALED);
      const classId = Array.from(el.classList).find((c) => activeActions.has(c));
      const data = classId ? activeActions.get(classId) : null;
      if (data?.action === 'blur') {
        el.setAttribute(SS_ATTR, 'blur');
        el.setAttribute(SS_REASON, data.reason || 'Flagged content');
      }
    });
    for (const data of activeActions.values()) data.revealed = false;
  }

  function revealBlurredElement(classId) {
    const data = activeActions.get(classId);
    if (!data) return;
    data.revealed = true;
    document.querySelectorAll(`.${CSS.escape(classId)}`).forEach((el) => {
      el.setAttribute(SS_REVEALED, 'true');
      el.removeAttribute(SS_ATTR);
      el.removeAttribute(SS_REASON);
    });
    if (hoveredClassId === classId) hoveredClassId = null;
    syncActionOverlays();
  }

  window.ssApplyAction = function (classId, actionID, reasoning) {
    if (!classId) return;
    if (window.ssConfig.enabled === false) return;
    const els = document.querySelectorAll(`.${CSS.escape(classId)}`);
    if (!els.length) return;

    els.forEach((el) => {
      // Wipe any prior verdict before applying a new one (e.g. on rescan).
      el.removeAttribute(SS_ATTR);
      el.removeAttribute(SS_REASON);
      el.removeAttribute(SS_REVEALED);

      if (actionID === 1) {
        el.setAttribute(SS_ATTR, 'blur');
        el.setAttribute(SS_REASON, reasoning || 'Flagged content');
        activeActions.set(classId, { action: 'blur', reason: reasoning || 'Flagged content', revealed: false });
        attachOverlayEvents(el, classId);
      } else if (actionID === 2) {
        el.setAttribute(SS_ATTR, 'highlight');
        el.setAttribute(SS_REASON, reasoning || 'Worth a parent conversation');
        activeActions.set(classId, { action: 'highlight', reason: reasoning || 'Worth a parent conversation', revealed: false });
        attachOverlayEvents(el, classId);
      } else {
        activeActions.delete(classId);
      }
    });
    syncActionOverlays();
  };

  // ─── Stats ─────────────────────────────────────────────────────────────────
  // Captured on every dispatched result (fresh scans + cache/in-flight hits).
  // Inspect at any time via `window.ssScanStats` or `window.ssPrintScanStats()`.

  // Per-element row storage. Each entry is recorded once (deduped by classId)
  // even though sequence mode may call scanWithCache twice for the same text
  // entry. `entries` is what you'll want to dump for optimization analysis.

  window.ssScanStats = window.ssScanStats || {
    startedAt: performance.now(),
    total: 0,
    fresh: 0,
    cached: 0,
    errors: 0,
    byContentType: { text: 0, image: 0 },
    byElementType: {},
    byAction:      { 0: 0, 1: 0, 2: 0 },
    inferenceMs:   { sum: 0, samples: [] },
    generateMs:    { sum: 0, samples: [] },
    tokensPerSec:  { sum: 0, samples: [] },
    entries: [],
  };

  function buildStatsSnapshot() {
    const s = window.ssScanStats;
    const avg = (bucket) => bucket.samples.length ? +(bucket.sum / bucket.samples.length).toFixed(1) : 0;
    const elapsedMs = performance.now() - s.startedAt;
    const processed = s.byAction[0] + s.byAction[1] + s.byAction[2];
    const sensitive = (s.byAction[1] || 0) + (s.byAction[2] || 0);
    return {
      startedAt: s.startedAt,
      elapsedMs: +elapsedMs.toFixed(0),
      total: s.total,
      processed,
      fresh: s.fresh,
      cached: s.cached,
      errors: s.errors,
      byContentType: { ...s.byContentType },
      byElementType: { ...s.byElementType },
      byAction: { ...s.byAction },
      sensitive,
      avgInferenceMs: avg(s.inferenceMs),
      avgGenerateMs: avg(s.generateMs),
      avgTokensPerSec: avg(s.tokensPerSec),
      lastEntries: s.entries.slice(-12),
    };
  }

  function broadcastStatsSoon() {
    clearTimeout(statsBroadcastTimer);
    statsBroadcastTimer = setTimeout(() => {
      chrome.runtime.sendMessage({
        target: 'background',
        type: 'scan-stats',
        stats: buildStatsSnapshot(),
      }).catch(() => {});
    }, 120);
  }

  // Track which classIds we've already counted so the runSequence text path
  // (which dispatches the same entry twice) doesn't double-tally.
  const _recorded = new Set();
  // Track when each classId's first scanThroughAI message went out, for
  // queue-time analysis.
  const _enqueuedAt = new Map();

  function noteEnqueued(classId) {
    if (!_enqueuedAt.has(classId)) _enqueuedAt.set(classId, performance.now());
  }

  function recordResult(classId, result) {
    const s = window.ssScanStats;
    const action = result.actionID ?? 0;
    s.total++;
    s.byAction[action] = (s.byAction[action] || 0) + 1;
    if (result.error) s.errors++;

    const enqueuedAt = _enqueuedAt.get(classId);
    const completedAt = performance.now();
    const queueWaitMs = enqueuedAt != null ? +(completedAt - enqueuedAt).toFixed(1) : null;

    if (result.debug) {
      if (result.cached) s.cached++;
      else s.fresh++;
      const d = result.debug;
      s.byContentType[d.contentType] = (s.byContentType[d.contentType] || 0) + 1;
      s.byElementType[d.elementType] = (s.byElementType[d.elementType] || 0) + 1;
      s.inferenceMs.sum += d.timings?.inferenceMs ?? 0;
      s.inferenceMs.samples.push(d.timings?.inferenceMs ?? 0);
      s.generateMs.sum  += d.timings?.generateMs  ?? 0;
      s.generateMs.samples.push(d.timings?.generateMs  ?? 0);
      if (d.tokensPerSec) {
        s.tokensPerSec.sum += d.tokensPerSec;
        s.tokensPerSec.samples.push(d.tokensPerSec);
      }
      s.entries.push({
        classId,
        elementType: d.elementType,
        contentType: d.contentType,
        priority:    d.priority,
        actionID:    d.actionID,
        cached:      !!result.cached,
        enqueuedAt:  enqueuedAt != null ? +enqueuedAt.toFixed(1) : null,
        completedAt: +completedAt.toFixed(1),
        queueWaitMs,                             // total time spent in queues+model
        payloadChars: d.payloadChars ?? 0,
        inputTokens:  d.inputTokens ?? 0,
        newTokens:    d.newTokens   ?? 0,
        tokensPerSec: d.tokensPerSec ?? 0,
        imageLoadMs:   d.timings?.imageLoadMs   ?? 0,
        imageResizeMs: d.timings?.imageResizeMs ?? 0,
        tokenizeMs:    d.timings?.tokenizeMs    ?? 0,
        generateMs:    d.timings?.generateMs    ?? 0,
        decodeMs:      d.timings?.decodeMs      ?? 0,
        inferenceMs:   d.timings?.inferenceMs   ?? 0,
        modelError:   d.modelError || null,
      });
    } else {
      s.cached++;
      s.entries.push({
        classId,
        actionID: action,
        cached: true,
        enqueuedAt:  enqueuedAt != null ? +enqueuedAt.toFixed(1) : null,
        completedAt: +completedAt.toFixed(1),
        queueWaitMs,
      });
    }
    broadcastStatsSoon();
  }

  window.ssPrintScanStats = function () {
    const s = window.ssScanStats;
    const inf = [...s.inferenceMs.samples].sort((a, b) => a - b);
    const gen = [...s.generateMs.samples].sort((a, b) => a - b);
    const tps = [...s.tokensPerSec.samples].sort((a, b) => a - b);
    const pct = (arr, q) => arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * q))].toFixed(0) : '—';
    const elapsedSec = ((performance.now() - s.startedAt) / 1000).toFixed(1);
    console.group(`[Safe Scroll] Scan stats — ${elapsedSec}s elapsed`);
    console.table({
      'Total dispatched':   { value: s.total },
      'Fresh (hit model)':  { value: s.fresh },
      'Cache / in-flight':  { value: s.cached },
      'Errors':             { value: s.errors },
      'Text scans':         { value: s.byContentType.text  || 0 },
      'Image scans':        { value: s.byContentType.image || 0 },
      'Action 0 (none)':    { value: s.byAction[0] || 0 },
      'Action 1 (blur)':    { value: s.byAction[1] || 0 },
      'Action 2 (mark)':    { value: s.byAction[2] || 0 },
      'Inference avg':      { value: inf.length ? `${(s.inferenceMs.sum / inf.length).toFixed(0)}ms` : '—' },
      'Inference p50/90':   { value: `${pct(inf, 0.5)} / ${pct(inf, 0.9)} ms` },
      'Generate avg':       { value: gen.length ? `${(s.generateMs.sum / gen.length).toFixed(0)}ms` : '—' },
      'Generate p50/90':    { value: `${pct(gen, 0.5)} / ${pct(gen, 0.9)} ms` },
      'Throughput avg':     { value: tps.length ? `${(s.tokensPerSec.sum / tps.length).toFixed(1)} tok/s` : '—' },
    });
    console.log('Per-element-type breakdown:', s.byElementType);
    console.log(`Per-element rows in window.ssScanStats.entries (${s.entries.length}). Dump with ssDumpScanRows().`);
    console.groupEnd();
  };

  // Copy-paste-friendly dump. Defaults to JSON; pass 'csv' for spreadsheet.
  window.ssDumpScanRows = function (format = 'json') {
    const rows = window.ssScanStats.entries;
    if (format === 'csv') {
      const cols = [
        'classId', 'contentType', 'elementType', 'priority', 'cached',
        'actionID', 'modelError',
        'enqueuedAt', 'completedAt', 'queueWaitMs',
        'payloadChars', 'inputTokens', 'newTokens', 'tokensPerSec',
        'imageLoadMs', 'imageResizeMs', 'tokenizeMs', 'generateMs', 'decodeMs',
        'inferenceMs',
      ];
      const lines = [cols.join(',')];
      for (const r of rows) {
        lines.push(cols.map((c) => {
          const v = r[c];
          if (v == null) return '';
          if (typeof v === 'string') return `"${v.replace(/"/g, '""')}"`;
          return String(v);
        }).join(','));
      }
      const csv = lines.join('\n');
      console.log(csv);
      return csv;
    }
    const json = JSON.stringify(rows, null, 2);
    console.log(json);
    return json;
  };

  window.ssDebugScans = window.ssDebugScans || { systemPrompt: '', scans: [] };
  const DEBUG_SNAPSHOT_ID = 'ss-debug-scans-json';

  function mirrorDebugScansToDom() {
    let node = document.getElementById(DEBUG_SNAPSHOT_ID);
    if (!node) {
      node = document.createElement('script');
      node.id = DEBUG_SNAPSHOT_ID;
      node.type = 'application/json';
      node.dataset.owner = 'safe-scroll';
      (document.documentElement || document.head || document.body).appendChild(node);
    }
    node.textContent = JSON.stringify(window.ssDebugScans || { systemPrompt: '', scans: [] }, null, 2);
  }
  mirrorDebugScansToDom();

  window.ssCopyDebugScans = function () {
    const json = JSON.stringify(window.ssDebugScans || { systemPrompt: '', scans: [] }, null, 2);
    if (typeof copy === 'function') copy(json);
    else console.log(json);
    return json;
  };

  function recordDebugScan(result) {
    const debug = result.debug;
    if (!debug?.fullPrompt || !debug?.rawOutput) return;
    if (!/^\s*[12]\b/.test(String(debug.rawOutput))) return;
    const systemPrompt = debug.fullPrompt.find((m) => m.role === 'system')?.content || '';
    if (!window.ssDebugScans || Array.isArray(window.ssDebugScans)) {
      window.ssDebugScans = { systemPrompt: '', scans: [] };
    }
    window.ssDebugScans.systemPrompt = systemPrompt;
    window.ssDebugScans.scans.push({
      classId: debug.classId,
      elementType: debug.elementType,
      contentType: debug.contentType,
      analyzedText: debug.analyzedText,
      rawOutput: debug.rawOutput,
    });
    mirrorDebugScansToDom();
  }

  // ─── ssOnResult ────────────────────────────────────────────────────────────
  // Fires for EVERY dispatched result — fresh scans, cache hits, and in-flight
  // dedup hits. This is where logging + stats + DOM action all happen.

  window.ssOnResult = function (classId, result) {
    if (!result) return;
    if (window.ssConfig.enabled === false) return;
    // Sequence mode in contentScanner.js dispatches the same text entry twice
    // (via entry.action() *and* a direct scanWithCache call), so dedupe here
    // — model still ran once, but we don't want twin log lines or stats.
    if (_recorded.has(classId)) return;
    _recorded.add(classId);

    recordResult(classId, result);

    const t = result.debug?.timings?.totalMs;
    const tag = result.cached ? ' [cached]' : '';
    const reason = result.reasoning ? ` — ${result.reasoning}` : '';

    // Stash the most recent image's full base64 for easy copy(window.ssLastImagePayload).
    if (result.debug?.imagePayloadFull) {
      window.ssLastImagePayload = result.debug.imagePayloadFull;
      window.ssLastImagePayloadClassId = classId;
    }

    if (window.ssConfig.logging !== false && result.debug) {
      recordDebugScan(result);
      // Stash the most recent image's full base64 for easy copy(window.ssLastImagePayload).
      console.groupCollapsed(
        `[Safe Scroll] ${classId} → action ${result.actionID}${tag}` +
          (t ? ` (${t.toFixed(0)}ms)` : '') +
          reason
      );
      console.log(result.debug);
      console.groupEnd();
    } else if (window.ssConfig.logging !== false) {
      console.log(`[Safe Scroll] ${classId} → action ${result.actionID}${tag}${reason}`);
    }

    window.ssApplyAction(classId, result.actionID, result.reasoning);
  };

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === 'get-scan-stats') {
      sendResponse({ ok: true, stats: buildStatsSnapshot() });
      return false;
    }
    return false;
  });

  // ─── Reapply actions when SPA navigations rebuild the DOM ─────────────────
  // Any element matching our class names that loses the data-ss-action attr
  // (e.g. React/Next re-renders the subtree) gets it restored from cache.
  // We piggy-back on ssPayloadCache via the queue's stored result.

  // Periodic light reconciliation. Cheap (querySelectorAll on a class prefix).
  setInterval(() => {
    if (window.ssConfig.enabled === false) return;
    if (!Array.isArray(window.ssQueue)) return;
    for (const entry of window.ssQueue) {
      if (!entry.result || entry.result.actionID === 0) continue;
      if (activeActions.get(entry.classId)?.revealed) continue;
      const el = document.querySelector(`.${CSS.escape(entry.classId)}`);
      if (el && !el.hasAttribute(SS_ATTR)) {
        window.ssApplyAction(entry.classId, entry.result.actionID, entry.result.reasoning);
      }
    }
  }, 2000);
})();
