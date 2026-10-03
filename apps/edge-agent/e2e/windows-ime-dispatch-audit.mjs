/**
 * Install before application scripts, via addInitScript followed by one pre-login reload.
 * This only observes JavaScript dispatch; it never creates or dispatches an input event.
 * Keep this function self-contained because Playwright serializes it into the page.
 */
export function installImeDispatchAudit() {
  const prototype = EventTarget.prototype;
  const original = prototype.dispatchEvent;
  /** @type {WeakSet<Event>} */
  const dispatched = new WeakSet();
  /** @type {WeakMap<EventTarget, number>} */
  const counts = new WeakMap();
  const apply = Reflect.apply;
  let intact = true;
  /** @this {EventTarget} @param {Event} event @returns {boolean} */
  function auditedDispatch(event) {
    if (event !== null && (typeof event === "object" || typeof event === "function")) {
      dispatched.add(event);
      counts.set(this, Math.min((counts.get(this) ?? 0) + 1, 65));
    }
    return apply(original, this, [event]);
  }
  let currentDispatch = auditedDispatch;
  Object.defineProperty(prototype, "dispatchEvent", {
    enumerable: Object.getOwnPropertyDescriptor(prototype, "dispatchEvent")?.enumerable ?? false,
    configurable: false,
    get: () => currentDispatch,
    /** @this {EventTarget} @param {typeof auditedDispatch} replacement */
    set(replacement) {
      intact = false;
      if (this === prototype) currentDispatch = replacement;
      else
        Object.defineProperty(this, "dispatchEvent", {
          value: replacement,
          writable: true,
          enumerable: true,
          configurable: true,
        });
    },
  });
  const audit = Object.freeze({
    /** @param {EventTarget} target */
    snapshot(target) {
      return Object.freeze({
        auditIntact:
          intact &&
          EventTarget.prototype === prototype &&
          prototype.dispatchEvent === auditedDispatch &&
          target.dispatchEvent === auditedDispatch,
        scriptDispatchedEvents: counts.get(target) ?? 0,
      });
    },
    /** @param {Event} event */
    wasScriptDispatched(event) {
      return dispatched.has(event);
    },
  });
  Object.defineProperty(window, "laundryImeDispatchAudit", {
    value: audit,
    writable: false,
    configurable: false,
  });
}
