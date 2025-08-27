// ---- CONFIG ----
const PEER_OPTS = {
    config: {
        iceServers: [
            // Google STUN
            { urls: "stun:stun.l.google.com:19302" },
            { urls: "stun:stun1.l.google.com:19302" },
            { urls: "stun:stun2.l.google.com:19302" },
            { urls: "stun:stun3.l.google.com:19302" },
            { urls: "stun:stun4.l.google.com:19302" },

            // Metered STUN
            { urls: "stun:stun.relay.metered.ca:80" },

            // Metered TURN (UDP + TCP + TLS)
            {
                urls: "turn:global.relay.metered.ca:80",
                username: "11ce86125f24f22799572088",
                credential: "wHvY1DUIlFOSnXnp"
            },
            {
                urls: "turn:global.relay.metered.ca:80?transport=tcp",
                username: "11ce86125f24f22799572088",
                credential: "wHvY1DUIlFOSnXnp"
            },
            {
                urls: "turn:global.relay.metered.ca:443",
                username: "11ce86125f24f22799572088",
                credential: "wHvY1DUIlFOSnXnp"
            },
            {
                urls: "turns:global.relay.metered.ca:443?transport=tcp",
                username: "11ce86125f24f22799572088",
                credential: "wHvY1DUIlFOSnXnp"
            }
        ]
    }
}

// ---- Helpers & UI refs ----
function uid(len = 6) { return Math.random().toString(36).slice(2, 2 + len) }
function getParam(name) { const u = new URL(location.href); return u.searchParams.get(name) }

let room = getParam('room') || uid(6)
function makeRoomLink(r) { return location.origin + location.pathname + '?room=' + r }
let link = makeRoomLink(room)

const qrcodeEl = document.getElementById('qrcode')
const roomUrlEl = document.getElementById('roomUrl')
const copyBtn = document.getElementById('copyBtn')
const regenBtn = document.getElementById('regen')
const modeEl = document.getElementById('mode')
const chatFileSection = document.getElementById('chat-file-section')
const peersCountEl = document.getElementById('peersCount')
const messagesEl = document.getElementById('messages')
const sendBtn = document.getElementById('sendBtn')
const textIn = document.getElementById('textIn')
const fileInput = document.getElementById('fileInput')
const fileStatus = document.getElementById('fileStatus')
const incomingArea = document.getElementById('incomingArea')
const logsEl = document.getElementById('logs')
const toastContainer = document.getElementById('toastContainer')
const clearLogsBtn = document.getElementById('clearLogs')

// render QR
new QRCode(qrcodeEl, { text: link, width: 160, height: 160 })
roomUrlEl.textContent = link

copyBtn.addEventListener('click', async () => {
    await navigator.clipboard.writeText(link);
    copyBtn.textContent = 'Copied ✓';
    setTimeout(() => copyBtn.textContent = 'Copy link', 1400)
})

regenBtn.addEventListener('click', () => {
    room = uid(6);
    link = makeRoomLink(room);
    roomUrlEl.textContent = link;
    qrcodeEl.innerHTML = '';
    new QRCode(qrcodeEl, { text: link, width: 256, height: 256, correctLevel: QRCode.CorrectLevel.H });
    updateHostAttempt()
})

clearLogsBtn.addEventListener('click', () => logsEl.innerHTML = '')

function addLog(text) {
    const d = document.createElement('div');
    d.textContent = (new Date()).toLocaleTimeString() + ' — ' + text;
    logsEl.appendChild(d);
    logsEl.scrollTop = logsEl.scrollHeight
}

function showToast(opts) { // {title,msg,autohide,delay,actions:[{label,cls,onclick}]}
    const id = 't_' + uid(6);
    const wrapper = document.createElement('div');
    wrapper.innerHTML = `
        <div id="${id}" class="toast align-items-center text-bg-dark border-0 mb-2" role="alert" aria-live="assertive" aria-atomic="true">
            <div class="d-flex">
                <div class="toast-body">
                    <strong>${opts.title || ''}</strong><div>${opts.msg || ''}</div>
                </div>
                <div class="d-flex flex-column p-2 gap-1 align-items-end">
                    ${(opts.actions || []).map((a, i) => `<button data-act='${i}' class='btn btn-sm ${a.cls || "btn-light"}'>${a.label}</button>`).join('')}
                    <button data-close class='btn-close btn-close-white mt-1' aria-label='close'></button>
                </div>
            </div>
        </div>`;
    toastContainer.appendChild(wrapper);
    const el = document.getElementById(id);
    const bs = new bootstrap.Toast(el, { autohide: opts.autohide !== undefined ? opts.autohide : true, delay: opts.delay || 5000 });

    // bind actions
    (opts.actions || []).forEach((a, i) => {
        wrapper.querySelector(`[data-act='${i}']`).addEventListener('click', () => {
            a.onclick();
            if (a.dismiss !== false) bs.hide();
        });
    });

    wrapper.querySelector('[data-close]').addEventListener('click', () => bs.hide());
    bs.show();
    return { id, el: wrapper, bs };
}

