// Short UI chimes for starting/stopping the scanner — generated tones via
// the Web Audio API rather than shipped audio files, so there's no asset to
// bundle/license and no extra network/IPC round trip. One shared
// AudioContext, created lazily on first use (browsers refuse to start one
// before a user gesture anyway, and a button click already is one).
let ctx: AudioContext | null = null;
function getContext(): AudioContext {
  if (!ctx) ctx = new AudioContext();
  return ctx;
}

// Per explicit instruction — a single Config-level on/off switch for every
// sound in the app. A plain module-level flag rather than each caller
// checking config itself, since these play functions get called from
// several unrelated components (Dashboard, Sidebar, App.tsx) that
// shouldn't each need their own copy of config.soundEnabled — App.tsx
// (already the one place listening for config changes app-wide, for the
// theme) keeps this in sync via setSoundEnabled on load and on every
// config:updated broadcast.
let soundEnabled = true;
export function setSoundEnabled(enabled: boolean): void {
  soundEnabled = enabled;
}

// Per explicit instruction — a synthetic reverb tail for the start/stop
// sounds, via a ConvolverNode fed a generated impulse response (exponentially
// decaying white noise) rather than a shipped audio file — same "no asset to
// bundle" reasoning as everything else in this module. Built once and
// reused, like the tab-switch tick's noise buffer used to be.
let reverbImpulse: AudioBuffer | null = null;
function getReverbImpulse(audioCtx: AudioContext): AudioBuffer {
  if (!reverbImpulse) {
    const durationSec = 1.6;
    const decay = 2.4;
    const length = Math.floor(audioCtx.sampleRate * durationSec);
    reverbImpulse = audioCtx.createBuffer(2, length, audioCtx.sampleRate);
    for (let channel = 0; channel < reverbImpulse.numberOfChannels; channel++) {
      const data = reverbImpulse.getChannelData(channel);
      for (let i = 0; i < length; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
      }
    }
  }
  return reverbImpulse;
}

// Splits `source` into a dry (unprocessed, full-volume) path and a wet
// (reverb-convolved) path and mixes both into the destination — 100% wet
// on its own would sound like the note is UNDERWATER, not just "in a room."
function connectWithReverb(audioCtx: AudioContext, source: AudioNode, wetAmount: number): void {
  source.connect(audioCtx.destination);
  const convolver = audioCtx.createConvolver();
  convolver.buffer = getReverbImpulse(audioCtx);
  const wet = audioCtx.createGain();
  wet.gain.value = wetAmount;
  source.connect(convolver);
  convolver.connect(wet);
  wet.connect(audioCtx.destination);
}

function playChimeNote(audioCtx: AudioContext, freq: number, startTime: number, peakGain: number, durationSec: number, wetAmount: number): void {
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(freq, startTime);
  gain.gain.setValueAtTime(0, startTime);
  gain.gain.linearRampToValueAtTime(peakGain, startTime + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.001, startTime + durationSec);
  osc.connect(gain);
  connectWithReverb(audioCtx, gain, wetAmount);
  osc.start(startTime);
  osc.stop(startTime + durationSec + 0.05);
}

// Per explicit instruction — "a chime that goes from pitches C -> F": two
// distinct notes (C5 then F5, a rising fourth), not the old single
// oscillator gliding continuously between two frequencies — reads as an
// actual little chime/doorbell figure instead of a "boop." A touch of
// reverb (see connectWithReverb) softens the tail instead of an abrupt cutoff.
export function playStartSound(): void {
  if (!soundEnabled) return;
  try {
    const audioCtx = getContext();
    const now = audioCtx.currentTime;
    playChimeNote(audioCtx, 523.25 /* C5 */, now, 0.22, 0.24, 0.28);
    playChimeNote(audioCtx, 698.46 /* F5 */, now + 0.12, 0.22, 0.32, 0.28);
  } catch {
    // Best-effort — a browser blocking audio (autoplay policy, no audio
    // device) shouldn't ever break the actual start/stop action.
  }
}

// Per explicit instruction — "a 2 octave lower G": a single low G (two
// octaves below the start chime's own C5-F5 register — G3, not G5), held
// a little longer than either start note for a "settling down" close, with
// more reverb than the start chime for a bigger, roomier tail.
export function playStopSound(): void {
  if (!soundEnabled) return;
  try {
    const audioCtx = getContext();
    playChimeNote(audioCtx, 196.0 /* G3 */, audioCtx.currentTime, 0.26, 0.55, 0.4);
  } catch {
    // Best-effort, same as above.
  }
}

// Per explicit instruction — "a C major glitter sound" for a confirmed
// deal, then "an octave higher": an ascending C-major triad-plus-octave
// (C6, E6, G6, C7), each note fired close on the heels of the last (60ms
// apart) so they overlap and ring together into a shimmering cascade
// rather than a slow, deliberate arpeggio — same playChimeNote/reverb
// machinery as start/stop, just more notes stacked in quick succession for
// the "glitter" effect. Replaces the old single pitch-drop "pop" this used
// to be (moved here from App.tsx, which built its own separate
// AudioContext for it, for the same reverb treatment everything else in
// this module gets).
const DEAL_GLITTER_NOTES = [1046.5 /* C6 */, 1318.51 /* E6 */, 1567.98 /* G6 */, 2093.0 /* C7 */];
export function playDealSound(): void {
  if (!soundEnabled) return;
  try {
    const audioCtx = getContext();
    const now = audioCtx.currentTime;
    DEAL_GLITTER_NOTES.forEach((freq, i) => {
      playChimeNote(audioCtx, freq, now + i * 0.06, 0.18, 0.4, 0.32);
    });
  } catch {
    // Best-effort — a browser blocking audio (autoplay policy, no audio
    // device) shouldn't ever break anything else about a confirmed deal.
  }
}

// Per explicit instruction — "a D pitch in between the start and stop
// sounds... make it more similar to the stop sound": D4 (293.66 Hz) sits
// between the stop chime's G3 (196 Hz) and the start chime's own opening
// note, C5 (523.25 Hz). Built from the SAME playChimeNote used for start/
// stop (sine wave, same reverb treatment) rather than the earlier
// triangle-wave "tick," per "more similar to the stop sound" — just
// quieter and shorter, since this fires on ordinary navigation (every tab
// click), not a meaningful state change worth as much presence as
// starting/stopping the scanner.
export function playTabSwitchSound(): void {
  if (!soundEnabled) return;
  try {
    const audioCtx = getContext();
    playChimeNote(audioCtx, 293.66 /* D4 */, audioCtx.currentTime, 0.16, 0.22, 0.3);
  } catch {
    // Best-effort, same as the bloops above.
  }
}
