// +build js,wasm

package main

import (
	"errors"
	"fmt"
	"io"
	"net"
	"sync"
	"syscall/js"
	"time"
)

// DirectSocket implements net.Conn using Chrome's Direct Sockets API
type DirectSocket struct {
	socketID   int
	readBuffer []byte
	closed     bool
	closeMu    sync.RWMutex // Protects closed flag and socketID
}

// NewDirectSocket creates a new socket connection using Direct Sockets API
func NewDirectSocket(network, address string) (*DirectSocket, error) {
	if network != "tcp" && network != "tcp4" && network != "tcp6" {
		return nil, errors.New("only tcp network is supported")
	}

	// Parse address (host:port)
	host, portStr, err := net.SplitHostPort(address)
	if err != nil {
		return nil, err
	}

	// Convert port to integer
	var port int
	if _, err := fmt.Sscanf(portStr, "%d", &port); err != nil {
		return nil, fmt.Errorf("invalid port: %v", err)
	}

	helper := js.Global().Get("directSocketHelper")
	if !helper.Truthy() {
		return nil, errors.New("directSocketHelper not available")
	}

	var wg sync.WaitGroup
	wg.Add(1)

	var socketID int = -1
	var connectErr error

	// Callback for async connection
	callback := js.FuncOf(func(this js.Value, args []js.Value) interface{} {
		defer wg.Done()

		// Args: (error, socketId)
		if len(args) > 0 && !args[0].IsNull() {
			// Error case
			connectErr = errors.New(args[0].String())
		} else if len(args) > 1 {
			// Success case
			socketID = args[1].Int()
		}

		return nil
	})
	defer callback.Release()

	// Call async JS function
	helper.Call("createSocket", host, port, callback)

	// Wait for callback - WaitGroup properly yields to JS event loop
	wg.Wait()

	if connectErr != nil {
		return nil, connectErr
	}

	if socketID == -1 {
		return nil, errors.New("failed to get socket ID")
	}

	ds := &DirectSocket{
		socketID:   socketID,
		readBuffer: make([]byte, 0),
		closed:     false,
	}

	return ds, nil
}

// Read implements net.Conn
func (ds *DirectSocket) Read(b []byte) (n int, err error) {
	ds.closeMu.RLock()
	closed := ds.closed
	socketID := ds.socketID
	ds.closeMu.RUnlock()

	if closed {
		return 0, io.EOF
	}

	if socketID == -1 {
		return 0, errors.New("socket not connected")
	}

	// If we have data in buffer, return it first
	if len(ds.readBuffer) > 0 {
		n = copy(b, ds.readBuffer)
		ds.readBuffer = ds.readBuffer[n:]
		return n, nil
	}

	helper := js.Global().Get("directSocketHelper")

	var wg sync.WaitGroup
	wg.Add(1)

	var readData []byte
	var readErr error

	callback := js.FuncOf(func(this js.Value, args []js.Value) interface{} {
		defer wg.Done()

		// Args: (error, data)
		if len(args) > 0 && !args[0].IsNull() {
			// Error case (could be EOF or actual error)
			errMsg := args[0].String()
			if errMsg == "EOF" {
				readErr = io.EOF
			} else {
				readErr = errors.New(errMsg)
			}
		} else if len(args) > 1 && !args[1].IsNull() {
			// Success case - got Uint8Array
			value := args[1]
			length := value.Get("length").Int()
			data := make([]byte, length)
			js.CopyBytesToGo(data, value)
			readData = data
		} else {
			// No data, must be EOF
			readErr = io.EOF
		}

		return nil
	})
	defer callback.Release()

	helper.Call("readSocket", socketID, callback)

	wg.Wait()

	if readErr != nil {
		return 0, readErr
	}

	// Copy data to buffer and return what fits
	n = copy(b, readData)
	if n < len(readData) {
		ds.readBuffer = readData[n:]
	}

	return n, nil
}

// Write implements net.Conn
func (ds *DirectSocket) Write(b []byte) (n int, err error) {
	ds.closeMu.RLock()
	closed := ds.closed
	socketID := ds.socketID
	ds.closeMu.RUnlock()

	if closed {
		return 0, errors.New("socket closed")
	}

	if socketID == -1 {
		return 0, errors.New("socket not connected")
	}

	helper := js.Global().Get("directSocketHelper")

	// Create Uint8Array from Go bytes
	uint8Array := js.Global().Get("Uint8Array").New(len(b))
	js.CopyBytesToJS(uint8Array, b)

	var wg sync.WaitGroup
	wg.Add(1)

	var writeErr error

	callback := js.FuncOf(func(this js.Value, args []js.Value) interface{} {
		defer wg.Done()

		// Args: (error, success)
		if len(args) > 0 && !args[0].IsNull() {
			// Error case
			writeErr = errors.New(args[0].String())
		}

		return nil
	})
	defer callback.Release()

	helper.Call("writeSocket", socketID, uint8Array, callback)

	wg.Wait()

	if writeErr != nil {
		return 0, writeErr
	}

	return len(b), nil
}

// Close implements net.Conn
func (ds *DirectSocket) Close() error {
	ds.closeMu.Lock()
	if ds.closed {
		socketID := ds.socketID
		ds.closeMu.Unlock()
		fmt.Printf("[DirectSocket] Close called on already-closed socket %d\n", socketID)
		return nil
	}
	ds.closed = true
	socketID := ds.socketID
	ds.closeMu.Unlock()

	if socketID == -1 {
		return nil
	}

	helper := js.Global().Get("directSocketHelper")

	var wg sync.WaitGroup
	wg.Add(1)

	callback := js.FuncOf(func(this js.Value, args []js.Value) interface{} {
		defer wg.Done()
		// Don't care about errors on close
		return nil
	})
	defer callback.Release()

	helper.Call("closeSocket", socketID, callback)

	wg.Wait()

	return nil
}

// LocalAddr implements net.Conn
func (ds *DirectSocket) LocalAddr() net.Addr {
	return &net.TCPAddr{}
}

// RemoteAddr implements net.Conn
func (ds *DirectSocket) RemoteAddr() net.Addr {
	return &net.TCPAddr{}
}

// SetDeadline implements net.Conn
func (ds *DirectSocket) SetDeadline(t time.Time) error {
	// Not implemented for Direct Sockets
	return nil
}

// SetReadDeadline implements net.Conn
func (ds *DirectSocket) SetReadDeadline(t time.Time) error {
	// Not implemented for Direct Sockets
	return nil
}

// SetWriteDeadline implements net.Conn
func (ds *DirectSocket) SetWriteDeadline(t time.Time) error {
	// Not implemented for Direct Sockets
	return nil
}
