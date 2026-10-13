// READ-ONLY audit harness: imports the app's real matching functions and prints what they decide. Changes nothing.
import { isSimilarProductName } from "../../src/main/store.ts";
import { compMatchesSpecs, titleLooksLikeProduct, modelLettersConflict } from "../../src/main/compFilter.ts";
import { listingHasExtraDetail } from "../../src/main/productIdentity.ts";

type Pair = [string, string, string, boolean]; // [category, nameA (new), nameB (existing), truth: same product?]
const pairs: Pair[] = [
  // --- target case + controllers across generations/editions
  ["controller", "Microsoft Xbox 360 Wireless Controller 1403", "Xbox Wireless Controller", false],
  ["controller", "Xbox One Wireless Controller", "Xbox Wireless Controller", false],
  ["controller", "Xbox Elite Wireless Controller Series 2", "Xbox Wireless Controller", false],
  ["controller", "Xbox Series X Wireless Controller", "Xbox Wireless Controller", true],
  ["controller", "PlayStation 3 DualShock 3 Controller", "PlayStation DualShock Controller", false],
  ["controller", "PS5 DualSense Edge Controller", "PS5 DualSense Controller", false],
  ["controller", "Nintendo Switch Pro Controller", "Nintendo Switch Controller", false],
  // --- console generations
  ["console", "Xbox 360 Console", "Xbox Console", false],
  ["console", "Xbox One X", "Xbox One", false],
  ["console", "Xbox Series S", "Xbox Series X", false],
  ["console", "PlayStation 4 Console", "PlayStation 3 Console", false],
  ["console", "Nintendo Switch 2", "Nintendo Switch", false],
  ["console", "Nintendo 3DS XL", "Nintendo 3DS", false],
  ["console", "PS5 Slim", "PlayStation 5 Slim", true],
  // --- phones
  ["phone", "iPhone 12 Pro", "iPhone 12", false],
  ["phone", "iPhone 13 Mini", "iPhone 13", false],
  ["phone", "Apple iPhone 12", "iPhone 12", true],
  ["phone", "Apple iPhone 12 128GB", "Apple iPhone 12 64GB", false],
  ["phone", "Samsung Galaxy S21 Ultra", "Samsung Galaxy S21", false],
  ["phone", "Samsung Galaxy S21 FE", "Samsung Galaxy S21", false],
  ["phone", "Samsung Galaxy S21+", "Samsung Galaxy S21", false],
  ["phone", "Google Pixel 7a", "Google Pixel 7", false],
  ["phone", "iPhone SE 2nd Generation", "iPhone SE 3rd Generation", false],
  // --- PC components
  ["pc", "NVIDIA GeForce RTX 3060 Ti", "NVIDIA GeForce RTX 3060", false],
  ["pc", "AMD Radeon RX 6700 XT", "AMD Radeon RX 6700", false],
  ["pc", "Intel Core i7 12700K", "Intel Core i7 12700", false],
  ["pc", "Intel Core i7 12700KF", "Intel Core i7 12700K", false],
  ["pc", "Samsung 980 Pro 1TB SSD", "Samsung 980 Pro 500GB SSD", false],
  ["pc", "Corsair Vengeance 32GB DDR5 RAM", "Corsair Vengeance 16GB DDR5 RAM", false],
  // --- vehicles
  ["vehicle", "2018 Honda Civic Si", "2018 Honda Civic", false],
  ["vehicle", "2018 Honda Civic EX-L", "2018 Honda Civic LX", false],
  ["vehicle", "Ford F-150 Raptor", "Ford F-150", false],
  // --- tool battery platforms
  ["tools", "Milwaukee M18 Battery", "Milwaukee M12 Battery", false],
  ["tools", "Milwaukee M18 XC 5.0 Battery", "Milwaukee M18 Battery", false],
  ["tools", "DeWalt 20V Max 5Ah Battery", "DeWalt 20V Max 2Ah Battery", false],
  ["tools", "DeWalt DCD791 Drill", "DeWalt DCD771 Drill", false],
  // --- appliances / furniture / collectibles / clothing
  ["appliance", "LG 5.2 cu ft Top Load Washer", "LG 4.5 cu ft Top Load Washer", false],
  ["appliance", "Samsung 65 inch QLED TV", "Samsung 55 inch QLED TV", false],
  ["furniture", "IKEA Kallax Shelf Unit 4x4", "IKEA Kallax Shelf Unit 2x2", false],
  ["furniture", "IKEA Kallax Shelf Unit 2x4", "IKEA Kallax Shelf Unit", false],
  ["collectible", "Pokemon Charizard Card 1st Edition Shadowless", "Pokemon Charizard Card Base Set", false],
  ["collectible", "Funko Pop Batman Chase Variant", "Funko Pop Batman", false],
  ["clothing", "Nike Air Force 1 Low White Size 10", "Nike Air Force 1 Low White Size 8", false],
  ["clothing", "Patagonia Better Sweater Mens Large", "Patagonia Better Sweater Mens Small", false],
  // --- identical products with different names
  ["alias", "Microsoft Xbox Series X Console", "Xbox Series X", true],
  ["alias", "Sony PlayStation 5 Digital Edition", "PS5 Digital Edition", true],
  ["alias", "Apple AirPods Pro 2nd Gen", "AirPods Pro 2", true],
];
console.log("category".padEnd(11), "isSimilarProductName".padEnd(21), "truth".padEnd(6), "A  |  B");
let wrongMerges = 0, missedMerges = 0;
for (const [cat, a, b, same] of pairs) {
  const sim = isSimilarProductName(a, b);
  const flag = sim && !same ? "WRONG MERGE" : !sim && same ? "missed alias" : "";
  if (flag === "WRONG MERGE") wrongMerges++;
  if (flag === "missed alias") missedMerges++;
  console.log(cat.padEnd(11), String(sim).padEnd(21), (same ? "same" : "diff").padEnd(6), `${a}  |  ${b}`, flag ? `  <== ${flag}` : "");
}
console.log(`\nwrong merges (different products treated as the same Database entry): ${wrongMerges} of ${pairs.filter((p) => !p[3]).length} different pairs; missed aliases: ${missedMerges} of ${pairs.filter((p) => p[3]).length} same-product pairs`);

