// tests/charlab.test.js — Character Lab preset validation and theme merge (tools/charlab/).
// Pure data work: no server is started and no file is written.
import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePreset, ACCESSORIES, OUTFITS, HEADS, FACES, SHARED_KEYS } from '../tools/charlab/serve.mjs';
import { applyPreset } from '../tools/charlab/apply.mjs';

const GOOD = {
  label: 'Night shift',
  palette: { skin: '#F2C9A0', outline: '#0a0f1e' },
  figures: {
    lead: { shirt: '#3b4fd8', hair: '#2b1d0e', pants: '#26305c', acc: 'tie', crown: true },
    Explore: { shirt: '#2f9e6b', hair: '#5a3a1a', pants: '#2b3a4b', acc: null },
  },
};

// ---------------------------------------------------------------- validatePreset

test('a good preset passes and is normalised', () => {
  const v = validatePreset(GOOD, 'night-shift');
  assert.ok(v.ok);
  assert.equal(v.preset.kind, 'agentdeck-character-preset');
  assert.equal(v.preset.name, 'night-shift');
  assert.equal(v.preset.label, 'Night shift');
  assert.equal(v.preset.palette.skin, '#f2c9a0', 'colours are lowercased');
  assert.equal(v.preset.figures.lead.crown, true);
  assert.equal(v.preset.figures.Explore.acc, null);
});

test('the name must be a slug', () => {
  for (const bad of ['Night Shift', '../escape', '', 'a'.repeat(41)]) {
    assert.equal(validatePreset(GOOD, bad).ok, false, `expected reject: ${bad}`);
  }
  assert.ok(validatePreset(GOOD, 'night-shift-2').ok);
});

test('a colour that is not #rrggbb is rejected', () => {
  const v = validatePreset({ figures: { lead: { shirt: 'red', hair: '#000000', pants: '#000000' } } }, 'x');
  assert.equal(v.ok, false);
  assert.ok(v.problems.some((p) => p.includes('figures.lead.shirt')));
});

test('only accessories the renderer draws are accepted', () => {
  for (const acc of ACCESSORIES) {
    assert.ok(validatePreset({ figures: { a: { shirt: '#000000', hair: '#000000', pants: '#000000', acc } } }, 'x').ok, acc);
  }
  assert.equal(validatePreset({ figures: { a: { shirt: '#000000', hair: '#000000', pants: '#000000', acc: 'cape' } } }, 'x').ok, false);
});

test('a room colour in a preset is dropped, not saved', () => {
  const v = validatePreset({ ...GOOD, palette: { ...GOOD.palette, bg: '#000000', floor1: '#111111' } }, 'x');
  assert.ok(v.ok, 'dropping is not a failure');
  assert.equal(v.preset.palette.bg, undefined);
  assert.equal(v.preset.palette.floor1, undefined);
  assert.equal(v.problems.length, 2);
  for (const k of Object.keys(v.preset.palette)) assert.ok(SHARED_KEYS.includes(k), k);
});

test('a preset with no agent types is rejected', () => {
  assert.equal(validatePreset({ figures: {} }, 'x').ok, false);
});

// ---------------------------------------------------------------- outfit and head

const BODY = { shirt: '#000000', hair: '#000000', pants: '#000000' };

test('every outfit and head the renderer draws is accepted', () => {
  for (const outfit of OUTFITS) {
    assert.ok(validatePreset({ figures: { a: { ...BODY, outfit } } }, 'x').ok, outfit);
  }
  for (const head of HEADS) {
    assert.ok(validatePreset({ figures: { a: { ...BODY, head } } }, 'x').ok, head);
  }
});

test('an outfit or head the renderer cannot draw is rejected', () => {
  const o = validatePreset({ figures: { a: { ...BODY, outfit: 'spacesuit' } } }, 'x');
  assert.equal(o.ok, false);
  assert.ok(o.problems[0].includes('spacesuit'));
  const h = validatePreset({ figures: { a: { ...BODY, head: 'dragon' } } }, 'x');
  assert.equal(h.ok, false);
  assert.ok(h.problems[0].includes('dragon'));
});

test('a figure with no outfit, head or face gets the plain defaults', () => {
  const v = validatePreset({ figures: { a: BODY } }, 'x');
  assert.ok(v.ok);
  assert.equal(v.preset.figures.a.outfit, 'shirt');
  assert.equal(v.preset.figures.a.head, 'human');
  assert.equal(v.preset.figures.a.face, 'plain');
});

test('every face the renderer draws is accepted and a made-up one is not', () => {
  for (const face of FACES) assert.ok(validatePreset({ figures: { a: { ...BODY, face } } }, 'x').ok, face);
  const bad = validatePreset({ figures: { a: { ...BODY, face: 'grimace' } } }, 'x');
  assert.equal(bad.ok, false);
  assert.ok(bad.problems[0].includes('grimace'));
});

test('the turtleneck, swept head and john face survive a save', () => {
  const v = validatePreset({ figures: { lead: { ...BODY, outfit: 'turtleneck', head: 'swept', face: 'john', acc: 'glasses' } } }, 'john');
  assert.ok(v.ok);
  assert.deepEqual(v.preset.figures.lead, { ...BODY, acc: 'glasses', outfit: 'turtleneck', head: 'swept', face: 'john' });
});

// ---------------------------------------------------------------- applyPreset

test('applying a preset changes characters and leaves the room alone', () => {
  const theme = {
    name: 'office',
    palette: { floor1: '#343f6b', wall: '#3a4780', skin: '#000000' },
    props: { desk: ['#a8733a', '#7a5230', '#5b3c22'] },
    figures: { lead: { shirt: '#111111', hair: '#111111', pants: '#111111', acc: null }, old: { shirt: '#222222', hair: '#222222', pants: '#222222', acc: null } },
    text: { deck: 'OFFICE' },
  };
  const { preset } = validatePreset(GOOD, 'night-shift');
  const { theme: out, changes } = applyPreset(theme, preset);

  assert.equal(out.palette.floor1, '#343f6b', 'floor untouched');
  assert.equal(out.palette.wall, '#3a4780', 'wall untouched');
  assert.deepEqual(out.props.desk, theme.props.desk, 'props untouched');
  assert.deepEqual(out.text, theme.text, 'text untouched');

  assert.equal(out.palette.skin, '#f2c9a0', 'skin comes from the preset');
  assert.equal(out.figures.lead.shirt, '#3b4fd8');
  assert.ok(out.figures.Explore, 'new type added');
  assert.equal(out.figures.old, undefined, 'type missing from the preset is removed');
  assert.ok(changes.some((c) => c.startsWith('figures.Explore: added')));
  assert.ok(changes.some((c) => c.startsWith('figures.old: removed')));
});

test('applying the same preset twice changes nothing the second time', () => {
  const theme = { palette: {}, figures: {} };
  const { preset } = validatePreset(GOOD, 'night-shift');
  const once = applyPreset(theme, preset).theme;
  const twice = applyPreset(once, preset);
  assert.equal(twice.changes.length, 0);
  assert.deepEqual(twice.theme, once);
});
