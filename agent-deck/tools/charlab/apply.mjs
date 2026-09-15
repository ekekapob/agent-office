#!/usr/bin/env node
// tools/charlab/apply.mjs — apply a saved character preset to a theme.
// A preset only carries character data (the nine shared palette keys plus the `figures` block),
// so applying it never touches floors, walls, props, states or text. Room look stays the theme's.
//
//   node tools/charlab/apply.mjs --list
//   node tools/charlab/apply.mjs my-team --theme office            # edit themes/office.json in place
//   node tools/charlab/apply.mjs my-team --theme office --dry      # show what would change
//   node tools/charlab/apply.mjs my-team --theme office --as night # write themes/night.json instead
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePreset, SHARED_KEYS } from './serve.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const PRESETS_DIR = path.join(ROOT, 'presets');
const THEMES_DIR = path.join(ROOT, 'themes');

const argv = process.argv.slice(2);
const flag = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i > -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback; };
const has = (name) => argv.includes(`--${name}`);
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

function list() {
  const names = fs.existsSync(PRESETS_DIR) ? fs.readdirSync(PRESETS_DIR).filter((f) => f.endsWith('.json')) : [];
  if (!names.length) return console.log('no presets yet — run: npm run charlab');
  for (const f of names) {
    const j = readJson(path.join(PRESETS_DIR, f));
    console.log(`${f.slice(0, -5).padEnd(24)} ${j.label || ''}  (${Object.keys(j.figures || {}).length} types)`);
  }
}

/**
 * Merge one preset into one theme object.
 * @returns {{theme:Object, changes:string[]}}
 */
export function applyPreset(theme, preset) {
  const changes = [];
  const out = JSON.parse(JSON.stringify(theme));
  out.palette = out.palette || {};
  for (const k of SHARED_KEYS) {
    const v = preset.palette?.[k];
    if (!v || out.palette[k] === v) continue;
    changes.push(`palette.${k}: ${out.palette[k] || '(default)'} -> ${v}`);
    out.palette[k] = v;
  }
  const before = new Set(Object.keys(out.figures || {}));
  out.figures = JSON.parse(JSON.stringify(preset.figures));
  for (const t of Object.keys(out.figures)) if (!before.has(t)) changes.push(`figures.${t}: added`);
  for (const t of before) if (!out.figures[t]) changes.push(`figures.${t}: removed`);
  for (const t of Object.keys(out.figures)) {
    if (!before.has(t)) continue;
    const a = JSON.stringify(theme.figures[t]), b = JSON.stringify(out.figures[t]);
    if (a !== b) changes.push(`figures.${t}: ${a} -> ${b}`);
  }
  return { theme: out, changes };
}

function main() {
  if (has('list') || !argv.length) return list();
  const name = argv.find((a) => !a.startsWith('--'));
  if (!name) return list();

  const presetFile = path.join(PRESETS_DIR, `${name}.json`);
  if (!fs.existsSync(presetFile)) { console.error(`no preset "${name}" in presets/`); process.exit(1); }
  const v = validatePreset(readJson(presetFile), name);
  if (!v.ok) { console.error(`preset "${name}" is not valid:\n  ${v.problems.join('\n  ')}`); process.exit(1); }

  const themeName = flag('theme', 'office');
  const themeFile = path.join(THEMES_DIR, `${themeName}.json`);
  if (!fs.existsSync(themeFile)) { console.error(`no theme "${themeName}" in themes/`); process.exit(1); }

  const { theme, changes } = applyPreset(readJson(themeFile), v.preset);
  const asName = flag('as', null);
  if (asName) { theme.name = asName; theme.label = theme.label ? `${theme.label} · ${v.preset.label}` : asName; }
  const target = path.join(THEMES_DIR, `${asName || themeName}.json`);

  console.log(`preset ${name} -> ${path.relative(ROOT, target).split(path.sep).join('/')}`);
  console.log(changes.length ? changes.map((c) => `  ${c}`).join('\n') : '  (no change)');
  if (has('dry')) return console.log('\n--dry: nothing written');

  fs.writeFileSync(target, `${JSON.stringify(theme, null, 2)}\n`, 'utf8');
  console.log(`\nwritten. ${asName ? `Add { name: '${asName}', label: '...' } to THEMES in web/js/main.js to show it in the picker.` : 'Reload Agent Deck to see it.'}`);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
