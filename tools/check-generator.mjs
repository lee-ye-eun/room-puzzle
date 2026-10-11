// Generates puzzles with js/generator.js and checks every answer against the rules —
// run after touching the generator to catch regressions.
// Usage: node tools/check-generator.mjs [puzzles per size, default 20]
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const ctx = vm.createContext({});
vm.runInContext(readFileSync(new URL('../js/generator.js', import.meta.url), 'utf8')
  + '\nthis.api = {generatePuzzle, neighborsOf, contribution, isWallTouching, hasRuleThreeViolation};', ctx);
const {generatePuzzle, neighborsOf, contribution, isWallTouching, hasRuleThreeViolation} = ctx.api;

const perSize = Number(process.argv[2]) || 20;
let failures = 0;
for(const n of [5, 7, 9, 15]){
  const t0 = performance.now();
  for(let k = 0; k < perSize; k++){
    const {cells} = generatePuzzle(n);
    const kind = cells.map(c => c.type === 'player' ? c.answer : 'number');
    const color = cells.map(c => c.type === 'player' ? 'blue' : 'green');
    cells.forEach((c, i) => {
      if(c.type === 'number'){
        let sum = 0;
        neighborsOf(n, i).forEach(({idx, dir}) => { sum += contribution(kind[idx], dir); });
        if(Math.abs(sum - c.value) > 1e-9 || c.value < 1 || c.value > 4) failures++; // rule: room number
      } else if(!isWallTouching(n, i, kind) || hasRuleThreeViolation(n, i, color, kind)){
        failures++; // rules: door touches a room / doors never touch
      }
    });
  }
  console.log(`${n}×${n}: ${perSize} puzzles, ${((performance.now() - t0) / perSize).toFixed(1)} ms each`);
}
console.log(failures ? `FAIL: ${failures} rule violations` : 'OK: every answer follows the rules');
process.exit(failures ? 1 : 0);
