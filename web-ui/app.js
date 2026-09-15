/**
 * Video AI Orchestrator (VAIO) — front-end application logic
 *
 * Two independent language concepts run through this file:
 *
 *   Interface language — console chrome. Read with `t()` from i18n.js, switchable
 *   at any time, persisted per browser.
 *
 *   Project language (`state.language`) — the language a storyboard's narration,
 *   titles, and character descriptions are generated in. Fixed when the project is
 *   created and stored on the manifest. It also selects the narration voice catalog
 *   and the transcription locale. Every API call that generates or regenerates
 *   content sends it, so the backend never has to guess.
 *
 * Image prompts are always English regardless of project language, because the image
 * models follow English far more reliably. The backend enforces that; the console
 * only labels it.
 */

const { t, getUiLanguage, getLocaleTag, setUiLanguage, applyTranslations } = window.VaioI18n;

const VAIO_CONFIG = window.__VAIO_CONFIG || {};
const API = VAIO_CONFIG.apiUrl;

if (!API) {
  console.error('VAIO: apiUrl missing from config.js. Run scripts/build-frontend.ps1 after deploying.');
}

// ─── Auth-aware fetch wrapper with token refresh ───
const _origFetch = window.fetch.bind(window);

/**
 * Fetch wrapper that attaches (and refreshes) the Cognito ID token for API calls.
 *
 * @param {string} url Request URL.
 * @param {RequestInit} [opts] Fetch options.
 * @returns {Promise<Response>} The fetch response.
 */
async function authFetch(url, opts = {}) {
  if (API && url.startsWith(API)) {
    // Refresh the token if the session is close to expiry; long generation runs can
    // outlive the original token.
    if (window.__cognitoPool) {
      const user = window.__cognitoPool.getCurrentUser();
      if (user) {
        await new Promise((resolve) => {
          user.getSession((err, session) => {
            if (!err && session && session.isValid()) {
              window.__cognitoIdToken = session.getIdToken().getJwtToken();
            }
            resolve();
          });
        });
      }
    }
    if (window.__cognitoIdToken) {
      if (opts.headers instanceof Headers) {
        opts.headers.set('Authorization', window.__cognitoIdToken);
      } else if (opts.body instanceof FormData) {
        opts.headers = { Authorization: window.__cognitoIdToken };
      } else if (typeof opts.headers === 'object' && opts.headers !== null) {
        opts.headers.Authorization = window.__cognitoIdToken;
      } else {
        opts.headers = { ...(opts.headers || {}), Authorization: window.__cognitoIdToken };
      }
    }
  }
  return _origFetch(url, opts);
}
const fetch = authFetch;

/** POST helper for JSON bodies, which is nearly every call in this file. */
function postJson(path, body) {
  return fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ─── Style Presets ───
// Sent to the backend verbatim and forwarded to the image models, so they stay in
// English even for French projects.
const STYLE_PRESETS = {
  'pastel-cartoon':
    'Simple colorful 2D flat cartoon illustration. Bold clean black outlines on everything. Flat geometric shapes, soft pastel color gradients, bright saturated colors. Warm peach, coral, teal, and lavender color palette. Simple cartoon characters with round heads, small black dot eyes, simple curved line mouths, minimal facial features, solid color clothing. Absolutely clean image with zero text, zero titles, zero labels, zero captions, zero watermarks. Pure illustration only.',
  'bold-corporate':
    'Bold high-energy 2D marketing illustration with vibrant warm gradients from gold to coral to crimson. Confident geometric shapes, dynamic diagonal compositions, strong contrast. Simple stylized people with round heads and minimal features. Rich saturated colors, clean white accents, premium feel. Flat 2D style with subtle depth through overlapping shapes. Zero text, zero labels, zero watermarks. Pure illustration only.',
  'custom-image': '', // filled in by AI analysis of an uploaded reference
};

// ─── State ───
const state = {
  script: '',
  shots: [],
  selectedMusic: null,
  musicVolume: 0.3,
  musicTracks: [],
  settings: { shotCount: 8, shotDuration: 6 },
  selectedStyle: 'pastel-cartoon',
  narrativeStyle: '',
  selectedVoice: 'tiffany',
  selectedImageModel: 'gemini',
  referenceImages: [],
  selectedWallpaper: null,
  // Project language. Defaults to the interface language so a French user who starts
  // typing immediately gets a French project without an extra click.
  language: getUiLanguage(),
  // Set once a project exists; the language can no longer change.
  languageLocked: false,
  availableVoices: [],
};

// ─── DOM refs ───
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const stepUpload = $('#step-upload');
const stepStoryboard = $('#step-storyboard');
const stepFinalize = $('#step-finalize');
const stepHistory = $('#step-history');
const statusBadge = $('#status-badge');
const fileInput = $('#file-input');
const scriptTextarea = $('#script-textarea');
const processBtn = $('#process-btn');
const browseBtn = $('#browse-btn');
const uploadCard = $('#upload-card');
const storyboardGrid = $('#storyboard-grid');
const progressOverlay = $('#progress-overlay');
const progressTitle = $('#progress-title');
const progressDetail = $('#progress-detail');
const progressBar = $('#progress-bar');
const aiModal = $('#ai-modal');
const narrationAiModal = $('#narration-ai-modal');

// ═══════════════════════════════════════════
// THEME CONTROL
// ═══════════════════════════════════════════

const THEME_ICONS = { light: '☀️', dark: '🌙', system: '🖥️' };
const THEME_LABEL_KEYS = { light: 'nav.themeLight', dark: 'nav.themeDark', system: 'nav.themeSystem' };

/** Refresh every theme toggle to reflect the current setting. */
function renderThemeToggles() {
  const setting = window.VaioTheme.getThemeSetting();
  $$('[data-theme-toggle]').forEach((button) => {
    const icon = button.querySelector('[data-theme-icon]');
    const label = button.querySelector('[data-theme-label]');
    if (icon) icon.textContent = THEME_ICONS[setting];
    if (label) label.textContent = t(THEME_LABEL_KEYS[setting]);
    // Announce what the next activation will do, not the current state.
    const nextIsLight = window.VaioTheme.getResolvedTheme() === 'dark';
    button.setAttribute('aria-label', t(nextIsLight ? 'nav.switchToLight' : 'nav.switchToDark'));
  });
}

$$('[data-theme-toggle]').forEach((button) => {
  button.addEventListener('click', () => {
    window.VaioTheme.cycleTheme();
    renderThemeToggles();
  });
});
window.addEventListener('vaio-theme-changed', renderThemeToggles);
renderThemeToggles();

// ═══════════════════════════════════════════
// INTERFACE LANGUAGE CONTROL
// ═══════════════════════════════════════════

/** Mark the active interface-language button in every switch. */
function renderLanguageSwitches() {
  const current = getUiLanguage();
  $$('[data-lang-btn]').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.langBtn === current));
  });
}

$$('[data-lang-btn]').forEach((button) => {
  button.addEventListener('click', () => setUiLanguage(button.dataset.langBtn));
});

window.addEventListener('vaio-language-changed', () => {
  renderLanguageSwitches();
  renderThemeToggles();
  renderProjectLanguagePicker();
  renderNarrativeStyleDefault();
  // Voice descriptions are served by the backend in the interface language.
  loadVoices();
  renderStoryboardVoiceOptions();
  if (state.shots.length) renderStoryboard();
  if (stepHistory.classList.contains('active')) loadRunHistory();
  updateFinalizeStats();
  updateModelBadge();
  setStatus('idle', t('status.ready'));
});

renderLanguageSwitches();

// ═══════════════════════════════════════════
// PROJECT LANGUAGE
// ═══════════════════════════════════════════

/**
 * Reflect the project language selection, including the locked state.
 *
 * Once a project exists the language cannot change: narration, audio, and the
 * character bible were all generated in it, so switching would silently invalidate
 * them. Users create a new project instead.
 */
function renderProjectLanguagePicker() {
  const picker = $('#language-picker');
  if (!picker) return;

  picker.querySelectorAll('[data-project-lang]').forEach((card) => {
    const isSelected = card.dataset.projectLang === state.language;
    card.classList.toggle('selected', isSelected);
    card.setAttribute('aria-pressed', String(isSelected));
    card.setAttribute('aria-disabled', String(state.languageLocked));
    card.disabled = state.languageLocked;
  });

  let note = picker.querySelector('.panel-note');
  if (state.languageLocked) {
    if (!note) {
      note = document.createElement('p');
      note.className = 'panel-note';
      picker.appendChild(note);
    }
    note.textContent = t('language.lockedNotice');
    note.hidden = false;
  } else if (note) {
    note.hidden = true;
  }
}

/**
 * Set the project language.
 *
 * Also switches the interface to match, which is what a user selecting a project
 * language almost always wants. They can switch the interface back independently.
 *
 * @param {'en'|'fr'} lang Requested project language.
 */
function setProjectLanguage(lang) {
  if (state.languageLocked || lang === state.language) return;
  state.language = lang;
  renderProjectLanguagePicker();
  renderNarrativeStyleDefault();
  setUiLanguage(lang);
  // setUiLanguage fires the change event, which reloads voices for the new language.
  // Guard against the no-op case where the interface was already in that language.
  if (getUiLanguage() === lang) {
    loadVoices();
    renderStoryboardVoiceOptions();
  }
}

$$('[data-project-lang]').forEach((card) => {
  card.addEventListener('click', () => setProjectLanguage(card.dataset.projectLang));
});

/**
 * Show which language a project was generated in, on the storyboard header.
 */
function renderProjectLanguageBadge() {
  const badge = $('#project-lang-badge');
  if (!badge) return;
  if (!state.languageLocked) {
    badge.hidden = true;
    return;
  }
  badge.hidden = false;
  badge.textContent = state.language === 'fr' ? t('language.french') : t('language.english');
}

/**
 * Reset the narrative-style textarea to the localized default.
 *
 * Only overwrites text the user has not customized, so switching the interface
 * language never discards their own direction.
 */
function renderNarrativeStyleDefault() {
  const field = $('#narrative-style');
  if (!field) return;
  const currentValue = field.value.trim();
  const isDefault =
    currentValue === '' ||
    currentValue === window.VaioI18n.t('narrative.default') ||
    field.dataset.pristine === 'true';
  if (isDefault) {
    field.value = t('narrative.default');
    field.dataset.pristine = 'true';
    state.narrativeStyle = field.value;
  }
}

$('#narrative-style').addEventListener('input', (event) => {
  event.target.dataset.pristine = 'false';
  state.narrativeStyle = event.target.value;
});

renderProjectLanguagePicker();
renderNarrativeStyleDefault();

// ─── Style Picker ───
$$('.style-card[data-style]').forEach((card) => {
  card.addEventListener('click', () => {
    const style = card.dataset.style;
    if (style === 'custom-image') {
      $('#style-image-input').click();
      return;
    }
    $$('.style-card[data-style]').forEach((c) => c.classList.remove('selected'));
    card.classList.add('selected');
    state.selectedStyle = style;
    $('#custom-style-preview').hidden = true;
  });
});

$('#style-upload-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  $('#style-image-input').click();
});

$('#style-image-input').addEventListener('change', async () => {
  const file = $('#style-image-input').files[0];
  if (!file) return;

  const preview = $('#style-upload-preview');
  const reader = new FileReader();
  reader.onload = (e) => {
    preview.innerHTML = `<img src="${e.target.result}" alt="">`;
  };
  reader.readAsDataURL(file);

  $$('.style-card[data-style]').forEach((c) => c.classList.remove('selected'));
  document.querySelector('[data-style="custom-image"]').classList.add('selected');

  setStatus('busy', t('status.analyzingStyle'));
  const arrayBuf = await file.arrayBuffer();
  const b64 = bytesToBase64(new Uint8Array(arrayBuf));
  try {
    const res = await postJson('/analyze-style-image', {
      image: b64,
      media_type: file.type || 'image/png',
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || t('status.styleFailed'));
    }
    const data = await res.json();
    STYLE_PRESETS['custom-image'] = data.style;
    state.selectedStyle = 'custom-image';
    state.customStyleImage = b64;
    state.customStyleImageType = file.type || 'image/png';
    $('#custom-style-text').textContent = data.style;
    $('#custom-style-preview').hidden = false;
    setStatus('done', t('status.styleExtracted'));
  } catch (err) {
    setStatus('error', t('status.styleFailed'));
    alert(t('style.analyzeFailed', { error: err.message }));
  }
});

/**
 * Base64-encode bytes without blowing the call stack on large files.
 *
 * String.fromCharCode(...bytes) throws RangeError past a few hundred KB, which broke
 * reference-image uploads in the predecessor.
 *
 * @param {Uint8Array} bytes Raw bytes.
 * @returns {string} Base64 text.
 */
function bytesToBase64(bytes) {
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

// ─── Image Model Picker ───
$$('#model-picker .style-card').forEach((card) => {
  card.addEventListener('click', () => {
    $$('#model-picker .style-card').forEach((c) => c.classList.remove('selected'));
    card.classList.add('selected');
    state.selectedImageModel = card.dataset.model;
  });
});

// ─── Settings Controls ───
const settingShots = $('#setting-shots');
const settingShotsVal = $('#setting-shots-val');
const settingDur = $('#setting-duration');
const settingDurVal = $('#setting-duration-val');
const settingTotal = $('#setting-total');

function updateSettingsDisplay() {
  state.settings.shotCount = parseInt(settingShots.value, 10);
  state.settings.shotDuration = parseInt(settingDur.value, 10);
  settingShotsVal.textContent = state.settings.shotCount;
  settingDurVal.textContent = `${state.settings.shotDuration}s`;
  settingTotal.textContent = `~${state.settings.shotCount * state.settings.shotDuration + 6}s`;
}
settingShots.addEventListener('input', updateSettingsDisplay);
settingDur.addEventListener('input', updateSettingsDisplay);
updateSettingsDisplay();

// ─── Reference Images ───
$('#ref-images-add-btn').addEventListener('click', () => $('#ref-images-input').click());
$('#ref-images-input').addEventListener('change', () => {
  const files = Array.from($('#ref-images-input').files);
  files.forEach((file) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      state.referenceImages.push({
        file,
        label: file.name.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' '),
        dataUrl: e.target.result,
      });
      renderRefImages();
    };
    reader.readAsDataURL(file);
  });
  $('#ref-images-input').value = '';
});

function renderRefImages() {
  const grid = $('#ref-images-grid');
  grid.innerHTML = '';
  state.referenceImages.forEach((ref, i) => {
    const item = document.createElement('div');
    item.className = 'ref-image-item';
    item.innerHTML = `
      <img src="${ref.dataUrl}" alt="${esc(ref.label)}">
      <button class="ref-image-remove" data-idx="${i}" aria-label="${esc(t('common.delete'))}">✕</button>
      <div class="ref-image-label">
        <input type="text" value="${esc(ref.label)}" placeholder="${esc(t('refs.labelPlaceholder'))}" data-idx="${i}">
      </div>
    `;
    grid.appendChild(item);
  });
  grid.querySelectorAll('.ref-image-remove').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      state.referenceImages.splice(parseInt(e.currentTarget.dataset.idx, 10), 1);
      renderRefImages();
    });
  });
  grid.querySelectorAll('.ref-image-label input').forEach((inp) => {
    inp.addEventListener('change', (e) => {
      state.referenceImages[parseInt(e.target.dataset.idx, 10)].label = e.target.value;
    });
  });
}

// ─── Voice Picker ───

/**
 * Load the narration voices available for the current project language.
 *
 * The voice list is language-specific: French projects get the French Nova Sonic
 * voices plus the polyglot ones, and never the English-only voices.
 */
async function loadVoices() {
  const picker = $('#voice-picker');
  if (!picker) return;
  picker.innerHTML = `<p class="text-dim">${esc(t('voice.loading'))}</p>`;
  try {
    const res = await fetch(`${API}/voices?language=${encodeURIComponent(state.language)}`);
    const data = await res.json();
    state.availableVoices = data.voices || [];

    // A voice carried over from another language is not valid here.
    if (!state.availableVoices.some((v) => v.id === state.selectedVoice)) {
      state.selectedVoice = state.availableVoices.length ? state.availableVoices[0].id : 'tiffany';
    }

    picker.innerHTML = '';
    state.availableVoices.forEach((v) => {
      const item = document.createElement('div');
      item.className = `voice-item${v.id === state.selectedVoice ? ' selected' : ''}`;
      item.innerHTML = `
        <div class="music-radio"></div>
        <div class="voice-info">
          <span class="voice-name">${esc(v.name)}</span>
          <span class="voice-desc">${esc(v.desc)}</span>
          <div class="voice-sample-player" id="voice-sample-${esc(v.id)}" hidden></div>
        </div>
        <button class="btn btn-ghost btn-sm voice-sample-btn" data-voice="${esc(v.id)}">▶ ${esc(t('voice.sample'))}</button>
      `;
      item.addEventListener('click', (e) => {
        if (e.target.closest('.voice-sample-btn')) return;
        picker.querySelectorAll('.voice-item').forEach((vi) => vi.classList.remove('selected'));
        item.classList.add('selected');
        state.selectedVoice = v.id;
        renderStoryboardVoiceOptions();
      });
      item.querySelector('.voice-sample-btn').addEventListener('click', async (e) => {
        e.stopPropagation();
        const btn = e.currentTarget;
        const original = btn.textContent;
        btn.textContent = '⏳…';
        try {
          const sampleRes = await fetch(
            `${API}/voice-sample/${encodeURIComponent(v.id)}?language=${encodeURIComponent(state.language)}`,
            { method: 'POST' }
          );
          const d = await sampleRes.json();
          const audio = new Audio(d.audio_url);
          audio
            .play()
            .then(() => {
              btn.textContent = `⏹ ${t('voice.playing')}`;
              audio.onended = () => { btn.textContent = original; };
            })
            .catch(() => {
              // Autoplay blocked — fall back to visible controls.
              const container = document.getElementById(`voice-sample-${v.id}`);
              container.innerHTML = `<audio controls src="${d.audio_url}"></audio>`;
              container.hidden = false;
              btn.textContent = original;
            });
        } catch {
          btn.textContent = `✗ ${t('voice.sampleFailed')}`;
        }
      });
      picker.appendChild(item);
    });
    renderStoryboardVoiceOptions();
  } catch {
    picker.innerHTML = `<p class="text-dim">${esc(t('voice.loadFailed'))}</p>`;
  }
}

