// +build js,wasm

package main

import (
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/base64"
	"fmt"
	"io"
	"net"
	"net/http"
	"syscall/js"
	"time"
)

func generateWebSocketKey() string {
	// Generate 16 random bytes
	key := make([]byte, 16)
	rand.Read(key)
	return base64.StdEncoding.EncodeToString(key)
}

func makeWebSocketRequest() {
	fmt.Println("Creating WebSocket connection with Direct Sockets...")

	// Domain fronting setup
	frontDomain := "client2.google.com"
	targetHost := "redirector-battleplan-0151e977-azdko6cnhq-uc.a.run.app"
	relayToken := "6882821a8efaf0afeef2bc8024cbf3acecac9f1778bc8f47a6c2c56a5964153a"

	// Connect to front domain
	fmt.Printf("Connecting to: %s (fronting for %s)\n", frontDomain, targetHost)

	conn, err := NewDirectSocket("tcp", frontDomain+":443")
	if err != nil {
		fmt.Printf("Error creating socket: %v\n", err)
		return
	}
	defer conn.Close()

	// Wrap with TLS (use frontDomain for SNI to maintain fronting)
	tlsConn := tls.Client(conn, &tls.Config{
		ServerName:         frontDomain,
		InsecureSkipVerify: true,
	})

	if err := tlsConn.Handshake(); err != nil {
		fmt.Printf("TLS handshake failed: %v\n", err)
		return
	}

	fmt.Println("TLS handshake successful")

	// Generate random WebSocket key
	wsKey := generateWebSocketKey()

	// Send WebSocket upgrade request
	// Use Sec-WebSocket-Protocol header to pass token (like JavaScript's subprotocol parameter)
	upgradeRequest := fmt.Sprintf(
		"GET / HTTP/1.1\r\n"+
			"Host: %s\r\n"+
			"Upgrade: websocket\r\n"+
			"Connection: Upgrade\r\n"+
			"Sec-WebSocket-Key: %s\r\n"+
			"Sec-WebSocket-Version: 13\r\n"+
			"Sec-WebSocket-Protocol: token.%s\r\n"+
			"\r\n",
		targetHost,
		wsKey,
		relayToken,
	)

	fmt.Printf("Sending WebSocket upgrade request to Host: %s\n", targetHost)

	if _, err := tlsConn.Write([]byte(upgradeRequest)); err != nil {
		fmt.Printf("Error sending upgrade request: %v\n", err)
		return
	}

	// Read the upgrade response
	response := make([]byte, 4096)
	n, err := tlsConn.Read(response)
	if err != nil {
		fmt.Printf("Error reading upgrade response: %v\n", err)
		return
	}

	responseStr := string(response[:n])
	fmt.Printf("WebSocket upgrade response:\n%s\n", responseStr)
	fmt.Printf("Response length: %d bytes\n", n)

	// Parse the response status line
	lines := splitLines(responseStr)
	if len(lines) > 0 {
		fmt.Printf("Status line: %s\n", lines[0])
	}

	// Check if upgrade was successful
	if !containsString(responseStr, "101") && !containsString(responseStr, "Switching Protocols") {
		fmt.Println("WebSocket upgrade failed - did not receive 101 response")
		fmt.Println("Server may have rejected the connection or responded with an error")
		return
	}

	fmt.Println("✓ WebSocket connection established!")
	fmt.Println("Connection is ready for bidirectional communication")

	// Now you can send/receive WebSocket frames over tlsConn
	// For demo, let's send a simple text frame
	sendWebSocketTextFrame(tlsConn, "Hello from Go WASM with domain fronting!")
}

func sendWebSocketTextFrame(conn net.Conn, text string) {
	payload := []byte(text)
	payloadLen := len(payload)

	// Build WebSocket frame
	// Byte 0: FIN (1) + RSV (000) + Opcode (0001 for text) = 0x81
	frame := []byte{0x81}

	// Byte 1: Mask (1) + payload length
	// Client must mask the payload
	if payloadLen < 126 {
		frame = append(frame, byte(0x80|payloadLen))
	} else if payloadLen < 65536 {
		frame = append(frame, 0xFE)
		frame = append(frame, byte(payloadLen>>8), byte(payloadLen))
	} else {
		frame = append(frame, 0xFF)
		for i := 7; i >= 0; i-- {
			frame = append(frame, byte(payloadLen>>(i*8)))
		}
	}

	// Generate random masking key
	maskKey := make([]byte, 4)
	rand.Read(maskKey)
	frame = append(frame, maskKey...)

	// Masked payload
	for i := 0; i < payloadLen; i++ {
		frame = append(frame, payload[i]^maskKey[i%4])
	}

	if _, err := conn.Write(frame); err != nil {
		fmt.Printf("Error sending WebSocket frame: %v\n", err)
		return
	}

	fmt.Printf("Sent WebSocket message: %s\n", text)
}

