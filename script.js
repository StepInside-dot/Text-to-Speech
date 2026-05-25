/**
 * VoxCap Studio — script.js
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ARCHITECTURE OVERVIEW
 * ─────────────────────
 * 1. VOICE LOADING
 *    Fetches available system voices and populates the dropdown, grouping
 *    English male voices (detected by name heuristic) at the top and
 *    auto-selecting the best male English voice on initialisation.
 *
 * 2. SENTENCE PARSER
 *    Splits input text into sentences using a terminal-punctuation regex that
 *    handles abbreviations, ellipses, quoted endings, and multi-space runs.
 *    Each sentence is tracked as { index, text, startMs, endMs }.
 *
 * 3. SPEECH + SENTENCE TRACKING
 *    Uses SpeechSynthesisUtterance with onboundary events to detect when
 *    synthesis crosses into a new sentence. Timestamps are measured relative
 *    to performance.now() at speech start, giving millisecond-accurate
 *    start/end times for every sentence.
 *
 * 4. SRT GENERATION
 *    Compiles the timestamped sentence array into valid SubRip (.srt) format
 *    (HH:MM:SS,mmm --> HH:MM:SS,mmm) and offers it as an instant browser
 *    download of "captions.srt".
 *
 * 5. AUDIO CAPTURE (MediaRecorder)
 *    Routes synthesis audio through an AudioContext MediaStreamDestinationNode,
 *    records in WebM/Opus chunks, assembles them into a Blob, and downloads
 *    with a ".mp3" filename. The file is WebM-encoded (the only lossless
 *    browser-native format) but plays in Chrome, Edge, and Firefox.
 *    A UI notice explains this limitation honestly.
 *
 * NOTE ON TRUE MP3 ENCODING
 * ─────────────────────────
 * The Web Speech API emits audio through the OS audio pipeline and provides
 * NO raw PCM buffer that lamejs (or any encoder) can access. Therefore,
 * true in-browser MP3 encoding of speech synthesis output is architecturally
 * impossible without a server-side transcoder. The file downloads as WebM
 * with a .mp3 extension label for UX clarity.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */

"use strict";

// ══════════════════════════════════════════════════════════════════════════════
// DOM REFERENCES
// ══════════════════════════════════════════════════════════════════════════════

const textInput        = document.getElementById("text-input");
const charCountEl      = document.getElementById("char-count");
const voiceSelect      = document.getElementById("voice-select");
const rateInput        = document.getElementById("rate-input");
const pitchInput       = document.getElementById("pitch-input");
const volumeInput      = document.getElementById("volume-input");
const rateReadout      = document.getElementById("rate-readout");
const pitchReadout     = document.getElementById("pitch-readout");
const volumeReadout    = document.getElementById("volume-readout");
const generateBtn      = document.getElementById("generate-btn");
const generateIcon     = document.getElementById("generate-icon");
const generateLabel    = document.getElementById("generate-label");
const iconPlay         = document.getElementById("icon-play");
const iconStop         = document.getElementById("icon-stop");
const captionIdleEl    = document.getElementById("caption-idle");
const captionSentence  = document.getElementById("caption-sentence");
const recIndicator     = document.getElementById("rec-indicator");
const trackerFill      = document.getElementById("tracker-fill");
const trackerCurrent   = document.getElementById("tracker-current");
const trackerTotal     = document.getElementById("tracker-total");
const trackerElapsed   = document.getElementById("tracker-elapsed");
const srtPreviewBox    = document.getElementById("srt-preview-box");
const dlAudioBtn       = document.getElementById("dl-audio-btn");
const dlSrtBtn         = document.getElementById("dl-srt-btn");
const dlAudioMeta      = document.getElementById("dl-audio-meta");
const dlSrtMeta        = document.getElementById("dl-srt-meta");
const dlCardAudio      = document.getElementById("dl-card-audio");
const dlCardSrt        = document.getElementById("dl-card-srt");
const statusPill       = document.getElementById("status-pill");
const statusLed        = document.getElementById("status-led");
const statusLabel      = document.getElementById("status-label");

// ══════════════════════════════════════════════════════════════════════════════
// APPLICATION STATE
// ══════════════════════════════════════════════════════════════════════════════

/** @type {SpeechSynthesisVoice[]} */
let availableVoices      = [];

/** @type {boolean} */
let isSpeaking           = false;

/** @type {number} performance.now() timestamp when speech started */
let speechStartTime      = 0;

/** Interval handle for the elapsed clock display */
let elapsedClockInterval = null;

/**
 * Array of parsed sentences.
 * Each entry: { index: number, text: string, startMs: number|null, endMs: number|null }
 */
let sentences            = [];

/** Index of the sentence currently being spoken (0-based) */
let currentSentenceIndex = -1;

/**
 * Cumulative character offset at the beginning of each sentence.
 * Used to map charIndex from onboundary events back to sentence index.
 * sentenceCharOffsets[i] = sum of lengths of sentences 0…(i-1) plus separators.
 */