/** Rebuild the storyboard-header voice dropdown from the loaded voice list. */
function renderStoryboardVoiceOptions() {
  const select = $('#storyboard-voice-select');
  if (!select) return;
  const voices = state.availableVoices.length
    ? state.availableVoices
    : [{ id: state.selectedVoice, name: state.selectedVoice, gender: '' }];
  select.innerHTML = voices
    .map((v) => `<option value="${esc(v.id)}">🎙️ ${esc(v.name)}${v.gender ? ` (${esc(v.gender)})` : ''}</option>`)
    .join('');
  select.value = state.selectedVoice;
}

window.addEventListener('vaio-auth-ready', () => {
  setTimeout(loadVoices, 100);
});

// ─── Navigation ───
function showStep(step) {
  [stepUpload, stepStoryboard, stepFinalize, stepHistory].forEach((s) => {
    if (s) s.classList.remove('active');
  });
  step.classList.add('active');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
function setStatus(type, text) {
  statusBadge.className = `badge badge-${type}`;
  statusBadge.textContent = text;
  // Clear the declarative key so a later applyTranslations() does not overwrite a
  // live status message with the static default.
  delete statusBadge.dataset.i18n;
}
function showProgress(title, detail, pct) {
  progressOverlay.hidden = false;
  progressTitle.textContent = title;
  progressDetail.textContent = detail;
  progressBar.style.width = `${pct}%`;
  delete progressTitle.dataset.i18n;
  delete progressDetail.dataset.i18n;
}
function updateProgress(detail, pct) {
  progressDetail.textContent = detail;
  progressBar.style.width = `${pct}%`;
}
function hideProgress() {
  progressOverlay.hidden = true;
}

// ─── File Upload ───
browseBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  e.preventDefault();
  fileInput.click();
});
uploadCard.addEventListener('click', (e) => {
  if (e.target === browseBtn || browseBtn.contains(e.target)) return;
  fileInput.click();
});
uploadCard.addEventListener('dragover', (e) => {
  e.preventDefault();
  uploadCard.classList.add('drag-over');
});
uploadCard.addEventListener('dragleave', () => uploadCard.classList.remove('drag-over'));
uploadCard.addEventListener('drop', (e) => {
  e.preventDefault();
  uploadCard.classList.remove('drag-over');
  if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener('change', () => {
  if (fileInput.files.length) handleFile(fileInput.files[0]);
});

async function handleFile(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  if (['txt', 'md'].includes(ext)) {
    scriptTextarea.value = await file.text();
    processBtn.disabled = false;
    return;
  }
  if (['docx', 'doc'].includes(ext)) {
    try {
      setStatus('busy', t('status.readingDocument'));
      // Sent as base64 JSON rather than multipart: API Gateway's multipart handling
      // is unreliable for binary payloads.
      const arrayBuf = await file.arrayBuffer();
      const b64 = bytesToBase64(new Uint8Array(arrayBuf));
      const res = await postJson('/extract-text', { file: b64, filename: file.name });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || res.statusText);
      }
      scriptTextarea.value = (await res.json()).text;
      processBtn.disabled = false;
      setStatus('done', t('status.documentLoaded'));
    } catch (err) {
      setStatus('error', t('status.uploadFailed'));
      alert(t('upload.readFailed', { error: err.message }));
    }
    return;
  }
  alert(t('upload.unsupportedType', { ext }));
}

scriptTextarea.addEventListener('input', () => {
  processBtn.disabled = scriptTextarea.value.trim().length < 20;
});

// ─── Process Script ───
processBtn.addEventListener('click', async () => {
  const script = scriptTextarea.value.trim();
  if (!script) return;
  state.script = script;
  showProgress(t('progress.analyzingScript'), t('progress.analyzingDetail'), 10);
  setStatus('busy', t('status.processing'));
  state.narrativeStyle = ($('#narrative-style') || {}).value || '';

  try {
    const res = await postJson('/process-script', {
      script,
      // The project language drives generation language, voice catalog, and
      // transcription locale for the whole life of this run.
      language: state.language,
      project_name: ($('#project-name') || {}).value || '',
      project_description: ($('#project-description') || {}).value || '',
      shot_count: state.settings.shotCount,
      shot_duration: state.settings.shotDuration,
      style_key: state.selectedStyle,
      style_override: STYLE_PRESETS[state.selectedStyle] || '',
      custom_style_image:
        state.selectedStyle === 'custom-image' && state.customStyleImage ? state.customStyleImage : '',
      narrative_style: state.narrativeStyle,
      image_model: state.selectedImageModel,
      selected_voice: state.selectedVoice,
      reference_images: state.referenceImages.map((r) => ({
        label: r.label,
        data: r.dataUrl.split(',')[1],
      })),
    });
    const submitData = await res.json();
    if (!submitData.job_id) throw new Error(submitData.detail || 'No job_id returned');

    state.projectName = ($('#project-name') || {}).value || '';
    state.projectDescription = ($('#project-description') || {}).value || '';

    const jobId = submitData.job_id;
    let attempts = 0;
    const maxAttempts = 360; // 360 × 2s = 12 minutes

    while (attempts < maxAttempts) {
      await new Promise((r) => setTimeout(r, 2000));
      attempts += 1;
      try {
        const statusRes = await fetch(`${API}/script-status/${jobId}`);
        const statusData = await statusRes.json();
        // `detail` is localized by the backend in the project language.
        if (statusData.progress) updateProgress(statusData.detail || t('progress.processing'), statusData.progress);

        if (statusData.status === 'complete') {
          state.runId = jobId;
          lockProjectLanguage(statusData.language);
          state.shots = statusData.shots.map((s, i) => ({
            shot: i + 1,
            title: s.title,
            image_prompt: s.image_prompt,
            image_url: null,
            narration: s.narration,
            audio_url: null,
            characters_in_shot: s.characters_in_shot || [],
            imageStatus: 'pending',
            audioStatus: 'pending',
            imageLoaded: false,
            audioLoaded: false,
          }));
          if (statusData.characters) state.characters = statusData.characters;
          hideProgress();
          renderStoryboard();
          showStep(stepStoryboard);
          const editBtn = document.getElementById('edit-characters-btn');
          if (editBtn) editBtn.hidden = !state.characters || Object.keys(state.characters).length === 0;
          updateProjectNameDisplay();
          renderStoryboardVoiceOptions();
          generateAllAssets();
          return;
        }
        if (statusData.status === 'characters_ready') {
          state.runId = jobId;
          lockProjectLanguage(statusData.language);
          state.characters = statusData.characters || {};
          state.artDirection = statusData.art_direction || '';
          hideProgress();
          showCharacterReview(jobId, state.characters);
          return;
        }
        if (statusData.status === 'error') {
          throw new Error(statusData.detail || t('status.processingFailed'));
        }
      } catch (pollErr) {
        // Transient network blips are expected over a 12-minute poll; keep going.
        if (pollErr.message && pollErr.message !== 'Failed to fetch') throw pollErr;
      }
    }
    throw new Error(t('progress.timedOut'));
  } catch (err) {
    hideProgress();
    setStatus('error', t('status.processingFailed'));
    alert(t('common.error', { error: err.message }));
  }
});

/**
 * Pin the project language once a run exists.
 *
 * @param {string} [languageFromServer] Language reported by the backend, which is
 *   authoritative over the local selection.
 */
function lockProjectLanguage(languageFromServer) {
  if (languageFromServer) {
    state.language = window.VaioI18n.normalizeUiLanguage(languageFromServer);
  }
  state.languageLocked = true;
  renderProjectLanguagePicker();
  renderProjectLanguageBadge();
}

// ═══════════════════════════════════════════
// STORYBOARD
// ═══════════════════════════════════════════

function renderStoryboard() {
  storyboardGrid.innerHTML = '';
  state.shots.forEach((shot, idx) => {
    const card = document.createElement('div');
    card.className = 'shot-card';
    card.id = `shot-card-${idx}`;
    card.draggable = true;
    card.innerHTML = buildCardShell(shot, idx);
    storyboardGrid.appendChild(card);
  });

  storyboardGrid.querySelectorAll('.shot-title-input').forEach((inp) => {
    inp.addEventListener('change', (e) => {
      state.shots[parseInt(e.target.dataset.idx, 10)].title = e.target.value;
    });
  });

  enableDragReorder();
  updateModelBadge();
  renderProjectLanguageBadge();

  // Re-attach already-loaded media from state, since innerHTML wiped the DOM.
  state.shots.forEach((shot, idx) => {
    if (shot.is_video) {
      if (shot.audio_url && shot.audioStatus === 'done' && shot.audio_mode !== 'native') {
        setAudioDone(idx, shot.audio_url);
      }
    } else if (shot.image_url && shot.imageStatus === 'done') {
      setImageDone(idx, shot.image_url);
    } else if (shot.imageStatus === 'generating') {
      setImageGenerating(idx);
    }
    if (!shot.is_video || shot.audio_mode !== 'native') {
      if (shot.audio_url && shot.audioStatus === 'done') {
        setAudioDone(idx, shot.audio_url);
      } else if (shot.audioStatus === 'generating') {
        setAudioGenerating(idx);
      }
    }
    setCardStatus(idx);
  });
  updateGenProgress();
}

function updateModelBadge() {
  const badge = document.getElementById('model-badge');
  if (!badge) return;
  const byModel = {
    gemini: { cls: 'model-badge-advanced', key: 'model.badgeAdvanced', dot: '🟢' },
    nova: { cls: 'model-badge-standard', key: 'model.badgeStandard', dot: '🟠' },
    sd35: { cls: 'model-badge-experimental', key: 'model.badgeExperimental', dot: '🟣' },
  };
  const meta = byModel[state.selectedImageModel] || byModel.sd35;
  badge.className = `badge ${meta.cls}`;
  badge.textContent = `${meta.dot} ${t(meta.key)}`;
}

function buildCardShell(shot, idx) {
  const isIdle = shot.imageStatus === 'idle';
  const isVideo = shot.is_video;
  const audioPlaceholderText = isIdle ? t('shot.fillNarration') : t('shot.waiting');

  const imageSection = isVideo
    ? `
    <div class="shot-image-wrap" id="img-wrap-${idx}">
      ${
        shot.video_url
          ? `<video src="${esc(shot.video_url)}" preload="metadata" controls></video>`
          : `<div class="shot-image-placeholder" id="img-ph-${idx}"><span aria-hidden="true" style="font-size:1.5rem;">🎬</span> ${esc(t('shot.videoShot'))}</div>`
      }
      <div class="media-chip media-chip-tl">🎬 ${esc(
        shot.audio_mode === 'native' ? t('shot.audioNative') : t('shot.audioVoiceover')
      )}</div>
      <div class="media-chip-action">
        <button class="btn" onclick="openVideoWizard(${idx})">⟳ ${esc(t('shot.reEdit'))}</button>
      </div>
    </div>
  `
    : `
    <div class="shot-image-wrap" id="img-wrap-${idx}">
      <div class="shot-image-placeholder" id="img-ph-${idx}">
        ${
          isIdle
            ? `
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
          <div style="display:flex;gap:.5rem;margin-top:.5rem;flex-wrap:wrap;justify-content:center;">
            <button class="btn btn-ghost btn-sm" onclick="openImportPicker(${idx})">📥 ${esc(t('shot.importShot'))}</button>
            <button class="btn btn-ghost btn-sm" onclick="uploadLocalImageToShot(${idx})">📁 ${esc(t('shot.localFile'))}</button>
            <button class="btn btn-ghost btn-sm" onclick="openVideoWizard(${idx})">🎬 ${esc(t('shot.addVideo'))}</button>
          </div>
          <span class="text-dim" style="font-size:.7rem;margin-top:.25rem;">${esc(t('shot.orFillPrompt'))}</span>
        `
            : `
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
          ${esc(t('shot.waiting'))}
        `
        }
      </div>
      <div class="shot-image-overlay" id="img-overlay-${idx}" style="display:none">
        <button class="btn btn-ghost btn-sm" onclick="regenerateImage(${idx})">⟳ ${esc(t('shot.regenerate'))}</button>
        <button class="btn btn-ghost btn-sm" onclick="openImportPicker(${idx})">📥 ${esc(t('shot.import'))}</button>
        <button class="btn btn-ghost btn-sm" onclick="uploadLocalImageToShot(${idx})">📁 ${esc(t('shot.local'))}</button>
      </div>
    </div>
  `;

  // French projects get an explicit note that the prompt field is English on purpose,
  // so an English prompt under French narration does not look like a bug.
  const promptNote =
    state.language === 'fr'
      ? `<span class="prompt-edit-hint"> — ${esc(t('shot.promptEnglishNote'))}</span>`
      : '';

  return `
    <div class="shot-card-header">
      <span class="shot-number">${esc(t('shot.label', { number: shot.shot }))}</span>
      <input type="text" class="shot-title-input" value="${esc(shot.title)}" data-idx="${idx}"
             title="${esc(t('shot.editTitle'))}">
      <span class="shot-status shot-status-${isIdle ? 'idle' : 'pending'}" id="status-${idx}">
        <span class="shot-status-dot"></span> ${esc(isIdle ? t('shot.statusNew') : t('shot.statusPending'))}
      </span>
      <button class="btn btn-ghost btn-sm shot-delete-btn" onclick="deleteShot(${idx})"
              title="${esc(t('shot.delete'))}">✕</button>
    </div>
    ${imageSection}
    ${
      !isVideo
        ? `<div class="shot-prompt-section">
      <label>${esc(t('shot.imagePrompt'))} <span class="prompt-edit-hint">${esc(t('shot.editable'))}</span>${promptNote}</label>
      <textarea class="shot-prompt-editor" id="prompt-${idx}" rows="3"
                onfocus="this.rows=6" onblur="setTimeout(()=>this.rows=3,200)">${esc(shot.image_prompt)}</textarea>
      <div class="prompt-edit-actions">
        <button class="btn btn-primary btn-sm" onclick="saveAndRegenerateImage(${idx})">⟳ ${esc(t('shot.saveRegenerate'))}</button>
        <button class="btn btn-ghost btn-sm" onclick="openAiHelp(${idx})">✦ ${esc(t('shot.askAi'))}</button>
      </div>
    </div>`
        : ''
    }
    <div class="shot-audio-section" id="audio-section-${idx}">
      <label>${esc(t('shot.audio'))}${
        isVideo
          ? ` <span class="prompt-edit-hint">(${esc(
              shot.audio_mode === 'native' ? t('shot.audioNative') : t('shot.audioVoiceover')
            )})</span>`
          : ''
      }</label>
      <div class="audio-content" id="audio-content-${idx}">
        <span class="narration-preview">${esc(audioPlaceholderText)}</span>
      </div>
    </div>
    <div class="shot-narration-section">
      <label>${esc(t('shot.narrationScript'))} <span class="prompt-edit-hint">${esc(t('shot.editable'))}</span></label>
      <textarea class="shot-prompt-editor" id="narration-${idx}" rows="2"
                onfocus="this.rows=4" onblur="setTimeout(()=>this.rows=2,200)">${esc(shot.narration)}</textarea>
      <div class="prompt-edit-actions">
        <button class="btn btn-primary btn-sm" onclick="saveAndRegenerateAudio(${idx})">⟳ ${esc(t('shot.saveRegenerateAudio'))}</button>
        <button class="btn btn-ghost btn-sm" onclick="openNarrationAiHelp(${idx})">✦ ${esc(t('shot.askAi'))}</button>
      </div>
    </div>
    ${
      isIdle
        ? `<div class="shot-generate-all">
             <button class="btn btn-create btn-sm" onclick="generateNewShot(${idx})">▶ ${esc(t('shot.generateBoth'))}</button>
           </div>`
        : ''
    }
  `;
}

// ─── Targeted DOM updates ───
function setCardStatus(idx) {
  const shot = state.shots[idx];
  const el = document.getElementById(`status-${idx}`);
  if (!el) return;
  let status;
  let label;
  if (shot.imageStatus === 'idle' && shot.audioStatus === 'idle') {
    status = 'idle';
    label = t('shot.statusNew');
  } else if (shot.imageStatus === 'generating' || shot.audioStatus === 'generating') {
    status = 'generating';
    label = t('shot.statusGenerating');
  } else if (shot.imageStatus === 'error' || shot.audioStatus === 'error') {
    status = 'error';
    label = t('shot.statusError');
  } else if (shot.imageLoaded && shot.audioLoaded) {
    status = 'done';
    label = t('shot.statusReady');
  } else if (shot.imageStatus === 'done' || shot.audioStatus === 'done') {
    status = 'generating';
    label = t('shot.statusLoading');
  } else {
    status = 'pending';
    label = t('shot.statusPending');
  }
  el.className = `shot-status shot-status-${status}`;
  el.innerHTML = `<span class="shot-status-dot"></span> ${esc(label)}`;
}

function setImageGenerating(idx) {
  const ph = document.getElementById(`img-ph-${idx}`);
  const wrap = document.getElementById(`img-wrap-${idx}`);
  const ov = document.getElementById(`img-overlay-${idx}`);
  if (ov) ov.style.display = 'none';
  const old = wrap?.querySelector('img');
  if (old) old.remove();
  if (ph) {
    ph.style.display = '';
    ph.innerHTML = `<div class="spinner" style="width:28px;height:28px;border-width:2px;"></div> ${esc(t('shot.generatingImage'))}`;
  }
}

