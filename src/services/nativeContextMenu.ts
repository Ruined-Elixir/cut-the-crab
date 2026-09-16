import { isTauri } from "@tauri-apps/api/core";
import { Menu } from "@tauri-apps/api/menu";

export type NativeContextMenuItem = {
  id: string;
  text: string;
  enabled?: boolean;
  action: () => void;
};

let activeContextMenu: Menu | null = null;

/**
 * True when CTC is running inside the desktop Tauri shell.
 * Browser-only previews should leave the browser's own context menu alone.
 */
export function canShowNativeContextMenu(): boolean {
  return isTauri();
}

/**
 * Shows a platform-native context menu. Tauri delegates the actual popup to
 * the host OS/toolkit, so macOS, Windows and Linux each get their native menu
 * appearance and interaction behavior.
 */
export async function showNativeContextMenu(
  items: NativeContextMenuItem[],
): Promise<void> {
  if (!isTauri()) return;

  if (activeContextMenu) {
    try {
      await activeContextMenu.close();
    } catch {
      // The previous native popup may already have released its resource.
    }
    activeContextMenu = null;
  }

  let menu: Menu | null = null;

  menu = await Menu.new({
    items: items.map((item) => ({
      id: item.id,
      text: item.text,
      enabled: item.enabled ?? true,
      action: () => {
        item.action();

        const menuToClose = menu;
        queueMicrotask(() => {
          if (!menuToClose) return;
          void menuToClose.close().catch(() => undefined);
          if (activeContextMenu === menuToClose) {
            activeContextMenu = null;
          }
        });
      },
    })),
  });

  activeContextMenu = menu;
  await menu.popup();
}
