// The hidden team editor. The Konami code (feed() is called with each arrow
// and button press) opens it: pick up to six Pokémon, their moves, held item,
// level, nature, IVs and EVs. The team is saved in localStorage and
// app.js writes it into the ROM config (rom-config.js), where the game builds
// it with its own rules. A custom team still counts as the day's battle.

const STORAGE_KEY = 'dailyred-custom-team';
const KONAMI = ['up', 'up', 'down', 'down', 'left', 'right', 'left', 'right', 'b', 'a'];
const STATS = ['HP', 'Attack', 'Defense', 'Speed', 'Sp. Atk', 'Sp. Def'];
const SLOTS = 6;
const MAX_EV = 252;
const MAX_TOTAL_EV = 510;

// --- Saved team ---------------------------------------------------------------

const emptyMon = () => ({ species: 0, moves: [0, 0, 0, 0], item: 0, level: 100, nature: 0, ivs: Array(6).fill(31), evs: Array(6).fill(0) });

function isInt(x, min, max) {
  return Number.isInteger(x) && x >= min && x <= max;
}

// Accepts only a well-formed saved entry; anything else becomes an empty slot.
function cleanMon(mon) {
  if (!mon || !isInt(mon.species, 0, 0xFFFF)) return emptyMon();
  const ok = Array.isArray(mon.moves) && mon.moves.length === 4 && mon.moves.every((m) => isInt(m, 0, 0xFFFF))
    && isInt(mon.item, 0, 0xFFFF) && isInt(mon.level, 1, 100) && isInt(mon.nature, 0, 24)
    && Array.isArray(mon.ivs) && mon.ivs.length === 6 && mon.ivs.every((v) => isInt(v, 0, 31))
    && Array.isArray(mon.evs) && mon.evs.length === 6 && mon.evs.every((v) => isInt(v, 0, MAX_EV))
    && mon.evs.reduce((a, b) => a + b, 0) <= MAX_TOTAL_EV;
  return ok ? { ...mon, moves: [...mon.moves], ivs: [...mon.ivs], evs: [...mon.evs] } : emptyMon();
}

function readStorage() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (!saved || !Array.isArray(saved.team)) return null;
    const team = Array.from({ length: SLOTS }, (_, i) => cleanMon(saved.team[i]));
    return { active: saved.active === true, team };
  } catch {
    return null;
  }
}

function writeStorage(value) {
  try {
    if (value) localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
    else localStorage.removeItem(STORAGE_KEY);
  } catch { /* not remembered */ }
}

// The team to play with, or null for the day's random team.
export function loadCustomTeam() {
  const saved = readStorage();
  if (!saved?.active) return null;
  const team = saved.team.filter((mon) => mon.species && mon.moves.some(Boolean));
  return team.length ? team : null;
}

// --- Stat preview ---------------------------------------------------------------

// Index into STATS of the stat a nature raises and the one it lowers.
function natureEffect(nature) {
  const up = Math.floor(nature / 5) + 1;
  const down = (nature % 5) + 1;
  return up === down ? [] : [[up, 110], [down, 90]];
}

function finalStat(base, iv, ev, level, index, nature) {
  const core = Math.floor(((2 * base + iv + Math.floor(ev / 4)) * level) / 100);
  if (index === 0) return base === 1 ? 1 : core + level + 10; // Shedinja has 1 HP
  const mult = natureEffect(nature).find(([i]) => i === index)?.[1] ?? 100;
  return Math.floor(((core + 5) * mult) / 100);
}

// --- The editor -------------------------------------------------------------------

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function option(value, label) {
  return el('option', { value: String(value), textContent: label });
}