function setImageDone(idx, url) {
  const wrap = document.getElementById(`img-wrap-${idx}`);
  const ph = document.getElementById(`img-ph-${idx}`);
  const ov = document.getElementById(`img-overlay-${idx}`);
  if (!wrap) return;
  const img = new Image();
  img.alt = state.shots[idx].title || '';
  img.onload = () => {
    if (ph) ph.style.display = 'none';
    const existing = wrap.querySelector('img');
    if (existing) existing.remove();
    wrap.prepend(img);
    if (ov) ov.style.display = '';
    state.shots[idx].imageLoaded = true;
    setCardStatus(idx);
    updateGenProgress();
  };
  img.onerror = () => {
    state.shots[idx].imageStatus = 'error';
    state.shots[idx].imageLoaded = false;
    if (ph) {
      ph.style.display = '';
      ph.innerHTML = `<span class="text-error">${esc(t('shot.imageLoadFailed'))}</span>`;
    }
    setCardStatus(idx);
    updateGenProgress();
  };
  img.src = url;
}

function setImageError(idx) {
  const ph = document.getElementById(`img-ph-${idx}`);
  if (ph) {
    ph.style.display = '';
    ph.innerHTML = `<span class="text-error">${esc(t('shot.generationFailed'))}</span>`;
  }
}

function showFallbackNotice(idx, modelUsed) {
  const names = {
    gemini: t('model.badgeAdvanced'),
    nova: t('model.badgeStandard'),
    sd35: t('model.badgeExperimental'),
    'sdxl-ip-adapter': t('model.badgeExperimental'),
  };
  const wrap = document.getElementById(`img-wrap-${idx}`);
  if (!wrap) return;
  const notice = document.createElement('div');
  notice.className = 'media-warn';
  notice.textContent = `⚠ ${t('model.fallbackNotice', {
    selected: names[state.selectedImageModel] || state.selectedImageModel,
    used: names[modelUsed] || modelUsed,
  })}`;
  wrap.appendChild(notice);
}

function setAudioGenerating(idx) {
  const c = document.getElementById(`audio-content-${idx}`);
  if (c) {
    c.innerHTML = `<div class="spinner" style="width:18px;height:18px;border-width:2px;flex-shrink:0;"></div><span class="narration-preview">${esc(t('shot.generatingAudio'))}</span>`;
  }
}

function setAudioDone(idx, url) {
  const c = document.getElementById(`audio-content-${idx}`);
  if (!c) return;
  const audio = new Audio();
  audio.preload = 'metadata';
  audio.controls = true;
  audio.onloadedmetadata = () => {
    state.shots[idx].audioLoaded = true;
    setCardStatus(idx);
    updateGenProgress();
  };
  audio.onerror = () => {
    state.shots[idx].audioStatus = 'error';
    state.shots[idx].audioLoaded = false;
    c.innerHTML = `<span class="audio-error">${esc(t('shot.audioLoadFailed'))}</span>`;
    setCardStatus(idx);
    updateGenProgress();
  };
  audio.src = url;
  c.innerHTML = '';
  c.appendChild(audio);
}

function setAudioError(idx) {
  const c = document.getElementById(`audio-content-${idx}`);
  if (c) c.innerHTML = `<span class="audio-error">${esc(t('shot.audioGenerationFailed'))}</span>`;
}

// ─── Generation Progress ───
function updateGenProgress() {
  // Count only the assets each shot actually needs:
  //   image shots            -> 1 image + 1 audio
  //   video shots, native    -> just the video
  //   video shots, voiced    -> video + 1 audio
  //   untouched new shots    -> not counted until generation starts
  let total = 0;
  let done = 0;
  state.shots.forEach((s) => {
    if (s.imageStatus === 'idle' && s.audioStatus === 'idle') return;
    if (s.is_video) {
      total += 1;
      if (s.video_url) done += 1;
      if (s.audio_mode && s.audio_mode !== 'native') {
        total += 1;
        if (s.audioLoaded) done += 1;
      }
    } else {
      total += 2;
      if (s.imageLoaded) done += 1;
      if (s.audioLoaded) done += 1;
    }
  });

  const pct = total > 0 ? Math.round((done / total) * 100) : 100;
  let el = document.getElementById('gen-progress');
  if (!el) {
    el = document.createElement('div');
    el.id = 'gen-progress';
    el.className = 'gen-progress';
    const header = document.querySelector('.storyboard-header');
    if (!header) return;
    header.insertBefore(el, header.querySelector('.storyboard-actions'));
  }

  if (total === 0 || done >= total) {
    el.innerHTML = `<span class="gen-progress-ready">✓ ${esc(
      t('storyboard.allShotsReady', { count: state.shots.length })
    )}</span>`;
    setStatus('done', t('status.allAssetsReady'));
  } else {
    el.innerHTML = `<div class="gen-progress-bar"><div class="gen-progress-fill" style="width:${pct}%"></div></div><span>${esc(
      t('storyboard.assetsLoaded', { done, total })
    )}</span>`;
  }
}

// ─── Generation ───
async function generateAllAssets() {
  setStatus('busy', t('status.generatingAssets'));
  // Two at a time: enough to hide latency without tripping Bedrock throttling.
  for (let b = 0; b < state.shots.length; b += 2) {
    const tasks = [];
    for (let i = b; i < Math.min(b + 2, state.shots.length); i += 1) tasks.push(generateShotAssets(i));
    await Promise.all(tasks);
  }
  syncStoryboard();
}

async function generateShotAssets(i) {
  const shot = state.shots[i];
  const tasks = [];

  if (!shot.image_url) {
    shot.imageStatus = 'generating';
    setCardStatus(i);
    setImageGenerating(i);
    updateGenProgress();
    tasks.push(
      postJson('/generate-image', {
        shot_index: i,
        prompt: shot.image_prompt,
        image_model: state.selectedImageModel,
        run_id: state.runId,
        language: state.language,
        characters_in_shot: shot.characters_in_shot || [],
      })
        .then((r) => r.json())
        .then((d) => {
          if (d.image_url) {
            shot.image_url = d.image_url;
            shot.image_key = d.image_key || '';
            shot.imageStatus = 'done';
            shot.modelUsed = d.model_used || state.selectedImageModel;
            setImageDone(i, d.image_url);
            if (d.model_used && d.model_used !== state.selectedImageModel) {
              showFallbackNotice(i, d.model_used);
            }
          } else {
            shot.imageStatus = 'error';
            setImageError(i);
          }
          setCardStatus(i);
        })
        .catch(() => {
          shot.imageStatus = 'error';
          setImageError(i);
          setCardStatus(i);
        })
    );
  }

  if (!shot.audio_url) {
    shot.audioStatus = 'generating';
    setCardStatus(i);
    setAudioGenerating(i);
    updateGenProgress();
    tasks.push(
      requestAudio({
        shot_index: i,
        text: shot.narration,
        voice_id: state.selectedVoice,
        run_id: state.runId,
      })
        .then((d) => {
          if (d.audio_url) {
            shot.audio_url = d.audio_url;
            shot.audio_key = d.audio_key || '';
            shot.audioStatus = 'done';
            setAudioDone(i, d.audio_url);
          } else {
            shot.audioStatus = 'error';
            setAudioError(i);
          }
          setCardStatus(i);
        })
        .catch(() => {
          shot.audioStatus = 'error';
          setAudioError(i);
          setCardStatus(i);
        })
    );
  }

  await Promise.all(tasks);
}

async function generateNewShot(idx) {
  const shot = state.shots[idx];
  const promptEl = document.getElementById(`prompt-${idx}`);
  const narrationEl = document.getElementById(`narration-${idx}`);
  if (promptEl) shot.image_prompt = promptEl.value.trim();
  if (narrationEl) shot.narration = narrationEl.value.trim();

  if (!shot.image_prompt && !shot.narration) {
    alert(t('shot.needPromptOrNarration'));
    return;
  }

  const genBtn = document.querySelector(`#shot-card-${idx} .shot-generate-all`);
  if (genBtn) genBtn.remove();

  shot.imageStatus = 'pending';
  shot.audioStatus = 'pending';
  await generateShotAssets(idx);
  syncStoryboard();
}

// ─── Delete Shot ───
function deleteShot(idx) {
  if (state.shots.length <= 1) {
    alert(t('shot.cannotDeleteLast'));
    return;
  }
  const shot = state.shots[idx];
  const title = shot.title || t('shot.label', { number: idx + 1 });
  if (!confirm(t('shot.confirmDelete', { title }))) return;

  state.shots.splice(idx, 1);
  state.shots.forEach((s, i) => {
    s.shot = i + 1;
  });
  renderStoryboard();
  syncStoryboard();
  setStatus('done', t('shot.deleted', { title }));
}

// ─── Sync Storyboard to Backend ───
/**
 * Persist the on-screen storyboard.
 *
 * @param {{createRevision?: boolean, note?: string}} [opts] Pass createRevision to
 *   snapshot a numbered revision (an explicit user Save rather than a background sync).
 * @returns {Promise<{ok: boolean, revision?: number, error?: string}>} Result.
 */
async function syncStoryboard(opts = {}) {
  if (!state.runId) return { ok: false };
  try {
    // Pull the latest textarea values; the user may have typed without blurring.
    state.shots.forEach((shot, idx) => {
      const promptEl = document.getElementById(`prompt-${idx}`);
      const narrationEl = document.getElementById(`narration-${idx}`);
      if (promptEl) shot.image_prompt = promptEl.value.trim();
      if (narrationEl) shot.narration = narrationEl.value.trim();
    });

    const shotsPayload = state.shots.map((shot, i) => ({
      index: i,
      title: shot.title,
      image_prompt: shot.image_prompt,
      narration: shot.narration,
      characters_in_shot: shot.characters_in_shot || [],
      image_key: shot.image_key || '',
      audio_key: shot.audio_key || '',
      video_key: shot.video_key || '',
      is_video: !!shot.is_video,
      audio_mode: shot.audio_mode || '',
    }));

    const res = await postJson(`/runs/${state.runId}/sync-storyboard`, {
      shots: shotsPayload,
      create_revision: !!opts.createRevision,
      note: opts.note || '',
      project_name: state.projectName || '',
      project_description: state.projectDescription || '',
      image_model: state.selectedImageModel || '',
      language: state.language,
      characters: state.characters || {},
      art_direction: state.artDirection || '',
      music_file: state.selectedMusic || '',
      wallpaper_file: state.selectedWallpaper || '',
      music_volume: state.musicVolume,
      selected_voice: state.selectedVoice || '',
      settings: state.settings || {},
    });
    if (!res.ok) return { ok: false };
    const data = await res.json().catch(() => ({}));
    return { ok: true, ...data };
  } catch (err) {
    console.warn('Storyboard sync failed:', err);
    return { ok: false, error: err.message };
  }
}

// ─── Save Storyboard (explicit user action — creates a revision) ───
$('#save-storyboard-btn').addEventListener('click', async () => {
  const btn = $('#save-storyboard-btn');
  if (!state.runId) {
    alert(t('storyboard.nothingToSave'));
    return;
  }
  const original = btn.innerHTML;
  btn.disabled = true;

  const totalShots = state.shots.length;
  showProgress(t('progress.savingStoryboard'), t('progress.savingDetail', { count: totalShots }), 15);
  btn.innerHTML = `⏳ ${esc(t('storyboard.saving'))}`;

  // The request has no progress events, so the bar is advanced on a timer to show
  // the app is still working.
  let pct = 15;
  const ticker = setInterval(() => {
    pct = Math.min(pct + 7, 85);
    updateProgress(t('progress.writingRevision'), pct);
  }, 250);

  const result = await syncStoryboard({ createRevision: true });
  clearInterval(ticker);

  if (result.ok) {
    const rev = result.revision != null ? result.revision : '?';
    updateProgress(t('progress.savedAsRevision', { revision: rev }), 100);
    state.currentRevision = result.revision;
    updateProjectNameDisplay();
    setTimeout(() => {
      hideProgress();
      btn.innerHTML = `✓ ${esc(t('storyboard.saved', { revision: rev }))}`;
      setStatus('done', t('progress.savedAsRevision', { revision: rev }));
      setTimeout(() => {
        btn.innerHTML = original;
        btn.disabled = false;
      }, 2000);
    }, 500);
  } else {
    hideProgress();
    btn.innerHTML = `✗ ${esc(t('status.saveFailed'))}`;
    setStatus('error', t('status.saveFailed'));
    alert(result.error ? t('common.error', { error: result.error }) : t('status.saveFailed'));
    setTimeout(() => {
      btn.innerHTML = original;
      btn.disabled = false;
    }, 2500);
  }
});

// ─── Revisions history ───
$('#revisions-modal-close').addEventListener('click', () => {
  document.getElementById('revisions-modal').hidden = true;
});

$('#revisions-btn').addEventListener('click', async () => {
  if (!state.runId) {
    alert(t('revisions.noProject'));
    return;
  }
  const modal = document.getElementById('revisions-modal');
  const list = document.getElementById('revisions-list');
  modal.hidden = false;
  list.innerHTML = `<p class="text-dim">${esc(t('revisions.loading'))}</p>`;
  try {
    const data = await (await fetch(`${API}/runs/${state.runId}/revisions`)).json();
    const revs = data.revisions || [];
    if (!revs.length) {
      list.innerHTML = `<p class="text-dim">${esc(t('revisions.none'))}</p>`;
      return;
    }
    const current = data.current_revision;
    list.innerHTML = revs
      .map((r) => {
        const when = formatDateTime(r.saved_at);
        const isCurrent = r.revision === current;
        return `<div class="char-card" style="display:flex;align-items:center;gap:.75rem;margin-bottom:.5rem;">
        <div style="flex:1;">
          <div style="font-weight:600;font-size:.85rem;">${esc(t('revisions.item', { revision: r.revision }))}${
            isCurrent ? ` <span class="gen-progress-ready">${esc(t('revisions.current'))}</span>` : ''
          }</div>
          <div class="text-dim" style="font-size:.72rem;">${esc(when)} · ${esc(
            t('revisions.shotCount', { count: r.shot_count })
          )}${r.note ? ` · ${esc(r.note)}` : ''}</div>
        </div>
        ${
          isCurrent
            ? ''
            : `<button class="btn btn-ghost btn-sm" onclick="restoreRevision(${r.revision})">↺ ${esc(
                t('revisions.restore')
              )}</button>`
        }
      </div>`;
      })
      .join('');
  } catch (err) {
    list.innerHTML = `<p class="text-error">${esc(t('revisions.loadFailed', { error: err.message }))}</p>`;
  }
});

/** Format an ISO timestamp in the interface locale. */
function formatDateTime(value) {
  try {
    return new Date(value).toLocaleString(getLocaleTag(), {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return String(value || '');
  }
}

async function restoreRevision(revisionNumber) {
  if (!confirm(t('revisions.confirmRestore', { revision: revisionNumber }))) return;
  document.getElementById('revisions-modal').hidden = true;
  showProgress(t('progress.restoringRevision'), t('progress.loadingRevision', { revision: revisionNumber }), 30);
  try {
    const res = await postJson(`/runs/${state.runId}/restore-revision`, { revision: revisionNumber });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || t('status.restoreFailed'));
    }
    updateProgress(t('progress.reloadingStoryboard'), 70);
    await jumpToStoryboard(state.runId, { textContent: '', disabled: false });
    hideProgress();
    setStatus('done', t('revisions.restored', { revision: revisionNumber }));
  } catch (err) {
    hideProgress();
    setStatus('error', t('status.restoreFailed'));
    alert(t('common.error', { error: err.message }));
  }
}

// ─── Storyboard voice selector ───
$('#storyboard-voice-select').addEventListener('change', (e) => {
  state.selectedVoice = e.target.value;
  const label = e.target.options[e.target.selectedIndex].text.replace(/^🎙️\s*/, '');
  setStatus('done', t('voice.setTo', { name: label }));
});

// ─── Project name display / rename / Save As ───
function updateProjectNameDisplay() {
  const input = document.getElementById('project-name-input');
  if (input) input.value = state.projectName || '';
  const revBadge = document.getElementById('project-rev-badge');
  if (revBadge) {
    if (state.currentRevision && state.currentRevision > 0) {
      revBadge.hidden = false;
      revBadge.textContent = `v${state.currentRevision}`;
    } else {
      revBadge.hidden = true;
    }
  }
  renderProjectLanguageBadge();
}

async function commitProjectRename() {
  const input = document.getElementById('project-name-input');
  if (!input) return;
  const trimmed = input.value.trim();
  const current = state.projectName || '';
  if (!trimmed) {
    input.value = current;
    return;
  }
  if (trimmed === current) return;
  if (!state.runId) {
    state.projectName = trimmed;
    return;
  }
  setStatus('busy', t('status.renaming'));
  try {
    const res = await postJson(`/runs/${state.runId}/rename`, { project_name: trimmed });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || t('status.renameFailed'));
    }
    state.projectName = trimmed;
    setStatus('done', t('status.projectRenamed'));
  } catch (err) {
    input.value = current;
    setStatus('error', t('status.renameFailed'));
    alert(t('common.error', { error: err.message }));
  }
}

(function initProjectNameInput() {
  const input = document.getElementById('project-name-input');
  if (!input) return;
  input.addEventListener('blur', commitProjectRename);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      input.blur();
    }
    if (e.key === 'Escape') {
      input.value = state.projectName || '';
      input.blur();
    }
  });
})();

