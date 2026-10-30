// Player settings saved in the browser.
const DEFAULTS = {
  sens: 1.0,          // mouse sensitivity
  fov: 80,
  renderScale: 0.75,  // lower = faster on weak GPUs
  viewDist: 110,
  volume: 0.6,
  crossColor: '#33ff33',
  crossSize: 6,
  crossGap: 3,
  showFps: false,
  viewmodel: true,
  fullscreen: true,   // fullscreen + keyboard lock so Ctrl+W (crouch + forward) can't close the tab
};

export const settings = { ...DEFAULTS };
try { Object.assign(settings, JSON.parse(localStorage.getItem('strikelite.settings') || '{}')); } catch { /* ignore */ }

export function saveSettings() {
  try { localStorage.setItem('strikelite.settings', JSON.stringify(settings)); } catch { /* ignore */ }
}

const SPEC = [
  ['sens', 'Mouse sensitivity', 0.1, 5, 0.05],
  ['fov', 'Field of view', 60, 110, 1],
  ['renderScale', 'Render scale (lower = more FPS)', 0.35, 1, 0.05],
  ['viewDist', 'View distance', 40, 160, 5],
  ['volume', 'Volume', 0, 1, 0.05],
  ['crossSize', 'Crosshair length', 2, 14, 1],
  ['crossGap', 'Crosshair gap', 0, 10, 1],
];

// Build the settings UI into a container; onChange is called after any change.
export function buildSettingsUI(el, onChange) {
  el.innerHTML = '';
  for (const [key, label, min, max, step] of SPEC) {
    const row = document.createElement('div');
    row.className = 'setting';
    row.innerHTML = `<span>${label}</span><input type="range" min="${min}" max="${max}" step="${step}"><b></b>`;
    const input = row.querySelector('input'), val = row.querySelector('b');
    input.value = settings[key];
    val.textContent = settings[key];
    input.oninput = () => { settings[key] = parseFloat(input.value); val.textContent = settings[key]; saveSettings(); onChange && onChange(); };
    el.appendChild(row);
  }
  const extra = document.createElement('div');
  extra.className = 'setting';
  extra.innerHTML = '<span>Crosshair color</span><input type="color"><b></b>';
  const c = extra.querySelector('input');
  c.value = settings.crossColor;
  c.oninput = () => { settings.crossColor = c.value; saveSettings(); onChange && onChange(); };
  el.appendChild(extra);
  for (const [key, label] of [['showFps', 'Show FPS'], ['viewmodel', 'Show weapon model'], ['fullscreen', 'Fullscreen while playing (stops Ctrl+W closing the game)']]) {
    const r = document.createElement('div');
    r.className = 'setting';
    r.innerHTML = `<span>${label}</span><input type="checkbox" style="justify-self:start"><b></b>`;
    const cb = r.querySelector('input');
    cb.checked = settings[key];
    cb.onchange = () => { settings[key] = cb.checked; saveSettings(); onChange && onChange(); };
    el.appendChild(r);
  }
}
