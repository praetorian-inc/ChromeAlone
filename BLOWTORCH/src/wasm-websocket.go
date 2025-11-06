// +build js,wasm

package main

import (
	"crypto/rand"
	"crypto/tls"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"strings"
	"syscall/js"
	"sync"
	"time"
)

// WebSocketConnection manages a WebSocket connection over Direct Sockets
type WebSocketConnection struct {
	conn          net.Conn
	tlsConn       *tls.Conn
	mu            sync.Mutex
	sendMu        sync.Mutex  // Serialize all sends
	closed        bool
	onMessage     js.Func
	onOpen        js.Func
	onClose       js.Func
	onError       js.Func
	messageQueue  chan []byte
	closeSignal   chan struct{}
	readBuf       []byte      // Buffer for accumulating incomplete messages
	readMu        sync.Mutex  // Serialize reads to prevent frame corruption
}

// WebSocketConfig contains configuration for establishing a WebSocket connection
type WebSocketConfig struct {
	URL              string // WebSocket URL (ws:// or wss://)
	FrontDomain      string // Domain to connect to (for domain fronting)
	TargetHost       string // Host header value
	RelayToken       string // Authentication token
	InsecureSkipVerify bool // Skip TLS verification
}

// NewWebSocketConnection creates a new WebSocket connection using Direct Sockets
func NewWebSocketConnection(config WebSocketConfig) (*WebSocketConnection, error) {
	ws := &WebSocketConnection{
		messageQueue: make(chan []byte, 100),
		closeSignal:  make(chan struct{}),
	}

	// Determine connection details
	useTLS := len(config.URL) >= 6 && config.URL[:6] == "wss://"

	// Extract host from URL
	url := config.URL
	if useTLS {
		url = url[6:] // Remove "wss://"
	} else {
		url = url[5:] // Remove "ws://"
	}

	// Find the host (before first /)
	slashIdx := -1
	for i := 0; i < len(url); i++ {
		if url[i] == '/' {
			slashIdx = i
			break
		}
	}
	var urlHost string
	if slashIdx >= 0 {
		urlHost = url[:slashIdx]
	} else {
		urlHost = url
	}

	// Determine connection and target hosts
	var connectHost, targetHost string
	if config.FrontDomain != "" {
		// Domain fronting mode
		connectHost = config.FrontDomain
		if config.TargetHost != "" {
			targetHost = config.TargetHost
		} else {
			targetHost = urlHost // Use URL host as target if not specified
		}
		fmt.Printf("[WASM-WS] Domain fronting: connecting to %s, Host header: %s\n", connectHost, targetHost)
	} else {
		// Standard mode - connect directly to URL host
		connectHost = urlHost
		targetHost = urlHost
		fmt.Printf("[WASM-WS] Standard mode: connecting to %s\n", connectHost)
	}

	// Add port if not present on connectHost
	if !containsPort(connectHost) {
		if useTLS {
			connectHost += ":443"
		} else {
			connectHost += ":80"
		}
	}

	// Create Direct Socket connection
	conn, err := NewDirectSocket("tcp", connectHost)
	if err != nil {
		return nil, fmt.Errorf("failed to create socket: %v", err)
	}
	ws.conn = conn

	// Wrap with TLS if needed
	if useTLS {
		sniHost := connectHost
		for idx := 0; idx < len(sniHost); idx++ {
			if sniHost[idx] == ':' {
				sniHost = sniHost[:idx]
				break
			}
		}

		tlsConn := tls.Client(conn, &tls.Config{
			ServerName:         sniHost,
			InsecureSkipVerify: config.InsecureSkipVerify,
		})

		if err := tlsConn.Handshake(); err != nil {
			conn.Close()
			return nil, fmt.Errorf("TLS handshake failed: %v", err)
		}

		fmt.Println("[WASM-WS] TLS handshake successful")
		ws.tlsConn = tlsConn
	}

	// Send WebSocket upgrade request
	if err := ws.sendUpgradeRequest(targetHost, config.RelayToken); err != nil {
		ws.Close()
		return nil, fmt.Errorf("upgrade request failed: %v", err)
	}

	// Read upgrade response
	if err := ws.readUpgradeResponse(); err != nil {
		ws.Close()
		return nil, fmt.Errorf("upgrade response failed: %v", err)
	}

	fmt.Println("[WASM-WS] WebSocket connection established")

	// Start reading messages
	go ws.readLoop()

	return ws, nil
}

