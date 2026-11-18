/** Participants list: this device + every linked device with live status and route. */
import { h, setText, setChildren } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { openDialog } from '../ui/dialog.js';
import { initials, hueFor } from '../util.js';

const ROUTE = {
  local: { icon: 'wifi', label: 'Direct · same network' },
  direct: { icon: 'direct', label: 'Direct connection' },
  relay: { icon: 'relay', label: 'Relayed through a TURN server' },
};

export function mountPeople({ list, count, room, getProfile, onRename }) {
  const rows = new Map();

  function selfRow() {
    const p = getProfile();
    const avatar = h('span', { class: 'avatar', 'aria-hidden': 'true', text: initials(p.name) });
    avatar.style.setProperty('--hue', hueFor(room.deviceKey));
    return h('li', { class: 'person person--self' },
      avatar,
      h('div', { class: 'person__body' },
        h('p', { class: 'person__name' }, h('span', { text: p.name }), h('span', { class: 'tag', text: 'You' })),
        h('p', { class: 'person__meta' }, icon(p.device, { size: 14 }), 'This device')),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Rename this device', title: 'Rename', onclick: onRename },
        icon('pencil', { size: 16 })));
  }

  function peerRow(link) {
    const avatar = h('span', { class: 'avatar', 'aria-hidden': 'true' });
    avatar.style.setProperty('--hue', hueFor(link.key || link.id));
    const name = h('span');
    const meta = h('p', { class: 'person__meta' });
    const dot = h('span', { class: 'status-dot', 'aria-hidden': 'true' });
    const verify = h('button', {
      class: 'icon-btn', type: 'button', title: 'Verify connection', onclick: () => showVerify(link),
    }, icon('shield', { size: 16 }));
    const el = h('li', { class: 'person person--enter' },
      h('div', { class: 'person__avatar' }, avatar, dot),
      h('div', { class: 'person__body' }, h('p', { class: 'person__name' }, name), meta),
      verify);
    el.addEventListener('animationend', () => el.classList.remove('person--enter'), { once: true });
    const rec = { el, avatar, name, meta, verify };
    rows.set(link.id, rec);
    update(link);
    return rec;
  }

  function update(link) {
    const rec = rows.get(link.id);
    if (!rec) return;
    rec.el.dataset.status = link.status === 'connected' && link.away ? 'away' : link.status;
    setText(rec.avatar, initials(link.name));
    setText(rec.name, link.name);
    rec.verify.setAttribute('aria-label', `Verify connection with ${link.name}`);
    rec.verify.hidden = !link.safetyCode || link.status !== 'connected';
    let metaIcon = link.device;
    let text;
    if (link.status === 'connecting') text = 'Connecting…';
    else if (link.status === 'reconnecting') text = 'Connection interrupted · reconnecting…';
    else if (link.away) text = 'App in background · transfers may slow down';
    else if (link.route) { metaIcon = ROUTE[link.route].icon; text = ROUTE[link.route].label; }
    else text = 'Connected';
    setChildren(rec.meta, icon(metaIcon, { size: 14 }), text);
  }

  function render() {
    // Devices appear once they've introduced themselves; dialing progress shows in the status pill.
    const peers = [...room.links.values()].filter((l) => l.everConnected);
    const keep = new Set(peers.map((l) => l.id));
    for (const [id, rec] of rows) if (!keep.has(id)) { rec.el.remove(); rows.delete(id); }
    const self = selfRow();
    const ordered = [self];
    for (const l of peers) ordered.push((rows.get(l.id) || peerRow(l)).el);
    list.replaceChildren(...ordered);
    for (const l of peers) update(l);
    const n = room.connectedPeers().length;
    setText(count, String(n + 1));
    count.setAttribute('aria-label', `${n + 1} ${n ? 'devices' : 'device'}`);
  }

  function showVerify(link) {
    if (!link.safetyCode) return;
    const routeNote = link.route === 'relay'
      ? 'This link passes through a TURN relay. The relay forwards encrypted data and can’t read it.'
      : 'Data travels directly between the two devices.';
    openDialog({
      title: `Verify ${link.name}`,
      body: [
        h('p', { class: 'dialog__text', text: 'Both devices show a code derived from the encryption keys of this connection. Compare them in person or over a call.' }),
        h('p', { class: 'safety-code', text: link.safetyCode }),
        h('p', { class: 'dialog__text dialog__text--muted', text: 'If the codes match, nobody (including the signaling server) is intercepting your connection. If they differ, leave the room.' }),
        h('p', { class: 'dialog__text dialog__text--muted', text: routeNote }),
      ],
    });
  }

  const unsubs = [
    room.on('peer:join', render),
    room.on('peer:leave', render),
    room.on('peer:update', (l) => (rows.has(l.id) ? update(l) : render())),
  ];
  render();

  return { render, destroy() { unsubs.forEach((u) => u()); list.replaceChildren(); rows.clear(); } };
}
