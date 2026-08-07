/* The bundled panel has connection guards compiled with a 25s default.
 * Extend only that exact network timeout; UI timers keep their original
 * behavior.
 */
(function () {
  'use strict';
  const nativeSetTimeout = window.setTimeout.bind(window);
  window.setTimeout = function (handler, delay, ...args) {
    const extendedDelay = delay === 25000 ? 90000 : delay;
    return nativeSetTimeout(handler, extendedDelay, ...args);
  };
})();