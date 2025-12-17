//go:build js && wasm
// +build js,wasm

package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"sync"
	"time"
)

// RelayMessage represents messages sent between relay and proxy
type RelayMessage struct {
	Type         string `json:"type"`
	ConnectionID string `json:"connectionId,omitempty"`
	TargetHost   string `json:"targetHost,omitempty"`
	TargetPort   int    `json:"targetPort,omitempty"`
	Data         string `json:"data,omitempty"`
	MsgID        string `json:"msgId,omitempty"`
}

// ProxyConnection represents a single proxied connection
type ProxyConnection struct {
	id         string
	localConn  net.Conn
	proxy      *RelayProxy
	readBuffer chan []byte
	done       chan struct{}
	closeOnce  sync.Once
	wg         sync.WaitGroup
}

// RelayProxy manages the WebSocket connection to relay and all proxied connections
type RelayProxy struct {
	ws             *WebSocketConnection
	connections    map[string]*ProxyConnection
	connMu         sync.RWMutex
	totalConnected int // Track total connections created
	activeConns    int // Track currently active connections
}

// NewRelayProxy creates a new relay proxy
// Note: The caller should set up the WebSocket message handler to call HandleMessage
func NewRelayProxy(ws *WebSocketConnection) *RelayProxy {
	proxy := &RelayProxy{
		ws:          ws,
		connections: make(map[string]*ProxyConnection),
	}

	return proxy
}

// HandleMessage processes incoming relay messages (called by global handler)
func (p *RelayProxy) HandleMessage(messageStr string) {
	p.handleMessage(messageStr)
}

// handleMessage processes incoming relay messages
func (p *RelayProxy) handleMessage(messageStr string) {
	var msg RelayMessage
	if err := json.Unmarshal([]byte(messageStr), &msg); err != nil {
		fmt.Printf("[RelayProxy] Failed to parse message: %v\n", err)
		return
	}

	switch msg.Type {
	case "connect":
		fmt.Printf("[%s] Received connect request to %s:%d\n", msg.ConnectionID, msg.TargetHost, msg.TargetPort)
		go p.handleConnect(msg.ConnectionID, msg.TargetHost, msg.TargetPort)

	case "data":
		p.connMu.RLock()
		conn, exists := p.connections[msg.ConnectionID]
		p.connMu.RUnlock()

		if !exists {
			fmt.Printf("[%s] Received data for unknown connection\n", msg.ConnectionID)
			return
		}

		// Decode base64 data
		data, err := base64.StdEncoding.DecodeString(msg.Data)
		if err != nil {
			fmt.Printf("[%s] Failed to decode data: %v\n", msg.ConnectionID, err)
			return
		}

		fmt.Printf("[%s] Received %d bytes from relay, queuing for local write\n", msg.ConnectionID, len(data))

		// Send to local connection - non-blocking with large buffer
		select {
		case conn.readBuffer <- data:
			// Queued successfully
		case <-conn.done:
			// Connection is closing
		default:
			// Buffer full - drop this packet to avoid blocking other connections
			// This prevents one slow connection from blocking all message processing
			fmt.Printf("[%s] WARNING: Buffer full, dropping %d bytes\n", msg.ConnectionID, len(data))
		}

	case "close":
		fmt.Printf("[%s] Received close from relay\n", msg.ConnectionID)
		p.connMu.RLock()
		conn, exists := p.connections[msg.ConnectionID]
		p.connMu.RUnlock()

		if exists {
			conn.close()
		}

	default:
		fmt.Printf("[RelayProxy] Unknown message type: %s\n", msg.Type)
	}
}

// handleConnect establishes a local TCP connection and starts proxying
func (p *RelayProxy) handleConnect(connID, targetHost string, targetPort int) {
	targetAddr := fmt.Sprintf("%s:%d", targetHost, targetPort)
	fmt.Printf("[%s] Connecting to %s\n", connID, targetAddr)

	// Pre-register connection with placeholder to avoid race condition
	// Data messages can arrive while we're still connecting
	proxyConn := &ProxyConnection{
		id:         connID,
		proxy:      p,
		readBuffer: make(chan []byte, 500), // Increased buffer - 500 packets max per connection
		done:       make(chan struct{}),
	}

	p.connMu.Lock()
	p.connections[connID] = proxyConn
	p.totalConnected++
	p.activeConns++
	totalConns := p.totalConnected
	activeConns := p.activeConns
	p.connMu.Unlock()

	fmt.Printf("[RelayProxy] Stats: %d total connections, %d active\n", totalConns, activeConns)

	// Use Direct Sockets API (the only way to make TCP connections in WASM)
	startTime := time.Now()
	localConn, err := NewDirectSocket("tcp", targetAddr)
	if err != nil {
		fmt.Printf("[%s] Failed to connect to %s after %v: %v\n", connID, targetAddr, time.Since(startTime), err)
		// Remove from map and send close to relay
		p.connMu.Lock()
		delete(p.connections, connID)
		p.activeConns--
		p.connMu.Unlock()

		p.sendMessage(RelayMessage{
			Type:         "close",
			ConnectionID: connID,
		})
		return
	}

	fmt.Printf("[%s] Connected to %s in %v\n", connID, targetAddr, time.Since(startTime))

	// Update connection with actual socket
	proxyConn.localConn = localConn

	// Now start bidirectional forwarding - connection can receive data immediately
	proxyConn.wg.Add(2)
	go proxyConn.readFromRelay()
	go proxyConn.readFromLocal()
}