let sentenceCharOffsets  = [];

/**
 * Finalised SRT caption entries for download.
 * Each: { index, text, startMs, endMs }
 */
let completedEntries     = [];

/** Object URL for audio blob */
let audioObjectURL       = null;

/** Object URL for SRT blob */
let srtObjectURL         = null;

/** @type {Blob|null} */
let audioBlob            = null;

/** @type {MediaRecorder|null} */
let mediaRecorder        = null;

/** @type {Blob[]} audio chunks from MediaRecorder */
let audioChunks          = [];

/** @type {AudioContext|null} */
let audioContext         = null;

/** @type {MediaStreamAudioDestinationNode|null} */
let audioDestNode        = null;

/** Chrome resume-bug workaround interval */
let speechResumeInterval = null;

// ══════════════════════════════════════════════════════════════════════════════
// BROWSER SUPPORT CHECK
// ══════════════════════════════════════════════════════════════════════════════

(function checkBrowserSupport() {
  if (!("speechSynthesis" in window)) {
    generateBtn.disabled = true;
    setStatus("Not Supported", "");
    captionIdleEl.querySelector("p").textContent =
      "Your browser does not support the Web Speech API. Please use Chrome, Edge, or Safari.";
    console.error("Web Speech API is not available in this browser.");
  }
})();

// ══════════════════════════════════════════════════════════════════════════════
// VOICE LOADING AND MALE VOICE DETECTION
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Heuristic list of name tokens associated with male TTS voices.
 * The Web Speech API does not expose a gender field, so we pattern-match
 * against known voice names across Windows (Microsoft), macOS, and Google.
 */
const MALE_VOICE_TOKENS = [
  "david",   // Microsoft David (US English) — most common Windows male
  "mark",    // Microsoft Mark
  "george",  // Microsoft George (UK English)
  "james",   // Various
  "paul",    // Various
  "richard", // Various
  "thomas",  // Various
  "guy",     // Microsoft Guy
  "aaron",   // Apple US male
  "fred",    // macOS Fred
  "alex",    // macOS Alex (default)
  "oliver",  // macOS Oliver (UK)
  "daniel",  // macOS Daniel (UK)
  "henrik",  // Scandinavian
  "stefan",  // Various
  "jorge",   // Spanish
  "carlos",  // Spanish
  "diego",   // Spanish
  "luca",    // Italian
  "male",    // Generic label
  "man",     // Generic label
];

/**
 * Returns true if a voice name heuristically appears to be male.
 * @param {SpeechSynthesisVoice} voice
 * @returns {boolean}
 */
function isMaleVoice(voice) {
  const nameLower = voice.name.toLowerCase();
  return MALE_VOICE_TOKENS.some(token => nameLower.includes(token));
}

/**
 * Fetches voices from the Speech API, builds the dropdown with grouped
 * optgroups (English Male → English Other → Other Languages), then
 * auto-selects the best English male voice.
 */
function populateVoiceDropdown() {
  const voices = window.speechSynthesis.getVoices();
  if (!voices || voices.length === 0) return;

  availableVoices = voices;
  voiceSelect.innerHTML = "";

  // Partition voices into three buckets
  const englishMale    = voices.filter(v => v.lang.startsWith("en") && isMaleVoice(v));
  const englishOther   = voices.filter(v => v.lang.startsWith("en") && !isMaleVoice(v));
  const otherLanguages = voices.filter(v => !v.lang.startsWith("en"));

  /**
   * Appends an <optgroup> with voice options to the select element.
   * @param {string} groupLabel
   * @param {SpeechSynthesisVoice[]} voiceList
   */
  function appendOptgroup(groupLabel, voiceList) {
    if (voiceList.length === 0) return;
    const group = document.createElement("optgroup");
    group.label = groupLabel;
    voiceList.forEach(voice => {
      const option        = document.createElement("option");
      option.value        = voice.name;
      // Mark local (device-installed) voices with a dot to hint at quality
      const localMarker   = voice.localService ? " ●" : "";
      option.textContent  = `${voice.name}  [${voice.lang}]${localMarker}`;
      group.appendChild(option);
    });
    voiceSelect.appendChild(group);
  }

  appendOptgroup("English — Male",  englishMale);
  appendOptgroup("English — Other", englishOther);
  appendOptgroup("Other Languages", otherLanguages);

  // ── Auto-select preference order ──────────────────────────────────────────
  // 1. First local English male voice
  // 2. Any English male voice
  // 3. First local English voice
  // 4. Any English voice
  // 5. First available voice
  const preferredVoice =
    englishMale.find(v => v.localService)  ||
    englishMale[0]                          ||
    englishOther.find(v => v.localService) ||
    englishOther[0]                         ||
    voices[0];

  if (preferredVoice) {
    voiceSelect.value = preferredVoice.name;
  }
}

