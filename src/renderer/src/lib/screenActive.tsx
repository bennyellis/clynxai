import React, { createContext, useContext, useRef } from "react";

// Every screen stays mounted (hidden with display:none) so its state survives switching tabs. That used to mean a hidden screen was
// re-rendered on every scan event as well, although nobody could see it. Two small tools fix that without touching any data flow:
//
//  * <ScreenActive active> tells everything inside whether its screen is the one being shown (useScreenActive), so timers and polls can stop
//    while hidden.
//  * <FreezeWhenHidden active> hands React the SAME element it rendered last time while the screen is hidden, so React skips the whole subtree.
//    The moment the screen is shown again it renders with the newest props, so what appears is current immediately.
//
// Nothing is dropped: App.tsx keeps receiving and storing every log line, status, listing and event; only the drawing of hidden screens waits.
const ScreenActiveContext = createContext(true);

export function useScreenActive(): boolean {
  return useContext(ScreenActiveContext);
}

export function ScreenActive({ active, children }: { active: boolean; children: React.ReactNode }) {
  return <ScreenActiveContext.Provider value={active}>{children}</ScreenActiveContext.Provider>;
}

export function FreezeWhenHidden({ active, children }: { active: boolean; children: React.ReactElement }) {
  const last = useRef<React.ReactElement>(children);
  if (active) last.current = children;
  return last.current;
}
