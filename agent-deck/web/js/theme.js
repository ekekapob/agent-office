// Theme loader (CONTRACTS §7). Fetches themes/<name>.json, validates every key
// and fills anything missing or malformed from the built-in spaceship theme.
// Never throws: a failed load returns spaceship with `loadError` set.

/** @typedef {{shirt:string, hair:string, pants:string, acc:string|null, crown?:boolean}} FigurePalette */
/**
 * @typedef {Object} Theme
 * @property {string} name
 * @property {string} label
 * @property {Object<string,string>} palette
 * @property {Object<string,string[]>} props
 * @property {Object<string,FigurePalette>} figures
 * @property {Object<string,string>} states
 * @property {Object<string,{chip:string,color:string}>} models
 * @property {Object<string,string>} text
 * @property {Object<string,boolean>} features
 * @property {string} [loadError]
 */

/** @type {Theme} Built-in default; themes/spaceship.json mirrors it. */
export const SPACESHIP = Object.freeze({
  name: 'spaceship', label: 'Spaceship deck',
  palette: { floor1: '#2a3242', floor2: '#303a4d', grout: '#1c2230', aisle1: '#12424f', aisle2: '#155062', wall: '#3a4658', wall2: '#44526a', wainscot: '#2b3546', trim: '#19d3e6', trimDim: '#0e7f8c', steel1: '#5b6a80', steel2: '#3f4b5e', steel3: '#2e3747', base1: '#1a212e', base2: '#131924', glass: '#7fe7ff', pod1: '#1e3a44', pod2: '#22414c', podGrout: '#142a31', bg: '#04070f' },
  props: { desk: ['#4a5870', '#34405a', '#262f45'], chair: ['#5b6a80', '#3f4b5e', '#2e3747'], table: ['#2a6d78', '#1e515a', '#163d44'] },
  figures: {
    lead: { shirt: '#3b4fd8', hair: '#2b1d0e', pants: '#26305c', acc: 'tie', crown: true },
    Explore: { shirt: '#2f9e6b', hair: '#5a3a1a', pants: '#2b3a4b', acc: 'cap' },
    Plan: { shirt: '#7b5bd6', hair: '#8a8a8a', pants: '#3a2a5a', acc: 'glasses' },
    'general-purpose': { shirt: '#e07a2f', hair: '#1a1a1a', pants: '#3a2a1a', acc: 'hat' },
    'code-review': { shirt: '#d64b4b', hair: '#3a2a1a', pants: '#2a1a1a', acc: 'badge' },
    default: { shirt: '#7f8ba6', hair: '#3a2a1a', pants: '#2b3a4b', acc: null },
  },
  states: { working: '#3ddc97', thinking: '#6aa6ff', waiting: '#ffb347', idle: '#7f8ba6', done: '#b48cff', joining: '#b48cff', leaving: '#b48cff', compacting: '#ff4d4d', teleporting: '#7fe7ff' },
  models: { 'claude-fable-5-1': { chip: 'F5.1', color: '#e0b354' }, 'claude-opus-5': { chip: 'O5', color: '#b48cff' }, 'claude-sonnet-5': { chip: 'S5', color: '#6aa6ff' }, 'claude-haiku-4-5-20251001': { chip: 'H4.5', color: '#3ddc97' } },
  text: { deck: 'DECK 1', door: 'AIRLOCK', board: 'ASSIGNMENT', pod: 'HUDDLE', pad: 'TRANSPORTER' },
  features: { stars: true, viewports: true, planet: true },
});

const COLOR_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const isColor = (v) => typeof v === 'string' && COLOR_RE.test(v);
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

/**
 * Validate a raw theme object against the spaceship defaults. Bad values are
 * replaced and listed in `problems` (for the error reporter).
 * @param {any} raw
 * @param {string} name
 * @returns {{theme:Theme, problems:string[]}}
 */