console.log("\n=== extra-detail pre-check (decides whether the identity AI is even asked) ===");
const extra: Array<[string, string]> = [
  ["Official Microsoft Xbox 360 & Windows Black Wireless Controller 1403 OEM gamepad", "Xbox Wireless Controller"],
  ["Xbox One controller", "Xbox Wireless Controller"],
  ["Microsoft Xbox Wireless Controller", "Xbox Wireless Controller"],
  ["Used PS4 controller works great", "PS4 DualShock 4 Controller"],
  ["Milwaukee M18 5.0 battery xc", "Milwaukee M18 Battery"],
  ["Samsung galaxy s21 ultra 128", "Samsung Galaxy S21"],
];
for (const [t, e] of extra) console.log(String(listingHasExtraDetail(t, e)).padEnd(6), `"${t}"  vs entry "${e}"`);

console.log("\n=== deterministic comp gate (compMatchesSpecs) with a GENERIC reference name ===");
const comps: Array<[string, string[]]> = [
  ["Xbox Wireless Controller", ["Microsoft Xbox Series X|S Wireless Controller Carbon Black", "Microsoft Xbox 360 Wireless Controller 1403 Black", "Xbox One Wireless Controller 1708", "Xbox Elite Series 2 Wireless Controller", "Xbox Wireless Controller Mars Red Special Edition"]],
  ["Samsung Galaxy S21", ["Samsung Galaxy S21 5G 128GB", "Samsung Galaxy S21 Ultra 5G 256GB", "Samsung Galaxy S21 FE 5G", "Samsung Galaxy S20"]],
  ["NVIDIA GeForce RTX 3060", ["RTX 3060 12GB Gigabyte", "RTX 3060 Ti 8GB", "RTX 3070"]],
  ["Milwaukee M18 Battery", ["Milwaukee M18 XC5.0 Battery", "Milwaukee M18 CP2.0 Battery", "Milwaukee M12 Battery", "Milwaukee M18 HIGH OUTPUT 8.0 Battery"]],
  ["2018 Honda Civic", ["2018 Honda Civic LX Sedan", "2018 Honda Civic Type R", "2018 Honda Civic Si Coupe"]],
];
for (const [ref, titles] of comps) {
  console.log(`reference "${ref}":`);
  for (const t of titles) console.log("   ", compMatchesSpecs(ref, t) ? "PASSES the hard gate" : "rejected           ", "-", t);
}
