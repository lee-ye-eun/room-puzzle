// Web Worker for knob-mode generation, so two boards can be built at the same time off the
// main thread. Message in: {size, loop}. With loop, keeps generating until the board has a
// single solution; without, generates one board. Message out: {puzzle, unique} or {error}.
importScripts('generator.js', 'solver.js');

self.onmessage = ({data: {size, loop}}) => {
  try {
    let puzzle, unique;
    do {
      puzzle = generatePuzzle(size);
      const knobClues = knobCounts(size, puzzle.cells.map(c => c.answer));
      unique = solvePuzzle(puzzle, {knobClues, limit: 2}).count === 1;
    } while(loop && !unique);
    self.postMessage({puzzle, unique});
  } catch(e){
    self.postMessage({error: String(e && e.message || e)});
  }
};