$('#save-as-btn').addEventListener('click', async () => {
  if (!state.runId) {
    alert(t('saveAs.needProject'));
    return;
  }
  const suggested = `${state.projectName || t('project.untitled')} ${t('saveAs.copySuffix')}`;
  const newName = prompt(t('saveAs.prompt'), suggested);
  if (newName === null) return;
  const trimmed = newName.trim() || suggested;

  showProgress(t('progress.savingAsNew'), t('progress.copyingAssets'), 20);
  let pct = 20;
  const ticker = setInterval(() => {
    pct = Math.min(pct + 6, 85);
    updateProgress(t('progress.copyingProgress'), pct);
  }, 300);
  try {
    await syncStoryboard();
    const res = await postJson(`/runs/${state.runId}/save-as`, { project_name: trimmed });
    clearInterval(ticker);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || t('status.saveAsFailed'));
    }
    const data = await res.json();
    updateProgress(t('progress.openingNew'), 95);
    await jumpToStoryboard(data.run_id, { textContent: '', disabled: false });
    hideProgress();
    setStatus('done', t('saveAs.saved', { name: data.project_name }));
  } catch (err) {
    clearInterval(ticker);
    hideProgress();
    setStatus('error', t('status.saveAsFailed'));
    alert(t('common.error', { error: err.message }));
  }
});

// ─── Regenerate Image ───
async function regenerateImage(idx) {
  const s = state.shots[idx];
  s.imageStatus = 'generating';
  s.image_url = null;
  s.imageLoaded = false;
  setCardStatus(idx);
  setImageGenerating(idx);
  updateGenProgress();
  setStatus('busy', t('shot.regenerating', { number: s.shot }));
  try {
    const d = await (
      await postJson('/generate-image', {
        shot_index: idx,
        prompt: s.image_prompt,
        regenerate: true,
        image_model: state.selectedImageModel,
        run_id: state.runId,
        language: state.language,
        characters_in_shot: s.characters_in_shot || [],
      })
    ).json();
    if (d.image_url) {
      s.image_url = d.image_url;
      s.image_key = d.image_key || s.image_key || '';
      s.imageStatus = 'done';
      setImageDone(idx, s.image_url);
      syncStoryboard();
    } else {
      s.imageStatus = 'error';
      setImageError(idx);
    }
  } catch {
    s.imageStatus = 'error';
    setImageError(idx);
  }
  setCardStatus(idx);
}

function saveAndRegenerateImage(idx) {
  const e = document.getElementById(`prompt-${idx}`);
  if (e) state.shots[idx].image_prompt = e.value.trim();
  regenerateImage(idx);
}

// ─── Audio request helper (handles sync + async chunked long narration) ───
/**
 * Request narration audio, transparently handling the async job path.
 *
 * Short narration is synthesized within the request. Anything longer exceeds API
 * Gateway's 29-second limit, so the backend returns a job id to poll.
 *
 * @param {{shot_index: number, text: string, voice_id: string, run_id: string,
 *   onProgress?: (seconds: number) => void}} args Request arguments.
 * @returns {Promise<{audio_url: string, audio_key?: string}>} The generated audio.
 */
async function requestAudio({ shot_index, text, voice_id, run_id, onProgress }) {
  const res = await postJson('/generate-audio', {
    shot_index,
    text,
    voice_id,
    run_id,
    language: state.language,
  });
  const data = await res.json();
  if (data.audio_url) return data;
  if (!data.async || !data.job_id) throw new Error(data.detail || t('shot.audioGenerationFailed'));

  const jobId = data.job_id;
  const maxPoll = 600000; // 10 minutes
  let elapsed = 0;
  while (elapsed < maxPoll) {
    await new Promise((r) => setTimeout(r, 3000));
    elapsed += 3000;
    const pollRes = await postJson('/audio-status', { job_id: jobId });
    const pd = await pollRes.json();
    if (pd.status === 'complete' && pd.audio_url) return pd;
    if (pd.status === 'error') throw new Error(pd.detail || t('shot.audioGenerationFailed'));
    if (onProgress) onProgress(Math.round(elapsed / 1000));
  }
  throw new Error(t('shot.audioGenerationFailed'));
}

// ─── Regenerate Audio ───
async function regenerateAudio(idx) {
  const s = state.shots[idx];
  s.audioStatus = 'generating';
  s.audio_url = null;
  s.audioLoaded = false;
  setCardStatus(idx);
  setAudioGenerating(idx);
  updateGenProgress();
  setStatus('busy', t('shot.regeneratingAudio', { number: s.shot }));
  try {
    const d = await requestAudio({
      shot_index: idx,
      text: s.narration,
      voice_id: state.selectedVoice,
      run_id: state.runId,
    });
    if (d.audio_url) {
      s.audio_url = d.audio_url;
      s.audio_key = d.audio_key || s.audio_key || '';
      s.audioStatus = 'done';
      setAudioDone(idx, s.audio_url);
      syncStoryboard();
    } else {
      s.audioStatus = 'error';
      setAudioError(idx);
    }
  } catch {
    s.audioStatus = 'error';
    setAudioError(idx);
  }
  setCardStatus(idx);
}

function saveAndRegenerateAudio(idx) {
  const e = document.getElementById(`narration-${idx}`);
  if (e) state.shots[idx].narration = e.value.trim();
  regenerateAudio(idx);
}

// ─── AI Help Modal (Image Prompt) ───
let aiHelpShotIdx = null;

function openAiHelp(idx) {
  aiHelpShotIdx = idx;
  const s = state.shots[idx];
  $('#modal-shot-num').textContent = t('shot.label', { number: s.shot });
  $('#modal-shot-title').textContent = s.title;
  $('#modal-current-prompt').textContent = s.image_prompt;
  $('#ai-guidance').value = '';
  aiModal.hidden = false;
}

$('#modal-close').addEventListener('click', () => { aiModal.hidden = true; });
$('#modal-cancel').addEventListener('click', () => { aiModal.hidden = true; });
aiModal.addEventListener('click', (e) => { if (e.target === aiModal) aiModal.hidden = true; });

$('#modal-submit').addEventListener('click', async () => {
  const guidance = $('#ai-guidance').value.trim();
  if (!guidance || aiHelpShotIdx === null) return;
  const idx = aiHelpShotIdx;
  aiModal.hidden = true;
  setStatus('busy', t('ai.updatingPrompt'));

  const promptEditor = document.getElementById(`prompt-${idx}`);
  const promptSection = promptEditor?.closest('.shot-prompt-section');
  let overlay;
  if (promptSection) {
    overlay = document.createElement('div');
    overlay.className = 'editor-loading-overlay';
    overlay.innerHTML = `<div class="spinner" style="width:20px;height:20px;border-width:2px;"></div><span>${esc(
      t('ai.generatingPrompt')
    )}</span>`;
    promptSection.style.position = 'relative';
    promptSection.appendChild(overlay);
  }

  try {
    const d = await (
      await postJson('/ai-help', {
        shot_index: idx,
        current_prompt: state.shots[idx].image_prompt,
        guidance,
        image_model: state.selectedImageModel,
        // Sent so the backend knows the user's guidance may be French while the
        // returned prompt must stay English.
        language: state.language,
        run_id: state.runId,
        style_override: STYLE_PRESETS[state.selectedStyle] || '',
      })
    ).json();
    state.shots[idx].image_prompt = d.new_prompt;
    if (promptEditor) promptEditor.value = d.new_prompt;
    setStatus('done', t('status.promptUpdated'));
  } catch {
    setStatus('error', t('status.aiHelpFailed'));
  } finally {
    if (overlay) overlay.remove();
  }
});

// ─── AI Help Modal (Narration) ───
let narrationAiShotIdx = null;

function openNarrationAiHelp(idx) {
  narrationAiShotIdx = idx;
  const s = state.shots[idx];
  $('#narration-modal-shot-num').textContent = t('shot.label', { number: s.shot });
  $('#narration-modal-shot-title').textContent = s.title;
  $('#narration-modal-current').textContent = s.narration;
  $('#narration-ai-guidance').value = '';
  narrationAiModal.hidden = false;
}

$('#narration-modal-close').addEventListener('click', () => { narrationAiModal.hidden = true; });
$('#narration-modal-cancel').addEventListener('click', () => { narrationAiModal.hidden = true; });
narrationAiModal.addEventListener('click', (e) => {
  if (e.target === narrationAiModal) narrationAiModal.hidden = true;
});

$('#narration-modal-submit').addEventListener('click', async () => {
  const guidance = $('#narration-ai-guidance').value.trim();
  if (!guidance || narrationAiShotIdx === null) return;
  const idx = narrationAiShotIdx;
  narrationAiModal.hidden = true;
  setStatus('busy', t('ai.updatingNarration'));

  const narrEditor = document.getElementById(`narration-${idx}`);
  const narrSection = narrEditor?.closest('.shot-narration-section');
  let overlay;
  if (narrSection) {
    overlay = document.createElement('div');
    overlay.className = 'editor-loading-overlay';
    overlay.innerHTML = `<div class="spinner" style="width:20px;height:20px;border-width:2px;"></div><span>${esc(
      t('ai.generatingNarration')
    )}</span>`;
    narrSection.style.position = 'relative';
    narrSection.appendChild(overlay);
  }

  try {
    const d = await (
      await postJson('/ai-help-narration', {
        shot_index: idx,
        current_narration: state.shots[idx].narration,
        guidance,
        narrative_style: state.narrativeStyle,
        // Narration is spoken to the audience, so it must come back in the project
        // language rather than English.
        language: state.language,
        run_id: state.runId,
      })
    ).json();
    state.shots[idx].narration = d.new_narration;
    if (narrEditor) narrEditor.value = d.new_narration;
    setStatus('done', t('status.narrationUpdated'));
  } catch {
    setStatus('error', t('status.aiHelpFailed'));
  } finally {
    if (overlay) overlay.remove();
  }
});

// ─── Regenerate all ───
$('#regenerate-all-btn').addEventListener('click', () => {
  state.shots.forEach((s) => {
    s.image_url = null;
    s.audio_url = null;
    s.imageStatus = 'pending';
    s.audioStatus = 'pending';
    s.imageLoaded = false;
    s.audioLoaded = false;
  });
  renderStoryboard();
  generateAllAssets();
});

// ═══════════════════════════════════════════
// CHARACTER REVIEW
// ═══════════════════════════════════════════

/**
 * Build the shared markup for a character review or edit panel.
 *
 * @param {Record<string,string>} characters Name to description mapping.
 * @param {{titleKey: string, helpKey: string, actions: string}} opts Panel config.
 * @returns {string} Panel HTML.
 */
function buildCharacterPanel(characters, opts) {
  const charHtml = Object.entries(characters)
    .map(
      ([name, desc]) => `
      <div class="char-card">
        <div class="char-card-head">
          <span class="char-card-name">🧑 ${esc(name)}</span>
          <button class="btn btn-ghost btn-sm char-ai-edit-btn" data-name="${esc(name)}"
                  style="font-size:.72rem;margin-left:auto;">✦ ${esc(t('characters.askAiToEdit'))}</button>
        </div>
        <textarea class="char-desc-input" data-name="${esc(name)}" rows="3">${esc(desc)}</textarea>
      </div>`
    )
    .join('');

  return `
    <div class="fullscreen-panel-inner">
      <div style="margin-bottom:1.5rem;">
        <h2>🎭 ${esc(t(opts.titleKey))}</h2>
        <p class="help">${esc(t(opts.helpKey))}</p>
      </div>
      <div style="margin-bottom:1.5rem;">
        <h3>${esc(t('characters.referenceSheet'))}</h3>
        <div id="char-sheet-preview" class="char-sheet-preview"><div class="spinner" style="width:24px;height:24px;"></div></div>
        <button class="btn btn-ghost btn-sm" id="char-regen-sheet-btn" style="margin-top:.5rem;">⟳ ${esc(
          t('characters.regenerateSheet')
        )}</button>
      </div>
      <div style="margin-bottom:1.5rem;">
        <h3>${esc(t('characters.descriptions'))}</h3>
        ${charHtml}
      </div>
      <div class="char-actions">${opts.actions}</div>
    </div>

    <div id="char-ai-dialog" class="nested-dialog" style="display:none;">
      <div class="nested-dialog-card">
        <h3 id="char-ai-dialog-title">✦ ${esc(t('characters.aiEditTitle'))}</h3>
        <p>${esc(t('characters.aiEditPrompt'))}</p>
        <textarea id="char-ai-dialog-input" rows="3" placeholder="${esc(t('characters.aiEditPlaceholder'))}"></textarea>
        <div class="nested-dialog-actions">
          <button class="btn btn-ghost btn-sm" id="char-ai-dialog-cancel">${esc(t('ai.cancel'))}</button>
          <button class="btn btn-primary btn-sm" id="char-ai-dialog-submit">✦ ${esc(t('ai.updateWithAi'))}</button>
        </div>
      </div>
    </div>

    <div id="char-loading-overlay" class="blocking-overlay" style="display:none;">
      <div class="blocking-overlay-inner">
        <div class="spinner" style="width:32px;height:32px;margin:0 auto 1rem;"></div>
        <p id="char-loading-text" style="font-size:.85rem;">${esc(t('characters.updating'))}</p>
      </div>
    </div>
  `;
}

/**
 * Wire the behaviour shared by both character panels.
 *
 * @param {HTMLElement} overlay The panel root.
 * @param {string} runId Run whose character sheet is being edited.
 * @param {string} sheetSource Endpoint to read the current sheet URL from.
 */
function wireCharacterPanel(overlay, runId, sheetSource) {
  const aiDialog = overlay.querySelector('#char-ai-dialog');
  const loadingOverlay = overlay.querySelector('#char-loading-overlay');
  const sheetPreview = overlay.querySelector('#char-sheet-preview');

  const showLoading = (text) => {
    loadingOverlay.querySelector('#char-loading-text').textContent = text;
    loadingOverlay.style.display = 'flex';
  };
  const hideLoading = () => { loadingOverlay.style.display = 'none'; };

  const readDescriptions = () => {
    const updated = {};
    overlay.querySelectorAll('.char-desc-input').forEach((ta) => {
      updated[ta.dataset.name] = ta.value.trim();
    });
    return updated;
  };

  const showSheet = (url) => {
    const img = new Image();
    img.onclick = () => window.open(img.src, '_blank');
    img.onload = () => {
      sheetPreview.innerHTML = '';
      sheetPreview.appendChild(img);
    };
    img.onerror = () => {
      sheetPreview.innerHTML = `<p class="text-dim" style="font-size:.8rem;padding:1rem;">${esc(
        t('characters.sheetUnavailable')
      )}</p>`;
    };
    img.src = url;
  };

  // Load the existing sheet.
  (async () => {
    try {
      const data = await (await fetch(`${API}${sheetSource}`)).json();
      if (data.character_sheet_url) {
        showSheet(data.character_sheet_url);
      } else {
        sheetPreview.innerHTML = `<p class="text-dim" style="font-size:.8rem;padding:1rem;">${esc(
          t('characters.sheetUnavailable')
        )}</p>`;
      }
    } catch {
      sheetPreview.innerHTML = `<p class="text-dim" style="font-size:.8rem;padding:1rem;">${esc(
        t('characters.couldNotLoad')
      )}</p>`;
    }
  })();

  // Regenerate the sheet from the current descriptions.
  overlay.querySelector('#char-regen-sheet-btn').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const original = btn.innerHTML;
    btn.innerHTML = `⏳ ${esc(t('characters.regenerating'))}`;
    btn.disabled = true;
    sheetPreview.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;padding:2rem;gap:.75rem;"><div class="spinner" style="width:24px;height:24px;"></div><span class="text-dim" style="font-size:.8rem;">${esc(
      t('characters.regeneratingWith')
    )}</span></div>`;
    try {
      const data = await (
        await postJson('/regenerate-character-sheet', {
          run_id: runId,
          characters: readDescriptions(),
          style_hint: state.artDirection || 'clean illustration',
          // The backend translates French descriptions before prompting the image
          // model, so it needs to know the project language.
          language: state.language,
        })
      ).json();
      if (data.image_url) {
        showSheet(data.image_url);
      } else {
        sheetPreview.innerHTML = `<p class="text-error" style="padding:1rem;font-size:.8rem;">${esc(
          t('characters.regenerationFailed')
        )}</p>`;
      }
    } catch {
      sheetPreview.innerHTML = `<p class="text-error" style="padding:1rem;font-size:.8rem;">${esc(
        t('characters.regenerationFailed')
      )}</p>`;
    }
    btn.innerHTML = original;
    btn.disabled = false;
  });

  // AI-assisted description editing.
  let activeTextarea = null;
  const allTextareas = overlay.querySelectorAll('.char-desc-input');
  overlay.querySelectorAll('.char-ai-edit-btn').forEach((btn, idx) => {
    btn.addEventListener('click', () => {
      activeTextarea = allTextareas[idx];
      overlay.querySelector('#char-ai-dialog-title').textContent = `✦ ${t('characters.aiEditOne', {
        name: btn.dataset.name,
      })}`;
      overlay.querySelector('#char-ai-dialog-input').value = '';
      aiDialog.style.display = 'flex';
      overlay.querySelector('#char-ai-dialog-input').focus();
    });
  });

  overlay.querySelector('#char-ai-dialog-cancel').addEventListener('click', () => {
    aiDialog.style.display = 'none';
    activeTextarea = null;
  });

  overlay.querySelector('#char-ai-dialog-submit').addEventListener('click', async () => {
    const guidance = overlay.querySelector('#char-ai-dialog-input').value.trim();
    if (!guidance || !activeTextarea) return;
    aiDialog.style.display = 'none';
    showLoading(t('characters.updating'));
    try {
      // Character descriptions are user-facing, so they stay in the project language.
      const languageClause =
        state.language === 'fr'
          ? ' Réponds en français.'
          : '';
      const data = await (
        await postJson('/ai-help-narration', {
          current_narration: activeTextarea.value,
          guidance:
            `Modify this character description: ${guidance}. Keep it as ONE DENSE LINE with all ` +
            `visual details (hair, eyes, skin, age, build, clothing, unique features). ` +
            `Return ONLY the updated description, nothing else.${languageClause}`,
          narrative_style: '',
          language: state.language,
          run_id: state.runId,
        })
      ).json();
      if (data.new_narration) activeTextarea.value = data.new_narration;
    } catch (err) {
      console.error('Character AI edit failed:', err);
    }
    hideLoading();
    activeTextarea = null;
  });

  return { readDescriptions, showLoading, hideLoading };
}

function closeCharacterPanel(overlay) {
  if (overlay.parentNode) document.body.removeChild(overlay);
  document.body.style.overflow = '';
}

/**
 * Character review shown mid-generation, before shots exist.
 *
 * Approving here resumes the paused backend job.
 */
function showCharacterReview(jobId, characters) {
  document.body.style.overflow = 'hidden';
  const overlay = document.createElement('div');
  overlay.id = 'character-review-overlay';
  overlay.className = 'fullscreen-panel';
  overlay.innerHTML = buildCharacterPanel(characters, {
    titleKey: 'characters.reviewTitle',
    helpKey: 'characters.reviewHelp',
    actions: `<button class="btn btn-create" id="char-approve-btn">✓ ${esc(t('characters.approve'))}</button>`,
  });
  document.body.appendChild(overlay);

  const { readDescriptions } = wireCharacterPanel(overlay, jobId, `/script-status/${jobId}`);

  overlay.querySelector('#char-approve-btn').addEventListener('click', async () => {
    const updated = readDescriptions();
    state.characters = updated;
    overlay.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;">
      <div style="text-align:center;color:var(--text);">
        <div class="spinner" style="width:40px;height:40px;margin:0 auto 1rem;"></div>
        <p style="font-size:.9rem;">${esc(t('characters.generatingShots'))}</p>
        <p class="text-dim" style="font-size:.8rem;margin-top:.5rem;">${esc(t('characters.mayTake'))}</p>
      </div>
    </div>`;
    try {
      await postJson(`/approve-characters/${jobId}`, { characters: updated });
      let attempts = 0;
      while (attempts < 180) {
        await new Promise((r) => setTimeout(r, 2000));
        attempts += 1;
        const statusData = await (await fetch(`${API}/script-status/${jobId}`)).json();
        if (statusData.status === 'complete') {
          state.shots = statusData.shots.map((s, i) => ({
            shot: i + 1,
            title: s.title,
            image_prompt: s.image_prompt,
            image_url: null,
            narration: s.narration,
            audio_url: null,
            characters_in_shot: s.characters_in_shot || [],
            imageStatus: 'pending',
            audioStatus: 'pending',
            imageLoaded: false,
            audioLoaded: false,
          }));
          if (statusData.characters) state.characters = statusData.characters;
          lockProjectLanguage(statusData.language);
          closeCharacterPanel(overlay);
          renderStoryboard();
          showStep(stepStoryboard);
          const editBtn = document.getElementById('edit-characters-btn');
          if (editBtn) editBtn.hidden = !state.characters || Object.keys(state.characters).length === 0;
          generateAllAssets();
          return;
        }
        if (statusData.status === 'error') throw new Error(statusData.detail || t('status.failed'));
      }
      throw new Error(t('progress.timedOut'));
    } catch (err) {
      setStatus('error', t('status.failed'));
      alert(t('common.error', { error: err.message }));
      closeCharacterPanel(overlay);
    }
  });
}

