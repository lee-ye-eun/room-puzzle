// Game screen: state, board editing (tools, drag painting, locks, undo/redo), shortcuts,
// timer, records, grading and rendering. Loaded last; its final lines start the page.

// ---- player cell values ----
const DIR_ORDER = ['blank','up','down','left','right'];
const MARK_ORDER = ['blank','q-tl','q-tr','q-bl','q-br'];
const STRIP_ORDER = ['blank','s-up','s-down','s-left','s-right'];
// cycle tools: each click advances the cell through its order (a value from the other
// order, e.g. a door under the pencil, starts the cycle like a blank)
const CYCLE_TOOLS = {'cycle-door': DIR_ORDER, 'cycle-mark': MARK_ORDER, 'cycle-strip': STRIP_ORDER};
// A cell holds 'blank', a door ('up'…), or a solving mark: a corner quarter ('q-*') or an
// edge strip ('s-*'). A mark of the same kind replaces the old one; a door (or the eraser)
// clears it. Quarters outrank strips: a quarter overwrites the cell's strip, and a strip
// is never added to a cell that already holds a quarter.
function markParts(v){
  const parts = {q: null, s: null};
  if(typeof v !== 'string') return parts;
  v.split('|').forEach(m => {
    if(m.startsWith('q-')) parts.q = m;
    else if(m.startsWith('s-')) parts.s = m;
  });
  return parts;
}
function joinMarks(parts){
  const list = [parts.q, parts.s].filter(Boolean);
  return list.length ? list.join('|') : 'blank';
}
function markKind(mark){ return mark.startsWith('q-') ? 'q' : 's'; }
function withMark(cur, mark){
  const parts = markParts(cur);
  if(markKind(mark) === 'q') parts.s = null;
  else if(parts.q) return cur;
  parts[markKind(mark)] = mark;
  return joinMarks(parts);
}
function withoutMark(cur, kind){
  const parts = markParts(cur);
  parts[kind] = null;
  return joinMarks(parts);
}
// a mark cycle tool steps just its own kind of mark and leaves the other kind in place
function cycleMark(order, cur){
  const kind = markKind(order[1]);
  const next = nextInCycle(order, markParts(cur)[kind] || 'blank');
  return next === 'blank' ? withoutMark(cur, kind) : withMark(cur, next);
}

function nextInCycle(order, cur){
  return order[(Math.max(0, order.indexOf(cur)) + 1) % order.length];
}
// solving marks: corner quarters ('q-*') and edge strips ('s-*'); never part of the answer
function isMark(v){ return typeof v === 'string' && (v.startsWith('q-') || v.startsWith('s-')); }

let state = {
  phase: 'start',      // 'start' | 'loading' | 'game'
  size: null,
  puzzle: null,
  playerState: [],     // per-cell 'blank'|'up'|'down'|'left'|'right', or a 'q-*'/'s-*' solving mark (player cells only)
  lockedCells: [],      // per-cell boolean — a locked player cell ignores left-click/tool edits
  submittedState: null,
  viewMode: 'play',     // 'play' | 'result' (after submitting: the submitted placement)
  selectedTool: null,   // null | 'cycle-door' | 'cycle-mark' | 'up' | 'down' | 'left' | 'right' | 'q-tl' | 'q-tr' | 'q-bl' | 'q-br' | 'cycle-strip' | 's-up' | 's-down' | 's-left' | 's-right' | 'erase'
  lockMode: false,      // when on, a tap/click toggles the cell's lock instead of editing it
                        // (the touch-screen stand-in for right-click); exclusive with selectedTool
  history: [],          // stack of {playerState, lockedCells} snapshots taken right before
                         // each edit, for undo
  future: [],            // snapshots popped off `history` by undo, for redo — cleared by
                          // any new edit
  submissionCorrect: null, // set by submitAnswer(): true/false once submitted, null before
  violations: new Set(),   // set by submitAnswer(): indices of cells that break a rule
  knobClues: null,         // knob mode only: {rows, cols} knob counts per half-line, from the answer
  knobViolations: new Set(), // set by submitAnswer(): 'r3' / 'c7' half-lines whose knob count is off
  knobDone: new Set(),       // knob clues the player clicked to grey out, same 'r3' / 'c7' keys
  roomDone: new Set()        // indices of rooms the player clicked to fade their number
};

// Snapshots playerState/lockedCells right before an edit so undo/redo can restore them.
// Called at the start of every board-mutating action; also clears `future`, since making a
// fresh edit after an undo abandons whatever redo path existed.
function recordHistory(){
  state.history.push({playerState: state.playerState.slice(), lockedCells: state.lockedCells.slice()});
  state.future = [];
}

function undo(){
  if(state.phase !== 'game' || state.viewMode !== 'play') return;
  if(state.history.length === 0) return;
  state.future.push({playerState: state.playerState.slice(), lockedCells: state.lockedCells.slice()});
  const prev = state.history.pop();
  state.playerState = prev.playerState;
  state.lockedCells = prev.lockedCells;
  render();
}

function redo(){
  if(state.phase !== 'game' || state.viewMode !== 'play') return;
  if(state.future.length === 0) return;
  state.history.push({playerState: state.playerState.slice(), lockedCells: state.lockedCells.slice()});
  const next = state.future.pop();
  state.playerState = next.playerState;
  state.lockedCells = next.lockedCells;
  render();
}

