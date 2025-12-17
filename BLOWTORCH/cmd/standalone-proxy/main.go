package main

import (
	"crypto/sha256"
	"crypto/tls"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const (
	// From .env file
	RELAY_URL    = "wss://<take from relay-info.txt>"
	RELAY_TOKEN  = "<take from relay-info.txt>"
	FRONT_DOMAIN = "yourfront-domain.com"
	TARGET_HOST  = "<take from relay-info.txt>"

	SOCKS_PORT = "1080"
)

type RelayMessage struct {
	Type         string `json:"type"`
	ConnectionID string `json:"connectionId,omitempty"`
	TargetHost   string `json:"targetHost,omitempty"`
	TargetPort   int    `json:"targetPort,omitempty"`
	Data         string `json:"data,omitempty"`
	MsgID        string `json:"msgId,omitempty"`
}

type FingerprintData struct {
	UserAgent           string   `json:"userAgent"`
	Language            string   `json:"language"`
	Languages           []string `json:"languages"`
	Platform            string   `json:"platform"`
	HardwareConcurrency int      `json:"hardwareConcurrency"`
	DeviceMemory        float64  `json:"deviceMemory"`
	ScreenWidth         int      `json:"screenWidth"`
	ScreenHeight        int      `json:"screenHeight"`
	ScreenDepth         int      `json:"screenDepth"`
	ColorDepth          int      `json:"colorDepth"`
	PixelRatio          float64  `json:"pixelRatio"`
	Timezone            string   `json:"timezone"`
	TimezoneOffset      int      `json:"timezoneOffset"`
	SessionStorage      bool     `json:"sessionStorage"`
	LocalStorage        bool     `json:"localStorage"`
	IndexedDB           bool     `json:"indexedDB"`
	OpenDatabase        bool     `json:"openDatabase"`
	CpuClass            string   `json:"cpuClass"`
	DoNotTrack          string   `json:"doNotTrack"`
	Plugins             []string `json:"plugins"`
	Canvas              string   `json:"canvas"`
	WebGL               string   `json:"webgl"`
	WebGLVendor         string   `json:"webglVendor"`
	WebGLRenderer       string   `json:"webglRenderer"`
	AudioContext        string   `json:"audioContext"`
	Fonts               []string `json:"fonts"`
	IPAddresses         []string `json:"ipAddresses"`
	Hash                string   `json:"hash"`
}

type RegistrationMessage struct {
	Type        string          `json:"type"`
	Fingerprint FingerprintData `json:"fingerprint"`
}

type ProxyConnection struct {
	id         string
	localConn  net.Conn
	relay      *RelayConnection
	readBuffer chan []byte
	done       chan struct{}
	closeOnce  sync.Once
	wg         sync.WaitGroup
}

type RelayConnection struct {
	wsConn      *websocket.Conn
	connections map[string]*ProxyConnection
	connMu      sync.RWMutex
	writeMu     sync.Mutex
}

func main() {
	log.Printf("Starting standalone SOCKS5 proxy on port %s", SOCKS_PORT)
	log.Printf("Relay URL: %s", RELAY_URL)
	log.Printf("Domain fronting: %s -> %s", FRONT_DOMAIN, TARGET_HOST)

	// Connect to relay
	relay, err := connectToRelay()
	if err != nil {
		log.Fatalf("Failed to connect to relay: %v", err)
	}
	defer relay.wsConn.Close()

	log.Println("Connected to relay successfully")
	log.Println("Waiting for connections from relay...")

	// Start WebSocket message handler (blocks until connection closes)
	relay.handleMessages()

	log.Println("Relay connection closed")
}

func connectToRelay() (*RelayConnection, error) {
	// Parse URL
	parsedURL, err := url.Parse(RELAY_URL)
	if err != nil {
		return nil, fmt.Errorf("invalid URL: %v", err)
	}

	// Domain fronting: connect to FRONT_DOMAIN but set Host header to TARGET_HOST
	connectHost := FRONT_DOMAIN
	if parsedURL.Port() != "" {
		connectHost = net.JoinHostPort(connectHost, parsedURL.Port())
	} else if parsedURL.Scheme == "wss" {
		connectHost = net.JoinHostPort(connectHost, "443")
	}

	log.Printf("Dialing %s...", connectHost)

	// Create TLS connection with domain fronting
	tlsConn, err := tls.Dial("tcp", connectHost, &tls.Config{
		ServerName:         FRONT_DOMAIN,
		InsecureSkipVerify: true,
	})
	if err != nil {
		return nil, fmt.Errorf("TLS dial failed: %v", err)
	}

	// Prepare WebSocket headers
	headers := http.Header{}
	headers.Set("Host", TARGET_HOST)
	headers.Set("Sec-WebSocket-Protocol", "token."+RELAY_TOKEN)

	// Create WebSocket URL (use ws:// since TLS is already established)
	wsURL := &url.URL{
		Scheme: "ws",
		Host:   TARGET_HOST,
		Path:   parsedURL.Path,
	}

	log.Printf("WebSocket handshake to %s", wsURL.String())

	// Perform WebSocket upgrade
	wsConn, resp, err := websocket.NewClient(tlsConn, wsURL, headers, 4096, 4096)
	if err != nil {
		if resp != nil {
			log.Printf("Handshake response: %d %s", resp.StatusCode, resp.Status)
		}
		return nil, fmt.Errorf("WebSocket handshake failed: %v", err)
	}

	if resp != nil {
		log.Printf("WebSocket handshake successful: %d %s", resp.StatusCode, resp.Status)
	}

	relay := &RelayConnection{
		wsConn:      wsConn,
		connections: make(map[string]*ProxyConnection),
	}

	// Send registration message with dummy fingerprint
	if err := sendRegistrationMessage(relay); err != nil {
		log.Printf("Warning: Failed to send registration message: %v", err)
		// Don't fail the connection, continue anyway
	}

	return relay, nil
}

func sendRegistrationMessage(relay *RelayConnection) error {
	// Create a dummy fingerprint based on hostname
	hostname, err := os.Hostname()
	if err != nil {
		hostname = "standalone-proxy"
	}

	// Generate a consistent hash based on hostname
	hasher := sha256.New()
	hasher.Write([]byte(hostname + "-standalone"))
	fingerprintHash := hex.EncodeToString(hasher.Sum(nil))

	// Create dummy fingerprint data
	fpData := FingerprintData{
		UserAgent:           "StandaloneProxy/1.0",
		Language:            "en-US",
		Languages:           []string{"en-US", "en"},
		Platform:            "Linux x86_64",
		HardwareConcurrency: 4,
		DeviceMemory:        8.0,
		ScreenWidth:         1920,
		ScreenHeight:        1080,
		ScreenDepth:         24,
		ColorDepth:          24,
		PixelRatio:          1.0,
		Timezone:            "America/New_York",
		TimezoneOffset:      -300,
		SessionStorage:      true,
		LocalStorage:        true,
		IndexedDB:           true,
		OpenDatabase:        false,
		CpuClass:            "",
		DoNotTrack:          "unspecified",
		Plugins:             []string{},
		Canvas:              "dummy",
		WebGL:               "dummy",
		WebGLVendor:         "dummy",
		WebGLRenderer:       "dummy",
		AudioContext:        "dummy",
		Fonts:               []string{},
		IPAddresses:         []string{},
		Hash:                fingerprintHash,
	}

	regMsg := RegistrationMessage{
		Type:        "register",
		Fingerprint: fpData,
	}

	regJSON, err := json.Marshal(regMsg)
	if err != nil {
		return fmt.Errorf("failed to marshal registration message: %v", err)
	}

	log.Printf("Sending registration message with fingerprint: %s...", fingerprintHash[:16])

	relay.writeMu.Lock()
	defer relay.writeMu.Unlock()

	if err := relay.wsConn.WriteMessage(websocket.TextMessage, regJSON); err != nil {
		return fmt.Errorf("failed to send registration message: %v", err)
	}

	log.Printf("Registration message sent successfully")
	return nil
}

func (r *RelayConnection) handleMessages() {
	for {
		messageType, message, err := r.wsConn.ReadMessage()
		if err != nil {
			log.Printf("WebSocket read error: %v", err)
			return
		}

		if messageType != websocket.TextMessage {
			log.Printf("Received non-text message type: %d", messageType)
			continue
		}

		var msg RelayMessage
		if err := json.Unmarshal(message, &msg); err != nil {
			log.Printf("Failed to parse message: %v", err)
			continue
		}

		switch msg.Type {
		case "connect":
			log.Printf("[%s] Received connect request to %s:%d", msg.ConnectionID, msg.TargetHost, msg.TargetPort)
			go r.handleConnect(msg.ConnectionID, msg.TargetHost, msg.TargetPort)

		case "data":
			r.connMu.RLock()
			conn, exists := r.connections[msg.ConnectionID]
			r.connMu.RUnlock()

			if !exists {
				log.Printf("[%s] Received data for unknown connection", msg.ConnectionID)
				continue
			}

			// Decode base64 data
			data, err := base64.StdEncoding.DecodeString(msg.Data)
			if err != nil {
				log.Printf("[%s] Failed to decode data: %v", msg.ConnectionID, err)
				continue
			}

			// Send to local connection (non-blocking with larger buffer)
			select {
			case conn.readBuffer <- data:
			case <-conn.done:
				// Connection is closing
			default:
				// Buffer full - this connection is slow, but don't block other connections
				log.Printf("[%s] Warning: read buffer full, connection may be slow", msg.ConnectionID)
				// Try again with blocking to prevent data loss for this specific connection
				select {
				case conn.readBuffer <- data:
				case <-conn.done:
				}
			}

		case "close":
			log.Printf("[%s] Received close from relay", msg.ConnectionID)
			r.connMu.RLock()
			conn, exists := r.connections[msg.ConnectionID]
			r.connMu.RUnlock()

			if exists {
				conn.close()
			}

		default:
			log.Printf("Unknown message type: %s", msg.Type)
		}
	}
}

func (r *RelayConnection) sendMessage(msg RelayMessage) error {
	data, err := json.Marshal(msg)
	if err != nil {
		return err
	}

	r.writeMu.Lock()
	defer r.writeMu.Unlock()

	return r.wsConn.WriteMessage(websocket.TextMessage, data)
}

func (r *RelayConnection) handleConnect(connID, targetHost string, targetPort int) {
	// Connect to local target
	targetAddr := fmt.Sprintf("%s:%d", targetHost, targetPort)
	log.Printf("[%s] Connecting to local target: %s", connID, targetAddr)

	localConn, err := net.DialTimeout("tcp", targetAddr, 10*time.Second)
	if err != nil {
		log.Printf("[%s] Failed to connect to %s: %v", connID, targetAddr, err)
		// Send close to relay
		r.sendMessage(RelayMessage{
			Type:         "close",
			ConnectionID: connID,
		})
		return
	}

	log.Printf("[%s] Connected to %s", connID, targetAddr)

	// Create proxy connection
	proxyConn := &ProxyConnection{
		id:         connID,
		localConn:  localConn,
		relay:      r,
		readBuffer: make(chan []byte, 1000),
		done:       make(chan struct{}),
	}

	r.connMu.Lock()
	r.connections[connID] = proxyConn
	r.connMu.Unlock()

	// Start bidirectional forwarding
	proxyConn.wg.Add(2)
	go proxyConn.readFromRelay()
	go proxyConn.readFromLocal()
}

func (c *ProxyConnection) readFromLocal() {
	defer c.wg.Done()

	buf := make([]byte, 32768)
	for {
		select {
		case <-c.done:
			return
		default:
		}

		// Set read deadline to allow checking done channel periodically
		c.localConn.SetReadDeadline(time.Now().Add(100 * time.Millisecond))

		n, err := c.localConn.Read(buf)
		if err != nil {
			if netErr, ok := err.(net.Error); ok && netErr.Timeout() {
				continue // Timeout is expected, check done channel and retry
			}
			if err != io.EOF {
				log.Printf("[%s] Local read error: %v", c.id, err)
			}
			c.close()
			return
		}

		if n > 0 {
			// Encode and send to relay
			data := base64.StdEncoding.EncodeToString(buf[:n])
			err := c.relay.sendMessage(RelayMessage{
				Type:         "data",
				ConnectionID: c.id,
				Data:         data,
			})
			if err != nil {
				log.Printf("[%s] Failed to send data to relay: %v", c.id, err)
				c.close()
				return
			}
		}
	}
}

func (c *ProxyConnection) readFromRelay() {
	defer c.wg.Done()

	for {
		select {
		case data, ok := <-c.readBuffer:
			if !ok {
				c.close()
				return
			}
			_, err := c.localConn.Write(data)
			if err != nil {
				log.Printf("[%s] Local write error: %v", c.id, err)
				c.close()
				return
			}
		case <-c.done:
			return
		}
	}
}

func (c *ProxyConnection) close() {
	c.closeOnce.Do(func() {
		log.Printf("[%s] Closing connection", c.id)

		// Signal goroutines to stop
		close(c.done)

		// Close the local connection (will unblock any pending reads/writes)
		c.localConn.Close()

		// Start cleanup in background to avoid deadlock
		go func() {
			// Wait for both goroutines to finish
			c.wg.Wait()

			// Close the read buffer
			close(c.readBuffer)

			// Remove from connections map
			c.relay.connMu.Lock()
			delete(c.relay.connections, c.id)
			c.relay.connMu.Unlock()

			// Send close to relay
			c.relay.sendMessage(RelayMessage{
				Type:         "close",
				ConnectionID: c.id,
			})

			log.Printf("[%s] Connection closed", c.id)
		}()
	})
}