func (ws *WebSocketConnection) sendUpgradeRequest(targetHost, relayToken string) error {
	wsKey := generateWebSocketKey()

	upgradeRequest := "GET / HTTP/1.1\r\n" +
		"Host: " + targetHost + "\r\n" +
		"Upgrade: websocket\r\n" +
		"Connection: Upgrade\r\n" +
		"Sec-WebSocket-Key: " + wsKey + "\r\n" +
		"Sec-WebSocket-Version: 13\r\n"

	if relayToken != "" {
		upgradeRequest += "Sec-WebSocket-Protocol: token." + relayToken + "\r\n"
	}

	upgradeRequest += "\r\n"

	var conn io.Writer = ws.conn
	if ws.tlsConn != nil {
		conn = ws.tlsConn
	}

	_, err := conn.Write([]byte(upgradeRequest))
	return err
}

func (ws *WebSocketConnection) readUpgradeResponse() error {
	response := make([]byte, 4096)

	var conn io.Reader = ws.conn
	if ws.tlsConn != nil {
		conn = ws.tlsConn
	}

	n, err := conn.Read(response)
	if err != nil {
		return err
	}

	responseStr := string(response[:n])

	// Check for 101 Switching Protocols
	if !strings.Contains(responseStr, "101") || !strings.Contains(responseStr, "Switching Protocols") {
		return fmt.Errorf("upgrade failed: %s", responseStr[:min(200, len(responseStr))])
	}

	return nil
}

func (ws *WebSocketConnection) readLoop() {
	defer func() {
		// Only close if not already closed
		ws.mu.Lock()
		alreadyClosed := ws.closed
		ws.mu.Unlock()

		if !alreadyClosed {
			fmt.Println("[WASM-WS] readLoop exiting, closing connection")
			ws.Close()
		}
	}()

	var conn io.Reader = ws.conn
	if ws.tlsConn != nil {
		conn = ws.tlsConn
	}

	fmt.Println("[WASM-WS] readLoop started")

	for {
		// Read WebSocket frame header
		header := make([]byte, 2)
		if _, err := io.ReadFull(conn, header); err != nil {
			if !ws.closed {
				fmt.Printf("[WASM-WS] Read error: %v\n", err)
				ws.callOnError(err.Error())
				ws.callOnClose()
			}
			return
		}

		// Parse frame
		fin := (header[0] & 0x80) != 0
		opcode := header[0] & 0x0F
		masked := (header[1] & 0x80) != 0
		payloadLen := int(header[1] & 0x7F)

		// Read extended payload length if needed
		if payloadLen == 126 {
			extLen := make([]byte, 2)
			if _, err := io.ReadFull(conn, extLen); err != nil {
				return
			}
			payloadLen = int(binary.BigEndian.Uint16(extLen))
		} else if payloadLen == 127 {
			extLen := make([]byte, 8)
			if _, err := io.ReadFull(conn, extLen); err != nil {
				return
			}
			payloadLen = int(binary.BigEndian.Uint64(extLen))
		}

		// Read masking key if present
		var maskKey []byte
		if masked {
			maskKey = make([]byte, 4)
			if _, err := io.ReadFull(conn, maskKey); err != nil {
				return
			}
		}

		// Read payload
		payload := make([]byte, payloadLen)
		if _, err := io.ReadFull(conn, payload); err != nil {
			return
		}

		// Unmask payload if masked
		if masked {
			for i := 0; i < len(payload); i++ {
				payload[i] ^= maskKey[i%4]
			}
		}

		// Handle frame based on opcode
		switch opcode {
		case 0x1: // Text frame
			if fin {
				ws.callOnMessage(string(payload))
			}
		case 0x2: // Binary frame
			if fin {
				ws.callOnMessage(string(payload))
			}
		case 0x8: // Close frame
			ws.Close()
			return
		case 0x9: // Ping frame
			ws.sendPong(payload)
		case 0xA: // Pong frame
			// Ignore
		}
	}
}