document.addEventListener('keydown', (e) => {
  if(!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z' || e.shiftKey) return;
  if(settingsOpen()) return;
  e.preventDefault();
  undo();
});

// Tool shortcuts: a letter picks its row's cycle tool, and holding the letter while
// pressing 1-4 picks that row's specific tool. Keys are matched by e.code so they work
// whatever the keyboard layout or IME (e.g. Korean input) is.
const TOOL_KEYS = {
  KeyD: ['cycle-door', 'up', 'down', 'left', 'right'],
  KeyF: ['cycle-mark', 'q-tl', 'q-tr', 'q-bl', 'q-br'],
  KeyG: ['cycle-strip', 's-up', 's-down', 's-left', 's-right']
};
// shortcut labels shown in the tool buttons' tooltips, by tool (data-dir) or 'lock'
const TOOL_SHORTCUT_LABELS = {erase: 'E', lock: 'L'};
Object.entries(TOOL_KEYS).forEach(([code, tools]) => {
  const letter = code.slice(3);
  tools.forEach((tool, k) => { TOOL_SHORTCUT_LABELS[tool] = k ? letter + ' + ' + k : letter; });
});
let heldToolKey = null;

// a shortcut picking a tool hidden by the folded palette unfolds it first
function selectToolByKey(tool){
  const btn = document.querySelector(`.tool-btn[data-dir="${tool}"]`);
  if(toolsCollapsed && btn && !btn.classList.contains('compact-keep')) toggleToolsCollapsed();
  selectTool(tool);
}

document.addEventListener('keydown', (e) => {
  if(e.ctrlKey || e.metaKey || e.altKey) return;
  if(settingsOpen() || state.phase !== 'game' || state.viewMode !== 'play') return;
  if(e.target.closest && e.target.closest('input, textarea, select')) return;
  const digit = /^(Digit|Numpad)([1-4])$/.exec(e.code);
  if(digit){
    if(!heldToolKey) return;
    e.preventDefault();
    selectToolByKey(TOOL_KEYS[heldToolKey][Number(digit[2])]);
    return;
  }
  if(e.repeat) return;
  if(TOOL_KEYS[e.code]){
    heldToolKey = e.code;
    selectToolByKey(TOOL_KEYS[e.code][0]);
  } else if(e.code === 'KeyE'){
    selectTool('erase');
  } else if(e.code === 'KeyL'){
    toggleLockMode();
  } else {
    return;
  }
  e.preventDefault();
});
document.addEventListener('keyup', (e) => {
  if(e.code === heldToolKey) heldToolKey = null;
});
window.addEventListener('blur', () => { heldToolKey = null; });

// ---- solve timer: runs from the moment the puzzle appears until it's submitted ----
const timer = {start: 0, elapsed: 0, running: false, tick: null};
function formatElapsed(ms){
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600), m = Math.floor(total / 60) % 60, sec = total % 60;
  const two = x => String(x).padStart(2, '0');
  return (h ? h + ':' + two(m) : two(m)) + ':' + two(sec);
}
function renderTimer(){
  const ms = timer.running ? performance.now() - timer.start : timer.elapsed;
  document.getElementById('solveTimerText').textContent = formatElapsed(ms);
  document.getElementById('solveTimer').classList.toggle('stopped', !timer.running);
}
function startTimer(){
  stopTimer();
  timer.start = performance.now();
  timer.elapsed = 0;
  timer.running = true;
  timer.tick = setInterval(renderTimer, 250);
  renderTimer();
}
function stopTimer(){
  if(timer.running) timer.elapsed = performance.now() - timer.start;
  timer.running = false;
  clearInterval(timer.tick);
  timer.tick = null;
}

// ---- my records: clear count + fastest RECORD_KEEP times per mode and size, kept in this browser ----
// Stored as {v:2, modes:{plain:{sizes:{"5":{clears, times:[ms, fastest first]}}}, knob:{…}}};
// a time pushed past RECORD_KEEP is dropped for good. Records saved before modes existed
// ({v:1, sizes}) were all plain-mode clears, so they carry over as the plain records.
// Storage failures (private windows etc.) never break play.
const RECORDS_KEY = 'roomPuzzle.records';
const RECORD_SIZES = [5, 7, 9, 15];
const RECORD_KEEP = 5;
function loadRecords(){
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(RECORDS_KEY)); } catch(e){}
  const savedModes = saved && saved.modes ? saved.modes : {plain: saved};
  const records = {v: 2, modes: {}};
  MODES.forEach(m => {
    const sizes = {};
    RECORD_SIZES.forEach(size => {
      const s = savedModes[m] && savedModes[m].sizes && savedModes[m].sizes[size];
      sizes[size] = {
        clears: s && Number.isFinite(s.clears) ? s.clears : 0,
        times: s && Array.isArray(s.times) ? s.times.filter(Number.isFinite).slice(0, RECORD_KEEP) : []
      };
    });
    records.modes[m] = {sizes};
  });
  return records;
}
function recordClear(recordMode, size, ms){
  const records = loadRecords();
  const entry = records.modes[recordMode] && records.modes[recordMode].sizes[size];
  if(!entry) return;
  entry.clears += 1;
  entry.times = entry.times.concat(ms).sort((a, b) => a - b).slice(0, RECORD_KEEP);
  try { localStorage.setItem(RECORDS_KEY, JSON.stringify(records)); } catch(e){}
}
// shows the records of the mode currently picked on the start screen
function renderRecords(){
  const records = loadRecords().modes[mode];
  const head = document.getElementById('recordsHead');
  const clears = document.getElementById('recordsClears');
  const times = document.getElementById('recordsTimes');
  head.innerHTML = clears.innerHTML = times.innerHTML = '';
  RECORD_SIZES.forEach(size => {
    const entry = records.sizes[size];
    const th = document.createElement('th');
    th.textContent = size + '×' + size;
    head.appendChild(th);
    const count = document.createElement('td');
    count.className = 'clear-count';
    count.textContent = entry.clears;
    clears.appendChild(count);
    const list = document.createElement('td');
    entry.times.forEach((ms, i) => {
      const p = document.createElement('p');
      p.textContent = (i + 1) + '. ' + formatElapsed(ms);
      list.appendChild(p);
    });
    times.appendChild(list);
  });
}

