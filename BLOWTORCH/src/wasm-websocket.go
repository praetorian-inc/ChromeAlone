//go:build js && wasm
// +build js,wasm

package main

import (
	"crypto/tls"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"sync"
	"syscall/js"
	"time"

	"github.com/gorilla/websocket"
)

// WebSocketConnection manages a WebSocket connection over Direct Sockets
type WebSocketConnection struct {
	conn         net.Conn
	tlsConn      *tls.Conn
	directSocket *DirectSocket   // Keep reference to underlying DirectSocket
	wsConn       *websocket.Conn // Gorilla WebSocket connection
	mu           sync.Mutex
	closed       bool
	connectionID int // Connection ID for routing callbacks
	onMessage    js.Func
	onOpen       js.Func
	onClose      js.Func
	onError      js.Func
	closeSignal  chan struct{}
	writeQueue   chan []byte   // Queue for outgoing messages
	writeDone    chan struct{} // Signals when write goroutine exits
	readQueue    chan string   // Queue for incoming messages (preserve order)
	readDone     chan struct{} // Signals when read dispatcher exits
}

// WebSocketConfig contains configuration for establishing a WebSocket connection
type WebSocketConfig struct {
	URL                string // WebSocket URL (ws:// or wss://)
	FrontDomain        string // Domain to connect to (for domain fronting)
	TargetHost         string // Host header value
	RelayToken         string // Authentication token
	InsecureSkipVerify bool   // Skip TLS verification
}

// NewWebSocketConnection creates a new WebSocket connection using Direct Sockets
func NewWebSocketConnection(config WebSocketConfig) (*WebSocketConnection, error) {
	ws := &WebSocketConnection{
		closeSignal: make(chan struct{}),
		writeQueue:  make(chan []byte, 1000),
		writeDone:   make(chan struct{}),
		readQueue:   make(chan string, 1000),
		readDone:    make(chan struct{}),
	}

	// Parse the WebSocket URL
	parsedURL, err := url.Parse(config.URL)
	if err != nil {
		return nil, fmt.Errorf("invalid URL: %v", err)
	}

	// Determine connection details
	useTLS := parsedURL.Scheme == "wss"
	urlHost := parsedURL.Host

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
	ws.directSocket = conn

	// The connection to use for WebSocket (might be wrapped in TLS)
	var netConn net.Conn = conn

	// Extract SNI host for TLS config
	sniHost := connectHost
	for idx := 0; idx < len(sniHost); idx++ {
		if sniHost[idx] == ':' {
			sniHost = sniHost[:idx]
			break
		}
	}

	// Wrap with TLS if needed
	if useTLS {
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
		netConn = tlsConn
	}

	// Set up headers for WebSocket handshake
	headers := http.Header{}
	headers.Set("Host", targetHost)
	if config.RelayToken != "" {
		headers.Set("Sec-WebSocket-Protocol", "token."+config.RelayToken)
		fmt.Printf("[WASM-WS] Setting relay token header: token.%s\n", config.RelayToken[:8]+"...")
	}

	// Build the WebSocket URL for the upgrade request
	path := parsedURL.Path
	if path == "" {
		path = "/"
	}

	fmt.Printf("[WASM-WS] WebSocket upgrade URL: ws://%s%s\n", targetHost, path)
	fmt.Printf("[WASM-WS] Connection type: TLS=%v\n", useTLS)
	fmt.Println("[WASM-WS] Request headers (before NewClient):")
	for key, values := range headers {
		for _, value := range values {
			fmt.Printf("[WASM-WS]   %s: %s\n", key, value)
		}
	}
	fmt.Println("[WASM-WS] Starting WebSocket handshake...")

	// Use NewClient which performs the WebSocket upgrade on an existing connection
	// Important: Use "ws://" scheme even if we have TLS, because TLS is already handled
	// The netConn is already a TLS connection if needed
	wsURL := &url.URL{
		Scheme: "ws", // Always use ws:// since TLS is already established on netConn
		Host:   targetHost,
		Path:   path,
	}

	fmt.Printf("[WASM-WS] About to call NewClient with URL: %s\n", wsURL.String())
	wsConn, resp, err := websocket.NewClient(netConn, wsURL, headers, 4096, 4096)
	fmt.Printf("[WASM-WS] NewClient returned: err=%v, resp=%v\n", err, resp != nil)
	if err != nil {
		fmt.Printf("[WASM-WS] WebSocket handshake failed: %v\n", err)
		if resp != nil {
			fmt.Printf("[WASM-WS] Response status: %d %s\n", resp.StatusCode, resp.Status)
			fmt.Println("[WASM-WS] Response headers:")
			for key, values := range resp.Header {
				for _, value := range values {
					fmt.Printf("[WASM-WS]   %s: %s\n", key, value)
				}
			}
			// Try to read response body for debugging
			if resp.Body != nil {
				buf := make([]byte, 1024)
				if n, readErr := resp.Body.Read(buf); readErr == nil || readErr == io.EOF {
					if n > 0 {
						fmt.Printf("[WASM-WS] Response body: %s\n", string(buf[:n]))
					}
				}
				resp.Body.Close()
			}
		}
		conn.Close()
		return nil, fmt.Errorf("WebSocket handshake failed: %v", err)
	}
	if resp != nil {
		fmt.Printf("[WASM-WS] WebSocket handshake response: %d %s\n", resp.StatusCode, resp.Status)
		fmt.Println("[WASM-WS] Response headers:")
		for key, values := range resp.Header {
			for _, value := range values {
				fmt.Printf("[WASM-WS]   %s: %s\n", key, value)
			}
		}
		resp.Body.Close()
	}

	ws.wsConn = wsConn
	fmt.Println("[WASM-WS] WebSocket connection established")

	// Configure pong handler (just for logging)
	wsConn.SetPongHandler(func(appData string) error {
		fmt.Println("[WASM-WS] Received pong")
		return nil
	})

	// Start read and write loops
	go ws.readLoop()
	go ws.writeLoop()

	// Start message dispatcher that calls JS callbacks in order
	go ws.messageDispatcher()

	// Start ping sender to keep connection alive (Cloud Run has 5min idle timeout)
	go ws.pingLoop()

	return ws, nil
}

