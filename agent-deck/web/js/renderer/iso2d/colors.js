// Resolves a theme JSON (CONTRACTS §7) into the flat colour table the iso2d renderer draws with.
// Every colour the renderer uses comes from here: §7 keys straight from the theme, plus optional fine-detail keys
// (theme.palette.<key> for single colours, theme.props.<key> for [top,left,right] triples) that default to the
// spaceship look. Missing or malformed keys fall back to spaceship values, as §7 requires.
import { dim } from './primitives.js';

const SPACESHIP = {
  palette: {
    floor1: '#2a3242', floor2: '#303a4d', grout: '#1c2230', aisle1: '#12424f', aisle2: '#155062',
    wall: '#3a4658', wall2: '#44526a', wainscot: '#2b3546', trim: '#19d3e6', trimDim: '#0e7f8c',
    steel1: '#5b6a80', steel2: '#3f4b5e', steel3: '#2e3747', base1: '#1a212e', base2: '#131924',
    glass: '#7fe7ff', pod1: '#1e3a44', pod2: '#22414c', podGrout: '#142a31', bg: '#04070f',
  },
  props: { desk: ['#4a5870', '#34405a', '#262f45'], chair: ['#5b6a80', '#3f4b5e', '#2e3747'], table: ['#2a6d78', '#1e515a', '#163d44'] },
  figures: {
    lead: { shirt: '#3b4fd8', hair: '#2b1d0e', pants: '#26305c', acc: 'tie', crown: true },
    default: { shirt: '#7f8ba6', hair: '#3a2a1a', pants: '#2b3a4b', acc: null },
  },
  states: { working: '#3ddc97', thinking: '#6aa6ff', waiting: '#ffb347', idle: '#7f8ba6', done: '#b48cff', joining: '#b48cff', leaving: '#b48cff', compacting: '#ff4d4d', teleporting: '#7fe7ff' },
  features: { stars: true, viewports: true, planet: true },
};

/** Optional single colours, read from theme.palette.<key>; defaults reproduce the mockup. */
const DETAIL = {
  skin: '#f2c9a0', outline: '#0a0f1e', ink: '#111111', white: '#ffffff', shadow: '#000000',
  space: '#03060f', starDim: '#3a4a6a', starBright: '#6a7aa0', starTint: '#8fa3ff',
  screenIdle: '#1b2340', monitorRim: '#2a3563', monitorStand: '#333333',
  doorPanel: '#141b2a', hazard: '#ffcc33', doorWindow: '#0b2a33', holoScreen: '#07202a', signPlate: '#0a1220',
  podBase1: '#0f1e22', podBase2: '#0a1518', padCore: '#0e3d4a', chipInk: '#0a2a33', ledOff: '#22304f', ledSlot: '#0e1424',
  steam: '#c9d3f5', hat: '#ffcc33', cap: '#2f9e6b', gold: '#e0b354', tie: '#ffd166', lens: '#dfe6ee', jewel: '#ff4d4d',
  portraitBg: '#141b36', portraitFloor1: '#2f3a63', portraitFloor2: '#343f6b',
};

/** Optional colour triples, read from theme.props.<key>. */
const TRIPLES = { monitor: ['#3a4468', '#1e2540', '#151a2e'], leaf: ['#2f7a2a', '#3a9a3a', '#4bb04b'], planet: ['#d9772f', '#f0a35a', '#b85f22'] };

const HEX = /^#[0-9a-fA-F]{6}$/;
const hex = (v, fb) => (typeof v === 'string' && HEX.test(v) ? v : fb);
const triple = (v, fb) => (Array.isArray(v) && v.length >= 3 && v.slice(0, 3).every((c) => HEX.test(String(c))) ? v.slice(0, 3) : fb);
const obj = (v) => (v && typeof v === 'object' ? v : {});

/**
 * Colour table for one theme. Plain data plus `figureOf(person)`.
 * @param {Object} theme theme JSON per CONTRACTS §7 (may be partial)
 * @returns {Object} C — palette keys, detail keys, prop triples, `states`, `figures`, `features`, `figureOf`
 */
export function resolveColors(theme) {
  const t = obj(theme), pal = obj(t.palette), props = obj(t.props), figs = obj(t.figures);
  const C = {};
  for (const k in SPACESHIP.palette) C[k] = hex(pal[k], SPACESHIP.palette[k]);
  for (const k in DETAIL) C[k] = hex(pal[k], DETAIL[k]);
  for (const k in TRIPLES) C[k] = triple(props[k], TRIPLES[k]);
  for (const k in SPACESHIP.props) C[k] = triple(props[k], SPACESHIP.props[k]);
  const steel = [C.steel1, C.steel2, C.steel3];
  C.stool = triple(props.stool, steel);
  C.dispenser = triple(props.dispenser, steel);
  C.core = triple(props.core, C.desk);
  C.plant = triple(props.plant, C.desk);
  C.pad = triple(props.pad, C.desk);
  C.laptop = triple(props.laptop, C.desk);
  C.beam = triple(props.beam, [C.glass, dim(C.glass, 0.85), dim(C.glass, 0.66)]);
  C.tube = triple(props.tube, [C.glass, dim(C.glass, 0.78), dim(C.glass, 0.58)]);
  C.states = { ...SPACESHIP.states };
  for (const k in obj(t.states)) C.states[k] = hex(t.states[k], C.states[k] || SPACESHIP.states.idle);
  C.features = { ...SPACESHIP.features, ...obj(t.features) };
  const figures = {};
  for (const k in figs) figures[k] = figurePalette(figs[k], SPACESHIP.figures.default);
  if (!figures.lead) figures.lead = SPACESHIP.figures.lead;
  if (!figures.default) figures.default = SPACESHIP.figures.default;
  C.figures = figures;
  /** Figure palette for a scene person: by type, else lead/default. */
  C.figureOf = (person) => figures[person.type] || (person.isLead ? figures.lead : figures.default) || figures.default;
  return C;
}

function figurePalette(f, fb) {
  const o = obj(f);
  return { shirt: hex(o.shirt, fb.shirt), hair: hex(o.hair, fb.hair), pants: hex(o.pants, fb.pants), acc: typeof o.acc === 'string' ? o.acc : null, crown: !!o.crown };
}
