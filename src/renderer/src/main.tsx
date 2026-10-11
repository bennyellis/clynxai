import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.js";
import "./styles/global.css";
import { initPerformance } from "./lib/performance.js";

// Sets <html data-perf="..."> before the first paint so the right effects tier
// is in force from the start (see lib/performance.ts).
initPerformance();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