/** Character editor reached from the storyboard, after shots already exist. */
function showCharacterReviewFromStoryboard(runId, characters) {
  document.body.style.overflow = 'hidden';
  const overlay = document.createElement('div');
  overlay.id = 'character-review-overlay';
  overlay.className = 'fullscreen-panel';
  overlay.innerHTML = buildCharacterPanel(characters, {
    titleKey: 'characters.editTitle',
    helpKey: 'characters.editHelp',
    actions: `
      <button class="btn btn-ghost" id="char-back-btn">← ${esc(t('characters.returnToStoryboard'))}</button>
      <button class="btn btn-create" id="char-apply-regen-btn">✓ ${esc(t('characters.applyRegenerate'))}</button>`,
  });
  document.body.appendChild(overlay);

  const { readDescriptions } = wireCharacterPanel(overlay, runId, `/runs/${runId}/manifest`);

  overlay.querySelector('#char-back-btn').addEventListener('click', () => {
    state.characters = readDescriptions();
    closeCharacterPanel(overlay);
  });

  overlay.querySelector('#char-apply-regen-btn').addEventListener('click', () => {
    state.characters = readDescriptions();
    closeCharacterPanel(overlay);
    setStatus('busy', t('characters.regeneratingAll'));
    state.shots.forEach((s) => {
      s.image_url = null;
      s.imageStatus = 'pending';
      s.imageLoaded = false;
    });
    renderStoryboard();
    generateAllAssets();
  });
}

$('#edit-characters-btn').addEventListener('click', () => {
  const hasCharacters = state.characters && Object.keys(state.characters).length > 0;
  if (!hasCharacters && !state.runId) {
    alert(t('characters.noneAvailable'));
    return;
  }
  const characters = hasCharacters
    ? state.characters
    : { [t('characters.noDataKey')]: t('characters.noDataValue') };
  showCharacterReviewFromStoryboard(state.runId, characters);
});

// ─── Add Shot ───
$('#add-shot-btn').addEventListener('click', () => {
  const number = state.shots.length + 1;
  state.shots.push({
    shot: number,
    title: t('shot.newShot', { number }),
    image_prompt: '',
    image_url: null,
    narration: '',
    audio_url: null,
    characters_in_shot: [],
    imageStatus: 'idle',
    audioStatus: 'idle',
    imageLoaded: false,
    audioLoaded: false,
  });
  renderStoryboard();
});

// ─── Drag to Reorder ───
function enableDragReorder() {
  const grid = storyboardGrid;
  let draggedIdx = null;
  grid.addEventListener('dragstart', (e) => {
    const card = e.target.closest('.shot-card');
    if (!card) return;
    draggedIdx = [...grid.children].indexOf(card);
    card.style.opacity = '0.5';
    e.dataTransfer.effectAllowed = 'move';
  });
  grid.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  });
  grid.addEventListener('dragend', (e) => {
    const card = e.target.closest('.shot-card');
    if (card) card.style.opacity = '';
  });
  grid.addEventListener('drop', (e) => {
    e.preventDefault();
    const target = e.target.closest('.shot-card');
    if (!target || draggedIdx === null) return;
    const targetIdx = [...grid.children].indexOf(target);
    if (draggedIdx === targetIdx) return;
    const [moved] = state.shots.splice(draggedIdx, 1);
    state.shots.splice(targetIdx, 0, moved);
    state.shots.forEach((s, i) => { s.shot = i + 1; });
    renderStoryboard();
    syncStoryboard();
    draggedIdx = null;
  });
}

// ─── Local Image Upload for a Shot ───
function uploadLocalImageToShot(idx) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.style.display = 'none';
  input.addEventListener('change', async () => {
    const file = input.files[0];
    if (!file) {
      input.remove();
      return;
    }
    const shot = state.shots[idx];
    try {
      const res = await postJson('/upload-wallpaper', {
        filename: `shot-${idx + 1}-${file.name}`,
        content_type: file.type || 'image/png',
      });
      const d = await res.json();
      if (d.upload_url) {
        await fetch(d.upload_url, {
          method: 'PUT',
          headers: { 'Content-Type': file.type || 'image/png' },
          body: file,
        });
        if (d.key) {
          shot.image_key = d.key;
          const urlData = await (await postJson('/presign-key', { key: d.key })).json();
          if (urlData.url) {
            shot.image_url = urlData.url;
            shot.imageStatus = 'done';
            setImageDone(idx, shot.image_url);
            setCardStatus(idx);
            updateGenProgress();
            syncStoryboard();
            input.remove();
            return;
          }
        }
        // Fall back to a local data URL when presigning is unavailable. The image is
        // visible immediately but will not survive a reload.
        const reader = new FileReader();
        reader.onload = (ev) => {
          shot.image_url = ev.target.result;
          shot.imageStatus = 'done';
          shot.imageLoaded = true;
          setImageDone(idx, shot.image_url);
          setCardStatus(idx);
          updateGenProgress();
        };
        reader.readAsDataURL(file);
      }
    } catch (e) {
      console.error('Local upload failed:', e);
      setStatus('error', t('status.uploadFailed'));
    }
    input.remove();
  });
  document.body.appendChild(input);
  input.click();
}

// ─── Step navigation ───
$('#back-to-upload-btn').addEventListener('click', () => showStep(stepUpload));
$('#back-to-storyboard-btn').addEventListener('click', () => showStep(stepStoryboard));

(function addContinueButton() {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;justify-content:center;padding:2rem 0;';
  const button = document.createElement('button');
  button.className = 'btn btn-create';
  button.id = 'continue-to-finalize';
  button.innerHTML = `<span data-i18n="storyboard.continueToFinalize"></span> →`;
  wrap.appendChild(button);
  stepStoryboard.querySelector('.step-inner').appendChild(wrap);
  applyTranslations(wrap);
  button.addEventListener('click', () => {
    loadMusicTracks();
    loadWallpapers();
    updateFinalizeStats();
    showStep(stepFinalize);
  });
  // Keep the label in sync when the interface language changes.
  window.addEventListener('vaio-language-changed', () => applyTranslations(wrap));
})();

// ═══════════════════════════════════════════
// FINALIZE — music, wallpaper, assembly
// ═══════════════════════════════════════════

async function loadMusicTracks() {
  const list = document.getElementById('music-list');
  try {
    state.musicTracks = (await (await fetch(`${API}/music-tracks`)).json()).tracks || [];
  } catch {
    state.musicTracks = [];
  }
  list.innerHTML = '';

  const noneItem = document.createElement('div');
  noneItem.className = 'music-item';
  noneItem.innerHTML = `<div class="music-radio"></div><span class="music-name text-dim">${esc(
    t('finalize.noMusic')
  )}</span>`;
  noneItem.addEventListener('click', () => {
    list.querySelectorAll('.music-item').forEach((m) => m.classList.remove('selected'));
    noneItem.classList.add('selected');
    state.selectedMusic = null;
    document.getElementById('music-preview').hidden = true;
    updateFinalizeStats();
  });
  list.appendChild(noneItem);

  state.musicTracks.forEach((track, i) => {
    const item = document.createElement('div');
    item.className = `music-item${i === 0 ? ' selected' : ''}`;
    item.innerHTML = `<div class="music-radio"></div><span class="music-name">${esc(
      track.name
    )}</span><button class="music-del" title="${esc(t('common.delete'))}">✕</button>`;
    const select = () => {
      list.querySelectorAll('.music-item').forEach((m) => m.classList.remove('selected'));
      item.classList.add('selected');
      state.selectedMusic = track.file;
      showMusicPreview(track.preview_url || track.file);
      updateFinalizeStats();
    };
    item.querySelector('.music-name').addEventListener('click', select);
    item.querySelector('.music-radio').addEventListener('click', select);
    item.querySelector('.music-del').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(t('finalize.confirmDeleteTrack', { name: track.name }))) return;
      try {
        await postJson('/delete-music', { filename: track.file });
      } catch (err) {
        console.warn('Music delete failed', err);
      }
      item.remove();
      state.musicTracks = state.musicTracks.filter((x) => x.file !== track.file);
      if (state.selectedMusic === track.file) {
        state.selectedMusic = null;
        document.getElementById('music-preview').hidden = true;
      }
      updateFinalizeStats();
    });
    list.appendChild(item);
  });

  if (state.musicTracks.length > 0) {
    state.selectedMusic = state.musicTracks[0].file;
    showMusicPreview(state.musicTracks[0].preview_url || state.musicTracks[0].file);
  } else {
    state.selectedMusic = null;
    noneItem.classList.add('selected');
  }
}

function showMusicPreview(url) {
  const preview = $('#music-preview');
  const player = $('#music-preview-player');
  if (url.startsWith('http')) {
    player.src = url;
  } else {
    fetch(`${API}/preview-music/${encodeURIComponent(url)}`)
      .then((r) => r.json())
      .then((d) => { player.src = d.preview_url || url; })
      .catch(() => {});
  }
  player.volume = state.musicVolume;
  preview.hidden = false;
}

(function initMusicVolume() {
  const slider = document.getElementById('music-volume');
  const valLabel = document.getElementById('music-volume-val');
  const player = document.getElementById('music-preview-player');
  if (!slider) return;
  slider.addEventListener('input', () => {
    const pct = parseInt(slider.value, 10);
    state.musicVolume = pct / 100;
    if (valLabel) valLabel.textContent = `${pct}%`;
    if (player) player.volume = state.musicVolume;
    updateFinalizeStats();
  });
})();

async function loadWallpapers() {
  const list = $('#wallpaper-list');
  let wallpapers = [];
  try {
    wallpapers = (await (await fetch(`${API}/wallpapers`)).json()).wallpapers || [];
  } catch {
    wallpapers = [];
  }
  list.innerHTML = '';

  const noneItem = document.createElement('div');
  noneItem.className = 'music-item';
  noneItem.innerHTML = `<div class="music-radio"></div><span class="music-name text-dim">${esc(
    t('finalize.noWallpaper')
  )}</span>`;
  noneItem.addEventListener('click', () => {
    list.querySelectorAll('.music-item').forEach((m) => m.classList.remove('selected'));
    noneItem.classList.add('selected');
    state.selectedWallpaper = null;
    $('#wallpaper-preview').hidden = true;
    updateFinalizeStats();
  });
  list.appendChild(noneItem);

  wallpapers.forEach((wp, i) => {
    const item = document.createElement('div');
    item.className = `music-item${i === 0 ? ' selected' : ''}`;
    item.innerHTML = `<div class="music-radio"></div><span class="music-name">${esc(
      wp.name
    )}</span><button class="wp-del" title="${esc(t('common.delete'))}">✕</button>`;
    const select = () => {
      list.querySelectorAll('.music-item').forEach((m) => m.classList.remove('selected'));
      item.classList.add('selected');
      state.selectedWallpaper = wp.file;
      showWallpaperPreview(wp.preview_url, wp.source, wp.file);
      updateFinalizeStats();
    };
    item.querySelector('.music-name').addEventListener('click', select);
    item.querySelector('.music-radio').addEventListener('click', select);
    item.querySelector('.wp-del').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(t('finalize.confirmDeleteTrack', { name: wp.name }))) return;
      try {
        await postJson('/delete-wallpaper', { filename: wp.file });
      } catch (err) {
        console.warn('Wallpaper delete failed', err);
      }
      item.remove();
      if (state.selectedWallpaper === wp.file) {
        state.selectedWallpaper = null;
        $('#wallpaper-preview').hidden = true;
      }
      updateFinalizeStats();
    });
    list.appendChild(item);
  });

  if (wallpapers.length > 0) {
    state.selectedWallpaper = wallpapers[0].file;
    showWallpaperPreview(wallpapers[0].preview_url, wallpapers[0].source, wallpapers[0].file);
  } else {
    state.selectedWallpaper = null;
    noneItem.classList.add('selected');
  }
}

function showWallpaperPreview(url, source, filename) {
  const preview = $('#wallpaper-preview');
  const img = $('#wallpaper-preview-img');
  if (url && url.startsWith('http')) {
    img.src = url;
  } else {
    fetch(`${API}/preview-wallpaper/${source}/${encodeURIComponent(filename)}`)
      .then((r) => r.json())
      .then((d) => { img.src = d.preview_url; })
      .catch(() => {});
  }
  preview.hidden = false;
}

$('#wallpaper-upload-btn').addEventListener('click', () => $('#wallpaper-upload-input').click());
$('#wallpaper-upload-input').addEventListener('change', async () => {
  const file = $('#wallpaper-upload-input').files[0];
  if (!file) return;
  try {
    const resp = await postJson('/upload-wallpaper', {
      filename: file.name,
      content_type: file.type || 'image/jpeg',
    });
    const d = await resp.json();
    if (d.upload_url) {
      await fetch(d.upload_url, {
        method: 'PUT',
        headers: { 'Content-Type': file.type || 'image/jpeg' },
        body: file,
      });
    }
    loadWallpapers();
  } catch (e) {
    console.error(e);
    setStatus('error', t('status.uploadFailed'));
  }
  $('#wallpaper-upload-input').value = '';
});

function updateFinalizeStats() {
  const shots = state.shots || [];
  const shotDur = (state.settings && state.settings.shotDuration) || 6;
  let imageShots = 0;
  let videoShots = 0;
  let totalSeconds = 0;

  shots.forEach((s, index) => {
    if (s.is_video) {
      videoShots += 1;
      // Prefer the real decoded duration; fall back to the configured shot length.
      let dur = 0;
      const videoEl = document.querySelector(`#shot-card-${index} video`);
      if (videoEl && Number.isFinite(videoEl.duration) && videoEl.duration > 0) dur = videoEl.duration;
      else if (s._videoDuration && Number.isFinite(s._videoDuration)) dur = s._videoDuration;
      else dur = shotDur;
      totalSeconds += dur;
    } else {
      imageShots += 1;
      // Image shots run as long as their narration audio.
      let dur = shotDur;
      const audioEl = document.querySelector(`#audio-content-${index} audio`);
      if (audioEl && Number.isFinite(audioEl.duration) && audioEl.duration > 0) {
        dur = Math.max(4, audioEl.duration + 0.5);
      }
      totalSeconds += dur;
    }
  });

  // Wallpaper bookends add roughly three seconds at each end.
  if (state.selectedWallpaper) totalSeconds += 6;

  const mins = Math.floor(totalSeconds / 60);
  const secs = Math.round(totalSeconds % 60);
  const durStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;

  // 720p H.264 at roughly 1.5 Mbps works out to about 0.19 MB per second.
  const estMB = Math.max(1, Math.round(totalSeconds * 0.19));
  // Video clips re-encode at roughly 0.6× realtime; image shots are much cheaper.
  const estRenderSec = Math.round(
    videoShots * (totalSeconds / Math.max(1, shots.length)) * 0.6 + videoShots * 8 + imageShots * 4 + 15
  );
  const rMin = Math.floor(estRenderSec / 60);
  const rSec = estRenderSec % 60;
  const renderStr = rMin > 0 ? `~${rMin}m ${rSec}s` : `~${rSec}s`;

  const set = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  };
  set('stat-clips', shots.length);
  set('stat-duration', durStr);
  set('stat-image-shots', imageShots);
  set('stat-video-shots', videoShots);
  set('stat-resolution', '1280×720');
  set('stat-filesize', `~${estMB} MB`);
  set('stat-rendertime', renderStr);
  set(
    'stat-music',
    state.selectedMusic
      ? t('finalize.on', { percent: Math.round((state.musicVolume ?? 0.3) * 100) })
      : t('finalize.none')
  );
}

