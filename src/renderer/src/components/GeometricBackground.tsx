import React, { useEffect, useRef } from "react";

interface Node {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

// A quiet particle-network backdrop, mounted once behind the whole app
// (see App.tsx) — per explicit instruction ("a cursor-reactive geometric
// background"). Plain <canvas> + requestAnimationFrame rather than a
// library: this is simple enough (drifting dots, distance-based lines, a
// gentle push away from the cursor) that pulling in a whole physics/
// particle package for it isn't worth the dependency. Deliberately subtle
// (thin low-opacity lines, slow drift) so it reads as ambient texture in
// the gaps between panels, not something competing with the actual UI for
// attention. pointerEvents: none the whole time — it only ever reacts to
// mouse position, never intercepts a click meant for something underneath.
export function GeometricBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    let width = 0;
    let height = 0;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let nodes: Node[] = [];
    let rafId = 0;
    const mouse = { x: -9999, y: -9999 };

    function resize() {
      width = window.innerWidth;
      height = window.innerHeight;
      canvas!.width = width * dpr;
      canvas!.height = height * dpr;
      canvas!.style.width = `${width}px`;
      canvas!.style.height = `${height}px`;
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
      // Density scales with viewport area, capped so a large monitor
      // doesn't turn this into hundreds of nodes drawing O(n^2) links.
      const count = Math.min(65, Math.max(24, Math.floor((width * height) / 22000)));
      nodes = Array.from({ length: count }, () => ({
        x: Math.random() * width,
        y: Math.random() * height,
        vx: (Math.random() - 0.5) * 0.18,
        vy: (Math.random() - 0.5) * 0.18,
      }));
    }
    resize();

    function onMouseMove(e: MouseEvent) {
      mouse.x = e.clientX;
      mouse.y = e.clientY;
    }
    function onMouseLeave() {
      mouse.x = -9999;
      mouse.y = -9999;
    }

    window.addEventListener("resize", resize);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseout", onMouseLeave);

    const LINK_DIST = 130;
    const CURSOR_RADIUS = 170;

    function tick() {
      ctx!.clearRect(0, 0, width, height);

      for (const n of nodes) {
        n.x += n.vx;
        n.y += n.vy;
        if (n.x < 0 || n.x > width) n.vx *= -1;
        if (n.y < 0 || n.y > height) n.vy *= -1;

        // A gentle push away from the cursor — this is the "reactive" part;
        // nodes drift back on their own via their base velocity once the
        // cursor moves away, no separate "return to place" logic needed.
        const dx = n.x - mouse.x;
        const dy = n.y - mouse.y;
        const dist = Math.hypot(dx, dy);
        if (dist < CURSOR_RADIUS && dist > 0.01) {
          const force = (1 - dist / CURSOR_RADIUS) * 0.7;
          n.x += (dx / dist) * force;
          n.y += (dy / dist) * force;
        }
      }

      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i];
          const b = nodes[j];
          const dist = Math.hypot(a.x - b.x, a.y - b.y);
          if (dist < LINK_DIST) {
            ctx!.strokeStyle = `rgba(124, 108, 246, ${0.14 * (1 - dist / LINK_DIST)})`;
            ctx!.lineWidth = 1;
            ctx!.beginPath();
            ctx!.moveTo(a.x, a.y);
            ctx!.lineTo(b.x, b.y);
            ctx!.stroke();
          }
        }

        const distToCursor = Math.hypot(nodes[i].x - mouse.x, nodes[i].y - mouse.y);
        if (distToCursor < CURSOR_RADIUS) {
          ctx!.strokeStyle = `rgba(168, 85, 247, ${0.3 * (1 - distToCursor / CURSOR_RADIUS)})`;
          ctx!.lineWidth = 1;
          ctx!.beginPath();
          ctx!.moveTo(nodes[i].x, nodes[i].y);
          ctx!.lineTo(mouse.x, mouse.y);
          ctx!.stroke();
        }
      }

      for (const n of nodes) {
        ctx!.fillStyle = "rgba(168, 148, 255, 0.4)";
        ctx!.beginPath();
        ctx!.arc(n.x, n.y, 1.6, 0, Math.PI * 2);
        ctx!.fill();
      }

      rafId = requestAnimationFrame(tick);
    }
    tick();

    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener("resize", resize);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseout", onMouseLeave);
    };
  }, []);

  return <canvas ref={canvasRef} style={{ position: "fixed", inset: 0, zIndex: 0, pointerEvents: "none" }} />;
}