// ---- mode: plain doors, or doors with knobs plus per-line knob-count clues ----
// Picked on the start screen and remembered; the puzzle itself is generated the same way
// in both, knob mode only reads the clues off the generated answer.
const MODE_KEY = 'roomPuzzle.mode';
const MODES = ['plain', 'knob'];
let mode = 'plain';
try { const saved = localStorage.getItem(MODE_KEY); if(MODES.includes(saved)) mode = saved; } catch(e){}

function setMode(value){
  if(state.phase !== 'start') return;
  mode = MODES.includes(value) ? value : 'plain';
  try { localStorage.setItem(MODE_KEY, mode); } catch(e){}
  renderRules();
  render();
}

// Small example boards drawn under some rules, built from the board's own cell classes so
// they follow the theme. Each board is rows of cell specs: '' = no cell, a number = room,
// a door orientation = door; a spec object adds {bad} (drawn as a violation) or {val}
// (a small label in the door's white half). `ok` puts a ✓ / ✗ under the board.
const RULE_FIGURES = {
  0: [{rows: [[2]]}, {rows: [['up', 'down', 'left', 'right']]}],
  2: [{rows: [
    ['', {d: 'down', val: '1'}, ''],
    [{d: 'up', val: '0.5'}, 2, {d: 'down', val: '0.5'}],
    ['', {d: 'down', val: '0'}, '']
  ]}],
  3: [{ok: true, rows: [['right', 2, 'left']]}, {ok: false, rows: [[{d: 'left', bad: true}, 1, 'left']]}],
  4: [{ok: false, rows: [[{d: 'right', bad: true}, {d: 'left', bad: true}]]},
      {ok: false, rows: [[{d: 'up', bad: true}, {d: 'up', bad: true}]]},
      {ok: true, rows: [['up', 'down']]},
      {ok: true, rows: [['left', 'left']]}],
  knob: [{knob: true, rows: [['right', 3, 'left'], [1, 'up', 1]]}]
};

function miniBoard(fig){
  const rows = fig.rows.map(r => r.map(s => typeof s === 'string' && s ? {d: s} : s));
  const wrap = document.createElement('div');
  wrap.className = 'rule-example';
  const board = document.createElement('div');
  board.className = 'mini-board' + (fig.knob ? ' with-knob' : '');
  board.style.gridTemplateColumns = `repeat(${rows[0].length}, 1fr)`;
  rows.flat().forEach(s => {
    const div = document.createElement('div');
    if(s === '') div.className = 'mini-gap';
    else if(typeof s === 'number'){
      div.className = 'cell fixed-number';
      div.textContent = s;
    } else {
      div.className = 'cell player' + (s.bad ? ' violation' : '');
      const fill = document.createElement('span');
      fill.className = 'fill fill-' + s.d;
      div.appendChild(fill);
      if(s.val){
        const val = document.createElement('span');
        val.className = 'mini-val mini-val-' + s.d;
        val.textContent = s.val;
        div.appendChild(val);
      }
    }
    board.appendChild(div);
  });
  if(fig.knob){
    // the knob clue strips around the board, read off the example itself
    const n = rows.length, m = rows[0].length;
    const rowCount = new Array(2 * n).fill(0), colCount = new Array(2 * m).fill(0);
    rows.forEach((r, i) => r.forEach((s, j) => {
      const q = s && KNOB_QUARTER[s.d];
      if(!q) return;
      rowCount[2 * i + q[0]]++;
      colCount[2 * j + q[1]]++;
    }));
    const frame = document.createElement('div');
    frame.className = 'mini-knob-frame';
    frame.style.setProperty('--rows', n);
    frame.style.setProperty('--cols', m);
    [['mini-col-clues', colCount], ['mini-row-clues', rowCount]].forEach(([cls, counts]) => {
      const strip = document.createElement('div');
      strip.className = 'mini-clues ' + cls;
      counts.forEach((c, k) => {
        const span = document.createElement('span');
        span.className = Math.floor(k / 2) % 2 ? 'band' : '';
        span.textContent = c;
        strip.appendChild(span);
      });
      frame.appendChild(strip);
    });
    frame.appendChild(board);
    wrap.appendChild(frame);
  } else wrap.appendChild(board);
  if(fig.ok !== undefined){
    const mark = document.createElement('span');
    mark.className = 'rule-verdict ' + (fig.ok ? 'ok' : 'bad');
    mark.textContent = fig.ok ? '✓' : '✗';
    wrap.appendChild(mark);
  }
  return wrap;
}