func (ws *WebSocketConnection) sendPong(payload []byte) error {
	ws.mu.Lock()
	defer ws.mu.Unlock()

	if ws.closed {
		return fmt.Errorf("connection closed")
	}

	frame := []byte{0x8A} // FIN + Pong opcode

	// Add payload length
	if len(payload) < 126 {
		frame = append(frame, byte(0x80|len(payload)))
	}

	// Add masking key
	maskKey := make([]byte, 4)
	rand.Read(maskKey)
	frame = append(frame, maskKey...)

	// Add masked payload
	for i := 0; i < len(payload); i++ {
		frame = append(frame, payload[i]^maskKey[i%4])
	}

	var conn io.Writer = ws.conn
	if ws.tlsConn != nil {
		conn = ws.tlsConn
	}

	_, err := conn.Write(frame)
	return err
}

// Send sends a text message over the WebSocket
func (ws *WebSocketConnection) Send(data string) error {
	// Serialize sends - critical for preventing message corruption
	ws.sendMu.Lock()
	defer ws.sendMu.Unlock()

	ws.mu.Lock()
	if ws.closed {
		ws.mu.Unlock()
		return fmt.Errorf("connection closed")
	}
	ws.mu.Unlock()

	payload := []byte(data)
	frame := []byte{0x81} // FIN + Text opcode

	// Add payload length
	payloadLen := len(payload)
	if payloadLen < 126 {
		frame = append(frame, byte(0x80|payloadLen))
	} else if payloadLen < 65536 {
		frame = append(frame, 0xFE)
		frame = append(frame, byte(payloadLen>>8), byte(payloadLen))
	} else {
		frame = append(frame, 0xFF)
		lenBytes := make([]byte, 8)
		binary.BigEndian.PutUint64(lenBytes, uint64(payloadLen))
		frame = append(frame, lenBytes...)
	}

	// Add masking key
	maskKey := make([]byte, 4)
	rand.Read(maskKey)
	frame = append(frame, maskKey...)

	// Add masked payload
	for i := 0; i < len(payload); i++ {
		frame = append(frame, payload[i]^maskKey[i%4])
	}

	var conn io.Writer = ws.conn
	if ws.tlsConn != nil {
		conn = ws.tlsConn
	}

	_, err := conn.Write(frame)
	return err
}

// Close closes the WebSocket connection
func (ws *WebSocketConnection) Close() error {
	ws.mu.Lock()
	defer ws.mu.Unlock()

	if ws.closed {
		return nil
	}

	ws.closed = true

	// Close the signal channel first (only once)
	select {
	case <-ws.closeSignal:
		// Already closed
	default:
		close(ws.closeSignal)
	}

	// Send close frame
	frame := []byte{0x88, 0x80} // FIN + Close opcode + masked
	maskKey := make([]byte, 4)
	rand.Read(maskKey)
	frame = append(frame, maskKey...)

	var conn io.Writer = ws.conn
	if ws.tlsConn != nil {
		conn = ws.tlsConn
	}

	conn.Write(frame)

	if ws.tlsConn != nil {
		ws.tlsConn.Close()
	}
	if ws.conn != nil {
		ws.conn.Close()
	}

	return nil
}

// JavaScript callback helpers
func (ws *WebSocketConnection) callOnMessage(data string) {
	if ws.onMessage.IsUndefined() {
		return
	}
	ws.onMessage.Invoke(js.ValueOf(data))
}

