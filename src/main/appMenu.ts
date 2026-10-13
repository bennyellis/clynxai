// The application menu. Windows and Linux have no menu bar (the window is the whole app). macOS always shows a menu bar and its standard text shortcuts (copy, paste, undo,
// select all, hide, quit) only work through it, so there it needs a minimal one.
import type { MenuItemConstructorOptions } from "electron";

export function applicationMenuTemplate(platform: string, appName: string): MenuItemConstructorOptions[] | null {
  if (platform !== "darwin") return null;
  return [
    {
      label: appName,
      submenu: [{ role: "about" }, { type: "separator" }, { role: "hide" }, { role: "hideOthers" }, { role: "unhide" }, { type: "separator" }, { role: "quit" }],
    },
    {
      label: "Edit",
      submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }],
    },
    { label: "Window", submenu: [{ role: "minimize" }, { role: "zoom" }, { role: "close" }] },
  ];
}
