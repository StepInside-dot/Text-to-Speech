/**
 * VoxCap — script.js
 * Text-to-Speech with real-time word-by-word captioning
 * Uses the Web Speech API (SpeechSynthesis + SpeechSynthesisUtterance)
 */

"use strict";

// ── DOM refs ──────────────────────────────────────────────────────────────────
const textInput     = document.getElementById("text-input");
const speakBtn      = document.getElementById("speak-btn");
const btnIcon       = document.getElementById("btn-icon");
const btnLabel      = document.getElementById("btn-label");
const captionWord   = document.getElementById("caption-word");
const captionIdle   = document.getElementById("caption-idle");
const captionStage  = document.querySelector(".caption-stage");
const stageDot      = document.getElementById("stage-dot");
const stageStatus   = document.getElementById("stage-status");
const progressFill  = document.getElementById("progress-fill");
const voiceSelect   = document.getElementById("voice-select");
const rateSlider    = document.getElementById("rate-slider");
const pitchSlider   = document.getElementById("pitch-slider");
const rateValue     = document.getElementById("rate-value");
const pitchValue    = document.getElementById("pitch-value");
const charCount     = document.getElementById("char-count");

// ── State ─────────────────────────────────────────────────────────────────────
let voices        = [];
let isSpeaking    = false;
let totalChars    = 0;   // for progress estimation

// ── Browser support check ─────────────────────────────────────────────────────
if (!("speechSynthesis" in window)) {
  const notice = document.createElement("p");
  notice.className = "unsupported-notice visible";
  notice.textContent =
    "⚠️ Your browser does not support the Web Speech API. " +
    "Please try Chrome, Edge, or Safari.";
  speakBtn.insertAdjacentElement("afterend", notice);
  speakBtn.disabled = true;
  speakBtn.style.opacity = "0.4";
  speakBtn.style.cursor  = "not-allowed";
}

// ── Load voices ───────────────────────────────────────────────────────────────
/**
 * Voices load asynchronously in most browsers.
 * We call populateVoices immediately, and also on the voiceschanged event.
 */
function populateVoices() {
  voices = window.speechSynthesis.getVoices();
  if (!voices.length) return;

  voiceSelect.innerHTML = "";

  // Prefer English voices, but show all
  const english = voices.filter(v => v.lang.startsWith("en"));
  const others  = voices.filter(v => !v.lang.startsWith("en"));

  const addGroup = (label, list) => {
    if (!list.length) return;
    const group = document.createElement("optgroup");
    group.label = label;
    list.forEach((voice, i) => {
      const opt = document.createElement("option");
      opt.value       = voice.name;
      opt.textContent = `${voice.name} (${voice.lang})`;
      // Default: pick first local English voice if available
      if (voice.localService && voice.lang.startsWith("en") && !voiceSelect.value) {
        opt.selected = true;
      }
      group.appendChild(opt);
    });
    voiceSelect.appendChild(group);
  };

  addGroup("English", english);
  addGroup("Other Languages", others);
}

populateVoices();
if (window.speechSynthesis.onvoiceschanged !== undefined) {
  window.speechSynthesis.onvoiceschanged = populateVoices;
}

// ── Character counter ─────────────────────────────────────────────────────────
textInput.addEventListener("input", () => {
  charCount.textContent = textInput.value.length;
});

// ── Slider labels ─────────────────────────────────────────────────────────────
rateSlider.addEventListener("input", () => {
  rateValue.textContent = parseFloat(rateSlider.value).toFixed(1) + "×";
});
pitchSlider.addEventListener("input", () => {
  pitchValue.textContent = parseFloat(pitchSlider.value).toFixed(1);
});

// ── Caption helpers ───────────────────────────────────────────────────────────

/** Show the idle placeholder */
function showIdle() {
  captionIdle.classList.remove("hidden");
  captionWord.classList.remove("pop", "fade-out");
  captionWord.textContent = "";
  captionWord.style.opacity = "0";
}

/**
 * Flash a word in the caption box.
 * We briefly fade out the old word, then pop in the new one.
 */
function showWord(word) {
  // Trim punctuation for display, keep it readable
  const clean = word.replace(/[.,!?;:"""''\-–—()[\]{}<>]+$/, "")
                     .replace(/^["""''\-–—()[\]{}<>]+/, "");
  if (!clean) return;

  captionIdle.classList.add("hidden");

  // Remove existing animation classes
  captionWord.classList.remove("pop", "fade-out");

  // Force reflow so the animation restarts cleanly
  void captionWord.offsetWidth;

  captionWord.textContent = clean.toUpperCase();
  captionWord.classList.add("pop");
}

/** Update the linear progress bar based on charIndex position */
function updateProgress(charIndex) {
  if (!totalChars) return;
  const pct = Math.min((charIndex / totalChars) * 100, 100);
  progressFill.style.width = pct + "%";
}

/** Set UI to LIVE (speaking) state */
function setStateLive() {
  isSpeaking = true;
  speakBtn.classList.add("speaking");
  btnIcon.textContent  = "■";
  btnLabel.textContent = "Stop";
  stageDot.className   = "stage-dot live";
  stageStatus.textContent = "LIVE";
  captionStage.classList.add("active");
  progressFill.style.width = "0%";
}

