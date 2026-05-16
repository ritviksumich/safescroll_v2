# Safe Scroll: Local AI Web Safety Companion for Kids

Safe Scroll is a privacy-first Chrome extension that uses local Gemma 4 E2B to help parents protect kids online while keeping browsing data on-device.

## The Problem

Children increasingly browse a web that was not designed for them. A child can move from a homework search to a lyrics page, a social post, an image-heavy article, or a forum thread in seconds. Along the way, they may encounter sexual language, suggestive images, bullying, hate, threats, scams, frightening content, or adult themes before a parent even knows it appeared.

Traditional parental controls often solve this problem in blunt ways. They block whole websites, require cloud-based filtering, or encourage parents to inspect browsing history after the fact. That creates a difficult tension at home: parents want to protect their children, but children also need independence, trust, and room to explore.

I built Safe Scroll around a different idea: what if a child could have a proactive safety companion inside the browser, while parents configure the guardrails and browsing content stays private?

## Solution Approach

Safe Scroll scans webpage text and images in real time, then classifies each meaningful page element into one of three actions:

- `0`: safe content, leave it clear
- `1`: explicitly inappropriate content, blur it
- `2`: sensitive but educational content, highlight it for possible parent-child discussion

The moderation behavior is controlled by a parent-editable prompt in the extension popup. This means parents can adapt the screening policy to their child's age, maturity, and family preferences instead of relying on a fixed universal classifier.

The extension also supports two screening modes. In balanced mode, blurred content can be viewed anyway, which is useful when parents want a softer coaching layer. In strict mode, blurred content stays blocked. This gives families a choice between supportive friction and firmer protection.

## How I Used Gemma 4