// ---- PeerJS logic (adapted) ----
const peers = {}
let peer = null
let amHost = false
let pendingFiles = {}

// *** BATCHING MOD START ***
const incomingBatches = {} // batchId => { files: [], conn, timeoutId }
// Track how many files are expected in a batch and how many have been received
const incomingBatchStatus = {};
// *** BATCHING MOD END ***

function addMsg(text, who) {
    const d = document.createElement('div');
    d.className = 'msg ' + (who === 'me' ? 'me' : 'them');
    d.textContent = text;
    messagesEl.appendChild(d);
    messagesEl.scrollTop = messagesEl.scrollHeight
}

function setMode(m) { modeEl.textContent = m }
function setPeersCount(n) { peersCountEl.textContent = 'Peers: ' + n }

function updateHostAttempt() {
    if (peer) { try { peer.destroy() } catch (e) { } peer = null }
    amHost = false; setMode('waiting'); addLog('Attempting to become host for room ' + room)
    try {
        peer = new Peer(room, PEER_OPTS); amHost = true; addLog('Created Peer as host: ' + room)
    } catch (err) {
        peer = new Peer(undefined, PEER_OPTS); amHost = false; addLog('Created anonymous Peer (host fallback)')
    }

    peer.on('open', id => {
        addLog('Peer open: ' + id)
        chatFileSection.classList.remove('d-none')
        if (!amHost) {
            const conn = peer.connect(room);
            setupConn(conn)
        }
        setPeersCount(Object.keys(peers).length + 1)
        showToast({ title: 'Peer ready', msg: 'Peer ID: ' + id, autohide: true, delay: 2500 })
    })

    peer.on('connection', conn => {
        addLog('Incoming connection from ' + conn.peer);
        setupConn(conn);
        showToast({ title: 'Peer connected', msg: conn.peer, autohide: true, delay: 2200 })
    })

    peer.on('disconnected', () => { addLog('Peer disconnected'); showToast({ title: 'Disconnected', msg: 'Signaling disconnected', autohide: true }) })
    peer.on('close', () => { addLog('Peer closed'); showToast({ title: 'Closed', msg: 'Peer connection closed', autohide: true }) })
    peer.on('error', err => {
        addLog('Peer error: ' + (err && err.type ? err.type : err));
        showToast({ title: 'Peer error', msg: String(err), autohide: true })
        if (err && (err.type === 'unavailable-id' || err.type === 'peer-unavailable')) {
            try { peer.destroy() } catch (e) { }
            peer = new Peer(undefined, PEER_OPTS); amHost = false
            peer.on('open', () => { const conn = peer.connect(room); setupConn(conn) })
            peer.on('connection', c => setupConn(c))
        }
    })
}

function setupConn(conn) {
    conn.on('open', () => {
        peers[conn.peer] = conn
        setPeersCount(Object.keys(peers).length + 1)
        addLog('Connection open: ' + conn.peer)
        addMsg('Peer joined: ' + conn.peer, 'them')
        conn.send({ type: 'meta', sub: 'joined', id: peer.id })
        evaluateMode()
        showToast({ title: 'Connected', msg: 'Peer ' + conn.peer, autohide: true, delay: 2000 })
    })
    conn.on('data', data => handleData(conn, data))
    conn.on('close', () => {
        delete peers[conn.peer];
        setPeersCount(Object.keys(peers).length + 1);
        addLog('Connection closed: ' + conn.peer);
        addMsg('Peer left: ' + conn.peer, 'them');
        evaluateMode();
        showToast({ title: 'Peer left', msg: conn.peer, autohide: true })
    })
}