function clamp(value, min, max, fallback) {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

export function createTeamEditor({ onChange = () => {} } = {}) {
  let data = null;
  let speciesById = null;
  let loading = null;
  let team = Array.from({ length: SLOTS }, emptyMon);
  let slot = 0;
  let allMoves = false;
  let konamiStep = 0;
  let dialog = null;
  const parts = {};

  const current = () => team[slot];

  async function loadData() {
    loading ??= fetch('game/editor-data.json').then((res) => {
      if (!res.ok) throw new Error(`Couldn't load the editor data (HTTP ${res.status}).`);
      return res.json();
    }).catch((err) => {
      loading = null;
      throw err;
    });
    data = await loading;
    speciesById = new Map(data.species.map((s) => [s.id, s]));
  }

  function build() {
    parts.tabs = el('div', { className: 'te-tabs', role: 'tablist' });
    parts.species = el('select', { id: 'te-species' }, option(0, '(empty slot)'), ...data.species.map((s) => option(s.id, s.name)));
    parts.level = el('input', { id: 'te-level', type: 'number', min: 1, max: 100, inputMode: 'numeric' });
    parts.nature = el('select', { id: 'te-nature' }, ...data.natures.map((n, i) => option(i, n)));
    parts.item = el('select', { id: 'te-item' }, option(0, '(none)'), ...data.items.map((i) => option(i.id, i.name)));
    parts.allMoves = el('input', { id: 'te-all-moves', type: 'checkbox' });
    parts.moves = [0, 1, 2, 3].map((i) => el('select', { id: `te-move-${i}`, ariaLabel: `Move ${i + 1}` }));
    parts.ivs = STATS.map((name) => el('input', { type: 'number', min: 0, max: 31, inputMode: 'numeric', ariaLabel: `${name} IV` }));
    parts.evs = STATS.map((name) => el('input', { type: 'number', min: 0, max: MAX_EV, step: 4, inputMode: 'numeric', ariaLabel: `${name} EV` }));
    parts.bases = STATS.map(() => el('span'));
    parts.finals = STATS.map(() => el('strong'));
    parts.evTotal = el('p', { className: 'te-note', role: 'status' });
    parts.message = el('p', { className: 'te-message', role: 'alert' });

    const statRows = STATS.map((name, i) => el('tr', {},
      el('th', { scope: 'row', textContent: name }), el('td', {}, parts.bases[i]), el('td', {}, parts.ivs[i]), el('td', {}, parts.evs[i]), el('td', {}, parts.finals[i])));
    const label = (text, input) => el('label', { className: 'te-field' }, el('span', { textContent: text }), input);

    parts.fields = el('div', { className: 'te-fields' },
      el('div', { className: 'te-row' }, label('Pokémon', parts.species), label('Level', parts.level)),
      el('div', { className: 'te-row' }, label('Nature', parts.nature), label('Held item', parts.item)),
      el('fieldset', { className: 'te-moves' },
        el('legend', { textContent: 'Moves' }),
        ...parts.moves,
        el('label', { className: 'te-check' }, parts.allMoves, el('span', { textContent: 'Allow moves this Pokémon can’t learn' }))),
      el('div', { className: 'te-scroll' }, el('table', { className: 'te-stats' },
        el('thead', {}, el('tr', {}, ...['Stat', 'Base', 'IV', 'EV', 'Final'].map((t) => el('th', { scope: 'col', textContent: t })))),
        el('tbody', {}, ...statRows))),
      parts.evTotal);

    const button = (text, className = 'button button-quiet') => el('button', { type: 'button', className, textContent: text });
    const save = button('Save and use', 'button button-play');
    const clear = button('Clear slot');
    const reset = button('Use the daily team');
    const close = button('Close');

    dialog = el('dialog', { className: 'te', ariaLabel: 'Team editor' },
      el('form', { className: 'te-form', onsubmit: (e) => e.preventDefault() },
        el('h2', { className: 'te-title', textContent: 'Team editor' }),
        el('p', { className: 'te-note', textContent: 'Up to six Pokémon. A custom team still counts as today’s battle.' }),
        parts.tabs, parts.fields, parts.message,
        el('div', { className: 'te-actions' }, save, clear, reset, close)));
    document.body.append(dialog);

    parts.species.addEventListener('change', () => pickSpecies(Number(parts.species.value)));
    parts.level.addEventListener('input', () => {
      current().level = clamp(parts.level.value, 1, 100, 100);
      showClamped(parts.level, current().level);
      refresh(false);
    });
    parts.nature.addEventListener('change', () => { current().nature = Number(parts.nature.value); refresh(false); });
    parts.item.addEventListener('change', () => { current().item = Number(parts.item.value); });
    parts.allMoves.addEventListener('change', () => { allMoves = parts.allMoves.checked; fillMoveSelects(); });
    parts.moves.forEach((select, i) => select.addEventListener('change', () => { current().moves[i] = Number(select.value); }));
    parts.ivs.forEach((input, i) => input.addEventListener('input', () => {
      current().ivs[i] = clamp(input.value, 0, 31, 31);
      showClamped(input, current().ivs[i]);
      refresh(false);
    }));
    parts.evs.forEach((input, i) => input.addEventListener('input', () => setEV(i, input.value)));

    save.addEventListener('click', saveTeam);
    clear.addEventListener('click', () => { team[slot] = emptyMon(); refresh(true); });
    reset.addEventListener('click', () => {
      writeStorage(null);
      team = Array.from({ length: SLOTS }, emptyMon);
      onChange(null);
      dialog.close();
    });
    close.addEventListener('click', () => dialog.close());
    dialog.addEventListener('keydown', (e) => e.stopPropagation()); // keep game keys out of the fields
  }

  // Shows the value the game will use when the typed one was out of range.
  // An empty box is left alone so typing isn't interrupted.
  function showClamped(input, value) {
    if (input.value !== '' && Number(input.value) !== value) input.value = value;
  }

  // EVs are capped at 252 per stat and 510 in all, as in the game.
  function setEV(index, value) {
    const mon = current();
    const others = mon.evs.reduce((sum, v, i) => (i === index ? sum : sum + v), 0);
    mon.evs[index] = Math.min(clamp(value, 0, MAX_EV, 0), MAX_TOTAL_EV - others);
    showClamped(parts.evs[index], mon.evs[index]);
    refresh(false);
  }

  function pickSpecies(id) {
    const mon = current();
    mon.species = id;
    mon.moves = [0, 0, 0, 0];
    if (id) {
      // Start with the four strongest attacks it can learn.
      const power = new Map(data.moves.map((m) => [m.id, m.power]));
      const strongest = speciesById.get(id).moves.slice().sort((a, b) => power.get(b) - power.get(a)).slice(0, 4);
      mon.moves = [...strongest, 0, 0, 0, 0].slice(0, 4);
      if (!mon.item) mon.item = data.items.find((i) => i.name === 'LEFTOVERS')?.id ?? 0;
    }
    refresh(true);
  }

  function fillMoveSelects() {
    const mon = current();
    const info = mon.species ? speciesById.get(mon.species) : null;
    const byId = new Map(data.moves.map((m) => [m.id, m]));
    const pool = allMoves || !info ? data.moves : info.moves.map((id) => byId.get(id)).filter(Boolean);
    const label = (m) => `${m.name} (${m.type[0]}${m.type.slice(1).toLowerCase()}${m.power ? `, ${m.power}` : ''})`;
    parts.moves.forEach((select, i) => {
      select.replaceChildren(option(0, '(none)'), ...pool.map((m) => option(m.id, label(m))));
      // Keep a move chosen earlier even when it is outside the list.
      if (mon.moves[i] && !pool.some((m) => m.id === mon.moves[i]) && byId.has(mon.moves[i])) select.append(option(mon.moves[i], label(byId.get(mon.moves[i]))));
      select.value = String(mon.moves[i]);
    });
  }

  function renderTabs() {
    parts.tabs.replaceChildren(...team.map((mon, i) => {
      const tab = el('button', {
        type: 'button', role: 'tab', className: 'te-tab', ariaSelected: String(i === slot),
        textContent: `${i + 1}. ${mon.species ? speciesById.get(mon.species).name : '—'}`,
      });
      tab.addEventListener('click', () => { slot = i; refresh(true); });
      return tab;
    }));
  }

  // `full` rebuilds the form controls (new slot or species); otherwise only the
  // numbers that depend on the inputs are redrawn, so typing isn't interrupted.
  function refresh(full) {
    const mon = current();
    const info = mon.species ? speciesById.get(mon.species) : null;
    if (full) {
      parts.species.value = String(mon.species);
      parts.level.value = mon.level;
      parts.nature.value = String(mon.nature);
      parts.item.value = String(mon.item);
      parts.allMoves.checked = allMoves;
      parts.ivs.forEach((input, i) => { input.value = mon.ivs[i]; });
      parts.evs.forEach((input, i) => { input.value = mon.evs[i]; });
      fillMoveSelects();
    }
    renderTabs();
    for (const control of [parts.level, parts.nature, parts.item, parts.allMoves, ...parts.moves, ...parts.ivs, ...parts.evs]) control.disabled = !info;
    STATS.forEach((_, i) => {
      parts.bases[i].textContent = info ? info.base[i] : '–';
      parts.finals[i].textContent = info ? finalStat(info.base[i], mon.ivs[i], mon.evs[i], mon.level, i, mon.nature) : '–';
    });
    const total = mon.evs.reduce((a, b) => a + b, 0);
    parts.evTotal.textContent = info ? `EVs: ${total} of ${MAX_TOTAL_EV} used (up to ${MAX_EV} in one stat).` : '';
    parts.message.textContent = '';
  }

  function saveTeam() {
    const problems = [];
    const chosen = team.filter((mon) => mon.species);
    if (!chosen.length) problems.push('Pick at least one Pokémon.');
    for (const mon of chosen) {
      const name = speciesById.get(mon.species).name;
      const moves = mon.moves.filter(Boolean);
      if (!moves.length) problems.push(`${name} needs at least one move.`);
      if (new Set(moves).size !== moves.length) problems.push(`${name} has the same move twice.`);
    }
    if (problems.length) {
      parts.message.textContent = problems.join(' ');
      return;
    }
    writeStorage({ active: true, team });
    onChange(loadCustomTeam());
    dialog.close();
  }

  async function open() {
    try {
      await loadData();
    } catch (err) {
      console.error(err);
      return;
    }
    if (!dialog) build();
    const saved = readStorage();
    team = saved ? saved.team : Array.from({ length: SLOTS }, emptyMon);
    slot = 0;
    refresh(true);
    dialog.showModal();
  }

  // Takes 'up', 'down', 'left', 'right', 'a' or 'b'.
  function feed(token) {
    if (dialog?.open) return;
    konamiStep = token === KONAMI[konamiStep] ? konamiStep + 1 : (token === KONAMI[0] ? 1 : 0);
    if (konamiStep === KONAMI.length) {
      konamiStep = 0;
      open();
    }
  }

  return { feed, open };
}

// Maps a keyboard event to a Konami token, or null.
export function konamiToken(event) {
  switch (event.key) {
    case 'ArrowUp': return 'up';
    case 'ArrowDown': return 'down';
    case 'ArrowLeft': return 'left';
    case 'ArrowRight': return 'right';
    default: return event.key.length === 1 ? event.key.toLowerCase() : null;
  }
}
