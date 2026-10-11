// Where a reference photo came from, in words, for showing next to it. The photo's stored label (ProductImage.sourceTitle)
// is the listing's title for a photo the scanner saved, or a tag like "eBay listing: ..." / "Stock photo - Wikipedia" for one
// Clynx went and found; nothing at all for one the user added by hand.

export interface ImageSource {
  // Short name for a badge: "eBay", "Facebook", "Wikipedia", "Web (example.com)", "Added by you".
  name: string;
  // The rest of the label (a listing's title), when there is one.
  detail: string | null;
}

export function imageSource(sourceTitle: string | null | undefined): ImageSource {
  const label = (sourceTitle ?? "").trim();
  if (!label) return { name: "Added by you", detail: null };
  const ebay = label.match(/^eBay listing(?: photo)?\s*[:—-]\s*(.*)$/i);
  if (ebay) return { name: "eBay", detail: ebay[1] || null };
  const stock = label.match(/^Stock photo\s*[—-]\s*(.*)$/i);
  if (stock) {
    const host = stock[1].trim();
    return /wikipedia|wikimedia|wikidata/i.test(host) ? { name: "Wikipedia", detail: null } : { name: `Web (${host})`, detail: null };
  }
  // Anything else is the title of a listing the scanner saved the photo from.
  return { name: "Facebook", detail: label };
}
