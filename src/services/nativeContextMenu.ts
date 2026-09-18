import { isTauri } from "@tauri-apps/api/core";
import { Menu, MenuItem, Submenu } from "@tauri-apps/api/menu";

export type NativeContextMenuActionItem = {
  id: string;
  text: string;
  enabled?: boolean;
  action: () => void;
  items?: never;
};

export type NativeContextMenuSubmenuItem = {
  id: string;
  text: string;
  enabled?: boolean;
  items: NativeContextMenuItem[];
  action?: never;
};

export type NativeContextMenuItem =
  | NativeContextMenuActionItem
  | NativeContextMenuSubmenuItem;

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
 *
 * Items may contain nested `items`, which Tauri renders as a native submenu.
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

  const scheduleMenuClose = () => {
    const menuToClose = menu;
    queueMicrotask(() => {
      if (!menuToClose) return;
      void menuToClose.close().catch(() => undefined);
      if (activeContextMenu === menuToClose) {
        activeContextMenu = null;
      }
    });
  };

  const buildItem = async (item: NativeContextMenuItem): Promise<MenuItem | Submenu> => {
    if ("items" in item && item.items) {
      const submenuItems = await Promise.all(item.items.map(buildItem));
      return Submenu.new({
        id: item.id,
        text: item.text,
        enabled: item.enabled ?? true,
        items: submenuItems,
      });
    }

    return MenuItem.new({
      id: item.id,
      text: item.text,
      enabled: item.enabled ?? true,
      action: () => {
        item.action();
        scheduleMenuClose();
      },
    });
  };

  menu = await Menu.new({
    items: await Promise.all(items.map(buildItem)),
  });

  activeContextMenu = menu;
  await menu.popup();
}