func (ws *WebSocketConnection) readLoop() {
	defer func() {
		close(ws.readQueue) // Signal dispatcher to exit

		// Only close if not already closed
		ws.mu.Lock()
		alreadyClosed := ws.closed
		ws.mu.Unlock()

		if !alreadyClosed {
			fmt.Println("[WASM-WS] readLoop exiting, closing connection")
			ws.Close()
		}
	}()

	fmt.Println("[WASM-WS] readLoop started")

	for {
		// Read message using gorilla/websocket
		messageType, message, err := ws.wsConn.ReadMessage()
		if err != nil {
			if !ws.closed {
				fmt.Printf("[WASM-WS] Read error: %v\n", err)
				ws.callOnError(err.Error())
				ws.callOnClose()
			}
			return
		}

		// Handle message based on type
		switch messageType {
		case websocket.TextMessage, websocket.BinaryMessage:
			// Log first few bytes to verify data integrity
			msgLen := len(message)
			preview := msgLen
			if preview > 100 {
				preview = 100
			}
			if msgLen > 0 {
				fmt.Printf("[WASM-WS] Received %d bytes (type=%d): %s...\n", msgLen, messageType, string(message[:preview]))
			}
			// Call handler directly - simplest approach for debugging
			ws.callOnMessage(string(message))
		case websocket.CloseMessage:
			ws.Close()
			return
		}
	}
}

// messageDispatcher processes incoming messages sequentially and calls JS callbacks
// This ensures messages are delivered in order while preventing readLoop blocking
func (ws *WebSocketConnection) messageDispatcher() {
	defer close(ws.readDone)

	msgCount := 0
	for msg := range ws.readQueue {
		msgCount++
		if msgCount%100 == 0 {
			fmt.Printf("[WASM-WS] Dispatcher processed %d messages, queue size: %d\n", msgCount, len(ws.readQueue))
		}
		ws.callOnMessage(msg)
	}

	fmt.Printf("[WASM-WS] Message dispatcher exiting after %d messages\n", msgCount)
}

// writeLoop is a dedicated goroutine that serializes all WebSocket writes
// This is the gorilla/websocket recommended pattern for concurrent writes
func (ws *WebSocketConnection) writeLoop() {
	defer close(ws.writeDone)

	for data := range ws.writeQueue {
		if err := ws.wsConn.WriteMessage(websocket.TextMessage, data); err != nil {
			fmt.Printf("[WASM-WS] Write error: %v\n", err)
			// Drain remaining messages to prevent deadlock on Send()
			go func() {
				for range ws.writeQueue {
					// Discard remaining messages
				}
			}()
			return
		}
	}

	fmt.Println("[WASM-WS] Write queue closed, writer exiting cleanly")
}

