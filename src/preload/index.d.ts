import type { ScoutApi } from "./index.js";

declare global {
  interface Window {
    api: ScoutApi;
  }
}
