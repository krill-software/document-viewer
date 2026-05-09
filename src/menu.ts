export type MenuItem =
  | { label: string; shortcut?: string; action: () => void }
  | { sep: true };

export interface MenuDef {
  label: string;
  items: MenuItem[];
}

interface OpenState {
  menu: MenuDef;
  trigger: HTMLElement;
  dropdown: HTMLElement;
}

export function installMenuBar(container: HTMLElement, menus: MenuDef[]): void {
  let open: OpenState | null = null;

  const closeOpen = () => {
    if (!open) return;
    open.dropdown.remove();
    delete open.trigger.dataset.open;
    open = null;
  };

  const openAt = (menu: MenuDef, trigger: HTMLElement) => {
    closeOpen();
    const dropdown = renderDropdown(menu, closeOpen);
    document.body.appendChild(dropdown);
    const rect = trigger.getBoundingClientRect();
    dropdown.style.left = `${Math.round(rect.left)}px`;
    dropdown.style.top = `${Math.round(rect.bottom)}px`;
    trigger.dataset.open = "true";
    open = { menu, trigger, dropdown };
  };

  for (const menu of menus) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "menu-trigger";
    btn.textContent = menu.label;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (open && open.menu === menu) closeOpen();
      else openAt(menu, btn);
    });
    btn.addEventListener("mouseenter", () => {
      if (open && open.menu !== menu) openAt(menu, btn);
    });
    container.appendChild(btn);
  }

  document.addEventListener("mousedown", (e) => {
    if (!open) return;
    const target = e.target as Node | null;
    if (target && (open.dropdown.contains(target) || open.trigger.contains(target))) return;
    closeOpen();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && open) closeOpen();
  });
}

function renderDropdown(menu: MenuDef, onClose: () => void): HTMLElement {
  const drop = document.createElement("div");
  drop.className = "menu-dropdown";
  drop.addEventListener("mousedown", (e) => e.stopPropagation());

  for (const item of menu.items) {
    if ("sep" in item) {
      const sep = document.createElement("div");
      sep.className = "menu-separator";
      drop.appendChild(sep);
      continue;
    }
    const row = document.createElement("button");
    row.type = "button";
    row.className = "menu-item";
    const label = document.createElement("span");
    label.className = "menu-item-label";
    label.textContent = item.label;
    row.appendChild(label);
    if (item.shortcut) {
      const sc = document.createElement("span");
      sc.className = "menu-item-shortcut";
      sc.textContent = item.shortcut;
      row.appendChild(sc);
    }
    row.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      item.action();
    });
    drop.appendChild(row);
  }
  return drop;
}
