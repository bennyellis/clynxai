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

// --- Keeping the hover tick and the chimes from clashing --------------------
// Per explicit instruction ("the hover sound and click sound if played at the
// same time clash"). The hover tick is a high, dry blip (E8, ~5.3 kHz); the
// click, start, stop and deal sounds are lower chimes that ring on a long
// reverb tail. Move the cursor soon after a click and the tick landed right on
// top of the ringing chime — a thin high needle over a sustained low note — and
// a tick still sounding when a click arrived overlapped the chime's attack. So
// the chimes always win:
//   * while one is ringing, new hover ticks are simply skipped, and
//   * a tick that is still sounding when a chime starts is faded out in a few
//     milliseconds instead of being left to overlap it.
// Each chime reports how long its main body rings (reverb tail excluded: it is
// far too quiet to clash with a tick).
let quietUntil = 0; // performance.now() before which hover ticks are held back
let activeHover: { ctx: BaseAudioContext; gain: GainNode; osc: OscillatorNode } | null = null;
const HOVER_CUT_SEC = 0.004;

/** Fades out a hover tick that is still sounding (a no-op if none is). */
function cutHoverTick(): void {
  const hover = activeHover;
  activeHover = null;
  if (!hover) return;
  try {
    const now = hover.ctx.currentTime;
    hover.gain.gain.cancelScheduledValues(now);
    hover.gain.gain.setValueAtTime(hover.gain.gain.value, now);
    hover.gain.gain.linearRampToValueAtTime(0, now + HOVER_CUT_SEC);
    hover.osc.stop(now + HOVER_CUT_SEC + 0.002);
  } catch {
    // The tick had already ended on its own — nothing to cut.
  }
}

/** Called by every chime as it starts: holds off hover ticks for `ringMs` and silences one in progress. */
function takeTheFloor(ringMs: number): void {
  quietUntil = Math.max(quietUntil, performance.now() + ringMs);
  cutHoverTick();
}

