/**
 * Video AI Orchestrator (VAIO) — theme switching
 *
 * Three settings, two rendered themes. "system" follows the OS preference and keeps
 * following it if the OS flips while the console is open; "light" and "dark" pin the
 * choice.
 *
 * The resolved theme is written to <html data-theme="light|dark">. All colour values
 * live in CSS custom properties scoped to that attribute, so switching is a single
 * attribute write with no re-render and no flash.
 *
 * Loaded as a blocking script in <head> — before any styled markup is parsed — so the
 * correct palette is in place on first paint. A deferred script would show a dark
 * flash to light-theme users.
 */

const THEME_STORAGE_KEY = 'vaio.theme';
const THEME_SETTINGS = ['light', 'dark', 'system'];
const DEFAULT_THEME_SETTING = 'system';

/** Media query used to read and watch the OS colour-scheme preference. */
const darkSchemeQuery =
  typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null;

/**
 * Read the persisted theme setting.
 *
 * @returns {'light'|'dark'|'system'} The stored setting, or the default.
 */
function readStoredSetting() {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored && THEME_SETTINGS.includes(stored)) return stored;
  } catch {
    // Private browsing can make localStorage throw; use the default.
  }
  return DEFAULT_THEME_SETTING;
}

let themeSetting = readStoredSetting();

/**
 * Resolve a setting into the theme actually rendered.
 *
 * @param {'light'|'dark'|'system'} setting The user's setting.
 * @returns {'light'|'dark'} The concrete theme.
 */
function resolveTheme(setting) {
  if (setting === 'light' || setting === 'dark') return setting;
  return darkSchemeQuery && darkSchemeQuery.matches ? 'dark' : 'light';
}

/**
 * Write the resolved theme to the document and notify listeners.
 *
 * @param {boolean} [notify=true] Whether to dispatch the change event.
 */
function applyTheme(notify = true) {
  const resolved = resolveTheme(themeSetting);
  const root = document.documentElement;
  root.setAttribute('data-theme', resolved);
  // Lets the browser style form controls, scrollbars, and the caret to match.
  root.style.colorScheme = resolved;

  if (notify) {
    window.dispatchEvent(
      new CustomEvent('vaio-theme-changed', { detail: { setting: themeSetting, resolved } })
    );
  }
}

/**
 * Change the theme setting and apply it.
 *
 * @param {'light'|'dark'|'system'} setting Requested setting.
 */
function setTheme(setting) {
  const next = THEME_SETTINGS.includes(setting) ? setting : DEFAULT_THEME_SETTING;
  themeSetting = next;
  try {
    localStorage.setItem(THEME_STORAGE_KEY, next);
  } catch {
    // Non-fatal: the choice just will not survive a reload.
  }
  applyTheme();
}

/**
 * Cycle light -> dark -> system, for a single toggle control.
 *
 * @returns {'light'|'dark'|'system'} The new setting.
 */
function cycleTheme() {
  const order = ['light', 'dark', 'system'];
  const next = order[(order.indexOf(themeSetting) + 1) % order.length];
  setTheme(next);
  return next;
}

/** @returns {'light'|'dark'|'system'} The current setting. */
function getThemeSetting() {
  return themeSetting;
}

/** @returns {'light'|'dark'} The theme currently rendered. */
function getResolvedTheme() {
  return resolveTheme(themeSetting);
}

// Follow the OS while the setting is "system".
if (darkSchemeQuery) {
  const onSchemeChange = () => {
    if (themeSetting === 'system') applyTheme();
  };
  if (typeof darkSchemeQuery.addEventListener === 'function') {
    darkSchemeQuery.addEventListener('change', onSchemeChange);
  } else if (typeof darkSchemeQuery.addListener === 'function') {
    // Safari < 14 only supports the deprecated listener API.
    darkSchemeQuery.addListener(onSchemeChange);
  }
}

window.VaioTheme = {
  setTheme,
  cycleTheme,
  getThemeSetting,
  getResolvedTheme,
  THEME_SETTINGS,
};

// Apply immediately, before first paint. No event on this pass: nothing is listening
// yet, and firing would be misleading.
applyTheme(false);
