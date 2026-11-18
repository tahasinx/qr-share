/**
 * Tiny DOM builder. Strings become text nodes, so untrusted content is never parsed as HTML.
 *
 *   h('button', { class: 'btn', onclick: fn, 'aria-label': 'Close' }, icon('x'), 'Close')
 */
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value == null || value === false) continue;
      if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
      else if (key === 'class') el.className = value;
      else if (key === 'text') el.textContent = value;
      else if (key === 'dataset') Object.assign(el.dataset, value);
      else if (key === 'style') Object.assign(el.style, value);
      else if (key in el && !key.includes('-') && key !== 'list' && key !== 'form') el[key] = value;
      else el.setAttribute(key, value === true ? '' : String(value));
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of children) {
    if (child == null || child === false) continue;
    if (Array.isArray(child)) append(el, child);
    else el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export const $ = (sel, root = document) => root.querySelector(sel);

/** Replaces all children of `el`. */
export function setChildren(el, ...children) {
  el.replaceChildren();
  append(el, children);
}

/** Sets textContent only when it changes (avoids needless layout work in hot paths). */
export function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}
