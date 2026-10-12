// Hidden team editor test: the Konami code opens it, a team built in it is
// written into the ROM, and the game's party matches (species, moves, item,
// level, nature, IVs, EVs and the final stats the editor previewed).
// Screenshots go to tests/output/editor-*.png.
import { mkdirSync, readFileSync } from 'node:fs';
import { startServer, launchBrowser, getStatus } from './lib.mjs';
import { readParty } from './party.mjs';

const OUT = new URL('./output/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const data = JSON.parse(readFileSync(new URL('../web/game/editor-data.json', import.meta.url)));
const speciesId = (name) => data.species.find((s) => s.name === name).id;
const moveId = (name) => data.moves.find((m) => m.name === name).id;
const itemId = (name) => data.items.find((i) => i.name === name).id;

let failures = 0;
function check(ok, message) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${message}`);
  if (!ok) failures++;
}

const server = await startServer();
const browser = await launchBrowser();
try {
  const page = await (await browser.newContext({ viewport: { width: 1000, height: 1000 } })).newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(server.url);
  const isOpen = () => page.evaluate(() => Boolean(document.querySelector('dialog.te')?.open));

  for (const key of ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'a', 'b']) await page.keyboard.press(key);
  await page.waitForTimeout(500);
  check(!(await isOpen()), 'a wrong code (…A, B) does not open the editor');

  for (const key of ['ArrowUp', 'ArrowUp', 'ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a']) await page.keyboard.press(key);
  await page.waitForSelector('dialog.te[open]', { timeout: 5000 });
  check(await isOpen(), 'the Konami code opens the editor (even after stray presses)');

  // Slot 1: a Pikachu with chosen moves, item, nature, level, IVs and EVs.
  await page.selectOption('#te-species', String(speciesId('PIKACHU')));
  await page.selectOption('#te-nature', { label: 'Timid' });
  await page.selectOption('#te-item', String(itemId('LIGHT BALL')));
  await page.fill('#te-level', '90');
  await page.selectOption('#te-move-0', String(moveId('THUNDERBOLT')));
  await page.selectOption('#te-move-1', String(moveId('QUICK ATTACK')));
  await page.selectOption('#te-move-2', '0');
  await page.selectOption('#te-move-3', '0');
  const ivs = [0, 10, 20, 30, 31, 5];
  const evs = [252, 0, 0, 252, 6, 0];
  for (let i = 0; i < 6; i++) {
    await page.locator('.te-stats tbody tr').nth(i).locator('input').nth(0).fill(String(ivs[i]));
    await page.locator('.te-stats tbody tr').nth(i).locator('input').nth(1).fill(String(evs[i]));
  }
  const preview = await page.locator('.te-stats tbody tr strong').allTextContents();

  // Slot 2: a Mew (not learnable moves are blocked until the box is ticked).
  await page.locator('.te-tab').nth(1).click();
  await page.selectOption('#te-species', String(speciesId('MEW')));
  await page.locator('.te-stats tbody tr').nth(0).locator('input').nth(1).fill('300');
  check(await page.locator('.te-stats tbody tr').nth(0).locator('input').nth(1).inputValue() === '252', 'EVs are capped at 252 per stat');
  await page.locator('.te-stats tbody tr').nth(1).locator('input').nth(1).fill('252');
  await page.locator('.te-stats tbody tr').nth(2).locator('input').nth(1).fill('252');
  check(await page.locator('.te-stats tbody tr').nth(2).locator('input').nth(1).inputValue() === '6', 'EVs are capped at 510 in all');
  await page.screenshot({ path: `${OUT}/editor-open.png` });

  await page.locator('.te-actions .button-play').click();
  check(!(await isOpen()), 'Save closes the editor');
  check(await page.evaluate(() => !document.getElementById('custom-note').hidden), 'the title card says a custom team is in use');
  await page.reload();
  check(await page.evaluate(() => !document.getElementById('custom-note').hidden), 'the custom team survives a reload');

  await page.click('#play');
  await page.waitForFunction(() => document.querySelector('.app').dataset.state === 'playing', null, { timeout: 60000 });
  await page.evaluate(() => { window.emu = window.dailyRed.emulator; });
  await new Promise((r) => setTimeout(r, 5000));
  const { count, party } = readParty((await getStatus(page)).mem);
  const [pika, mew] = party;
  check(count === 2, `the party has the 2 chosen Pokémon (got ${count})`);
  check(pika?.speciesName === 'PIKACHU' && mew?.speciesName === 'MEW', `species are Pikachu and Mew (got ${pika?.speciesName}, ${mew?.speciesName})`);
  check(pika?.level === 90, `level is 90 (got ${pika?.level})`);
  check(pika?.nature === 'Timid', `nature is Timid (got ${pika?.nature})`);
  check(JSON.stringify(pika?.moveNames) === JSON.stringify(['THUNDERBOLT', 'QUICK_ATTACK']), `moves are Thunderbolt and Quick Attack (got ${pika?.moveNames})`);
  check(pika?.heldItem === itemId('LIGHT BALL'), 'held item is Light Ball');
  check(JSON.stringify(pika?.ivs) === JSON.stringify(ivs), `IVs match (got ${pika?.ivs})`);
  check(JSON.stringify(pika?.evs) === JSON.stringify(evs), `EVs match (got ${pika?.evs})`);
  check(JSON.stringify(pika?.stats) === JSON.stringify(preview.map(Number)), `final stats equal the editor's preview (${pika?.stats} vs ${preview})`);
  check(pika?.hp === pika?.maxHp && mew?.hp === mew?.maxHp, `both start at full HP (${pika?.hp}/${pika?.maxHp}, ${mew?.hp}/${mew?.maxHp})`);
  check(mew?.evs.reduce((a, b) => a + b, 0) === 510, 'Mew has 510 EVs in all');
  check(errors.length === 0, `no page errors${errors.length ? `: ${errors[0]}` : ''}`);
} finally {
  await browser.close();
  server.close();
}
console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll editor checks passed');
process.exit(failures ? 1 : 0);
