/**
 * WASM WebSocket Bridge
 *
 * This module provides a bridge between the Go WASM WebSocket implementation
 * and JavaScript, making it compatible with the existing socks-server.js code.
 */

export class WASMWebSocket {
    constructor(url, protocols) {
        this.url = url;
        this.protocols = protocols || [];
        this.readyState = WASMWebSocket.CONNECTING;

        // Event handlers (compatible with standard WebSocket API)
        this.onopen = null;
        this.onmessage = null;
        this.onclose = null;
        this.onerror = null;

        this._wasmConnection = null;
        this._config = this._parseConfig(url, protocols);

        // Initialize the WASM connection
        this._connect();
    }

    _parseConfig(url, protocols) {
        const config = {
            url: url,
            frontDomain: '',
            targetHost: '',
            relayToken: '',
            insecureSkipVerify: true
        };

        // Extract relay token from protocols (token.XXXXX format)
        if (Array.isArray(protocols)) {
            for (const protocol of protocols) {
                if (protocol.startsWith('token.')) {
                    config.relayToken = protocol.substring(6);
                    break;
                }
            }
        }

        // Check for domain fronting configuration in environment or config
        // Domain fronting is OPTIONAL - only use if explicitly configured
        if (window.WASM_WS_FRONT_DOMAIN) {
            config.frontDomain = window.WASM_WS_FRONT_DOMAIN;

            // If frontDomain is set, use targetHost override if provided
            // Otherwise, it will default to the URL host in the WASM layer
            if (window.WASM_WS_TARGET_HOST) {
                config.targetHost = window.WASM_WS_TARGET_HOST;
            }
        }
        // If no domain fronting, leave frontDomain empty
        // The WASM layer will use the URL host for both connection and Host header

        return config;
    }

    async _connect() {
        try {
            // Check if WASM is loaded
            if (typeof window.createWASMWebSocket !== 'function') {
                throw new Error('WASM WebSocket not loaded. Make sure relay-client.wasm is loaded.');
            }

            console.log('[WASM-Bridge] Creating WASM WebSocket connection');
            console.log('[WASM-Bridge] Config:', {
                url: this._config.url,
                frontDomain: this._config.frontDomain || '(none)',
                targetHost: this._config.targetHost,
                hasToken: !!this._config.relayToken
            });

            // Create the WASM WebSocket connection
            // This returns a connection ID that we'll use to interact with the WASM side
            this._connectionId = await window.createWASMWebSocket(
                this._config.url,
                this._config.frontDomain,
                this._config.targetHost,
                this._config.relayToken,
                this._config.insecureSkipVerify
            );

            // Set up message handler
            window.wasmWebSocketMessageHandlers = window.wasmWebSocketMessageHandlers || {};
            window.wasmWebSocketMessageHandlers[this._connectionId] = (data) => {
                if (this.onmessage) {
                    this.onmessage({ data: data });
                }
            };

            // Set up close handler
            window.wasmWebSocketCloseHandlers = window.wasmWebSocketCloseHandlers || {};
            window.wasmWebSocketCloseHandlers[this._connectionId] = () => {
                this.readyState = WASMWebSocket.CLOSED;
                if (this.onclose) {
                    this.onclose({ code: 1000, reason: 'Normal closure' });
                }
            };

            // Set up error handler
            window.wasmWebSocketErrorHandlers = window.wasmWebSocketErrorHandlers || {};
            window.wasmWebSocketErrorHandlers[this._connectionId] = (error) => {
                this.readyState = WASMWebSocket.CLOSED;
                if (this.onerror) {
                    this.onerror({ error: error });
                }
            };

            // Connection successful
            this.readyState = WASMWebSocket.OPEN;
            console.log('[WASM-Bridge] Connection established');

            if (this.onopen) {
                this.onopen({});
            }

        } catch (error) {
            console.error('[WASM-Bridge] Connection failed:', error);
            this.readyState = WASMWebSocket.CLOSED;

            if (this.onerror) {
                this.onerror({ error: error.message });
            }

            if (this.onclose) {
                this.onclose({ code: 1006, reason: error.message });
            }
        }
    }

    send(data) {
        if (this.readyState !== WASMWebSocket.OPEN) {
            throw new Error('WebSocket is not open');
        }

        if (typeof window.wasmWebSocketSend !== 'function') {
            throw new Error('WASM WebSocket send function not available');
        }

        try {
            // Call the WASM send function - it returns immediately
            // The actual send happens asynchronously in the write queue
            window.wasmWebSocketSend(this._connectionId, data);
        } catch (error) {
            console.error('[WASM-Bridge] Send error:', error);
            if (this.onerror) {
                this.onerror({ error: error.message });
            }
        }
    }

    // Async send that waits for write completion
    async sendAsync(data) {
        if (this.readyState !== WASMWebSocket.OPEN) {
            throw new Error('WebSocket is not open');
        }

        if (typeof window.wasmWebSocketSendAsync !== 'function') {
            throw new Error('WASM WebSocket sendAsync function not available');
        }

        try {
            // This will wait for the write to actually complete
            await window.wasmWebSocketSendAsync(this._connectionId, data);
        } catch (error) {
            console.error('[WASM-Bridge] Send error:', error);
            if (this.onerror) {
                this.onerror({ error: error.message });
            }
            throw error;
        }
    }

    close(code, reason) {
        if (this.readyState === WASMWebSocket.CLOSED ||
            this.readyState === WASMWebSocket.CLOSING) {
            return;
        }

        this.readyState = WASMWebSocket.CLOSING;

        if (typeof window.wasmWebSocketClose === 'function') {
            window.wasmWebSocketClose(this._connectionId);
        }

        // Clean up handlers
        if (window.wasmWebSocketMessageHandlers) {
            delete window.wasmWebSocketMessageHandlers[this._connectionId];
        }
        if (window.wasmWebSocketCloseHandlers) {
            delete window.wasmWebSocketCloseHandlers[this._connectionId];
        }
        if (window.wasmWebSocketErrorHandlers) {
            delete window.wasmWebSocketErrorHandlers[this._connectionId];
        }

        this.readyState = WASMWebSocket.CLOSED;
    }

    // Ping method for keep-alive (optional, standard WebSocket doesn't have this)
    ping() {
        // WASM WebSocket handles pings automatically in the readLoop
    }
}

// WebSocket ready states (matching standard WebSocket API)
WASMWebSocket.CONNECTING = 0;
WASMWebSocket.OPEN = 1;
WASMWebSocket.CLOSING = 2;
WASMWebSocket.CLOSED = 3;

// Helper function to check if WASM WebSocket is available
export function isWASMWebSocketAvailable() {
    const hasWASM = typeof window.createWASMWebSocket === 'function';
    const hasDirectSockets = typeof window.directSocketHelper !== 'undefined' &&
                              window.directSocketHelper !== null &&
                              typeof window.directSocketHelper.createSocket === 'function';
    const hasTCPSocket = typeof TCPSocket !== 'undefined';

    console.log('[WASM-Bridge] Availability check:', {
        hasWASM,
        hasDirectSockets,
        hasTCPSocket,
        createWASMWebSocket: typeof window.createWASMWebSocket,
        directSocketHelper: typeof window.directSocketHelper
    });

    return hasWASM && hasDirectSockets && hasTCPSocket;
}

// Configuration helpers
export function configureWASMWebSocket(options) {
    if (options.frontDomain) {
        window.WASM_WS_FRONT_DOMAIN = options.frontDomain;
    }
    if (options.targetHost) {
        window.WASM_WS_TARGET_HOST = options.targetHost;
    }
}
