class NativeOwnerInvalidatedError extends Error {
  constructor(message = "Native-work owner is no longer active") {
    super(message);
    this.name = "NativeOwnerInvalidatedError";
    this.code = "NATIVE_OWNER_INVALIDATED";
  }
}

class NativeOwnerLifecycle {
  constructor() {
    this.states = new WeakMap();
  }

  ensure(owner) {
    return this.#state(owner);
  }

  capture(owner) {
    const state = this.#state(owner);
    if (!state.active || state.disposed) throw new NativeOwnerInvalidatedError();
    return Object.freeze({ owner, epoch: state.epoch });
  }

  assertActive(context) {
    const state = context?.owner ? this.states.get(context.owner) : null;
    if (
      !state ||
      !state.active ||
      state.disposed ||
      state.epoch !== context.epoch
    ) {
      throw new NativeOwnerInvalidatedError();
    }
    return true;
  }

  invalidate(owner) {
    const state = this.#state(owner);
    if (!state.active && !state.disposed) return state.epoch;
    state.epoch += 1;
    state.active = false;
    return state.epoch;
  }

  activate(owner) {
    const state = this.#state(owner);
    if (state.disposed) return false;
    state.active = true;
    return true;
  }

  dispose(owner) {
    const state = this.#state(owner);
    if (state.disposed) return state.epoch;
    state.epoch += 1;
    state.active = false;
    state.disposed = true;
    return state.epoch;
  }

  getSnapshot(owner) {
    const state = this.#state(owner);
    return { ...state };
  }

  #state(owner) {
    if (!owner || (typeof owner !== "object" && typeof owner !== "function")) {
      throw new TypeError("Native-work owner must be an object");
    }
    let state = this.states.get(owner);
    if (!state) {
      state = { epoch: 1, active: true, disposed: false };
      this.states.set(owner, state);
    }
    return state;
  }
}

function createNativeOwnerLifecycle() {
  return new NativeOwnerLifecycle();
}

module.exports = {
  NativeOwnerInvalidatedError,
  NativeOwnerLifecycle,
  createNativeOwnerLifecycle,
};
