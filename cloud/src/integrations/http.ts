// Every call this server makes to a paid provider (OpenAI, eBay) goes through here, so tests can stand in for the provider and so there is one place to see what is called.

type FetchFn = typeof fetch;
let impl: FetchFn | null = null;

export const outboundFetch: FetchFn = (input, init) => (impl ?? fetch)(input, init);

/** Tests only: replace (or with null, restore) the function used for provider calls. */
export function setOutboundFetch(fn: FetchFn | null): void {
  impl = fn;
}
