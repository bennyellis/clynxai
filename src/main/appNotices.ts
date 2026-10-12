// Persistent "needs attention" notices: problems the user has to know about and can act on (a damaged settings file, a damaged
// database, a Facebook login that expired, a scan that keeps failing). Unlike log lines they stay visible until the problem is
// fixed or the user dismisses them. One notice per id: setting an id again replaces it, clearing it removes it.
export type NoticeSeverity = "error" | "warning" | "info";

// What the notice's button does (the renderer maps this to a call); "dismiss" only hides it.
export type NoticeAction = "open-facebook-login" | "retry-scanner" | "open-activity" | "dismiss";

export interface AppNotice {
  id: string;
  severity: NoticeSeverity;
  title: string;
  // Plain words: what happened and what to do about it.
  message: string;
  action: NoticeAction;
  actionLabel: string;
  // Which Facebook account (engine) this is about, when it is about one.
  accountId?: string;
  createdAt: number;
}

export class NoticeBoard {
  private notices = new Map<string, AppNotice>();
  constructor(private onChange: (notices: AppNotice[]) => void = () => {}) {}

  set(notice: Omit<AppNotice, "createdAt"> & { createdAt?: number }): void {
    const previous = this.notices.get(notice.id);
    this.notices.set(notice.id, { ...notice, createdAt: previous?.createdAt ?? notice.createdAt ?? Date.now() });
    this.onChange(this.list());
  }

  clear(id: string): void {
    if (this.notices.delete(id)) this.onChange(this.list());
  }

  /** Clears every notice whose id starts with `prefix` (for example all of one account's). */
  clearPrefix(prefix: string): void {
    let changed = false;
    for (const id of [...this.notices.keys()]) {
      if (id.startsWith(prefix)) {
        this.notices.delete(id);
        changed = true;
      }
    }
    if (changed) this.onChange(this.list());
  }

  has(id: string): boolean {
    return this.notices.has(id);
  }

  clearAll(): void {
    if (this.notices.size === 0) return;
    this.notices.clear();
    this.onChange(this.list());
  }

  /** Most severe first, then oldest first. */
  list(): AppNotice[] {
    const rank: Record<NoticeSeverity, number> = { error: 0, warning: 1, info: 2 };
    return [...this.notices.values()].sort((a, b) => rank[a.severity] - rank[b.severity] || a.createdAt - b.createdAt);
  }
}