// rule 8 only exists in knob mode
function renderRules(){
  const list = document.getElementById('rulesList');
  list.innerHTML = t('rulesBody') + (mode === 'knob' ? t('ruleKnob') : '');
  const items = list.children;
  Object.entries(RULE_FIGURES).forEach(([key, figs]) => {
    const li = key === 'knob' ? (mode === 'knob' ? items[items.length - 1] : null) : items[key];
    if(!li) return;
    const row = document.createElement('div');
    row.className = 'rule-figure';
    row.setAttribute('aria-hidden', 'true');
    figs.forEach(fig => row.appendChild(miniBoard(fig)));
    li.appendChild(row);
  });
}

// Which quarter of its cell a door's knob sits in, as [half-row, half-column] (0 = top/left):
// up → top-right, down → bottom-left, left → top-left, right → bottom-right.
const KNOB_QUARTER = {up: [0, 1], down: [1, 0], left: [0, 0], right: [1, 1]};

// Knob counts per half-row (rows[2r + h]) and per half-column (cols[2c + h]) for a board
// whose cells hold door orientations; anything else (rooms, blanks, marks) has no knob.
function knobCounts(n, doors){
  const rows = new Array(2 * n).fill(0);
  const cols = new Array(2 * n).fill(0);
  doors.forEach((d, i) => {
    const q = KNOB_QUARTER[d];
    if(!q) return;
    rows[2 * Math.floor(i / n) + q[0]]++;
    cols[2 * (i % n) + q[1]]++;
  });
  return {rows, cols};
}

// Puts state back to an empty round on the given puzzle (null = no puzzle, the start screen).
function resetRound(size, puzzle){
  state.size = size;
  state.puzzle = puzzle;
  state.knobClues = puzzle && mode === 'knob' ? knobCounts(size, puzzle.cells.map(c => c.answer)) : null;
  state.playerState = puzzle ? puzzle.cells.map(c => c.type === 'player' ? 'blank' : null) : [];
  state.lockedCells = puzzle ? puzzle.cells.map(() => false) : [];
  state.submittedState = null;
  state.viewMode = 'play';
  state.selectedTool = null;
  state.lockMode = false;
  state.history = [];
  state.future = [];
  state.submissionCorrect = null;
  state.violations = new Set();
  state.knobViolations = new Set();
  state.knobDone = new Set();
  state.roomDone = new Set();
}

function startGame(size){
  if(state.phase !== 'start') return;
  state.phase = 'loading';
  render();
  // the short delay lets the loading screen paint before generation blocks the page
  setTimeout(() => {
    let puzzle;
    try {
      puzzle = generatePuzzle(size);
    } catch(e){
      console.error(e);
      state.phase = 'start';
      render();
      alert(t('generateFailed'));
      return;
    }
    state.phase = 'game';
    resetRound(size, puzzle);
    render();
    startTimer();
  }, 30);
}

// The rules / how-to-play cards stay open or closed the way the player last left them.
['rulesCard', 'controlsCard'].forEach(id => {
  const card = document.getElementById(id);
  const key = 'roomPuzzle.' + id + 'Open';
  try { if(localStorage.getItem(key) === '0') card.open = false; } catch(e){}
  card.addEventListener('toggle', () => {
    try { localStorage.setItem(key, card.open ? '1' : '0'); } catch(e){}
  });
});

const TOOLS_COLLAPSED_KEY = 'roomPuzzle.toolsCollapsed';
let toolsCollapsed = true;
// collapsed unless the player opened it before (a saved '0')
try { toolsCollapsed = localStorage.getItem(TOOLS_COLLAPSED_KEY) !== '0'; } catch(e){ toolsCollapsed = true; }

// Folding the tool section leaves only the five cycle/lock/eraser tools; a selected tool
// that gets hidden is deselected so nothing invisible stays active.
function toggleToolsCollapsed(){
  toolsCollapsed = !toolsCollapsed;
  try { localStorage.setItem(TOOLS_COLLAPSED_KEY, toolsCollapsed ? '1' : '0'); } catch(e){}
  const compact = ['cycle-door', 'cycle-mark', 'cycle-strip', 'erase'];
  if(toolsCollapsed && state.selectedTool && !compact.includes(state.selectedTool)) state.selectedTool = null;
  render();
}

// Every button on the page clicks when pressed (tools, undo/redo, submit, restart, puzzle
// sizes, settings…). Board cells aren't buttons, so placing doors and marks stays silent.
document.addEventListener('click', (e) => {
  if(e.target.closest && e.target.closest('button')) playClick();
});

function selectTool(dir){
  if(state.phase !== 'game' || state.viewMode !== 'play') return;
  state.selectedTool = (state.selectedTool === dir) ? null : dir;
  state.lockMode = false;
  render();
}

function toggleLockMode(){
  if(state.phase !== 'game' || state.viewMode !== 'play') return;
  state.lockMode = !state.lockMode;
  if(state.lockMode) state.selectedTool = null;
  render();
}

