import "@testing-library/jest-dom/vitest";
import { JSDOM } from "jsdom";

// Node 26 ships an experimental global `localStorage` that is undefined
// unless --localstorage-file is provided, and it shadows the one jsdom
// injects (assignment to it silently fails). Redefine it with a real
// storage so lib/hook tests keep working under the jsdom environment.
// The instance's prototype is aligned with the current window's Storage
// so tests that spy on Storage.prototype keep intercepting writes.
const dom = new JSDOM("", { url: "http://localhost/" });
const storage = dom.window.localStorage;
Object.setPrototypeOf(storage, window.Storage.prototype);
Object.defineProperty(globalThis, "localStorage", {
  value: storage,
  configurable: true,
});

// The requests event-log table syncs a top scrollbar via ResizeObserver,
// which jsdom does not implement. A no-op stub keeps the effect inert.
if (typeof globalThis.ResizeObserver !== "function") {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver = ResizeObserverStub;
}
