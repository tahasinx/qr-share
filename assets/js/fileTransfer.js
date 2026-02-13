/**
 * File Transfer Module
 * Handles file sending, receiving, chunking, and progress tracking
 */

const FileTransfer = {
    pendingFiles: {},
    incomingBatches: {},
    incomingBatchStatus: {},
    activeTransfers: {},
    transferStats: {},

    /**
     * Initialize file transfer
     */
    init() {
        this.pendingFiles = {};
        this.incomingBatches = {};
        this.incomingBatchStatus = {};
        this.activeTransfers = {};
        this.transferStats = {};
    },

    /**
     * Handle incoming file metadata
     * @param {Object} conn - Connection object
     * @param {Object} data - File metadata
     */
    handleFileMeta(conn, data) {
        const batchId = data.batchId || ('single_' + data.fileId);
        
        if (!this.incomingBatches[batchId]) {
            this.incomingBatches[batchId] = {
                files: [],
                conn: conn,
                timeoutId: null
            };
            
            // Batch files together (500ms window)
            this.incomingBatches[batchId].timeoutId = setTimeout(() => {
                const batch = this.incomingBatches[batchId];
                if (!batch) return;
                
                this.incomingBatchStatus[batchId] = {
                    expected: batch.files.length,
                    received: 0
                };
                
                this.showBatchToast(batch.conn, batch.files, batchId);
                delete this.incomingBatches[batchId];
            }, 500);
        }
        
        this.incomingBatches[batchId].files.push(data);
        UI.addLog(`Queued file offer ${data.name} from ${conn.peer} (batch ${batchId})`);
    },

    /**
     * Show batch file toast with accept/reject
     * @param {Object} conn - Connection
     * @param {Array} files - File metadata array
     * @param {string} batchId - Batch ID
     */
    showBatchToast(conn, files, batchId) {
        const fileListHtml = files.map(f => {
            const displayName = Utils.truncate(f.name, 30);
            const size = Utils.formatFileSize(f.size);
            return `<span class="truncate-filename" title="${Utils.sanitize(f.name)}">${Utils.sanitize(displayName)}</span> (${size})`;
        }).join('<br>');

        const actionsHtml = `
            <div class="file-action-btns btn-group">
                <button data-act='0' class='btn btn-success btn-sm'>Accept</button>
                <button data-act='1' class='btn btn-danger btn-sm'>Reject</button>
            </div>
        `;

        const toast = UI.showToast({
            title: `Incoming ${files.length} file${files.length > 1 ? 's' : ''}`,
            msg: actionsHtml + fileListHtml,
            autohide: false,
            actions: [
                {
                    label: 'Accept',
                    cls: 'btn-success',
                    onclick: () => this.acceptBatch(conn, files, batchId),
                    dismiss: true
                },
                {
                    label: 'Reject',
                    cls: 'btn-danger',
                    onclick: () => this.rejectBatch(conn, files, batchId),
                    dismiss: true
                }
            ]
        });

        // Also handle custom buttons
        setTimeout(() => {
            const toastBody = document.querySelector('.toast-body');
            if (toastBody) {
                const acceptBtn = toastBody.querySelector("button[data-act='0']");
                const rejectBtn = toastBody.querySelector("button[data-act='1']");
                const toastEl = toastBody.closest('.toast');
                const bsToast = toastEl ? bootstrap.Toast.getOrCreateInstance(toastEl) : null;

                if (acceptBtn) {
                    acceptBtn.onclick = () => {
                        this.acceptBatch(conn, files, batchId);
                        if (bsToast) bsToast.hide();
                    };
                }
                if (rejectBtn) {
                    rejectBtn.onclick = () => {
                        this.rejectBatch(conn, files, batchId);
                        if (bsToast) bsToast.hide();
                    };
                }
            }
        }, 100);
    },

    /**
     * Accept batch of files
     * @param {Object} conn - Connection
     * @param {Array} files - File metadata
     * @param {string} batchId - Batch ID
     */
    acceptBatch(conn, files, batchId) {
        files.forEach(f => {
            conn.send({ type: 'file-accept', fileId: f.fileId });
            conn._incoming = conn._incoming || {};
            conn._incoming[f.fileId] = {
                chunks: [],
                size: 0,
                meta: f,
                startTime: Date.now()
            };
            
            // Create progress indicator
            if (CONFIG.ui.showTransferProgress) {
                const progressEl = UI.createFileProgress(f.fileId, f.name, f.size);
                UI.elements.incomingArea?.appendChild(progressEl);
            }
        });
        
        UI.setFileStatus(`Receiving ${files.length} file${files.length > 1 ? 's' : ''}`);
        UI.setFileLoading(true);
        UI.addLog(`Accepted batch ${batchId} from ${conn.peer}`);
    },

    /**
     * Reject batch of files
     * @param {Object} conn - Connection
     * @param {Array} files - File metadata
     * @param {string} batchId - Batch ID
     */
    rejectBatch(conn, files, batchId) {
        files.forEach(f => {
            conn.send({ type: 'file-reject', fileId: f.fileId });
        });
        UI.addLog(`Rejected batch ${batchId} from ${conn.peer}`);
    },

    /**
     * Handle incoming file chunk
     * @param {Object} conn - Connection
     * @param {Object} data - Chunk data
     */
    handleFileChunk(conn, data) {
        const id = data.fileId;
        let chunk = data.chunk;
        const pin = conn._incoming && conn._incoming[id];
        
        if (!pin) return;
        
        // Convert chunk to ArrayBuffer if needed
        if (!(chunk instanceof ArrayBuffer)) {
            if (chunk.data) {
                chunk = new Uint8Array(chunk.data).buffer;
            }
        }
        
        pin.chunks.push(chunk);
        pin.size += (chunk.byteLength || chunk.length || 0);
        
        // Update progress
        if (CONFIG.ui.showTransferProgress) {
            const elapsed = (Date.now() - pin.startTime) / 1000; // seconds
            const speed = elapsed > 0 ? pin.size / elapsed : 0;
            UI.updateFileProgress(id, pin.size, pin.meta.size, speed);
        }
    },

    /**
     * Handle file transfer end
     * @param {Object} conn - Connection
     * @param {Object} data - End data
     */
    handleFileEnd(conn, data) {
        const id = data.fileId;
        const p = conn._incoming && conn._incoming[id];
        if (!p) return;
        
        const blob = new Blob(p.chunks);
        UI.addDownloadLink(p.meta.name, blob);
        UI.setFileStatus('Received: ' + p.meta.name);
        UI.addLog('Received file ' + p.meta.name + ' from ' + conn.peer);
        
        // Clean up
        delete conn._incoming[id];
        UI.removeFileProgress(id);
        UI.setFileLoading(false);
        
        // Update batch status
        const batchId = p.meta.batchId || ('single_' + id);
        if (this.incomingBatchStatus[batchId]) {
            this.incomingBatchStatus[batchId].received++;
            if (this.incomingBatchStatus[batchId].received >= this.incomingBatchStatus[batchId].expected) {
                delete this.incomingBatchStatus[batchId];
            }
        }
    },

    /**
     * Handle file accept response
     * @param {Object} conn - Connection
     * @param {Object} data - Accept data
     */
    handleFileAccept(conn, data) {
        const meta = this.pendingFiles[data.fileId];
        if (meta) {
            UI.addLog('Peer accepted file: ' + data.fileId + ' -> sending chunks to ' + conn.peer);
            this.sendFileChunks(conn, meta);
        }
    },

    /**
     * Handle file reject response
     * @param {Object} conn - Connection
     * @param {Object} data - Reject data
     */
    handleFileReject(conn, data) {
        UI.setFileStatus('Receiver rejected the file');
        UI.addLog('Peer rejected file ' + data.fileId);
        delete this.pendingFiles[data.fileId];
    },

    /**
     * Process files for sending
     * @param {FileList|Array} files - Files to send
     */
    processFiles(files) {
        const fileArray = Array.from(files);
        const validFiles = [];
        const errors = [];

        // Validate files
        for (const file of fileArray) {
            // Check file size
            const sizeCheck = Utils.validateFileSize(file, CONFIG.fileTransfer.maxFileSize);
            if (!sizeCheck.valid) {
                errors.push(`${file.name}: ${sizeCheck.reason}`);
                continue;
            }

            // Check file type
            const typeCheck = Utils.validateFileType(
                file,
                CONFIG.fileTransfer.allowedFileTypes,
                CONFIG.fileTransfer.blockedFileTypes
            );
            if (!typeCheck.valid) {
                errors.push(`${file.name}: ${typeCheck.reason}`);
                continue;
            }

            validFiles.push(file);
        }

        // Show errors if any
        if (errors.length > 0) {
            UI.showToast({
                title: 'File Validation Errors',
                msg: errors.join('<br>'),
                autohide: true,
                delay: 8000
            });
        }

        if (validFiles.length === 0) return;

        // Check batch limit
        if (validFiles.length > CONFIG.fileTransfer.maxFilesPerBatch) {
            UI.showToast({
                title: 'Too Many Files',
                msg: `Maximum ${CONFIG.fileTransfer.maxFilesPerBatch} files per batch`,
                autohide: true
            });
            return;
        }

        // Send files
        this.sendFiles(validFiles);
    },

    /**
     * Send files to peers
     * @param {Array} files - File array
     */
    sendFiles(files) {
        const batchId = Utils.uid(8);
        UI.setFileStatus(`Offering ${files.length} file${files.length > 1 ? 's' : ''}`);
        UI.addLog(`Offering ${files.length} files as batch ${batchId}`);

        for (const file of files) {
            const id = 'f_' + Utils.uid(8);
            const sanitizedName = CONFIG.security.sanitizeFileNames 
                ? Utils.sanitizeFileName(file.name) 
                : file.name;
            
            this.pendingFiles[id] = {
                file: file,
                meta: {
                    fileId: id,
                    name: sanitizedName,
                    size: file.size,
                    batchId: batchId
                }
            };
            
            WebRTC.broadcast({
                type: 'file-meta',
                fileId: id,
                name: sanitizedName,
                size: file.size,
                batchId: batchId
            });
        }
    },

    /**
     * Send file chunks to connection
     * @param {Object} conn - Connection
     * @param {Object} fmeta - File metadata
     */
    async sendFileChunks(conn, fmeta) {
        const file = fmeta.file;
        const chunkSize = CONFIG.fileTransfer.chunkSize;
        const total = file.size;
        let offset = 0;
        const reader = new FileReader();
        const startTime = Date.now();
        let lastUpdate = startTime;

        // Create progress indicator
        if (CONFIG.ui.showTransferProgress) {
            const progressEl = UI.createFileProgress(fmeta.meta.fileId, fmeta.meta.name, total);
            UI.elements.incomingArea?.appendChild(progressEl);
        }

        const readSlice = (o) => {
            const slice = file.slice(o, o + chunkSize);
            reader.readAsArrayBuffer(slice);
        };

        reader.onload = async (e) => {
            const buf = e.target.result;
            
            if (!conn.open) {
                UI.addLog('Connection closed during file send');
                UI.removeFileProgress(fmeta.meta.fileId);
                return;
            }

            try {
                conn.send({
                    type: 'file-chunk',
                    fileId: fmeta.meta.fileId,
                    chunk: buf
                });
            } catch (err) {
                UI.addLog('Chunk send error: ' + err);
                UI.removeFileProgress(fmeta.meta.fileId);
                return;
            }

            offset += buf.byteLength;

            // Update progress
            if (CONFIG.ui.showTransferProgress) {
                const now = Date.now();
                const elapsed = (now - startTime) / 1000;
                const speed = elapsed > 0 ? offset / elapsed : 0;
                UI.updateFileProgress(fmeta.meta.fileId, offset, total, speed);
            }

            if (offset < total) {
                // Adaptive delay based on connection quality
                const delay = CONFIG.performance.enableAdaptiveChunkSize
                    ? this.calculateAdaptiveDelay(conn)
                    : CONFIG.fileTransfer.chunkDelay;
                
                await new Promise(r => setTimeout(r, delay));
                readSlice(offset);
            } else {
                // File complete
                conn.send({ type: 'file-end', fileId: fmeta.meta.fileId });
                UI.setFileStatus('Sent: ' + file.name);
                UI.addLog('Sent file ' + file.name);
                UI.removeFileProgress(fmeta.meta.fileId);
                delete this.pendingFiles[fmeta.meta.fileId];
            }
        };

        readSlice(0);
    },

    /**
     * Calculate adaptive delay based on connection quality
     * @param {Object} conn - Connection
     * @returns {number} Delay in milliseconds
     */
    calculateAdaptiveDelay(conn) {
        // Basic implementation - can be enhanced with actual WebRTC stats
        const quality = WebRTC.getConnectionQuality();
        const baseDelay = CONFIG.fileTransfer.chunkDelay;
        
        switch (quality) {
            case 'good':
                return Math.max(10, baseDelay * 0.5);
            case 'medium':
                return baseDelay;
            case 'poor':
                return baseDelay * 2;
            default:
                return baseDelay;
        }
    }
};