Safe Scroll uses the open-source [Gemma 4 E2B ONNX model](https://huggingface.co/onnx-community/gemma-4-E2B-it-ONNX) locally inside the Chrome extension. I chose E2B because the project needed multimodal reasoning for both text and images, but also needed to run on consumer hardware instead of depending on a remote API.

Gemma 4 acts as the moderation reasoning layer. For each page element, Safe Scroll sends a compact prompt and either the text content or image payload. The model returns exactly two lines: a numeric action and a short explanation. The extension then maps the numeric output to a UI action: clear, highlight, or blur.

This keeps the system explainable. Parents can see not just that something was flagged, but why.

## Architecture

The extension uses a Manifest V3 architecture designed around local inference:

- A content script runs on each tab and watches the DOM.
- A MutationObserver detects dynamically added content.
- A content scanner extracts meaningful text and image elements.
- A thin background service worker routes scan requests.
- An offscreen document hosts the Gemma 4 pipeline using WebGPU/WebAssembly.
- The popup provides parent configuration, model loading, screening mode, prompt editing, and live stats.

The offscreen document is central to the architecture. Running inference directly in the background service worker is not practical because MV3 service workers are short-lived and do not provide the full browser environment needed for image processing, WebGPU, and long-running model work. The offscreen document gives the extension a stable place to host the model while keeping the background service worker lightweight.

## Development Process

I started with the core scanning loop: identify page elements, send them to Gemma, and apply a visual action. Once text scanning worked, I added image support by converting images into data URLs, resizing them, and passing them through the multimodal pipeline.

The popup evolved from a basic control panel into a parent-facing configuration console. It now shows model status, download progress, prompt configuration, extension toggles, balanced/strict screening, processed element counts, sensitive findings, average inference time, token throughput, and a live verdict chart.

I also added debug logging for development. When enabled, Safe Scroll exposes flagged scan entries in a copyable JSON structure so I can inspect the analyzed text, model output, and reasoning. This helped me tune prompts and understand false positives.

## Model Download and Caching

Because the Gemma 4 E2B ONNX model is large, I designed the extension to download it only when the parent chooses to load the model. The popup shows progress while files are downloaded.

The extension can use model artifacts from Hugging Face and related CDN hosts. Once downloaded, model files are cached in the extension origin, so future browsing sessions can reuse the cached files instead of downloading everything again.

This approach keeps the first-run experience explicit: parents know when the model is being loaded, and the extension does not silently pull large files in the background.

## Improving Inference Speed

A major part of the build was making local inference feel usable. I tried several practical optimizations:

First, I resized images before inference. Early image payloads were too large and slowed down processing, so I capped image dimensions and tuned compression. This helped reduce processing time while preserving enough detail for moderation.

Second, I added element filtering. The scanner avoids tiny navigation labels, repeated UI fragments, and low-value anchors where possible. This prevents the model from wasting time on content that is unlikely to matter.

Third, I added caching and in-flight request reuse. If the same element content is encountered again, the extension can reuse prior results instead of calling the model repeatedly.

Fourth, I tested process modes, including sequence-based processing and above-the-fold prioritization. For child safety, perceived responsiveness matters: the content visible first should be classified first.

Finally, I added live performance stats so I could see average inference time and token throughput while testing real pages.

## Challenges

The hardest challenge was balancing safety with false positives. A child-safety classifier can easily become too cautious. For example, an educational article about bullying should not be treated the same as direct harassment. A small lock icon should not always become a sensitive online safety warning. Prompt design mattered a lot, especially telling the model to judge what the content is, not merely what sensitive topic it mentions.

Images were another challenge. Prompt formatting for multimodal input took experimentation, and debugging was tricky because base64 payloads are huge. I added separate full image payload logging only when debug mode is enabled.

Overlay behavior on real websites was also surprisingly complex. Page z-index, sticky navigation bars, dropdowns, scrolling containers, and dynamic layout changes can all affect whether a highlight or blur border appears correctly. I had to adjust overlays so they behave more like page-aware annotations than simple CSS outlines.

## Privacy and Trust

Privacy is the main reason Safe Scroll exists as a local-first extension. Page text and images are processed on the user's computer. Browsing content is not sent to my server or to an external moderation API.

This matters because child safety tools can easily become surveillance tools. I wanted Safe Scroll to help parents equip their kids with support, not force parents to constantly inspect what their kids are reading. The goal is to make online safety feel like guidance, not snooping.

## Impact

Safe Scroll sits at the intersection of online well-being, safety, trust, and education. It gives parents a configurable way to support children as they browse the open web, while preserving privacy and independence.

The project is still a proof of concept, but it demonstrates a powerful pattern: open, local multimodal models can create safety tools that do not require sending private browsing content to the cloud.

## What Comes Next

Next, I want to add password protection for parent settings, improve calibration with parent-labeled examples, reduce image false positives, and evaluate whether fine-tuning with Unsloth could improve moderation consistency.

Safe Scroll shows how Gemma 4 can bring local intelligence directly into the browser, helping families build safer digital habits without giving up privacy.

-------

## Manual Installation During Chrome Web Store Review

While Safe Scroll is being reviewed in the Chrome Web Store, it can be installed manually as an unpacked Chrome extension.

1. Download or clone the public Safe Scroll repository.
2. Open Google Chrome.
3. Go to `chrome://extensions/`.
4. Enable **Developer mode** in the top-right corner.
5. Click **Load unpacked**.
6. Select the Safe Scroll extension folder.
7. The Safe Scroll icon should appear in the Chrome toolbar.
8. Open the popup, load the local Gemma 4 E2B model, and configure the moderation prompt if needed.

Once loaded, Safe Scroll can scan supported webpages locally in the browser.

## Example Test Pages

The following public pages can be used to test Safe Scroll's text and image moderation behavior:

- [Nicki Minaj - Barbie Dreams Lyrics](https://genius.com/Nicki-minaj-barbie-dreams-lyrics)
- [Cardi B - WAP Lyrics](https://genius.com/Cardi-b-wap-lyrics)
- [Nicki Minaj - Anaconda Lyrics](https://genius.com/Nicki-minaj-anaconda-lyrics)

These pages are useful because they include lyrics, descriptions, and/or imagery that can help demonstrate Safe Scroll's ability to highlight or blur sensitive content.