function handleCellClick(index){
  if(state.phase !== 'game' || state.viewMode !== 'play') return;
  const cell = state.puzzle.cells[index];
  if(cell.type !== 'player') return;
  if(state.lockMode){ handleCellRightClick(index); return; }
  if(state.lockedCells[index]) return;
  const cur = state.playerState[index];
  if(state.selectedTool === 'erase'){
    if(cur === 'blank') return;
    recordHistory();
    state.playerState[index] = 'blank';
    playPlace();
    render();
    return;
  }
  recordHistory();
  if(!state.selectedTool){
    state.playerState[index] = nextInCycle(DIR_ORDER, cur);
  } else if(state.selectedTool === 'cycle-door'){
    state.playerState[index] = nextInCycle(DIR_ORDER, cur);
  } else if(CYCLE_TOOLS[state.selectedTool]){
    state.playerState[index] = cycleMark(CYCLE_TOOLS[state.selectedTool], cur);
  } else if(isMark(state.selectedTool)){
    const kind = markKind(state.selectedTool);
    state.playerState[index] = markParts(cur)[kind] === state.selectedTool
      ? withoutMark(cur, kind)
      : withMark(cur, state.selectedTool);
  } else {
    state.playerState[index] = (cur === state.selectedTool) ? 'blank' : state.selectedTool;
  }
  if(state.playerState[index] !== cur) playPlace();
  render();
}

// Right-click toggles a lock on the cell's CURRENT content, so a player who's sure about
// a cell can pin it and keep clicking around it (with a tool selected or not) without
// accidentally overwriting it. Locking doesn't change the cell's content, only whether
// handleCellClick is allowed to.
function handleCellRightClick(index){
  if(state.phase !== 'game' || state.viewMode !== 'play') return;
  const cell = state.puzzle.cells[index];
  if(cell.type !== 'player') return;
  recordHistory();
  state.lockedCells[index] = !state.lockedCells[index];
  render();
}

// Clicking a room fills in neighbors its number already decides. Only locked doors (and
// fixed cells) count as known; every other neighbor could still be 0, 0.5 or 1. Those
// unknowns are forced only when the room needs all of them fully attached (remaining ==
// count) or none of them (remaining == 0) — a forced 0.5 is never filled. Door overlap
// (rule 3) is deliberately ignored. Filled doors are locked, since they're now certain.
function autoFillRoom(index){
  const cells = state.puzzle.cells;
  let remaining = cells[index].value;
  const unknown = [];
  neighborsOf(state.size, index).forEach(({idx, dir}) => {
    const cell = cells[idx];
    const value = state.playerState[idx];
    if(cell.type !== 'player') remaining -= contribution(cell.type, dir);
    else if(state.lockedCells[idx] && ORIENTATIONS.includes(value)) remaining -= contribution(value, dir);
    else unknown.push({idx, dir});
  });
  if(unknown.length === 0) return;
  const attach = Math.abs(remaining - unknown.length) < 1e-9;
  const detach = Math.abs(remaining) < 1e-9;
  if(!attach && !detach) return;
  // a locked blank/marked neighbor is unknown but can't be overwritten, so it's left as is
  const fills = unknown
    .filter(({idx}) => !state.lockedCells[idx])
    .map(({idx, dir}) => ({idx, value: attach ? OPPOSITE[dir] : dir}));
  if(fills.length === 0) return;
  recordHistory();
  fills.forEach(({idx, value}) => {
    state.playerState[idx] = value;
    state.lockedCells[idx] = true;
  });
  playPlace();
}

// Clicking a room fades its number as "done" (a solving note like a greyed-out knob clue,
// so the fade itself isn't part of undo/redo), auto-filling whatever the number decides.
// Clicking a faded room restores its number without touching the board.
function handleRoomClick(index){
  if(state.phase !== 'game' || state.viewMode !== 'play') return;
  if(state.roomDone.has(index)){
    state.roomDone.delete(index);
  } else {
    autoFillRoom(index);
    state.roomDone.add(index);
  }
  render();
}

// Judges the player's CURRENT placement against the three rules directly — not against
// puzzle.cells' own stored answer — so an alternate valid placement (the puzzle turning out
// non-unique) is still graded correct. Reuses the exact same rule checks the generator
// itself relies on (contribution/isWallTouching/hasRuleThreeViolation), applied to
// whatever the player actually placed. Returns the indices of every cell at fault: a blank
// player cell, a number cell whose neighbors don't sum to its value (rule 1), a half-block
// whose black half touches no number cell (rule 2), and both half-blocks of every pair
// whose black halves touch (rule 3). An empty set means the placement is correct.
function findViolations(){
  const n = state.size;
  const total = n * n;
  const cells = state.puzzle.cells;
  // quarter marks are solving notes only, so a marked cell is graded as blank
  const kind = cells.map((c, i) => c.type !== 'player' ? 'number' : isMark(state.playerState[i]) ? 'blank' : state.playerState[i]);
  const color = cells.map((c, i) => c.type === 'player' && kind[i] !== 'blank' ? 'blue' : 'green');
  const bad = new Set();

  for(let i = 0; i < total; i++){
    if(cells[i].type === 'number'){
      let sum = 0;
      neighborsOf(n, i).forEach(({idx: j, dir}) => {
        if(kind[j] !== 'blank') sum += contribution(kind[j], dir);
      });
      if(Math.abs(sum - cells[i].value) > 1e-9) bad.add(i); // rule 1
    } else if(cells[i].type === 'player'){
      if(kind[i] === 'blank') bad.add(i); // must be fully filled in
      else if(!isWallTouching(n, i, kind)) bad.add(i); // rule 2
      else if(hasRuleThreeViolation(n, i, color, kind)) bad.add(i); // rule 3
    }
  }
  return bad;
}

