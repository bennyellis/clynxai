import { useEffect, useRef, type ReactNode } from "react";

// Small shared building blocks.

const ICONS: Record<string, string> = {
  scan: "M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2M7 12h10",
  tag: "M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8zM7.5 7.5h.01",
  chart: "M3 3v18h18M7 15l4-5 3 3 5-7",
  calc: "M5 3h14a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM8 7h8M8 12h.01M12 12h.01M16 12h.01M8 16h.01M12 16h.01M16 16h.01",
  db: "M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6",
  bell: "M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0",
  star: "M12 2l3.1 6.3 6.9 1-5 4.9 1.2 6.9L12 17.8 5.8 21l1.2-6.9-5-4.9 6.9-1z",
  bolt: "M13 2 4 14h7l-1 8 9-12h-7z",
  shield: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z",
  lock: "M6 11V8a6 6 0 0 1 12 0v3M5 11h14v10H5z",
  download: "M12 3v12M7 10l5 5 5-5M4 21h16",
  check: "M5 12l5 5L20 7",
  user: "M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z",
};
export function Icon({ name }: { name: keyof typeof ICONS | string }) {
  return (
    <span className="icon" aria-hidden="true">
      <svg viewBox="0 0 24 24">
        <path d={ICONS[name] ?? ICONS.star} />
      </svg>
    </span>
  );
}

export function Notice({ kind = "info", children, role }: { kind?: "info" | "warn" | "bad" | "ok"; children: ReactNode; role?: "alert" | "status" | "alertdialog" }) {
  return (
    <div className={`notice ${kind === "info" ? "" : kind}`} role={role ?? (kind === "bad" ? "alert" : undefined)}>
      {children}
    </div>
  );
}

/** A framed screenshot. Screenshots on this site come from the real application with SAMPLE data; the caption says so. */
export function Shot({ src, alt, title = "Clynx", caption, width, height, priority }: { src: string; alt: string; title?: string; caption?: string; width: number; height: number; priority?: boolean }) {
  return (
    <figure style={{ margin: 0 }}>
      <div className="shot">
        <div className="bar" aria-hidden="true">
          <i />
          <i />
          <i />
          <span>{title}</span>
        </div>
        <img src={src} alt={alt} width={width} height={height} loading={priority ? "eager" : "lazy"} decoding="async" />
      </div>
      {caption && <figcaption className="shot-caption">{caption}</figcaption>}
    </figure>
  );
}

export function Faq({ q, children }: { q: string; children: ReactNode }) {
  return (
    <details className="faq">
      <summary>{q}</summary>
      <div>{children}</div>
    </details>
  );
}

/** Fades a block in as it scrolls into view (nothing is hidden for people who prefer reduced motion, or when IntersectionObserver is missing). */
export function Reveal({ children, className = "" }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined" || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      el.classList.add("in");
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries)
          if (e.isIntersecting) {
            e.target.classList.add("in");
            io.unobserve(e.target);
          }
      },
      { threshold: 0.12 }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <div ref={ref} className={`reveal ${className}`}>
      {children}
    </div>
  );
}

export function Field({ label, hint, children, htmlFor }: { label: string; hint?: string; children: ReactNode; htmlFor: string }) {
  return (
    <div className="field">
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}

export function Loading({ what = "Loading" }: { what?: string }) {
  return (
    <p className="muted" role="status">
      {what}...
    </p>
  );
}

/** Sets the page title and description (the server also pre-renders these for each public page so search engines and link previews see them). */
export function usePageMeta(title: string, description?: string) {
  useEffect(() => {
    document.title = title.includes("Clynx") ? title : `${title} - Clynx`;
    if (description) document.querySelector('meta[name="description"]')?.setAttribute("content", description);
  }, [title, description]);
}

export const SITE = {
  name: "Clynx",
  // Placeholders until the owner decides: nothing below is a real company, address or price.
  companyLegalName: "[COMPANY LEGAL NAME - to be decided]",
  companyAddress: "[REGISTERED ADDRESS - to be decided]",
  supportEmailFallback: "support@clynx.invalid",
};
