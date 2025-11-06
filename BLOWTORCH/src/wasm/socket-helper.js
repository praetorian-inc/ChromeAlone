// Socket helper to bridge async Direct Sockets API with Go WASM
// This provides callback-based functions that Go can use

window.directSocketHelper = {
    sockets: new Map(),
    nextId: 1,

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
            callback(null, id); // Success: (error=null, socketId)
        }).catch(err => {
            callback(err.message || 'Connection failed', null); // Error: (error, socketId=null)
        });
    },

    // Read data from socket - callback signature: (error, data)
    async readSocket(id, callback) {
        const conn = this.sockets.get(id);
        if (!conn) {
            callback('Socket not found', null);
            return;
        }

        try {
            const { value, done } = await conn.reader.read();
            if (done) {
                callback('EOF', null); // EOF - Go will interpret this as io.EOF
            } else {
                callback(null, value); // Success: (error=null, Uint8Array)
            }
        } catch (err) {
            callback(err.message || 'Read failed', null);
        }
    },

    // Write data to socket - callback signature: (error, success)
    async writeSocket(id, data, callback) {
        const conn = this.sockets.get(id);
        if (!conn) {
            callback('Socket not found', null);
            return;
        }

        try {
            await conn.writer.write(data);
            callback(null, true); // Success: (error=null, success=true)
        } catch (err) {
            callback(err.message || 'Write failed', null);
        }
    },

    // Close socket - callback signature: (error, success)
    async closeSocket(id, callback) {
        const conn = this.sockets.get(id);
        if (!conn) {
            callback(null, true); // Already closed
            return;
        }

        try {
            await conn.reader.releaseLock();
            await conn.writer.releaseLock();
            await conn.socket.close();
            this.sockets.delete(id);
            callback(null, true); // Success: (error=null, success=true)
        } catch (err) {
            callback(err.message || 'Close failed', null);
        }
    }
};
