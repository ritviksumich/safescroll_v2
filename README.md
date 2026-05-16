# Safe Scroll

Chrome extension that code-rates page content with on-device Gemma 4 E2B (ONNX, WebGPU). Each rendered text/image element is classified against the prompt specified in the popup and either blurred (action 1), framed with a tooltip (action 2), or left alone (0).

The classifier runs in a single offscreen document, shared across every tab and every site. Model files are fetched once into the extension-origin Cache API; subsequent visits hit the cache regardless of which website you're on.

---

## Architecture

```
popup/         → parent-facing config (prompt, mode, toggles, download)
                 ↕ chrome.storage + runtime.sendMessage / port
background/    → thin router. No model. Spawns offscreen on demand,
                 forwards control + scan messages, relays progress.
offscreen/     → owns the Gemma pipeline (transformers.js, WebGPU).
                 Has DOM/XHR/WASM APIs that MV3 service workers lack.
                 Cache lives in extension origin → cross-site sharing.
content/       → contentScanner.js + safescroll.js
                 contentScanner queues DOM elements; safescroll's
                 scanThroughAI messages the SW (which forwards to
                 offscreen) and applies blur/highlight on the result.
vendor/        → transformers.js v4.2.0 self-contained min build
models/        → optional: drop ONNX files here for instant load
```

Why offscreen and not the service worker: MV3 SWs lack `XMLHttpRequest`
(used by onnxruntime-web), can't compile WASM under the default extension
CSP, and have no DOM. The offscreen document runs in the extension origin
exactly like the SW would, so the cross-site share property is preserved.

Model lookup order (in offscreen):
1. `chrome.runtime.getURL('models/onnx-community/gemma-4-E2B-it-ONNX/...')` — bundled.
2. transformers.js Cache API in extension origin — populated after first download.
3. `https://huggingface.co/...` — last resort.

---

## Setup

### 1. Pre-fetch the model (recommended for dev)

```bash
./scripts/download-model.sh           # default q4 quant (~3.6 GB)
./scripts/download-model.sh q4f16     # smaller alternative
```

Files land in `models/onnx-community/gemma-4-E2B-it-ONNX/`. The script is idempotent — re-running skips files that match remote size.

If you skip this step, the extension will fall back to fetching from Hugging Face on the first **Download / Load model** click in the popup.

### 2. Load the unpacked extension

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select this directory.
4. Pin Safe Scroll from the puzzle-piece menu so the popup is one click away.

### 3. Initialize the model

Open the popup and click **Download / Load model**. With files bundled, this takes a couple of seconds (Chrome reads them from disk and warms WebGPU). Without files bundled, the progress bar shows the HF download.

A successful load persists `modelReady` in `chrome.storage.local`, so subsequent service-worker restarts re-create the offscreen doc and re-hydrate the pipeline from the Cache API.

---

## Popup controls

| Control            | Effect                                                          |
|--------------------|-----------------------------------------------------------------|
| Moderation prompt  | Sent verbatim to Gemma per element. Default flags food content. |
| Process mode       | `parallel_fold` (default) / `parallel` / `sequence`.            |
| Scan text / images | Per-content-type kill switch; routed into `ssConfig`.           |
| Quantization       | Picks the ONNX variant (`q4`, `q4f16`, `q8`, `fp16`).           |
| Debug              | Logs `{prompt, payload, rawOutput, classId, timings, ...}` per element to the **page** console. |
| Reset              | Clears the in-memory pipeline and the `modelReady` flag.        |

Settings are debounced to `chrome.storage.local`. The content script picks up changes live.

---

## Action mapping

| `actionID` | Behavior                                                                  |
|-----------:|---------------------------------------------------------------------------|
| 0          | No-op.                                                                    |
| 1          | Blur (filter + dashed red outline). Hover/focus reveals the reasoning.    |
| 2          | Amber frame + glow. Hover/focus shows reasoning tooltip.                  |

Styles live in `content/actions.css`. The integration touches the DOM via `data-ss-action` and `data-ss-reason` attributes set by `ssApplyAction(classId, actionID, reasoning)`.

---

## How it talks to itself

```
contentScanner.js (page-side, isolated world)
   │   queues h1-h6, p, li, blockquote, img, picture, canvas, …
   │   dedup'd via ssPayloadCache; cache-hits also dispatch via ssOnResult
   ▼
safescroll.js — window.scanThroughAI = (classId, ...) =>
   chrome.runtime.sendMessage({type:'scan', payload, ...})
   │
   ▼
background.js — pure router
   ├─ early-exits with actionID:0 if modelReady flag is false
   ├─ ensureOffscreen() — creates the offscreen doc on first need
   └─ chrome.runtime.sendMessage({...msg, target:'offscreen'})
   │
   ▼
offscreen.js — runScan()
   ├─ buildMessages(parentPrompt, ...)     ← Gemma chat-template input
   ├─ pipeline(...)(messages)              ← WebGPU inference
   └─ parseModelOutput(rawText)            ← maps "1\nReason..." → {actionID, reasoning}
   │
   ▼ (response flows back through bg)
safescroll.js — ssApplyAction(classId, actionID, reasoning)
   sets [data-ss-action]/[data-ss-reason] → CSS does the rest.
```

Progress events follow the same path in reverse: offscreen → bg → popup port.

---

## Caveats / TODO

- **MTP / Drafter speedup** ([gemma docs](https://ai.google.dev/gemma/docs/mtp/mtp)) — transformers.js v4.2 doesn't expose a draft-model API in the high-level `pipeline()` yet. Hooking a speculative decoder would require dropping to lower-level `AutoModel` + custom `generate()`. Marked as best-effort, not wired.
- **Image multimodal** — the prompt builder renders a `{ type: 'image' }` placeholder, then passes the resized `RawImage` separately through `Gemma4Processor` so transformers.js emits the vision tensors. Debug logs still include the post-resize `data:image/...` URL for inspection.
- **Offscreen lifetime** — Chrome keeps the offscreen doc alive as long as the extension is enabled, except under heavy memory pressure. If it's terminated, the next message re-creates it and the pipeline rehydrates from cache.
- **WebGPU availability** — falls back to WASM if WebGPU isn't available. To force one or the other, edit `DEFAULT_DEVICE` in `offscreen/offscreen.js`.

---

## File map

| Path                                      | Role                                                |
|-------------------------------------------|-----------------------------------------------------|
| `manifest.json`                           | MV3 manifest                                        |
| `background/background.js`                | Service worker — message router only (no model)     |
| `offscreen/offscreen.{html,js}`           | Hosts the Gemma pipeline (transformers.js + WebGPU) |
| `content/contentScanner.js`               | Your queue + DOM scanner (one minor hook added)     |
| `content/safescroll.js`                   | scanThroughAI bridge + ssApplyAction                |
| `content/actions.css`                     | Blur / highlight / tooltip styles                   |
| `popup/popup.{html,css,js}`               | Parent UI                                           |
| `vendor/transformers.min.js`              | transformers.js v4.2.0 (self-contained min build)   |
| `vendor/ort-wasm-simd-threaded.jsep.{mjs,wasm}` | onnxruntime-web WebGPU/JSEP backend artifacts |
| `vendor/ort-wasm-simd-threaded.{mjs,wasm}`      | onnxruntime-web WASM fallback                  |
| `models/`                                 | Drop ONNX weights here (or run the script)          |
| `scripts/download-model.sh`               | One-shot HF fetch                                   |
