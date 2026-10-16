/**
 * A minimal DOM, just enough for Preact to render components in Node unit tests
 * (the project has no jsdom). Elements keep attributes, children and listeners;
 * tests assert on `textContent`, attributes and the query helpers below.
 * Test-only: nothing in the app imports this file.
 */
import { type ComponentChild, render } from 'preact';
import { act } from 'preact/test-utils';
import { vi } from 'vitest';

const HTML_NS = 'http://www.w3.org/1999/xhtml';

export interface FakeEvent {
  type: string;
  target: FakeEventTarget;
  currentTarget: FakeEventTarget;
  defaultPrevented: boolean;
  preventDefault(): void;
  stopPropagation(): void;
}

type Listener = (this: FakeEventTarget, event: FakeEvent) => unknown;

export class FakeEventTarget {
  readonly listeners = new Map<string, Set<Listener>>();

  addEventListener(type: string, listener: Listener): void {
    const key = type.toLowerCase();
    const set = this.listeners.get(key) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(key, set);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type.toLowerCase())?.delete(listener);
  }

  /** Calls the listeners of this target only (no bubbling); Preact attaches handlers to the element itself. */
  dispatch(type: string): FakeEvent {
    const event: FakeEvent = {
      type,
      target: this,
      currentTarget: this,
      defaultPrevented: false,
      preventDefault() {
        event.defaultPrevented = true;
      },
      stopPropagation() {},
    };
    for (const listener of [...(this.listeners.get(type.toLowerCase()) ?? [])]) listener.call(this, event);
    return event;
  }
}

export class FakeNode extends FakeEventTarget {
  parentNode: FakeElement | null = null;
  readonly childNodes: FakeNode[] = [];

  get firstChild(): FakeNode | null {
    return this.childNodes[0] ?? null;
  }

  get nextSibling(): FakeNode | null {
    const siblings = this.parentNode?.childNodes;
    if (!siblings) return null;
    return siblings[siblings.indexOf(this) + 1] ?? null;
  }

  get textContent(): string {
    return this.childNodes.map((child) => child.textContent).join('');
  }
}

export class FakeText extends FakeNode {
  readonly nodeType = 3;
  #data: string;

  constructor(data: unknown) {
    super();
    this.#data = String(data);
  }

  get data(): string {
    return this.#data;
  }

  set data(value: unknown) {
    this.#data = String(value);
  }

  override get textContent(): string {
    return this.#data;
  }
}

export class FakeElement extends FakeNode {
  readonly nodeType = 1;
  readonly attrs = new Map<string, string>();
  readonly style = { cssText: '', setProperty() {} };
  // Present so that Preact uses the lower-case DOM event names (`'onclick' in dom`).
  onclick = null;
  oninput = null;
  onchange = null;
  onsubmit = null;
  onkeydown = null;
  onpointerdown = null;
  onfocus = null;
  onblur = null;

  constructor(
    readonly localName: string,
    readonly namespaceURI: string,
  ) {
    super();
  }

  setAttribute(name: string, value: unknown): void {
    this.attrs.set(name, String(value));
  }

  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }

  hasAttribute(name: string): boolean {
    return this.attrs.has(name);
  }

  removeAttribute(name: string): void {
    this.attrs.delete(name);
  }

  insertBefore(node: FakeNode, reference: FakeNode | null): FakeNode {
    node.parentNode?.removeChild(node);
    const index = reference ? this.childNodes.indexOf(reference) : -1;
    if (index < 0) this.childNodes.push(node);
    else this.childNodes.splice(index, 0, node);
    node.parentNode = this;
    return node;
  }

  appendChild(node: FakeNode): FakeNode {
    return this.insertBefore(node, null);
  }

  removeChild(node: FakeNode): FakeNode {
    const index = this.childNodes.indexOf(node);
    if (index >= 0) this.childNodes.splice(index, 1);
    node.parentNode = null;
    return node;
  }

  contains(node: unknown): boolean {
    for (let current = node instanceof FakeNode ? node : null; current; current = current.parentNode) {
      if (current === this) return true;
    }
    return false;
  }

  focus(): void {}
  blur(): void {}
}

export class FakeDocument extends FakeEventTarget {
  visibilityState: 'visible' | 'hidden' = 'visible';

  createElement(name: string): FakeElement {
    return new FakeElement(name, HTML_NS);
  }

  createElementNS(namespace: string, name: string): FakeElement {
    return new FakeElement(name, namespace);
  }

  createTextNode(text: unknown): FakeText {
    return new FakeText(text);
  }

  /** Switches the page visibility and fires `visibilitychange`, as a browser tab does. */
  setVisibility(state: 'visible' | 'hidden'): void {
    this.visibilityState = state;
    this.dispatch('visibilitychange');
  }
}

/** Installs a fresh fake `document`; undo with `vi.unstubAllGlobals()`. */
export function installDocument(): FakeDocument {
  const doc = new FakeDocument();
  vi.stubGlobal('document', doc);
  return doc;
}

export interface Mounted {
  container: FakeElement;
  update(vnode: ComponentChild): Promise<void>;
  unmount(): Promise<void>;
}

/** Renders `vnode` into a detached container and flushes effects. Needs `installDocument()` first. */
export async function mount(vnode: ComponentChild): Promise<Mounted> {
  const container = new FakeElement('div', HTML_NS);
  const root = container as unknown as Element;
  await act(() => {
    render(vnode, root);
  });
  return {
    container,
    update: (next) =>
      act(() => {
        render(next, root);
      }),
    unmount: () =>
      act(() => {
        render(null, root);
      }),
  };
}

/** Lets pending promises (fetch, JSON parsing) settle and flushes the resulting renders. */
export function settle(): Promise<void> {
  return act(async () => {
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** Every element below `root`, depth first. */
export function elements(root: FakeNode): FakeElement[] {
  const found: FakeElement[] = [];
  for (const child of root.childNodes) {
    if (child instanceof FakeElement) found.push(child, ...elements(child));
  }
  return found;
}

/** Text with whitespace collapsed, as a reader would see it. */
export function textOf(node: FakeNode): string {
  return node.textContent.replace(/\s+/g, ' ').trim();
}

export function byRole(root: FakeNode, role: string): FakeElement[] {
  return elements(root).filter((element) => element.getAttribute('role') === role);
}

export function byClass(root: FakeNode, className: string): FakeElement[] {
  return elements(root).filter((element) =>
    (element.getAttribute('class') ?? '').split(/\s+/).includes(className),
  );
}

export function byTag(root: FakeNode, tag: string): FakeElement[] {
  return elements(root).filter((element) => element.localName === tag);
}

/** The smallest element whose text contains `text`; throws when there is none. */
export function getByText(root: FakeNode, text: string): FakeElement {
  const matches = elements(root).filter((element) => textOf(element).includes(text));
  const innermost = matches.filter(
    (element) => !matches.some((other) => other !== element && element.contains(other)),
  );
  const found = innermost[0];
  if (!found) throw new Error(`No element with text «${text}» in: ${textOf(root)}`);
  return found;
}

/** The button whose text contains `text`; throws when there is none. */
export function getButton(root: FakeNode, text: string): FakeElement {
  const found = byTag(root, 'button').find((button) => textOf(button).includes(text));
  if (!found) throw new Error(`No button «${text}» in: ${textOf(root)}`);
  return found;
}

/** Clicks an element and flushes the resulting renders. */
export function click(element: FakeElement): Promise<void> {
  return act(() => {
    element.dispatch('click');
  });
}
