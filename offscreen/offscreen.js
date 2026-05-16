// Safe Scroll offscreen document.
//
// Hosts the Gemma 4 E2B classifier. Single instance per extension, shared
// across every tab. Lives in extension origin → transformers.js's Cache API
// hits keep the model download cross-site.
//
// We bypass `pipeline()` and use AutoTokenizer + AutoProcessor +
// Gemma4ForConditionalGeneration directly. Reasons:
//   * v4.2 has no `image-text-to-text` pipeline — `text-generation` doesn't
//     route the multimodal Gemma 4 architecture cleanly (we hit "Inputs given
//     to model: [object Object]" warnings).
//   * We need access to processor.image_processor.max_soft_tokens (per
//     https://ai.google.dev/gemma/docs/capabilities/vision).
//   * Easier to control input shape and output decoding.

import {
  AutoTokenizer,
  AutoProcessor,
  Gemma4ForConditionalGeneration,
  load_image,
  env,
} from '../vendor/transformers.min.js';

const MODEL_REPO = 'onnx-community/gemma-4-E2B-it-ONNX';
const DEFAULT_DTYPE = 'q4';
const DEFAULT_DEVICE = 'webgpu';
const MAX_NEW_TOKENS = 64; // we only need a digit + one short sentence
const IMAGE_SOFT_TOKENS = 70; // per Gemma 4 vision docs
const DEFAULT_IMAGE_SETTINGS = { maxWidth: 500, maxHeight: 500, quality: 0.85 };
const DEFAULT_IMAGE_MAX = {
  width: DEFAULT_IMAGE_SETTINGS.maxWidth,
  height: DEFAULT_IMAGE_SETTINGS.maxHeight,
}; // fallback if settings.image isn't pushed

const DEFAULT_SETTINGS = {
  enabled: true,
  screeningMode: 'balanced',
  prompt: '',
  processMode: 'sequence',
  contentTypes: { text: true, image: true },
  image: DEFAULT_IMAGE_SETTINGS,
  debug: false,
  dtype: DEFAULT_DTYPE,
};

function mergeSettings(base, patch = {}) {
  return {
    ...base,
    ...patch,
    contentTypes: { ...base.contentTypes, ...(patch.contentTypes || {}) },
    image: { ...base.image, ...(patch.image || {}) },
  };
}

function getImageSettings() {
  const image = settings.image || {};
  const maxWidth = Number(image.maxWidth) || DEFAULT_IMAGE_SETTINGS.maxWidth;
  const maxHeight = Number(image.maxHeight) || DEFAULT_IMAGE_SETTINGS.maxHeight;
  const quality = Number.isFinite(Number(image.quality))
    ? Math.max(0, Math.min(1, Number(image.quality)))
    : DEFAULT_IMAGE_SETTINGS.quality;

  return { maxWidth, maxHeight, quality };
}

let settings = mergeSettings(DEFAULT_SETTINGS);
let tokenizer = null;
let processor = null;
let model = null;
let pipeLoading = null;
let loadError = null;

const progress = {
  status: 'idle',
  percent: 0,
  loaded: 0,
  total: 0,
  file: null,
  files: {},
  source: null,
  error: null,
};

function log(...args) { console.log('[Safe Scroll offscreen]', ...args); }

function reportProgress(patch) {
  Object.assign(progress, patch);
  chrome.runtime.sendMessage({ target: 'background', type: 'progress', progress }).catch(() => {});
}

// ─── Model lookup ────────────────────────────────────────────────────────────

async function checkBundledModel() {
  try {
    const url = chrome.runtime.getURL(`models/${MODEL_REPO}/config.json`);
    const res = await fetch(url, { method: 'HEAD' });
    return res.ok;
  } catch {
    return false;
  }
}

async function configureEnv(useBundled) {
  env.useBrowserCache = true;
  if (useBundled) {
    env.allowLocalModels = true;
    env.localModelPath = chrome.runtime.getURL('models/');
    env.allowRemoteModels = true; // fallback if bundle is partial
  } else {
    env.allowLocalModels = false;
    env.allowRemoteModels = true;
  }
  if (env.backends?.onnx?.wasm) {
    env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL('vendor/');
  }
}

// Aggregated progress callback shared by tokenizer / processor / model loads.
const knownFiles = new Set();
const doneFiles = new Set();
let lastProgressAt = performance.now();

