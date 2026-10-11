// Puzzle solver: finds every door placement that satisfies the rules for a given board of
// rooms. Pure logic, no DOM — needs generator.js loaded first (ORIENTATIONS, CONTRIB,
// OPPOSITE, neighborsOf). solvePuzzle(puzzle, options) is the entry point.
//
// Each door cell keeps a domain: a 4-bit mask of the orientations still possible
// (up/down/left/right). Constraint propagation shrinks the domains until nothing changes,
// and only when it gets stuck does the search guess (the cell with the fewest options
// first) and recurse. Rules, as constraints:
//   - room: the contributions of its neighboring doors add up to its number (rule 3)
//   - wall: a door's black half reaches at least one room (rule 4) — fixed by where the
//     rooms are, so it's applied once to the initial domains
//   - touch: two neighboring doors' black halves never touch (rule 5)
//   - knob (optional): every half-row / half-column holds as many knobs as its clue says
// Contributions are counted in halves (0 / 1 / 2) so all sums stay integers.

const BIT = {up: 1, down: 2, left: 4, right: 8};
const FULL_DOMAIN = 15;

// popcount and "the one orientation" of a 4-bit mask, precomputed
const BIT_COUNT = Array.from({length: 16}, (_, m) => ORIENTATIONS.filter(o => m & BIT[o]).length);
const SINGLE_ORIENTATION = Array.from({length: 16}, (_, m) => BIT_COUNT[m] === 1 ? ORIENTATIONS.find(o => m & BIT[o]) : null);

// Orientations whose knob (see KNOB_QUARTER in game.js) sits in the top half-row of the
// cell, and in the left half-column. The rest sit in the bottom / right halves.
const KNOB_TOP = BIT.up | BIT.left;
const KNOB_LEFT = BIT.down | BIT.left;

// TOUCH_OK[dir][a]: mask of orientations a neighbor in direction `dir` may take when this
// cell's orientation is `a` (bit index, 0-3).
const TOUCH_OK = {};
ORIENTATIONS.forEach(dir => {
  TOUCH_OK[dir] = ORIENTATIONS.map(a =>
    ORIENTATIONS.reduce((m, b) => halfBlocksTouch(a, dir, b) ? m : m | BIT[b], 0)
  );
});

// halves[o] contributed to a room lying in direction `dirFromDoor` of the door
function halvesToward(orientation, dirFromDoor){
  return CONTRIB[orientation][dirFromDoor] * 2;
}

// Builds the static constraint graph for a board: which cells are doors, their neighbor
// links, every room's neighboring doors, and (with knob clues) every half-line's doors.
function buildModel(puzzle, knobClues){
  const n = puzzle.size;
  const total = n * n;
  const isDoor = puzzle.cells.map(c => c.type === 'player');

  const doorNeighbors = new Array(total);  // [{idx, dir}] door neighbors of a door
  const roomsOfDoor = new Array(total);    // [room index] rooms next to a door
  const rooms = [];                         // {idx, target, doors: [{idx, dirFromDoor}]}
  const domain = new Uint8Array(total);

  for(let i = 0; i < total; i++){
    if(isDoor[i]){
      doorNeighbors[i] = neighborsOf(n, i).filter(({idx}) => isDoor[idx]);
      roomsOfDoor[i] = [];
      // wall rule: keep only orientations whose black half reaches some room
      domain[i] = ORIENTATIONS.reduce((m, o) =>
        neighborsOf(n, i).some(({idx, dir}) => !isDoor[idx] && CONTRIB[o][dir] > 0) ? m | BIT[o] : m, 0);
    } else {
      const room = {idx: i, target: puzzle.cells[i].value * 2, doors: []};
      neighborsOf(n, i).forEach(({idx, dir}) => {
        if(isDoor[idx]) room.doors.push({idx, dirFromDoor: OPPOSITE[dir]});
      });
      rooms.push(room);
    }
  }
  rooms.forEach((room, r) => room.doors.forEach(({idx}) => roomsOfDoor[idx].push(r)));

  // knob lines: a half-row clue counts the row's doors with a top-half knob, a
  // half-column clue the column's doors with a left-half knob (the other half of each
  // pair is just "the rest", so it's checked as the same line with the count flipped)
  const lines = [];
  const linesOfDoor = Array.from({length: total}, () => []);
  if(knobClues){
    for(let k = 0; k < n; k++){
      const rowDoors = [], colDoors = [];
      for(let m = 0; m < n; m++){
        if(isDoor[k * n + m]) rowDoors.push(k * n + m);
        if(isDoor[m * n + k]) colDoors.push(m * n + k);
      }
      lines.push({doors: rowDoors, mask: KNOB_TOP, want: knobClues.rows[2 * k], other: knobClues.rows[2 * k + 1]});
      lines.push({doors: colDoors, mask: KNOB_LEFT, want: knobClues.cols[2 * k], other: knobClues.cols[2 * k + 1]});
    }
    lines.forEach((line, l) => line.doors.forEach(i => linesOfDoor[i].push(l)));
  }

  return {n, total, isDoor, doorNeighbors, roomsOfDoor, rooms, lines, linesOfDoor, domain};
}

