// Generates puzzles with js/generator.js, solves them with js/solver.js (rooms only, never
// the stored answer) and checks every solution against the rules. Also reports how many
// puzzles turn out unique and how many fall to pure deduction without guessing.
// Usage: node tools/check-solver.mjs [puzzles per size, default 20]
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const ctx = vm.createContext({});
const load = f => readFileSync(new URL(`../js/${f}`, import.meta.url), 'utf8');
vm.runInContext(load('generator.js') + '\n' + load('solver.js')
  + '\nthis.api = {generatePuzzle, solvePuzzle, neighborsOf, contribution, isWallTouching, hasRuleThreeViolation};', ctx);
const {generatePuzzle, solvePuzzle, neighborsOf, contribution, isWallTouching, hasRuleThreeViolation} = ctx.api;

// same knob counting as game.js
const KNOB_QUARTER = {up: [0, 1], down: [1, 0], left: [0, 0], right: [1, 1]};
function knobCounts(n, doors){
  const rows = new Array(2 * n).fill(0), cols = new Array(2 * n).fill(0);
  doors.forEach((d, i) => {
    const q = KNOB_QUARTER[d];
    if(!q) return;
    rows[2 * Math.floor(i / n) + q[0]]++;
    cols[2 * (i % n) + q[1]]++;
  });
  return {rows, cols};
}

function followsRules(n, cells, solution, knobClues){
  const kind = cells.map((c, i) => c.type === 'player' ? solution[i] : 'number');
  const color = cells.map(c => c.type === 'player' ? 'blue' : 'green');
  const ok = cells.every((c, i) => {
    if(c.type !== 'number') return isWallTouching(n, i, kind) && !hasRuleThreeViolation(n, i, color, kind);
    let sum = 0;
    neighborsOf(n, i).forEach(({idx, dir}) => { sum += contribution(kind[idx], dir); });
    return Math.abs(sum - c.value) < 1e-9;
  });
  if(!ok || !knobClues) return ok;
  const got = knobCounts(n, solution);
  return ['rows', 'cols'].every(key => got[key].every((v, k) => v === knobClues[key][k]));
}

const perSize = Number(process.argv[2]) || 20;
let failures = 0;
for(const n of [5, 7, 9, 15]){
  for(const knob of [false, true]){
    let unique = 0, logical = 0, ms = 0, worst = 0;
    for(let k = 0; k < perSize; k++){
      const puzzle = generatePuzzle(n);
      const knobClues = knob ? knobCounts(n, puzzle.cells.map(c => c.answer)) : null;
      const t0 = performance.now();
      const res = solvePuzzle(puzzle, {knobClues});
      const dt = performance.now() - t0;
      ms += dt; worst = Math.max(worst, dt);
      if(res.count === 0){ failures++; continue; } // the generated answer always exists
      if(!res.solutions.every(s => followsRules(n, puzzle.cells, s, knobClues))) failures++;
      if(res.count === 1) unique++;
      if(res.logical) logical++;
    }
    console.log(`${n}×${n} ${knob ? 'knob ' : 'plain'}: unique ${unique}/${perSize}, `
      + `no guessing ${logical}/${perSize}, ${(ms / perSize).toFixed(1)} ms avg, ${worst.toFixed(1)} ms worst`);
  }
}
console.log(failures ? `FAIL: ${failures} puzzles solved wrong or not at all` : 'OK: every solution follows the rules');
process.exit(failures ? 1 : 0);
