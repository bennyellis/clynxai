import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

// Chat-style scrolling for a list that grows downward (oldest first, newest last): follow new content only while the reader is parked at
// the bottom, and leave the view alone the moment they scroll up to read something older. Shared by the Discovery chat and the Activity
// feed so both behave the same way.

/** How far from the bottom (px) still counts as "at the bottom". */
export const STICK_THRESHOLD_PX = 80;

/** Pure: is a scroll container within `threshold` px of its bottom edge? */
export function isNearBottom(m: { scrollHeight: number; scrollTop: number; clientHeight: number }, threshold = STICK_THRESHOLD_PX): boolean {
  return m.scrollHeight - m.scrollTop - m.clientHeight < threshold;
}

/** Where a list was left: lets a remounted list (another tab was shown meanwhile) open where the reader was. */
export interface StickPosition {
  top: number;
  stuck: boolean;
}

export interface StickToBottom<T extends HTMLElement> {
  /** The scrolling element once mounted (for scrolling to a specific item). */
  element: T | null;
  /** Callback ref for the scrolling element (overflow:auto). */
  scrollRef: (el: T | null) => void;
  /** Callback ref for the element INSIDE it that holds the content: its growth (a streamed reply, an image loading) is what is followed. */
  contentRef: (el: HTMLElement | null) => void;
  /** Wire to the scroller's onScroll. */
  onScroll: () => void;
  /** False once the reader has scrolled away from the bottom: drives a "Jump to latest" button. */
  atBottom: boolean;
  /** Re-stick and jump to the newest content (after the user sends, or on a view change). */
  scrollToBottom: () => void;
  /** Stop following, e.g. before scrolling to a specific older item on purpose. */
  release: () => void;
  /** The current position, to remember across an unmount. */
  getPosition: () => StickPosition;
}

export function useStickToBottom<T extends HTMLElement = HTMLDivElement>(options: { threshold?: number; initial?: StickPosition } = {}): StickToBottom<T> {
  const threshold = options.threshold ?? STICK_THRESHOLD_PX;
  const initial = useRef(options.initial);
  const [scrollEl, setScrollEl] = useState<T | null>(null);
  const [contentEl, setContentEl] = useState<HTMLElement | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  // A ref, not state: it is read inside observer callbacks and must not wait for a render.
  const stuck = useRef(true);
  const lastTop = useRef(0);

  const toBottom = useCallback(() => {
    if (!scrollEl) return;
    // Instant, never smooth: a smooth scroll fires scroll events from the middle of the animation, which would read as "scrolled away".
    scrollEl.scrollTop = scrollEl.scrollHeight;
    lastTop.current = scrollEl.scrollTop;
  }, [scrollEl]);

  const onScroll = useCallback(() => {
    if (!scrollEl) return;
    // A hidden panel (display:none) reports a zero-height box and a reset offset: that is not the reader scrolling.
    if (scrollEl.clientHeight === 0) return;
    const near = isNearBottom(scrollEl, threshold);
    stuck.current = near;
    lastTop.current = scrollEl.scrollTop;
    setAtBottom((prev) => (prev === near ? prev : near));
  }, [scrollEl, threshold]);

  // The first paint of a freshly mounted list starts at the newest message, or where the reader had left it.
  useLayoutEffect(() => {
    if (!scrollEl) return;
    const from = initial.current;
    initial.current = undefined;
    if (from && !from.stuck) {
      stuck.current = false;
      scrollEl.scrollTop = from.top;
      lastTop.current = scrollEl.scrollTop;
      setAtBottom(isNearBottom(scrollEl, threshold));
    } else {
      toBottom();
    }
  }, [scrollEl, toBottom, threshold]);

  useEffect(() => {
    if (!scrollEl || typeof ResizeObserver === "undefined") return;
    let hadHeight = scrollEl.clientHeight > 0;
    const follow = () => {
      const visible = scrollEl.clientHeight > 0;
      if (visible && !hadHeight && !stuck.current) {
        // Shown again after being hidden: put the reader back where they were.
        scrollEl.scrollTop = lastTop.current;
      } else if (visible && stuck.current) {
        toBottom();
      }
      hadHeight = visible;
    };
    const ro = new ResizeObserver(follow);
    ro.observe(scrollEl);
    if (contentEl) ro.observe(contentEl);
    return () => ro.disconnect();
  }, [scrollEl, contentEl, toBottom]);

  const scrollToBottom = useCallback(() => {
    stuck.current = true;
    setAtBottom(true);
    toBottom();
  }, [toBottom]);

  const release = useCallback(() => {
    stuck.current = false;
  }, []);

  const getPosition = useCallback((): StickPosition => ({ top: lastTop.current, stuck: stuck.current }), []);

  return { element: scrollEl, scrollRef: setScrollEl, contentRef: setContentEl, onScroll, atBottom, scrollToBottom, release, getPosition };
}
