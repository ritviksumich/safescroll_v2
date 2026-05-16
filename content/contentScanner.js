/**
 * contentScanner.js
 * Scans page content elements, assigns unique class IDs, queues them by fold priority.
 * Supports text and image elements. Dynamically loaded content handled via MutationObserver.
 *
 * Config (set before script load, or update window.ssConfig at any time):
 *
 *   window.ssConfig = {
 *     enabled: true,                 // enable/disable scanning
 *     prompt: '',                    // empty prompt disables scanning
 *     processMode: 'parallel'        // all entries fire at once on enqueue
 *                  'sequence'        // one at a time, next fires after previous resolves
 *                  'parallel_fold'   // above-fold fires in parallel first, then below-fold
 *     logging: true,                 // set false to silence all [contentScanner] output
 *     contentTypes: {
 *       text:  true,                 // enable/disable text element scanning
 *       image: true,                 // enable/disable image element scanning
 *     },
 *     image: {
 *       maxWidth:  500,              // cap image width before toDataURL (px)
 *       maxHeight: 500,              // cap image height before toDataURL (px)
 *       quality:   0.85,             // jpeg quality (0–1), ignored for png
 *     }
 *   }
 */

(function () {

  const TEXT_SELECTORS  = 'h1, h2, h3, h4, h5, h6, p, li, blockquote, figcaption, td, th, a';
  const IMAGE_SELECTORS = 'img, picture, canvas';
  const EXCLUDED_CONTAINERS = 'nav, header, footer, aside';
  const CLASS_PREFIX = 'ss-node-';
  const QUEUE_KEY    = 'ssQueue';

  let _counter = 0;

  // ─── Config ───────────────────────────────────────────────────────────────────
  // Don't clobber a config that safescroll.js may have already populated from
  // chrome.storage when this scanner is injected dynamically post-modelReady.

  window.ssConfig = window.ssConfig || {
    enabled: true,
    prompt: '',
    processMode: 'parallel_fold', // 'parallel' | 'sequence' | 'parallel_fold'
    logging: false,               // true | false
    contentTypes: {
      text:  true,                // true | false
      image: true,                // true | false
    },
    image: {
      maxWidth:  500,             // number (px)
      maxHeight: 500,             // number (px)
      quality:   0.85,            // 0–1, applies to jpeg only
    },
  };

  function getMode() {
    return (window.ssConfig && window.ssConfig.processMode) || 'parallel_fold';
  }

  function isScannerEnabled() {
    return !window.ssConfig ||
      (window.ssConfig.enabled !== false && String(window.ssConfig.prompt || '').trim().length > 0);
  }

  function isContentTypeEnabled(type) {
    const ct = window.ssConfig && window.ssConfig.contentTypes;
    if (!ct) return true; // default on if contentTypes not specified
    return ct[type] !== false;
  }

  function getImageConfig() {
    return Object.assign({ maxWidth: 500, maxHeight: 500, quality: 0.85 },
      window.ssConfig && window.ssConfig.image);
  }

  // ─── Logger ───────────────────────────────────────────────────────────────────

  const log = {
    info:     (...a) => window.ssConfig.logging !== false && console.log(...a),
    warn:     (...a) => window.ssConfig.logging !== false && console.warn(...a),
    table:    (...a) => window.ssConfig.logging !== false && console.table(...a),
    group:    (...a) => window.ssConfig.logging !== false && console.group(...a),
    groupEnd: ()    => window.ssConfig.logging !== false && console.groupEnd(),
  };

  // ─── Utilities ────────────────────────────────────────────────────────────────

  function generateClassId() {
    _counter++;
    return `${CLASS_PREFIX}${Date.now()}-${_counter}`;
  }

  function isExcluded(el) {
    return !!el.closest(EXCLUDED_CONTAINERS);
  }

  function isAboveFold(el) {
    const rect = el.getBoundingClientRect();
    const foldHeight = window.innerHeight || document.documentElement.clientHeight;
    return rect.top < foldHeight && rect.bottom > 0;
  }

  function alreadyTagged(el) {
    return Array.from(el.classList).some(c => c.startsWith(CLASS_PREFIX));
  }

  function getClassId(el) {
    return Array.from(el.classList).find(c => c.startsWith(CLASS_PREFIX));
  }

  function getElementText(el) {
    return (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function isMeaningfulAnchor(el) {
    if (el.tagName.toLowerCase() !== 'a') return true;
    if (el.closest('nav, header, footer, aside, menu')) return false;
    if (el.closest('[role="navigation"], [role="menu"], [aria-label*="breadcrumb" i]')) return false;
    if (el.getAttribute('role') === 'button' || el.hasAttribute('aria-haspopup')) return false;

    const text = getElementText(el);
    if (text.length < 40) return false;
    const words = text.split(/\s+/).filter(Boolean);
    if (words.length < 6) return false;
    if (!/[.!?;:,"']|<br/i.test(el.innerHTML) && text.length < 80) return false;

    const href = (el.getAttribute('href') || '').trim();
    if ((href === '#' || href.startsWith('#')) && text.length < 120) return false;
    if (/^(read more|learn more|more|next|previous|back|home|menu|login|sign in|subscribe)$/i.test(text)) return false;
    return true;
  }

  // ─── Image utilities ──────────────────────────────────────────────────────────

  /**
   * Resolves the source element for a given image-related element.
   * <picture> delegates to its <img> child; everything else is itself.
   */
  function resolveImgElement(el) {
    if (el.tagName.toLowerCase() === 'picture') {
      return el.querySelector('img') || null;
    }
    return el;
  }

  /**
   * Returns the src URL for an img element, or null for canvas.
   */
  function getImageSrc(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'canvas') return null;
    return el.currentSrc || el.src || null;
  }

  /**
   * Waits for an img element to finish loading.
   * Resolves with the element if loaded successfully, rejects if broken.
   */
  function waitForImage(el) {
    return new Promise((resolve, reject) => {
      if (el.complete && el.naturalWidth > 0) return resolve(el);
      if (el.complete && el.naturalWidth === 0) return reject(new Error('broken'));
      el.addEventListener('load',  () => resolve(el), { once: true });
      el.addEventListener('error', () => reject(new Error('error')), { once: true });
    });
  }

  /**
   * Checks whether a canvas contains any transparent pixels.
   * Only called when format cannot be determined from URL extension.
   */
  function hasTransparency(canvas) {
    const data = canvas.getContext('2d')
      .getImageData(0, 0, canvas.width, canvas.height).data;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] < 255) return true;
    }
    return false;
  }

  /**
   * Determines the best output format for toDataURL().
   * Checks URL extension first (fast), falls back to pixel scan only when ambiguous.
   *
   * @param {string|null} src     - Image src URL (null for canvas)
   * @param {HTMLCanvasElement} offscreen - The offscreen canvas already drawn
   * @returns {'image/jpeg'|'image/png'}
   */
  function detectFormat(src, offscreen) {
    if (src) {
      const ext = (src.split('?')[0].split('.').pop() || '').toLowerCase();
      if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'; // definitely no alpha
      if (ext === 'png')  return hasTransparency(offscreen) ? 'image/png' : 'image/jpeg';
      if (ext === 'webp') return hasTransparency(offscreen) ? 'image/png' : 'image/jpeg';
    }
    // Unknown extension or canvas — check pixels
    return hasTransparency(offscreen) ? 'image/png' : 'image/jpeg';
  }

  /**
   * Draws an image/canvas element onto an offscreen canvas scaled to fit
   * within maxWidth × maxHeight, then returns a base64 data URL.
   *
   * @param {HTMLImageElement|HTMLCanvasElement} el
   * @param {string|null} src
   * @returns {string} base64 data URL
   */
  function toResizedBase64(el, src) {
    const cfg = getImageConfig();
    const naturalW = el.naturalWidth  || el.width;
    const naturalH = el.naturalHeight || el.height;

    // Never upscale — ratio capped at 1
    const ratio = Math.min(cfg.maxWidth / naturalW, cfg.maxHeight / naturalH, 1);
    const w = Math.max(1, Math.round(naturalW * ratio));
    const h = Math.max(1, Math.round(naturalH * ratio));

    const offscreen = document.createElement('canvas');
    offscreen.width  = w;
    offscreen.height = h;
    offscreen.getContext('2d').drawImage(el, 0, 0, w, h);

    const format = detectFormat(src, offscreen);
    return offscreen.toDataURL(format, cfg.quality);
  }

  // ─── Placeholder AI function ──────────────────────────────────────────────────

  /**
   * Placeholder — to be built out further.
   * Simulates an async AI scan and returns { classID, actionID }.
   *
   * @param {string} classId
   * @param {string} elementType
   * @param {string} priority
   * @param {string} payload      - text string or base64 data URL
   * @returns {Promise<{classID: string, actionID: number}>}
   */
  // Same guard as ssConfig — safescroll.js installs the real one before we
  // get injected, so don't downgrade it back to a stub.
  if (!window.scanThroughAI) {
    window.scanThroughAI = function (classId, elementType, priority, payload) {
      return new Promise((resolve) => {
        setTimeout(() => {
          resolve({
            classID:  classId,
            actionID: Math.floor(Math.random() * 3) + 1,
          });
        }, 3000);
      });
    };
  }

  // ─── Queue bootstrap ──────────────────────────────────────────────────────────

  if (!window[QUEUE_KEY]) {
    window[QUEUE_KEY] = [];
  }

  // ─── Payload cache & pending map ─────────────────────────────────────────────

  // Cache key for text  = payload string
  // Cache key for image = src URL  (avoids storing/comparing large base64 strings)
  window.ssPayloadCache   = window.ssPayloadCache   || {};
  window.ssPayloadPending = window.ssPayloadPending || {};

  // ─── Stats ────────────────────────────────────────────────────────────────────

  window.ssStats = window.ssStats || {
    totalEntries: 0,
    aiCalls:      0,
    cacheHits:    0,
    inflightHits: 0,
    savedCalls:   0,
    skipped:      0,  // broken images removed from queue
  };

  window.ssPrintStats = function () {
    const s   = window.ssStats;
    const pct = s.totalEntries > 0
      ? ((s.savedCalls / s.totalEntries) * 100).toFixed(1)
      : '0.0';
    log.group('[contentScanner] ── Cache Stats ──────────────────');
    log.table({
      'Total entries queued': { value: s.totalEntries },
      'AI calls fired':       { value: s.aiCalls },
      'Cache hits':           { value: s.cacheHits },
      'In-flight hits':       { value: s.inflightHits },
      'Total calls saved':    { value: s.savedCalls },
      'Savings rate':         { value: `${pct}%` },
      'Skipped (broken img)': { value: s.skipped },
    });
    log.groupEnd();
  };

  // ─── scanWithCache ────────────────────────────────────────────────────────────

  /**
   * Cached wrapper around scanThroughAI.
   *
   * For text:   cacheKey === payload
   * For images: cacheKey === src URL  (payload is the base64, not used as key)
   *
   * 1. Cache hit   → resolve immediately, no AI call
   * 2. In-flight   → attach to existing Promise, no duplicate AI call
   * 3. Cache miss  → fire scanThroughAI, register as pending, cache on resolve
   *
   * result.classID is always re-stamped to the requesting entry's own classId.
   */
  function scanWithCache(classId, elementType, priority, payload, cacheKey) {
    if (!isScannerEnabled()) {
      return Promise.resolve({ classID: classId, actionID: 0, skipped: 'extension-disabled' });
    }
    const key = cacheKey !== undefined ? cacheKey : payload;

    // Hook so external code (safescroll.js) can react to every entry's result,
    // including cache hits and in-flight dedup. Without this, only fresh
    // scanThroughAI invocations would trigger downstream actions.
    function dispatch(result) {
      if (typeof window.ssOnResult === 'function') {
        try { window.ssOnResult(classId, result); }
        catch (e) { log.warn('[contentScanner] ssOnResult error', e); }
      }
      return result;
    }

    // 1. Cache hit
    if (window.ssPayloadCache[key] !== undefined) {
      window.ssStats.cacheHits++;
      window.ssStats.savedCalls++;
      log.info(`[contentScanner] CACHE HIT   — ${classId} (${elementType}) | saved call #${window.ssStats.savedCalls}`);
      return Promise.resolve(
        Object.assign({}, window.ssPayloadCache[key], { classID: classId, cached: true })
      ).then(dispatch);
    }

    // 2. In-flight hit
    if (window.ssPayloadPending[key] !== undefined) {
      window.ssStats.inflightHits++;
      window.ssStats.savedCalls++;
      log.info(`[contentScanner] IN-FLIGHT   — ${classId} (${elementType}) | saved call #${window.ssStats.savedCalls}`);
      return window.ssPayloadPending[key].then(result =>
        Object.assign({}, result, { classID: classId, cached: true })
      ).then(dispatch);
    }

    // 3. Cache miss
    window.ssStats.aiCalls++;
    log.info(`[contentScanner] AI CALL     — ${classId} (${elementType}) | call #${window.ssStats.aiCalls}`);
    const promise = window.scanThroughAI(classId, elementType, priority, payload)
      .then(result => {
        result.cached = false;
        window.ssPayloadCache[key] = result;
        delete window.ssPayloadPending[key];
        log.info(`[contentScanner] AI RESOLVED — ${classId} | actionID: ${result.actionID}`);
        return result;
      });

    window.ssPayloadPending[key] = promise;
    return promise.then(dispatch);
  }

  // ─── Cursor & processing state ────────────────────────────────────────────────

  let _cursor     = 0;
  let _processing = false;

  // ─── Build entry — text ───────────────────────────────────────────────────────

  function buildTextEntry(el) {
    if (!isMeaningfulAnchor(el)) return null;
    let classId;
    if (alreadyTagged(el)) {
      classId = getClassId(el);
    } else {
      classId = generateClassId();
      el.classList.add(classId);
    }

    const priority    = isAboveFold(el) ? 'above_fold' : 'below_fold';
    const elementType = el.tagName.toLowerCase();
    const payload     = getElementText(el);

    if (!payload) return null;

    return {
      classId,
      priority,
      contentType: 'text',
      elementType,
      payload,
      action: function () {
        scanWithCache(this.classId, this.elementType, this.priority, this.payload)
          .then(result => { this.result = result; });
      },
    };
  }

  // ─── Build entry — image ──────────────────────────────────────────────────────

  /**
   * Builds an image queue entry.
   * payload starts as null — populated asynchronously once the image is ready.
   * scanThroughAI is never called until payload is set.
   */
  function buildImageEntry(el) {
    // <picture> resolves to its <img> child
    const imgEl = resolveImgElement(el);
    if (!imgEl) return null;

    let classId;
    if (alreadyTagged(el)) {
      classId = getClassId(el);
    } else {
      classId = generateClassId();
      el.classList.add(classId);
    }

    const priority    = isAboveFold(el) ? 'above_fold' : 'below_fold';
    const elementType = el.tagName.toLowerCase();
    const src         = getImageSrc(imgEl); // null for canvas

    return {
      classId,
      priority,
      contentType: 'image',
      elementType,
      payload: null,  // populated after image loads
      src,
      action: function () {
        const entry = this;

        // canvas: no load wait needed, convert directly
        if (imgEl.tagName.toLowerCase() === 'canvas') {
          try {
            entry.payload = toResizedBase64(imgEl, null);
            scanWithCache(entry.classId, entry.elementType, entry.priority, entry.payload, null)
              .then(result => { entry.result = result; });
          } catch (e) {
            log.warn(`[contentScanner] Canvas encode failed — ${entry.classId}`, e);
            // Stub the result so sequence-mode polling can advance.
            entry.result = { classID: entry.classId, actionID: 0 };
            removeFromQueue(entry.classId);
          }
          return;
        }

        // img / picture: wait for load, then convert. If toResizedBase64 throws
        // (most often a CORS-tainted canvas — the third-party image didn't
        // send Access-Control-Allow-Origin), fall back to sending the URL so
        // the offscreen can fetch it itself in extension origin.
        waitForImage(imgEl)
          .then(loaded => {
            try {
              entry.payload = toResizedBase64(loaded, src);
            } catch (e) {
              log.info(`[contentScanner] CORS taint, falling back to URL — ${entry.classId} ${src || ''}`);
              entry.payload = src;
            }
            return scanWithCache(entry.classId, entry.elementType, entry.priority, entry.payload, src);
          })
          .then(result => { entry.result = result; })
          .catch(() => {
            // broken or failed image — remove from queue. Stub the result
            // first so the sequence-mode poll resolves and the cursor
            // advances; otherwise one bad image blocks every entry behind it.
            log.warn(`[contentScanner] Image skipped (broken/error) — ${entry.classId} ${src || ''}`);
            window.ssStats.skipped++;
            entry.result = { classID: entry.classId, actionID: 0 };
            removeFromQueue(entry.classId);
          });
      },
    };
  }

  // ─── Remove entry from queue ──────────────────────────────────────────────────

  function removeFromQueue(classId) {
    const idx = window[QUEUE_KEY].findIndex(e => e.classId === classId);
    if (idx !== -1) {
      window[QUEUE_KEY].splice(idx, 1);
      // adjust cursor if removed entry was behind or at it
      if (idx < _cursor) _cursor--;
    }
  }

  // ─── Enqueue ──────────────────────────────────────────────────────────────────

  function enqueue(entry, isDynamic) {
    if (!entry) return;

    const exists = window[QUEUE_KEY].some(e => e.classId === entry.classId);
    if (exists) return;

    window.ssStats.totalEntries++;
    const mode = getMode();

    if (isDynamic && entry.priority === 'above_fold' && mode !== 'parallel') {
      // Insert after cursor, before first pending below-fold entry
      let firstBelowFoldAfterCursor = window[QUEUE_KEY].length;
      for (let i = _cursor; i < window[QUEUE_KEY].length; i++) {
        if (window[QUEUE_KEY][i].priority === 'below_fold') {
          firstBelowFoldAfterCursor = i;
          break;
        }
      }
      window[QUEUE_KEY].splice(Math.max(_cursor, firstBelowFoldAfterCursor), 0, entry);

    } else if (!isDynamic && entry.priority === 'above_fold') {
      // Initial scan: after last above-fold entry
      let insertAt = 0;
      for (let i = window[QUEUE_KEY].length - 1; i >= 0; i--) {
        if (window[QUEUE_KEY][i].priority === 'above_fold') {
          insertAt = i + 1;
          break;
        }
      }
      window[QUEUE_KEY].splice(insertAt, 0, entry);

    } else {
      window[QUEUE_KEY].push(entry);
    }

    triggerProcessing();
  }

  // ─── Processing engine ────────────────────────────────────────────────────────

  function triggerProcessing() {
    if (!isScannerEnabled()) return;
    const mode = getMode();
    if (mode === 'parallel') {
      const entry = window[QUEUE_KEY][window[QUEUE_KEY].length - 1];
      if (entry && !entry.result) entry.action();
      return;
    }
    if (!_processing) runProcessor();
  }

  async function runProcessor() {
    if (_processing) return;
    _processing = true;
    try {
      const mode = getMode();
      if (mode === 'sequence')       await runSequence();
      else if (mode === 'parallel_fold') await runParallelFold();
    } finally {
      _processing = false;
      if (_cursor < window[QUEUE_KEY].length) {
        runProcessor();
      } else {
        window.ssPrintStats();
      }
    }
  }

  async function runSequence() {
    while (_cursor < window[QUEUE_KEY].length) {
      const entry = window[QUEUE_KEY][_cursor];
      _cursor++;
      await new Promise((resolve) => {
        // For images, action() is async internally — we await it resolving entry.result
        const poll = setInterval(() => {
          if (entry.result || entry.payload === null && !entry.src) {
            clearInterval(poll);
            resolve();
          }
        }, 50);
        entry.action();
        // For text entries, result comes back via promise chain — resolve once set
        if (entry.contentType === 'text') {
          clearInterval(poll);
          scanWithCache(entry.classId, entry.elementType, entry.priority, entry.payload)
            .then(result => { entry.result = result; resolve(); });
        }
      });
    }
  }

  async function runParallelFold() {
    // Phase 1: all above-fold entries
    const aboveFold = [];
    for (let i = _cursor; i < window[QUEUE_KEY].length; i++) {
      if (window[QUEUE_KEY][i].priority === 'above_fold') aboveFold.push(window[QUEUE_KEY][i]);
      else break;
    }

    if (aboveFold.length > 0) {
      _cursor += aboveFold.length;
      await Promise.all(aboveFold.map(entry => processEntry(entry)));
    }

    // Phase 2: all below-fold entries
    const belowFold = [];
    for (let i = _cursor; i < window[QUEUE_KEY].length; i++) {
      belowFold.push(window[QUEUE_KEY][i]);
    }

    if (belowFold.length > 0) {
      _cursor += belowFold.length;
      await Promise.all(belowFold.map(entry => processEntry(entry)));
    }
  }

  /**
   * Unified entry processor used by parallel_fold and sequence modes.
   * Handles both text (direct scanWithCache) and image (waitForImage → base64 → scanWithCache).
   */
  function processEntry(entry) {
    if (!isScannerEnabled()) return Promise.resolve();
    if (entry.contentType === 'text') {
      return scanWithCache(entry.classId, entry.elementType, entry.priority, entry.payload)
        .then(result => { entry.result = result; });
    }

    // image entry
    const imgEl = resolveImgElement(
      document.querySelector(`.${entry.classId}`) || { tagName: 'IMG' }
    );

    // canvas — convert directly
    if (!entry.src && entry.elementType === 'canvas') {
      const canvasEl = document.querySelector(`.${entry.classId}`);
      if (!canvasEl) return Promise.resolve();
      try {
        entry.payload = toResizedBase64(canvasEl, null);
        return scanWithCache(entry.classId, entry.elementType, entry.priority, entry.payload, `canvas:${entry.classId}`)
          .then(result => { entry.result = result; });
      } catch (e) {
        log.warn(`[contentScanner] Canvas encode failed — ${entry.classId}`, e);
        entry.result = { classID: entry.classId, actionID: 0 };
        removeFromQueue(entry.classId);
        return Promise.resolve();
      }
    }

    // img / picture
    if (!imgEl) return Promise.resolve();
    return waitForImage(imgEl)
      .then(loaded => {
        try {
          entry.payload = toResizedBase64(loaded, entry.src);
        } catch (e) {
          // CORS-tainted canvas — fall back to URL; offscreen will fetch it.
          log.info(`[contentScanner] CORS taint, falling back to URL — ${entry.classId} ${entry.src || ''}`);
          entry.payload = entry.src;
        }
        return scanWithCache(entry.classId, entry.elementType, entry.priority, entry.payload, entry.src);
      })
      .then(result => { entry.result = result; })
      .catch(() => {
        log.warn(`[contentScanner] Image skipped (broken/error) — ${entry.classId} ${entry.src || ''}`);
        window.ssStats.skipped++;
        entry.result = { classID: entry.classId, actionID: 0 };
        removeFromQueue(entry.classId);
      });
  }

  // ─── Initial scan ─────────────────────────────────────────────────────────────

  const ALL_SELECTORS = `${TEXT_SELECTORS}, ${IMAGE_SELECTORS}`;

  /**
   * Single querySelectorAll pass using ALL_SELECTORS preserves natural DOM order.
   * Elements are split into above/below-fold buckets maintaining their relative
   * order within each bucket, then above-fold is enqueued first.
   */
  function scanElements(root) {
    if (!isScannerEnabled()) return;
    const base      = root || document;
    const aboveFold = [];
    const belowFold = [];

    base.querySelectorAll(ALL_SELECTORS).forEach(el => {
      if (isExcluded(el)) return;

      const tag     = el.tagName.toLowerCase();
      const isImage = ['img', 'picture', 'canvas'].includes(tag);

      // skip bare <img> inside <picture> — handled via the <picture> entry
      if (tag === 'img' && el.closest('picture')) return;

      // respect contentTypes config
      if (isImage  && !isContentTypeEnabled('image')) return;
      if (!isImage && !isContentTypeEnabled('text'))  return;

      const entry = isImage ? buildImageEntry(el) : buildTextEntry(el);
      if (!entry) return;

      (entry.priority === 'above_fold' ? aboveFold : belowFold).push(entry);
    });

    for (const entry of aboveFold) enqueue(entry, false);
    for (const entry of belowFold) enqueue(entry, false);

    // Log initial queue summary broken down by fold and content type
    const afText  = aboveFold.filter(e => e.contentType === 'text').length;
    const afImage = aboveFold.filter(e => e.contentType === 'image').length;
    const bfText  = belowFold.filter(e => e.contentType === 'text').length;
    const bfImage = belowFold.filter(e => e.contentType === 'image').length;
    const textEnabled  = isContentTypeEnabled('text');
    const imageEnabled = isContentTypeEnabled('image');

    log.group(`[contentScanner] Initial scan — ${aboveFold.length + belowFold.length} elements queued | Mode: ${getMode()} | text: ${textEnabled ? 'on' : 'off'} | image: ${imageEnabled ? 'on' : 'off'}`);
    log.table({
      'Above fold — text':  { count: afText,  enabled: textEnabled  ? '✓' : '✗' },
      'Above fold — image': { count: afImage, enabled: imageEnabled ? '✓' : '✗' },
      'Below fold — text':  { count: bfText,  enabled: textEnabled  ? '✓' : '✗' },
      'Below fold — image': { count: bfImage, enabled: imageEnabled ? '✓' : '✗' },
      'Total':              { count: afText + afImage + bfText + bfImage },
    });
    log.groupEnd();
  }

  window.ssScanElements = scanElements;
  window.ssTriggerProcessing = triggerProcessing;

  scanElements(document);

  // ─── MutationObserver — dynamic content ──────────────────────────────────────

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== 1) continue;

        const process = (el) => {
          if (!isScannerEnabled()) return;
          if (isExcluded(el)) return;
          const tag = el.tagName.toLowerCase();
          // skip bare <img> inside <picture>
          if (tag === 'img' && el.closest('picture')) return;

          const isImage = ['img', 'picture', 'canvas'].includes(tag);

          // respect contentTypes config
          if (isImage  && !isContentTypeEnabled('image')) return;
          if (!isImage && !isContentTypeEnabled('text'))  return;

          const entry = isImage ? buildImageEntry(el) : buildTextEntry(el);
          enqueue(entry, true);
        };

        if (node.matches && node.matches(ALL_SELECTORS)) process(node);
        if (node.querySelectorAll) {
          node.querySelectorAll(ALL_SELECTORS).forEach(process);
        }
      }
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });
  window.ssQueueObserver = observer;

})();