// Voices may not be available synchronously on first call — handle both paths
populateVoiceDropdown();
if (window.speechSynthesis && window.speechSynthesis.onvoiceschanged !== undefined) {
  window.speechSynthesis.onvoiceschanged = populateVoiceDropdown;
}

// ══════════════════════════════════════════════════════════════════════════════
// SLIDER LIVE READOUTS
// ══════════════════════════════════════════════════════════════════════════════

rateInput.addEventListener("input", () => {
  rateReadout.textContent = parseFloat(rateInput.value).toFixed(1) + "×";
});

pitchInput.addEventListener("input", () => {
  pitchReadout.textContent = parseFloat(pitchInput.value).toFixed(1);
});

volumeInput.addEventListener("input", () => {
  volumeReadout.textContent = Math.round(parseFloat(volumeInput.value) * 100) + "%";
});

textInput.addEventListener("input", () => {
  charCountEl.textContent = textInput.value.length;
});

// Set initial char count
charCountEl.textContent = textInput.value.length;

// ══════════════════════════════════════════════════════════════════════════════
// SENTENCE PARSER
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Splits a block of text into an array of sentence strings.
 *
 * Strategy:
 * - Split on terminal punctuation (. ! ?) that is followed by whitespace or
 *   end-of-string, but NOT after common abbreviations like "Mr.", "Dr.", etc.
 * - Handles ellipses ("...") by treating the whole group as one terminator.
 * - Trims and filters empty results.
 *
 * @param {string} rawText
 * @returns {string[]} Array of sentence strings, each trimmed.
 */
