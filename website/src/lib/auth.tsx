import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { ApiError, get, post, setCsrf } from "./api";

export interface User {
  id: string;
  email: string;
  displayName: string | null;
  emailVerified: boolean;
  role: "user" | "admin" | "owner";
  /** The permanent Owner: full access with no subscription (decided by the server). */
  owner: boolean;
  isBetaTester: boolean;
  createdAt: string;
  plan: "free" | "pro";
}

interface AuthState {
  /** undefined while the first check is running. */
  user: User | null | undefined;
  refresh: () => Promise<void>;
  signedIn: (user: User, csrfToken: string) => void;
  logout: () => Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null | undefined>(undefined);

  const refresh = useCallback(async () => {
    try {
      const r = await get<{ user: User; csrfToken: string | null }>("/web/session");
      setCsrf(r.csrfToken);
      setUser(r.user);
    } catch (e) {
      setCsrf(null);
      if (e instanceof ApiError && e.status !== 401) console.warn("session check failed", e.status);
      setUser(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = useMemo<AuthState>(
    () => ({
      user,
      refresh,
      signedIn: (u, token) => {
        setCsrf(token);
        setUser(u);
      },
      logout: async () => {
        try {
          await post("/web/logout");
        } catch {
          /* the session may already be gone */
        }
        setCsrf(null);
        setUser(null);
      },
    }),
    [user, refresh]
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAuth outside AuthProvider");
  return v;
}