// Per explicit instruction — a synthetic reverb tail for the start/stop
// sounds, via a ConvolverNode fed a generated impulse response (exponentially
// decaying white noise) rather than a shipped audio file — same "no asset to
// bundle" reasoning as everything else in this module. Built once and
// reused, like the tab-switch tick's noise buffer used to be.
let reverbImpulse: AudioBuffer | null = null;
function getReverbImpulse(audioCtx: BaseAudioContext): AudioBuffer {
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
function connectWithReverb(audioCtx: BaseAudioContext, source: AudioNode, wetAmount: number): void {
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

// --- The start-scanner sound: droplet into glass, FL Studio-style --------------
// Per explicit instruction ("half liquid half glassy", and "I want the app to
// kinda sound similar to FL Studio's vibe" — then, after hearing it, "I wanna
// keep the old click sounds. I just wanted the start scanner to have that kinda
// sound"). So this is used ONLY by the start sound below; click, stop, deal and
// the hover tick keep the plain sine chimes and noise reverb above, unchanged.
//
// What makes FL's stock sounds recognisable is not a particular note, it is the
// production around it, so that is what this sound uses:
//   * FM "bell" voices (see scheduleGlassNote) — the clean, bright pluck/keys
//     tones of FL's own synths: a hard glassy strike that settles into a pure
//     ringing tone;
//   * a stereo ping-pong echo with darkened repeats, like Fruity Delay 3, so the
//     sound bounces left/right instead of sitting in the middle;
//   * a smooth, darkening plate-style reverb instead of a burst of white noise.
// All of it is generated, so there is still no audio asset to ship.

// The plate reverb's impulse response, via a ConvolverNode. Built once per
// sample rate and reused. (The chimes above use the older, plain white-noise
// impulse; this one is only for the start sound.)
//
// The white-noise one has a harsh hissy top end all the way through. This one is
// shaped like a real plate: a short smooth build-up, then a tail that gets
// steadily DARKER as it decays (the high frequencies die away first, as they do
// in air). Its overall energy is matched to the white-noise impulse so a wet
// level means the same loudness in both.
const plateImpulses = new Map<number, AudioBuffer>();
function getPlateImpulse(audioCtx: BaseAudioContext): AudioBuffer {
  const cached = plateImpulses.get(audioCtx.sampleRate);
  if (cached) return cached;
  const durationSec = 1.6;
  const decay = 2.4;
  const length = Math.floor(audioCtx.sampleRate * durationSec);
  const impulse = audioCtx.createBuffer(2, length, audioCtx.sampleRate);
  const attack = Math.floor(audioCtx.sampleRate * 0.012); // a 12ms build-up: no click at the start of the tail

  // What the old white-noise impulse's total energy was (uniform noise has variance 1/3), to match it.
  let oldEnergy = 0;
  for (let i = 0; i < length; i++) oldEnergy += Math.pow(1 - i / length, decay * 2) / 3;

  for (let channel = 0; channel < impulse.numberOfChannels; channel++) {
    const data = impulse.getChannelData(channel);
    let lowpassed = 0;
    let energy = 0;
    for (let i = 0; i < length; i++) {
      const progress = i / length;
      // One-pole lowpass whose cutoff falls from bright (0.5) to dark (0.04) along the tail.
      const coefficient = 0.5 - 0.46 * Math.pow(progress, 0.55);
      lowpassed += coefficient * (Math.random() * 2 - 1 - lowpassed);
      const build = i < attack ? i / attack : 1;
      data[i] = lowpassed * build * Math.pow(1 - progress, decay);
      energy += data[i] * data[i];
    }
    const scale = Math.sqrt(oldEnergy / Math.max(energy, 1e-9));
    for (let i = 0; i < length; i++) data[i] *= scale;
  }
  plateImpulses.set(audioCtx.sampleRate, impulse);
  return impulse;
}

// The shared "space" every note of one sound plays into: a dry path, the plate
// reverb (wetAmount), and — when echo is on — a stereo ping-pong echo: two
// taps, the first on the left, the second (quieter) on the right, each one
// darker than the last. Returns the node to connect notes to. A new bus per
// sound; it goes quiet and is collected on its own once the tails die.
function createFxBus(audioCtx: BaseAudioContext, wetAmount: number, echo: boolean, level = 1): AudioNode {
  const input = audioCtx.createGain();
  input.gain.value = level; // overall loudness of everything sent through this bus
  input.connect(audioCtx.destination); // dry

  const convolver = audioCtx.createConvolver();
  convolver.buffer = getPlateImpulse(audioCtx);
  const wet = audioCtx.createGain();
  wet.gain.value = wetAmount;
  input.connect(convolver);
  convolver.connect(wet);
  wet.connect(audioCtx.destination);

  if (echo) {
    const taps: Array<{ delaySec: number; level: number; pan: number; cutoffHz: number }> = [
      { delaySec: 0.17, level: 0.3, pan: -0.65, cutoffHz: 3200 },
      { delaySec: 0.34, level: 0.17, pan: 0.65, cutoffHz: 2200 },
    ];
    for (const tap of taps) {
      const delay = audioCtx.createDelay(1);
      delay.delayTime.value = tap.delaySec;
      const tone = audioCtx.createBiquadFilter();
      tone.type = "lowpass";
      tone.frequency.value = tap.cutoffHz;
      const level = audioCtx.createGain();
      level.gain.value = tap.level;
      const panner = audioCtx.createStereoPanner();
      panner.pan.value = tap.pan;
      input.connect(delay);
      delay.connect(tone);
      tone.connect(level);
      level.connect(panner);
      panner.connect(audioCtx.destination);
    }
  }
  return input;
}

/** Puts a note's output into the bus, optionally placed left (-1) to right (+1) in the stereo field. */
function routeToBus(audioCtx: BaseAudioContext, source: AudioNode, bus: AudioNode, pan: number): void {
  if (pan === 0) {
    source.connect(bus);
    return;
  }
  const panner = audioCtx.createStereoPanner();
  panner.pan.value = pan;
  source.connect(panner);
  panner.connect(bus);
}

// The "glass" voice. An FM bell: a sine carrier whose pitch is shaken by a
// second sine at a slightly off-whole-number ratio (3.01x by default). While
// the modulator is strong the tone is bright and metallic-glassy — the hard
// strike of a fingernail on a wine glass — and because its strength dies away
// within ~0.1s, what is left is a pure, clean ringing tone. That bright-then-
// pure shape is exactly how FL Studio's own FM keys and bells sound. The
// amplitude has a quick drop after the strike and then a slow ring, and a faint
// very-high partial gives the edge of the glass.
interface GlassOptions {
  /** FM depth at the strike: higher is brighter and more metallic. */
  index?: number;
  /** Modulator pitch as a multiple of the note: ~3 is glassy, 2 is warmer and rounder. */
  ratio?: number;
  /** Level of the quick very-high shimmer on top, relative to the note. 0 for none. */
  sparkle?: number;
  /** -1 (left) to +1 (right). */
  pan?: number;
}
function scheduleGlassNote(audioCtx: BaseAudioContext, bus: AudioNode, freq: number, t: number, peakGain: number, sec: number, options: GlassOptions = {}): void {
  const { index = 2.2, ratio = 3.01, sparkle = 0.16, pan = 0 } = options;

  const carrier = audioCtx.createOscillator();
  carrier.type = "sine";
  carrier.frequency.setValueAtTime(freq, t);

  const modulator = audioCtx.createOscillator();
  modulator.type = "sine";
  modulator.frequency.setValueAtTime(freq * ratio, t);
  const modulationDepth = audioCtx.createGain();
  const strike = index * freq * ratio; // peak frequency deviation, in Hz
  modulationDepth.gain.setValueAtTime(strike, t);
  modulationDepth.gain.exponentialRampToValueAtTime(strike * 0.01, t + Math.min(0.14, sec * 0.5)); // the strike fades; the tone stays
  modulator.connect(modulationDepth);
  modulationDepth.connect(carrier.frequency);

  const gain = audioCtx.createGain();
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.linearRampToValueAtTime(peakGain, t + 0.003); // a sharp strike
  gain.gain.exponentialRampToValueAtTime(peakGain * 0.45, t + 0.05); // quick settle after the strike...
  gain.gain.exponentialRampToValueAtTime(0.0008, t + sec); // ...then a slow ring
  carrier.connect(gain);

  const stop = t + sec + 0.05;
  carrier.start(t);
  modulator.start(t);
  carrier.stop(stop);
  modulator.stop(stop);

  if (sparkle > 0) {
    const shimmer = audioCtx.createOscillator();
    shimmer.type = "sine";
    shimmer.frequency.setValueAtTime(freq * 4, t); // two octaves up
    const shimmerGain = audioCtx.createGain();
    shimmerGain.gain.setValueAtTime(peakGain * sparkle, t);
    shimmerGain.gain.exponentialRampToValueAtTime(0.0008, t + Math.min(0.1, sec * 0.5));
    shimmer.connect(shimmerGain);
    shimmerGain.connect(gain);
    shimmer.start(t);
    shimmer.stop(stop);
  }

  routeToBus(audioCtx, gain, bus, pan);
}

// The "liquid" voice. A water droplet or bubble has a very recognisable sound,
// and it is NOT a bell:
//   * the pitch SWOOPS UP, fast, right at the start (a bubble's resonance rises
//     as it forms) — a bell holds one pitch;
//   * the note wobbles for a moment — a quick vibrato that dies away — which is
//     the "gloop";
//   * it is soft at the front and fades out smoothly, with no metallic ring.
const BLOOP_RISE_SEC = 0.065; // how long the upward swoop takes
const BLOOP_START_RATIO = 0.5; // the swoop starts at this fraction of the final pitch (a full octave of rise)
const BLOOP_WOBBLE_HZ = 26; // speed of the wobble
const BLOOP_WOBBLE_DEPTH = 0.05; // wobble size, as a fraction of the pitch (dies away)

/** One droplet: a sine that swoops up into freq, wobbles, and fades. */
function scheduleBloop(audioCtx: BaseAudioContext, bus: AudioNode, t: number, freq: number, peakGain: number, sec: number, pan = 0): void {
  const osc = audioCtx.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(freq * BLOOP_START_RATIO, t);
  osc.frequency.exponentialRampToValueAtTime(freq, t + BLOOP_RISE_SEC);
  osc.frequency.exponentialRampToValueAtTime(freq * 1.05, t + sec); // keeps creeping up a hair as it fades

  // The wobble: a fast low-depth vibrato that fades out over most of the note.
  const lfo = audioCtx.createOscillator();
  lfo.frequency.setValueAtTime(BLOOP_WOBBLE_HZ, t);
  const lfoDepth = audioCtx.createGain();
  lfoDepth.gain.setValueAtTime(freq * BLOOP_WOBBLE_DEPTH, t);
  lfoDepth.gain.exponentialRampToValueAtTime(0.01, t + sec * 0.7);
  lfo.connect(lfoDepth);
  lfoDepth.connect(osc.frequency);

  const gain = audioCtx.createGain();
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.linearRampToValueAtTime(peakGain, t + 0.008); // soft, quick onset
  gain.gain.exponentialRampToValueAtTime(0.0008, t + sec);
  osc.connect(gain);
  routeToBus(audioCtx, gain, bus, pan);

  osc.start(t);
  lfo.start(t);
  osc.stop(t + sec + 0.05);
  lfo.stop(t + sec + 0.05);
}

// Per explicit instruction — "a chime that goes from pitches C -> F": two
// distinct notes (C5 then F5, a rising fourth), not one oscillator gliding
// between two pitches — a little rising figure rather than a "boop".
//
// Then per explicit instruction ("make it more 'liquidy'", and next "half
// liquid half glassy"): the sound turns from water into glass as it goes.
//   * C5 is a droplet — swooping up into its pitch with just a tiny glass tick
//     on its front edge;
//   * F5 is the turn — a second swoop that lands into a clear FM bell;
//   * the tail is glass — two bright little bell notes (C6, then G6) that the
//     ping-pong echo throws left and right.
// Pitches, order and overall length are the same as before (about 0.5s); the
// reverb is kept light so the water stays clean.
/** The start-scanner sound. Exported so it can be rendered offline and measured. */
export function scheduleStartSound(audioCtx: BaseAudioContext, t: number): void {
  // level 1.45 (+3.2 dB): measured offline, the notes alone came out that much quieter than the
  // droplet-only version this replaces, and the start sound should be as present as it was.
  const bus = createFxBus(audioCtx, 0.12, true, 1.45);
  // Water: the first droplet.
  scheduleBloop(audioCtx, bus, t, 523.25 /* C5 */, 0.17, 0.27, -0.12);
  scheduleGlassNote(audioCtx, bus, 523.25, t, 0.04, 0.2, { index: 1.4, sparkle: 0.08, pan: -0.12 });
  // The turn: a swoop that arrives into the bell just as it reaches the pitch.
  scheduleBloop(audioCtx, bus, t + 0.12, 698.46 /* F5 */, 0.08, 0.2, 0.12);
  scheduleGlassNote(audioCtx, bus, 698.46, t + 0.16, 0.17, 0.4, { index: 2.4, pan: 0.12 });
  // Glass: small bright bells at the end, spread left and right.
  scheduleGlassNote(audioCtx, bus, 1046.5 /* C6 */, t + 0.32, 0.075, 0.26, { index: 1.8, pan: -0.45 });
  scheduleGlassNote(audioCtx, bus, 1567.98 /* G6 */, t + 0.41, 0.05, 0.24, { index: 1.6, pan: 0.45 });
}

export function playStartSound(): void {
  if (!soundEnabled) return;
  try {
    takeTheFloor(600); // droplet, bell and two glass notes, ~0.55s
    const audioCtx = getContext();
    scheduleStartSound(audioCtx, audioCtx.currentTime);
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
    takeTheFloor(600); // one long note, ~0.55s
    const audioCtx = getContext();
    playChimeNote(audioCtx, 196.0 /* G3 */, audioCtx.currentTime, 0.26, 0.55, 0.4);
  } catch {
    // Best-effort, same as above.
  }
}

// Per explicit instruction — "a C major glitter sound" for a confirmed
// deal, then "an octave higher", then later "change the found item chime from
// a c major to an f major chord": an ascending F-major triad-plus-octave
// (F6, A6, C7, F7; it used to be C6, E6, G6, C7 — the same shape moved up a
// fourth, so it sits a little higher), each note fired close on the heels of the last (60ms
// apart) so they overlap and ring together into a shimmering cascade
// rather than a slow, deliberate arpeggio — same playChimeNote/reverb
// machinery as start/stop, just more notes stacked in quick succession for
// the "glitter" effect. Replaces the old single pitch-drop "pop" this used
// to be (moved here from App.tsx, which built its own separate
// AudioContext for it, for the same reverb treatment everything else in
// this module gets).
const DEAL_GLITTER_NOTES = [1396.91 /* F6 */, 1760.0 /* A6 */, 2093.0 /* C7 */, 2793.83 /* F7 */];
export function playDealSound(): void {
  if (!soundEnabled) return;
  try {
    takeTheFloor(650); // four overlapping notes, ~0.6s
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
// quieter and shorter, since this fires on ordinary clicks, not a
// meaningful state change worth as much presence as starting/stopping the
// scanner.
//
// Renamed from playTabSwitchSound per further explicit instruction — "make
// that D pitched sound play after every clickable thing is clicked," not
// just Sidebar/Database's own tab switches. See App.tsx's single global
// click listener, which now calls this for every clickable element in the
// app — the two old explicit call sites (Database.tsx/Sidebar.tsx's own tab
// buttons) were removed rather than left in place, since a tab button IS a
// clickable element the global listener already covers; keeping both would
// have double-fired the sound on every tab click.
export function playClickSound(): void {
  if (!soundEnabled) return;
  try {
    takeTheFloor(300); // the D4 chime's body, ~0.22s
    const audioCtx = getContext();
    playChimeNote(audioCtx, 293.66 /* D4 */, audioCtx.currentTime, 0.16, 0.22, 0.3);
  } catch {
    // Best-effort, same as the bloops above.
  }
}

// Per explicit instruction — "a tiny little sound that plays when hovering
// over something": a single very short, very quiet high tick (E8, ~5.3 kHz —
// doubled twice from the first version's E6, which was "too annoying"), far
// higher and quieter than playClickSound's D4 so the two never blur together
// when a hover is immediately followed by a click. Follows the same Config →
// Sound on/off switch as every other sound (see setSoundEnabled).
//
// Reworked per explicit instruction ("a little too harsh... an instant attack
// but quickly fade out... fade out at 65ms"). Two things made the old tick
// harsh, both fixed by giving it its own envelope instead of playChimeNote's:
//   * it ramped up over 15ms and then ran ~50ms with the oscillator left
//     running to 100ms, so it smeared instead of ticking;
//   * it was fed through the shared reverb — a 1.6 second burst of decaying
//     white noise — which at this pitch added a quiet "shhh" hiss trailing
//     every hover (and a ConvolverNode per hover). The tick is now dry.
// Now: full level on the very first sample (the sine itself starts at zero
// phase, so an instant gain doesn't click), then an exponential fade that
// reaches silence at exactly HOVER_FADE_SEC.
const HOVER_FREQ_HZ = 5274.04; // E8
const HOVER_PEAK_GAIN = 0.016; // unchanged: the same loudness at the peak
const HOVER_FADE_SEC = 0.065; // the tick is over (silent) at 65ms

/** Schedules the hover tick on any audio context (exported so the envelope can be rendered offline and checked). */
export function scheduleHoverTick(audioCtx: BaseAudioContext, startTime: number): { gain: GainNode; osc: OscillatorNode } {
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(HOVER_FREQ_HZ, startTime);
  gain.gain.setValueAtTime(HOVER_PEAK_GAIN, startTime); // instant attack
  // Quick exponential fade down 60 dB (to inaudible) by HOVER_FADE_SEC, then true zero.
  gain.gain.exponentialRampToValueAtTime(HOVER_PEAK_GAIN * 0.001, startTime + HOVER_FADE_SEC);
  gain.gain.setValueAtTime(0, startTime + HOVER_FADE_SEC);
  osc.connect(gain);
  gain.connect(audioCtx.destination); // dry: no reverb tail
  osc.start(startTime);
  osc.stop(startTime + HOVER_FADE_SEC + 0.005);
  return { gain, osc };
}

// The context is resumed defensively: a hover isn't a user gesture, so if the
// browser left the shared AudioContext suspended, a hover tick would otherwise
// silently never play until the first click.
export function playHoverSound(): void {
  if (!soundEnabled) return;
  // A chime is ringing: it has the floor — skip this tick rather than lay it over the chime.
  if (performance.now() < quietUntil) return;
  try {
    const audioCtx = getContext();
    if (audioCtx.state === "suspended") void audioCtx.resume();
    const { gain, osc } = scheduleHoverTick(audioCtx, audioCtx.currentTime);
    activeHover = { ctx: audioCtx, gain, osc };
    osc.onended = () => {
      if (activeHover && activeHover.osc === osc) activeHover = null;
    };
  } catch {
    // Best-effort, same as the sounds above.
  }
}