$('#music-upload-btn').addEventListener('click', () => $('#music-upload-input').click());
$('#music-upload-input').addEventListener('change', async () => {
  const file = $('#music-upload-input').files[0];
  if (!file) return;
  const btn = $('#music-upload-btn');
  const original = btn.innerHTML;
  btn.innerHTML = `⏳ ${esc(t('finalize.uploading'))}`;
  btn.disabled = true;

  let progressEl = document.getElementById('music-upload-progress');
  if (!progressEl) {
    progressEl = document.createElement('div');
    progressEl.id = 'music-upload-progress';
    progressEl.style.cssText = 'margin-top:.5rem;';
    progressEl.innerHTML = `
      <div class="upload-progress-track"><div id="music-upload-bar" class="upload-progress-fill"></div></div>
      <div id="music-upload-pct" class="upload-progress-text" style="text-align:left;margin-top:.2rem;">0%</div>`;
    btn.parentElement.appendChild(progressEl);
  }
  progressEl.hidden = false;
  const bar = document.getElementById('music-upload-bar');
  const pctLabel = document.getElementById('music-upload-pct');
  bar.classList.remove('complete');
  bar.style.width = '0%';
  pctLabel.textContent = '0%';

  try {
    const resp = await postJson('/upload-music', {
      filename: file.name,
      content_type: file.type || 'audio/mpeg',
    });
    const d = await resp.json();
    if (d.upload_url) {
      // XHR rather than fetch: fetch has no upload progress events.
      await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('PUT', d.upload_url);
        xhr.setRequestHeader('Content-Type', file.type || 'audio/mpeg');
        xhr.upload.addEventListener('progress', (evt) => {
          if (!evt.lengthComputable) return;
          const pct = Math.round((evt.loaded / evt.total) * 100);
          bar.style.width = `${pct}%`;
          pctLabel.textContent = `${pct}%`;
        });
        xhr.addEventListener('load', () => {
          if (xhr.status >= 200 && xhr.status < 300) resolve();
          else reject(new Error(`Upload returned status ${xhr.status}`));
        });
        xhr.addEventListener('error', () => reject(new Error('Network error')));
        xhr.send(file);
      });
      bar.style.width = '100%';
      bar.classList.add('complete');
      pctLabel.textContent = t('finalize.uploadDone');
      setTimeout(() => { progressEl.hidden = true; }, 1500);
      loadMusicTracks();
    } else if (d.name) {
      loadMusicTracks();
    }
  } catch (e) {
    console.error(e);
    pctLabel.textContent = t('finalize.uploadFailed');
  }
  btn.innerHTML = original;
  btn.disabled = false;
  $('#music-upload-input').value = '';
});

$('#create-video-btn').addEventListener('click', async () => {
  const notReady = state.shots.filter((s) => {
    if (s.is_video) return false; // video shots are ready once they have a key
    return !s.imageLoaded || !s.audioLoaded;
  });
  if (notReady.length > 0) {
    alert(t('finalize.shotsNotReady', { count: notReady.length }));
    return;
  }
  showProgress(t('finalize.creatingVideo'), t('finalize.creatingDetail'), 5);
  setStatus('busy', t('status.creating'));
  try {
    const d = await (
      await postJson('/create-video', {
        shots: state.shots,
        music: state.selectedMusic,
        music_volume: state.musicVolume,
        settings: state.settings,
        wallpaper: state.selectedWallpaper,
        run_id: state.runId,
        image_model: state.selectedImageModel,
        language: state.language,
        project_name: state.projectName || '',
        project_description: state.projectDescription || '',
      })
    ).json();
    if (d.status === 'processing' && d.job_id) {
      pollVideoProgress(d.job_id);
    } else if (d.status === 'complete') {
      hideProgress();
      setStatus('done', t('status.videoCreated'));
      showDownloadButton(d.download_url, d.size_mb, d.job_id);
    } else {
      hideProgress();
      setStatus('error', d.detail || t('status.failed'));
      alert(d.detail || t('status.assemblyFailed'));
    }
  } catch (err) {
    hideProgress();
    setStatus('error', t('status.failed'));
    alert(t('common.error', { error: err.message }));
  }
});

function pollVideoProgress(jobId) {
  const poll = async () => {
    try {
      const d = await (await fetch(`${API}/video-status/${jobId}`)).json();
      if (d.status === 'complete') {
        hideProgress();
        setStatus('done', t('status.videoCreated'));
        showDownloadButton(d.download_url, d.size_mb, jobId, d.preview_url);
      } else if (d.status === 'error') {
        hideProgress();
        setStatus('error', t('status.assemblyFailed'));
        alert(t('finalize.assemblyFailedDetail', { error: d.detail || t('status.failed') }));
      } else {
        updateProgress(d.detail || t('finalize.assembling'), d.progress || 30);
        setTimeout(poll, 2000);
      }
    } catch {
      hideProgress();
      setStatus('error', t('status.lostConnection'));
    }
  };
  poll();
}

function showDownloadButton(downloadUrl, sizeMb, jobId, previewUrl) {
  const createBtn = $('#create-video-btn');
  const parent = createBtn.parentElement;
  const videoSrc = previewUrl || downloadUrl || '';
  const wrap = document.createElement('div');
  wrap.className = 'download-complete';
  wrap.innerHTML = `
    <div style="text-align:center;margin-bottom:1rem;">
      <span class="success-mark" aria-hidden="true">✓</span>
      <p class="success-text">${esc(
        sizeMb ? t('finalize.assembledWithSize', { size: sizeMb }) : t('finalize.assembled')
      )}</p>
    </div>
    <div class="video-preview-wrap">
      <video controls preload="metadata" src="${esc(videoSrc)}"></video>
    </div>
    <div style="display:flex;gap:.5rem;margin-top:1rem;">
      <button class="btn btn-create" id="download-video-btn">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        ${esc(t('finalize.download'))}
      </button>
      <button class="btn btn-ghost" id="create-another-btn">${esc(t('finalize.createAnother'))}</button>
    </div>
  `;
  createBtn.style.display = 'none';
  parent.appendChild(wrap);

  wrap.querySelector('#download-video-btn').addEventListener('click', (e) => {
    downloadVideo(downloadUrl || videoSrc, `${jobId || 'video'}.mp4`, e.currentTarget);
  });
  wrap.querySelector('#create-another-btn').addEventListener('click', () => {
    wrap.remove();
    createBtn.style.display = '';
  });
}

// ─── Helpers ───
/** HTML-escape a value for safe interpolation into a template string. */
function esc(str) {
  const d = document.createElement('div');
  d.textContent = str === null || str === undefined ? '' : String(str);
  return d.innerHTML;
}

/**
 * Download a video through a blob so cross-origin presigned URLs still save
 * with the intended filename instead of navigating.
 *
 * @param {string} url Presigned video URL.
 * @param {string} filename Suggested filename.
 * @param {HTMLElement} [btn] Button to show progress on.
 */
function downloadVideo(url, filename, btn) {
  const original = btn ? btn.innerHTML : '';
  if (btn) btn.textContent = '⏳…';
  _origFetch(url)
    .then((r) => r.blob())
    .then((blob) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename || 'video.mp4';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(a.href);
      if (btn) btn.innerHTML = original;
    })
    .catch(() => {
      window.open(url, '_blank');
      if (btn) btn.innerHTML = original;
    });
}

// ═══════════════════════════════════════════
// HISTORY — previous runs
// ═══════════════════════════════════════════

$('#nav-history-btn').addEventListener('click', () => {
  loadRunHistory();
  showStep(stepHistory);
});

$('#history-back-btn').addEventListener('click', () => showStep(stepUpload));

async function loadRunHistory() {
  const list = $('#history-list');
  list.innerHTML = `<p class="text-dim">${esc(t('history.loading'))}</p>`;
  const bulkActions = $('#history-bulk-actions');
  const selectedRuns = new Set();

  function updateBulkUI() {
    if (selectedRuns.size > 0) {
      bulkActions.hidden = false;
      $('#history-select-count').textContent = t('history.selected', { count: selectedRuns.size });
    } else {
      bulkActions.hidden = true;
    }
  }

  try {
    const data = await (await fetch(`${API}/runs`)).json();
    const runs = (data.runs || []).filter((r) => r.image_count > 0);
    if (!runs.length) {
      list.innerHTML = `<p class="text-dim">${esc(t('history.none'))}</p>`;
      bulkActions.hidden = true;
      return;
    }

    bulkActions.hidden = false;
    list.innerHTML = '';

    runs.forEach((run) => {
      const el = document.createElement('div');
      el.className = 'history-run';
      el.dataset.runId = run.id;

      const badge =
        run.status === 'complete'
          ? `<span class="history-badge history-badge-complete">✓ ${esc(t('history.complete'))}${
              run.size_mb ? ` · ${run.size_mb} MB` : ''
            }</span>`
          : run.status === 'error'
          ? `<span class="history-badge history-badge-error">✗ ${esc(t('history.error'))}</span>`
          : `<span class="history-badge history-badge-partial">◐ ${esc(t('history.partial'))}</span>`;

      const dateStr = formatRunDate(run.date || run.id);
      const projectName = run.project_name || '';
      const projectDesc = run.project_description || '';

      const thumbs = (run.images || [])
        .map((img) => {
          const imgUrl = (run.image_urls && run.image_urls[img]) || '';
          if (!imgUrl) return '';
          const isVideo = /\.(mp4|mov|webm)$/i.test(img);
          return isVideo
            ? `<video src="${esc(imgUrl)}#t=0.1" preload="metadata" muted playsinline data-open-src="${esc(imgUrl)}"></video>`
            : `<img src="${esc(imgUrl)}" alt="" loading="lazy" data-open-src="${esc(imgUrl)}">`;
        })
        .join('');

      el.innerHTML = `
        <div class="history-run-header">
          <input type="checkbox" class="history-run-checkbox" data-run-id="${esc(run.id)}">
          <h3 style="flex:1;">${esc(projectName || dateStr)}</h3>
          <div class="history-meta">
            <span>${esc(t('history.shots', { count: run.image_count }))}</span>
            ${badge}
          </div>
        </div>
        <div class="history-run-body">
          ${
            projectName
              ? `<div class="history-date">${esc(dateStr)}${projectDesc ? ` — ${esc(projectDesc)}` : ''}</div>`
              : projectDesc
              ? `<div class="history-date">${esc(projectDesc)}</div>`
              : ''
          }
          ${thumbs ? `<div class="history-thumbs">${thumbs}</div>` : ''}
          <div class="history-actions">
            <button class="btn btn-ghost btn-sm history-open-btn" data-action="open">✦ ${esc(
              t('history.openStoryboard')
            )}</button>
            ${
              run.status === 'complete' && run.video_url
                ? `<button class="btn btn-ghost btn-sm" data-action="preview">▶ ${esc(t('history.preview'))}</button>
                   <button class="btn btn-primary btn-sm" data-action="download">↓ ${esc(t('history.download'))}</button>`
                : ''
            }
            <button class="btn btn-ghost btn-sm history-delete-btn" data-action="delete">✕ ${esc(
              t('history.delete')
            )}</button>
          </div>
          <div class="history-video-slot" id="history-video-${esc(run.id)}"></div>
        </div>
      `;

      el.querySelector('.history-run-header').addEventListener('click', (e) => {
        if (e.target.type === 'checkbox') return;
        el.classList.toggle('open');
      });

      el.querySelector('.history-run-checkbox').addEventListener('change', (e) => {
        e.stopPropagation();
        if (e.target.checked) selectedRuns.add(run.id);
        else selectedRuns.delete(run.id);
        updateBulkUI();
      });
      el.querySelector('.history-run-checkbox').addEventListener('click', (e) => e.stopPropagation());

      // Thumbnails open full size in a new tab.
      el.querySelectorAll('[data-open-src]').forEach((media) => {
        media.style.cursor = 'pointer';
        media.addEventListener('click', (e) => {
          e.stopPropagation();
          window.open(media.dataset.openSrc, '_blank');
        });
      });

      // Actions are delegated rather than inlined so run ids and URLs never need
      // escaping into onclick attributes.
      el.querySelectorAll('[data-action]').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const action = btn.dataset.action;
          if (action === 'open') jumpToStoryboard(run.id, btn);
          else if (action === 'preview') previewRunVideo(run.id, btn, run.video_url);
          else if (action === 'download') downloadVideo(run.download_url, `video-${run.id}.mp4`, btn);
          else if (action === 'delete') deleteRun(run.id, btn);
        });
      });

      list.appendChild(el);
    });

    $('#history-select-all-btn').onclick = () => {
      const checkboxes = list.querySelectorAll('.history-run-checkbox');
      const allChecked = selectedRuns.size === runs.length;
      checkboxes.forEach((cb) => {
        cb.checked = !allChecked;
        if (!allChecked) selectedRuns.add(cb.dataset.runId);
      });
      if (allChecked) selectedRuns.clear();
      updateBulkUI();
      $('#history-select-all-btn').textContent =
        selectedRuns.size === runs.length ? t('history.deselectAll') : t('history.selectAll');
    };

    $('#history-delete-selected-btn').onclick = async () => {
      if (!selectedRuns.size) return;
      if (!confirm(t('history.confirmDeleteMany', { count: selectedRuns.size }))) return;
      const toDelete = [...selectedRuns];
      const btn = $('#history-delete-selected-btn');
      btn.textContent = t('history.deleting', { count: toDelete.length });
      btn.disabled = true;
      for (const id of toDelete) {
        try {
          await fetch(`${API}/runs/${id}`, { method: 'DELETE' });
        } catch (e) {
          console.warn(`Could not delete run ${id}:`, e);
        }
      }
      selectedRuns.clear();
      btn.disabled = false;
      updateBulkUI();
      loadRunHistory();
    };

    updateBulkUI();
  } catch (err) {
    list.innerHTML = `<p class="text-error">${esc(t('history.loadFailed', { error: err.message }))}</p>`;
  }
}

/**
 * Format a run identifier or timestamp for display.
 *
 * Run ids look like 2026-04-30_204753, which Date cannot parse directly.
 *
 * @param {string} value Run date or id.
 * @returns {string} A locale-formatted date, or the raw value if unparseable.
 */
