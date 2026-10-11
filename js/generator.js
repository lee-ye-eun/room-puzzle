// Puzzle generator: builds a random board of rooms (number cells) and doors (half-blocks).
// Pure logic, no DOM — generatePuzzle(n) is the entry point.

const ORIENTATIONS = ['up','down','left','right'];

// half-block contribution to each of its own four sides (see legend for the shapes)
const CONTRIB = {
  up:    {up:1, down:0, left:0.5, right:0.5},
  down:  {up:0, down:1, left:0.5, right:0.5},
  left:  {up:0.5, down:0.5, left:1, right:0},
  right: {up:0.5, down:0.5, left:0, right:1}
};
const OPPOSITE = {up:'down', down:'up', left:'right', right:'left'};

// Rule 3: two orthogonally-adjacent half-blocks may never have their black regions
// actually touch across their shared border. A raw contribution (0/0.5/1, see CONTRIB)
// isn't enough on its own to decide this: two 0.5 contributions can still land on
// opposite halves of the shared border and not overlap at all (e.g. 'up' facing right
// meets 'down' facing left — top half vs. bottom half, touching at a single point, never
// a real overlap). A full (1) contribution from either side always overlaps whatever
// nonzero the other side shows, and two 0.5 contributions overlap only when they name the
// SAME orientation, since both cells share the same coordinate axis along that border.
function halfBlocksTouch(orientA, dirAtoB, orientB){
  const cA = CONTRIB[orientA][dirAtoB];
  const cB = CONTRIB[orientB][OPPOSITE[dirAtoB]];
  if(cA === 0 || cB === 0) return false;
  if(cA === 1 || cB === 1) return true;
  return orientA === orientB;
}

// Would giving `idx` this orientation make it touch (rule 3) some ALREADY-decided
// half-block neighbor? Only checks committed 'blue' neighbors — this is meant to be used
// both as a pre-filter on a hypothetical orientation before it's committed, and (via
// hasRuleThreeViolation below) as a post-hoc check on an orientation already committed.
function conflictsWithBlueNeighbor(n, idx, orientation, knownKind, color){
  return neighborsOf(n, idx).some(({idx: j, dir}) =>
    color[j] === 'blue' && halfBlocksTouch(orientation, dir, knownKind[j])
  );
}

function hasRuleThreeViolation(n, idx, color, knownKind){
  if(color[idx] !== 'blue') return false;
  return conflictsWithBlueNeighbor(n, idx, knownKind[idx], knownKind, color);
}

// Full-board sweep, used where there's no cheaper way to know what to check (right after
// the initial unique-cell closure, and as a final belt-and-suspenders pass).
function findRuleThreeViolationFull(n, total, color, knownKind){
  for(let i = 0; i < total; i++){
    if(hasRuleThreeViolation(n, i, color, knownKind)) return i;
  }
  return -1;
}

// Mirrors findStuckCellNear's reasoning: a cell's rule-3 status can only newly change as a
// direct result of a placement that just resolved IT or one of ITS neighbors, so only
// `newlyResolved` and their neighbors need re-checking, not the whole board.
function findRuleThreeViolationNear(n, newlyResolved, color, knownKind){
  const seen = new Set();
  const check = (idx) => {
    if(seen.has(idx)) return false;
    seen.add(idx);
    return hasRuleThreeViolation(n, idx, color, knownKind);
  };
  for(const idx of newlyResolved){
    if(check(idx)) return idx;
    for(const {idx: j} of neighborsOf(n, idx)){
      if(check(j)) return j;
    }
  }
  return -1;
}

// Knight's-move targets of `idx` on an n×n board (up to 8, fewer near edges/corners) —
// used to space freshly-planted number clues away from an existing one (see the "no
// wall-adjacent cell left" branch of generatePuzzleAttempt's main loop).
const KNIGHT_OFFSETS = [[1,2],[1,-2],[-1,2],[-1,-2],[2,1],[2,-1],[-2,1],[-2,-1]];
function knightMoves(n, idx){
  const r = Math.floor(idx / n), c = idx % n;
  const res = [];
  KNIGHT_OFFSETS.forEach(([dr, dc]) => {
    const nr = r + dr, nc = c + dc;
    if(nr >= 0 && nr < n && nc >= 0 && nc < n) res.push(nr * n + nc);
  });
  return res;
}

// kind is either 'full' | 'empty' | 'number' (each contributes a fixed, type-determined
// amount to its neighbors) or an orientation string (a player cell's chosen half-block)
function contribution(kind, dirFromClueToNeighbor){
  if(kind === 'full') return 1;
  if(kind === 'empty' || kind === 'number') return 0;
  return CONTRIB[kind][OPPOSITE[dirFromClueToNeighbor]];
}

function neighborsOf(n, idx){
  const r = Math.floor(idx / n), c = idx % n;
  const res = [];
  if(r > 0) res.push({idx: idx - n, dir: 'up'});
  if(r < n - 1) res.push({idx: idx + n, dir: 'down'});
  if(c > 0) res.push({idx: idx - 1, dir: 'left'});
  if(c < n - 1) res.push({idx: idx + 1, dir: 'right'});
  return res;
}