// Knob mode's rule 7: every half-line's knob count must match its clue.
function findKnobViolations(){
  const bad = new Set();
  if(!state.knobClues) return bad;
  const got = knobCounts(state.size, state.playerState);
  ['rows', 'cols'].forEach(key => {
    state.knobClues[key].forEach((want, k) => {
      if(got[key][k] !== want) bad.add(key[0] + k);
    });
  });
  return bad;
}

function submitAnswer(){
  if(state.phase !== 'game' || state.viewMode !== 'play') return;
  state.submittedState = state.playerState.slice();
  state.viewMode = 'result';
  state.violations = findViolations();
  state.knobViolations = findKnobViolations();
  state.submissionCorrect = state.violations.size === 0 && state.knobViolations.size === 0;
  const wasRunning = timer.running; // a puzzle's clear is only recorded once
  stopTimer();
  renderTimer();
  if(state.submissionCorrect && wasRunning) recordClear(state.knobClues ? 'knob' : 'plain', state.size, Math.round(timer.elapsed));
  playResult(state.submissionCorrect);
  render();
}

function restart(){
  stopTimer();
  state.phase = 'start';
  resetRound(null, null);
  render();
}

// Touch long-press = right-click (lock toggle). Android also fires `contextmenu` on a
// long-press, and iOS never does, so a touch gesture is handled here alone and the
// matching contextmenu/click that may follow it is swallowed. The board is rebuilt on
// every render, so the gesture state lives here rather than on the cell elements.
const LONG_PRESS_MS = 450;
const LONG_PRESS_SLOP = 10;
let longPress = null;          // {index, x, y, timer} while a touch is held on a cell
let suppressNextClick = false; // the click that ends a long-press must not also edit the cell

// Drag painting: with a tool (door, mark, eraser) or lock mode on, pressing on a cell and
// dragging across others applies that tool to every cell passed over. Painting always SETS
// (a cell already holding the same door/mark, or already locked, stays as it is) rather
// than toggling the way a single click does; locked cells are never changed except by the
// lock tool, which just locks everything it passes. A right-button drag (mouse) locks the
// same way whatever tool is selected. A press that never leaves its first cell stays an
// ordinary click / right-click. One drag = one undo step.
let drag = null;               // {start, last, painted, lock, rightClick} while a press is held on the board
let rightDragJustEnded = false; // swallows the context menu Windows opens after a right-drag

function paintingActive(){
  return state.phase === 'game' && state.viewMode === 'play' && (state.lockMode || !!state.selectedTool);
}

// The value a drag paints. A cycle tool advances the drag's first cell one step and then
// paints that same result on every other cell it passes.
// Returns how the drag rewrites each cell it passes: (current value) => new value.
// Doors and the eraser replace the whole cell; a mark is added alongside the other kind.
function dragPaintValue(start){
  const tool = state.selectedTool;
  if(tool === 'erase') return () => 'blank';
  if(isMark(tool)) return cur => withMark(cur, tool);
  const order = CYCLE_TOOLS[tool];
  if(!order) return () => tool;
  const startsOnFreeCell = state.puzzle.cells[start].type === 'player' && !state.lockedCells[start];
  const startValue = startsOnFreeCell ? state.playerState[start] : 'blank';
  if(tool === 'cycle-door'){
    const door = nextInCycle(DIR_ORDER, startValue);
    return () => door;
  }
  const kind = markKind(order[1]);
  const next = nextInCycle(order, markParts(startValue)[kind] || 'blank');
  return next === 'blank' ? cur => withoutMark(cur, kind) : cur => withMark(cur, next);
}

// returns true when the cell's content actually changed (a lock doesn't count)
function paintCell(index, lock, value){
  if(state.puzzle.cells[index].type !== 'player') return false;
  if(lock){ state.lockedCells[index] = true; return false; }
  if(state.lockedCells[index]) return false;
  const before = state.playerState[index];
  state.playerState[index] = value(before);
  return state.playerState[index] !== before;
}

function cellIndexAt(x, y){
  const el = document.elementFromPoint(x, y);
  const cellEl = el && el.closest && el.closest('#board .cell');
  return cellEl ? Number(cellEl.dataset.index) : -1;
}

document.addEventListener('pointermove', (e) => {
  if(!drag) return;
  const index = cellIndexAt(e.clientX, e.clientY);
  if(index < 0 || index === drag.last) return;
  if(!drag.painted){
    cancelLongPress();
    recordHistory();
    if(!drag.lock) drag.value = dragPaintValue(drag.start);
    if(paintCell(drag.start, drag.lock, drag.value)) playPlace();
    drag.painted = true;
  }
  drag.last = index;
  if(paintCell(index, drag.lock, drag.value)) playPlace();
  render();
});
function endDrag(){
  if(drag && drag.painted) suppressNextClick = true; // the click ending a drag isn't a click
  if(drag && drag.rightClick){
    if(drag.painted) rightDragJustEnded = true;
    else handleCellRightClick(drag.start); // a plain right-click still toggles the lock
  }
  drag = null;
}
document.addEventListener('contextmenu', (e) => {
  if(rightDragJustEnded){ e.preventDefault(); rightDragJustEnded = false; }
});
document.addEventListener('pointerup', endDrag);
document.addEventListener('pointercancel', () => { drag = null; });

