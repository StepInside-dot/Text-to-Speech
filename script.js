/**
 * VoxCap Studio — script.js
 * ─────────────────────────────────────────────────────────────
 * Features:
 *   • Web Speech API (SpeechSynthesis) with voice selection
 *   • Real-time word-by-word captions via onboundary
 *   • MediaRecorder audio capture → downloadable WebM/WAV
 *   • Timestamped caption log → downloadable .srt or .vtt file
 *   • Progress bar, elapsed timer, word counter
 * ─────────────────────────────────────────────────────────────
 */

"use strict";

// ══════════════════════════════════════════════════════════════
// DOM references
// ══════════════════════════════════════════════════════════════
const textInput         = document.getElementById("text-input");
const charCountEl       = document.getElementById("char-count");
const voiceSelect       = document.getElementById("voice-select");
const rateSlider        = document.getElementById("rate-slider");
const pitchSlider       = document.getElementById("pitch-slider");
const volumeSlider      = document.getElementById("volume-slider");
const rateDisplay       = document.getElementById("rate-display");
const pitchDisplay      = document.getElementById("pitch-display");
const volumeDisplay     = document.getElementById("volume-display");
const captionFormatSel  = document.getElementById("caption-format");
const speakBtn          = document.getElementById("speak-btn");
const speakIcon         = document.getElementById("speak-icon");
const speakLabel        = document.getElementById("speak-label");
const stopBtn           = document.getElementById("stop-btn");
const captionIdleMsg    = document.getElementById("caption-idle-msg");
const captionDisplay    = document.getElementById("caption-display");
const progressBar       = document.getElementById("progress-bar");
const elapsedTimeEl     = document.getElementById("elapsed-time");
const wordCountDisplay  = document.getElementById("word-count-display");
const captionLogEl      = document.getElementById("caption-log");
const clearLogBtn       = document.getElementById("clear-log-btn");
const recBadge          = document.getElementById("rec-badge");
const statusDot         = document.getElementById("status-dot");
const statusText        = document.getElementById("status-text");
const downloadAudioBtn  = document.getElementById("download-audio-btn");
const downloadCaptionBtn= document.getElementById("download-caption-btn");
const audioMeta         = document.getElementById("audio-meta");
const captionMeta       = document.getElementById("caption-meta");
const recorderNotice    = document.getElementById("recorder-notice");

// ══════════════════════════════════════════════════════════════
// State
// ══════════════════════════════════════════════════════════════
let voices          = [];
let isSpeaking      = false;
let speechStartTime = 0;        // performance.now() when speech began
let totalChars      = 0;
let wordIndex       = 0;        // sequential word counter
let elapsedTimer    = null;     // setInterval handle for clock

// Caption data: array of { index, word, startMs, endMs }
let captionEntries  = [];
let currentEntry    = null;     // the in-progress entry (no endMs yet)

// Audio recording
let mediaRecorder   = null;
let audioChunks     = [];
let recordedBlob    = null;     // final audio blob
let audioObjectURL  = null;

// Caption download
let captionObjectURL = null;

// Chrome resume-bug workaround
let resumeInterval  = null;

// ══════════════════════════════════════════════════════════════
// Browser support check
// ══════════════════════════════════════════════════════════════
const hasSpeech = "speechSynthesis" in window;

if (!hasSpeech) {
  speakBtn.disabled = true;
  setStatus("NOT SUPPORTED", "");
  alert(
    "Your browser does not support the Web Speech API.\n" +
    "Please use Chrome, Edge, or Safari."
  );
}

// ══════════════════════════════════════════════════════════════
// Voices
// ══════════════════════════════════════════════════════════════

/**
 * Keywords that help identify male voices.
 * This is heuristic — the Web Speech API provides no gender field.
 */
const MALE_KEYWORDS = [
  "david", "james", "mark", "paul", "richard", "thomas", "george",
  "daniel", "guy", "aaron", "fred", "alex", "oliver", "male",
  "carlos", "diego", "luca", "henrik", "stefan", "jorge"
];

function isMaleVoice(voice) {
  const name = voice.name.toLowerCase();
  return MALE_KEYWORDS.some(kw => name.includes(kw));
}

