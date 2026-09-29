// Scrambles the BGM tracks so the repo and site ship no directly playable audio files
// (the licence forbids leaving the raw tracks easy to download).
// Usage: node tools/encode-audio.mjs   — turns every audio/*.mp3 into audio/*.dat.
// The originals stay local only (audio/*.mp3 is git-ignored); index.html undoes this with
// the same keystream in unscrambleBgm(). XOR is its own inverse.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';

function scramble(bytes){
  let s = 0x5EED1234;
  for(let i = 0; i < bytes.length; i++){
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    bytes[i] ^= s & 0xFF;
  }
  return bytes;
}

for(const name of readdirSync('audio').filter(f => f.endsWith('.mp3'))){
  const out = 'audio/' + name.replace(/\.mp3$/, '.dat');
  writeFileSync(out, scramble(readFileSync('audio/' + name)));
  console.log(name, '->', out);
}
