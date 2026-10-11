// Sound: volume levels, synthesized sound effects, and the special themes' background music.

// ---- volume ----
// Two separate 0–5 volume bars (0 = mute, 5 = full, 3 by default): background music
// (the special themes' tracks) and sound effects (button clicks, correct/incorrect).
// A level saved by the older single "sound" bar seeds both on first load.
const SOUND_MAX = 5;
const SOUND_DEFAULT = 3;
const VOLUME_KEYS = {bgm: 'roomPuzzle.bgmLevel', sfx: 'roomPuzzle.sfxLevel'};
const volumes = {bgm: SOUND_DEFAULT, sfx: SOUND_DEFAULT};
function readLevel(key){
  try {
    const raw = localStorage.getItem(key);
    const v = Number(raw);
    if(raw !== null && Number.isInteger(v) && v >= 0 && v <= SOUND_MAX) return v;
  } catch(e){}
  return null;
}
{
  const legacy = readLevel('roomPuzzle.soundLevel');
  for(const kind of ['bgm', 'sfx']){
    const saved = readLevel(VOLUME_KEYS[kind]);
    volumes[kind] = saved !== null ? saved : legacy !== null ? legacy : SOUND_DEFAULT;
  }
}

function setVolume(kind, level){
  volumes[kind] = Math.min(SOUND_MAX, Math.max(0, level));
  try { localStorage.setItem(VOLUME_KEYS[kind], String(volumes[kind])); } catch(e){}
  if(kind === 'bgm'){
    bgm.volume = bgmVolume();
    if(volumes.bgm <= 0) bgm.pause();
    else if(bgm.paused) startBgm(false);
  }
  renderSettings();
}
function changeVolume(kind, delta){ setVolume(kind, volumes[kind] + delta); }

