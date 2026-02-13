/**
 * QRShare - Main Application
 * Initializes and coordinates all modules
 */

// Load and merge local config if available (optional, for custom TURN credentials)
(function loadLocalConfig() {
    // Try to load config.local.js if it exists
    // Use a HEAD request first to check if file exists without triggering full 404 error
    fetch('assets/js/config.local.js', { method: 'HEAD' })
        .then(response => {
            if (response.ok) {
                // File exists, fetch the full content
                return fetch('assets/js/config.local.js').then(r => r.ok ? r.text() : null);
            } else {
                // File doesn't exist, use defaults
                return null;
            }
        })
        .then(scriptContent => {
            if (scriptContent) {
                try {
                    // Execute the config script using a blob URL (safer than eval)
                    const blob = new Blob([scriptContent], { type: 'application/javascript' });
                    const url = URL.createObjectURL(blob);
                    const script = document.createElement('script');
                    script.src = url;
                    script.onload = function() {
                        URL.revokeObjectURL(url);
                        mergeConfigOverride();
                        initApp();
                    };
                    script.onerror = function() {
                        URL.revokeObjectURL(url);
                        console.warn('Error executing config.local.js');
                        console.log('Using default configuration.');
                        initApp();
                    };
                    document.head.appendChild(script);
                } catch (e) {
                    console.warn('Error loading config.local.js:', e);
                    console.log('Using default configuration.');
                    initApp();
                }
            } else {
                // No config file, use defaults (this is normal and expected)
                initApp();
            }
        })
        .catch(() => {
            // Error fetching (file doesn't exist - this is normal), use defaults
            initApp();
        });
    
    function mergeConfigOverride() {
        // Merge CONFIG_OVERRIDE if defined
        if (typeof CONFIG_OVERRIDE !== 'undefined' && CONFIG_OVERRIDE && Object.keys(CONFIG_OVERRIDE).length > 0) {
            // Deep merge configuration
            Object.keys(CONFIG_OVERRIDE).forEach(key => {
                if (typeof CONFIG_OVERRIDE[key] === 'object' && !Array.isArray(CONFIG_OVERRIDE[key]) && CONFIG[key]) {
                    Object.assign(CONFIG[key], CONFIG_OVERRIDE[key]);
                } else {
                    CONFIG[key] = CONFIG_OVERRIDE[key];
                }
            });
            console.log('Loaded custom configuration from config.local.js');
        }
    }
    
    function initApp() {
        // Initialize app after config is loaded (or if config doesn't exist)
        // Only log config message once when app initializes
        if (typeof CONFIG_OVERRIDE === 'undefined' || !CONFIG_OVERRIDE || Object.keys(CONFIG_OVERRIDE).length === 0) {
            // Suppress console log - 404 is expected if config.local.js doesn't exist
            // Uncomment the line below if you want to see the message:
            // console.log('Using default configuration. Create config.local.js to customize.');
        }
        
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => App.init());
        } else {
            App.init();
        }
    }
})();