// pingLoop sends periodic pings to keep the connection alive
func (ws *WebSocketConnection) pingLoop() {
	ticker := time.NewTicker(30 * time.Second) // Ping every 30 seconds
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			ws.mu.Lock()
			closed := ws.closed
			wsConn := ws.wsConn
			ws.mu.Unlock()

			if closed || wsConn == nil {
				return
			}

			// WriteControl is safe to call concurrently with WriteMessage
			// according to gorilla/websocket docs
			err := wsConn.WriteControl(websocket.PingMessage, []byte{}, time.Now().Add(10*time.Second))
			if err != nil {
				fmt.Printf("[WASM-WS] Ping failed: %v\n", err)
				// Don't exit on error - connection might recover
			} else {
				fmt.Println("[WASM-WS] Sent ping")
			}

		case <-ws.closeSignal:
			return
		}
	}
}

// Send sends a text message over the WebSocket (non-blocking with timeout)
func (ws *WebSocketConnection) Send(data string) error {
	ws.mu.Lock()
	if ws.closed {
		ws.mu.Unlock()
		return fmt.Errorf("connection closed")
	}
	ws.mu.Unlock()

	// Queue the message for the writer goroutine with timeout
	// This prevents indefinite blocking if write queue is full
	select {
	case ws.writeQueue <- []byte(data):
		return nil
	case <-time.After(2 * time.Second):
		return fmt.Errorf("send timeout: write queue full (possible slow connection or backpressure)")
	}
}

// SendSync sends a text message and waits for the write to complete
// This is used by sendAsync to ensure writes happen sequentially
func (ws *WebSocketConnection) SendSync(data string) error {
	ws.mu.Lock()
	if ws.closed {
		ws.mu.Unlock()
		return fmt.Errorf("connection closed")
	}
	ws.mu.Unlock()

	// Queue the message for the writer goroutine (blocking if full)
	ws.writeQueue <- []byte(data)
	return nil
}

// Close closes the WebSocket connection
func (ws *WebSocketConnection) Close() error {
	ws.mu.Lock()
	if ws.closed {
		ws.mu.Unlock()
		return nil
	}
	ws.closed = true
	ws.mu.Unlock()

	// Close the signal channel first (only once)
	select {
	case <-ws.closeSignal:
		// Already closed
	default:
		close(ws.closeSignal)
	}

	// Close the write queue to signal writer to exit
	close(ws.writeQueue)

	// Wait for writer to drain remaining messages (with timeout)
	select {
	case <-ws.writeDone:
		fmt.Println("[WASM-WS] Write queue drained")
	case <-time.After(5 * time.Second):
		fmt.Println("[WASM-WS] Writer drain timeout - force closing")
	}

	// Wait for message dispatcher to finish (with timeout)
	select {
	case <-ws.readDone:
		fmt.Println("[WASM-WS] Message dispatcher finished")
	case <-time.After(5 * time.Second):
		fmt.Println("[WASM-WS] Dispatcher drain timeout - force closing")
	}

	// Close the WebSocket connection (this is safe from any goroutine)
	// Do NOT call WriteMessage here - it would race with writeLoop
	if ws.wsConn != nil {
		ws.wsConn.Close()
	}

	// Close underlying connections
	if ws.tlsConn != nil {
		ws.tlsConn.Close()
	}
	if ws.conn != nil {
		ws.conn.Close()
	}

	return nil
}

// SetConnectionID sets the connection ID for routing callbacks
func (ws *WebSocketConnection) SetConnectionID(id int) {
	ws.connectionID = id
}

// JavaScript callback helpers
func (ws *WebSocketConnection) callOnMessage(data string) {
	if ws.onMessage.IsUndefined() {
		return
	}
	ws.onMessage.Invoke(js.ValueOf(ws.connectionID), js.ValueOf(data))
}

func (ws *WebSocketConnection) callOnOpen() {
	if ws.onOpen.IsUndefined() {
		return
	}
	ws.onOpen.Invoke(js.ValueOf(ws.connectionID))
}

func (ws *WebSocketConnection) callOnClose() {
	if ws.onClose.IsUndefined() {
		return
	}
	ws.onClose.Invoke(js.ValueOf(ws.connectionID))
}

func (ws *WebSocketConnection) callOnError(err string) {
	if ws.onError.IsUndefined() {
		return
	}
	ws.onError.Invoke(js.ValueOf(ws.connectionID), js.ValueOf(err))
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
