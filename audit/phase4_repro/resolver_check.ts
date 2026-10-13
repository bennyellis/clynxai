import { isSimilarProductName } from "../../src/main/store.ts";
import { compareIdentity } from "../../src/main/identity/resolver.ts";
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

let oldWrong=0,newWrong=0,oldMiss=0,newMiss=0;
for (const [cat,a,b,same] of pairs) {
  const o=isSimilarProductName(a,b); const n=compareIdentity(a,b);
  const newSame=n.level==="exact";
  const flag=(o&&!same?"OLD-WRONG-MERGE ":"")+(!o&&same?"OLD-MISS ":"")+(newSame&&!same?"NEW-WRONG-EXACT ":"")+(!newSame&&same?"NEW-NOT-EXACT ":"");
  if(o&&!same)oldWrong++; if(!o&&same)oldMiss++; if(newSame&&!same)newWrong++; if(!newSame&&same)newMiss++;
  console.log(cat.padEnd(11), (o?"old:same":"old:no  "), ("new:"+n.level).padEnd(14), (same?"truth:same":"truth:diff"), `${a} | ${b}`, flag? " <== "+flag+" "+n.reasons.join("; "):"");
}
console.log(`
old: wrong merges ${oldWrong}, missed aliases ${oldMiss}   new: wrong exact ${newWrong}, not-exact for same ${newMiss}`);
