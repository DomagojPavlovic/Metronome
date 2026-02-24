(() => {
  const toggleBtn = document.getElementById("toggle-btn");
  const resetBtn = document.getElementById("reset-btn");
  const statusText = document.getElementById("status-text");
  const loopToggle = /** @type {HTMLInputElement | null} */ (
    document.getElementById("loop-toggle")
  );
  const fieldError = /** @type {HTMLParagraphElement | null} */ (
    document.getElementById("field-error")
  );
  const volumeSlider = /** @type {HTMLInputElement | null} */ (
    document.getElementById("volume-slider")
  );
  const presetNameInput = /** @type {HTMLInputElement | null} */ (
    document.getElementById("preset-name-input")
  );
  const presetSaveBtn = /** @type {HTMLButtonElement | null} */ (
    document.getElementById("preset-save-btn")
  );
  const presetListEl = /** @type {HTMLDivElement | null} */ (
    document.getElementById("preset-list")
  );
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
  /** @type {Map<number, { bpm: number, beats: number, subdivisions: number, shuffle: boolean }>} */
  const dynamicSegmentConfigs = new Map();

  const MIN_BPM = 20;
  const MAX_BPM = 300;
  const MIN_TS_TOP = 1;
  const MAX_TS_TOP = 64;
  const MIN_TS_BOTTOM = 1;
  const MAX_TS_BOTTOM = 64;
  const STORAGE_KEY = "ultimate-metronome:program";
  const STORAGE_SLOTS_KEY = "ultimate-metronome:program-slots";

  function getMasterVolume() {
    if (!volumeSlider) return 1;
    const raw = Number(volumeSlider.value);
    if (!Number.isFinite(raw) || Number.isNaN(raw)) return 1;
    const clamped = Math.min(100, Math.max(0, raw));
    if (clamped === 0) {
      // Use a tiny positive value to avoid exponential ramps to 0,
      // which can break the AudioContext, while still being inaudible.
      return 0.0001;
    }
    return clamped / 100;
  }

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

    const volume = getMasterVolume();

    gain.gain.setValueAtTime(0.001, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(
      1.0 * volume,
      audioCtx.currentTime + 0.001
    );
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

    const volume = getMasterVolume();

    gain.gain.setValueAtTime(0.001, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(
      0.5 * volume,
      audioCtx.currentTime + 0.001
    );
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

  function setFieldError(message) {
    if (fieldError) {
      fieldError.textContent = message;
    }
  }

  function clearFieldError() {
    if (fieldError) {
      fieldError.textContent = "";
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
   * Serialize the current program (rows + loop + volume) from the DOM.
   */
  function serializeProgramFromDom() {
    const rows = Array.from(
      tempoRowsContainer.querySelectorAll(".tempo-row")
    );

    /** @type {any[]} */
    const rowData = rows.map((row) => {
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

      return {
        bpm: bpmInputEl ? bpmInputEl.value : "100",
        tsTop: tsTopInputEl ? tsTopInputEl.value : "4",
        tsBottom: tsBottomInputEl ? tsBottomInputEl.value : "4",
        subdivEnabled: !!subdivisionEnableEl?.checked,
        subdivisions: subdivisionInputEl ? subdivisionInputEl.value : "2",
        shuffle: !!subdivisionShuffleEl?.checked,
      };
    });

    return {
      rows: rowData,
      loop: !!loopToggle?.checked,
      volume: volumeSlider ? volumeSlider.value : "100",
    };
  }

  function saveProgramToStorage() {
    try {
      const data = serializeProgramFromDom();
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch {
      // Ignore storage errors (e.g., disabled cookies)
    }
  }

  /**
   * Apply a serialized program object to the DOM (rows + loop + volume).
   * @param {{ rows?: any[]; loop?: boolean; volume?: string }} program
   * @returns {boolean}
   */
  function applyProgramToDom(program) {
    if (!program || !Array.isArray(program.rows) || !program.rows.length) {
      return false;
    }

    // Clear existing rows.
    tempoRowsContainer.innerHTML = "";

    program.rows.forEach((rowConfig) => {
      const bpm = Number(rowConfig.bpm) || 100;
      const tsTop = Number(rowConfig.tsTop) || 4;
      const tsBottom = Number(rowConfig.tsBottom) || 4;

      createTempoRow(bpm, tsTop, tsBottom);

      const createdRow = /** @type {HTMLElement | null} */ (
        tempoRowsContainer.lastElementChild
      );
      if (!createdRow) return;

      const subdivisionEnableEl = /** @type {HTMLInputElement | null} */ (
        createdRow.querySelector(".subdivision-enable")
      );
      const subdivisionInputEl = /** @type {HTMLInputElement | null} */ (
        createdRow.querySelector(".subdivision-input")
      );
      const subdivisionShuffleEl = /** @type {HTMLInputElement | null} */ (
        createdRow.querySelector(".subdivision-shuffle")
      );

      if (subdivisionEnableEl) {
        subdivisionEnableEl.checked = !!rowConfig.subdivEnabled;
      }
      if (subdivisionInputEl && typeof rowConfig.subdivisions !== "undefined") {
        subdivisionInputEl.value = String(rowConfig.subdivisions);
      }
      if (subdivisionShuffleEl) {
        subdivisionShuffleEl.checked = !!rowConfig.shuffle;
      }

      // Re-apply subdivision state visuals.
      const subdivisionSettingsEl = /** @type {HTMLDivElement | null} */ (
        createdRow.querySelector(".subdivision-settings")
      );
      if (subdivisionEnableEl && subdivisionSettingsEl) {
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
      }
    });

    if (loopToggle && typeof program.loop === "boolean") {
      loopToggle.checked = program.loop;
    }

    if (volumeSlider && typeof program.volume === "string") {
      volumeSlider.value = program.volume;
    }

    return true;
  }

  /**
   * Restore a saved program from storage.
   * Returns true if something was restored, false otherwise.
   */
  function loadProgramFromStorage() {
    let raw = null;
    try {
      raw = window.localStorage.getItem(STORAGE_KEY);
    } catch {
      return false;
    }

    if (!raw) return false;

    /** @type {{ rows?: any[]; loop?: boolean; volume?: string } | null} */
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return false;
    }

    return applyProgramToDom(parsed);
  }

  /**
   * ------ Program slots (saved programs) ------
   */

  /**
   * @returns {{ id: string; name: string; createdAt: number; program: { rows: any[]; loop: boolean; volume: string } }[]}
   */
  function loadProgramSlots() {
    let raw = null;
    try {
      raw = window.localStorage.getItem(STORAGE_SLOTS_KEY);
    } catch {
      return [];
    }
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed;
    } catch {
      return [];
    }
  }

  /**
   * @param {{ id: string; name: string; createdAt: number; program: { rows: any[]; loop: boolean; volume: string } }[]} slots
   */
  function saveProgramSlots(slots) {
    try {
      window.localStorage.setItem(STORAGE_SLOTS_KEY, JSON.stringify(slots));
    } catch {
      // Ignore storage errors
    }
  }

  function renderProgramSlots() {
    if (!presetListEl) return;

    const slots = loadProgramSlots();
    presetListEl.innerHTML = "";

    slots.forEach((slot) => {
      const rowEl = document.createElement("div");
      rowEl.className = "preset-row";
      rowEl.dataset.id = slot.id;

      const nameEl = document.createElement("div");
      nameEl.className = "preset-row-name";
      nameEl.textContent = slot.name || "Untitled";

      const actionsEl = document.createElement("div");
      actionsEl.className = "preset-row-actions";

      const loadBtn = document.createElement("button");
      loadBtn.type = "button";
      loadBtn.textContent = "Load";
      loadBtn.dataset.action = "load";

      const deleteBtn = document.createElement("button");
      deleteBtn.type = "button";
      deleteBtn.textContent = "Delete";
      deleteBtn.dataset.action = "delete";

      actionsEl.appendChild(loadBtn);
      actionsEl.appendChild(deleteBtn);

      rowEl.appendChild(nameEl);
      rowEl.appendChild(actionsEl);

      presetListEl.appendChild(rowEl);
    });
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
        const msg = `Row ${i + 1}: tempo must be between ${MIN_BPM} and ${MAX_BPM} BPM.`;
        setStatus(msg, "error");
        setFieldError(msg);
        return null;
      }

      const tsTop = Number.parseInt(tsTopInputEl.value, 10);
      if (
        !Number.isFinite(tsTop) ||
        tsTop < MIN_TS_TOP ||
        tsTop > MAX_TS_TOP
      ) {
        const msg = `Row ${i + 1}: top time value must be a whole number between ${MIN_TS_TOP} and ${MAX_TS_TOP}.`;
        setStatus(msg, "error");
        setFieldError(msg);
        return null;
      }

      const tsBottom = Number.parseInt(tsBottomInputEl.value, 10);
      const allowedBottoms = [1, 2, 4, 8, 16, 32, 64];
      if (!Number.isFinite(tsBottom) || !allowedBottoms.includes(tsBottom)) {
        const msg = `Row ${i + 1}: bottom time value must be one of 1, 2, 4, 8, 16, 32, 64.`;
        setStatus(msg, "error");
        setFieldError(msg);
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
        const msg = `Row ${i + 1}: subdivisions must be a whole number between 2 and 64.`;
        setStatus(msg, "error");
        setFieldError(msg);
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

  /**
   * Compute a fresh segment config for a given row index from the DOM.
   * This is used so that edits to a row only take effect the next time
   * that row is entered.
   * @param {number} index
   * @returns {{ bpm: number, beats: number, subdivisions: number, shuffle: boolean } | null}
   */
  function buildSegmentConfigForRow(index) {
    if (!currentSequenceRows || !currentSequenceRows[index]) {
      return null;
    }

    const row = currentSequenceRows[index];
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

    if (!bpmInputEl || !tsTopInputEl || !tsBottomInputEl) {
      return null;
    }

    const rowNumber = index + 1;

    const baseBpm = validateBpm(bpmInputEl.value);
    if (!baseBpm) {
      const msg = `Row ${rowNumber}: tempo must be between ${MIN_BPM} and ${MAX_BPM} BPM.`;
      setStatus(msg, "error");
      setFieldError(msg);
      return null;
    }

    const tsTop = Number.parseInt(tsTopInputEl.value, 10);
    if (
      !Number.isFinite(tsTop) ||
      tsTop < MIN_TS_TOP ||
      tsTop > MAX_TS_TOP
    ) {
      const msg = `Row ${rowNumber}: top time value must be a whole number between ${MIN_TS_TOP} and ${MAX_TS_TOP}.`;
      setStatus(msg, "error");
      setFieldError(msg);
      return null;
    }

    const tsBottom = Number.parseInt(tsBottomInputEl.value, 10);
    const allowedBottoms = [1, 2, 4, 8, 16, 32, 64];
    if (!Number.isFinite(tsBottom) || !allowedBottoms.includes(tsBottom)) {
      const msg = `Row ${rowNumber}: bottom time value must be one of 1, 2, 4, 8, 16, 32, 64.`;
      setStatus(msg, "error");
      setFieldError(msg);
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
        const msg = `Row ${rowNumber}: subdivisions must be a whole number between 2 and 64.`;
        setStatus(msg, "error");
        setFieldError(msg);
        return null;
      }
      subdivisions = rawSubdivisions;
      shuffle = !!subdivisionShuffleEl?.checked;
    }

    return {
      bpm: effectiveBpm,
      beats: tsTop,
      subdivisions,
      shuffle,
    };
  }

  /**
   * Get a segment config for the given index, caching it for the duration
   * of the time we are inside that row. When we exit the row, the cache
   * entry is cleared so that edits are picked up the next time we enter.
   * @param {number} index
   * @returns {{ bpm: number, beats: number, subdivisions: number, shuffle: boolean } | null}
   */
  function getSegmentConfig(index) {
    if (dynamicSegmentConfigs.has(index)) {
      return dynamicSegmentConfigs.get(index) ?? null;
    }
    const config = buildSegmentConfigForRow(index);
    if (!config) {
      return null;
    }
    dynamicSegmentConfigs.set(index, config);
    return config;
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
    dynamicSegmentConfigs.clear();
    toggleBtn.textContent = "Start";
    setStatus("Stopped");
  }

  function resetProgramToDefaults() {
    if (isRunning) {
      stopMetronome();
    }

    // Clear all rows and recreate a single default row.
    tempoRowsContainer.innerHTML = "";
    createTempoRow(100, 4, 4);

    clearFieldError();
    setStatus("Program ready.");
  }

  function runClickAndAdvance() {
    if (!isRunning || !currentSequenceRows) return;

    // Find the next segment that still has ticks to play.
    while (true) {
      if (!currentSequenceRows[currentSegmentIndex]) {
        stopMetronome();
        return;
      }

      const segment = getSegmentConfig(currentSegmentIndex);
      if (!segment) {
        // Error has already been reported in buildSegmentConfigForRow.
        stopMetronome();
        return;
      }

      const subdivisions = Math.max(1, segment.subdivisions || 1);
      const beats = segment.beats;
      const totalTicksInSegment = beats * subdivisions;

      if (currentTickIndexInSegment >= totalTicksInSegment) {
        // We are leaving this segment; clear its cached dynamic config so
        // that any edits are picked up the next time we enter it.
        dynamicSegmentConfigs.delete(currentSegmentIndex);
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

      if (!currentSequenceRows[nextSegmentIndex]) {
        // End of the programmed sequence: either loop from the beginning
        // or stop, depending on the loop toggle.
        currentTimeoutId = window.setTimeout(() => {
          // If the user stopped manually while the timeout was pending,
          // do nothing.
          if (!isRunning || !currentSequence) {
            return;
          }

          const shouldLoop = !!loopToggle?.checked;

          if (shouldLoop) {
            currentSegmentIndex = 0;
            currentTickIndexInSegment = 0;
            clearActiveRowIndicators();
            runClickAndAdvance();
          } else {
            stopMetronome();
          }
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
        if (!bpm) {
          bpmInputEl.classList.add("input-error");
          setFieldError("Tempo must be an integer between 20 and 300 BPM.");
          return;
        }
        bpmInputEl.classList.remove("input-error");
        clearFieldError();
        syncRowBpm(row, bpm);
        saveProgramToStorage();
      });
    }

    if (bpmSliderEl) {
      bpmSliderEl.addEventListener("input", () => {
        const bpm = validateBpm(bpmSliderEl.value);
        if (!bpm) {
          if (bpmInputEl) bpmInputEl.classList.add("input-error");
          setFieldError("Tempo must be an integer between 20 and 300 BPM.");
          return;
        }
        if (bpmInputEl) bpmInputEl.classList.remove("input-error");
        clearFieldError();
        syncRowBpm(row, bpm);
        saveProgramToStorage();
      });
    }

    function stepRowBpm(delta) {
      const current =
        (bpmInputEl && validateBpm(bpmInputEl.value)) ?? 120;
      const next = clampBpm(current + delta);
      syncRowBpm(row, next);
      saveProgramToStorage();
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
        saveProgramToStorage();
      };

      subdivisionEnableEl.addEventListener("change", applySubdivisionState);
      applySubdivisionState();
    }

    if (subdivisionInputEl) {
      subdivisionInputEl.addEventListener("input", () => {
        const raw = Number.parseInt(subdivisionInputEl.value, 10);
        if (!Number.isFinite(raw) || raw < 2 || raw > 64) {
          subdivisionInputEl.classList.add("input-error");
          setFieldError("Subdivisions must be an integer between 2 and 64.");
          return;
        }
        subdivisionInputEl.classList.remove("input-error");
        clearFieldError();
        saveProgramToStorage();
      });
    }

    if (deleteBtnEl) {
      deleteBtnEl.addEventListener("click", () => {
        const indexInSequence =
          currentSequenceRows?.indexOf(row) ?? -1;

        if (
          isRunning &&
          currentSequenceRows &&
          currentSequenceRows[currentSegmentIndex] === row
        ) {
          // If the currently playing row is deleted, stop the metronome.
          stopMetronome();
          row.remove();
          return;
        }

        row.remove();

        // If we removed a non-current row while running, keep playing
        // but update our internal row list and cached configs so that
        // on the next time we "would have" reached that row, it is
        // correctly skipped.
        if (currentSequenceRows && indexInSequence !== -1) {
          // Rebuild the sequence rows from the DOM to keep indices aligned.
          currentSequenceRows = Array.from(
            tempoRowsContainer.querySelectorAll(".tempo-row")
          );

          if (isRunning) {
            // If the removed row was before the current one, shift the
            // current segment index left so we stay on the same logical row.
            if (indexInSequence < currentSegmentIndex) {
              currentSegmentIndex = Math.max(0, currentSegmentIndex - 1);
            }

            // Clear any cached configs for rows at or after the removed
            // index so that future passes rebuild them from the DOM.
            dynamicSegmentConfigs.forEach((_, key) => {
              if (key >= indexInSequence) {
                dynamicSegmentConfigs.delete(key);
              }
            });
          }
        }

        saveProgramToStorage();
      });
    }

    // Save when time signature values change.
    const tsTopInputEl = /** @type {HTMLInputElement | null} */ (
      row.querySelector(".ts-top-input")
    );
    const tsBottomInputEl = /** @type {HTMLInputElement | null} */ (
      row.querySelector(".ts-bottom-input")
    );
    if (tsTopInputEl) {
      tsTopInputEl.addEventListener("input", () => {
        const value = Number.parseInt(tsTopInputEl.value, 10);
        if (
          !Number.isFinite(value) ||
          value < MIN_TS_TOP ||
          value > MAX_TS_TOP
        ) {
          tsTopInputEl.classList.add("input-error");
          setFieldError("Top time value must be an integer between 1 and 64.");
          return;
        }
        tsTopInputEl.classList.remove("input-error");
        clearFieldError();
        saveProgramToStorage();
      });
    }
    if (tsBottomInputEl) {
      tsBottomInputEl.addEventListener("input", () => {
        const value = Number.parseInt(tsBottomInputEl.value, 10);
        const allowedBottoms = [1, 2, 4, 8, 16, 32, 64];
        if (!Number.isFinite(value) || !allowedBottoms.includes(value)) {
          tsBottomInputEl.classList.add("input-error");
          setFieldError(
            "Bottom time value must be one of 1, 2, 4, 8, 16, 32, 64."
          );
          return;
        }
        tsBottomInputEl.classList.remove("input-error");
        clearFieldError();
        saveProgramToStorage();
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

    // If the metronome is running, make sure the internal row list
    // includes this newly added row so that it will be reached
    // naturally later in the program (or on the next loop) without
    // restarting.
    if (isRunning && currentSequenceRows) {
      currentSequenceRows = Array.from(
        tempoRowsContainer.querySelectorAll(".tempo-row")
      );
    }

    saveProgramToStorage();
  }

  toggleBtn.addEventListener("click", () => {
    if (isRunning) {
      stopMetronome();
    } else {
      startProgrammedMetronome();
    }
  });

  if (resetBtn) {
    resetBtn.addEventListener("click", () => {
      resetProgramToDefaults();
    });
  }

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

  if (loopToggle) {
    loopToggle.addEventListener("change", saveProgramToStorage);
  }

  if (volumeSlider) {
    volumeSlider.addEventListener("input", saveProgramToStorage);
  }

  if (presetSaveBtn) {
    presetSaveBtn.addEventListener("click", () => {
      const rawName = presetNameInput ? presetNameInput.value.trim() : "";
      if (!rawName || rawName.length > 18) {
        setFieldError("Preset name must be 1–18 characters.");
        if (presetNameInput) {
          presetNameInput.classList.add("input-error");
        }
        return;
      }
      if (presetNameInput) {
        presetNameInput.classList.remove("input-error");
      }
      clearFieldError();

      const name = rawName;
      const program = serializeProgramFromDom();
      const now = Date.now();

      let slots = loadProgramSlots();
      const id = `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

      slots.push({
        id,
        name,
        createdAt: now,
        program,
      });

      // Keep only the 10 most recent slots.
      if (slots.length > 10) {
        slots = slots
          .sort((a, b) => b.createdAt - a.createdAt)
          .slice(0, 10);
      }

      saveProgramSlots(slots);
      renderProgramSlots();

      if (presetNameInput) {
        presetNameInput.value = "";
      }
    });
  }

  if (presetListEl) {
    presetListEl.addEventListener("click", (event) => {
      const target = /** @type {HTMLElement} */ (event.target);
      if (!(target instanceof HTMLElement)) return;

      const action = target.dataset.action;
      if (!action) return;

      const rowEl = target.closest(".preset-row");
      if (!rowEl || !rowEl.dataset.id) return;

      const id = rowEl.dataset.id;
      let slots = loadProgramSlots();
      const slot = slots.find((s) => s.id === id);
      if (!slot) return;

      if (action === "load") {
        const applied = applyProgramToDom(slot.program);
        if (applied) {
          saveProgramToStorage();
          setStatus(`Program loaded: ${slot.name || "Untitled"}.`);
        }
      } else if (action === "delete") {
        slots = slots.filter((s) => s.id !== id);
        saveProgramSlots(slots);
        renderProgramSlots();
      }
    });
  }

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

  const restored = loadProgramFromStorage();

  if (!restored) {
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
  } else {
    setStatus("Program restored.");
  }

  // Render any existing saved slots on load.
  renderProgramSlots();
})();

(() => {
  const bpmInput = document.getElementById("bpm");
  const toggleBtn = document.getElementById("toggle-btn");
  const statusText = document.getElementById("status-text");
  const bpmSlider = document.getElementById("bpm-slider");
  const bpmUpBtn = document.getElementById("bpm-up");
  const bpmDownBtn = document.getElementById("bpm-down");
  const volumeSlider = /** @type {HTMLInputElement | null} */ (
    document.getElementById("volume-slider")
  );

  /** @type {AudioContext | null} */
  let audioCtx = null;
  /** @type {number | null} */
  let intervalId = null;
  let isRunning = false;

  const MIN_BPM = 20;
  const MAX_BPM = 300;

  function getMasterVolume() {
    if (!volumeSlider) return 1;
    const raw = Number(volumeSlider.value);
    if (!Number.isFinite(raw) || Number.isNaN(raw)) return 1;
    const clamped = Math.min(100, Math.max(0, raw));
    if (clamped === 0) {
      // Use a tiny positive value to avoid exponential ramps to 0,
      // which can break the AudioContext, while still being inaudible.
      return 0.0001;
    }
    return clamped / 100;
  }

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

    const volume = getMasterVolume();

    gain.gain.setValueAtTime(0.001, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(
      1.0 * volume,
      audioCtx.currentTime + 0.001
    );
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