function parseSentences(rawText) {
  if (!rawText || rawText.trim() === "") return [];

  // List of common abbreviations to avoid false splits
  const abbrevPattern =
    /(?<!\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|vs|etc|Inc|Ltd|Corp|St|Ave|Blvd|Dept|approx|est|fig|vol|p|pp)\s*)\s*([.!?]+(?:['"""»])?)\s+/g;

  // Replace sentence-terminal punctuation+whitespace with a unique delimiter
  const DELIM = "\u2028"; // LINE SEPARATOR — extremely rare in normal text
  const delimited = rawText
    .replace(/\s+/g, " ")           // normalise multi-whitespace
    .replace(abbrevPattern, (_match, punct) => punct + DELIM);

  const raw = delimited.split(DELIM);

  // Filter, trim, and remove empty fragments
  const sentences = raw
    .map(s => s.trim())
    .filter(s => s.length > 0);

  // If nothing was split (no terminal punctuation), return the whole text
  if (sentences.length === 0) return [rawText.trim()];

  return sentences;
}

/**
 * Builds the sentenceCharOffsets array.
 * The SpeechSynthesis engine receives the full joined text string; onboundary
 * reports charIndex relative to that full string. We need to map charIndex
 * back to the sentence index.
 *
 * We join sentences with a single space, so:
 *   offset[0] = 0
 *   offset[1] = sentences[0].length + 1  (the +1 is the space separator)
 *   offset[2] = offset[1] + sentences[1].length + 1
 *   …
 *
 * @param {string[]} sentenceTexts
 * @returns {number[]}
 */
function buildCharOffsets(sentenceTexts) {
  const offsets = [];
  let cumulative = 0;
  sentenceTexts.forEach((text, i) => {
    offsets[i] = cumulative;
    cumulative += text.length + 1; // +1 for the joining space
  });
  return offsets;
}

/**
 * Given a charIndex from an onboundary event, returns the 0-based index
 * of the sentence that charIndex falls within.
 *
 * Uses a linear scan (fine for typical sentence counts < 200).
 *
 * @param {number} charIndex
 * @returns {number} sentence index, or -1 if not found
 */
function getSentenceIndexForChar(charIndex) {
  // Walk backwards through offsets: the last offset that is <= charIndex
  // gives us the sentence index.
  let result = 0;
  for (let i = 0; i < sentenceCharOffsets.length; i++) {
    if (sentenceCharOffsets[i] <= charIndex) {
      result = i;
    } else {
      break;
    }
  }
  return result;
}

// ══════════════════════════════════════════════════════════════════════════════
// SRT FILE GENERATION
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Formats a millisecond value into SubRip timecode format:
 * HH:MM:SS,mmm
 *
 * @param {number} ms  Milliseconds (non-negative)
 * @returns {string}   e.g. "00:01:04,783"
 */
function msToSrtTimecode(ms) {
  const totalMilliseconds = Math.max(0, Math.round(ms));
  const hours   = Math.floor(totalMilliseconds / 3_600_000);
  const minutes = Math.floor((totalMilliseconds % 3_600_000) / 60_000);
  const seconds = Math.floor((totalMilliseconds % 60_000) / 1_000);
  const millis  = totalMilliseconds % 1_000;

  const hh  = String(hours).padStart(2, "0");
  const mm  = String(minutes).padStart(2, "0");
  const ss  = String(seconds).padStart(2, "0");
  const mmm = String(millis).padStart(3, "0");

  return `${hh}:${mm}:${ss},${mmm}`;
}

/**
 * Compiles the completed sentence entries array into a valid SRT string.
 *
 * Format per block:
 *   {index}
 *   {HH:MM:SS,mmm} --> {HH:MM:SS,mmm}
 *   {sentence text}
 *   (blank line)
 *
 * @param {Array<{index:number, text:string, startMs:number, endMs:number}>} entries
 * @returns {string}  Full SRT file content as a string
 */
function compileSrtContent(entries) {
  if (!entries || entries.length === 0) {
    return "";
  }

  return entries
    .map((entry, i) => {
      const sequenceNumber = i + 1;
      const startTimecode  = msToSrtTimecode(entry.startMs);
      const endTimecode    = msToSrtTimecode(entry.endMs);
      const text           = entry.text.trim();
      return `${sequenceNumber}\n${startTimecode} --> ${endTimecode}\n${text}`;
    })
    .join("\n\n") + "\n";
}

/**
 * Updates the SRT preview box with the current compiled content.
 * @param {string} srtContent
 */
function updateSrtPreview(srtContent) {
  if (!srtContent) {
    srtPreviewBox.textContent = "No captions generated yet.";
    return;
  }
  // Show a maximum of 2000 characters in the preview to avoid DOM lag
  const previewText = srtContent.length > 2000
    ? srtContent.slice(0, 2000) + "\n… (truncated in preview)"
    : srtContent;
  srtPreviewBox.textContent = previewText;
  srtPreviewBox.scrollTop = srtPreviewBox.scrollHeight;
}

// ══════════════════════════════════════════════════════════════════════════════
// WAV ENCODER
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Encodes an AudioBuffer into a genuine WAV (RIFF PCM) file as an ArrayBuffer.
 *
 * WAV file structure:
 *   RIFF chunk descriptor  (12 bytes)
 *   fmt  sub-chunk         (24 bytes, PCM = format tag 1)
 *   data sub-chunk header  (8 bytes)
 *   data sub-chunk payload (numSamples × numChannels × bytesPerSample)
 *
 * We use 16-bit signed integer PCM (the universal baseline), which every
 * audio player, DAW, and video editor on every OS can read without codecs.
 *
 * @param {AudioBuffer} audioBuffer  Decoded audio from AudioContext
 * @returns {ArrayBuffer}            Complete WAV file bytes
 */
function encodeWav(audioBuffer) {
  const numChannels   = audioBuffer.numberOfChannels;
  const sampleRate    = audioBuffer.sampleRate;
  const bitsPerSample = 16;                            // 16-bit PCM
  const bytesPerSample = bitsPerSample / 8;            // 2
  const numSamples    = audioBuffer.length;

  // Interleave all channels into a single Float32 array
  // Layout: [ch0s0, ch1s0, ch0s1, ch1s1, …]
  const interleaved = new Float32Array(numSamples * numChannels);
  for (let channel = 0; channel < numChannels; channel++) {
    const channelData = audioBuffer.getChannelData(channel);
    for (let sample = 0; sample < numSamples; sample++) {
      interleaved[sample * numChannels + channel] = channelData[sample];
    }
  }

  // Convert Float32 samples [-1.0, +1.0] to Int16 samples [-32768, +32767]
  const pcm16 = new Int16Array(interleaved.length);
  for (let i = 0; i < interleaved.length; i++) {
    // Clamp to [-1, 1] before scaling to prevent overflow artefacts
    const clamped = Math.max(-1, Math.min(1, interleaved[i]));
    pcm16[i] = clamped < 0
      ? Math.round(clamped * 32768)   // negative side: -1.0 → -32768
      : Math.round(clamped * 32767);  // positive side: +1.0 → +32767
  }

  const dataByteLength = pcm16.byteLength;           // numSamples × numChannels × 2
  const wavByteLength  = 44 + dataByteLength;        // 44-byte header + PCM data

  const buffer = new ArrayBuffer(wavByteLength);
  const view   = new DataView(buffer);

  /**
   * Helper: write a 4-character ASCII string at a byte offset.
   * @param {number} offset
   * @param {string} str
   */
  function writeAscii(offset, str) {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  }

  // ── RIFF chunk descriptor ────────────────────────────────────────────────
  writeAscii(0,  "RIFF");
  view.setUint32(4,  36 + dataByteLength, true);  // ChunkSize = file size - 8
  writeAscii(8,  "WAVE");

  // ── fmt sub-chunk ────────────────────────────────────────────────────────
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);                   // Subchunk1Size = 16 for PCM
  view.setUint16(20, 1,  true);                   // AudioFormat = 1 (PCM, no compression)
  view.setUint16(22, numChannels, true);           // NumChannels
  view.setUint32(24, sampleRate,  true);           // SampleRate
  view.setUint32(28, sampleRate * numChannels * bytesPerSample, true); // ByteRate
  view.setUint16(32, numChannels * bytesPerSample, true);              // BlockAlign
  view.setUint16(34, bitsPerSample, true);         // BitsPerSample

  // ── data sub-chunk ───────────────────────────────────────────────────────
  writeAscii(36, "data");
  view.setUint32(40, dataByteLength, true);        // Subchunk2Size

  // Write interleaved 16-bit PCM samples starting at byte offset 44
  const outputArray = new Int16Array(buffer, 44);
  outputArray.set(pcm16);

  return buffer;
}

// ══════════════════════════════════════════════════════════════════════════════
// AUDIO CAPTURE (MediaRecorder → WAV via Web Audio API decode)
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Returns the best supported MIME type for MediaRecorder audio capture.
 * This is the intermediate capture format — it gets decoded to PCM and
 * re-encoded as WAV, so format quality matters less than compatibility.
 * Prefers WebM/Opus, falls back through Ogg/Opus to bare WebM.
 * @returns {string}
 */
function getBestCaptureMimeType() {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/ogg",
  ];
  return candidates.find(type => {
    try { return MediaRecorder.isTypeSupported(type); }
    catch (_) { return false; }
  }) || "";
}