function aggregateProgress(info) {
  lastProgressAt = performance.now();
  if (info.status === 'progress' && info.file && info.total) {
    knownFiles.add(info.file);
    progress.files[info.file] = { loaded: info.loaded, total: info.total };
    let agg = 0, total = 0;
    for (const f of Object.values(progress.files)) {
      agg += f.loaded; total += f.total;
    }
    const pct = total > 0 ? Math.round((agg / total) * 100) : 0;
    reportProgress({
      status: 'downloading', percent: pct, loaded: agg, total, file: info.file,
    });
  } else if (info.status === 'done' && info.file) {
    knownFiles.add(info.file);
    doneFiles.add(info.file);
    const tracked = progress.files[info.file];
    if (tracked) tracked.loaded = tracked.total;
    log('done file:', info.file, '(', doneFiles.size, '/', knownFiles.size, ')');
  } else if (info.status === 'ready') {
    log('progress_callback received status=ready');
  }
}

async function loadPipeline() {
  if (model && tokenizer) return;
  if (pipeLoading) return pipeLoading;

  loadError = null;
  reportProgress({ status: 'checking', percent: 0, error: null, files: {} });
  const bundled = await checkBundledModel();
  log('bundled model present?', bundled);
  await configureEnv(bundled);
  reportProgress({ source: bundled ? 'bundled' : 'remote' });
  log('env configured. dtype=', settings.dtype || DEFAULT_DTYPE, 'device=', DEFAULT_DEVICE);

  const heartbeat = setInterval(() => {
    const idleSec = Math.round((performance.now() - lastProgressAt) / 1000);
    if (idleSec >= 15) {
      log(`pipeline idle ${idleSec}s | status=${progress.status} percent=${progress.percent}% files=${doneFiles.size}/${knownFiles.size}`);
    }
  }, 10000);

  pipeLoading = (async () => {
    try {
      const dtype = settings.dtype || DEFAULT_DTYPE;
      const device = DEFAULT_DEVICE;

      log('loading tokenizer…');
      tokenizer = await AutoTokenizer.from_pretrained(MODEL_REPO, {
        progress_callback: aggregateProgress,
      });

      log('loading processor…');
      processor = await AutoProcessor.from_pretrained(MODEL_REPO, {
        progress_callback: aggregateProgress,
      });
      // Image token budget per Gemma 4 vision docs.
      if (processor?.image_processor) {
        processor.image_processor.max_soft_tokens = IMAGE_SOFT_TOKENS;
        log('processor.image_processor.max_soft_tokens =', IMAGE_SOFT_TOKENS);
      }

      log('all files downloaded; constructing ONNX sessions for the model now (can take 30–60s)…');
      reportProgress({ status: 'initializing', percent: 100, file: null });

      model = await Gemma4ForConditionalGeneration.from_pretrained(MODEL_REPO, {
        dtype,
        device,
        progress_callback: aggregateProgress,
      });

      log('model ready. dtype=', dtype, 'device=', device);
      reportProgress({ status: 'ready', percent: 100 });
    } catch (err) {
      log('load failed:', err);
      loadError = err;
      reportProgress({ status: 'error', error: String(err && err.message || err) });
      throw err;
    } finally {
      clearInterval(heartbeat);
      pipeLoading = null;
    }
  })();

  return pipeLoading;
}

// ─── Prompt construction (Gemma 4 chat template via tokenizer) ──────────────
// The parent's prompt from the popup dictates what to flag, the output format,
// and the digit meanings. In transformers.js, Gemma4Processor.apply_chat_template
// only renders text + media placeholders; the actual image is passed separately
// to processor(promptText, images, audio, options).
//
// System and text-user content stay as plain strings — Gemma 4's chat
// template applies `| trim` to them, which @huggingface/jinja doesn't
// support on array values. Image-user content is an array per the template.

function buildMessages(systemPrompt, contentType, elementType, payload) {
  if (contentType === 'image') {
    return [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: [{ type: 'image', images: [payload || ''] }],
      },
    ];
  }
  return [
    { role: 'system', content: systemPrompt },
    // Raw text only, no wrapper.
    { role: 'user',   content: payload },
  ];
}

function getImagePart(messages) {
  const userMsg = messages.find((m) => m.role === 'user');
  if (!Array.isArray(userMsg?.content)) return null;
  return userMsg.content.find((c) => c?.type === 'image') || null;
}

function getImageValue(part) {
  return part?.images?.[0] ?? part?.url ?? part?.base64 ?? part?.image ?? '';
}

function setImageValue(part, value) {
  if (!part) return;
  part.images = [value];
  delete part.url;
  delete part.image;
  delete part.base64;
}

