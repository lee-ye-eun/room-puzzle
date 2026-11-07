// Times knob-mode generation (generate + uniqueness check, retrying until unique) and
// verifies each result really has one solution.
// Usage: node tools/bench-knob.mjs [puzzles per size, default 20] [sizes, default 5,7,9,15]
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const ctx = vm.createContext({});
const load = f => readFileSync(new URL(`../js/${f}`, import.meta.url), 'utf8');
vm.runInContext(load('generator.js') + '\n' + load('solver.js')
  + '\nthis.api = {generateUniqueKnobPuzzle, solvePuzzle};', ctx);
const {generateUniqueKnobPuzzle, solvePuzzle} = ctx.api;

const perSize = Number(process.argv[2]) || 20;
const sizes = (process.argv[3] || '5,7,9,15').split(',').map(Number);
let failures = 0;
for(const n of sizes){
  const times = [];
  let tries = 0, maxTries = 0;
  for(let k = 0; k < perSize; k++){
    const t0 = performance.now();
    const res = generateUniqueKnobPuzzle(n);
    times.push(performance.now() - t0);
    tries += res.tries; maxTries = Math.max(maxTries, res.tries);
    if(solvePuzzle(res.puzzle, {knobClues: res.knobClues, limit: 3}).count !== 1) failures++;
  }
  times.sort((a, b) => a - b);
  const avg = times.reduce((a, b) => a + b, 0) / perSize;
  console.log(`${n}×${n} knob: ${perSize} puzzles, avg ${avg.toFixed(1)} ms, median ${times[perSize >> 1].toFixed(1)} ms, `
    + `min ${times[0].toFixed(1)} ms, max ${times[perSize - 1].toFixed(1)} ms, tries avg ${(tries / perSize).toFixed(2)} (max ${maxTries})`);
}
console.log(failures ? `FAIL: ${failures} puzzles not unique` : 'OK: every puzzle has exactly one solution');
process.exit(failures ? 1 : 0);