// readFromLocal reads from the local TCP connection and sends to relay
func (c *ProxyConnection) readFromLocal() {
	defer c.wg.Done()

	// Use 16KB buffer - balance between throughput and message size
	// Larger buffers cause issues with Direct Sockets under high load
	buf := make([]byte, 16384)
	consecutiveErrors := 0

	for {
		select {
		case <-c.done:
			return
		default:
		}

		// Set read deadline to allow checking done channel periodically
		// Use longer timeout for WASM since Direct Sockets API has more overhead
		c.localConn.SetReadDeadline(time.Now().Add(1 * time.Second))

		n, err := c.localConn.Read(buf)
		if err != nil {
			if netErr, ok := err.(net.Error); ok && netErr.Timeout() {
				continue // Timeout is expected, check done channel and retry
			}
			if err != io.EOF {
				fmt.Printf("[%s] Local read error: %v\n", c.id, err)
			} else {
				fmt.Printf("[%s] Local connection EOF\n", c.id)
			}
			c.close()
			return
		}

		fmt.Printf("[%s] Read %d bytes from local connection\n", c.id, n)

		if n > 0 {
			// Encode and send to relay
			data := base64.StdEncoding.EncodeToString(buf[:n])
			fmt.Printf("[%s] Sending %d bytes to relay\n", c.id, n)
			err := c.proxy.sendMessage(RelayMessage{
				Type:         "data",
				ConnectionID: c.id,
				Data:         data,
			})
			if err != nil {
				fmt.Printf("[%s] Failed to send data to relay: %v\n", c.id, err)
				consecutiveErrors++

				// If we're getting repeated send errors, the connection is unhealthy
				// Close it to trigger reconnect
				if consecutiveErrors > 3 {
					fmt.Printf("[%s] Too many consecutive send errors, closing\n", c.id)
					c.close()
					return
				}

				// Brief pause before retry to avoid hammering a failing connection
				time.Sleep(100 * time.Millisecond)
				continue
			}

			// Reset error counter on success
			consecutiveErrors = 0
		}
	}
}

// readFromRelay reads from the relay and writes to local TCP connection
func (c *ProxyConnection) readFromRelay() {
	defer c.wg.Done()
	defer func() {
		if r := recover(); r != nil {
			fmt.Printf("[%s] PANIC in readFromRelay: %v\n", c.id, r)
		}
	}()

	for {
		select {
		case data, ok := <-c.readBuffer:
			if !ok {
				c.close()
				return
			}

			// Check if connection is valid before writing
			if c.localConn == nil {
				fmt.Printf("[%s] WARNING: localConn is nil, skipping write\n", c.id)
				c.close()
				return
			}

			fmt.Printf("[%s] Writing %d bytes to local connection (START)\n", c.id, len(data))

			// Wrap write in recover to catch any panics
			func() {
				defer func() {
					if r := recover(); r != nil {
						fmt.Printf("[%s] PANIC during Write(): %v\n", c.id, r)
					}
				}()

				_, err := c.localConn.Write(data)
				if err != nil {
					fmt.Printf("[%s] Local write error: %v\n", c.id, err)
					c.close()
					return
				}
			}()

			fmt.Printf("[%s] Writing %d bytes to local connection (COMPLETE)\n", c.id, len(data))

		case <-c.done:
			return
		}
	}
}

// close cleanly shuts down the connection
// CRITICAL: This must be fully non-blocking because it's called from JS callbacks
func (c *ProxyConnection) close() {
	c.closeOnce.Do(func() {
		fmt.Printf("[%s] Closing connection\n", c.id)

		// Remove from connections map FIRST to prevent new data messages
		c.proxy.connMu.Lock()
		delete(c.proxy.connections, c.id)
		c.proxy.activeConns--
		activeConns := c.proxy.activeConns
		c.proxy.connMu.Unlock()

		fmt.Printf("[RelayProxy] Connection closed, %d active connections remaining\n", activeConns)

		// ALL cleanup must happen in background goroutine to avoid blocking JS event loop
		go func() {
			// Close the local connection first (will unblock readFromLocal)
			if c.localConn != nil {
				c.localConn.Close()
			}

			// Close the read buffer BEFORE signaling done
			// This ensures readFromRelay will exit when it reads from closed channel
			close(c.readBuffer)

			// NOW signal goroutines to stop
			close(c.done)

			// Wait for both goroutines to finish (with timeout)
			done := make(chan struct{})
			go func() {
				c.wg.Wait()
				close(done)
			}()

			select {
			case <-done:
				fmt.Printf("[%s] Goroutines exited cleanly\n", c.id)
			case <-time.After(2 * time.Second):
				fmt.Printf("[%s] Warning: goroutines did not finish within timeout\n", c.id)
			}

			// Send close to relay
			c.proxy.sendMessage(RelayMessage{
				Type:         "close",
				ConnectionID: c.id,
			})

			fmt.Printf("[%s] Connection cleanup completed\n", c.id)
		}()
	})
}

// sendMessage sends a message to the relay server
func (p *RelayProxy) sendMessage(msg RelayMessage) error {
	data, err := json.Marshal(msg)
	if err != nil {
		return err
	}

	return p.ws.Send(string(data))
}
