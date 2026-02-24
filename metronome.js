(() => {
  const toggleBtn = document.getElementById("toggle-btn");
  const statusText = document.getElementById("status-text");
  const tempoRowsContainer = document.getElementById("tempo-rows");
  const addRowBtn = document.getElementById("add-row-btn");

  /** @type {AudioContext | null} */
  let audioCtx = null;
  let isRunning = false;
  /** @type {number | null} */
  let currentTimeoutId = null;
  /** @type {{ bpm: number, beats: number, subdivisions: number, shuffle: boolean }[] | null} */
  let currentSequence = null;
  let currentSegmentIndex = 0;
  let currentTickIndexInSegment = 0;
  /** @type {HTMLElement[] | null} */
  let currentSequenceRows = null;

  const MIN_BPM = 20;
  const MAX_BPM = 300;
  const MIN_TS_TOP = 1;
  const MAX_TS_TOP = 64;
  const MIN_TS_BOTTOM = 2;
  const MAX_TS_BOTTOM = 64;

  function getIntervalMsFromBpm(bpm) {
    return 60_000 / bpm;
  }

  /**
   * Play a metronome click for a main beat.
   * @param {boolean} isAccent - Whether this is the accented (first) beat of a row.
   */
  function playClick(isAccent = true) {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }

    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();

    osc.type = "square";
    osc.frequency.value = isAccent ? 1000 : 750;

    gain.gain.setValueAtTime(0.001, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(1.0, audioCtx.currentTime + 0.001);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.08);

    osc.connect(gain);
    gain.connect(audioCtx.destination);

    osc.start();
    osc.stop(audioCtx.currentTime + 0.1);
  }

  /**
   * Play a quieter subdivision click.
   */
  function playSubdivisionClick() {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }

    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();

    osc.type = "square";
    // Subdivision clicks are lower in pitch by the same
    // interval as the difference between the accented
    // and unaccented main beats (1000 -> 750 -> 500).
    osc.frequency.value = 500;

    gain.gain.setValueAtTime(0.001, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.5, audioCtx.currentTime + 0.001);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.08);

    osc.connect(gain);
    gain.connect(audioCtx.destination);

    osc.start();
    osc.stop(audioCtx.currentTime + 0.1);
  }

  function validateBpm(rawValue) {
    const bpm = Number(rawValue);
    if (!Number.isFinite(bpm) || Number.isNaN(bpm)) return null;
    if (bpm < MIN_BPM || bpm > MAX_BPM) return null;
    return bpm;
  }

  function clampBpm(bpm) {
    if (!Number.isFinite(bpm) || Number.isNaN(bpm)) return MIN_BPM;
    return Math.min(MAX_BPM, Math.max(MIN_BPM, bpm));
  }

  function setStatus(message, type = "") {
    statusText.textContent = message;
    statusText.classList.remove("running", "error");
    if (type) {
      statusText.classList.add(type);
    }
  }

  function syncRowBpm(row, bpm) {
    const clamped = clampBpm(bpm);
    const bpmInputEl = /** @type {HTMLInputElement | null} */ (
      row.querySelector(".bpm-input")
    );
    const bpmSliderEl = /** @type {HTMLInputElement | null} */ (
      row.querySelector(".bpm-slider")
    );

    if (bpmInputEl) bpmInputEl.value = String(clamped);
    if (bpmSliderEl) bpmSliderEl.value = String(clamped);

    if (!isRunning) {
      setStatus(`Ready at ${clamped} BPM.`);
    }

    return clamped;
  }

  function ensureAudioContext() {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    } else if (audioCtx.state === "suspended") {
      audioCtx.resume();
    }
  }

  /**
   * Build a sequence of { bpm, beats, subdivisions, shuffle } objects from the current rows.
   * The BPM stored in the sequence is the *effective* BPM derived from the
   * base BPM and the time signature bottom value.
   * Returns null if validation fails.
   * Also stores the corresponding DOM rows in `currentSequenceRows`.
   * @returns {{ bpm: number, beats: number, subdivisions: number, shuffle: boolean }[] | null}
   */
  function buildSequenceFromRows() {
    const rows = Array.from(
      tempoRowsContainer.querySelectorAll(".tempo-row")
    );

    if (!rows.length) {
      setStatus("Add at least one tempo row.", "error");
      return null;
    }

    /** @type {{ bpm: number, beats: number, subdivisions: number, shuffle: boolean }[]} */
    const sequence = [];
    /** @type {HTMLElement[]} */
    const sequenceRows = [];
    let totalBeats = 0;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const bpmInputEl = /** @type {HTMLInputElement | null} */ (
        row.querySelector(".bpm-input")
      );
      const tsTopInputEl = /** @type {HTMLInputElement | null} */ (
        row.querySelector(".ts-top-input")
      );
      const tsBottomInputEl = /** @type {HTMLInputElement | null} */ (
        row.querySelector(".ts-bottom-input")
      );
      const subdivisionEnableEl = /** @type {HTMLInputElement | null} */ (
        row.querySelector(".subdivision-enable")
      );
      const subdivisionInputEl = /** @type {HTMLInputElement | null} */ (
        row.querySelector(".subdivision-input")
      );
      const subdivisionShuffleEl = /** @type {HTMLInputElement | null} */ (
        row.querySelector(".subdivision-shuffle")
      );

      if (!bpmInputEl || !tsTopInputEl || !tsBottomInputEl) continue;

      const baseBpm = validateBpm(bpmInputEl.value);
      if (!baseBpm) {
        setStatus(
          `Row ${i + 1}: tempo must be between ${MIN_BPM} and ${MAX_BPM} BPM.`,
          "error"
        );
        return null;
      }

      const tsTop = Number.parseInt(tsTopInputEl.value, 10);
      if (
        !Number.isFinite(tsTop) ||
        tsTop < MIN_TS_TOP ||
        tsTop > MAX_TS_TOP
      ) {
        setStatus(
          `Row ${i + 1}: top time value must be a whole number between ${MIN_TS_TOP} and ${MAX_TS_TOP}.`,
          "error"
        );
        return null;
      }

      const tsBottom = Number.parseInt(tsBottomInputEl.value, 10);
      if (
        !Number.isFinite(tsBottom) ||
        tsBottom < MIN_TS_BOTTOM ||
        tsBottom > MAX_TS_BOTTOM ||
        tsBottom % 2 !== 0
      ) {
        setStatus(
          `Row ${i + 1}: bottom time value must be an even number between ${MIN_TS_BOTTOM} and ${MAX_TS_BOTTOM}.`,
          "error"
        );
        return null;
      }

      const effectiveBpm = baseBpm * (tsBottom / 4);
      let subdivisions = 1;
      let shuffle = false;

      if (subdivisionEnableEl && subdivisionEnableEl.checked) {
        const rawSubdivisions = Number.parseInt(
          subdivisionInputEl?.value ?? "2",
          10
        );
        if (
          !Number.isFinite(rawSubdivisions) ||
          rawSubdivisions < 2 ||
          rawSubdivisions > 64
        ) {
          setStatus(
            `Row ${i + 1}: subdivisions must be a whole number between 2 and 64.`,
            "error"
          );
          return null;
        }
        subdivisions = rawSubdivisions;
        shuffle = !!subdivisionShuffleEl?.checked;
      }

      sequence.push({
        bpm: effectiveBpm,
        beats: tsTop,
        subdivisions,
        shuffle,
      });
      sequenceRows.push(row);
      totalBeats += tsTop;
    }

    if (totalBeats === 0) {
      setStatus("Program has no clicks to play.", "error");
      return null;
    }

    currentSequenceRows = sequenceRows;
    return sequence;
  }

  function clearActiveRowIndicators() {
    if (!currentSequenceRows) return;
    currentSequenceRows.forEach((row) => {
      row.classList.remove("tempo-row-active");
      const dot = /** @type {HTMLElement | null} */ (
        row.querySelector(".row-indicator-dot")
      );
      if (dot) {
        dot.classList.remove("row-indicator-pulse");
      }
    });
  }

  /**
   * Highlight the currently active row based on its index.
   * @param {number} index
   */
  function setActiveRowIndicator(index) {
    if (!currentSequenceRows) return;
    currentSequenceRows.forEach((row, i) => {
      if (i === index) {
        row.classList.add("tempo-row-active");
      } else {
        row.classList.remove("tempo-row-active");
      }
    });
  }

  /**
   * Trigger a short pulse animation on the active row's indicator dot.
   * @param {number} index
   */
  function pulseActiveRowIndicator(index) {
    if (!currentSequenceRows) return;
    const row = currentSequenceRows[index];
    if (!row) return;
    const dot = /** @type {HTMLElement | null} */ (
      row.querySelector(".row-indicator-dot")
    );
    if (!dot) return;

    // Restart CSS animation by removing and re-adding the class.
    dot.classList.remove("row-indicator-pulse");
    // Force reflow so the browser sees the class removal.
    // eslint-disable-next-line no-unused-expressions
    void dot.offsetWidth;
    dot.classList.add("row-indicator-pulse");
  }

  function clearCurrentTimer() {
    if (currentTimeoutId !== null) {
      window.clearTimeout(currentTimeoutId);
      currentTimeoutId = null;
    }
  }

  function stopMetronome() {
    clearCurrentTimer();
    isRunning = false;
    clearActiveRowIndicators();
    currentSequence = null;
    currentSegmentIndex = 0;
    currentTickIndexInSegment = 0;
    currentSequenceRows = null;
    toggleBtn.textContent = "Start";
    setStatus("Stopped");
  }

  function runClickAndAdvance() {
    if (!isRunning || !currentSequence) return;

    // Find the next segment that still has ticks to play.
    while (true) {
      const segment = currentSequence[currentSegmentIndex];
      if (!segment) {
        stopMetronome();
        return;
      }

      const subdivisions = Math.max(1, segment.subdivisions || 1);
      const beats = segment.beats;
      const totalTicksInSegment = beats * subdivisions;

      if (currentTickIndexInSegment >= totalTicksInSegment) {
        // Move to the next segment and reset tick index, then re-check.
        currentSegmentIndex += 1;
        currentTickIndexInSegment = 0;
        continue;
      }

      const bpmForInterval = segment.bpm;
      const baseIntervalMs = getIntervalMsFromBpm(bpmForInterval);
      const tickIntervalMs =
        subdivisions > 1 ? baseIntervalMs / subdivisions : baseIntervalMs;

      const isMainBeat = currentTickIndexInSegment % subdivisions === 0;

      // Highlight the active row for this segment.
      setActiveRowIndicator(currentSegmentIndex);

      if (isMainBeat) {
        const beatNumber = Math.floor(
          currentTickIndexInSegment / subdivisions
        );
        const isFirstBeatOfRow = beatNumber === 0;
        // Pulse on every main beat click.
        pulseActiveRowIndicator(currentSegmentIndex);
        playClick(isFirstBeatOfRow);
      } else {
        const isLastSubdivisionInGroup =
          currentTickIndexInSegment % subdivisions === subdivisions - 1;
        if (!segment.shuffle || isLastSubdivisionInGroup) {
          // Only pulse when a subdivision click is actually played. With shuffle
          // enabled this will be only the last subdivision in each group.
          pulseActiveRowIndicator(currentSegmentIndex);
          playSubdivisionClick();
        }
      }

      currentTickIndexInSegment += 1;

      // Check if there will be any more ticks after this one.
      let nextSegmentIndex = currentSegmentIndex;
      let nextTickIndex = currentTickIndexInSegment;
      const currentTotalTicks = totalTicksInSegment;

      if (nextTickIndex >= currentTotalTicks) {
        nextSegmentIndex += 1;
        nextTickIndex = 0;
      }

      if (!currentSequence[nextSegmentIndex]) {
        // Schedule final stop after the last tick interval.
        currentTimeoutId = window.setTimeout(() => {
          stopMetronome();
        }, tickIntervalMs);
        return;
      }

      currentTimeoutId = window.setTimeout(runClickAndAdvance, tickIntervalMs);
      return;
    }
  }

  function startProgrammedMetronome() {
    const sequence = buildSequenceFromRows();
    if (!sequence) {
      return;
    }

    clearCurrentTimer();
    ensureAudioContext();

    currentSequence = sequence;
    currentSegmentIndex = 0;
    currentTickIndexInSegment = 0;
    isRunning = true;
    toggleBtn.textContent = "Stop";

    const totalBeats = sequence.reduce((sum, seg) => sum + seg.beats, 0);
    setStatus(
      `Running program with ${sequence.length} row(s), ${totalBeats} beat(s) total.`,
      "running"
    );

    // Immediate first click, then schedule the rest according to the sequence.
    runClickAndAdvance();
  }

  function setupTempoRow(row) {
    const bpmInputEl = /** @type {HTMLInputElement | null} */ (
      row.querySelector(".bpm-input")
    );
    const bpmSliderEl = /** @type {HTMLInputElement | null} */ (
      row.querySelector(".bpm-slider")
    );
    const bpmUpEl = /** @type {HTMLButtonElement | null} */ (
      row.querySelector(".bpm-up")
    );
    const bpmDownEl = /** @type {HTMLButtonElement | null} */ (
      row.querySelector(".bpm-down")
    );
    const subdivisionEnableEl = /** @type {HTMLInputElement | null} */ (
      row.querySelector(".subdivision-enable")
    );
    const subdivisionSettingsEl = /** @type {HTMLDivElement | null} */ (
      row.querySelector(".subdivision-settings")
    );
    const subdivisionInputEl = /** @type {HTMLInputElement | null} */ (
      row.querySelector(".subdivision-input")
    );
    const subdivisionShuffleEl = /** @type {HTMLInputElement | null} */ (
      row.querySelector(".subdivision-shuffle")
    );
    const deleteBtnEl = /** @type {HTMLButtonElement | null} */ (
      row.querySelector(".row-delete-btn")
    );

    if (bpmInputEl) {
      bpmInputEl.addEventListener("input", () => {
        const bpm = validateBpm(bpmInputEl.value);
        if (!bpm) return;
        syncRowBpm(row, bpm);
      });
    }

    if (bpmSliderEl) {
      bpmSliderEl.addEventListener("input", () => {
        const bpm = validateBpm(bpmSliderEl.value);
        if (!bpm) return;
        syncRowBpm(row, bpm);
      });
    }

    function stepRowBpm(delta) {
      const current =
        (bpmInputEl && validateBpm(bpmInputEl.value)) ?? 120;
      const next = clampBpm(current + delta);
      syncRowBpm(row, next);
    }

    if (bpmUpEl) {
      bpmUpEl.addEventListener("click", () => stepRowBpm(1));
    }

    if (bpmDownEl) {
      bpmDownEl.addEventListener("click", () => stepRowBpm(-1));
    }

    if (subdivisionEnableEl && subdivisionSettingsEl) {
      const applySubdivisionState = () => {
        const enabled = subdivisionEnableEl.checked;
        subdivisionSettingsEl.classList.toggle(
          "subdivision-settings-disabled",
          !enabled
        );
        if (subdivisionInputEl) {
          subdivisionInputEl.disabled = !enabled;
        }
        if (subdivisionShuffleEl) {
          subdivisionShuffleEl.disabled = !enabled;
        }
      };

      subdivisionEnableEl.addEventListener("change", applySubdivisionState);
      applySubdivisionState();
    }

    if (deleteBtnEl) {
      deleteBtnEl.addEventListener("click", () => {
        if (isRunning) {
          stopMetronome();
        }
        row.remove();
      });
    }
  }

  function createTempoRow(
    initialBpm = 100,
    initialTsTop = 4,
    initialTsBottom = 4
  ) {
    const row = document.createElement("div");
    row.className = "tempo-row";
    row.innerHTML = `
      <div class="row-indicator">
        <div class="row-indicator-dot"></div>
      </div>
      <div class="bpm-group">
        <input
          class="bpm-input"
          type="number"
          min="${MIN_BPM}"
          max="${MAX_BPM}"
          step="1"
          value="${initialBpm}"
        />
        <div class="bpm-step-buttons">
          <button
            type="button"
            class="bpm-up"
            aria-label="Increase tempo"
          >
            ▲
          </button>
          <button
            type="button"
            class="bpm-down"
            aria-label="Decrease tempo"
          >
            ▼
          </button>
        </div>
        <input
          class="bpm-slider"
          type="range"
          min="${MIN_BPM}"
          max="${MAX_BPM}"
          step="1"
          value="${initialBpm}"
        />
      </div>
      <div class="time-signature">
        <input
          class="time-input ts-top-input"
          type="number"
          min="${MIN_TS_TOP}"
          max="${MAX_TS_TOP}"
          step="1"
          value="${initialTsTop}"
          aria-label="Time signature top value"
        />
        <div class="time-divider"></div>
        <input
          class="time-input ts-bottom-input"
          type="number"
          min="${MIN_TS_BOTTOM}"
          max="${MAX_TS_BOTTOM}"
          step="2"
          value="${initialTsBottom}"
          aria-label="Time signature bottom value"
        />
      </div>
      <div class="subdivision-controls">
        <label class="subdivision-toggle">
          <input
            type="checkbox"
            class="subdivision-enable"
            aria-label="Enable subdivisions"
          />
          Subdiv
        </label>
        <div class="subdivision-settings">
          <input
            class="subdivision-input"
            type="number"
            min="2"
            max="64"
            step="1"
            value="2"
            aria-label="Number of subdivisions"
          />
          <label class="shuffle-toggle">
            <input
              type="checkbox"
              class="subdivision-shuffle"
              aria-label="Enable shuffle subdivisions"
            />
            Shuffle
          </label>
        </div>
      </div>
      <div class="row-delete">
        <button
          type="button"
          class="row-delete-btn"
          aria-label="Remove tempo row"
        ></button>
      </div>
    `;

    tempoRowsContainer.appendChild(row);
    syncRowBpm(row, initialBpm);
    setupTempoRow(row);
  }

  toggleBtn.addEventListener("click", () => {
    if (isRunning) {
      stopMetronome();
    } else {
      startProgrammedMetronome();
    }
  });

  // Allow spacebar to toggle the metronome when focus
  // is not inside a text/input control (so it doesn't
  // interfere with typing, but does override button clicks).
  document.addEventListener("keydown", (event) => {
    if (event.code !== "Space" && event.key !== " ") {
      return;
    }

    const target = event.target;
    if (target instanceof HTMLElement) {
      const tag = target.tagName.toLowerCase();
      const isTextEntryField =
        target.isContentEditable ||
        tag === "input" ||
        tag === "textarea" ||
        tag === "select";

      // Let space behave normally only when typing/editing.
      if (isTextEntryField) {
        return;
      }
    }

    // Prevent default so space doesn't "click" buttons or scroll.
    event.preventDefault();

    if (isRunning) {
      stopMetronome();
    } else {
      startProgrammedMetronome();
    }
  });

  if (addRowBtn) {
    addRowBtn.addEventListener("click", () => {
      const existingRows = Array.from(
        tempoRowsContainer.querySelectorAll(".tempo-row")
      );

      if (existingRows.length) {
        const lastRow = existingRows[existingRows.length - 1];
        const lastBpmInput = /** @type {HTMLInputElement | null} */ (
          lastRow.querySelector(".bpm-input")
        );
        const lastTsTopInput = /** @type {HTMLInputElement | null} */ (
          lastRow.querySelector(".ts-top-input")
        );
        const lastTsBottomInput = /** @type {HTMLInputElement | null} */ (
          lastRow.querySelector(".ts-bottom-input")
        );

        const lastBpm =
          (lastBpmInput && validateBpm(lastBpmInput.value)) ?? 120;
        const lastTsTop =
          Number.parseInt(lastTsTopInput?.value ?? "4", 10) || 4;
        const lastTsBottom =
          Number.parseInt(lastTsBottomInput?.value ?? "4", 10) || 4;

        createTempoRow(lastBpm, lastTsTop, lastTsBottom);
      } else {
        createTempoRow(100, 4, 4);
      }
    });
  }

  // Setup existing row from HTML (if any), otherwise create a default one
  const initialRows = Array.from(
    tempoRowsContainer.querySelectorAll(".tempo-row")
  );
  if (initialRows.length) {
    initialRows.forEach((row) => {
      const bpmInputEl = /** @type {HTMLInputElement | null} */ (
        row.querySelector(".bpm-input")
      );
      const initialBpm =
        (bpmInputEl && validateBpm(bpmInputEl.value)) ?? 120;
      syncRowBpm(row, initialBpm);
      setupTempoRow(row);
    });
    setStatus("Program ready.");
  } else {
    createTempoRow(100, 4);
    setStatus("Program ready.");
  }
})();

