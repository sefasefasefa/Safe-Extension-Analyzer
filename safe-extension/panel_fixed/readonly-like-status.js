/* Read-only like state for content cards.
 * The bundled panel is intentionally left intact; this layer removes the
 * mutation control from rendered media cards and keeps the existing state
 * visible as text.
 */
(function () {
  'use strict';

  function isLikeControl(button) {
    if (!button || button.tagName !== 'BUTTON') return false;
    const svg = button.querySelector('svg');
    const text = (button.textContent || '').trim();
    return Boolean(svg && /^\d[\d.,]*[KMB]?$/.test(text));
  }

  function makeReadonly(button) {
    if (!isLikeControl(button) || button.dataset.readonlyLike === '1') return;
    button.dataset.readonlyLike = '1';
    const liked = button.className.includes('text-primary') ||
      button.className.includes('bg-primary');
    const count = (button.textContent || '').trim();
    const status = document.createElement('div');
    status.className = button.className.replace(/\bactive:scale-\S+/g, '');
    status.setAttribute('role', 'status');
    status.title = liked ? 'Bu içerik daha önce beğenildi' : 'Bu içerik henüz beğenilmedi';
    status.innerHTML =
      '<span style="font-size:10px;font-weight:700">' +
      (liked ? 'Beğenildi' : 'Beğenilmedi') +
      '</span><span style="font-size:10px;opacity:.7;margin-left:5px">· ' +
      count + '</span>';
    button.replaceWith(status);
  }

  function scan() {
    document.querySelectorAll('button').forEach(makeReadonly);
  }

  new MutationObserver(scan).observe(document.documentElement, {
    subtree: true,
    childList: true,
  });
  scan();
})();