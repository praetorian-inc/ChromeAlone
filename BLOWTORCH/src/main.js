import { wasmReady } from './wasm-loader.js';  // Load WASM module first
import { startProxy, stopProxy, getRelayServer } from './app.js';
import {FirecrackerWebSocketServer, initializeFirecrackerServer, getFirecrackerServer} from'./websocket-server.js';

let firecrackerServer = null;

// Use a global flag to prevent double initialization across module reloads
if (typeof window.__BLOWTORCH_INITIALIZED__ === 'undefined') {
    window.__BLOWTORCH_INITIALIZED__ = false;
}

// Firecracker logging callback that outputs to main console
function firecrackerLogCallback(message, ...args) {
    console.log(message, ...args);
}

// Export getFirecrackerServer for external access
export function getFirecrackerServerInstance() {
    return firecrackerServer || getFirecrackerServer();
}

async function initializeApp() {
    if (window.__BLOWTORCH_INITIALIZED__) {
        console.log("App already initialized, skipping...");
        return;
    }
    window.__BLOWTORCH_INITIALIZED__ = true;

    console.log("Initializing app...");

    // Wait for WASM to be ready (or timeout after a reasonable period)
    console.log("Waiting for WASM module to load...");
    const wasmAvailable = await wasmReady;
    if (wasmAvailable) {
        console.log("✓ WASM module loaded and ready");
    } else {
        console.log("⚠ WASM not available, using standard WebSocket");
    }

    const startButton = document.getElementById('startProxy');
    const stopButton = document.getElementById('stopProxy');

    if (startButton && stopButton) {
        startButton.removeEventListener('click', startProxy);
        stopButton.removeEventListener('click', stopProxy);

        startButton.addEventListener('click', startProxy);
        stopButton.addEventListener('click', stopProxy);

        await startProxy();
        firecrackerServer = await initializeFirecrackerServer(firecrackerLogCallback);
    }
}

// Expose functions globally for devtools access
window.getFirecrackerServerInstance = getFirecrackerServerInstance;
window.broadcastToFirecracker = async function(message) {
    const server = getFirecrackerServerInstance();
    if (server && server.clientConnections) {
        let sent = 0;
        for (const [connectionId, connectionInfo] of server.clientConnections) {
            if (connectionInfo.isWebSocket) {
                await server.sendWebSocketMessage(connectionInfo, message);
                sent++;
            }
        }
        console.log(`Broadcast sent to ${sent} WebSocket connections`);
        return sent;
    } else {
        console.log("Server not available or no connections");
        return 0;
    }
};

window.getRelayServer = getRelayServer;

// Wait for DOM to be ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeApp);
} else {
    initializeApp();
}