export function validateTheme(raw, name) {
  const problems = [], base = SPACESHIP, src = isObj(raw) ? raw : {};
  if (!isObj(raw)) problems.push('theme is not an object');
  const strMap = (key, check, label) => {
    const out = { ...base[key] }, s = isObj(src[key]) ? src[key] : {};
    if (src[key] !== undefined && !isObj(src[key])) problems.push(`${key} is not an object`);
    for (const [k, v] of Object.entries(s)) { if (check(v)) out[k] = v; else problems.push(`${key}.${k} is not a ${label}`); }
    return out;
  };
  const props = { ...base.props }, ps = isObj(src.props) ? src.props : {};
  for (const [k, v] of Object.entries(ps)) { if (Array.isArray(v) && v.length === 3 && v.every(isColor)) props[k] = v.slice(); else problems.push(`props.${k} must be three colours`); }
  const figures = { ...base.figures }, fs = isObj(src.figures) ? src.figures : {};
  for (const [k, v] of Object.entries(fs)) {
    if (!isObj(v) || !isColor(v.shirt) || !isColor(v.hair) || !isColor(v.pants)) { problems.push(`figures.${k} needs shirt, hair and pants colours`); continue; }
    figures[k] = { shirt: v.shirt, hair: v.hair, pants: v.pants, acc: typeof v.acc === 'string' ? v.acc : null, crown: !!v.crown };
  }
  const models = { ...base.models }, ms = isObj(src.models) ? src.models : {};
  for (const [k, v] of Object.entries(ms)) { if (isObj(v) && typeof v.chip === 'string' && isColor(v.color)) models[k] = { chip: v.chip, color: v.color }; else problems.push(`models.${k} needs chip and color`); }
  const theme = {
    ...src, // unknown top-level keys pass through untouched
    name: typeof src.name === 'string' && src.name ? src.name : name,
    label: typeof src.label === 'string' && src.label ? src.label : name,
    palette: strMap('palette', isColor, 'colour'), props, figures,
    states: strMap('states', isColor, 'colour'), models,
    text: strMap('text', (v) => typeof v === 'string', 'string'),
    features: strMap('features', (v) => typeof v === 'boolean', 'boolean'),
  };
  return { theme, problems };
}

/**
 * Load and validate a theme. Missing keys fall back to spaceship; a failed fetch
 * returns spaceship with `loadError` describing why. Never rejects.
 * @param {string} name
 * @param {string} [baseUrl='themes/']
 * @param {{fetchImpl?:typeof fetch}} [opts]
 * @returns {Promise<Theme>}
 */
export async function loadTheme(name, baseUrl = 'themes/', opts = {}) {
  const safe = /^[\w-]+$/.test(name || '') ? name : 'spaceship';
  const f = opts.fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!f) return { ...SPACESHIP, loadError: 'fetch is not available' };
  try {
    const res = await f(`${baseUrl}${safe}.json`, { cache: 'no-cache' });
    if (!res.ok) return { ...SPACESHIP, loadError: `theme ${safe}: HTTP ${res.status}` };
    const raw = await res.json();
    const { theme, problems } = validateTheme(raw, safe);
    if (problems.length) theme.loadError = `theme ${safe}: ${problems.slice(0, 3).join('; ')}${problems.length > 3 ? ` (+${problems.length - 3})` : ''}`;
    return theme;
  } catch (err) {
    return { ...SPACESHIP, loadError: `theme ${safe}: ${err && err.message ? err.message : err}` };
  }
}

/** Colour for an agent/presentation state. @param {Theme} theme @param {string} state */
export function stateColor(theme, state) {
  const s = theme && theme.states ? theme.states : SPACESHIP.states;
  return s[state] || SPACESHIP.states[state] || s.idle || SPACESHIP.states.idle;
}

/**
 * Chip label and colour for a model id. Exact key first, then prefix match,
 * then a chip derived from the name (claude-opus-4-1 → O4.1).
 * @param {Theme} theme @param {string|null} model @returns {{chip:string,color:string}}
 */
export function modelChip(theme, model) {
  const m = theme && theme.models ? theme.models : SPACESHIP.models;
  if (!model) return { chip: '?', color: '#7f8ba6' };
  if (m[model]) return m[model];
  const key = Object.keys(m).find((k) => model.startsWith(k) || k.startsWith(model));
  if (key) return m[key];
  const parts = model.replace(/^claude-/, '').split('-'), fam = parts[0] || '?';
  const nums = parts.slice(1).filter((p) => /^\d{1,2}$/.test(p)).join('.');
  return { chip: (fam[0] || '?').toUpperCase() + nums, color: '#7f8ba6' };
}

/** Figure palette for an agent type, falling back to `default`. @param {Theme} theme @param {string} type */
export function figurePalette(theme, type) {
  const f = theme && theme.figures ? theme.figures : SPACESHIP.figures;
  return f[type] || f.default || SPACESHIP.figures.default;
}