func (ws *WebSocketConnection) callOnOpen() {
	if ws.onOpen.IsUndefined() {
		return
	}
	ws.onOpen.Invoke()
}

func (ws *WebSocketConnection) callOnClose() {
	if ws.onClose.IsUndefined() {
		return
	}
	ws.onClose.Invoke()
}

func (ws *WebSocketConnection) callOnError(err string) {
	if ws.onError.IsUndefined() {
		return
	}
	ws.onError.Invoke(js.ValueOf(err))
}

// Helper functions
func containsPort(host string) bool {
	for i := 0; i < len(host); i++ {
		if host[i] == ':' {
			return true
		}
	}
	return false
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// generateWebSocketKey generates a random WebSocket key for the handshake
func generateWebSocketKey() string {
	key := make([]byte, 16)
	rand.Read(key)
	return base64.StdEncoding.EncodeToString(key)
}

// DirectSocket implements net.Conn using Chrome's Direct Sockets API
type DirectSocket struct {
	socketID   int
	readBuffer []byte
	closed     bool
	readMu     sync.Mutex // Serialize read operations
	writeQueue chan writeRequest
}

type writeRequest struct {
	data   []byte
	result chan error
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
		writeQueue: make(chan writeRequest, 1000), // Large buffer to handle bursts without blocking
	}

	// Start the write worker goroutine
	go ds.writeWorker()

	return ds, nil
}

// Read implements net.Conn
func (ds *DirectSocket) Read(b []byte) (n int, err error) {
	// Serialize read operations - only one read at a time
	ds.readMu.Lock()
	defer ds.readMu.Unlock()

	if ds.closed {
		return 0, io.EOF
	}

	if ds.socketID == -1 {
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

	helper.Call("readSocket", ds.socketID, callback)

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
// Uses a write queue to avoid blocking when readLoop is already blocked on Read
func (ds *DirectSocket) Write(b []byte) (n int, err error) {
	if ds.closed {
		return 0, errors.New("socket closed")
	}

	if ds.socketID == -1 {
		return 0, errors.New("socket not connected")
	}

	// Create a copy of the data since b might be reused by caller
	data := make([]byte, len(b))
	copy(data, b)

	// Queue the write request with no result channel - fire and forget
	req := writeRequest{
		data:   data,
		result: nil, // No result channel - we don't wait for completion
	}

	// Non-blocking send - drop writes if queue is full to prevent deadlock
	select {
	case ds.writeQueue <- req:
		// Successfully queued
	default:
		// Queue is full - this is a flow control issue
		// Return error but don't block
		return 0, errors.New("write queue full - data dropped")
	}

	// Return immediately - write is queued
	return len(data), nil
}

// writeWorker processes write requests sequentially
// This is the only goroutine that blocks on WaitGroup for writes
func (ds *DirectSocket) writeWorker() {
	for req := range ds.writeQueue {
		err := ds.doWrite(req.data)
		// Only send result if there's a result channel (for future use)
		if req.result != nil {
			req.result <- err
			close(req.result)
		}
		// If write failed, log it but continue processing
		if err != nil {
			fmt.Printf("[DirectSocket] Write failed: %v\n", err)
		}
	}
}

// doWrite performs the actual write operation with WaitGroup blocking
func (ds *DirectSocket) doWrite(b []byte) error {
	if ds.closed {
		return errors.New("socket closed")
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

	helper.Call("writeSocket", ds.socketID, uint8Array, callback)

	wg.Wait()

	return writeErr
}

// Close implements net.Conn
func (ds *DirectSocket) Close() error {
	if ds.closed {
		return nil
	}
	ds.closed = true

	// Close the write queue to signal writeWorker to exit
	close(ds.writeQueue)

	if ds.socketID == -1 {
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

	helper.Call("closeSocket", ds.socketID, callback)

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
