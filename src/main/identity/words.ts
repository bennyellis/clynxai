// Words that carry no product information whatever the product is: English function words and marketplace filler. This is a language list, not a
// category list (no product, brand or category appears here), and it is the only word list the identity code uses.
export const NOISE_WORDS = new Set(
  (
    "a an the and or with for of in on to at by from is it its this that these those used like works working work great good excellent condition " +
    "open box boxed original genuine authentic official oem free shipping ship fast tested clean mint barely very nice lightly gently only no not " +
    "as are was be you your our sale sold lot bundle set pack usa us fully functional functioning perfect edition gen generation"
  ).split(" ")
);
