// Main application script
const outputEl = document.getElementById('output');

// Capture console output
const originalLog = console.log;
console.log = function(...args) {
    originalLog.apply(console, args);
    outputEl.textContent += args.join(' ') + '\n';
};

const originalError = console.error;
console.error = function(...args) {
    originalError.apply(console, args);
    outputEl.textContent += 'ERROR: ' + args.join(' ') + '\n';
};

// Check if Direct Sockets API is available
if (typeof TCPSocket === 'undefined') {
    console.error('TCPSocket API is not available. This must be run in an Isolated Web App (IWA) context with Direct Sockets API enabled.');
} else {
    console.log('TCPSocket API is available!');
}

// Load and run WASM
const go = new Go();
WebAssembly.instantiateStreaming(fetch('main.wasm'), go.importObject).then((result) => {
    console.log('WASM loaded successfully');
    go.run(result.instance);
}).catch((err) => {
    console.error('Failed to load WASM:', err);
});

// Wire up HTTP button
document.getElementById('makeRequestBtn').addEventListener('click', () => {
    if (typeof makeRequest !== 'undefined') {
        console.log('HTTP Button clicked - making request...');
        makeRequest();
    } else {
        console.error('makeRequest function not available yet');
    }
});

// Wire up WebSocket button
document.getElementById('makeWebSocketBtn').addEventListener('click', () => {
    if (typeof makeWebSocketRequest !== 'undefined') {
        console.log('WebSocket Button clicked - making request...');
        makeWebSocketRequest();
    } else {
        console.error('makeWebSocketRequest function not available yet');
    }
});