// Shrinks `domain` in place until every constraint is consistent. `queue` holds the doors
// whose domain just changed; their rooms, lines and door neighbors get re-checked. Returns
// false as soon as some domain empties or a constraint can't be met (a contradiction).
function propagate(model, domain, queue){
  const {doorNeighbors, roomsOfDoor, rooms, lines, linesOfDoor} = model;
  const queued = new Uint8Array(model.total);
  queue.forEach(i => { queued[i] = 1; });

  function narrow(i, mask){
    const next = domain[i] & mask;
    if(next === domain[i]) return true;
    domain[i] = next;
    if(next === 0) return false;
    if(!queued[i]){ queued[i] = 1; queue.push(i); }
    return true;
  }

  // Room: keep an orientation only if the other doors can still make up the rest of the
  // number. Each door's reachable contributions are a bitmask over 0..2 halves; shifting
  // and OR-ing them together gives every reachable total (at most 4 doors, so it's tiny).
  function checkRoom(room){
    const reach = room.doors.map(({idx, dirFromDoor}) =>
      ORIENTATIONS.reduce((m, o) => domain[idx] & BIT[o] ? m | (1 << halvesToward(o, dirFromDoor)) : m, 0));
    for(let d = 0; d < room.doors.length; d++){
      let others = 1; // reachable totals of every door but d (bit k = total k halves)
      for(let e = 0; e < room.doors.length; e++){
        if(e === d) continue;
        let next = 0;
        for(let h = 0; h <= 2; h++) if(reach[e] & (1 << h)) next |= others << h;
        others = next;
      }
      const {idx, dirFromDoor} = room.doors[d];
      let keep = 0;
      ORIENTATIONS.forEach(o => {
        const rest = room.target - halvesToward(o, dirFromDoor);
        if(rest >= 0 && (others >> rest) & 1) keep |= BIT[o];
      });
      if(!narrow(idx, keep)) return false;
    }
    return true;
  }

  // Knob line: count doors that must / may have their knob in the clued half. If the
  // clue is already met, nobody else may; if every "may" is needed, they all must.
  function checkLine(line){
    if(line.want + line.other !== line.doors.length) return false;
    let must = 0, may = 0;
    line.doors.forEach(i => {
      if(domain[i] & line.mask){ may++; if(!(domain[i] & ~line.mask)) must++; }
    });
    if(must > line.want || may < line.want) return false;
    if(must !== line.want && may !== line.want) return true;
    // only the undecided doors (some options in the clued half, some outside) change
    for(const i of line.doors){
      if(!(domain[i] & line.mask) || !(domain[i] & ~line.mask)) continue;
      if(!narrow(i, must === line.want ? ~line.mask & FULL_DOMAIN : line.mask)) return false;
    }
    return true;
  }

  for(let head = 0; head < queue.length; head++){
    const i = queue[head];
    queued[i] = 0;
    // touch: each neighbor keeps only what's compatible with at least one of i's options
    for(const {idx: j, dir} of doorNeighbors[i]){
      let allowed = 0;
      ORIENTATIONS.forEach((o, b) => { if(domain[i] & BIT[o]) allowed |= TOUCH_OK[dir][b]; });
      if(!narrow(j, allowed)) return false;
    }
    for(const r of roomsOfDoor[i]) if(!checkRoom(rooms[r])) return false;
    for(const l of linesOfDoor[i]) if(!checkLine(lines[l])) return false;
  }
  return true;
}

// One level deeper than propagate: try each remaining option of each undecided door on a
// copy, and drop the ones that lead straight to a contradiction ("if this door pointed
// up, room X couldn't be met"). Repeats until a full pass removes nothing. Returns false
// if the board itself is contradictory.
function probe(model, domain, doors){
  let changed = true;
  while(changed){
    changed = false;
    for(const i of doors){
      if(BIT_COUNT[domain[i]] < 2) continue;
      for(const o of ORIENTATIONS){
        if(!(domain[i] & BIT[o])) continue;
        const trial = domain.slice();
        trial[i] = BIT[o];
        if(propagate(model, trial, [i])) continue;
        domain[i] &= ~BIT[o];
        if(!propagate(model, domain, [i])) return false;
        changed = true;
      }
    }
  }
  return true;
}