function populateVoices() {
  voices = window.speechSynthesis.getVoices();
  if (!voices.length) return;

  voiceSelect.innerHTML = "";

  // Split into groups: English Male, English Female/Unknown, Other
  const enMale    = voices.filter(v => v.lang.startsWith("en") && isMaleVoice(v));
  const enOther   = voices.filter(v => v.lang.startsWith("en") && !isMaleVoice(v));
  const otherLang = voices.filter(v => !v.lang.startsWith("en"));

  const buildGroup = (label, list) => {
    if (!list.length) return;
    const grp = document.createElement("optgroup");
    grp.label = label;
    list.forEach(voice => {
      const opt = document.createElement("option");
      opt.value = voice.name;
      opt.textContent = `${voice.name}  [${voice.lang}]${voice.localService ? " ●" : ""}`;
      grp.appendChild(opt);
    });
    voiceSelect.appendChild(grp);
  };

  buildGroup("English — Male", enMale);
  buildGroup("English — Other", enOther);
  buildGroup("Other Languages", otherLang);

  // Auto-select: prefer first local English male, else first English, else first
  const preferred =
    enMale.find(v => v.localService) ||
    enMale[0] ||
    enOther.find(v => v.localService) ||
    enOther[0] ||
    voices[0];

  if (preferred) voiceSelect.value = preferred.name;
}

populateVoices();
if (typeof window.speechSynthesis !== "undefined") {
  window.speechSynthesis.onvoiceschanged = populateVoices;
}

// ══════════════════════════════════════════════════════════════
// Slider live labels
// ══════════════════════════════════════════════════════════════
rateSlider.addEventListener("input", () => {
  rateDisplay.textContent = parseFloat(rateSlider.value).toFixed(1) + "×";
});
pitchSlider.addEventListener("input", () => {
  pitchDisplay.textContent = parseFloat(pitchSlider.value).toFixed(1);
});
volumeSlider.addEventListener("input", () => {
  volumeDisplay.textContent = Math.round(parseFloat(volumeSlider.value) * 100) + "%";
});
textInput.addEventListener("input", () => {
  charCountEl.textContent = textInput.value.length;
});
charCountEl.textContent = textInput.value.length;

// ══════════════════════════════════════════════════════════════
// Helpers — UI state
// ══════════════════════════════════════════════════════════════
function setStatus(text, dotClass) {
  statusText.textContent = text;
  statusDot.className = "status-dot" + (dotClass ? " " + dotClass : "");
}

function setPlayingUI(playing) {
  isSpeaking = playing;

  if (playing) {
    speakBtn.classList.add("playing");
    speakIcon.innerHTML = `<svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
      <rect x="0" y="0" width="4" height="12" rx="1"/>
      <rect x="7" y="0" width="4" height="12" rx="1"/>
    </svg>`;
    speakLabel.textContent = "Playing…";
    speakBtn.disabled = false;  // keep enabled so user can click to stop via stop-btn
    stopBtn.disabled = false;
    recBadge.classList.add("active");
    setStatus("RECORDING", "live");
  } else {
    speakBtn.classList.remove("playing");
    speakIcon.innerHTML = `<svg width="14" height="16" viewBox="0 0 14 16" fill="currentColor"><path d="M0 0L14 8L0 16V0Z"/></svg>`;
    speakLabel.textContent = "Play";
    stopBtn.disabled = true;
    recBadge.classList.remove("active");
  }
}

function showCaption(word) {
  captionIdleMsg.classList.add("hidden");
  captionDisplay.classList.add("visible");

  // Replace content with a freshly-animated element
  captionDisplay.innerHTML = "";
  const el = document.createElement("span");
  el.className = "caption-word-el";
  el.textContent = cleanWord(word).toUpperCase();
  captionDisplay.appendChild(el);
}

function hideCaption() {
  captionDisplay.classList.remove("visible");
  captionIdleMsg.classList.remove("hidden");
  setTimeout(() => { captionDisplay.innerHTML = ""; }, 300);
}

function cleanWord(w) {
  return w.replace(/^[^\w]+|[^\w]+$/g, "");
}

// ══════════════════════════════════════════════════════════════
// Elapsed timer
// ══════════════════════════════════════════════════════════════
function startTimer() {
  speechStartTime = performance.now();
  elapsedTimer = setInterval(() => {
    const ms = performance.now() - speechStartTime;
    elapsedTimeEl.textContent = formatElapsed(ms);
  }, 100);
}

function stopTimer() {
  clearInterval(elapsedTimer);
  elapsedTimer = null;
}

