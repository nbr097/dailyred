#!/usr/bin/env node
// Writes web/game/editor-data.json for the hidden team editor: every Gen 1-3
// species (base stats and learnable moves), every move, every item with a
// hold effect, and the natures. It parses the decomp's own data files, so the
// editor always matches the ROM that scripts/build-rom.sh builds.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GAME = join(ROOT, 'pokefirered');
const OUT = join(ROOT, 'web', 'game', 'editor-data.json');

// Keeps only the FIRERED side of `#if defined(FIRERED)` / LEAFGREEN blocks.
function fireRedOnly(text) {
  const out = [];
  const stack = [];
  for (const line of text.split('\n')) {
    const directive = line.match(/^\s*#\s*(if|ifdef|elif|else|endif)\b(.*)/);
    if (!directive) {
      if (stack.every(Boolean)) out.push(line);
      continue;
    }
    const [, kind, rest] = directive;
    const cond = rest.includes('FIRERED') ? true : rest.includes('LEAFGREEN') ? false : true;
    if (kind === 'if' || kind === 'ifdef') stack.push(cond);
    else if (kind === 'elif') stack[stack.length - 1] = cond && !stack.at(-1);
    else if (kind === 'else') stack[stack.length - 1] = !stack.at(-1);
    else stack.pop();
  }
  return out.join('\n');
}
const read = (file) => fireRedOnly(readFileSync(join(GAME, file), 'utf8'));
const defines = (file, prefix) => new Map(
  [...read(file).matchAll(new RegExp(`^#define ${prefix}_(\\w+)\\s+(\\d+)\\b`, 'gm'))].map((m) => [m[1], Number(m[2])]),
);
const text = (s) => s.replace(/\\n/g, ' ');

const speciesIds = defines('include/constants/species.h', 'SPECIES');
const moveIds = defines('include/constants/moves.h', 'MOVE');
const itemIds = defines('include/constants/items.h', 'ITEM');
const numSpecies = speciesIds.get('EGG'); // NUM_SPECIES

const speciesNames = new Map([...read('src/data/text/species_names.h').matchAll(/\[SPECIES_(\w+)\]\s*=\s*_\("([^"]*)"\)/g)].map((m) => [m[1], m[2]]));
const moveNames = new Map([...read('src/data/text/move_names.h').matchAll(/\[MOVE_(\w+)\]\s*=\s*_\("([^"]*)"\)/g)].map((m) => [m[1], m[2]]));

// Base stats, in the game's stat order: HP, Atk, Def, Spe, SpA, SpD.
const baseStats = new Map();
for (const block of read('src/data/pokemon/species_info.h').split(/\n\s*\[SPECIES_/).slice(1)) {
  const name = block.match(/^(\w+)\]/)[1];
  const stat = (key) => Number(block.match(new RegExp(`\\.${key}\\s*=\\s*(\\d+)`))?.[1] ?? 0);
  baseStats.set(name, [stat('baseHP'), stat('baseAttack'), stat('baseDefense'), stat('baseSpeed'), stat('baseSpAttack'), stat('baseSpDefense')]);
}

// Moves a species can learn by level-up or TM/HM.
const levelUpArrays = new Map();
for (const m of read('src/data/pokemon/level_up_learnsets.h').matchAll(/static const u16 (\w+)\[\] = \{([^}]*)\}/g)) {
  levelUpArrays.set(m[1], [...m[2].matchAll(/MOVE_(\w+)/g)].map((x) => moveIds.get(x[1])));
}
const levelUp = new Map();
for (const m of read('src/data/pokemon/level_up_learnset_pointers.h').matchAll(/\[SPECIES_(\w+)\]\s*=\s*(\w+)/g)) {
  levelUp.set(m[1], levelUpArrays.get(m[2]) ?? []);
}
const tmTable = read('src/data/party_menu.h').match(/static const u16 sTMHMMoves\[\] =\s*\{([^}]*)\}/)[1];
const tmMoves = [...tmTable.matchAll(/MOVE_(\w+)/g)].map((x) => moveIds.get(x[1]));
const tmhm = new Map();
for (const block of read('src/data/pokemon/tmhm_learnsets.h').split(/\n\s*\[SPECIES_/).slice(1)) {
  const name = block.match(/^(\w+)\]/)[1];
  tmhm.set(name, [...block.matchAll(/TMHM\((TM|HM)(\d\d)_/g)].map((x) => tmMoves[(x[1] === 'HM' ? 50 : 0) + Number(x[2]) - 1]));
}

const species = [];
for (const [name, id] of speciesIds) {
  // Same rule as IsEligibleSpecies in dailyred_team.c.
  if (id < 1 || id >= numSpecies || (id >= speciesIds.get('OLD_UNOWN_B') && id <= speciesIds.get('OLD_UNOWN_Z'))) continue;
  if (!speciesNames.has(name) || !baseStats.has(name)) continue;
  const learnable = [...new Set([...(levelUp.get(name) ?? []), ...(tmhm.get(name) ?? [])])].filter((x) => x > 0).sort((a, b) => a - b);
  species.push({ id, name: speciesNames.get(name), base: baseStats.get(name), moves: learnable });
}
species.sort((a, b) => a.id - b.id);

const battleMoves = new Map();
for (const block of read('src/data/battle_moves.h').split(/\n\s*\[MOVE_/).slice(1)) {
  const name = block.match(/^(\w+)\]/)[1];
  battleMoves.set(name, {
    power: Number(block.match(/\.power\s*=\s*(\d+)/)?.[1] ?? 0),
    type: block.match(/\.type\s*=\s*TYPE_(\w+)/)?.[1] ?? 'NORMAL',
  });
}
const moves = [];
for (const [name, id] of moveIds) {
  if (id < 1 || !moveNames.has(name) || !battleMoves.has(name)) continue;
  moves.push({ id, name: moveNames.get(name), ...battleMoves.get(name) });
}
moves.sort((a, b) => a.id - b.id);

// Held items that do something in battle (any item with a hold effect).
const items = [];
for (const m of read('src/data/items.h').matchAll(/\.name = _\("([^"]*)"\),\s*\.itemId = ITEM_(\w+),[\s\S]*?\.holdEffect = HOLD_EFFECT_(\w+),/g)) {
  const id = itemIds.get(m[2]);
  if (id && m[3] !== 'NONE') items.push({ id, name: text(m[1]) });
}
items.sort((a, b) => a.name.localeCompare(b.name));

// In the game's order (personality % 25).
const natures = ['Hardy', 'Lonely', 'Brave', 'Adamant', 'Naughty', 'Bold', 'Docile', 'Relaxed', 'Impish', 'Lax',
  'Timid', 'Hasty', 'Serious', 'Jolly', 'Naive', 'Modest', 'Mild', 'Quiet', 'Bashful', 'Rash',
  'Calm', 'Gentle', 'Sassy', 'Careful', 'Quirky'];

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({ species, moves, items, natures }));
console.log(`Editor data: ${species.length} species, ${moves.length} moves, ${items.length} items -> web/game/editor-data.json`);