/** Set UI to IDLE (stopped/finished) state */
function setStateIdle(label = "Ready") {
  isSpeaking = false;
  speakBtn.classList.remove("speaking");
  btnIcon.textContent  = "▶";
  btnLabel.textContent = "Speak";
  stageDot.className   = "stage-dot";
  stageStatus.textContent = label;
  captionStage.classList.remove("active");
}

/** Set UI to DONE (finished naturally) state */
function setStateDone() {
  isSpeaking = false;
  speakBtn.classList.remove("speaking");
  btnIcon.textContent  = "▶";
  btnLabel.textContent = "Speak";
  stageDot.className   = "stage-dot done";
  stageStatus.textContent = "Done";
  captionStage.classList.remove("active");
  progressFill.style.width = "100%";
}

// ── Core TTS logic ────────────────────────────────────────────────────────────

/**
 * extractWordAtCharIndex
 *
 * The Web Speech API's `boundary` event provides `charIndex`, the position in
 * the original string where the upcoming word starts. We walk forward from
 * that index to find the full word token.
 *
 * @param {string} text      - full input string
 * @param {number} charIndex - starting character index from boundary event
 * @returns {string}          the word token
 */
function extractWordAtCharIndex(text, charIndex) {
  // Walk forward from charIndex until we hit whitespace or end-of-string
  let end = charIndex;
  while (end < text.length && !/\s/.test(text[end])) {
    end++;
  }
  return text.slice(charIndex, end);
}

/**
 * speak
 * Creates and fires a SpeechSynthesisUtterance, wiring up all events.
 */
function speak() {
  const text = textInput.value.trim();

  if (!text) {
    textInput.focus();
    textInput.style.borderColor = "rgba(255,95,135,0.6)";
    setTimeout(() => (textInput.style.borderColor = ""), 1200);
    return;
  }

  // Cancel anything in progress first
  window.speechSynthesis.cancel();

  // Small delay lets cancel() fully flush before starting (fixes Chrome bug)
  setTimeout(() => {
    totalChars = text.length;

    const utterance = new SpeechSynthesisUtterance(text);

    // ── Voice ──
    const selectedVoiceName = voiceSelect.value;
    if (selectedVoiceName) {
      const voice = voices.find(v => v.name === selectedVoiceName);
      if (voice) utterance.voice = voice;
    }

    // ── Rate & Pitch ──
    utterance.rate  = parseFloat(rateSlider.value);
    utterance.pitch = parseFloat(pitchSlider.value);

    // ── Events ──

    utterance.onstart = () => {
      setStateLive();
    };

    /**
     * onboundary fires at word (and sentence) boundaries.
     * charIndex = position in the string where the current word starts.
     * We use this to extract the exact word and display it.
     */
    utterance.onboundary = (event) => {
      // Only handle word boundaries (not sentence boundaries)
      if (event.name !== "word") return;

      const { charIndex } = event;
      const word = extractWordAtCharIndex(text, charIndex);

      if (word) {
        showWord(word);
        updateProgress(charIndex);
      }
    };

    utterance.onend = () => {
      setStateDone();
      // Fade out the last caption word after a short pause
      setTimeout(() => {
        captionWord.classList.add("fade-out");
        setTimeout(showIdle, 300);
      }, 900);
    };

    utterance.onerror = (event) => {
      // 'canceled' is a normal error when we call cancel() ourselves — ignore it
      if (event.error === "canceled" || event.error === "interrupted") return;

      console.error("SpeechSynthesis error:", event.error);
      setStateIdle("Error");
      showIdle();
    };

    window.speechSynthesis.speak(utterance);

    /**
     * Chrome has a known bug where speechSynthesis pauses after ~15s.
     * We work around it by calling resume() periodically.
     * We clear the interval once speech ends.
     */
    const resumeInterval = setInterval(() => {
      if (!window.speechSynthesis.speaking) {
        clearInterval(resumeInterval);
      } else if (window.speechSynthesis.paused) {
        window.speechSynthesis.resume();
      }
    }, 5000);

    // Store so we can clear on manual stop
    speakBtn._resumeInterval = resumeInterval;

  }, 80);
}

/**
 * stop
 * Cancels ongoing speech and resets UI.
 */
function stop() {
  window.speechSynthesis.cancel();
  clearInterval(speakBtn._resumeInterval);
  setStateIdle("Stopped");
  showIdle();
  progressFill.style.width = "0%";
}

// ── Button click handler ──────────────────────────────────────────────────────
speakBtn.addEventListener("click", () => {
  if (isSpeaking) {
    stop();
  } else {
    speak();
  }
});

// ── Cancel speech when page becomes hidden (tab switch, minimize) ─────────────
document.addEventListener("visibilitychange", () => {
  if (document.hidden && isSpeaking) {
    stop();
  }
});

// ── Keyboard shortcut: Space to speak/stop (when textarea not focused) ────────
document.addEventListener("keydown", (e) => {
  if (e.target === textInput) return;           // don't intercept textarea typing
  if (e.code === "Space" && !e.repeat) {
    e.preventDefault();
    speakBtn.click();
  }
});

// ── Init ──────────────────────────────────────────────────────────────────────
showIdle();
charCount.textContent = textInput.value.length;