func splitLines(s string) []string {
	var lines []string
	start := 0
	for i := 0; i < len(s); i++ {
		if s[i] == '\n' {
			end := i
			if end > 0 && s[end-1] == '\r' {
				end--
			}
			lines = append(lines, s[start:end])
			start = i + 1
		}
	}
	if start < len(s) {
		lines = append(lines, s[start:])
	}
	return lines
}

func containsString(s, substr string) bool {
	if len(substr) > len(s) {
		return false
	}
	for i := 0; i <= len(s)-len(substr); i++ {
		if s[i:i+len(substr)] == substr {
			return true
		}
	}
	return false
}

func makeHTTPRequest() {
	fmt.Println("Creating HTTP client with Direct Sockets...")

	// Domain fronting setup
	frontDomain := "client2.google.com" // Where we actually connect
	targetHost := "www.google.com"      // What we put in Host header

	// Create a custom HTTP transport that uses Direct Sockets
	transport := &http.Transport{
		DialContext: DirectSocketDialContext,
		// For HTTPS, we need TLS configuration
		DialTLSContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			// Override the address to connect to frontDomain instead
			_, port, _ := net.SplitHostPort(addr)
			frontAddr := net.JoinHostPort(frontDomain, port)

			fmt.Printf("Connecting to: %s (fronting for %s)\n", frontAddr, targetHost)

			// First establish the raw socket connection to front domain
			conn, err := NewDirectSocket("tcp", frontAddr)
			if err != nil {
				return nil, fmt.Errorf("failed to create socket: %v", err)
			}

			// Wrap with TLS using frontDomain for SNI
			tlsConn := tls.Client(conn, &tls.Config{
				ServerName:         frontDomain, // SNI uses front domain
				InsecureSkipVerify: true,        // Skip certificate verification for testing
			})

			// Perform TLS handshake
			if err := tlsConn.Handshake(); err != nil {
				conn.Close()
				return nil, fmt.Errorf("TLS handshake failed: %v", err)
			}

			return tlsConn, nil
		},
	}

	client := &http.Client{
		Transport: transport,
		Timeout:   30 * time.Second,
	}

	fmt.Printf("Making HTTP GET request with Host: %s\n", targetHost)

	// Create request manually to control Host header
	req, err := http.NewRequest("GET", "https://"+targetHost+"/", nil)
	if err != nil {
		fmt.Printf("Error creating request: %v\n", err)
		return
	}

	// Explicitly set Host header to target
	req.Host = targetHost

	resp, err := client.Do(req)
	if err != nil {
		fmt.Printf("Error making request: %v\n", err)
		return
	}
	defer resp.Body.Close()

	fmt.Printf("Response Status: %s\n", resp.Status)
	fmt.Printf("Response Headers:\n")
	for key, values := range resp.Header {
		for _, value := range values {
			fmt.Printf("  %s: %s\n", key, value)
		}
	}

	// Read the response body
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		fmt.Printf("Error reading response body: %v\n", err)
		return
	}

	fmt.Printf("\nResponse Body (first 500 chars):\n%s\n", string(body[:min(500, len(body))]))
	fmt.Printf("\nTotal body length: %d bytes\n", len(body))
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func main() {
	fmt.Println("Go WASM Direct Sockets Test")
	fmt.Println("============================")

	// Register functions that JavaScript can call
	js.Global().Set("makeRequest", js.FuncOf(func(this js.Value, args []js.Value) interface{} {
		go makeHTTPRequest()
		return nil
	}))

	js.Global().Set("makeWebSocketRequest", js.FuncOf(func(this js.Value, args []js.Value) interface{} {
		go makeWebSocketRequest()
		return nil
	}))

	// Make the WebSocket request automatically on load
	go makeWebSocketRequest()

	// Keep the program running
	select {}
}
