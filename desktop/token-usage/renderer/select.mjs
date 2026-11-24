const controls = new Set();

// Keep the native select as the source of truth and a no-JS fallback.
export function enhanceSelect(select) {
  const host = document.createElement("div");
  host.className = "custom-select";
  host.dataset.select = select.id;
  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "select-trigger";
  trigger.setAttribute("role", "combobox");
  trigger.setAttribute("aria-label", select.getAttribute("aria-label"));
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");
  const value = document.createElement("span");
  value.className = "select-value";
  const arrow = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  arrow.setAttribute("viewBox", "0 0 20 20");
  arrow.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(arrow.namespaceURI, "path");
  path.setAttribute("d", "m6 8 4 4 4-4");
  arrow.append(path);
  trigger.append(value, arrow);
  const menu = document.createElement("div");
  menu.id = `${select.id}-options`;
  menu.className = "select-menu";
  menu.setAttribute("role", "listbox");
  menu.setAttribute("aria-label", select.getAttribute("aria-label"));
  menu.hidden = true;
  trigger.setAttribute("aria-controls", menu.id);
  select.before(host);
  host.append(select, trigger, menu);
  select.hidden = true;
  let active = 0, prefix = "", typedAt = 0;
  const options = () => Array.from(select.options);
  function render() {
    const items = options();
    value.textContent = items[select.selectedIndex]?.textContent || "请选择";
    trigger.disabled = select.disabled;
    menu.replaceChildren();
    items.forEach((option, index) => {
      const item = document.createElement("div");
      item.id = `${select.id}-option-${index}`;
      item.className = "select-option";
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", String(option.selected));
      item.setAttribute("aria-disabled", String(option.disabled));
      item.textContent = option.textContent;
      item.onpointerdown = (event) => event.preventDefault();
      item.onclick = () => choose(index);
      menu.append(item);
    });
    highlight(active);
  }
  function highlight(index) {
    active = index;
    for (const [i, item] of Array.from(menu.children).entries())
      item.classList.toggle("active-option", i === index);
    if (!menu.hidden && menu.children[index]) {
      trigger.setAttribute("aria-activedescendant", menu.children[index].id);
      menu.children[index].scrollIntoView({ block: "nearest" });
    }
  }
  function close() {
    menu.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    trigger.removeAttribute("aria-activedescendant");
    prefix = "";
  }
  function open() {
    for (const control of controls) control.close();
    active = Math.max(0, select.selectedIndex);
    menu.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    highlight(active);
  }
  function choose(index) {
    if (options()[index]?.disabled) return;
    const previous = select.value;
    select.selectedIndex = index;
    close();
    render();
    trigger.focus({ preventScroll: true });
    if (select.value !== previous)
      select.dispatchEvent(new Event("change", { bubbles: true }));
  }
  trigger.onclick = () => menu.hidden ? open() : close();
  trigger.onkeydown = (event) => {
    const items = options();
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      if (menu.hidden) open();
      let index = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
        : (active + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      const direction = event.key === "ArrowUp" || event.key === "End" ? -1 : 1;
      for (let i = 0; i < items.length && items[index]?.disabled; i++)
        index = (index + direction + items.length) % items.length;
      highlight(index);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      menu.hidden ? open() : choose(active);
    } else if (event.key === "Escape") {
      if (!menu.hidden) { event.preventDefault(); event.stopPropagation(); close(); }
    } else if (event.key === "Tab") close();
    else if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      if (menu.hidden) open();
      if (Date.now() - typedAt > 700) prefix = "";
      prefix += event.key.toLocaleLowerCase();
      typedAt = Date.now();
      const index = items.findIndex((option) => !option.disabled && option.textContent.toLocaleLowerCase().startsWith(prefix));
      if (index >= 0) highlight(index);
    }
  };
  select.addEventListener("change", render);
  host.addEventListener("focusout", (event) => {
    if (!host.contains(event.relatedTarget)) close();
  });
  document.addEventListener("pointerdown", (event) => {
    if (!host.contains(event.target)) close();
  });
  const control = { close };
  controls.add(control);
  render();
  return control;
}