// Splits the undecided doors into groups that can't affect each other: two doors are
// linked when they're neighbors or share a room or (knob mode) a half-line. Each group
// can then be searched on its own, so independent corners don't multiply the work.
function undecidedGroups(model, domain, doors){
  const {doorNeighbors, roomsOfDoor, rooms, linesOfDoor, lines} = model;
  const open = i => BIT_COUNT[domain[i]] > 1;
  const seen = new Uint8Array(model.total);
  const groups = [];
  for(const start of doors){
    if(seen[start] || !open(start)) continue;
    const group = [start];
    seen[start] = 1;
    for(let head = 0; head < group.length; head++){
      const i = group[head];
      const linked = doorNeighbors[i].map(({idx}) => idx);
      roomsOfDoor[i].forEach(r => rooms[r].doors.forEach(({idx}) => linked.push(idx)));
      linesOfDoor[i].forEach(l => lines[l].doors.forEach(j => linked.push(j)));
      for(const j of linked){
        if(!seen[j] && open(j)){ seen[j] = 1; group.push(j); }
      }
    }
    groups.push(group);
  }
  return groups;
}

// Solves a puzzle ({size, cells} as generatePuzzle returns, only the rooms' values are
// read — never the stored answers). Options:
//   knobClues  {rows, cols} from knobCounts() for knob mode, or null/absent for plain
//   limit      stop after this many solutions (default 2: enough to tell unique or not)
// Returns {count, solutions, logical, guesses, open}:
//   count      solutions found (capped at limit); 0 = unsolvable, 1 = unique
//   solutions  each an array over all cells: an orientation for doors, null for rooms
//   logical    true if deduction alone (propagate + probe) filled the whole board
//   guesses    how many search branches were tried (0 when logical)
//   open       doors deduction couldn't settle — where a non-unique puzzle has its choices
function solvePuzzle(puzzle, options = {}){
  const limit = options.limit ?? 2;
  const model = buildModel(puzzle, options.knobClues || null);
  const {total, isDoor} = model;
  const doors = [];
  for(let i = 0; i < total; i++) if(isDoor[i]) doors.push(i);

  const result = {count: 0, solutions: [], logical: false, guesses: 0, open: []};

  const root = model.domain.slice();
  // every room, line and door neighbor gets checked at least once
  if(!propagate(model, root, doors.slice()) || !probe(model, root, doors)) return result;
  result.open = doors.filter(i => BIT_COUNT[root[i]] > 1);
  result.logical = result.open.length === 0;

  // Up to `limit` settled domains for one group, by depth-first search: guess the door
  // with the fewest options left, propagate, probe, recurse.
  function searchGroup(group){
    const found = [];
    (function search(domain){
      let best = -1, bestCount = 5;
      for(const i of group){
        const c = BIT_COUNT[domain[i]];
        if(c > 1 && c < bestCount){ best = i; bestCount = c; if(c === 2) break; }
      }
      if(best === -1){ found.push(domain); return; }
      for(const o of ORIENTATIONS){
        if(!(domain[best] & BIT[o])) continue;
        result.guesses++;
        const next = domain.slice();
        next[best] = BIT[o];
        if(propagate(model, next, [best]) && probe(model, next, group)) search(next);
        if(found.length >= limit) return;
      }
    })(root);
    return found;
  }

  // Groups are independent, so the board's solutions are every combination of one
  // solution per group; only the first `limit` combinations are built.
  const perGroup = undecidedGroups(model, root, doors).map(searchGroup);
  if(perGroup.some(f => f.length === 0)) return result;
  const pick = perGroup.map(() => 0);
  while(result.count < limit){
    const domain = root.slice();
    perGroup.forEach((found, g) => found[pick[g]].forEach((m, i) => { if(BIT_COUNT[domain[i]] > 1) domain[i] = m; }));
    result.count++;
    result.solutions.push(Array.from({length: total}, (_, i) => isDoor[i] ? SINGLE_ORIENTATION[domain[i]] : null));
    // advance the combination like an odometer
    let g = 0;
    while(g < pick.length && ++pick[g] === perGroup[g].length){ pick[g] = 0; g++; }
    if(g === pick.length) break;
  }
  return result;
}