// ---- sound effects ----
// A soft "click" (달칵) like pressing a real button: synthesized with Web Audio, no files.
// It's two short taps — the press and, a moment later, a quieter release — each a burst
// of band-passed noise (the plastic "tick") over a brief low sine (the body "thud").
// Volume follows the settings bar (0 = silent, 5 = full).
let audioCtx = null;
function getAudioCtx(){
  if(!audioCtx){
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if(!Ctx) return null;
    audioCtx = new Ctx();
  }
  if(audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

function scheduleTap(ctx, dest, t, {tone, freq, gain, length}){
  const noiseLen = Math.ceil(ctx.sampleRate * length);
  const buf = ctx.createBuffer(1, noiseLen, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for(let i = 0; i < noiseLen; i++) data[i] = Math.random() * 2 - 1;
  const noise = ctx.createBufferSource();
  noise.buffer = buf;
  const band = ctx.createBiquadFilter();
  band.type = 'bandpass';
  band.frequency.value = freq;
  band.Q.value = 1.2;
  const noiseGain = ctx.createGain();
  noiseGain.gain.setValueAtTime(0.0001, t);
  noiseGain.gain.exponentialRampToValueAtTime(gain, t + 0.001);
  noiseGain.gain.exponentialRampToValueAtTime(0.0001, t + length);
  noise.connect(band).connect(noiseGain).connect(dest);
  noise.start(t);
  noise.stop(t + length);

  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(tone, t);
  osc.frequency.exponentialRampToValueAtTime(tone * 0.6, t + length * 1.5);
  const oscGain = ctx.createGain();
  oscGain.gain.setValueAtTime(0.0001, t);
  oscGain.gain.exponentialRampToValueAtTime(gain * 0.9, t + 0.002);
  oscGain.gain.exponentialRampToValueAtTime(0.0001, t + length * 1.5);
  osc.connect(oscGain).connect(dest);
  osc.start(t);
  osc.stop(t + length * 1.5);
}

function scheduleClick(ctx, dest, t){
  scheduleTap(ctx, dest, t,        {tone: 220, freq: 2600, gain: 0.9, length: 0.022}); // press: 달
  scheduleTap(ctx, dest, t + 0.05, {tone: 170, freq: 1900, gain: 0.5, length: 0.018}); // release: 칵
}

// One soft bell-like note: a sine plus a quieter octave partial, quick attack, gentle decay.
function scheduleNote(ctx, dest, t, freq, {gain = 0.5, length = 0.5, type = 'sine'} = {}){
  [[1, 1], [2, 0.25]].forEach(([mult, level]) => {
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq * mult, t);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain * level, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + length);
    osc.connect(g).connect(dest);
    osc.start(t);
    osc.stop(t + length + 0.02);
  });
}

// correct: a bright rising three-note chime (C6 → E6 → G6, then a held C7)
function scheduleCorrect(ctx, dest, t){
  scheduleNote(ctx, dest, t,        1046.5, {gain: 0.45, length: 0.35});
  scheduleNote(ctx, dest, t + 0.09, 1318.5, {gain: 0.45, length: 0.35});
  scheduleNote(ctx, dest, t + 0.18, 1568.0, {gain: 0.45, length: 0.4});
  scheduleNote(ctx, dest, t + 0.27, 2093.0, {gain: 0.4,  length: 0.7});
}

// incorrect: a soft, low two-note fall (A3 → F3) — clearly "not quite", without a harsh buzz
function scheduleIncorrect(ctx, dest, t){
  scheduleNote(ctx, dest, t,        220.0, {gain: 0.6, length: 0.28, type: 'triangle'});
  scheduleNote(ctx, dest, t + 0.2,  174.6, {gain: 0.6, length: 0.5,  type: 'triangle'});
}

function playSound(schedule, delay = 0){
  if(volumes.sfx <= 0) return;
  const ctx = getAudioCtx();
  if(!ctx) return;
  const master = ctx.createGain();
  const v = volumes.sfx / SOUND_MAX;
  master.gain.value = 0.35 * Math.pow(v, 1.5); // perceptual-ish curve, so low steps stay quiet
  master.connect(ctx.destination);
  schedule(ctx, master, ctx.currentTime + 0.005 + delay);
}

// ---- placing on the board: one short sound per theme ----
function scheduleNoiseBurst(ctx, dest, t, {freq, type = 'lowpass', gain, length}){
  const len = Math.ceil(ctx.sampleRate * length);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for(let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const filter = ctx.createBiquadFilter();
  filter.type = type;
  filter.frequency.value = freq;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.002);
  g.gain.exponentialRampToValueAtTime(0.0001, t + length);
  src.connect(filter).connect(g).connect(dest);
  src.start(t);
  src.stop(t + length);
}
function scheduleSweep(ctx, dest, t, {type, from, to, gain, length, sweep = length}){
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(from, t);
  osc.frequency.exponentialRampToValueAtTime(to, t + sweep);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.003);
  g.gain.exponentialRampToValueAtTime(0.0001, t + length);
  osc.connect(g).connect(dest);
  osc.start(t);
  osc.stop(t + length + 0.02);
}

// basic themes: a dull, soft "tuk" — a low falling thump with a muffled knock
function schedulePlaceThud(ctx, dest, t){
  scheduleSweep(ctx, dest, t, {type: 'sine', from: 160, to: 70, gain: 0.9, length: 0.11, sweep: 0.08});
  scheduleNoiseBurst(ctx, dest, t, {freq: 900, gain: 0.35, length: 0.03});
}
// mediterranean: a water droplet — a quick rising "plip"
function schedulePlaceDrop(ctx, dest, t){
  scheduleSweep(ctx, dest, t, {type: 'sine', from: 480, to: 1500, gain: 0.55, length: 0.13, sweep: 0.05});
  scheduleSweep(ctx, dest, t + 0.06, {type: 'sine', from: 900, to: 1800, gain: 0.12, length: 0.08, sweep: 0.03});
}
// rococo: a low music-box note — pure sine partials only (no noise, no buzzy waves):
// the tine's fundamental ringing long, a soft octave, and a faint high shimmer that fades fast
const MUSIC_BOX_NOTES = [392.0, 440.0, 523.3, 587.3, 659.3]; // G4 A4 C5 D5 E5
function scheduleMusicBoxNote(ctx, dest, t, freq, gain){
  [[1, 1, 1.6], [2, 0.3, 0.7], [5.4, 0.07, 0.18]].forEach(([mult, level, decay]) => {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq * mult, t);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain * level, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    osc.connect(g).connect(dest);
    osc.start(t);
    osc.stop(t + decay + 0.02);
  });
}
function schedulePlaceMusicBox(ctx, dest, t){
  scheduleMusicBoxNote(ctx, dest, t, MUSIC_BOX_NOTES[Math.floor(Math.random() * MUSIC_BOX_NOTES.length)], 0.62);
}
// cyberpunk: a short synthetic double blip
function schedulePlaceBlip(ctx, dest, t){
  scheduleSweep(ctx, dest, t, {type: 'square', from: 1300, to: 650, gain: 0.16, length: 0.06});
  scheduleSweep(ctx, dest, t + 0.045, {type: 'square', from: 1950, to: 1950, gain: 0.09, length: 0.04});
}
const PLACE_SOUNDS = {med: schedulePlaceDrop, rococo: schedulePlaceMusicBox, cyber: schedulePlaceBlip};
let lastPlaceSoundAt = 0;
function playPlace(){
  const now = performance.now();
  if(now - lastPlaceSoundAt < 45) return; // a fast drag shouldn't turn into a buzz
  lastPlaceSoundAt = now;
  playSound(PLACE_SOUNDS[currentTheme()] || schedulePlaceThud);
}

