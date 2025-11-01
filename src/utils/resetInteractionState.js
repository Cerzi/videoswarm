export function resetInteractionState() {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return;
  }

  const dispatchSafe = (eventFactory) => {
    try {
      const event = eventFactory();
      if (event) document.dispatchEvent(event);
    } catch (err) {
      // noop – browser might not support the event constructor
    }
  };

  if (typeof PointerEvent !== 'undefined') {
    dispatchSafe(() => new PointerEvent('pointerup', {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      buttons: 0,
    }));
  }

  dispatchSafe(() => new MouseEvent('mouseup', {
    bubbles: true,
    cancelable: true,
  }));

  try {
    window.getSelection?.()?.removeAllRanges?.();
  } catch (err) {
    // ignore
  }

  const schedule = typeof window.requestAnimationFrame === 'function'
    ? window.requestAnimationFrame.bind(window)
    : (cb) => setTimeout(cb, 0);

  schedule(() => {
    const doc = document;
    const host = doc.body || doc.documentElement;
    if (!host) return;

    const sentinel = doc.createElement('button');
    sentinel.type = 'button';
    sentinel.setAttribute('aria-hidden', 'true');
    sentinel.tabIndex = -1;
    Object.assign(sentinel.style, {
      position: 'fixed',
      width: '0px',
      height: '0px',
      opacity: '0',
      pointerEvents: 'none',
      padding: '0',
      margin: '0',
      border: '0',
    });

    host.appendChild(sentinel);

    try {
      sentinel.focus({ preventScroll: true });
    } catch (err) {
      try { sentinel.focus(); } catch (err2) { /* ignore */ }
    }

    schedule(() => {
      try {
        sentinel.blur();
      } catch (err) {
        // ignore
      }
      sentinel.remove();
    });
  });
}

export default resetInteractionState;