function shuffled(arr){
  const a = arr.slice();
  for(let i = a.length - 1; i > 0; i--){
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function randomOf(arr){ return arr[Math.floor(Math.random() * arr.length)]; }

// ---- experimental generator: unique cells first, then black pattern, then more clues ----
//
// A cell's value has exactly one possible neighbor arrangement when it's 0 (every neighbor
// points away) or its degree — 4 interior / 3 edge / 2 corner (every neighbor points in).
// We call that a "unique cell". Splitting the grid into zones and forcing one unique cell
// per zone up front gives every puzzle a few guaranteed, unambiguous footholds spread
// across the board, before the rest of the grid is filled in at random exactly like
// before (paint everything, then walk cells in random order turning some into clues,
// freezing each clue's neighbors so a later clue can't quietly invalidate it).

// Splits [0, n) into k roughly-equal runs of length ceil(n/k): overlapping at the shared
// boundary when n doesn't divide evenly by k (e.g. n=5,k=2 → [0,3) and [2,5)), and exactly
// tiling with no overlap when it does (e.g. n=9,k=3 → [0,3),[3,6),[6,9)).
function computeZones(n, k){
  const size = Math.ceil(n / k);
  const starts = [];
  for(let i = 0; i < k; i++){
    starts.push(k > 1 ? Math.round(i * (n - size) / (k - 1)) : 0);
  }
  const zones = [];
  starts.forEach(rowStart => {
    starts.forEach(colStart => {
      zones.push({rowStart, rowEnd: rowStart + size, colStart, colEnd: colStart + size});
    });
  });
  return zones;
}

function cellsInZone(n, zone){
  const idxs = [];
  for(let r = zone.rowStart; r < zone.rowEnd && r < n; r++){
    for(let c = zone.colStart; c < zone.colEnd && c < n; c++){
      idxs.push(r * n + c);
    }
  }
  return idxs;
}

// Picks one (on large boards sometimes two) "unique cell" per zone — a position whose value (its degree: 4
// interior / 3 edge / 2 corner; 0 is no longer allowed anywhere) has exactly one possible
// neighbor arrangement. This is the ONLY place a clue is ever allowed to show that
// unambiguous degree-value pattern — every later clue placement in generatePuzzleAttempt
// (placeNumberClue, the wall-touch repair pass, and a final sweep over whatever tryGreen
// computes on its own) explicitly refuses to reproduce it, so all of a puzzle's "free"
// starting footholds are concentrated here at generation time.
//
// A candidate must have every neighbor still unfrozen, not just itself: two unique cells
// that end up sharing a neighbor would each need that shared cell pointed a different way,
// and whichever got decided second would silently overwrite the first's requirement,
// corrupting its value. Only decides WHICH cells are clues and what they show — not any
// actual orientations (runClosureBFS derives those).
const LARGE_BOARD_MIN = 15;
const MAX_UNIQUE_CELLS_LARGE = 7;

function placeUniqueCells(n){
  const total = n * n;
  const isClue = new Array(total).fill(false);
  const clueValue = new Array(total).fill(null);
  const frozen = new Array(total).fill(false);

  function placeOneIn(zoneCells){
    const candidates = shuffled(zoneCells).filter(i =>
      !frozen[i] && neighborsOf(n, i).every(({idx: j}) => !frozen[j])
    );
    if(candidates.length === 0) return false; // no room left in this zone
    const i = candidates[0];
    const nb = neighborsOf(n, i);
    const degree = nb.length;
    isClue[i] = true;
    // 0 tiles are no longer allowed anywhere on the board, so a unique cell's only
    // remaining unambiguous value is "every neighbor points in" (its degree: 2 at a
    // corner, 3 on an edge, 4 inside) — never "every neighbor points away" (0).
    clueValue[i] = degree;
    frozen[i] = true;
    nb.forEach(({idx: j}) => { frozen[j] = true; });
    return true;
  }

  // always a 4-way (2×2) split, regardless of grid size — one unique cell seeded per zone
  // (a zone with no room left for its own pick just goes without — see placeOneIn's early
  // return). Large boards (15×15 and up) additionally get 0–3 extra unique cells, each in
  // a different zone, so every zone holds 1–2 and the whole board at most 7. On those
  // boards the odd-sized zones overlap on the middle row/column, so seeds stay off that
  // shared strip — otherwise one zone could end up holding a neighbor's picks too.
  const large = n >= LARGE_BOARD_MIN;
  const allZones = computeZones(n, 2);
  const zoneCells = new Map(allZones.map(zone => {
    let cells = cellsInZone(n, zone);
    if(large){
      cells = cells.filter(i => allZones.filter(z => cellsInZone(n, z).includes(i)).length === 1);
    }
    return [zone, cells];
  }));
  const zones = shuffled(allZones);
  zones.forEach(zone => placeOneIn(zoneCells.get(zone)));
  if(large){
    const extra = Math.floor(Math.random() * (MAX_UNIQUE_CELLS_LARGE - zones.length + 1));
    zones.slice(0, extra).forEach(zone => placeOneIn(zoneCells.get(zone)));
  }

  return {isClue, clueValue};
}

// Same rule, checked against `idx`'s ALREADY-DECIDED orientation rather than picking one:
// true iff idx's current fill actually reaches at least one number-tile neighbor. This is
// not checked while half-blocks are being placed (see commitHalfBlockOrientation) — only in
// bulk, once the whole board is filled in, by the wall-touch repair pass below.
function isWallTouching(n, idx, knownKind){
  return neighborsOf(n, idx).some(({idx: j, dir}) =>
    knownKind[j] === 'number' && knownKind[idx] !== OPPOSITE[dir]
  );
}

function isHonestClueValue(v){
  return Number.isInteger(v) && v >= 1 && v <= 4;
}

function perpendicularOrientations(dir){
  return ORIENTATIONS.filter(o => o !== dir && o !== OPPOSITE[dir]);
}

// Plants a fresh number clue at `idx` and, in the very same step, DECIDES the orientation
// of every one of its still-unknown neighbors so their contributions sum back to exactly
// the value just committed — never leaving any of them for some later, unrelated process
// to resolve independently. That gap was the actual mismatched-number bug: picking a
// value from partway through the achievable range (rather than only the two extremes
// tryForceClue can pin down alone) left 2+ neighbors free, with nothing guaranteeing they
// eventually added back up to the number already committed to. Each neighbor's needed
// contribution (1, 0.5, or 0) maps to an exact orientation — only the 0.5 case has any
// real freedom (two perpendicular choices) — so this constructs a fully consistent
// assignment directly instead of gambling on one. Mutates color/knownKind/knownValue
// and appends idx plus every neighbor it just decided to `order`; returns the list of
// newly-set indices (for the caller to feed into runClosureBFS as the next queue), or
// null when no honest 1-4 value is achievable here at all.
function placeNumberClue(n, idx, color, knownKind, knownValue, order){
  const nb = neighborsOf(n, idx);
  let baseSum = 0;
  const unknown = [];
  nb.forEach(({idx: j, dir}) => {
    if(color[j] === 'none'){
      unknown.push({idx: j, dir});
    } else {
      baseSum += contribution(knownKind[j], dir);
    }
  });

  // A neighbor assigned "point away" (contributing 0 to THIS clue) only stays wall-honest
  // if it has some OTHER number-tile neighbor to touch instead — one with none at all
  // would need the costly final-check repair. Knowing which neighbors are in that bind
  // lets the value itself be chosen to avoid it: preferring a value whose "needed"
  // (points-toward count) covers at least every no-other-wall neighbor means none of them
  // HAVE to be the ones left pointing away.
  const withFlag = unknown.map(u => ({
    idx: u.idx,
    dir: u.dir,
    hasOtherWall: neighborsOf(n, u.idx).some(({idx: k}) => k !== idx && knownKind[k] === 'number')
  }));
  const noOtherWallCount = withFlag.filter(u => !u.hasOtherWall).length;

  // "유일칸" (a clue whose value forces every neighbor to point in, degree 2/3/4) is
  // reserved for the initial placeUniqueCells seeding only — a clue planted here later
  // must never reproduce that same unambiguous pattern, so v === degree is excluded
  // outright, never offered as a candidate in the first place.
  const degree = nb.length;
  const candidates = [];
  const roomyCandidates = [];
  for(let v = 1; v <= 4; v++){
    if(v === degree) continue;
    const needed = v - baseSum;
    if(needed < -1e-9 || needed > unknown.length + 1e-9) continue;
    candidates.push(v);
    if(needed >= noOtherWallCount - 1e-9) roomyCandidates.push(v);
  }
  if(candidates.length === 0) return null;
  const value = randomOf(roomyCandidates.length > 0 ? roomyCandidates : candidates);
  let needed = value - baseSum;

  // Even with a roomy value, still spend the "point away" assignments on hasOtherWall
  // neighbors first (their alternative wall keeps them honest either way), saving the
  // safe point-toward/perpendicular assignments for whichever no-other-wall neighbors
  // there are.
  const noOtherWall = shuffled(withFlag.filter(u => !u.hasOtherWall));
  const hasOtherWallList = shuffled(withFlag.filter(u => u.hasOtherWall));
  const ordered = noOtherWall.concat(hasOtherWallList);

  const newlySet = [];
  ordered.forEach(({idx: j, dir}) => {
    let want;
    if(needed >= 1 - 1e-9){ want = 1; needed -= 1; }
    else if(needed >= 0.5 - 1e-9){ want = 0.5; needed -= 0.5; }
    else { want = 0; }

    let kind;
    if(want === 1) kind = OPPOSITE[dir];
    else if(want === 0) kind = dir;
    else {
      // Real freedom here (two perpendicular choices) — prefer whichever doesn't touch
      // (rule 3) an already-placed half-block neighbor of j, when that's possible. Not a
      // full guarantee (closure forcing elsewhere can still create a violation), which is
      // why the caller re-checks with findRuleThreeViolationNear after this returns.
      const perp = perpendicularOrientations(dir);
      const perpSafe = perp.filter(o => !conflictsWithBlueNeighbor(n, j, o, knownKind, color));
      kind = randomOf(perpSafe.length ? perpSafe : perp);
    }
    color[j] = 'blue';
    knownKind[j] = kind;
    order.push(j);
    newlySet.push(j);
  });

  color[idx] = 'green';
  knownKind[idx] = 'number';
  knownValue[idx] = value;
  order.push(idx);
  newlySet.push(idx);

  return newlySet;
}

// A 'none' cell that's fully surrounded (every neighbor already known) but has no
// number-tile neighbor of its own is a dead end: it can't become a half-block (nothing to
// touch), and with zero unknown neighbors left it can't become a number clue either unless
// reading off exactly what's already fixed happens to land on an honest, non-unique-
// looking 1-4 value — anything else and there is no more freedom anywhere to fix it. Small
// grids rarely hit this by chance; larger ones hit it almost every attempt, because there
// are quadratically more "meeting points" where several independently-chosen half-block
// fills have to add up to something sensible with no coordination between them. Detecting
// it right after a placement — instead of only at the very end, once the rest of the
// board has already been built on top of the bad choice — is what makes backing out of
// that ONE placement (see the snapshot/restore trial below) actually pay off.
function isStuckCell(n, i, color, knownKind){
  if(color[i] === 'none'){
    const nb = neighborsOf(n, i);
    if(nb.some(({idx: j}) => knownKind[j] === 'number')) return false; // still eligible later
    if(nb.some(({idx: j}) => color[j] === 'none')) return false; // still has freedom, not stuck yet
    let sum = 0;
    nb.forEach(({idx: j, dir}) => { sum += contribution(knownKind[j], dir); });
    return !isHonestClueValue(sum) || sum === nb.length;
  }
  if(color[i] === 'blue'){
    // The mirror image of the 'none' case above: a half-block whose fixed orientation
    // points away from its only number-tile neighbor (or has none at all) is exactly what
    // the final isWallTouching repair pass exists to fix — but that repair only works
    // when reading off its neighbors' contributions lands on an honest, non-unique-
    // looking value. A cell can only be judged here once every one of ITS neighbors is
    // also resolved (an unresolved neighbor might still turn into a number cell later and
    // start being touched), and if the repair would fail, this is a dead end just like
    // the 'none' case — better caught now than at the very end of a large board, after
    // everything else has already been built on top of it.
    if(isWallTouching(n, i, knownKind)) return false;
    const nb = neighborsOf(n, i);
    if(nb.some(({idx: j}) => color[j] === 'none')) return false; // might still be rescued later
    let sum = 0;
    nb.forEach(({idx: j, dir}) => { sum += contribution(knownKind[j], dir); });
    return !isHonestClueValue(sum) || sum === nb.length;
  }
  return false;
}

// Full-board sweep, used only where there's no cheaper way to know what to check (e.g.
// right after the initial unique-cell seeding, before anything else has been decided).
function findStuckCell(n, total, color, knownKind){
  for(let i = 0; i < total; i++){
    if(isStuckCell(n, i, color, knownKind)) return i;
  }
  return -1;
}

// A cell can only newly BECOME stuck as a direct result of one specific placement: it has
// to be a neighbor of something that placement just resolved (that's the only way its own
// "are all my neighbors known yet" status could have just flipped). So instead of
// rescanning the whole board after every single trial placement — the dominant cost once
// grids get into the hundreds of cells, since backtracking means this check runs on the
// order of thousands of times per attempt — this only re-examines the neighbors of
// whatever cells `runClosureBFS` just resolved (`newlyResolved`, e.g. the slice of `order`
// added by that call), which is the same check with the same result but genuinely O(1)-ish
// per trial instead of O(board size).
function findStuckCellNear(n, newlyResolved, color, knownKind){
  const seen = new Set();
  for(const idx of newlyResolved){
    for(const {idx: j} of neighborsOf(n, idx)){
      if(seen.has(j)) continue;
      seen.add(j);
      if(isStuckCell(n, j, color, knownKind)) return j;
    }
  }
  return -1;
}

function snapshotState(color, knownKind, knownValue, order){
  return {color: color.slice(), knownKind: knownKind.slice(), knownValue: knownValue.slice(), orderLen: order.length};
}

function restoreState(snap, color, knownKind, knownValue, order){
  for(let i = 0; i < color.length; i++){
    color[i] = snap.color[i];
    knownKind[i] = snap.knownKind[i];
    knownValue[i] = snap.knownValue[i];
  }
  order.length = snap.orderLen;
}

// How many of the 4 orientations would keep cell `i` (already committed as a half-block)
// just as legal as its actual, committed knownKind[i] — i.e. every number-tile neighbor's
// sum still honest, the wall-touch rule still met, and no touching (rule 3) any OTHER
// already-known half-block neighbor. This is a strictly local snapshot of `i` at the
// moment it's checked: as more of the board fills in, i's already-known number/half-block
// neighbors can only ever ADD constraints, never remove one, so a count of 1 here can
// never later become 2 — which is exactly why every call site below only ever needs to
// check a cell once, right when it's freshly resolved to 'blue'. A count of 2+ means two
// (or more) orientations are equally legal for i RIGHT NOW, with nothing yet on the board
// to tell them apart — this is the ambiguity a single random pick used to paper over (a
// perpendicular pair both contributing 0.5 to the same clue is the simplest case).
function countValidOrientations(n, i, color, knownKind, knownValue){
  const nb = neighborsOf(n, i);
  const numberNb = nb.filter(({idx: j}) => knownKind[j] === 'number');
  const blueNb = nb.filter(({idx: j}) => color[j] === 'blue');
  let count = 0;
  ORIENTATIONS.forEach(o => {
    const honestForEveryClue = numberNb.every(({idx: j, dir}) => {
      const jnb = neighborsOf(n, j);
      let sum = 0;
      jnb.forEach(({idx: k, dir: d}) => { sum += (k === i) ? contribution(o, d) : contribution(knownKind[k], d); });
      return Math.abs(sum - knownValue[j]) < 1e-9;
    });
    if(!honestForEveryClue) return;
    if(!numberNb.some(({dir}) => o !== OPPOSITE[dir])) return; // must actually touch a wall
    if(blueNb.some(({idx: j, dir}) => halfBlocksTouch(o, dir, knownKind[j]))) return; // rule 3
    count++;
  });
  return count;
}

// Only ever called on a cell that was JUST set to 'blue' (see findAmbiguousCellNear) —
// older half-blocks are guaranteed count===1 forever by the monotonicity argument above,
// so re-checking them again later would be wasted work, not extra safety.
function isAmbiguousCell(n, i, color, knownKind, knownValue){
  return countValidOrientations(n, i, color, knownKind, knownValue) > 1;
}

// Mirrors findStuckCellNear/findRuleThreeViolationNear's shape, but only needs to look at
// `newlyResolved` itself (not their neighbors): a half-block's own ambiguity is decided
// once, at the moment IT is committed, from whatever's known then — see
// countValidOrientations for why that reading never goes stale.
function findAmbiguousCellNear(n, newlyResolved, color, knownKind, knownValue){
  for(const idx of newlyResolved){
    if(color[idx] === 'blue' && isAmbiguousCell(n, idx, color, knownKind, knownValue)) return idx;
  }
  return -1;
}

// Commits exactly ONE specific orientation at `idx` (no candidate loop — the choice-point
// search in generatePuzzleAttempt owns trying alternatives) and runs the closure that
// follows. Only rule 3 is checked directly (conflictsWithBlueNeighbor, by the caller,
// before this is even invoked) — never rule 1 (a clue's sum) or rule 2 (wall-touch): those
// are verified once in bulk after the whole board is filled (see the wall-touch repair pass
// and honest-value checks below). The closure can still cascade a rule-3 violation
// elsewhere via tryForceClue (which knows nothing about rule 3) or strand some cell with no
// honest value left (tryForceClue forcing a neighbor outright, bypassing the rule-1
// deferral that only applies to FREE half-block choices) — both checked here. Returns the
// newly-resolved indices on success, or null on either failure (the caller is responsible
// for restoring state and trying the next option).
function commitHalfBlockOrientation(n, idx, orientation, color, knownKind, knownValue, order){
  const orderLenBefore = order.length;
  color[idx] = 'blue';
  knownKind[idx] = orientation;
  order.push(idx);
  runClosureBFS(n, color, knownKind, knownValue, order, [idx]);
  const newlyResolved = order.slice(orderLenBefore);
  if(findStuckCellNear(n, newlyResolved, color, knownKind) === -1
    && findRuleThreeViolationNear(n, newlyResolved, color, knownKind) === -1){
    return newlyResolved;
  }
  return null;
}

// Turns `idx` (currently 'none') into a number clue in place via placeNumberClue (single
// attempt — again, the choice-point search owns retrying with different randomness by
// simply trying this same option again after a backtrack). Checked against all three
// deferred concerns at once: a stranded neighbor, a rule-3 cascade, and — now that
// backtracking can actually recover from it instead of just wasting a random retry — a
// genuinely tied neighbor assignment (findAmbiguousCellNear). Returns the newly-resolved
// indices, or null if this placement doesn't hold up.
function tryPlaceClueAt(n, idx, color, knownKind, knownValue, order){
  const orderLenBefore = order.length;
  const newlySet = placeNumberClue(n, idx, color, knownKind, knownValue, order);
  if(newlySet === null) return null;
  runClosureBFS(n, color, knownKind, knownValue, order, newlySet);
  const newlyResolved = order.slice(orderLenBefore);
  if(findStuckCellNear(n, newlyResolved, color, knownKind) === -1
    && findRuleThreeViolationNear(n, newlyResolved, color, knownKind) === -1
    && findAmbiguousCellNear(n, newlyResolved, color, knownKind, knownValue) === -1){
    return newlyResolved;
  }
  return null;
}

// Every 'none' cell reachable right now, framed as an ordered list of independent things to
// try — half-block orientations first (each checked against rule 3 up front so obviously-bad
// ones are never even attempted), then falling back to becoming a clue outright. Consumed
// one option at a time by generatePuzzleAttempt's choice-point search: trying the next
// option in the list IS what "retry this cell" means, and running out of options IS what
// triggers a real backtrack to whichever earlier choice point still has options left.
function halfBlockChoiceOptions(n, idx, color, knownKind){
  const halfOpts = shuffled(ORIENTATIONS.filter(o => !conflictsWithBlueNeighbor(n, idx, o, knownKind, color)))
    .map(orientation => ({type: 'half', idx, orientation}));
  halfOpts.push({type: 'clue', idx});
  return halfOpts;
}

// The reseed equivalent of halfBlockChoiceOptions: every (existing clue anchor, knight-move
// target) pair is its own independent option, each trying to plant a clue at a DIFFERENT
// spaced-out cell — not the same cell repeatedly. Without this periodic spacing, half-blocks
// placed far from any wall would almost all fail the final wall-touch repair's honesty check
// purely by chance (a repaired cell's sum is whatever its uncoordinated neighbors happen to
// add up to), sinking nearly every attempt on anything but a tiny board.
function reseedChoiceOptions(n, color, knownKind, candidateCap){
  const total = n * n;
  const numberIdxs = [];
  for(let i = 0; i < total; i++){ if(knownKind[i] === 'number') numberIdxs.push(i); }
  const anchors = shuffled(numberIdxs).slice(0, candidateCap);
  const opts = [];
  anchors.forEach(anchor => {
    shuffled(knightMoves(n, anchor).filter(i => color[i] === 'none')).forEach(idx => {
      opts.push({type: 'clue', idx});
    });
  });
  return opts;
}

function applyChoiceOption(n, opt, color, knownKind, knownValue, order){
  return opt.type === 'half'
    ? commitHalfBlockOrientation(n, opt.idx, opt.orientation, color, knownKind, knownValue, order)
    : tryPlaceClueAt(n, opt.idx, color, knownKind, knownValue, order);
}

// Generates the real puzzle by running the red→blue→green closure (runClosureBFS),
// then filling in everything the closure left undetermined via genuine
// chronological backtracking (a stack of choice points, each remembering which of its
// options are still untried) rather than undoing a random number of steps and hoping —
// picking the most-constrained reachable cell first (see the "advance" branch below) so a
// dead end is far less likely to come up in the first place. Every number clue still comes
// from exactly one of four honest sources: a seeded unique cell, a 'green' cell the closure
// discovered on its own, a deliberately-planted spacing clue, or a half-block repaired into
// one by the final wall-touch pass — never a value invented without reading its known
// neighbors.
function generatePuzzleAttempt(n){
  const total = n * n;
  const {isClue, clueValue} = placeUniqueCells(n);

  const color = new Array(total).fill('none');
  const knownKind = new Array(total).fill(undefined);
  const knownValue = new Array(total).fill(null);
  const order = [];

  const seedQueue = [];
  for(let i = 0; i < total; i++){
    if(!isClue[i]) continue;
    color[i] = 'red';
    knownKind[i] = 'number';
    knownValue[i] = clueValue[i];
    order.push(i);
    seedQueue.push(i);
  }
  runClosureBFS(n, color, knownKind, knownValue, order, seedQueue);

  // Every neighbor a unique cell forces has zero freedom (its orientation is dictated
  // entirely by the clue's extreme value) and this initial closure runs before any
  // backtracking history exists — so a rule-3 violation here can't be locally repaired at
  // all. Bailing out lets generatePuzzle's outer retry loop reroll a different unique-cell
  // seeding instead.
  if(findRuleThreeViolationFull(n, total, color, knownKind) !== -1) return null;

  const CANDIDATE_CAP = 15;

  // Frontier of already-placed half-blocks that might still have a 'none' neighbor to
  // expand into — a stack (push/pop off the end), not a rescan of the whole board, so
  // picking "a cell near an existing half-block" stays cheap no matter how large the board
  // gets. `noneCount` is maintained the same way (decremented by exactly how many cells
  // each successful step resolves) instead of being recomputed by scanning every cell.
  const frontier = [];
  const inFrontier = new Array(total).fill(false);
  function pushFrontier(i){
    if(color[i] === 'blue' && !inFrontier[i]){ inFrontier[i] = true; frontier.push(i); }
  }
  let noneCount = 0;
  // A restore() call reverts color/knownKind/etc. but has no idea about `frontier` or
  // `noneCount` — those are this loop's own bookkeeping, not part of the snapshotted
  // state, so they have to be rebuilt from scratch after any backtrack. That's an O(total)
  // scan, but backtracking now targets exactly the choice point that needs revisiting
  // (see the choice-point stack below), so it happens far less often than the naive
  // "undo a random number of steps" approach did.
  function rebuildBookkeeping(){
    frontier.length = 0;
    inFrontier.fill(false);
    noneCount = 0;
    for(let i = 0; i < total; i++){
      if(color[i] === 'none') noneCount++;
      else pushFrontier(i);
    }
  }
  rebuildBookkeeping();

  // How many half-blocks get placed, on average, between deliberate re-seeds — see
  // reseedChoiceOptions for why this matters (keeping the eventual wall-touch repair pass
  // cheap and near-certain to succeed, rather than reading an honest sum out of thin air
  // for a huge wall-less region).
  const RESEED_INTERVAL = Math.max(3, Math.round(n / 2));
  let sinceReseed = 0;

  // Genuine chronological backtracking: each choice point remembers the cell(s) it was
  // deciding, its still-untried options, and the exact state right before ANY of its
  // options were attempted. A dead end doesn't guess how far back the real problem was
  // (the naive design's fatal flaw — it kept re-deriving the same "boxed in" cell from
  // scratch because undoing a random number of steps almost never actually removed the
  // neighbor combination that caused it); it pops back to the most recent choice point
  // that still has an untried option and resumes EXACTLY there, which is provably where
  // the next different outcome can come from.
  const choiceStack = [];
  // Total option attempts (across the whole choice-point search), not "how many times we
  // backed up" — cheap insurance against a genuinely pathological seed, not something
  // normal attempts get anywhere near now that backtracking is targeted instead of random.
  let stepBudget = Math.max(4000, total * 40);
  // true only right after a pop-and-restore: the NEXT iteration must resume the
  // now-topmost choice point's remaining options (state was just restored to exactly
  // before any of them were tried) instead of pushing a fresh choice point for a new cell.
  // Every other iteration — including right after a SUCCESS, when the just-resolved choice
  // point is still sitting on top of the stack — advances to a brand-new one instead.
  let resuming = false;

  while(noneCount > 0){
    if(stepBudget-- <= 0) return null;

    let options;
    if(resuming){
      options = choiceStack[choiceStack.length - 1].options;
      resuming = false;
    } else {
      // Advancing normally: pick what to work on next and snapshot BEFORE touching it,
      // so every option tried against this snapshot starts from the same baseline.
      let freshOptions = null;
      if(frontier.length > 0 && sinceReseed < RESEED_INTERVAL){
        // Most-constrained-first among every still-reachable 'none' cell (adjacent to
        // the recent frontier): prefer whichever already has the MOST known neighbors
        // (fewest degrees of freedom left), rather than blindly taking whatever the
        // most-recently-added frontier cell happens to point at. A heavily-constrained
        // cell left for last is exactly where "all 4 orientations blocked AND no honest
        // clue value" dead ends come from — resolving it early, while its surroundings
        // still have freedom to accommodate it, heads off the trap instead of only
        // discovering it once nothing nearby can change anymore. Only the most recent
        // slice of the frontier is scanned (not the whole thing) so this stays cheap.
        let bestIdx = -1, bestKnownCount = -1;
        const seen = new Set();
        for(let fi = frontier.length - 1; fi >= 0 && fi >= frontier.length - 40; fi--){
          const cur = frontier[fi];
          neighborsOf(n, cur).forEach(({idx: j}) => {
            if(color[j] !== 'none' || seen.has(j)) return;
            seen.add(j);
            const knownCount = neighborsOf(n, j).filter(({idx: k}) => color[k] !== 'none').length;
            if(knownCount > bestKnownCount){ bestKnownCount = knownCount; bestIdx = j; }
          });
        }
        while(frontier.length > 0 && !neighborsOf(n, frontier[frontier.length - 1]).some(({idx: j}) => color[j] === 'none')){
          frontier.pop(); // drop fully-surrounded cells found stale while scanning above
        }
        if(bestIdx !== -1) freshOptions = halfBlockChoiceOptions(n, bestIdx, color, knownKind);
      }
      if(freshOptions === null) freshOptions = reseedChoiceOptions(n, color, knownKind, CANDIDATE_CAP);
      const snapshot = snapshotState(color, knownKind, knownValue, order);
      choiceStack.push({options: freshOptions, snapshot});
      options = freshOptions;
    }

    let newlyResolved = null;
    let succeededType = null;
    while(options.length > 0){
      const opt = options.shift();
      newlyResolved = applyChoiceOption(n, opt, color, knownKind, knownValue, order);
      if(newlyResolved){ succeededType = opt.type; break; }
      restoreState(choiceStack[choiceStack.length - 1].snapshot, color, knownKind, knownValue, order);
    }

    if(newlyResolved){
      newlyResolved.forEach(pushFrontier);
      noneCount -= newlyResolved.length;
      sinceReseed = succeededType === 'half' ? sinceReseed + 1 : 0;
      continue; // this choice point stays on the stack, exhausted or not, for future backtracking
    }

    // This choice point is fully exhausted (every option failed) — pop it and resume the
    // PREVIOUS choice point exactly where it left off, restoring to its own snapshot first.
    choiceStack.pop();
    if(choiceStack.length === 0) return null;
    restoreState(choiceStack[choiceStack.length - 1].snapshot, color, knownKind, knownValue, order);
    rebuildBookkeeping();
    sinceReseed = 0;
    resuming = true;
  }

  // Every clue this function deliberately PICKS (unique cells via placeUniqueCells,
  // freshly-planted ones via placeNumberClue) is already guaranteed an honest 1-4 integer
  // by construction — placeNumberClue decides its whole neighborhood in the same step
  // specifically so nothing is left for chance. What that can't fully rule out is a
  // 'green' cell that tryGreen finalizes as an incidental SIDE EFFECT of one of those
  // moves — e.g. placeNumberClue deciding several neighbors at once can, in the same
  // stroke, complete some unrelated third cell nearby with no say over what it adds up to
  // — or a cell tryForceClue forces outright, whose direction is dictated entirely by the
  // clue it's satisfying. So this pass is the final, unconditional check: any number cell
  // that still isn't an honest 1-4 integer means this particular random configuration was
  // never salvageable, and the whole attempt is discarded rather than shipping a clue that
  // doesn't match what's actually touching it.
  for(let i = 0; i < total; i++){
    if(knownKind[i] === 'number' && !isHonestClueValue(knownValue[i])) return null;
  }

  // This is where the wall-touch rule deferred during placement actually gets settled: every
  // half-block's fill must actually reach a number tile on at least one side
  // (isWallTouching) — sharing a border with a number cell isn't enough on its own if the
  // fill points straight away from it, the grid border doesn't count at all, and neither
  // does touching another half-block. commitHalfBlockOrientation never checks this while
  // filling (see its own comment), relying on reseedChoiceOptions' periodic spacing clues to keep
  // most half-blocks within reach of SOME wall — so this pass is expected to catch a real,
  // bounded number of stragglers on every attempt, not just rare edge cases. A cell that
  // fails this check contributes exactly 0 to every number-tile neighbor it has (that's
  // what failing means), so no EXISTING clue's sum depends on its half-block contribution
  // — turning it into a number clue itself (showing the honest sum its neighbors actually
  // contribute to it) changes nothing already placed. Only when that sum isn't itself an
  // honest 1-4 integer is there truly nothing to repair, and the whole attempt is
  // discarded instead — this is also why RESEED_INTERVAL matters: too sparse a spacing
  // leaves large wall-less regions here, and an uncoordinated sum landing honestly on pure
  // chance gets exponentially less likely the more of them there are.
  for(let i = 0; i < total; i++){
    if(color[i] !== 'blue') continue;
    if(isWallTouching(n, i, knownKind)) continue;
    const nb = neighborsOf(n, i);
    let sum = 0;
    nb.forEach(({idx: j, dir}) => { sum += contribution(knownKind[j], dir); });
    // Repairing into a clue that happens to equal its own degree would reintroduce the
    // exact 유일칸 pattern this generator now reserves for the initial seeding only — that
    // repair is refused (not attempted with some other value; there's only one honest sum
    // here) and the whole attempt is discarded instead.
    if(!isHonestClueValue(sum) || sum === nb.length) return null;
    color[i] = 'green';
    knownKind[i] = 'number';
    knownValue[i] = sum;
  }

  // "유일칸" — a clue whose value equals its own degree, forcing every neighbor to point
  // in with no other possible arrangement — is reserved for the initial placeUniqueCells
  // seeding (color 'red') only. placeNumberClue and the repair pass above already refuse
  // to offer that value as a candidate, but a 'green' cell tryGreen finalizes directly
  // from whatever its neighbors' orientations happen to add up to has no such filter (it
  // isn't a choice, just a readout) — so this catches that remaining case: any
  // non-seeded number cell that still landed on its own degree reproduces the reserved
  // pattern, and the whole attempt is discarded.
  for(let i = 0; i < total; i++){
    if(knownKind[i] !== 'number' || color[i] === 'red') continue;
    if(knownValue[i] === neighborsOf(n, i).length) return null;
  }

  // Final belt-and-suspenders pass for rule 3, mirroring the checks above: the incremental
  // checks threaded through the main loop (and the one right after the initial closure)
  // should already rule this out, and the wall-touch repair just above can only ever
  // remove a half-block from play (never introduce a new touching pair) — but this is the
  // one guaranteed place to catch anything those missed before the puzzle ships.
  if(findRuleThreeViolationFull(n, total, color, knownKind) !== -1) return null;

  const cells = new Array(total);
  for(let i = 0; i < total; i++){
    cells[i] = color[i] === 'blue'
      ? {type: 'player', answer: knownKind[i]}
      : {type: 'number', value: knownValue[i]};
  }

  return {size: n, cells};
}

const MAX_GENERATE_ATTEMPTS = 8000;

function generatePuzzle(n){
  // A whole attempt still occasionally has to be thrown away and restarted from the
  // unique-cell seeding — most commonly the wall-touch repair pass finding a straggler
  // half-block whose uncoordinated neighbors don't happen to sum to an honest value (see
  // that pass's own comment). A generous cap here trades a little loading-screen time for
  // making an outright failure practically impossible.
  //
  // NOTE: this build has no independent uniqueness solver. Verified empirically to leave
  // only a small residual chance (roughly 1-3 cells per puzzle) of a genuine
  // multi-orientation tie slipping through; a solver variant closed that gap but made
  // larger boards (13×13+) take tens of seconds per puzzle, so it was dropped.
  for(let attempt = 0; attempt < MAX_GENERATE_ATTEMPTS; attempt++){
    const puzzle = generatePuzzleAttempt(n);
    if(puzzle) return puzzle;
  }
  throw new Error(`Puzzle generation failed ${MAX_GENERATE_ATTEMPTS} times in a row (${n}×${n})`);
}

// Beyond the seeded unique cells (red) and their directly-forced neighbors (blue), some
// cells end up pinned down purely by deduction — e.g. an interior unique cell reading 4
// forces all 4 of its neighbors' directions (blue); if a corner's only two neighbors are
// both blue like that, the corner's own value is now computable too, with no guessing.
//
// This is a genuine multi-source BFS, not just a red/blue/green label: every seed cell
// starts the queue, and popping a cell either (a) forces its still-unknown neighbors'
// directions when the popped cell is a clue, or (b) checks whether a neighbor now has ALL
// of ITS neighbors known and can be computed outright. `order` is the sequence cells get
// settled in (callers slice it to see what a call newly resolved). Shared closure step, reused both for the initial
// red-seeded propagation and for every later continuation generatePuzzleAttempt's main
// loop kicks off (a freely-chosen half-block or a freshly-planted clue). This is a
// worklist / arc-consistency loop, not a one-shot pass: a number clue (red or green) can
// only be forced to pin down its remaining unknown neighbors once few enough of them are
// left — most simply, once EXACTLY one remains and the clue's fixed value pins that one
// neighbor's needed contribution to exactly 0 or 1 (the "ALL of them must be 0" / "ALL of
// them must be 1" extreme cases below are just the same rule applied when 2+ are still
// unknown). A clue that's genuinely ambiguous when first placed (2+ unknowns, value
// strictly between the extremes) can become forceable LATER purely because some of its
// OTHER neighbors got resolved through a completely different path (another clue's
// forcing, a green cascade elsewhere, or a later free placement) — so `tryForceClue` has
// to be retried on every clue every time ANY one of its neighbors newly resolves, not just once when the clue itself is
// popped. That's why every cell popped from the queue re-checks EVERY neighboring clue
// (tryForceClue) and every still-unknown neighbor (tryGreen), rather than only checking
// itself. Mutates color/knownKind/knownValue in place and appends every
// newly-settled cell to both `queue` and `order`, so calling this again later on the
// same arrays just continues the same fixed point from wherever it left off.
function runClosureBFS(n, color, knownKind, knownValue, order, queue){
  function enqueue(j){
    queue.push(j);
    order.push(j);
  }

  // `c`'s own extremes have to be judged against its CURRENTLY-known neighbors, not
  // against 0 and its raw degree: if `baseSum` is what its already-known neighbors
  // contribute and `u` is how many are still unknown, its value can only range over
  // [baseSum, baseSum + u] — so the two extremes that pin down EVERY remaining neighbor
  // with no ambiguity are value === baseSum (all point away, contributing 0) and
  // value === baseSum + u (all point in, contributing 1 each). Anything strictly between
  // leaves them genuinely ambiguous (several combinations could sum to it), so nothing
  // is forced yet — they stay open for tryGreen or another clue's forcing.
  function tryForceClue(c){
    if(color[c] !== 'red' && color[c] !== 'green') return;
    const nb = neighborsOf(n, c);
    let baseSum = 0;
    const unknown = [];
    nb.forEach(({idx: j, dir}) => {
      if(color[j] === 'none'){
        unknown.push({idx: j, dir});
      } else {
        baseSum += contribution(knownKind[j], dir);
      }
    });
    if(unknown.length === 0) return;
    const isMinValue = knownValue[c] === baseSum;
    const isMaxValue = knownValue[c] === baseSum + unknown.length;
    if(!isMinValue && !isMaxValue) return;
    unknown.forEach(({idx: j, dir}) => {
      color[j] = 'blue';
      knownKind[j] = isMaxValue ? OPPOSITE[dir] : dir;
      enqueue(j);
    });
  }

  function tryGreen(j){
    if(color[j] !== 'none') return;
    const jnb = neighborsOf(n, j);
    if(!jnb.every(({idx: k}) => color[k] !== 'none')) return;
    let sum = 0;
    jnb.forEach(({idx: k, dir}) => { sum += contribution(knownKind[k], dir); });
    // Every neighbor happening to be known at once doesn't guarantee their contributions
    // add up to anything a clue could honestly show (fractional, or exactly 0 — a 0 tile
    // is banned board-wide) — that combination is simply what the uncoordinated forcing
    // upstream produced. Finalizing it as a number clue anyway used to be the source of
    // both the mismatched-number bug and, at larger grid sizes, near-total generation
    // failure (every attempt tripping this exact check at the very end, after a great
    // deal of wasted work). Leaving j as 'none' instead costs nothing: nothing downstream
    // has read a contribution from j yet (that's what being 'none' until this very moment
    // means), so it's simply picked up later by the main loop's frontier expansion
    // (halfBlockChoiceOptions) or a spacing clue (reseedChoiceOptions), both of which choose a
    // value/orientation deliberately instead of gambling on one.
    if(!isHonestClueValue(sum)) return;
    color[j] = 'green';
    knownKind[j] = 'number';
    knownValue[j] = sum;
    enqueue(j);
  }

  for(let head = 0; head < queue.length; head++){
    const i = queue[head];

    // i itself might be a clue seeing its very first check (a freshly-seeded red clue,
    // or a cell that just became a green/freshly-planted number clue).
    tryForceClue(i);

    // i just became known, so every neighboring clue's unknown-count just shrank by
    // one — each deserves a fresh look — and every still-unknown neighbor might now
    // have every one of ITS OWN neighbors known.
    neighborsOf(n, i).forEach(({idx: j}) => {
      tryForceClue(j);
      tryGreen(j);
    });
  }
}
