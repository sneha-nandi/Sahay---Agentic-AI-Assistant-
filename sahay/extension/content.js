// Injected into the active tab on demand (isolated world: page scripts can't see or
// change anything defined here). Reads the page and executes the single action the
// backend's risk layer released. Re-injection is a no-op.
if (!window.__sahay) {
  // Element ids live only in this private map. They are never written to the DOM, so a
  // page can't forge or copy them to redirect an action to a different element.
  const prefix = crypto.getRandomValues(new Uint32Array(1))[0].toString(36);
  const idOf = new WeakMap();
  const elementOf = new Map();
  let counter = 0;
  const idFor = (el) => {
    if (!idOf.has(el)) {
      const id = `${prefix}-${++counter}`;
      idOf.set(el, id);
      elementOf.set(id, el);
    }
    return idOf.get(el);
  };

  const TRANSPARENT = /^(transparent|rgba\(.*,\s*0\))$/;
  function camouflaged(el, style) {
    if (TRANSPARENT.test(style.color)) return true;
    for (let p = el; p; p = p.parentElement) {
      const bg = getComputedStyle(p).backgroundColor;
      if (!TRANSPARENT.test(bg)) return bg === style.color;
    }
    return false;
  }

  // Visible to a person: rendered, not transparent, on the page, not microscopic, not same colour as its background.
  function shown(el) {
    if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    if (r.right + scrollX <= 0 || r.bottom + scrollY <= 0 || r.left + scrollX >= document.documentElement.scrollWidth) return false;
    const style = getComputedStyle(el);
    return parseFloat(style.fontSize) >= 6 && !camouflaged(el, style);
  }

  const BLOCK = 'p,div,li,h1,h2,h3,h4,h5,h6,td,th,section,article,header,footer,main,label,legend,button,dd,dt,pre,blockquote,form,fieldset,nav,aside,summary';
  function visibleText() {
    const out = [];
    const ok = new Map();
    let hidden = 0;
    let length = 0;
    let lastBlock;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node; (node = walker.nextNode()) && length < 15000;) {
      const text = node.nodeValue.replace(/\s+/g, ' ');
      const el = node.parentElement;
      if (!text.trim() || !el || el.closest('script,style,noscript,template,select')) continue;
      if (!ok.has(el)) ok.set(el, shown(el));
      if (!ok.get(el)) { hidden += text.length; continue; }
      const block = el.closest(BLOCK);
      if (block !== lastBlock) { out.push('\n'); lastBlock = block; }
      out.push(text);
      length += text.length;
    }
    return { text: out.join('').replace(/\n\s+/g, '\n').trim().slice(0, 15000), hidden };
  }

  function labelOf(el) {
    const isButton = ['submit', 'button', 'reset', 'image'].includes(el.type) || el.tagName === 'BUTTON';
    return (el.labels?.[0]?.innerText || el.getAttribute('aria-label') || el.placeholder || el.closest('label')?.innerText ||
      (el.tagName === 'A' || isButton || el.getAttribute('role') === 'button' ? el.innerText || (isButton ? el.value : '') : '') ||
      el.name || el.title || el.alt || '').trim().slice(0, 160);
  }

  function describe(el) {
    const tag = el.tagName.toLowerCase();
    const kind = el.type === 'file' ? 'file' : tag === 'a' ? 'link'
      : tag === 'button' || el.getAttribute('role') === 'button' || ['submit', 'button', 'reset', 'image'].includes(el.type) ? 'button' : tag;
    return { kind, type: el.type || null, label: labelOf(el) };
  }

  function snapshot() {
    const elements = [];
    for (const el of document.querySelectorAll('input, select, textarea, button, a[href], [role="button"]')) {
      if (el.type === 'hidden' || !(el.type === 'file' || shown(el))) continue;
      const item = { id: idFor(el), ...describe(el), name: el.name || null, autocomplete: el.autocomplete || null, required: !!el.required };
      if (item.kind === 'link') { item.text = item.label; item.href = el.href; }
      if (item.kind === 'button') item.text = item.label;
      // button.formAction falls back to the page URL, so only use it when the attribute is really set
      if (el.form) item.form_action = el.hasAttribute('formaction') ? el.formAction : el.form.action;
      if (['input', 'textarea', 'select'].includes(item.kind)) item.value = el.type === 'checkbox' || el.type === 'radio' ? '' : el.value;
      if (el.type === 'checkbox' || el.type === 'radio') item.checked = el.checked;
      if (item.kind === 'file') item.files = el.files?.length || 0;
      if (item.kind === 'select') {
        item.options = [...el.options].slice(0, 50).map((o) => o.text.trim().slice(0, 80));
        item.selectedText = el.selectedOptions[0]?.text.trim() || '';
      }
      elements.push(item);
      if (elements.length >= 150) break;
    }
    const { text, hidden } = visibleText();
    return { url: location.href, title: document.title.slice(0, 300), text, hidden_text_chars: hidden, elements };
  }

  function flash(el) {
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    const old = el.style.outline;
    el.style.outline = '3px solid #f59e0b';
    setTimeout(() => (el.style.outline = old), 4000);
  }

  function setValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : el instanceof HTMLSelectElement ? HTMLSelectElement : HTMLInputElement;
    Object.getOwnPropertyDescriptor(proto.prototype, 'value').set.call(el, value); // works with React-controlled inputs
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function execute(a) {
    // The tab must still be on the site the action was approved for.
    if (a.site && location.host !== a.site) return { ok: false, error: `The tab is now on ${location.host}, not ${a.site}.` };
    if (a.type === 'navigate') {
      const url = new URL(a.url, location.href);
      if (!['http:', 'https:'].includes(url.protocol)) return { ok: false, error: 'Only http(s) links can be opened.' };
      setTimeout(() => (location.href = url.href), 50);
      return { ok: true, detail: `Opening ${url.href}` };
    }
    const el = elementOf.get(a.target_id);
    if (!el || !el.isConnected || !(el.type === 'file' || shown(el))) return { ok: false, error: 'The element is no longer visible on the page.' };
    // Refuse if the page changed the element after Sahay assessed it (e.g. relabelled a button).
    const now = describe(el);
    const expect = a.expect || {};
    if (now.kind !== expect.kind || now.type !== expect.type || now.label !== expect.label) {
      return { ok: false, error: `The element changed after Sahay checked it (now “${now.label}”). Nothing was done.` };
    }
    flash(el);
    switch (a.type) {
      case 'highlight':
        return { ok: true, detail: 'Highlighted on the page.' };
      case 'fill':
        el.focus();
        setValue(el, a.value);
        return { ok: true };
      case 'select': {
        const want = String(a.value).trim().toLowerCase();
        const opt = [...el.options].find((o) => o.text.trim().toLowerCase() === want || o.value.toLowerCase() === want);
        if (!opt) return { ok: false, error: `No option “${a.value}” in this list.` };
        setValue(el, opt.value);
        return { ok: true };
      }
      case 'click':
        el.click();
        return { ok: true };
      case 'upload':
        el.focus();
        return { ok: true, detail: 'Choose the file yourself in the highlighted field.' };
      case 'submit': {
        const form = el.form || el.closest('form');
        if (!form) return { ok: false, error: 'No form found for this element.' };
        if (!form.checkValidity()) {
          form.reportValidity();
          const missing = [...form.elements].filter((f) => f.willValidate && !f.checkValidity()).map(labelOf);
          return { ok: false, error: `The website rejected the form. Fields to fix: ${missing.join('; ')}` };
        }
        form.requestSubmit(el.form === form && ['submit', 'image'].includes(el.type) ? el : undefined);
        return { ok: true };
      }
    }
    return { ok: false, error: `Unsupported action ${a.type}` };
  }

  window.__sahay = { snapshot, execute };
}
