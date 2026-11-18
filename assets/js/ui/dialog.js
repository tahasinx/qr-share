/** Accessible modal dialogs built on the native <dialog> element (focus trap, Esc, inert background). */
import { h } from './dom.js';
import { icon } from './icons.js';

/**
 * @param {{ title: string, body: Node|Node[], actions?: Node[], className?: string,
 *   onClose?: () => void, describedBy?: boolean }} opts
 * @returns {{ el: HTMLDialogElement, close: () => void }}
 */
export function openDialog({ title, body, actions = [], className = '', onClose }) {
  const titleId = `dlg-${Math.random().toString(36).slice(2, 8)}`;
  const el = h('dialog', { class: `dialog ${className}`.trim(), 'aria-labelledby': titleId },
    h('div', { class: 'dialog__head' },
      h('h2', { class: 'dialog__title', id: titleId, text: title }),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', onclick: () => close() }, icon('x'))),
    h('div', { class: 'dialog__body' }, body),
    actions.length ? h('div', { class: 'dialog__actions' }, actions) : null);

  let closed = false;
  const opener = document.activeElement;
  function close() {
    if (closed) return;
    closed = true;
    const finish = () => {
      if (el.open) el.close();
      el.remove();
      onClose?.();
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true });
    };
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) { finish(); return; }
    el.classList.add('is-closing');
    el.addEventListener('animationend', finish, { once: true });
    setTimeout(finish, 250);
  }
  el.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
  // Click on the backdrop (outside the dialog box) closes it.
  el.addEventListener('pointerdown', (e) => {
    if (e.target !== el) return;
    const r = el.getBoundingClientRect();
    const outside = e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
    if (outside) close();
  });
  document.body.append(el);
  el.showModal();
  return { el, close };
}

/** Promise-based confirmation. Resolves true when confirmed. */
export function confirmDialog({ title, message, confirmLabel, danger = false }) {
  return new Promise((resolve) => {
    let result = false;
    const { close } = openDialog({
      title,
      body: h('p', { class: 'dialog__text', text: message }),
      actions: [
        h('button', { class: 'btn btn--quiet', type: 'button', text: 'Cancel', onclick: () => close() }),
        h('button', {
          class: `btn ${danger ? 'btn--danger' : 'btn--primary'}`, type: 'button', text: confirmLabel,
          onclick: () => { result = true; close(); },
        }),
      ],
      onClose: () => resolve(result),
    });
  });
}