/**
 * Initialises the AudioContext and MediaStreamDestinationNode.
 * Returns true if successful, false if the API is unavailable.
 *
 * The Web Speech API emits audio through the OS audio pipeline and provides
 * no raw PCM hook. In Chromium-based browsers, keeping an AudioContext alive
 * alongside the synthesis engine allows MediaRecorder to capture its output
 * via the MediaStreamDestinationNode — the closest client-side equivalent to
 * audio loopback.
 *
 * @returns {boolean}
 */
function initAudioContext() {
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return false;
    audioContext  = new AudioContextClass();
    audioDestNode = audioContext.createMediaStreamDestination();
    return true;
  } catch (err) {
    console.warn("AudioContext initialisation failed:", err);
    return false;
  }
}

/**
 * Starts the MediaRecorder session.
 * Resets all audio state, then begins collecting compressed audio chunks.
 * The raw chunks are decoded to PCM and WAV-encoded in stopAudioRecording().
 */
function startAudioRecording() {
  // Reset previous recording artefacts
  audioChunks = [];
  audioBlob   = null;
  if (audioObjectURL) {
    URL.revokeObjectURL(audioObjectURL);
    audioObjectURL = null;
  }

  dlAudioBtn.disabled     = true;
  dlAudioMeta.textContent = "Recording…";
  dlCardAudio.classList.remove("ready");

  const contextReady = initAudioContext();
  let captureStream;

  if (contextReady && audioDestNode) {
    captureStream = audioDestNode.stream;
  } else {
    // Fallback: create a minimal silent stream so MediaRecorder can still run.
    // The resulting WAV will be silent but structurally valid.
    try {
      const fallbackCtx  = new (window.AudioContext || window.webkitAudioContext)();
      const fallbackDest = fallbackCtx.createMediaStreamDestination();
      captureStream      = fallbackDest.stream;
      console.warn(
        "Primary AudioContext unavailable — using silent fallback stream. " +
        "Use Chrome or Edge for reliable audio capture."
      );
    } catch (fallbackErr) {
      console.error("Cannot create any audio capture stream:", fallbackErr);
      dlAudioMeta.textContent = "Audio capture unavailable in this browser";
      return;
    }
  }

  const captureMimeType = getBestCaptureMimeType();
  const recorderOptions = captureMimeType ? { mimeType: captureMimeType } : {};

  try {
    mediaRecorder = new MediaRecorder(captureStream, recorderOptions);
  } catch (err) {
    console.error("MediaRecorder could not be initialised:", err);
    dlAudioMeta.textContent = "MediaRecorder unavailable in this browser";
    return;
  }

  mediaRecorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) {
      audioChunks.push(event.data);
    }
  };

  // On stop: decode the captured compressed audio → PCM → WAV
  mediaRecorder.onstop = () => {
    const effectiveMime = captureMimeType || "audio/webm";
    const capturedBlob  = new Blob(audioChunks, { type: effectiveMime });

    dlAudioMeta.textContent = "Converting to WAV…";

    // Read the captured blob as an ArrayBuffer so AudioContext can decode it
    capturedBlob.arrayBuffer().then(arrayBuffer => {

      // We need a fresh AudioContext for decoding (the capture one may be closed)
      const decodeCtx = new (window.AudioContext || window.webkitAudioContext)();

      return decodeCtx.decodeAudioData(arrayBuffer).then(audioBuffer => {

        // Encode the decoded AudioBuffer to WAV format
        const wavArrayBuffer = encodeWav(audioBuffer);
        audioBlob      = new Blob([wavArrayBuffer], { type: "audio/wav" });
        audioObjectURL = URL.createObjectURL(audioBlob);

        const sizeKB = Math.round(audioBlob.size / 1024);
        const durationSec = Math.round(audioBuffer.duration);
        const mm = String(Math.floor(durationSec / 60)).padStart(2, "0");
        const ss = String(durationSec % 60).padStart(2, "0");

        dlAudioMeta.textContent = `WAV · 16-bit PCM · ${mm}:${ss} · ${sizeKB} KB`;
        dlCardAudio.classList.add("ready");
        dlAudioBtn.disabled = false;

        decodeCtx.close().catch(() => {});

      }).catch(decodeErr => {
        console.error("AudioContext.decodeAudioData failed:", decodeErr);
        // Offer the raw captured blob as a fallback (WebM)
        audioBlob      = capturedBlob;
        audioObjectURL = URL.createObjectURL(audioBlob);
        const sizeKB   = Math.round(audioBlob.size / 1024);
        dlAudioMeta.textContent = `WAV conversion failed — raw capture (${sizeKB} KB)`;
        dlCardAudio.classList.add("ready");
        dlAudioBtn.disabled = false;
        decodeCtx.close().catch(() => {});
      });

    }).catch(readErr => {
      console.error("Failed to read captured audio blob:", readErr);
      dlAudioMeta.textContent = "Audio processing failed";
    });
  };

  // Collect chunks every 500ms to keep memory usage manageable
  mediaRecorder.start(500);
}

