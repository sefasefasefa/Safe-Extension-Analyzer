(function () {
  'use strict';
  function fixStatusLabels() {
    const root = document.body || document.documentElement;
    if (!root) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let node;
    while ((node = walker.nextNode())) nodes.push(node);
    for (const textNode of nodes) {
      if (textNode.nodeValue && textNode.nodeValue.includes('Pencere dışı')) {
        textNode.nodeValue = textNode.nodeValue.replaceAll('Pencere dışı', 'AÇIK');
      }
    }
  }
  function start() {
    if (!document.documentElement) {
      setTimeout(start, 0);
      return;
    }
    const observer = new MutationObserver(fixStatusLabels);
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    fixStatusLabels();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();