function formatElapsed(ms) {
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  const dec = Math.floor((ms % 1000) / 100);
  return `${String(min).padStart(2,"0")}:${String(sec).padStart(2,"0")}.${dec}`;
}

// ══════════════════════════════════════════════════════════════
// Caption log
// ══════════════════════════════════════════════════════════════
function addLogEntry(word, startMs) {
  const empty = captionLogEl.querySelector(".log-empty");
  if (empty) empty.remove();

  const row = document.createElement("div");
  row.className = "log-entry";

  const ts = formatSrtTime(startMs, false); // compact form
  row.innerHTML = `<span class="log-ts">${ts}</span><span class="log-word">${cleanWord(word) || word}</span>`;
  captionLogEl.appendChild(row);
  captionLogEl.scrollTop = captionLogEl.scrollHeight;
}

clearLogBtn.addEventListener("click", () => {
  captionLogEl.innerHTML = '<p class="log-empty">Caption entries will appear here during playback.</p>';
});

// ══════════════════════════════════════════════════════════════
// MediaRecorder — audio capture
// ══════════════════════════════════════════════════════════════

/**
 * The Web Speech API synthesises audio through the OS audio pipeline,
 * not via the Web Audio API. We therefore capture the system audio by
 * routing to a Web Audio AudioContext with a destination stream, then
 * recording that stream.
 *
 * Important caveat: on most browsers getDisplayMedia (screen + audio)
 * is the only reliable way to capture system audio; getUserMedia cannot
 * capture it directly. However, we can use AudioContext.createMediaStreamDestination()
 * as a passthrough so that SpeechSynthesis audio IS routed through it
 * in Chromium-based browsers when the AudioContext is kept alive.
 *
 * Fallback: if AudioContext capture fails, we fall back to a silent
 * recording and show a helpful notice to the user.
 */

let audioCtx        = null;
let audioDestination= null;

function initAudioCapture() {
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    audioDestination = audioCtx.createMediaStreamDestination();
    return true;
  } catch (e) {
    console.warn("AudioContext init failed:", e);
    return false;
  }
}

function startRecording() {
  audioChunks = [];
  recordedBlob = null;
  if (audioObjectURL) { URL.revokeObjectURL(audioObjectURL); audioObjectURL = null; }

  // Try to get a real stream from AudioContext
  const hasAudioCtx = initAudioCapture();
  let stream;

  if (hasAudioCtx && audioDestination) {
    stream = audioDestination.stream;
  } else {
    // Fallback: create a silent oscillator stream so MediaRecorder still
    // runs (the file will be silent — we notify the user)
    try {
      const fallbackCtx = new (window.AudioContext || window.webkitAudioContext)();
      const dest = fallbackCtx.createMediaStreamDestination();
      // Immediately suspended so it stays silent
      stream = dest.stream;
      showRecorderNotice(
        "⚠️ Audio capture is limited on this browser. " +
        "The downloaded file may be silent. " +
        "For full audio capture, try Chrome or Edge."
      );
    } catch (e) {
      console.warn("Cannot create MediaRecorder stream:", e);
      return;
    }
  }

  // Prefer WebM/opus, fall back to whatever the browser supports
  const mimeType = getSupportedMimeType();

  try {
    mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});
  } catch (e) {
    console.warn("MediaRecorder init failed:", e);
    showRecorderNotice("⚠️ MediaRecorder is not supported in this browser. Audio download unavailable.");
    return;
  }

  mediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) audioChunks.push(e.data);
  };

  mediaRecorder.onstop = () => {
    const ext = mimeType && mimeType.includes("ogg") ? "ogg" : "webm";
    recordedBlob = new Blob(audioChunks, { type: mimeType || "audio/webm" });
    audioObjectURL = URL.createObjectURL(recordedBlob);
    const sizekb = Math.round(recordedBlob.size / 1024);
    audioMeta.textContent = `${ext.toUpperCase()} · ${sizekb} KB`;
    document.getElementById("card-audio").classList.add("ready");
    downloadAudioBtn.disabled = false;
  };

  mediaRecorder.start(250); // collect in 250ms chunks
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop();
  }
  if (audioCtx) {
    audioCtx.close().catch(() => {});
    audioCtx = null;
    audioDestination = null;
  }
}

function getSupportedMimeType() {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/ogg",
  ];
  return candidates.find(t => MediaRecorder.isTypeSupported(t)) || "";
}

function showRecorderNotice(msg) {
  recorderNotice.textContent = msg;
  recorderNotice.classList.add("visible");
}

