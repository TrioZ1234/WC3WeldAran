/**
 * A forty-line replacement for a framework.
 *
 * The interface is a handful of screens whose state is one `MatchConfig`. A
 * framework would add a build step, a dependency to keep current and a mental
 * model to learn, and would buy nothing this file does not already give: build
 * an element tree, replace a screen, wire an event.
 *
 * If the interface ever grows to where this hurts, that is the signal to adopt
 * one - not before.
 */

type Child = Node | string | number | false | null | undefined;

export interface Attributes {
  class?: string;
  id?: string;
  title?: string;
  type?: string;
  value?: string | number;
  disabled?: boolean;
  checked?: boolean;
  style?: string;
  /** Anything else lands as a plain attribute, including `data-*` and `aria-*`. */
  [key: string]: unknown;
}

/**
 * Create an element.
 *
 * Keys starting with `on` bind listeners; everything else becomes an attribute.
 * Booleans are treated the way HTML treats them - present or absent, never
 * `"false"` as a string, which is the classic way to accidentally disable a
 * button forever.
 */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes: Attributes = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);

  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith("on") && typeof value === "function") {
      element.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else if (value === true) {
      element.setAttribute(key, "");
    } else {
      element.setAttribute(key, String(value));
    }
  }

  append(element, children);
  return element;
}

export function append(parent: Node, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(typeof child === "object" ? child : document.createTextNode(String(child)));
  }
}

export function clear(element: Element): void {
  while (element.firstChild) element.removeChild(element.firstChild);
}

export const formatClock = (seconds: number): string => {
  const total = Math.max(0, Math.floor(seconds));
  const minutes = String(Math.floor(total / 60)).padStart(2, "0");
  return `${minutes}:${String(total % 60).padStart(2, "0")}`;
};

export const formatNumber = (value: number): string =>
  Math.round(value).toLocaleString("ru-RU");
