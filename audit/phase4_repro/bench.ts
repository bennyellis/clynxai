// Per-listing cost of the new identity checks (pure string work).
import { codesMissingFrom, relateCodes } from "../../src/main/identity/codes.ts";
import { splitByPriceSeparators } from "../../src/main/identity/populations.ts";
const title = "Official Microsoft Xbox 360 & Windows Black Wireless Controller 1403 OEM gamepad works great no scratches smoke free home";
const names = Array.from({ length: 10_000 }, (_, i) => `Brand ${i} Model Line ${i % 97} Wireless Controller ${i % 13}`);
let t = process.hrtime.bigint();
let n = 0;
for (const name of names) n += codesMissingFrom(name, title).length;
const ms = Number(process.hrtime.bigint() - t) / 1e6;
console.log(`codesMissingFrom: ${names.length} products x 1 listing = ${ms.toFixed(1)} ms total (${(ms / names.length * 1000).toFixed(1)} us each)`);
const comps = Array.from({ length: 60 }, (_, i) => ({ title: `Microsoft Xbox ${["Series X|S", "360", "One"][i % 3]} Wireless Controller ${["", "1403", "1708"][i % 3]} ${i}`, priceUsd: [48, 18, 28][i % 3] + (i % 5) }));
t = process.hrtime.bigint();
for (let i = 0; i < 200; i++) splitByPriceSeparators(comps, "Xbox Wireless Controller");
console.log(`splitByPriceSeparators: 60 comps = ${(Number(process.hrtime.bigint() - t) / 1e6 / 200).toFixed(2)} ms each`);
