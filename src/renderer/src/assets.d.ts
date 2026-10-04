// Lets TS resolve `import x from "./whatever.png"` (Vite handles the
// actual bundling; this just tells the type-checker what that import
// resolves to — a URL string, same as Vite's own vite/client types would
// declare for every static asset extension it supports).
declare module "*.png" {
  const src: string;
  export default src;
}