async function rawImageToDataUrl(rawImage, quality) {
  const blob = await rawImage.toBlob('image/jpeg', quality);
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

// Replace RawImage / typed-array image payloads with a one-line summary so
// the debug dump in the page console stays readable. The pixel buffer can
// be 1+ MB of numeric keys when serialized — useless for debugging prompts.
function sanitizePromptForLog(messages) {
  const trunc = (s) => (s.length > 80 ? s.slice(0, 80) + `…(${s.length} chars)` : s);
  return messages.map((m) => {
    if (Array.isArray(m.content)) {
      return {
        ...m,
        content: m.content.map((part) => {
          if (part?.type !== 'image') return part;
          const out = { type: 'image' };
          const imageValue = getImageValue(part);
          if (typeof imageValue === 'string') out.images = [trunc(imageValue)];
          else if (imageValue && typeof imageValue === 'object' && 'data' in imageValue && 'width' in imageValue) {
            out.images = [`RawImage ${imageValue.width}×${imageValue.height}×${imageValue.channels || '?'}`];
          } else {
            out.images = ['<unknown image payload>'];
          }
          return out;
        }),
      };
    }
    return m;
  });
}

function parseModelOutput(raw) {
  const text = String(raw || '').trim();
  const m = text.match(/(?:^|\n)\s*([012])\b\s*\n?([\s\S]*)/);
  if (m) {
    return { actionID: parseInt(m[1], 10), reasoning: (m[2] || '').trim().split('\n')[0] };
  }
  const fallback = text.match(/[012]/);
  return { actionID: fallback ? parseInt(fallback[0], 10) : 0, reasoning: text.split('\n')[0] || '' };
}

// ─── Inference ───────────────────────────────────────────────────────────────

async function runScan({ classId, elementType, priority, payload, contentType }) {
  if (settings.enabled === false || !String(settings.prompt || '').trim()) {
    return {
      classID: classId,
      actionID: 0,
      reasoning: '',
      skipped: settings.enabled === false ? 'extension-disabled' : 'prompt-empty',
    };
  }
  const t0 = performance.now();
  const messages = buildMessages(settings.prompt, contentType, elementType, payload);
  const t1 = performance.now();

  try {
    await loadPipeline();
  } catch (err) {
    return { classID: classId, actionID: 0, reasoning: '', error: `model-load-failed: ${err && err.message || err}` };
  }
  const t2 = performance.now();

  let raw = '';
  let modelError = null;
  let imageLoadMs = 0, imageResizeMs = 0, tokenizeMs = 0, generateMs = 0, decodeMs = 0;
  let inputTokens = 0, newTokens = 0;
  let inputKeys = [];

  try {
    // For image entries, payload might be either a base64 data URL (when
    // contentScanner could decode the canvas) or an http(s) URL (CORS-tainted
    // canvas fallback). Resolve to a RawImage in both cases — the offscreen
    // doc has <all_urls> host permission so cross-origin fetch is fine here.
    let inputs;
    if (contentType === 'image' && processor) {
      const imgPart = getImagePart(messages);
      const originalImage = getImageValue(imgPart);
      const imageSettings = getImageSettings();
      if (!imgPart || typeof originalImage !== 'string' || !originalImage) {
        throw new Error('missing image content');
      }
      // Resolve URL/data:URL → RawImage. Offscreen origin has <all_urls>
      // host permission so cross-origin fetch isn't blocked here.
      const t = performance.now();
      let rawImage = await load_image(originalImage);
      imageLoadMs = +(performance.now() - t).toFixed(1);
      log(`load_image(${classId}) took ${imageLoadMs}ms`);
      // Apply the same width/height cap contentScanner.js does on the page
      // side. URL-fallback images (CORS-tainted canvas) skip that resize and
      // arrive here at full resolution — without this they'd be 1200×900+,
      // wasting the vision encoder pass.
      if (rawImage && rawImage.width && rawImage.height) {
        const maxW = imageSettings.maxWidth  || DEFAULT_IMAGE_MAX.width;
        const maxH = imageSettings.maxHeight || DEFAULT_IMAGE_MAX.height;
        const ratio = Math.min(maxW / rawImage.width, maxH / rawImage.height, 1);
        if (ratio < 1) {
          const tw = Math.max(1, Math.round(rawImage.width * ratio));
          const th = Math.max(1, Math.round(rawImage.height * ratio));
          const t = performance.now();
          rawImage = await rawImage.resize(tw, th);
          imageResizeMs = +(performance.now() - t).toFixed(1);
          log(`resized image for ${classId} → ${tw}×${th} (${imageResizeMs}ms)`);
        }
      }
      // Keep a post-resize data URL in the debug prompt, but pass the RawImage
      // itself to Gemma4Processor so it emits vision tensors.
      setImageValue(imgPart, await rawImageToDataUrl(rawImage, imageSettings.quality));
      if (typeof imgPart.images?.[0] !== 'string' || !imgPart.images[0].startsWith('data:image/')) {
        throw new Error('image content must be a data:image URL');
      }
      const tk = performance.now();
      const promptText = processor.apply_chat_template(messages, {
        add_generation_prompt: true,
        tokenize: false,
      });
      inputs = await processor(promptText, [rawImage], null, {});
      tokenizeMs = +(performance.now() - tk).toFixed(1);
    } else {
      const tk = performance.now();
      inputs = tokenizer.apply_chat_template(messages, {
        add_generation_prompt: true,
        return_dict: true,
        tokenize: true,
      });
      tokenizeMs = +(performance.now() - tk).toFixed(1);
    }

    inputTokens = inputs?.input_ids?.dims?.[1] ?? 0;
    inputKeys = Object.keys(inputs || {});
    if (settings.debug) log(`generate(${classId}) input_ids dims:`, inputs?.input_ids?.dims);

    const tg = performance.now();
    const outputs = await model.generate({
      ...inputs,
      max_new_tokens: MAX_NEW_TOKENS,
      do_sample: false,
    });
    generateMs = +(performance.now() - tg).toFixed(1);

    // Strip the prompt tokens — outputs is [batch, seq] including the prompt.
    const td = performance.now();
    const inputLen = inputs.input_ids.dims[1];
    const flat = outputs.tolist ? outputs.tolist()[0] : Array.from(outputs[0]);
    const newToks = flat.slice(inputLen);
    newTokens = newToks.length;
    raw = tokenizer.decode(newToks, { skip_special_tokens: true });
    decodeMs = +(performance.now() - td).toFixed(1);
  } catch (err) {
    modelError = String(err && err.message || err);
    log('inference error for', classId, modelError);
  }
  const t3 = performance.now();

  const { actionID, reasoning } = parseModelOutput(raw);

  const result = {
    classID: classId,
    actionID: modelError ? 0 : actionID,
    reasoning,
  };

  const payloadChars = contentType === 'text' ? (payload?.length ?? 0) : 0;
  const imgPart = getImagePart(messages);

  result.debug = {
    classId,
    elementType,
    priority,
    contentType,
    actionID: result.actionID,
    reasoning,
    modelError,
    payloadChars,
    inputTokens,
    inputKeys,
    newTokens,
    tokensPerSec: generateMs > 0 ? +((newTokens / (generateMs / 1000)).toFixed(2)) : 0,
    timings: {
      promptBuildMs:  +(t1 - t0).toFixed(1),
      pipelineWaitMs: +(t2 - t1).toFixed(1),
      imageLoadMs,
      imageResizeMs,
      tokenizeMs,
      generateMs,
      decodeMs,
      inferenceMs:    +(t3 - t2).toFixed(1),
      totalMs:        +(t3 - t0).toFixed(1),
    },
  };

  if (settings.debug) {
    // For image scans, also surface the raw post-resize base64 untruncated
    // so it can be inspected / pasted elsewhere. Adds ~30 KB to the message
    // round-trip per scan, so it stays behind Console debug logs.
    const imagePayloadFull =
      contentType === 'image' && typeof imgPart?.images?.[0] === 'string' ? imgPart.images[0] : null;
    Object.assign(result.debug, {
      fullPrompt: sanitizePromptForLog(messages),
      fullPromptIsPreview: true,
      analyzedText: contentType === 'text' ? payload : `[image: ${(payload || '').slice(0, 80)}…]`,
      imagePayloadFull,
      imagePayloadFullPath: 'imagePayloadFull',
      rawOutput: raw,
    });
  }

  return result;
}

// ─── Message routing (target: 'offscreen') ──────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return false;
  if (msg.settings) settings = mergeSettings(DEFAULT_SETTINGS, msg.settings);

  if (msg.type === 'scan') {
    runScan(msg)
      .then((r) => sendResponse(r))
      .catch((err) => sendResponse({ classID: msg.classId, actionID: 0, error: String(err) }));
    return true;
  }

  if (msg.type === 'load-model') {
    loadPipeline()
      .then(() => sendResponse({ ok: true, progress }))
      .catch((err) =>
        sendResponse({ ok: false, error: String(err && err.message || err), progress })
      );
    return true;
  }

  if (msg.type === 'get-status') {
    sendResponse({
      loaded: !!model,
      loading: !!pipeLoading,
      progress,
      settings,
      error: loadError ? String(loadError.message || loadError) : null,
    });
    return false;
  }

  if (msg.type === 'unload-model') {
    model = null;
    tokenizer = null;
    processor = null;
    pipeLoading = null;
    progress.status = 'idle';
    progress.percent = 0;
    progress.files = {};
    knownFiles.clear();
    doneFiles.clear();
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

chrome.runtime.sendMessage({ target: 'background', type: 'offscreen-ready' }).catch(() => {});
