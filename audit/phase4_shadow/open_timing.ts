// Read/write timing of opening a COPY of a database with the identity foundation off and on. Works on the file given (use a scratch copy).
//   node audit/phase4_shadow/build.cjs open_timing && node audit/phase4_shadow/open_timing.cjs <scratch-copy-of-scout.db>
import { Store } from "../../src/main/store.ts";
const f = process.argv[2];
if (!f || /fb-marketplace-scout[\/]+data[\/]/i.test(f)) {
  console.error("Refusing to run: give it a scratch COPY of scout.db.");
  process.exit(2);
}
const time = (label: string, fn: () => void) => {
  const t = performance.now();
  fn();
  console.log(label.padEnd(44), `${Math.round(performance.now() - t)} ms`);
};
for (let i = 1; i <= 5; i++) {
  time(`open, foundation OFF   (#${i})`, () => new Store(f).close());
  // remove the identity tables first so the "ON" open really has to create them
  const d = new Store(f, { identityFoundation: true });
  d.identity!.drop();
  d.close();
  time(`open, foundation ON, creates the tables (#${i})`, () => new Store(f, { identityFoundation: true }).close());
  time(`open, foundation ON, already there      (#${i})`, () => new Store(f, { identityFoundation: true }).close());
}