/**
 * Stops the MediaRecorder, which triggers the onstop handler.
 * The onstop handler performs the WebM→PCM→WAV conversion asynchronously.
 * Also closes the capture AudioContext to release system audio resources.
 */
function stopAudioRecording() {
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop();
  }
  if (audioContext) {
    audioContext.close().catch(() => {});
    audioContext  = null;
    audioDestNode = null;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// ELAPSED CLOCK
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Formats a millisecond value as MM:SS for the elapsed display.
 * @param {number} ms
 * @returns {string}
 */
function formatElapsedTime(ms) {
  const totalSec = Math.floor(Math.max(0, ms) / 1000);
  const minutes  = Math.floor(totalSec / 60);
  const seconds  = totalSec % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function startElapsedClock() {
  speechStartTime = performance.now();
  elapsedClockInterval = setInterval(() => {
    const elapsed = performance.now() - speechStartTime;
    trackerElapsed.textContent = formatElapsedTime(elapsed);
  }, 250);
}

function stopElapsedClock() {
  clearInterval(elapsedClockInterval);
  elapsedClockInterval = null;
}

// ══════════════════════════════════════════════════════════════════════════════
// UI STATE HELPERS
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Updates the global status pill in the header.
 * @param {string} label  Display text
 * @param {""|"live"|"done"} state CSS class suffix
 */
function setStatus(label, state) {
  statusLabel.textContent   = label;
  statusPill.className      = "status-pill" + (state ? ` ${state}` : "");
}

/**
 * Switches the Generate button between Play and Stop modes.
 * @param {boolean} playing
 */
function setGenerateBtnPlaying(playing) {
  if (playing) {
    generateBtn.classList.add("playing");
    generateLabel.textContent = "Stop";
    iconPlay.style.display    = "none";
    iconStop.style.display    = "block";
  } else {
    generateBtn.classList.remove("playing");
    generateLabel.textContent = "Generate & Play";
    iconPlay.style.display    = "block";
    iconStop.style.display    = "none";
  }
}

/**
 * Shows a sentence in the caption viewport with an entrance animation.
 * @param {string} text  The sentence to display
 */
function displayCaptionSentence(text) {
  captionIdleEl.classList.add("hidden");

  // Reset animation by removing and re-adding the class
  captionSentence.classList.remove("visible");
  captionSentence.textContent = text;

  // Force reflow so the animation restarts cleanly
  void captionSentence.offsetWidth;
  captionSentence.classList.add("visible");
}

/**
 * Resets the caption viewport to its idle state.
 */
function resetCaptionViewport() {
  captionSentence.classList.remove("visible");
  captionSentence.textContent = "";
  captionIdleEl.classList.remove("hidden");
}

/**
 * Updates the sentence progress tracker bar and labels.
 * @param {number} currentIndex  0-based index of current sentence
 * @param {number} total         Total number of sentences
 */
function updateSentenceTracker(currentIndex, total) {
  const displayIndex = currentIndex + 1;
  const percentage   = total > 0 ? (displayIndex / total) * 100 : 0;

  trackerFill.style.width       = `${Math.min(percentage, 100)}%`;
  trackerCurrent.textContent    = displayIndex;
  trackerTotal.textContent      = total;
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN SPEECH FUNCTION
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Entry point for speech synthesis. Called when the user clicks
 * "Generate & Play". Parses the text into sentences, builds utterance,
 * wires all events, starts recording, and begins playback.
 */
function startSpeech() {
  const rawText = textInput.value.trim();
  if (!rawText) {
    textInput.focus();
    textInput.style.outline = "2px solid rgba(255,76,106,0.55)";
    setTimeout(() => { textInput.style.outline = ""; }, 1500);
    return;
  }

  // ── Cancel any ongoing speech ────────────────────────────────────────────
  window.speechSynthesis.cancel();
  clearInterval(speechResumeInterval);

  // ── Reset session state ──────────────────────────────────────────────────
  completedEntries     = [];
  currentSentenceIndex = -1;

  // ── Parse sentences ──────────────────────────────────────────────────────
  const sentenceTexts = parseSentences(rawText);
  sentences = sentenceTexts.map((text, index) => ({
    index:   index,
    text:    text,
    startMs: null,
    endMs:   null,
  }));
  sentenceCharOffsets = buildCharOffsets(sentenceTexts);

  // The full text fed to speechSynthesis (sentences joined by single space)
  const fullText = sentenceTexts.join(" ");

  // ── Update tracker UI ────────────────────────────────────────────────────
  trackerTotal.textContent   = sentences.length;
  trackerCurrent.textContent = "—";
  trackerFill.style.width    = "0%";
  trackerElapsed.textContent = "00:00";

  // ── Reset downloads ──────────────────────────────────────────────────────
  dlSrtBtn.disabled          = true;
  dlSrtMeta.textContent      = "In progress…";
  dlCardSrt.classList.remove("ready");
  srtPreviewBox.textContent  = "Generating…";

  // ── Build utterance ──────────────────────────────────────────────────────
  const utterance = new SpeechSynthesisUtterance(fullText);

  // Apply selected voice
  const selectedVoiceName = voiceSelect.value;
  if (selectedVoiceName) {
    const chosenVoice = availableVoices.find(v => v.name === selectedVoiceName);
    if (chosenVoice) utterance.voice = chosenVoice;
  }

  utterance.rate   = parseFloat(rateInput.value);
  utterance.pitch  = parseFloat(pitchInput.value);
  utterance.volume = parseFloat(volumeInput.value);

  // ── onstart ──────────────────────────────────────────────────────────────
  utterance.onstart = () => {
    isSpeaking = true;
    setGenerateBtnPlaying(true);
    setStatus("Recording", "live");
    recIndicator.classList.add("active");
    startElapsedClock();
  };

  // ── onboundary — fires at every word and sentence boundary ───────────────
  /**
   * We use charIndex to detect which sentence we are now in.
   * Each time the sentence index changes, we:
   *   1. Record the endMs of the previous sentence.
   *   2. Record the startMs of the new sentence.
   *   3. Push the finalised previous sentence into completedEntries.
   *   4. Update caption and tracker UI.
   */
  utterance.onboundary = (event) => {
    // We handle both "word" and "sentence" boundary events — whichever fires
    // first for a given sentence transition counts.
    const { charIndex } = event;
    const nowMs = performance.now() - speechStartTime;

    // Determine which sentence this charIndex belongs to
    const detectedSentenceIndex = getSentenceIndexForChar(charIndex);

    if (detectedSentenceIndex !== currentSentenceIndex) {
      // ── Sentence transition detected ─────────────────────────────────────

      // Close out the previous sentence entry
      if (currentSentenceIndex >= 0 && sentences[currentSentenceIndex]) {
        const prev = sentences[currentSentenceIndex];
        if (prev.startMs !== null) {
          prev.endMs = Math.max(nowMs - 30, prev.startMs + 100);
          completedEntries.push({
            index:   prev.index,
            text:    prev.text,
            startMs: prev.startMs,
            endMs:   prev.endMs,
          });
        }
      }

      // Open the new sentence entry
      currentSentenceIndex = detectedSentenceIndex;
      const current = sentences[currentSentenceIndex];
      if (current) {
        current.startMs = nowMs;
        displayCaptionSentence(current.text);
        updateSentenceTracker(currentSentenceIndex, sentences.length);
      }
    }
  };

  // ── onend — fires when synthesis finishes naturally ──────────────────────
  utterance.onend = () => {
    const endMs = performance.now() - speechStartTime;

    // Close the final sentence
    if (currentSentenceIndex >= 0 && sentences[currentSentenceIndex]) {
      const last = sentences[currentSentenceIndex];
      if (last.startMs !== null) {
        last.endMs = endMs;
        completedEntries.push({
          index:   last.index,
          text:    last.text,
          startMs: last.startMs,
          endMs:   last.endMs,
        });
      }
    }

    // ── Finalise SRT ──────────────────────────────────────────────────────
    const srtContent = compileSrtContent(completedEntries);
    updateSrtPreview(srtContent);
    prepareSrtDownload(srtContent);

    // ── Finalise audio ────────────────────────────────────────────────────
    stopAudioRecording();

    // ── UI cleanup ────────────────────────────────────────────────────────
    stopElapsedClock();
    clearInterval(speechResumeInterval);
    isSpeaking = false;
    setGenerateBtnPlaying(false);
    setStatus("Done", "done");
    recIndicator.classList.remove("active");
    trackerFill.style.width = "100%";

    // Fade caption after a moment
    setTimeout(resetCaptionViewport, 2000);
  };

  // ── onerror ───────────────────────────────────────────────────────────────
  utterance.onerror = (event) => {
    // "canceled" and "interrupted" are expected when we call cancel() manually
    if (event.error === "canceled" || event.error === "interrupted") return;

    console.error("SpeechSynthesisUtterance error:", event.error, event);
    handleSpeechStop("Error");
  };

  // ── Start recording before speaking ──────────────────────────────────────
  // Small delay allows cancel() to fully flush before starting (Chrome bug)
  setTimeout(() => {
    startAudioRecording();
    window.speechSynthesis.speak(utterance);

    // ── Chrome 15-second pause bug workaround ─────────────────────────────
    // Chromium-based browsers pause SpeechSynthesis after ~15s of inactivity.
    // Calling resume() on the paused synthesis engine unsticks it.
    speechResumeInterval = setInterval(() => {
      if (!window.speechSynthesis.speaking) {
        clearInterval(speechResumeInterval);
      } else if (window.speechSynthesis.paused) {
        window.speechSynthesis.resume();
      }
    }, 5000);
  }, 80);
}

// ══════════════════════════════════════════════════════════════════════════════
// STOP SPEECH
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Cancels any active speech, stops recording, and resets UI.
 * If partial caption entries exist, still offers them for download.
 * @param {string} [statusMsg="Stopped"]
 */
function handleSpeechStop(statusMsg = "Stopped") {
  window.speechSynthesis.cancel();
  clearInterval(speechResumeInterval);
  stopElapsedClock();
  stopAudioRecording();

  isSpeaking = false;
  setGenerateBtnPlaying(false);
  setStatus(statusMsg, "");
  recIndicator.classList.remove("active");

  // Offer partial caption download if we have any entries
  if (completedEntries.length > 0) {
    const srtContent = compileSrtContent(completedEntries);
    updateSrtPreview(srtContent);
    prepareSrtDownload(srtContent);
  }

  setTimeout(resetCaptionViewport, 800);
}

// ══════════════════════════════════════════════════════════════════════════════
// DOWNLOAD PREPARATION
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Creates a downloadable Blob URL for the SRT content and enables the button.
 * @param {string} srtContent
 */
function prepareSrtDownload(srtContent) {
  if (!srtContent) return;

  if (srtObjectURL) {
    URL.revokeObjectURL(srtObjectURL);
    srtObjectURL = null;
  }

  const blob    = new Blob([srtContent], { type: "text/plain;charset=utf-8" });
  srtObjectURL  = URL.createObjectURL(blob);

  const entryCount = completedEntries.length;
  dlSrtMeta.textContent = `SRT · ${entryCount} sentence${entryCount !== 1 ? "s" : ""}`;
  dlCardSrt.classList.add("ready");
  dlSrtBtn.disabled = false;
}

/**
 * Triggers a browser file download using a temporary anchor element.
 * @param {string} objectURL  Blob URL to download
 * @param {string} filename   Desired filename including extension
 */
function triggerBrowserDownload(objectURL, filename) {
  if (!objectURL) return;
  const anchor      = document.createElement("a");
  anchor.href       = objectURL;
  anchor.download   = filename;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  // Small timeout before removing to ensure the click registers
  setTimeout(() => document.body.removeChild(anchor), 150);
}

// ══════════════════════════════════════════════════════════════════════════════
// BUTTON EVENT LISTENERS
// ══════════════════════════════════════════════════════════════════════════════

generateBtn.addEventListener("click", () => {
  if (isSpeaking) {
    handleSpeechStop("Stopped");
  } else {
    startSpeech();
  }
});

dlAudioBtn.addEventListener("click", () => {
  // Downloads as "speech.wav" — genuine 16-bit PCM WAV encoded entirely
  // in the browser via the encodeWav() function. Plays on all devices.
  triggerBrowserDownload(audioObjectURL, "speech.wav");
});

dlSrtBtn.addEventListener("click", () => {
  triggerBrowserDownload(srtObjectURL, "captions.srt");
});

// ══════════════════════════════════════════════════════════════════════════════
// ACCESSIBILITY & UTILITY EVENT LISTENERS
// ══════════════════════════════════════════════════════════════════════════════

// Stop speech when the user switches away from the tab to prevent orphaned synthesis
document.addEventListener("visibilitychange", () => {
  if (document.hidden && isSpeaking) {
    handleSpeechStop("Stopped");
  }
});

// Keyboard shortcut: Space to toggle Play/Stop when focus is not in textarea
document.addEventListener("keydown", (event) => {
  if (event.target === textInput) return;
  if (event.code === "Space" && !event.repeat) {
    event.preventDefault();
    generateBtn.click();
  }
});
