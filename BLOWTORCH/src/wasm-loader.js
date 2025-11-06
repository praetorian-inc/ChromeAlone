// WASM Loader for BLOWTORCH
// This loads the relay-client.wasm module if available

// Import the WASM file as a bundled resource
import wasmUrl from './relay-client.wasm';

// Use existing promise if already created (prevent double loading)
let wasmReadyResolve;
let wasmReadyReject;

if (window.__BLOWTORCH_WASM_READY__) {
    // Already loading or loaded
    var wasmReady = window.__BLOWTORCH_WASM_READY__;
} else {
    var wasmReady = new Promise((resolve, reject) => {
        wasmReadyResolve = resolve;
        wasmReadyReject = reject;
    });
    window.__BLOWTORCH_WASM_READY__ = wasmReady;
}
export { wasmReady };

// Load WASM module if available
async function loadWASM() {
    // Check if already loading/loaded
    if (window.__BLOWTORCH_WASM_LOADING__) {
        console.log('[WASM-Loader] Already loading, skipping...');
        return;
    }
    window.__BLOWTORCH_WASM_LOADING__ = true;

    console.log('[WASM-Loader] Checking WASM support...');
    console.log(`  Go: ${typeof Go !== 'undefined' ? 'available' : 'NOT FOUND'}`);
    console.log(`  WebAssembly: ${typeof WebAssembly !== 'undefined' ? 'available' : 'NOT FOUND'}`);
    console.log(`  directSocketHelper: ${typeof window.directSocketHelper !== 'undefined' ? 'available' : 'NOT FOUND'}`);
    console.log(`  TCPSocket: ${typeof TCPSocket !== 'undefined' ? 'available' : 'NOT FOUND'}`);

    if (typeof Go === 'undefined' || typeof WebAssembly === 'undefined') {
        console.warn('[WASM-Loader] WASM not supported, will use standard WebSocket');
        wasmReadyResolve(false);
        return;
    }

    try {
        console.log('[WASM-Loader] Loading WASM relay client from:', wasmUrl);
        const go = new Go();

        // Fetch the WASM file from the bundled resource
        const response = await fetch(wasmUrl);
        if (!response.ok) {
            throw new Error(`Failed to fetch WASM: ${response.status} ${response.statusText}`);
        }

        console.log('[WASM-Loader] Fetched WASM, instantiating...');
        const wasmBuffer = await response.arrayBuffer();
        console.log(`[WASM-Loader] WASM size: ${(wasmBuffer.byteLength / 1024 / 1024).toFixed(2)} MB`);

        const result = await WebAssembly.instantiate(wasmBuffer, go.importObject);

        console.log('[WASM-Loader] ✓ WASM module instantiated, starting Go runtime...');
        go.run(result.instance);

        // Wait a bit for Go runtime to register functions
        setTimeout(() => {
            console.log('[WASM-Loader] Go runtime started, checking exports...');
            console.log(`  createWASMWebSocket: ${typeof window.createWASMWebSocket}`);
            console.log(`  wasmWebSocketSend: ${typeof window.wasmWebSocketSend}`);
            console.log(`  wasmWebSocketClose: ${typeof window.wasmWebSocketClose}`);

            if (typeof window.createWASMWebSocket === 'function') {
                console.log('[WASM-Loader] ✓ WASM ready!');
                wasmReadyResolve(true);
            } else {
                console.warn('[WASM-Loader] WASM functions not registered');
                wasmReadyResolve(false);
            }
        }, 100);

    } catch (err) {
        console.error('[WASM-Loader] Failed to load WASM module:', err);
        console.warn('[WASM-Loader] Will fall back to standard WebSocket');
        wasmReadyResolve(false);
    }
}

// Load WASM when script loads
loadWASM();