// Board zoom (the magnifier buttons next to undo/redo). The level is a per-device view
// preference, kept in localStorage; it isn't part of the puzzle state.
const ZOOM_LEVELS = [0.6, 0.8, 1, 1.25, 1.5, 2, 2.5, 3];
let zoomIndex = ZOOM_LEVELS.indexOf(1);
try {
  const savedZoom = ZOOM_LEVELS.indexOf(Number(localStorage.getItem('roomPuzzle.zoom')));
  if(savedZoom >= 0) zoomIndex = savedZoom;
} catch(e){}

function changeZoom(step){
  const next = Math.max(0, Math.min(ZOOM_LEVELS.length - 1, zoomIndex + step));
  if(next === zoomIndex) return;
  const wrap = document.querySelector('.board-wrap');
  // keep the point at the middle of the visible area in the middle after rescaling
  const ratio = ZOOM_LEVELS[next] / ZOOM_LEVELS[zoomIndex];
  const cx = wrap.scrollLeft + wrap.clientWidth / 2;
  zoomIndex = next;
  try { localStorage.setItem('roomPuzzle.zoom', String(ZOOM_LEVELS[zoomIndex])); } catch(e){}
  renderZoom();
  wrap.scrollLeft = cx * ratio - wrap.clientWidth / 2;
}

function renderZoom(){
  const zoom = ZOOM_LEVELS[zoomIndex];
  const wrap = document.querySelector('.board-wrap');
  wrap.style.setProperty('--zoom', zoom);
  wrap.classList.toggle('zoomed', zoom > 1);
  document.getElementById('zoomOutBtn').disabled = zoomIndex === 0;
  document.getElementById('zoomInBtn').disabled = zoomIndex === ZOOM_LEVELS.length - 1;
}

// While a tool is selected a one-finger drag paints, so a zoomed board is panned with two
// fingers instead. A second finger also cancels the paint drag / long-press it started.
let pan = null;
function touchMid(e){
  return {x: (e.touches[0].clientX + e.touches[1].clientX) / 2,
          y: (e.touches[0].clientY + e.touches[1].clientY) / 2};
}
document.querySelector('.board-wrap').addEventListener('touchstart', (e) => {
  if(e.touches.length < 2) return;
  if(drag && !drag.painted) drag = null;
  cancelLongPress();
  pan = touchMid(e);
}, {passive: true});
document.querySelector('.board-wrap').addEventListener('touchmove', (e) => {
  if(!pan || e.touches.length < 2) return;
  e.preventDefault();
  drag = null;
  const mid = touchMid(e);
  const wrap = e.currentTarget;
  wrap.scrollLeft -= mid.x - pan.x;
  window.scrollBy(0, -(mid.y - pan.y));
  pan = touchMid(e);
}, {passive: false});
document.querySelector('.board-wrap').addEventListener('touchend', (e) => {
  if(e.touches.length < 2) pan = null;
});

// Wired to every board cell (rooms included), so a drag can start anywhere on the board.
function startDrag(e, index){
  suppressNextClick = false;
  rightDragJustEnded = false;
  drag = null;
  const playing = state.phase === 'game' && state.viewMode === 'play';
  if(playing && e.button === 2 && e.pointerType !== 'touch'){
    drag = {start: index, last: index, painted: false, lock: true, rightClick: true};
  } else if(e.button === 0 && paintingActive()){
    drag = {start: index, last: index, painted: false, lock: state.lockMode, rightClick: false};
    // touch pointers are captured by the pressed cell; release so moves hit-test normally
    if(e.target.releasePointerCapture) e.target.releasePointerCapture(e.pointerId);
  }
}

function onCellPointerDown(e, index){
  startDrag(e, index);
  if(e.pointerType !== 'touch') return;
  cancelLongPress();
  const timer = setTimeout(() => {
    longPress = null;
    suppressNextClick = true;
    if(navigator.vibrate) navigator.vibrate(15);
    handleCellRightClick(index);
  }, LONG_PRESS_MS);
  longPress = {index, x: e.clientX, y: e.clientY, timer};
}
function cancelLongPress(){
  if(longPress){ clearTimeout(longPress.timer); longPress = null; }
}
document.addEventListener('pointermove', (e) => {
  if(longPress && Math.hypot(e.clientX - longPress.x, e.clientY - longPress.y) > LONG_PRESS_SLOP) cancelLongPress();
});
document.addEventListener('pointerup', cancelLongPress);
document.addEventListener('pointercancel', cancelLongPress);

function onCellClick(index){
  if(suppressNextClick){ suppressNextClick = false; return; }
  if(state.puzzle.cells[index].type === 'number') handleRoomClick(index);
  else handleCellClick(index);
}
// The lock toggle itself happens on pointerup (see endDrag) so a right-button press can
// turn into a drag; touch long-press is handled by its timer. Here we only keep the
// browser's menu from opening over the board.
function onCellContextMenu(e){
  e.preventDefault();
}

// Clicking a knob clue greys it out as "done"; clicking again restores it. A solving note
// only, so it isn't part of undo/redo.
function toggleKnobDone(key){
  if(state.knobDone.has(key)) state.knobDone.delete(key);
  else state.knobDone.add(key);
  render();
}

