// Compares knob-mode generation strategies, each worker running in its own thread like
// a Web Worker would in the browser (fresh workers per puzzle, so startup cost counts):
//   seq   1 worker: generate one, check uniqueness, repeat until unique
//   pair  2 workers: generate one each, take a unique one; if neither is, generate 2 again
//   race  2 workers: each repeats generate + check until unique; first one done wins
// Strategies run interleaved round by round so machine load affects them alike.
// Usage: node tools/bench-knob-parallel.mjs [rounds, default 20] [size, default 15]
import { Worker } from 'node:worker_threads';

const rounds = Number(process.argv[2]) || 20;
const n = Number(process.argv[3]) || 15;
const jsDir = new URL('../js/', import.meta.url).pathname;

const WORKER_SRC = `
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs'), vm = require('node:vm');
const ctx = vm.createContext({});
vm.runInContext(fs.readFileSync(workerData + 'generator.js', 'utf8') + '\\n'
  + fs.readFileSync(workerData + 'solver.js', 'utf8')
  + '\\nthis.api = {generatePuzzle, solvePuzzle, knobCounts};', ctx);
const {generatePuzzle, solvePuzzle, knobCounts} = ctx.api;
function once(n){
  const puzzle = generatePuzzle(n);
  const knobClues = knobCounts(n, puzzle.cells.map(c => c.answer));
  return {unique: solvePuzzle(puzzle, {knobClues, limit: 2}).count === 1};
}
parentPort.on('message', ({n, loop}) => {
  let tries = 0, r;
  do { tries++; r = once(n); } while(loop && !r.unique);
  parentPort.postMessage({unique: r.unique, tries});
});`;

const spawn = () => new Worker(WORKER_SRC, {eval: true, workerData: jsDir});
const ask = (w, msg) => new Promise(res => { w.once('message', res); w.postMessage(msg); });

async function seq(){
  const w = spawn(); let tries = 0, r;
  do { r = await ask(w, {n, loop: false}); tries++; } while(!r.unique);
  await w.terminate(); return tries;
}
async function pair(){
  const ws = [spawn(), spawn()]; let tries = 0;
  for(;;){
    const rs = await Promise.all(ws.map(w => ask(w, {n, loop: false})));
    tries += 2;
    if(rs.some(r => r.unique)) break;
  }
  await Promise.all(ws.map(w => w.terminate())); return tries;
}
async function race(){
  const ws = [spawn(), spawn()];
  const r = await Promise.race(ws.map(w => ask(w, {n, loop: true})));
  await Promise.all(ws.map(w => w.terminate())); return r.tries;
}

const strategies = {seq, pair, race};
const times = {seq: [], pair: [], race: []}, tries = {seq: 0, pair: 0, race: 0};
for(let k = 0; k < rounds; k++){
  for(const [name, fn] of Object.entries(strategies)){
    const t0 = performance.now();
    tries[name] += await fn();
    times[name].push(performance.now() - t0);
  }
  process.stdout.write(`round ${k + 1}/${rounds}\r`);
}
console.log();
for(const name of Object.keys(strategies)){
  const t = times[name].slice().sort((a, b) => a - b);
  const avg = t.reduce((a, b) => a + b, 0) / t.length;
  console.log(`${n}×${n} ${name.padEnd(4)}: avg ${avg.toFixed(0)} ms, median ${t[t.length >> 1].toFixed(0)} ms, `
    + `min ${t[0].toFixed(0)} ms, max ${t[t.length - 1].toFixed(0)} ms, puzzles generated avg ${(tries[name] / rounds).toFixed(2)}`);
}