function handleData(conn, data) {
    if (!data || !data.type) return
    if (data.type === 'meta' && data.sub === 'joined') { addLog('Peer announced joined: ' + data.id); evaluateMode(); return }
    if (data.type === 'chat') { addMsg(data.text, 'them'); addLog('Chat from ' + conn.peer + ': ' + data.text); return }

    if (data.type === 'file-meta') {
        // *** BATCHING MOD START ***
        const batchId = data.batchId || ('single_' + data.fileId);
        if (!incomingBatches[batchId]) {
            incomingBatches[batchId] = { files: [], conn, timeoutId: null };
            incomingBatches[batchId].timeoutId = setTimeout(() => {
                const batch = incomingBatches[batchId];
                if (!batch) return;
                // Track expected files for this batch
                incomingBatchStatus[batchId] = { expected: batch.files.length, received: 0 };
                showBatchToast(batch.conn, batch.files, batchId);
                delete incomingBatches[batchId];
            }, 500); // 500ms to batch offers
        }
        incomingBatches[batchId].files.push(data);
        addLog(`Queued file offer ${data.name} from ${conn.peer} (batch ${batchId})`);
        // *** BATCHING MOD END ***
        return;
    }

    if (data.type === 'file-chunk') {
        const id = data.fileId;
        let chunk = data.chunk;
        const pin = conn._incoming && conn._incoming[id];
        if (pin) {
            if (!(chunk instanceof ArrayBuffer)) {
                if (chunk.data) {
                    chunk = new Uint8Array(chunk.data).buffer;
                }
            }
            pin.chunks.push(chunk);
            pin.size += (chunk.byteLength || chunk.length || 0);
        }
        return
    }

    if (data.type === 'file-end') {
        const id = data.fileId;
        const p = conn._incoming && conn._incoming[id];
        if (!p) return;
        const blob = new Blob(p.chunks, { type: (p.meta && p.meta.type) ? p.meta.type : 'application/octet-stream' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = p.meta.name;
        a.textContent = 'Download ' + p.meta.name;
        a.className = 'd-block mt-2';
        // Remove only the loading indicator, not the file links
        const loadingEl = incomingArea.querySelector('.file-loading');
        if (loadingEl) loadingEl.remove();
        incomingArea.appendChild(a);
        fileStatus.textContent = 'Received: ' + p.meta.name;
        addLog('Received file ' + p.meta.name + ' from ' + conn.peer);
        delete conn._incoming[id];
        // Batch tracking: increment received count and hide loading only when all files are received
        const batchId = p.meta.batchId || ('single_' + id);
        if (incomingBatchStatus[batchId]) {
            incomingBatchStatus[batchId].received++;
            if (incomingBatchStatus[batchId].received >= incomingBatchStatus[batchId].expected) {
                // Only remove loading, do not clear file links
                // (handled above)
                delete incomingBatchStatus[batchId];
            }
        }
        return;
    }

    if (data.type === 'file-accept') {
        const meta = pendingFiles && pendingFiles[data.fileId];
        if (meta) {
            addLog('Peer accepted file: ' + data.fileId + ' -> sending chunks to ' + conn.peer);
            sendFileChunksToConn(conn, meta)
        }
        return;
    }

    if (data.type === 'file-reject') {
        fileStatus.textContent = 'Receiver rejected the file';
        addLog('Peer rejected file ' + data.fileId)
    }
}

function showBatchToast(conn, files, batchId) {
    const fileListHtml = files.map(f => {
        const maxNameLength = 30;
        const displayName = f.name.length > maxNameLength ? f.name.slice(0, maxNameLength) + '…' : f.name;
        return `<span class="truncate-filename" title="${f.name}">${displayName}</span> (${Math.round(f.size / 1024)} KB)`;
    }).join('<br>');

    // Accept/Reject buttons above file list
    const actionsHtml = `
        <div class="file-action-btns btn-group">
            <button data-act='0' class='btn btn-success btn-sm'>Accept</button>
            <button data-act='1' class='btn btn-danger btn-sm'>Reject</button>
        </div>
    `;

    showToast({
        title: `Incoming ${files.length} file${files.length > 1 ? 's' : ''}`,
        msg: actionsHtml + fileListHtml,
        autohide: false,
        actions: [
            {
                label: '', // Accept button handled by custom HTML
                cls: '',
                onclick: () => {
                    files.forEach(f => {
                        conn.send({ type: 'file-accept', fileId: f.fileId });
                        conn._incoming = conn._incoming || {};
                        conn._incoming[f.fileId] = { chunks: [], size: 0, meta: f };
                    });
                    fileStatus.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"><path fill="currentColor" d="M12,1A11,11,0,1,0,23,12,11,11,0,0,0,12,1Zm0,19a8,8,0,1,1,8-8A8,8,0,0,1,12,20Z" opacity="0.25"/><circle cx="12" cy="2.5" r="1.5" fill="currentColor"><animateTransform attributeName="transform" dur="0.75s" repeatCount="indefinite" type="rotate" values="0 12 12;360 12 12"/></circle></svg> Receiving ${files.length} file${files.length > 1 ? 's' : ''}`;
                    addLog(`Accepted batch ${batchId} from ${conn.peer}`);
                },
                dismiss: true
            },
            {
                label: '', // Reject button handled by custom HTML
                cls: '',
                onclick: () => {
                    files.forEach(f => conn.send({ type: 'file-reject', fileId: f.fileId }));
                    addLog(`Rejected batch ${batchId} from ${conn.peer}`);
                },
                dismiss: true
            }
        ]
    });
    // Attach event listeners for custom Accept/Reject buttons
    setTimeout(() => {
        const toastBody = document.querySelector('.toast-body');
        if (toastBody) {
            const acceptBtn = toastBody.querySelector("button[data-act='0']");
            const rejectBtn = toastBody.querySelector("button[data-act='1'] ");
            // Find the toast element and its Toast instance
            const toastEl = toastBody.closest('.toast');
            let bsToast = null;
            if (toastEl) {
                bsToast = bootstrap.Toast.getOrCreateInstance(toastEl);
            }
            if (acceptBtn) acceptBtn.onclick = () => {
                files.forEach(f => {
                    conn.send({ type: 'file-accept', fileId: f.fileId });
                    conn._incoming = conn._incoming || {};
                    conn._incoming[f.fileId] = { chunks: [], size: 0, meta: f };
                });
                fileStatus.textContent = `Receiving ${files.length} file${files.length > 1 ? 's' : ''}`;
                addLog(`Accepted batch ${batchId} from ${conn.peer}`);
                if (bsToast) bsToast.hide();
                // Show loading when waiting for files
                setFileLoading(true);
            };
            if (rejectBtn) rejectBtn.onclick = () => {
                files.forEach(f => conn.send({ type: 'file-reject', fileId: f.fileId }));
                addLog(`Rejected batch ${batchId} from ${conn.peer}`);
                if (bsToast) bsToast.hide();
            };
        }
    }, 100);
}

function evaluateMode() {
    const peerCount = Object.keys(peers).length + 1;
    if (peerCount >= 2) {
        setMode('file-sharing');
        chatFileSection.classList.remove('d-none'); // Show when someone joins
    } else {
        setMode('waiting');
        chatFileSection.classList.add('d-none'); // Hide when alone
    }
}

// Chat send
sendBtn.addEventListener('click', () => {
    const text = textIn.value.trim();
    if (!text) return;
    addMsg(text, 'me');
    broadcast({ type: 'chat', text });
    textIn.value = '';
    addLog('Sent chat: ' + text)
})

textIn.addEventListener('keydown', e => {
    if (e.key === 'Enter') sendBtn.click()
})

function broadcast(obj) {
    for (const id in peers) {
        try { peers[id].send(obj) } catch (e) { addLog('Broadcast error to ' + id) }
    }
}

// *** BATCHING MOD START ***
// File sending with multiple files and batchId
fileInput.setAttribute('multiple', 'multiple')
fileInput.addEventListener('change', e => {
    const files = e.target.files;
    if (!files.length) return;

    const batchId = uid(8);

    fileStatus.textContent = `Offering ${files.length} file${files.length > 1 ? 's' : ''}`;
    addLog(`Offering ${files.length} files as batch ${batchId}`);

    for (const f of files) {
        const id = 'f_' + uid(8);
        pendingFiles[id] = { file: f, meta: { fileId: id, name: f.name, size: f.size, batchId, type: f.type } };
        broadcast({ type: 'file-meta', fileId: id, name: f.name, size: f.size, batchId, type: f.type });
    }
})
// *** BATCHING MOD END ***

async function sendFileChunksToConn(conn, fmeta) {
    const file = fmeta.file;
    const chunkSize = 64 * 1024; // 64KB chunks
    const total = file.size;
    let offset = 0;
    const reader = new FileReader();

    function readSlice(o) {
        const slice = file.slice(o, o + chunkSize);
        reader.readAsArrayBuffer(slice);
    }

    reader.onload = async e => {
        const buf = e.target.result;
        if (!conn.open) {
            addLog('Connection closed during file send');
            return;
        }
        try {
            conn.send({ type: 'file-chunk', fileId: fmeta.meta.fileId, chunk: buf });
        } catch (err) {
            addLog('Chunk send error: ' + err);
            return;
        }
        offset += buf.byteLength;
        if (offset < total) {
            // Delay to prevent flooding the channel
            await new Promise(r => setTimeout(r, 20));
            readSlice(offset);
        } else {
            conn.send({ type: 'file-end', fileId: fmeta.meta.fileId });
            fileStatus.textContent = 'Sent: ' + file.name;
            addLog('Sent file ' + file.name);
            delete pendingFiles[fmeta.meta.fileId];
        }
    };

    readSlice(0);
}

function setFileLoading(loading) {
    if (loading) {
        incomingArea.innerHTML = '<div class="file-loading">Waiting for incoming files...</div>';
    } else {
        incomingArea.innerHTML = '';
    }
}

// init
updateHostAttempt()

// expose for debug
window._dbg = { peer, peers }

incomingArea.addEventListener('click', e => {
    if (e.target.tagName.toLowerCase() === 'a') {
        e.target.style.color = 'orange';
    }
});