function playClick(){ playSound(scheduleClick); }

// The title's door: a knock on a thick wooden door (똑똑). Each knock is a knuckle's click —
// a very short noise burst, kept low so it doesn't sound sharp — ringing the door panel's
// few low resonances; the second knock follows after an unhurried pause, a little softer.
function scheduleKnockHit(ctx, dest, t, gain){
  const len = Math.ceil(ctx.sampleRate * 0.03);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for(let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (ctx.sampleRate * 0.003));
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const click = ctx.createBiquadFilter();
  click.type = 'bandpass';
  click.frequency.value = 650;
  click.Q.value = 0.8;
  const clickGain = ctx.createGain();
  clickGain.gain.value = gain * 0.55;
  src.connect(click).connect(clickGain).connect(dest);
  src.start(t);
  // the panel's body: a low thump plus two fainter wooden overtones
  [[115, 0.06, 1], [260, 0.035, 0.5], [540, 0.015, 0.18]].forEach(([freq, decay, level]) => {
    const osc = ctx.createOscillator();
    osc.frequency.setValueAtTime(freq * 1.06, t);
    osc.frequency.exponentialRampToValueAtTime(freq, t + 0.025);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain * level, t + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, t + decay * 4);
    osc.connect(g).connect(dest);
    osc.start(t);
    osc.stop(t + decay * 4 + 0.02);
  });
}
function scheduleKnock(ctx, dest, t){
  scheduleKnockHit(ctx, dest, t, 0.95);
  scheduleKnockHit(ctx, dest, t + 0.22, 0.8);
}
function playKnock(){ playSound(scheduleKnock); }

function scheduleDecayingNoise(ctx, dest, t, {freq, q = 1, decay, gain}){
  const len = Math.ceil(ctx.sampleRate * decay * 6);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for(let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (ctx.sampleRate * decay));
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = freq;
  filter.Q.value = q;
  const g = ctx.createGain();
  g.gain.value = gain;
  src.connect(filter).connect(g).connect(dest);
  src.start(t);
}
function scheduleDoorBreak(ctx, dest, t){
  scheduleDecayingNoise(ctx, dest, t, {freq: 1300, q: 0.7, decay: 0.02, gain: 1.1});
  const osc = ctx.createOscillator();
  osc.frequency.setValueAtTime(110, t);
  osc.frequency.exponentialRampToValueAtTime(66, t + 0.32);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.9, t + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.32);
  osc.connect(g).connect(dest);
  osc.start(t);
  osc.stop(t + 0.34);
  for(let i = 0; i < 22; i++){
    const x = Math.pow(Math.random(), 1.8);
    scheduleDecayingNoise(ctx, dest, t + 0.01 + x * 0.45, {
      freq: 2200 * (0.6 + 0.8 * Math.random()), q: 2,
      decay: 0.002 + 0.003 * Math.random(),
      gain: 0.35 * (1 - 0.7 * x) * (0.5 + Math.random())
    });
  }
}
const DOOR_BREAK_KNOCKS = 8;
const DOOR_BREAK_WINDOW_MS = 1000;
let doorKnocks = [];
function knockDoor(){
  const door = document.querySelector('.title-door');
  if(door.classList.contains('broken')) return;
  const now = performance.now();
  doorKnocks = doorKnocks.filter(at => now - at < DOOR_BREAK_WINDOW_MS);
  doorKnocks.push(now);
  if(doorKnocks.length < DOOR_BREAK_KNOCKS){ playKnock(); return; }
  door.classList.add('broken');
  playSound(scheduleDoorBreak);
}
// played on submit, just after the submit button's own click
function playResult(correct){ playSound(correct ? scheduleCorrect : scheduleIncorrect, 0.12); }

