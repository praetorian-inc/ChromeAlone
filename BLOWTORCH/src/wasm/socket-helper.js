// Socket helper to bridge async Direct Sockets API with Go WASM
// This provides callback-based functions that Go can use

window.directSocketHelper = {
    sockets: new Map(),
    nextId: 1,
    writeQueues: new Map(), // Serialize writes per socket to prevent Chrome crashes

    // Create a new TCP socket - callback signature: (error, socketId)
    createSocket(host, port, callback) {
        const id = this.nextId++;

        const socket = new TCPSocket(host, port);

        socket.opened.then(openInfo => {
            this.sockets.set(id, {
                socket: socket,
                reader: openInfo.readable.getReader(),
                writer: openInfo.writable.getWriter(),
                openInfo: openInfo
            });
            // Initialize write queue for this socket
            this.writeQueues.set(id, { queue: [], processing: false });
            // Defer callback to next tick for WASM safety
            setTimeout(() => {
                callback(null, id); // Success: (error=null, socketId)
            }, 0);
        }).catch(err => {
            // Defer callback to next tick for WASM safety
            setTimeout(() => {
                callback(err.message || 'Connection failed', null); // Error: (error, socketId=null)
            }, 0);
        });
    },

    // Read data from socket - callback signature: (error, data)
    async readSocket(id, callback) {
        const conn = this.sockets.get(id);
        if (!conn) {
            setTimeout(() => {
                callback('Socket closed', null);
            }, 0);
            return;
        }

        try {
            const { value, done } = await conn.reader.read();
            if (done) {
                setTimeout(() => {
                    callback('EOF', null); // EOF - Go will interpret this as io.EOF
                }, 0);
            } else {
                setTimeout(() => {
                    callback(null, value); // Success: (error=null, Uint8Array)
                }, 0);
            }
        } catch (err) {
            // Remove socket on read error to prevent further operations
            this.sockets.delete(id);
            setTimeout(() => {
                callback(err.message || 'Read failed', null);
            }, 0);
        }
    },

    // Write data to socket - callback signature: (error, success)
    // CRITICAL: Queue writes to prevent overwhelming Chrome's Direct Sockets
    writeSocket(id, data, callback) {
        const queue = this.writeQueues.get(id);
        if (!queue) {
            setTimeout(() => {
                callback('Socket closed', null);
            }, 0);
            return;
        }

        // Add to queue
        queue.queue.push({ data, callback });

        // Process queue if not already processing
        if (!queue.processing) {
            this._processWriteQueue(id);
        }
    },

    async _processWriteQueue(id) {
        const queue = this.writeQueues.get(id);
        const conn = this.sockets.get(id);

        if (!queue || !conn) {
            return;
        }

        queue.processing = true;

        while (queue.queue.length > 0) {
            const { data, callback } = queue.queue.shift();

            try {
                // Wait for writer to be ready (backpressure handling)
                const desiredSize = conn.writer.desiredSize;
                if (desiredSize !== null && desiredSize <= 0) {
                    console.warn(`[DirectSocket ${id}] Backpressure detected, waiting... (queue: ${queue.queue.length})`);
                    await Promise.race([
                        conn.writer.ready,
                        new Promise((_, reject) => setTimeout(() => reject(new Error('Backpressure timeout')), 5000))
                    ]);
                }

                // Perform the write
                await Promise.race([
                    conn.writer.write(data),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('Write timeout')), 5000))
                ]);

                // Success callback
                setTimeout(() => {
                    callback(null, true);
                }, 0);

            } catch (err) {
                console.error(`[DirectSocket ${id}] Write error: ${err.message}`);
                // Error callback
                setTimeout(() => {
                    callback(err.message || 'Write failed', null);
                }, 0);

                // On error, fail all remaining writes in queue
                while (queue.queue.length > 0) {
                    const { callback: failCallback } = queue.queue.shift();
                    setTimeout(() => {
                        failCallback('Socket error', null);
                    }, 0);
                }

                // Clean up
                this.sockets.delete(id);
                this.writeQueues.delete(id);
                break;
            }
        }

        queue.processing = false;
    },

    // Close socket - callback signature: (error, success)
    async closeSocket(id, callback) {
        const conn = this.sockets.get(id);
        if (!conn) {
            setTimeout(() => {
                callback(null, true); // Already closed
            }, 0);
            return;
        }

        // CRITICAL: Wait for write queue to drain before closing
        const queue = this.writeQueues.get(id);
        if (queue && (queue.processing || queue.queue.length > 0)) {
            console.log(`[DirectSocket ${id}] Waiting for ${queue.queue.length} pending writes to complete before closing...`);

            // Wait for queue to drain (with timeout)
            const startTime = Date.now();
            while ((queue.processing || queue.queue.length > 0) && (Date.now() - startTime < 3000)) {
                await new Promise(resolve => setTimeout(resolve, 10));
            }

            if (queue.processing || queue.queue.length > 0) {
                console.warn(`[DirectSocket ${id}] Timeout waiting for writes to drain, forcing close`);
            } else {
                console.log(`[DirectSocket ${id}] All writes completed, proceeding with close`);
            }
        }

        // Remove from maps to prevent new operations
        this.sockets.delete(id);
        this.writeQueues.delete(id);

        try {
            // Cancel reader first (this will reject any pending read())
            // Only cancel if reader is locked (active)
            if (conn.reader.locked) {
                try {
                    await Promise.race([
                        conn.reader.cancel(),
                        new Promise((_, reject) => setTimeout(() => reject(new Error('Reader cancel timeout')), 1000))
                    ]);
                } catch (e) {
                    console.debug(`[DirectSocket ${id}] Reader cancel failed: ${e.message}`);
                }
            }

            // Abort writer (this will reject any pending write())
            // Only abort if writer is locked (active)
            if (conn.writer.locked) {
                try {
                    await Promise.race([
                        conn.writer.abort(),
                        new Promise((_, reject) => setTimeout(() => reject(new Error('Writer abort timeout')), 1000))
                    ]);
                } catch (e) {
                    console.debug(`[DirectSocket ${id}] Writer abort failed: ${e.message}`);
                }
            }

            // Close the socket - this will release locks automatically
            try {
                await Promise.race([
                    conn.socket.close(),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('Socket close timeout')), 2000))
                ]);
            } catch (e) {
                console.debug(`[DirectSocket ${id}] Socket close failed: ${e.message}`);
            }

            setTimeout(() => {
                callback(null, true); // Success: (error=null, success=true)
            }, 0);
        } catch (err) {
            console.error(`[DirectSocket ${id}] Close error: ${err.message}`);
            setTimeout(() => {
                callback(err.message || 'Close failed', null);
            }, 0);
        }
    }
};