(() => {
  const bpmInput = document.getElementById("bpm");
  const toggleBtn = document.getElementById("toggle-btn");
  const statusText = document.getElementById("status-text");
  const bpmSlider = document.getElementById("bpm-slider");
  const bpmUpBtn = document.getElementById("bpm-up");
  const bpmDownBtn = document.getElementById("bpm-down");

  /** @type {AudioContext | null} */
  let audioCtx = null;
  /** @type {number | null} */
  let intervalId = null;
  let isRunning = false;

  const MIN_BPM = 20;
  const MAX_BPM = 300;

  function getIntervalMsFromBpm(bpm) {
    return (60_000 / bpm);
  }

  function playClick() {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }

    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();

    osc.type = "square";
    osc.frequency.value = 1000;

    gain.gain.setValueAtTime(0.001, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(1.0, audioCtx.currentTime + 0.001);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.08);

    osc.connect(gain);
    gain.connect(audioCtx.destination);

    osc.start();
    osc.stop(audioCtx.currentTime + 0.1);
  }

  function validateBpm(rawValue) {
    const bpm = Number(rawValue);
    if (!Number.isFinite(bpm) || Number.isNaN(bpm)) return null;
    if (bpm < MIN_BPM || bpm > MAX_BPM) return null;
    return bpm;
  }

  function clampBpm(bpm) {
    if (!Number.isFinite(bpm) || Number.isNaN(bpm)) return MIN_BPM;
    return Math.min(MAX_BPM, Math.max(MIN_BPM, bpm));
  }

  function setBpmValue(bpm) {
    const clamped = clampBpm(bpm);
    bpmInput.value = String(clamped);
    if (bpmSlider) {
      bpmSlider.value = String(clamped);
    }
    return clamped;
  }

  function setStatus(message, type = "") {
    statusText.textContent = message;
    statusText.classList.remove("running", "error");
    if (type) {
      statusText.classList.add(type);
    }
  }

  function startMetronome() {
    const bpm = validateBpm(bpmInput.value);
    if (!bpm) {
      setStatus("Enter a tempo between 20 and 300 BPM.", "error");
      return;
    }

    if (intervalId !== null) {
      window.clearInterval(intervalId);
    }

    // Ensure AudioContext is resumed (required after user gesture in some browsers)
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    } else if (audioCtx.state === "suspended") {
      audioCtx.resume();
    }

    const intervalMs = getIntervalMsFromBpm(bpm);
    playClick(); // immediate first click
    intervalId = window.setInterval(playClick, intervalMs);

    isRunning = true;
    toggleBtn.textContent = "Stop";
    setStatus(`Running at ${bpm} BPM.`, "running");
  }

  function stopMetronome() {
    if (intervalId !== null) {
      window.clearInterval(intervalId);
      intervalId = null;
    }
    isRunning = false;
    toggleBtn.textContent = "Start";
    setStatus("Stopped");
  }

  toggleBtn.addEventListener("click", () => {
    if (isRunning) {
      stopMetronome();
    } else {
      startMetronome();
    }
  });

  bpmInput.addEventListener("input", () => {
    const bpm = validateBpm(bpmInput.value);
    if (!bpm) {
      return;
    }
    setBpmValue(bpm);
    if (isRunning) {
      startMetronome();
    } else {
      setStatus(`Ready at ${bpm} BPM.`);
    }
  });

  if (bpmSlider) {
    // While dragging, just sync the visual BPM controls and (if stopped) the status,
    // but do not restart a running metronome yet.
    bpmSlider.addEventListener("input", () => {
      const bpm = validateBpm(bpmSlider.value);
      if (!bpm) return;
      setBpmValue(bpm);
      if (!isRunning) {
        setStatus(`Ready at ${bpm} BPM.`);
      }
    });

    // When the user releases the slider (change event), then apply the new BPM.
    bpmSlider.addEventListener("change", () => {
      const bpm = validateBpm(bpmSlider.value);
      if (!bpm) return;
      setBpmValue(bpm);
      if (isRunning) {
        startMetronome();
      } else {
        setStatus(`Ready at ${bpm} BPM.`);
      }
    });
  }

  function stepBpm(delta) {
    const current = validateBpm(bpmInput.value) ?? 120;
    const next = clampBpm(current + delta);
    setBpmValue(next);
    if (isRunning) {
      startMetronome();
    } else {
      setStatus(`Ready at ${next} BPM.`);
    }
  }

  if (bpmUpBtn) {
    bpmUpBtn.addEventListener("click", () => stepBpm(1));
  }

  if (bpmDownBtn) {
    bpmDownBtn.addEventListener("click", () => stepBpm(-1));
  }

  // Initial status
  const initialBpm = validateBpm(bpmInput.value);
  if (initialBpm) {
    const syncedBpm = setBpmValue(initialBpm);
    setStatus(`Ready at ${syncedBpm} BPM.`);
  } else {
    setStatus("Enter a tempo between 20 and 300 BPM.");
    setBpmValue(MIN_BPM);
  }
})();