// ---- background music for the special themes ----
// Each special theme loops its own track; switching themes restarts from the beginning.
// Browsers only allow audio after a user gesture, so a theme restored from a previous
// visit starts playing on the first tap/click anywhere on the page.
// The tracks ship scrambled (tools/encode-audio.mjs), since the licence forbids leaving the
// raw audio easy to download; each is fetched once, unscrambled and played from a blob URL.
const BGM_TRACKS = {med: 'audio/bgm-med.dat', rococo: 'audio/bgm-rococo.dat', cyber: 'audio/bgm-cyber.dat'};
const bgm = new Audio();
bgm.loop = true;
bgm.preload = 'none';
let bgmTrack = null;
const bgmUrls = {};    // track -> blob URL, once unscrambled
const bgmLoading = {}; // track -> promise while it's being fetched

// same keystream as tools/encode-audio.mjs; XOR is its own inverse
function unscrambleBgm(bytes){
  let s = 0x5EED1234;
  for(let i = 0; i < bytes.length; i++){
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    bytes[i] ^= s & 0xFF;
  }
  return bytes;
}

// A failed fetch is forgotten so the next attempt (the next gesture) tries again.
function loadBgm(track){
  if(!bgmLoading[track]){
    bgmLoading[track] = fetch(track)
      .then(res => { if(!res.ok) throw new Error(res.status); return res.arrayBuffer(); })
      .then(buf => {
        const blob = new Blob([unscrambleBgm(new Uint8Array(buf))], {type: 'audio/mpeg'});
        bgmUrls[track] = URL.createObjectURL(blob);
      })
      .catch(e => { delete bgmLoading[track]; throw e; });
  }
  return bgmLoading[track];
}

function bgmVolume(){
  const v = volumes.bgm / SOUND_MAX;
  return 0.6 * Math.pow(v, 1.5); // same perceptual curve as the effects
}

function startBgm(fromStart){
  const track = BGM_TRACKS[currentTheme()] || null;
  if(!track){
    bgm.pause();
    bgmTrack = null;
    return;
  }
  if(!bgmUrls[track]){
    // not unscrambled yet: stop the old track, and come back once this one is ready
    // (if its theme is still on). A play blocked by then waits for the next gesture.
    bgm.pause();
    loadBgm(track).then(() => { if(BGM_TRACKS[currentTheme()] === track) startBgm(false); }, () => {});
    return;
  }
  if(track !== bgmTrack){
    bgm.src = bgmUrls[track];
    bgmTrack = track;
  } else if(fromStart){
    bgm.currentTime = 0;
  }
  bgm.volume = bgmVolume();
  if(volumes.bgm <= 0 || document.hidden){ bgm.pause(); return; }
  const played = bgm.play();
  if(played && played.catch) played.catch(() => {}); // blocked until a user gesture
}

// Start the saved theme's music on a user gesture if it isn't playing yet. Chrome only
// counts some events as a gesture (a touch pointerdown doesn't; its click/touchend
// does), so listen to all of them — a blocked attempt just waits for the next one.
['pointerdown', 'touchend', 'click', 'keydown'].forEach(type => {
  document.addEventListener(type, () => {
    if(BGM_TRACKS[currentTheme()] && bgm.paused && volumes.bgm > 0 && !document.hidden) startBgm(false);
  }, true);
});
// fetch a restored theme's track up front, so the first gesture can start it right away
if(BGM_TRACKS[currentTheme()]) loadBgm(BGM_TRACKS[currentTheme()]).catch(() => {});
// pause while the tab is in the background, pick up where it left off on return
document.addEventListener('visibilitychange', () => {
  if(document.hidden) bgm.pause();
  else startBgm(false);
});