function formatRunDate(value) {
  try {
    const normalized = String(value)
      .replace(/_/g, ' ')
      .replace(/(\d{4}-\d{2}-\d{2})\s(\d{2})(\d{2})(\d{2})/, '$1T$2:$3:$4Z');
    const d = new Date(normalized);
    if (Number.isNaN(d.getTime())) return String(value);
    return d.toLocaleDateString(getLocaleTag(), {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return String(value);
  }
}

function previewRunVideo(runId, btn, videoUrl) {
  const slot = document.getElementById(`history-video-${runId}`);
  if (slot.querySelector('video')) {
    slot.innerHTML = '';
    btn.textContent = `▶ ${t('history.preview')}`;
    return;
  }
  slot.innerHTML = `<div class="history-video-preview"><video controls preload="metadata" src="${esc(
    videoUrl || ''
  )}"></video></div>`;
  btn.textContent = `▶ ${t('history.hide')}`;
}

async function jumpToStoryboard(runId, btn) {
  const original = btn.textContent;
  btn.textContent = `⏳ ${t('common.loading')}`;
  btn.disabled = true;
  try {
    const manifest = await (await fetch(`${API}/runs/${runId}/manifest`)).json();
    if (!manifest.shots || !manifest.shots.length) {
      alert(t('history.noStoryboardData'));
      btn.textContent = original;
      btn.disabled = false;
      return;
    }

    state.runId = runId;
    state.selectedImageModel = manifest.image_model || 'gemini';
    state.characters = manifest.characters || {};
    state.artDirection = manifest.art_direction || '';
    state.projectName = manifest.project_name || '';
    state.projectDescription = manifest.project_description || '';
    state.currentRevision = manifest.revision || 0;

    // Restore the project language before anything that depends on it (voices,
    // prompt handling, badges).
    lockProjectLanguage(manifest.language);
    if (manifest.selected_voice) state.selectedVoice = manifest.selected_voice;
    await loadVoices();

    updateProjectNameDisplay();
    renderStoryboardVoiceOptions();

    state.shots = manifest.shots.map((s, i) => ({
      shot: i + 1,
      title: s.title || t('shot.label', { number: i + 1 }),
      image_prompt: s.image_prompt || '',
      image_url: s.is_video ? null : s.image_url || null,
      image_key: s.image_key || '',
      narration: s.narration || '',
      audio_url: s.audio_url || null,
      audio_key: s.audio_key || '',
      is_video: !!s.is_video,
      video_url: s.video_url || '',
      video_key: s.video_key || '',
      audio_mode: s.audio_mode || '',
      characters_in_shot: s.characters_in_shot || [],
      imageStatus: 'done',
      audioStatus: s.audio_url || s.is_video ? 'done' : 'pending',
      imageLoaded: !!s.is_video,
      audioLoaded: !!(s.audio_url || (s.is_video && s.audio_mode === 'native')),
    }));

    if (manifest.settings) state.settings = manifest.settings;
    if (manifest.music_file) state.selectedMusic = manifest.music_file;
    if (typeof manifest.music_volume === 'number') {
      state.musicVolume = manifest.music_volume;
      const volSlider = document.getElementById('music-volume');
      const volLabel = document.getElementById('music-volume-val');
      const pct = Math.round(manifest.music_volume * 100);
      if (volSlider) volSlider.value = pct;
      if (volLabel) volLabel.textContent = `${pct}%`;
    }
    if (manifest.wallpaper_file) state.selectedWallpaper = manifest.wallpaper_file;

    const editCharsBtn = document.getElementById('edit-characters-btn');
    if (editCharsBtn) {
      const hasChars = state.characters && Object.keys(state.characters).length > 0;
      editCharsBtn.hidden = !hasChars && !manifest.character_sheet_url;
    }

    renderStoryboard();
    showStep(stepStoryboard);

    state.shots.forEach((shot, idx) => {
      if (shot.image_url && !shot.is_video) {
        setImageDone(idx, shot.image_url);
        shot.imageStatus = 'done';
      }
      if (shot.audio_url) {
        setAudioDone(idx, shot.audio_url);
        shot.audioStatus = 'done';
      }
      setCardStatus(idx);
    });
    updateGenProgress();
    setStatus('done', t('history.loadedRun', { id: runId }));
  } catch (err) {
    alert(t('history.loadStoryboardFailed', { error: err.message }));
    btn.textContent = original;
    btn.disabled = false;
  }
}

// ─── Refresh expiring asset URLs ───
/**
 * Re-fetch presigned asset URLs from the manifest.
 *
 * Presigned URLs expire after 12 hours, so images silently break if the tab is left
 * open overnight. Refreshing on tab focus repairs them without a reload.
 */
async function refreshStoryboardAssets() {
  if (!state.runId) return;
  if (!stepStoryboard.classList.contains('active')) return;
  try {
    const manifest = await (await fetch(`${API}/runs/${state.runId}/manifest`)).json();
    if (!manifest.shots) return;
    manifest.shots.forEach((s, idx) => {
      const shot = state.shots[idx];
      if (!shot) return;
      if (s.is_video && s.video_url) {
        if (shot.video_url !== s.video_url) {
          shot.video_url = s.video_url;
          const wrap = document.getElementById(`img-wrap-${idx}`);
          const vid = wrap && wrap.querySelector('video');
          if (vid) vid.src = s.video_url;
        }
      } else {
        if (s.image_url && shot.image_url !== s.image_url) {
          shot.image_url = s.image_url;
          setImageDone(idx, s.image_url);
        }
        if (s.audio_url && shot.audio_url !== s.audio_url) {
          shot.audio_url = s.audio_url;
          setAudioDone(idx, s.audio_url);
        }
      }
    });
  } catch (err) {
    console.warn('Asset refresh failed:', err);
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refreshStoryboardAssets();
});

// ─── Import Shot from Previous Runs ───
let importTargetIdx = null;
let importableCache = null;

async function openImportPicker(idx) {
  importTargetIdx = idx;
  setStatus('busy', t('status.loadingShots'));

  try {
    if (!importableCache) {
      const data = await (await fetch(`${API}/runs/importable-shots`)).json();
      importableCache = data.shots || [];
    }

    let modal = document.getElementById('import-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'import-modal';
      modal.className = 'modal-overlay';
      document.body.appendChild(modal);
    }

    const available = importableCache.filter((s) => s.image_url);
    const grid = available
      .map(
        (s, i) => `
      <div class="import-shot-card" data-cache-idx="${i}" title="${esc(s.title || '')}">
        <img src="${esc(s.image_url)}" alt="" loading="lazy">
        <div class="import-shot-info">
          <span class="import-shot-title">${esc(s.title || t('shot.label', { number: s.index + 1 }))}</span>
          <span class="import-shot-date">${esc(formatRunDate(s.run_date || s.run_id))}</span>
        </div>
      </div>`
      )
      .join('');

    modal.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" style="max-width:800px;max-height:80vh;overflow:hidden;display:flex;flex-direction:column;">
        <div class="modal-header">
          <h3>📥 ${esc(t('import.title', { number: idx + 1 }))}</h3>
          <button class="modal-close" id="import-modal-close" aria-label="${esc(t('common.close'))}">&times;</button>
        </div>
        <p style="padding:0 1.5rem;" class="text-dim">${esc(t('import.help'))}</p>
        <div style="flex:1;overflow-y:auto;padding:1rem 1.5rem;">
          ${grid || `<p class="text-dim">${esc(t('import.none'))}</p>`}
        </div>
      </div>
    `;
    modal.hidden = false;
    modal.querySelector('#import-modal-close').addEventListener('click', () => { modal.hidden = true; });
    modal.querySelectorAll('.import-shot-card').forEach((card) => {
      card.addEventListener('click', () => importShot(parseInt(card.dataset.cacheIdx, 10), available));
    });
    setStatus('idle', t('status.ready'));
  } catch (err) {
    setStatus('error', t('status.loadShotsFailed'));
    alert(t('import.loadFailed', { error: err.message }));
  }
}

function importShot(cacheIdx, available) {
  const source = available[cacheIdx];
  const idx = importTargetIdx;
  if (!source || idx === null) return;

  document.getElementById('import-modal').hidden = true;

  const shot = state.shots[idx];
  shot.title = source.title || shot.title;
  shot.image_prompt = source.image_prompt || shot.image_prompt;
  shot.narration = source.narration || shot.narration;
  shot.image_url = source.image_url || null;
  shot.image_key = source.image_key || '';
  shot.audio_url = source.audio_url || null;
  shot.audio_key = source.audio_key || '';
  shot.imageStatus = source.image_url ? 'done' : 'pending';
  shot.audioStatus = source.audio_url ? 'done' : 'pending';
  shot.imageLoaded = false;
  shot.audioLoaded = false;

  const promptEl = document.getElementById(`prompt-${idx}`);
  if (promptEl) promptEl.value = shot.image_prompt;
  const narrEl = document.getElementById(`narration-${idx}`);
  if (narrEl) narrEl.value = shot.narration;
  const titleEl = document.querySelector(`#shot-card-${idx} .shot-title-input`);
  if (titleEl) titleEl.value = shot.title;

  if (shot.image_url) setImageDone(idx, shot.image_url);
  if (shot.audio_url) setAudioDone(idx, shot.audio_url);
  setCardStatus(idx);
  updateGenProgress();
  syncStoryboard();
  setStatus('done', t('shot.importedInto', { number: idx + 1 }));
}

async function deleteRun(runId, btn) {
  if (!confirm(t('history.confirmDeleteRun', { id: runId }))) return;
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = '⏳…';
  try {
    const res = await fetch(`${API}/runs/${runId}`, { method: 'DELETE' });
    if (res.ok) {
      const card = btn.closest('.history-run');
      if (card) card.remove();
      if (!$('#history-list .history-run')) {
        $('#history-list').innerHTML = `<p class="text-dim">${esc(t('history.none'))}</p>`;
      }
      return;
    }
    throw new Error('delete failed');
  } catch {
    alert(t('history.deleteFailed'));
    btn.disabled = false;
    btn.textContent = original;
  }
}

// ═══════════════════════════════════════════
// VIDEO UPLOAD WIZARD
// ═══════════════════════════════════════════

let videoWizardState = {
  file: null,
  videoUrl: null,
  audioMode: 'native',
  transcribedText: '',
  uploadedVideoKey: '',
  processedAudioKey: '',
  processedAudioUrl: '',
  mergedPreviewUrl: '',
  selectedVoice: 'tiffany',
  editingIdx: null, // non-null when re-editing an existing video shot
  // Language actually spoken in the uploaded clip. Independent of the project
  // language: an English-voiced video can be re-voiced into a French project, and the
  // reverse. Defaults to the project language, the common case.
  sourceLanguage: 'en',
};

$('#add-video-btn').addEventListener('click', () => openVideoWizard());

function openVideoWizard(editIdx) {
  videoWizardState = {
    file: null,
    videoUrl: null,
    audioMode: 'native',
    transcribedText: '',
    uploadedVideoKey: '',
    processedAudioKey: '',
    processedAudioUrl: '',
    mergedPreviewUrl: '',
    selectedVoice: state.selectedVoice || 'tiffany',
    editingIdx: editIdx != null ? editIdx : null,
    sourceLanguage: state.language,
  };

  const byId = (id) => document.getElementById(id);
  byId('video-wizard-modal').hidden = false;
  byId('vw-source-language-row').hidden = true;
  byId('vw-translation-row').hidden = true;
  byId('vw-refine-btn').hidden = true;
  byId('vw-polish-row').hidden = true;
  byId('vw-translation-status').textContent = '';
  renderSourceLanguageSwitch();
  renderVoiceTargetNote();
  byId('vw-step-audio').hidden = true;
  byId('vw-step-preview').hidden = true;
  byId('vw-file-info').hidden = true;
  byId('vw-finish-btn').hidden = true;
  byId('vw-voice-panel').hidden = true;
  byId('vw-audio-preview').hidden = true;
  byId('vw-transcribe-action').hidden = true;
  byId('vw-gen-preview-btn').hidden = true;
  byId('vw-preview-status').hidden = true;
  byId('vw-status').hidden = true;
  byId('vw-file-input').value = '';
  byId('vw-narration-text').value = '';
  byId('vw-synth-status').textContent = '';
  byId('vw-voice-picker').innerHTML = '';
  byId('vw-synthesize-btn').innerHTML = `🔊 ${esc(t('wizard.synthesize'))}`;
  const transcribeBtn = byId('vw-transcribe-btn');
  transcribeBtn.innerHTML = `📝 ${esc(t('wizard.transcribeButton'))}`;
  transcribeBtn.disabled = false;
  transcribeBtn.style.opacity = '';

  const nativeRadio = document.querySelector('input[name="vw-audio-mode"][value="native"]');
  if (nativeRadio) nativeRadio.checked = true;

  if (editIdx != null) {
    const shot = state.shots[editIdx];
    if (shot && (shot.video_url || shot.video_key)) {
      byId('vw-finish-btn').hidden = false;
      byId('vw-step-audio').hidden = false;
      videoWizardState.uploadedVideoKey = shot.video_key || '';
      videoWizardState.videoUrl = shot.video_url;
      if (shot.video_url) {
        byId('vw-step-preview').hidden = false;
        byId('vw-preview-video').src = shot.video_url;
      }
      if (shot.audio_mode && shot.audio_mode !== 'native') {
        const radio = document.querySelector(`input[name="vw-audio-mode"][value="${shot.audio_mode}"]`);
        if (radio) {
          radio.checked = true;
          radio.dispatchEvent(new Event('change', { bubbles: true }));
        }
        if (shot.narration) byId('vw-narration-text').value = shot.narration;
      }
    }
  }
}

function closeVideoWizard() {
  document.getElementById('video-wizard-modal').hidden = true;
  if (videoWizardState.videoUrl && videoWizardState.videoUrl.startsWith('blob:')) {
    URL.revokeObjectURL(videoWizardState.videoUrl);
  }
}

document.getElementById('vw-file-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  videoWizardState.file = file;

  const byId = (id) => document.getElementById(id);
  byId('vw-file-info').hidden = false;
  byId('vw-file-name').textContent = file.name;
  byId('vw-file-size').textContent = `${(file.size / (1024 * 1024)).toFixed(1)} MB`;

  if (videoWizardState.videoUrl && videoWizardState.videoUrl.startsWith('blob:')) {
    URL.revokeObjectURL(videoWizardState.videoUrl);
  }
  videoWizardState.videoUrl = URL.createObjectURL(file);

  byId('vw-step-preview').hidden = false;
  byId('vw-preview-video').src = videoWizardState.videoUrl;
  byId('vw-step-audio').hidden = true;
  byId('vw-finish-btn').hidden = true;

  showVideoUploadProgress(0);

  // Browsers frequently report an empty type for .mov, and S3 signs the
  // Content-Type into the presigned PUT, so a mismatch fails the upload silently.
  // Derive the type from the extension when the browser gives nothing.
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  const extTypeMap = {
    mp4: 'video/mp4',
    mov: 'video/quicktime',
    webm: 'video/webm',
    m4v: 'video/x-m4v',
    avi: 'video/x-msvideo',
  };
  const uploadContentType = file.type || extTypeMap[ext] || 'video/mp4';

  try {
    const res = await postJson('/upload-wallpaper', {
      filename: `video-${Date.now()}-${file.name}`,
      content_type: uploadContentType,
    });
    const data = await res.json();
    if (!data.upload_url) {
      showVideoStatus(t('wizard.uploadNoUrl'), 'error');
      hideVideoUploadProgress();
      return;
    }

    await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', data.upload_url);
      xhr.setRequestHeader('Content-Type', uploadContentType);
      xhr.upload.addEventListener('progress', (evt) => {
        if (evt.lengthComputable) {
          showVideoUploadProgress(Math.round((evt.loaded / evt.total) * 100));
        }
      });
      xhr.addEventListener('load', () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          videoWizardState.uploadedVideoKey = data.key;
          showVideoUploadProgress(100);
          setTimeout(() => {
            hideVideoUploadProgress();
            showVideoStatus(t('wizard.uploaded'), 'done');
            document.getElementById('vw-step-audio').hidden = false;
            if (videoWizardState.audioMode === 'native') {
              document.getElementById('vw-finish-btn').hidden = false;
            }
          }, 400);
          resolve();
        } else {
          reject(new Error(`Upload returned status ${xhr.status}`));
        }
      });
      xhr.addEventListener('error', () => reject(new Error('Network error during upload')));
      xhr.addEventListener('abort', () => reject(new Error('Upload aborted')));
      xhr.send(file);
    });
  } catch (err) {
    hideVideoUploadProgress();
    showVideoStatus(t('wizard.uploadFailed', { error: err.message }), 'error');
  }
});

document.querySelectorAll('input[name="vw-audio-mode"]').forEach((radio) => {
  radio.addEventListener('change', (e) => {
    videoWizardState.audioMode = e.target.value;
    const voicePanel = document.getElementById('vw-voice-panel');
    const finishBtn = document.getElementById('vw-finish-btn');
    const transcribeAction = document.getElementById('vw-transcribe-action');
    const textLabel = document.getElementById('vw-text-label');
    const textArea = document.getElementById('vw-narration-text');

    if (e.target.value === 'native') {
      voicePanel.hidden = true;
      finishBtn.hidden = !videoWizardState.uploadedVideoKey;
      return;
    }

    voicePanel.hidden = false;
    populateVwVoicePicker();
    finishBtn.hidden = !videoWizardState.processedAudioUrl;
    document.getElementById('vw-audio-preview').hidden = !videoWizardState.processedAudioUrl;

    if (e.target.value === 'transcribe') {
      textLabel.textContent = t('wizard.transcribedText');
      textArea.placeholder = t('wizard.transcribePlaceholder');
      transcribeAction.hidden = false;
      // The spoken language only matters when transcribing; manual entry is typed
      // directly in the project language.
      document.getElementById('vw-source-language-row').hidden = false;
      // Polishing only applies to transcribed speech; manually typed narration is
      // already written text and needs no filler removal.
      document.getElementById('vw-polish-row').hidden = false;
      renderSourceLanguageSwitch();
      renderVoiceTargetNote();
      if (videoWizardState.transcribedText) textArea.value = videoWizardState.transcribedText;
    } else {
      textLabel.textContent = t('wizard.narrationText');
      textArea.placeholder = t('wizard.manualPlaceholder');
      transcribeAction.hidden = true;
      document.getElementById('vw-source-language-row').hidden = true;
      document.getElementById('vw-polish-row').hidden = true;
      document.getElementById('vw-translation-row').hidden = true;
    }
  });
});

// Editing the text invalidates any synthesized audio, so require re-synthesis.
document.getElementById('vw-narration-text').addEventListener('input', invalidateWizardAudio);

/** Reflect the selected spoken language of the uploaded clip. */
function renderSourceLanguageSwitch() {
  document.querySelectorAll('[data-vw-source-lang]').forEach((button) => {
    button.setAttribute(
      'aria-pressed',
      String(button.dataset.vwSourceLang === videoWizardState.sourceLanguage)
    );
  });
}

/**
 * Note which language the voice-over will be produced in.
 *
 * Only shown when it differs from the spoken language, since that is the case where
 * a user could otherwise be surprised by the output language.
 */
function renderVoiceTargetNote() {
  const note = document.getElementById('vw-voice-target-note');
  if (!note) return;
  if (videoWizardState.sourceLanguage === state.language) {
    note.hidden = true;
    return;
  }
  note.hidden = false;
  note.textContent = t('wizard.voiceTargetNote', {
    target: state.language === 'fr' ? t('language.french') : t('language.english'),
  });
}

document.querySelectorAll('[data-vw-source-lang]').forEach((button) => {
  button.addEventListener('click', () => {
    const next = button.dataset.vwSourceLang;
    if (next === videoWizardState.sourceLanguage) return;
    videoWizardState.sourceLanguage = next;
    renderSourceLanguageSwitch();
    renderVoiceTargetNote();
    // Any existing transcript was produced in the previous language, so it and the
    // audio derived from it are no longer valid.
    videoWizardState.transcribedText = '';
    document.getElementById('vw-narration-text').value = '';
    document.getElementById('vw-translation-row').hidden = true;
    invalidateWizardAudio();
  });
});

/**
 * Discard synthesized audio and require re-synthesis.
 *
 * Called whenever the narration text or its language changes, so the clip that gets
 * attached can never be stale relative to the text on screen.
 */