// Application state
const App = {
    room: null,
    link: null,

    /**
     * Initialize application
     */
    init() {
        // Initialize UI
        UI.init();

        // Initialize file transfer
        FileTransfer.init();

        // Get or create room ID
        this.room = Utils.getParam('room') || CONFIG.room.defaultRoomId || Utils.uid(CONFIG.room.idLength);
        this.link = Utils.makeRoomLink(this.room);

        // Setup UI
        this.setupUI();

        // Initialize WebRTC
        this.initWebRTC();

        // Setup event handlers
        this.setupEventHandlers();

        // Setup drag and drop
        UI.setupDragAndDrop((files) => {
            FileTransfer.processFiles(files);
        });

        UI.addLog('Application initialized');
    },

    /**
     * Setup UI elements
     */
    setupUI() {
        // Update QR code
        UI.updateQRCode(this.link);
        UI.updateRoomUrl(this.link);

        // Copy button
        if (UI.elements.copyBtn) {
            UI.elements.copyBtn.addEventListener('click', async () => {
                try {
                    await navigator.clipboard.writeText(this.link);
                    UI.elements.copyBtn.textContent = 'Copied ✓';
                    setTimeout(() => {
                        UI.elements.copyBtn.textContent = 'Copy link';
                    }, 1400);
                } catch (err) {
                    UI.showToast({
                        title: 'Copy Failed',
                        msg: 'Could not copy to clipboard',
                        autohide: true
                    });
                }
            });
        }

        // Regenerate room button
        if (UI.elements.regenBtn) {
            UI.elements.regenBtn.addEventListener('click', () => {
                this.room = Utils.uid(CONFIG.room.idLength);
                this.link = Utils.makeRoomLink(this.room);
                UI.updateQRCode(this.link);
                UI.updateRoomUrl(this.link);
                WebRTC.init(this.room, this.getWebRTCCallbacks());
            });
        }

        // Clear logs button
        if (UI.elements.clearLogsBtn) {
            UI.elements.clearLogsBtn.addEventListener('click', () => {
                UI.clearLogs();
            });
        }
    },

    /**
     * Initialize WebRTC connection
     */
    initWebRTC() {
        WebRTC.init(this.room, this.getWebRTCCallbacks());
    },

    /**
     * Get WebRTC event callbacks
     * @returns {Object} Callbacks object
     */
    getWebRTCCallbacks() {
        return {
            onPeerReady: (id) => {
                UI.addLog('Peer ready: ' + id);
            },

            onConnectionOpen: (conn) => {
                UI.addLog('Connection opened: ' + conn.peer);
            },

            onConnectionClose: (conn) => {
                UI.addLog('Connection closed: ' + conn.peer);
            },

            onData: (conn, data) => {
                this.handleData(conn, data);
            }
        };
    },

    /**
     * Handle incoming data
     * @param {Object} conn - Connection
     * @param {Object} data - Data object
     */
    handleData(conn, data) {
        if (!data || !data.type) return;

        switch (data.type) {
            case 'meta':
                if (data.sub === 'joined') {
                    // Peer announced they joined - ensure mode is updated
                    // Don't log this as it's just a handshake message
                    WebRTC.evaluateMode();
                }
                break;

            case 'chat':
                // Sanitize chat message
                const sanitizedText = Utils.sanitize(data.text);
                if (sanitizedText.length > 0 && sanitizedText.length <= CONFIG.chat.maxMessageLength) {
                    UI.addMessage(sanitizedText, 'them');
                    UI.addLog('Chat from ' + conn.peer + ': ' + sanitizedText);
                }
                break;

            case 'file-meta':
                FileTransfer.handleFileMeta(conn, data);
                break;

            case 'file-chunk':
                FileTransfer.handleFileChunk(conn, data);
                break;

            case 'file-end':
                FileTransfer.handleFileEnd(conn, data);
                break;

            case 'file-accept':
                FileTransfer.handleFileAccept(conn, data);
                break;

            case 'file-reject':
                FileTransfer.handleFileReject(conn, data);
                break;

            default:
                UI.addLog('Unknown data type: ' + data.type);
        }
    },

    /**
     * Setup event handlers
     */
    setupEventHandlers() {
        // Chat send button
        if (UI.elements.sendBtn) {
            UI.elements.sendBtn.addEventListener('click', () => {
                this.sendChatMessage();
            });
        }

        // Chat input enter key
        if (UI.elements.textIn) {
            UI.elements.textIn.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    this.sendChatMessage();
                }
            });
        }

        // File input change
        if (UI.elements.fileInput) {
            UI.elements.fileInput.setAttribute('multiple', 'multiple');
            UI.elements.fileInput.addEventListener('change', (e) => {
                const files = e.target.files;
                if (files && files.length > 0) {
                    FileTransfer.processFiles(files);
                }
                // Reset input
                e.target.value = '';
            });
        }

        // Download link click handler
        if (UI.elements.incomingArea) {
            UI.elements.incomingArea.addEventListener('click', (e) => {
                if (e.target.tagName.toLowerCase() === 'a') {
                    e.target.style.color = 'orange';
                }
            });
        }
    },

    /**
     * Send chat message
     */
    sendChatMessage() {
        if (!UI.elements.textIn) return;

        const text = UI.elements.textIn.value.trim();
        if (!text) return;

        // Validate message length
        if (text.length > CONFIG.chat.maxMessageLength) {
            UI.showToast({
                title: 'Message Too Long',
                msg: `Maximum ${CONFIG.chat.maxMessageLength} characters`,
                autohide: true
            });
            return;
        }

        // Sanitize message
        const sanitizedText = Utils.sanitize(text);

        // Add to UI
        UI.addMessage(sanitizedText, 'me');

        // Broadcast to peers
        WebRTC.broadcast({
            type: 'chat',
            text: sanitizedText
        });

        // Clear input
        UI.elements.textIn.value = '';
        UI.addLog('Sent chat: ' + sanitizedText);
    }
};

// App initialization is handled in loadLocalConfig() above
// to ensure config is loaded before app starts

// Expose for debugging
window.QRShare = {
    App,
    UI,
    WebRTC,
    FileTransfer,
    Utils,
    CONFIG
};

