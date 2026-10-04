// Per explicit instruction — a Config "No particles" switch for
// StarfieldBackground.tsx and ClickParticles.tsx. Unlike lib/sound.ts's
// plain module-level flag (read at the moment each sound plays), turning
// particles on/off has to actually mount/unmount React components — that
// state lives in App.tsx, the one place both components are rendered from,
// so this is a tiny pub-sub bridge rather than a flag: Config.tsx's toggle
// calls notifyParticlesToggle for an instant live preview (the same
// "applies before Save" posture as theme/colorScheme/soundEnabled), and
// App.tsx subscribes once via onParticlesToggle to keep its own state in
// sync, the same role App.tsx already plays for every other Appearance
// setting.
type Listener = (enabled: boolean) => void;
const listeners = new Set<Listener>();

export function notifyParticlesToggle(enabled: boolean): void {
  listeners.forEach((l) => l(enabled));
}

export function onParticlesToggle(cb: Listener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
