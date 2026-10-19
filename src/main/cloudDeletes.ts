// Why deleting in Clynx did not stick while cloud sync was on (live test L8): the five guessed products the owner deleted came back two minutes later, and 109 queued deletes had been
// "waiting" since 10-14 without ever draining.
//  * "Clear all" removed the rows locally but never queued a cloud delete, so the next pull brought every one of them back from the server.
//  * A queued delete needs the product's id on the server, which only a successful FULL pull can supply. A queued id the server does not have (already gone, or never sent) could never be
//    resolved, so it stayed in the queue forever. After a full, successful pull an id the server does not list needs no delete: it is dropped from the queue (nothing is sent to the server).
//  * "Reset with cloud" queued only the products this device still held, so a copy that existed only on the server came straight back after the restart. It now also queues what the
//    server lists.
// Pure helpers; the Database, the server and the clock are not touched here.

/** Queued deletes the server no longer lists: safe to forget, nothing is deleted anywhere. Needs a complete list from the server (null = no trustworthy list this tick: keep everything). */
export function staleQueuedDeletes(queued: string[], serverLocalIds: Set<string> | null): string[] {
  // an EMPTY list is as untrustworthy as none (a reset server, the wrong account, a glitch): never forget queued deletes because of it
  if (!serverLocalIds || serverLocalIds.size === 0) return [];
  return queued.filter((id) => !serverLocalIds.has(id));
}

/** Every product id a "Reset with cloud" has to queue: what this device holds plus what the server lists, each once. */
export function idsToQueueOnReset(localIds: string[], serverLocalIds: string[]): string[] {
  return [...new Set([...localIds, ...serverLocalIds])];
}