// The number strips beside and above the board: 2n numbers each, every cell's two halves
// sharing a band on alternate cells.
function renderKnobClues(){
  const n = state.size;
  [['rows', 'rowClues', 'gridTemplateRows'], ['cols', 'colClues', 'gridTemplateColumns']].forEach(([key, id, tracks]) => {
    const strip = document.getElementById(id);
    strip.style.gridTemplateRows = strip.style.gridTemplateColumns = '';
    strip.style[tracks] = `repeat(${2 * n}, minmax(0, 1fr))`;
    strip.innerHTML = '';
    state.knobClues[key].forEach((count, k) => {
      const span = document.createElement('span');
      span.className = 'knob-clue' + (Math.floor(k / 2) % 2 ? ' band' : '')
        + (state.knobDone.has(key[0] + k) ? ' done' : '')
        + (state.knobViolations.has(key[0] + k) ? ' violation' : '');
      span.textContent = count;
      span.onclick = () => toggleKnobDone(key[0] + k);
      strip.appendChild(span);
    });
  });
}

function render(){
  document.body.dataset.phase = state.phase;
  const startScreen = document.getElementById('startScreen');
  const loadingScreen = document.getElementById('loadingScreen');
  const gameScreen = document.getElementById('gameScreen');

  document.getElementById('modeSection').hidden = state.phase !== 'start';
  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.setAttribute('aria-checked', String(btn.dataset.mode === mode));
  });
  const knob = state.phase === 'game' && !!state.knobClues;
  if(knob) document.documentElement.dataset.knob = '';
  else delete document.documentElement.dataset.knob;

  startScreen.hidden = state.phase !== 'start';
  loadingScreen.hidden = state.phase !== 'loading';
  gameScreen.hidden = state.phase !== 'game';
  document.getElementById('recordsSection').hidden = state.phase !== 'start';
  if(state.phase === 'start') renderRecords();

  if(state.phase !== 'game') return;

  const submitted = state.submittedState !== null;
  document.getElementById('submitBtn').hidden = submitted;

  const resultBanner = document.getElementById('resultBanner');
  resultBanner.hidden = !submitted;
  if(submitted){
    resultBanner.textContent = t(state.submissionCorrect ? 'resultCorrect' : 'resultIncorrect');
    resultBanner.className = 'result-banner ' + (state.submissionCorrect ? 'correct' : 'incorrect');
  }

  document.getElementById('toolPalette').hidden = state.viewMode !== 'play';
  document.getElementById('toolPalette').classList.toggle('collapsed', toolsCollapsed);
  document.getElementById('toolToggleBtn').setAttribute('aria-expanded', String(!toolsCollapsed));
  document.querySelectorAll('.tool-btn').forEach(btn => {
    btn.classList.toggle('active', state.selectedTool === btn.dataset.dir);
  });
  document.getElementById('historyActions').hidden = state.viewMode !== 'play';
  document.getElementById('undoBtn').disabled = state.history.length === 0;
  document.getElementById('redoBtn').disabled = state.future.length === 0;
  renderZoom();
  document.getElementById('lockModeBtn').classList.toggle('active', state.lockMode);

  const board = document.getElementById('board');
  board.style.gridTemplateColumns = `repeat(${state.size}, minmax(0, 1fr))`;
  board.style.gridTemplateRows = `repeat(${state.size}, minmax(0, 1fr))`;
  board.style.setProperty('--n', state.size);
  board.classList.toggle('painting', paintingActive());
  const frame = document.getElementById('boardFrame');
  frame.classList.toggle('knob', knob);
  frame.style.setProperty('--n', state.size);
  if(knob) renderKnobClues();
  board.innerHTML = '';

  state.puzzle.cells.forEach((cell, i) => {
    const div = document.createElement('div');
    div.dataset.index = i;

    if(cell.type === 'number'){
      div.className = 'cell fixed-number' + (state.roomDone.has(i) ? ' done' : '')
        + (state.violations.has(i) ? ' violation' : '');
      div.textContent = cell.value;
    } else if(cell.type === 'full'){
      div.className = 'cell fixed-full';
    } else if(cell.type === 'empty'){
      div.className = 'cell fixed-empty';
    } else {
      const interactive = state.viewMode === 'play';
      const locked = interactive && state.lockedCells[i];
      div.className = 'cell player' + (interactive ? ' interactive' : '') + (locked ? ' locked' : '')
        + (state.violations.has(i) ? ' violation' : '');
      const dir = state.viewMode === 'play' ? state.playerState[i] : state.submittedState[i];

      if(dir && dir !== 'blank'){
        (isMark(dir) ? dir.split('|') : [dir]).forEach(part => {
          const fill = document.createElement('span');
          fill.className = isMark(part) ? 'mark mark-' + part : 'fill fill-' + part;
          div.appendChild(fill);
        });
      }
      if(interactive){
        div.onpointerdown = (e) => onCellPointerDown(e, i);
        div.onclick = () => onCellClick(i);
        div.oncontextmenu = onCellContextMenu;
      }
    }
    if(state.viewMode === 'play' && cell.type !== 'player'){
      div.onpointerdown = (e) => startDrag(e, i);
      div.oncontextmenu = onCellContextMenu;
      if(cell.type === 'number') div.onclick = () => onCellClick(i);
    }
    board.appendChild(div);
  });
}

applyLang();
render();
