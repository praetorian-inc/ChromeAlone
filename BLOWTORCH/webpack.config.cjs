const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const CopyWebpackPlugin = require('copy-webpack-plugin');
const webpack = require('webpack');
const fs = require("fs");
const dotenv = require('dotenv');

// Load environment variables from .env file
const envPath = path.resolve(process.cwd(), '.env');
let envConfig = {};

// Check if .env file exists before trying to load it
if (fs.existsSync(envPath)) {
  console.log(`Loading environment from: ${envPath}`);
  envConfig = dotenv.parse(fs.readFileSync(envPath));
} else {
  console.warn('No .env file found. Using only environment variables.');
}

// Get private key setup
const privateKeyFile = process.env.KEYFILE || envConfig.KEYFILE || "private.key";
let privateKey;
if (process.env.KEY || envConfig.KEY) {
  privateKey = process.env.KEY || envConfig.KEY;
} else if (fs.existsSync(privateKeyFile)) {
  privateKey = fs.readFileSync(privateKeyFile);
}

// Get relay configuration - prioritize environment variables over .env file
const wsDomain = process.env.WS_DOMAIN || envConfig.WS_DOMAIN;
const relayToken = process.env.RELAY_TOKEN || envConfig.RELAY_TOKEN;
const firecrackerPort = process.env.FIRECRACKER_PORT || envConfig.FIRECRACKER_PORT;
const frontDomain = process.env.FRONT_DOMAIN || envConfig.FRONT_DOMAIN || '';
const targetHost = process.env.TARGET_HOST || envConfig.TARGET_HOST || '';

// Validate required environment variables
if (!wsDomain) {
  console.error('\x1b[31m%s\x1b[0m', 'ERROR: WS_DOMAIN is not defined!');
  console.error('\x1b[33m%s\x1b[0m', 'Please set WS_DOMAIN in your .env file or as an environment variable.');
  console.error('\x1b[33m%s\x1b[0m', 'Example: WS_DOMAIN=your-relay-server.com');
  process.exit(1); // Exit with error code
}

if (!relayToken) {
  console.error('\x1b[31m%s\x1b[0m', 'ERROR: RELAY_TOKEN is not defined!');
  console.error('\x1b[33m%s\x1b[0m', 'Please set RELAY_TOKEN in your .env file or as an environment variable.');
  console.error('\x1b[33m%s\x1b[0m', 'Example: RELAY_TOKEN=your-secret-token');
  process.exit(1); // Exit with error code
}

console.log(`Using WebSocket URL: wss://${wsDomain}:443`);
// Don't log the full token for security reasons
console.log(`Using Relay Token: ${relayToken.substring(0, 8)}...`);
if (firecrackerPort) {
    console.log(`Using FIRECRACKER Port: ${firecrackerPort}`);
}
if (frontDomain) {
    console.log(`Domain Fronting: ${frontDomain} -> ${targetHost || wsDomain}`);
}

// Create the webpack configuration
const config = {
    entry: './src/main.js',
    output: {
        filename: 'bundle.js',
        path: path.resolve(__dirname, 'dist'),
        clean: true
    },
    module: {
        rules: [
            {
                test: /\.js$/,
                exclude: /node_modules/,
                use: {
                    loader: 'babel-loader'
                }
            },
            {
                test: /\.css$/,
                use: ['style-loader', 'css-loader']
            },
            {
                test: /\.wasm$/,
                type: 'asset/resource',
                generator: {
                    filename: '[name][ext]'
                }
            }
        ]
    },
    plugins: [
        new HtmlWebpackPlugin({
            template: 'src/index.html'
        }),
        // Copy wasm_exec.js and socket-helper.js to dist
        new CopyWebpackPlugin({
            patterns: [
                {
                    from: 'src/wasm_exec.js',
                    to: 'wasm_exec.js',
                    noErrorOnMissing: true
                },
                {
                    from: 'src/wasm/socket-helper.js',
                    to: 'socket-helper.js',
                    noErrorOnMissing: true
                }
            ]
        }),
        // Add DefinePlugin to inject environment variables
        new webpack.DefinePlugin({
            'process.env.WS_DOMAIN': JSON.stringify(wsDomain),
            'process.env.RELAY_TOKEN': JSON.stringify(relayToken),
            'process.env.FIRECRACKER_PORT': JSON.stringify(firecrackerPort),
            'process.env.FRONT_DOMAIN': JSON.stringify(frontDomain),
            'process.env.TARGET_HOST': JSON.stringify(targetHost)
        })
    ],
    resolve: {
        extensions: ['.js']
    }
};

// Add shared variables as a non-enumerable property to avoid webpack schema validation
Object.defineProperty(config, 'sharedEnv', {
    enumerable: false,
    value: {
        privateKey,
        privateKeyFile,
        wsDomain,
        relayToken,
        firecrackerPort
    }
});

module.exports = config; 