/**
 * Look up an element that the wizard cannot function without.
 *
 * A missing node here almost always means the browser is running this app.js against an
 * index.html from an earlier deploy, so the element simply does not exist yet. Throwing a
 * named, actionable error beats "Cannot set properties of null", which says nothing about
 * what to do next.
 *
 * @param {string} id Element id.
 * @returns {HTMLElement} The element.
 * @throws {Error} If no element has that id.
 */
function requireEl(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error(t('wizard.staleUi', { id }));
  return el;
}

function invalidateWizardAudio() {
  if (!videoWizardState.processedAudioUrl) return;
  videoWizardState.processedAudioUrl = '';
  videoWizardState.processedAudioKey = '';
  requireEl('vw-audio-preview').hidden = true;
  requireEl('vw-finish-btn').hidden = true;
  requireEl('vw-gen-preview-btn').hidden = true;
  const status = requireEl('vw-synth-status');
  status.textContent = t('wizard.textChanged');
  status.className = 'text-dim';
  requireEl('vw-synthesize-btn').innerHTML = `🔊 ${esc(t('wizard.synthesize'))}`;
}

/**
 * Prepare a raw transcript for re-voicing: translate it into the project language when
 * the clip is in the other one, polish the wording when asked, and report what happened.
 *
 * Both operations run in a single backend call. Translating and then polishing as two
 * passes produces stilted output, because the polish inherits translation artefacts.
 *
 * @param {string} text Transcribed text in the spoken language.
 * @returns {Promise<string>} Narration ready to synthesize, or the original on failure.
 */
async function refineTranscript(text) {
  const source = videoWizardState.sourceLanguage;
  const target = state.language;
  const polishEl = document.getElementById('vw-polish');
  const polish = !!(polishEl && polishEl.checked);
  const row = requireEl('vw-translation-row');
  const statusEl = requireEl('vw-translation-status');
  const retryBtn = requireEl('vw-refine-btn');
  const label = (lang) => (lang === 'fr' ? t('language.french') : t('language.english'));

  row.hidden = false;
  retryBtn.hidden = true;

  const needsTranslation = source !== target;
  if (!needsTranslation && !polish) {
    statusEl.className = 'text-dim';
    statusEl.textContent = t('wizard.refinedNone', { source: label(source) });
    retryBtn.hidden = false;
    return text;
  }

  statusEl.className = 'text-busy';
  statusEl.textContent = `⏳ ${polish ? t('wizard.refining') : t('wizard.translating')}`;

  try {
    const res = await postJson('/refine-narration', {
      text,
      source_language: source,
      target_language: target,
      polish,
    });
    const data = await res.json();
    if (!res.ok || !data.text) throw new Error(data.detail || t('status.failed'));

    const words = t('wizard.wordDelta', {
      before: data.original_words,
      after: data.refined_words,
    });

    // The backend rejects a rewrite that drifts too far from the original length and
    // returns the transcript untouched. Say so rather than implying it was applied.
    const rejected = !data.translated && !data.polished && data.detail;
    if (rejected) {
      statusEl.className = 'text-error';
      statusEl.textContent = `⚠ ${t('wizard.lengthRejected')}`;
    } else {
      statusEl.className = 'text-done';
      let key = 'wizard.refinedNone';
      if (data.translated && data.polished) key = 'wizard.refinedTranslatedPolished';
      else if (data.translated) key = 'wizard.refinedTranslated';
      else if (data.polished) key = 'wizard.refinedPolished';
      statusEl.textContent = `✓ ${t(key, {
        source: label(source),
        target: label(target),
        words,
      })}`;
    }
    retryBtn.hidden = false;
    return data.text;
  } catch (err) {
    // Keep the transcript rather than losing it; the user can edit or retry. Failing
    // the whole flow here would throw away a completed transcription job.
    statusEl.className = 'text-error';
    statusEl.textContent = `✗ ${t('wizard.refineFailed', { error: err.message })}`;
    retryBtn.hidden = false;
    return text;
  }
}

document.getElementById('vw-refine-btn').addEventListener('click', async () => {
  // Always start from the raw transcript, so repeated refining does not compound
  // rewrites of rewrites and drift away from the original meaning.
  const original = videoWizardState.transcribedText;
  if (!original) return;
  const refined = await refineTranscript(original);
  document.getElementById('vw-narration-text').value = refined;
  invalidateWizardAudio();
});

// Changing the polish setting re-runs the refinement from the raw transcript.
document.getElementById('vw-polish').addEventListener('change', async () => {
  const original = videoWizardState.transcribedText;
  if (!original) return;
  const refined = await refineTranscript(original);
  document.getElementById('vw-narration-text').value = refined;
  invalidateWizardAudio();
});

/** Build the voice chips, using the voices valid for the project language. */
function populateVwVoicePicker() {
  const picker = document.getElementById('vw-voice-picker');
  picker.innerHTML = '';
  const voices = state.availableVoices.length
    ? state.availableVoices
    : [{ id: state.selectedVoice, name: state.selectedVoice, desc: '' }];

  if (!voices.some((v) => v.id === videoWizardState.selectedVoice)) {
    videoWizardState.selectedVoice = voices[0].id;
  }

  voices.forEach((v) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = `btn btn-ghost btn-sm vw-voice-chip${
      v.id === videoWizardState.selectedVoice ? ' vw-voice-active' : ''
    }`;
    chip.textContent = v.name;
    chip.title = v.desc || '';
    chip.dataset.voiceId = v.id;
    chip.addEventListener('click', () => {
      videoWizardState.selectedVoice = v.id;
      picker.querySelectorAll('.vw-voice-chip').forEach((c) => c.classList.remove('vw-voice-active'));
      chip.classList.add('vw-voice-active');
    });
    picker.appendChild(chip);
  });
}

async function transcribeVideo() {
  const btn = document.getElementById('vw-transcribe-btn');
  const status = document.getElementById('vw-synth-status');

  if (!videoWizardState.uploadedVideoKey) {
    status.textContent = `⚠ ${t('wizard.stillUploading')}`;
    status.className = 'text-error';
    return;
  }

  btn.innerHTML = `<span class="spinner" style="width:14px;height:14px;border-width:2px;display:inline-block;vertical-align:middle;margin-right:6px;"></span> ${esc(
    t('wizard.transcribing')
  )}`;
  btn.disabled = true;
  btn.style.opacity = '0.7';
  status.textContent = `⏳ ${t('wizard.startingTranscription')}`;
  status.className = 'text-busy';

  try {
    // The SPOKEN language of the clip selects the Transcribe locale, not the project
    // language. Transcribing French audio as en-US produces unusable text.
    const startRes = await postJson('/transcribe-video', {
      video_key: videoWizardState.uploadedVideoKey,
      source_language: videoWizardState.sourceLanguage,
      run_id: state.runId,
    });
    const startData = await startRes.json();
    if (!startData.job_name) throw new Error(startData.detail || t('status.failed'));

    const jobName = startData.job_name;
    status.textContent = `⏳ ${t('wizard.transcribingDetail')}`;

    const maxPollTime = 600000; // 10 minutes
    let elapsed = 0;
    while (elapsed < maxPollTime) {
      await new Promise((r) => setTimeout(r, 3000));
      elapsed += 3000;

      const pollData = await (await postJson('/transcribe-status', { job_name: jobName })).json();

      if (pollData.status === 'COMPLETED') {
        const transcribed = pollData.transcription || '';
        // Keep the raw transcript so a retranslate starts from the source text rather
        // than translating an already-translated string.
        videoWizardState.transcribedText = transcribed;
        btn.innerHTML = `✓ ${esc(t('wizard.transcribed'))}`;
        status.textContent = `✓ ${t('wizard.transcriptionReady')}`;
        status.className = 'text-done';
        btn.disabled = false;
        btn.style.opacity = '';

        // Cross into the project language when the clip is in the other one, so the
        // synthesized voice-over matches the rest of the storyboard.
        const forNarration = await refineTranscript(transcribed);
        document.getElementById('vw-narration-text').value = forNarration;
        invalidateWizardAudio();
        return;
      }
      if (pollData.status === 'FAILED') {
        throw new Error(pollData.detail || t('status.failed'));
      }
      status.textContent = `⏳ ${t('wizard.transcribingElapsed', { seconds: Math.round(elapsed / 1000) })}`;
    }
    throw new Error(t('wizard.transcriptionTimeout'));
  } catch (err) {
    btn.innerHTML = `📝 ${esc(t('wizard.retryTranscription'))}`;
    status.textContent = `✗ ${err.message}`;
    status.className = 'text-error';
  }

  btn.disabled = false;
  btn.style.opacity = '';
}

async function synthesizeVoiceover() {
  const text = document.getElementById('vw-narration-text').value.trim();
  if (!text) {
    showVideoStatus(t('wizard.needText'), 'error');
    return;
  }

  const btn = document.getElementById('vw-synthesize-btn');
  const status = document.getElementById('vw-synth-status');
  const finishBtn = document.getElementById('vw-finish-btn');

  btn.innerHTML = `<span class="spinner" style="width:14px;height:14px;border-width:2px;display:inline-block;vertical-align:middle;margin-right:6px;"></span> ${esc(
    t('wizard.synthesizing')
  )}`;
  btn.disabled = true;
  btn.style.opacity = '0.7';
  status.className = 'text-busy';
  status.textContent = `⏳ ${t('wizard.generatingVoiceover')}`;
  document.getElementById('vw-audio-preview').hidden = true;
  finishBtn.hidden = true;

  try {
    // shot_index 999 marks this as wizard audio rather than a storyboard shot, so the
    // backend does not try to patch it into the manifest.
    const data = await requestAudio({
      shot_index: 999,
      text,
      voice_id: videoWizardState.selectedVoice || state.selectedVoice,
      run_id: state.runId,
      onProgress: (seconds) => {
        status.textContent = `⏳ ${t('wizard.generatingLongVoiceover', { seconds })}`;
      },
    });
    if (!data.audio_url) throw new Error(data.detail || t('status.failed'));

    videoWizardState.processedAudioUrl = data.audio_url;
    videoWizardState.processedAudioKey = data.audio_key || '';
    document.getElementById('vw-audio-player').src = data.audio_url;
    document.getElementById('vw-audio-preview').hidden = false;
    status.className = 'text-done';
    status.textContent = `✓ ${t('wizard.voiceoverReady')}`;
    showVideoStatus('', 'done');
    finishBtn.hidden = false;
    document.getElementById('vw-gen-preview-btn').hidden = false;
  } catch (err) {
    status.className = 'text-error';
    status.textContent = `✗ ${err.message}`;
    showVideoStatus(t('common.error', { error: err.message }), 'error');
    // Leave finish available so the user can retry rather than being stuck.
    finishBtn.hidden = false;
  }

  btn.innerHTML = `🔊 ${esc(t('wizard.reSynthesize'))}`;
  btn.disabled = false;
  btn.style.opacity = '';
}

async function finishVideoWizard() {
  const finishBtn = document.getElementById('vw-finish-btn');
  const audioMode = videoWizardState.audioMode;

  if (audioMode !== 'native' && !videoWizardState.processedAudioUrl) {
    showVideoStatus(t('wizard.synthesizeFirst'), 'error');
    return;
  }

  const original = finishBtn.innerHTML;
  finishBtn.innerHTML = `<span class="spinner" style="width:14px;height:14px;border-width:2px;display:inline-block;vertical-align:middle;margin-right:6px;"></span> ${esc(
    t('wizard.adding')
  )}`;
  finishBtn.disabled = true;

  try {
    const narrationText =
      audioMode === 'native'
        ? t('wizard.nativeAudioLabel')
        : document.getElementById('vw-narration-text').value.trim();

    const videoShot = {
      shot:
        videoWizardState.editingIdx != null
          ? state.shots[videoWizardState.editingIdx].shot
          : state.shots.length + 1,
      title: videoWizardState.file
        ? videoWizardState.file.name.replace(/\.[^.]+$/, '')
        : t('wizard.defaultTitle'),
      image_prompt: '',
      image_url: null,
      image_key: '',
      narration: narrationText,
      audio_url: audioMode === 'native' ? null : videoWizardState.processedAudioUrl,
      audio_key: audioMode === 'native' ? '' : videoWizardState.processedAudioKey,
      video_url: videoWizardState.mergedPreviewUrl || '',
      video_key: videoWizardState.uploadedVideoKey,
      is_video: true,
      audio_mode: audioMode,
      characters_in_shot: [],
      imageStatus: 'done',
      audioStatus: 'done',
      imageLoaded: true,
      audioLoaded: true,
    };

    if (!videoShot.video_url && videoWizardState.uploadedVideoKey) {
      try {
        const urlData = await (
          await postJson('/presign-key', { key: videoWizardState.uploadedVideoKey })
        ).json();
        if (urlData.url) videoShot.video_url = urlData.url;
      } catch {
        // Non-fatal: the storyboard will refresh the URL from the manifest.
      }
    }

    if (videoWizardState.editingIdx != null) {
      state.shots[videoWizardState.editingIdx] = videoShot;
    } else {
      state.shots.push(videoShot);
    }

    renderStoryboard();
    syncStoryboard();
    closeVideoWizard();
    setStatus('done', t('status.videoShotAdded'));
  } catch (err) {
    showVideoStatus(t('common.error', { error: err.message }), 'error');
  }

  finishBtn.innerHTML = original;
  finishBtn.disabled = false;
}

async function generateMergedPreview() {
  const btn = document.getElementById('vw-gen-preview-btn');
  const status = document.getElementById('vw-preview-status');

  if (!videoWizardState.uploadedVideoKey) {
    showVideoStatus(t('wizard.noVideo'), 'error');
    return;
  }
  if (videoWizardState.audioMode !== 'native' && !videoWizardState.processedAudioKey) {
    showVideoStatus(t('wizard.synthesizeFirst'), 'error');
    return;
  }

  btn.innerHTML = `<span class="spinner" style="width:12px;height:12px;border-width:2px;display:inline-block;vertical-align:middle;margin-right:4px;"></span> ${esc(
    t('wizard.generatingPreview')
  )}`;
  btn.disabled = true;
  status.hidden = false;
  status.className = 'text-busy';
  status.textContent = `⏳ ${t('wizard.mergingPreview')}`;

  try {
    const startData = await (
      await postJson('/preview-merge', {
        video_key: videoWizardState.uploadedVideoKey,
        audio_key: videoWizardState.processedAudioKey || '',
        audio_mode: videoWizardState.audioMode,
      })
    ).json();
    if (!startData.preview_id) throw new Error(startData.detail || t('status.failed'));

    const previewId = startData.preview_id;
    const maxPoll = 600000; // 10 minutes
    let elapsed = 0;
    while (elapsed < maxPoll) {
      await new Promise((r) => setTimeout(r, 3000));
      elapsed += 3000;

      const pollData = await (await postJson('/preview-merge-status', { preview_id: previewId })).json();

      if (pollData.status === 'complete' && pollData.preview_url) {
        videoWizardState.mergedPreviewUrl = pollData.preview_url;
        document.getElementById('vw-preview-video').src = pollData.preview_url;
        status.className = 'text-done';
        status.textContent = `✓ ${t('wizard.previewReady')}`;
        btn.innerHTML = `▶ ${esc(t('wizard.regeneratePreview'))}`;
        btn.disabled = false;
        return;
      }
      if (pollData.status === 'error' || pollData.status === 'failed') {
        throw new Error(pollData.detail || t('status.failed'));
      }
      status.textContent = `⏳ ${t('wizard.mergingElapsed', { seconds: Math.round(elapsed / 1000) })}`;
    }
    throw new Error(t('wizard.previewTimeout'));
  } catch (err) {
    status.className = 'text-error';
    status.textContent = `✗ ${err.message}`;
  }

  btn.innerHTML = `▶ ${esc(t('wizard.generatePreview'))}`;
  btn.disabled = false;
}

function showVideoStatus(msg, type) {
  const el = document.getElementById('vw-status');
  if (!msg) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.textContent = msg;
  el.className = type === 'busy' ? 'vw-status-busy' : type === 'error' ? 'vw-status-error' : 'vw-status-done';
}

function showVideoUploadProgress(pct) {
  let bar = document.getElementById('vw-upload-progress');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'vw-upload-progress';
    bar.style.cssText = 'margin-top:.75rem;';
    bar.innerHTML = `
      <div style="display:flex;align-items:center;gap:.75rem;">
        <div class="upload-progress-track" style="flex:1;">
          <div id="vw-upload-progress-fill" class="upload-progress-fill"></div>
        </div>
        <span id="vw-upload-progress-text" class="upload-progress-text">0%</span>
      </div>
      <div class="text-dim" style="font-size:.7rem;margin-top:.25rem;">${esc(t('wizard.uploadingVideo'))}</div>
    `;
    const fileInfo = document.getElementById('vw-file-info');
    fileInfo.parentNode.insertBefore(bar, fileInfo.nextSibling);
  }
  bar.hidden = false;
  const fill = document.getElementById('vw-upload-progress-fill');
  const text = document.getElementById('vw-upload-progress-text');
  if (fill) {
    fill.style.width = `${pct}%`;
    fill.classList.toggle('complete', pct >= 100);
  }
  if (text) text.textContent = `${pct}%`;
}

function hideVideoUploadProgress() {
  const bar = document.getElementById('vw-upload-progress');
  if (bar) bar.hidden = true;
}

// Expose the handlers referenced from inline onclick attributes in index.html.
Object.assign(window, {
  regenerateImage,
  saveAndRegenerateImage,
  regenerateAudio,
  saveAndRegenerateAudio,
  openAiHelp,
  openNarrationAiHelp,
  deleteShot,
  generateNewShot,
  openImportPicker,
  uploadLocalImageToShot,
  openVideoWizard,
  closeVideoWizard,
  transcribeVideo,
  synthesizeVoiceover,
  finishVideoWizard,
  generateMergedPreview,
  restoreRevision,
  jumpToStoryboard,
  downloadVideo,
});
