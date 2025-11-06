import { SocksServer } from './socks-server.js';
import { isWASMWebSocketAvailable, configureWASMWebSocket } from './wasm-bridge.js';

let socksServer = null;

export async function startProxy() {
    try {
        console.log("=".repeat(80));
        console.log("BLOWTORCH - Starting Proxy");
        console.log("=".repeat(80));

        // Use environment variables injected by webpack
        const wsUrl = "wss://" + process.env.WS_DOMAIN + ":443";
        const relayToken = process.env.RELAY_TOKEN;
        const frontDomain = process.env.FRONT_DOMAIN || '';
        const targetHost = process.env.TARGET_HOST || '';

        console.log(`Relay Server: ${wsUrl}`);
        console.log(`Relay Token: ${relayToken.substring(0, 8)}...`);

        // Configure domain fronting if environment variables are set
        if (frontDomain) {
            console.log(`Domain Fronting: ENABLED`);
            console.log(`  Connect to: ${frontDomain}`);
            console.log(`  Host header: ${targetHost || process.env.WS_DOMAIN}`);
            configureWASMWebSocket({
                frontDomain: frontDomain,
                targetHost: targetHost
            });
        } else {
            console.log('Domain Fronting: DISABLED (using standard connection)');
        }

        if (socksServer) {
            console.log("Stopping existing proxy...");
            socksServer.stop();
        }

        // Check if WASM WebSocket is available
        const useWASM = isWASMWebSocketAvailable();
        console.log("-".repeat(80));
        console.log(`WebSocket Implementation: ${useWASM ? 'WASM (Direct Sockets)' : 'STANDARD (Browser WebSocket)'}`);

        if (useWASM && frontDomain) {
            console.log(`Connection will be established to: ${frontDomain}:443`);
            console.log(`HTTP Host header will be: ${targetHost || process.env.WS_DOMAIN}`);
        } else if (!useWASM) {
            console.log(`Connection will be established to: ${process.env.WS_DOMAIN}:443`);
        }
        console.log("-".repeat(80));

        socksServer = new SocksServer(
            {
                "websocketUrl": wsUrl,
                "relayToken": relayToken,
                "useWASM": useWASM
            }
        );
        updateStatus(`Creating WS Relay connection...`);
        await socksServer.start();
        console.log("✓ Proxy started successfully");
    } catch (err) {
        console.error("✗ Failed to start proxy:", err);
        updateStatus(`Failed to start proxy: ${err.message}`);
    }
}

export function stopProxy() {
    if (socksServer) {
        socksServer.stop();
        socksServer = null;
        updateStatus('Proxy server stopped');
    }
}

export function getRelayServer() {
    return socksServer;
}

function updateStatus(message) {
    const statusElement = document.getElementById('status');
    if (statusElement) {
        statusElement.textContent = message;
    }
} 