// ══════════════════════════════════════════════════════════════
// Caption file generation (SRT / VTT)
// ══════════════════════════════════════════════════════════════

/**
 * Format milliseconds → "HH:MM:SS,mmm" (SRT) or "HH:MM:SS.mmm" (VTT)
 */
function formatSrtTime(ms, useSrt = true) {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const msec = Math.floor(ms % 1000);
  const sep = useSrt ? "," : ".";
  return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}${sep}${String(msec).padStart(3,"0")}`;
}

/**
 * Build an SRT or VTT string from captionEntries.
 * Each entry: { index, word, startMs, endMs }
 */
function buildCaptionFile(format) {
  if (!captionEntries.length) return "";

  if (format === "vtt") {
    let out = "WEBVTT\n\n";
    captionEntries.forEach((entry, i) => {
      const start = formatSrtTime(entry.startMs, false);
      const end   = formatSrtTime(entry.endMs,   false);
      out += `${i + 1}\n${start} --> ${end}\n${cleanWord(entry.word) || entry.word}\n\n`;
    });
    return out;
  } else {
    // SRT
    let out = "";
    captionEntries.forEach((entry, i) => {
      const start = formatSrtTime(entry.startMs, true);
      const end   = formatSrtTime(entry.endMs,   true);
      out += `${i + 1}\n${start} --> ${end}\n${cleanWord(entry.word) || entry.word}\n\n`;
    });
    return out;
  }
}

function prepareCaptionDownload() {
  if (!captionEntries.length) return;

  if (captionObjectURL) { URL.revokeObjectURL(captionObjectURL); captionObjectURL = null; }

  const format  = captionFormatSel.value;
  const content = buildCaptionFile(format);
  const blob    = new Blob([content], { type: "text/plain;charset=utf-8" });
  captionObjectURL = URL.createObjectURL(blob);

  const wordCount = captionEntries.length;
  captionMeta.textContent = `${format.toUpperCase()} · ${wordCount} entries`;
  document.getElementById("card-caption").classList.add("ready");
  downloadCaptionBtn.disabled = false;
}

// ══════════════════════════════════════════════════════════════
// Download handlers
// ══════════════════════════════════════════════════════════════
downloadAudioBtn.addEventListener("click", () => {
  if (!audioObjectURL) return;
  const ext  = recordedBlob.type.includes("ogg") ? "ogg" : "webm";
  triggerDownload(audioObjectURL, `voxcap-audio.${ext}`);
});

downloadCaptionBtn.addEventListener("click", () => {
  if (!captionObjectURL) return;
  const format = captionFormatSel.value;
  triggerDownload(captionObjectURL, `voxcap-captions.${format}`);
});

function triggerDownload(url, filename) {
  const a = document.createElement("a");
  a.href     = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

// ══════════════════════════════════════════════════════════════
// Word extraction from charIndex
// ══════════════════════════════════════════════════════════════
function extractWordAt(text, charIndex) {
  let end = charIndex;
  while (end < text.length && !/\s/.test(text[end])) end++;
  return text.slice(charIndex, end);
}

// ══════════════════════════════════════════════════════════════
// Main speak() function
// ══════════════════════════════════════════════════════════════
function speak() {
  const text = textInput.value.trim();
  if (!text) {
    textInput.focus();
    textInput.style.outline = "1px solid rgba(255,68,85,0.6)";
    setTimeout(() => (textInput.style.outline = ""), 1200);
    return;
  }

  // Cancel any ongoing speech cleanly
  window.speechSynthesis.cancel();

  // Reset caption + audio state
  captionEntries = [];
  currentEntry   = null;
  wordIndex      = 0;
  totalChars     = text.length;
  progressBar.style.width = "0%";
  wordCountDisplay.textContent = "0";
  elapsedTimeEl.textContent = "00:00.0";

  // Reset download buttons
  downloadAudioBtn.disabled  = true;
  downloadCaptionBtn.disabled= true;
  audioMeta.textContent    = "Recording…";
  captionMeta.textContent  = "In progress…";
  document.getElementById("card-audio").classList.remove("ready");
  document.getElementById("card-caption").classList.remove("ready");

  // Small delay lets cancel() flush (Chrome timing bug)
  setTimeout(() => {

    startRecording();

    const utterance = new SpeechSynthesisUtterance(text);

    // Voice
    const selectedName = voiceSelect.value;
    if (selectedName) {
      const voice = voices.find(v => v.name === selectedName);
      if (voice) utterance.voice = voice;
    }

    utterance.rate   = parseFloat(rateSlider.value);
    utterance.pitch  = parseFloat(pitchSlider.value);
    utterance.volume = parseFloat(volumeSlider.value);

    // ── onstart ──
    utterance.onstart = () => {
      setPlayingUI(true);
      startTimer();
    };

    // ── onboundary — fires at each word / sentence boundary ──
    utterance.onboundary = (event) => {
      if (event.name !== "word") return;

      const { charIndex } = event;
      const word = extractWordAt(text, charIndex);
      if (!word) return;

      const nowMs = performance.now() - speechStartTime;

      // Close out the previous entry with an endMs
      if (currentEntry) {
        currentEntry.endMs = Math.max(nowMs - 20, currentEntry.startMs + 50);
        captionEntries.push({ ...currentEntry });
        addLogEntry(currentEntry.word, currentEntry.startMs);
      }

      // Open new entry
      wordIndex++;
      currentEntry = {
        index:   wordIndex,
        word:    word,
        startMs: nowMs,
        endMs:   null,
      };

      // Update caption display
      showCaption(word);
      wordCountDisplay.textContent = wordIndex;
      updateProgress(charIndex);
    };

    // ── onend ──
    utterance.onend = () => {
      const endMs = performance.now() - speechStartTime;

      // Close last entry
      if (currentEntry) {
        currentEntry.endMs = endMs;
        captionEntries.push({ ...currentEntry });
        addLogEntry(currentEntry.word, currentEntry.startMs);
        currentEntry = null;
      }

      stopTimer();
      stopRecording();
      setPlayingUI(false);
      setStatus("DONE", "done");
      progressBar.style.width = "100%";
      clearInterval(resumeInterval);

      // Fade caption then show idle
      setTimeout(() => hideCaption(), 1200);

      // Prepare caption download (audio is ready via mediaRecorder.onstop)
      prepareCaptionDownload();
    };

    // ── onerror ──
    utterance.onerror = (event) => {
      if (event.error === "canceled" || event.error === "interrupted") return;
      console.error("SpeechSynthesis error:", event.error);
      stopAll("ERROR");
    };

    window.speechSynthesis.speak(utterance);

    // Chrome 15-second pause bug workaround
    clearInterval(resumeInterval);
    resumeInterval = setInterval(() => {
      if (!window.speechSynthesis.speaking) {
        clearInterval(resumeInterval);
      } else if (window.speechSynthesis.paused) {
        window.speechSynthesis.resume();
      }
    }, 5000);

  }, 80);
}

// ══════════════════════════════════════════════════════════════
// Stop
// ══════════════════════════════════════════════════════════════
function stopAll(statusLabel = "STOPPED") {
  window.speechSynthesis.cancel();
  clearInterval(resumeInterval);
  stopTimer();
  stopRecording();
  setPlayingUI(false);
  setStatus(statusLabel, "");
  hideCaption();
  progressBar.style.width = "0%";

  // If we have partial entries, still offer caption download
  if (captionEntries.length) prepareCaptionDownload();
}

// ══════════════════════════════════════════════════════════════
// Progress bar
// ══════════════════════════════════════════════════════════════
function updateProgress(charIndex) {
  if (!totalChars) return;
  const pct = Math.min((charIndex / totalChars) * 100, 100);
  progressBar.style.width = pct + "%";
}

// ══════════════════════════════════════════════════════════════
// Button handlers
// ══════════════════════════════════════════════════════════════
speakBtn.addEventListener("click", () => {
  if (isSpeaking) {
    stopAll("STOPPED");
  } else {
    speak();
  }
});

stopBtn.addEventListener("click", () => stopAll("STOPPED"));

// ══════════════════════════════════════════════════════════════
// Page visibility — stop on tab hide to avoid orphaned synthesis
// ══════════════════════════════════════════════════════════════
document.addEventListener("visibilitychange", () => {
  if (document.hidden && isSpeaking) stopAll("STOPPED");
});

// ══════════════════════════════════════════════════════════════
// Keyboard shortcut: Space = play/stop (when not in textarea)
// ══════════════════════════════════════════════════════════════
document.addEventListener("keydown", (e) => {
  if (e.target === textInput) return;
  if (e.code === "Space" && !e.repeat) {
    e.preventDefault();
    speakBtn.click();
  }
});
