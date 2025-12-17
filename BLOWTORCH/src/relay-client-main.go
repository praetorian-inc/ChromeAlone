// +build js,wasm

package main

import (
	"encoding/json"
	"fmt"
	"sync"
	"syscall/js"
	"time"
)

var (
	connections   = make(map[int]*WebSocketConnection)
	proxies       = make(map[int]*RelayProxy)
	nextConnID    = 1
	connectionsMu sync.Mutex

	// Global callback handlers (single instance, route by connection ID)
	globalOnMessage js.Func
	globalOnClose   js.Func
	globalOnError   js.Func
	globalOnOpen    js.Func
)

func main() {
	fmt.Println("BLOWTORCH Relay Client WASM Module Loaded")
	fmt.Println("=========================================")

	// Create single global callback handlers that route by connection ID
	initGlobalHandlers()

	// Register WebSocket creation function (automatically includes relay proxy)
	js.Global().Set("createWASMWebSocket", js.FuncOf(createWASMWebSocketJS))
	js.Global().Set("wasmWebSocketSend", js.FuncOf(wasmWebSocketSendJS))
	js.Global().Set("wasmWebSocketSendAsync", js.FuncOf(wasmWebSocketSendAsyncJS))
	js.Global().Set("wasmWebSocketClose", js.FuncOf(wasmWebSocketCloseJS))

	// Register fingerprint function
	js.Global().Set("generateFingerprint", js.FuncOf(GenerateFingerprint))
	js.Global().Set("getOrCreateFingerprint", js.FuncOf(GetOrCreateFingerprintJS))

	fmt.Println("✓ WASM functions registered")
	fmt.Println("  - createWASMWebSocket (WebSocket + integrated relay proxy)")
	fmt.Println("  - wasmWebSocketSend")
	fmt.Println("  - wasmWebSocketSendAsync")
	fmt.Println("  - wasmWebSocketClose")
	fmt.Println("  - generateFingerprint")
	fmt.Println("  - getOrCreateFingerprint")

	// Keep the program running
	select {}
}

// initGlobalHandlers creates single global callback handlers that route by connection ID
func initGlobalHandlers() {
	// Single onMessage handler for all connections
	globalOnMessage = js.FuncOf(func(this js.Value, args []js.Value) interface{} {
		if len(args) < 2 {
			return nil
		}
		connID := args[0].Int()
		data := args[1].String()

		// Route to relay proxy first (handles relay protocol)
		connectionsMu.Lock()
		proxy, exists := proxies[connID]
		connectionsMu.Unlock()

		if exists {
			proxy.HandleMessage(data)
		}

		// Also route to JavaScript handler if registered
		handlers := js.Global().Get("wasmWebSocketMessageHandlers")
		if !handlers.IsUndefined() {
			handler := handlers.Get(fmt.Sprintf("%d", connID))
			if !handler.IsUndefined() {
				handler.Invoke(data)
			}
		}
		return nil
	})

	// Single onClose handler for all connections
	globalOnClose = js.FuncOf(func(this js.Value, args []js.Value) interface{} {
		if len(args) < 1 {
			return nil
		}
		connID := args[0].Int()

		// Route to JavaScript handler if registered
		handlers := js.Global().Get("wasmWebSocketCloseHandlers")
		if !handlers.IsUndefined() {
			handler := handlers.Get(fmt.Sprintf("%d", connID))
			if !handler.IsUndefined() {
				handler.Invoke()
			}
		}

		// Clean up connection and proxy
		connectionsMu.Lock()
		delete(connections, connID)
		delete(proxies, connID)
		connectionsMu.Unlock()

		return nil
	})

	// Single onError handler for all connections
	globalOnError = js.FuncOf(func(this js.Value, args []js.Value) interface{} {
		if len(args) < 2 {
			return nil
		}
		connID := args[0].Int()
		errorMsg := args[1].String()

		// Route to JavaScript handler if registered
		handlers := js.Global().Get("wasmWebSocketErrorHandlers")
		if !handlers.IsUndefined() {
			handler := handlers.Get(fmt.Sprintf("%d", connID))
			if !handler.IsUndefined() {
				handler.Invoke(errorMsg)
			}
		}
		return nil
	})

	// Single onOpen handler for all connections
	globalOnOpen = js.FuncOf(func(this js.Value, args []js.Value) interface{} {
		if len(args) < 1 {
			return nil
		}
		connID := args[0].Int()
		fmt.Printf("[WASM] Connection %d opened\n", connID)
		return nil
	})
}

// createWASMWebSocketJS creates a new WebSocket connection
// Arguments: (url, frontDomain, targetHost, relayToken, insecureSkipVerify, fingerprint)
// Returns: Promise<connectionId>
func createWASMWebSocketJS(this js.Value, args []js.Value) interface{} {
	if len(args) < 6 {
		return jsPromiseReject("insufficient arguments")
	}

	url := args[0].String()
	frontDomain := args[1].String()
	targetHost := args[2].String()
	relayToken := args[3].String()
	insecureSkipVerify := args[4].Bool()
	fingerprint := args[5].String()

	// Create a promise
	handler := js.FuncOf(func(this js.Value, promiseArgs []js.Value) interface{} {
		resolve := promiseArgs[0]
		reject := promiseArgs[1]

		go func() {
			config := WebSocketConfig{
				URL:                url,
				FrontDomain:        frontDomain,
				TargetHost:         targetHost,
				RelayToken:         relayToken,
				InsecureSkipVerify: insecureSkipVerify,
			}

			conn, err := NewWebSocketConnection(config)
			if err != nil {
				reject.Invoke(js.ValueOf(fmt.Sprintf("Failed to create WebSocket: %v", err)))
				return
			}

			// Store connection and generate ID first
			connectionsMu.Lock()
			connID := nextConnID
			nextConnID++
			connections[connID] = conn
			connectionsMu.Unlock()

			// Store the connection ID in the connection object for routing
			conn.SetConnectionID(connID)

			// Set callbacks to the global handlers (shared across all connections)
			conn.onMessage = globalOnMessage
			conn.onClose = globalOnClose
			conn.onError = globalOnError
			conn.onOpen = globalOnOpen

			// Create relay proxy
			proxy := NewRelayProxy(conn)

			// Store proxy
			connectionsMu.Lock()
			proxies[connID] = proxy
			connectionsMu.Unlock()

			fmt.Printf("[WASM] WebSocket connection %d established with integrated relay proxy\n", connID)

			// Trigger onOpen callback first
			conn.callOnOpen()

			// Send registration message with fingerprint after a small delay
			// to ensure WebSocket is fully ready
			if fingerprint != "" {
				fmt.Printf("[WASM] Preparing to send registration message with fingerprint: %s\n", fingerprint[:16]+"...")
				go func() {
					// Small delay to ensure connection is stable
					time.Sleep(100 * time.Millisecond)
					if err := sendRegistrationMessage(conn, fingerprint); err != nil {
						fmt.Printf("[WASM] ERROR: Failed to send registration message: %v\n", err)
					} else {
						fmt.Printf("[WASM] Successfully queued registration message\n")
					}
				}()
			} else {
				fmt.Printf("[WASM] WARNING: No fingerprint provided, skipping registration\n")
			}

			// Note: readLoop already started in NewWebSocketConnection
			fmt.Printf("[WASM] Connection %d ready (readLoop already running)\n", connID)

			// Resolve with connection ID
			resolve.Invoke(js.ValueOf(connID))
		}()

		return nil
	})

	promiseConstructor := js.Global().Get("Promise")
	return promiseConstructor.New(handler)
}

// wasmWebSocketSendJS sends data over a WebSocket connection (fire-and-forget)
// Arguments: (connectionId, data)
func wasmWebSocketSendJS(this js.Value, args []js.Value) interface{} {
	if len(args) < 2 {
		fmt.Println("[WASM] wasmWebSocketSend: insufficient arguments")
		return nil
	}

	connID := args[0].Int()
	data := args[1].String()

	connectionsMu.Lock()
	conn, exists := connections[connID]
	connectionsMu.Unlock()

	if !exists {
		fmt.Printf("[WASM] Connection %d not found\n", connID)
		return nil
	}

	if err := conn.Send(data); err != nil {
		fmt.Printf("[WASM] Failed to send data on connection %d: %v\n", connID, err)
		conn.callOnError(err.Error())
	}

	return nil
}

// wasmWebSocketSendAsyncJS sends data and returns a Promise that resolves when send completes
// Arguments: (connectionId, data)
// Returns: Promise<void>
func wasmWebSocketSendAsyncJS(this js.Value, args []js.Value) interface{} {
	if len(args) < 2 {
		return jsPromiseReject("insufficient arguments")
	}

	connID := args[0].Int()
	data := args[1].String()

	// Create a promise
	handler := js.FuncOf(func(this js.Value, promiseArgs []js.Value) interface{} {
		resolve := promiseArgs[0]
		reject := promiseArgs[1]

		go func() {
			connectionsMu.Lock()
			conn, exists := connections[connID]
			connectionsMu.Unlock()

			if !exists {
				reject.Invoke(js.ValueOf(fmt.Sprintf("Connection %d not found", connID)))
				return
			}

			if err := conn.SendSync(data); err != nil {
				fmt.Printf("[WASM] Failed to send data on connection %d: %v\n", connID, err)
				conn.callOnError(err.Error())
				reject.Invoke(js.ValueOf(err.Error()))
				return
			}

			resolve.Invoke(js.Undefined())
		}()

		return nil
	})

	promiseConstructor := js.Global().Get("Promise")
	return promiseConstructor.New(handler)
}

// wasmWebSocketCloseJS closes a WebSocket connection
// Arguments: (connectionId)
func wasmWebSocketCloseJS(this js.Value, args []js.Value) interface{} {
	if len(args) < 1 {
		return nil
	}

	connID := args[0].Int()

	connectionsMu.Lock()
	conn, exists := connections[connID]
	if exists {
		delete(connections, connID)
	}
	connectionsMu.Unlock()

	if exists {
		conn.Close()
		fmt.Printf("[WASM] Connection %d closed\n", connID)
	}

	return nil
}

// Helper function to create a rejected promise
func jsPromiseReject(reason string) js.Value {
	handler := js.FuncOf(func(this js.Value, args []js.Value) interface{} {
		reject := args[1]
		reject.Invoke(js.ValueOf(reason))
		return nil
	})
	defer handler.Release()

	promiseConstructor := js.Global().Get("Promise")
	return promiseConstructor.New(handler)
}

// sendRegistrationMessage sends a registration message with fingerprint data
func sendRegistrationMessage(conn *WebSocketConnection, fingerprintHash string) error {
	fmt.Printf("[Registration] Starting registration process...\n")
	fmt.Printf("[Registration] Using stored fingerprint hash: %s\n", fingerprintHash[:16]+"...")

	localStorage := js.Global().Get("localStorage")
	storedFingerprintJSON := localStorage.Call("getItem", "blowtorch_fingerprint_data")

	var fpData FingerprintData

	// Use stored fingerprint data if available
	if !storedFingerprintJSON.IsNull() && !storedFingerprintJSON.IsUndefined() {
		fmt.Printf("[Registration] Using stored fingerprint data from localStorage\n")
		if err := json.Unmarshal([]byte(storedFingerprintJSON.String()), &fpData); err != nil {
			fmt.Printf("[Registration] ERROR parsing stored fingerprint, collecting new: %v\n", err)
			// Fall back to collecting new fingerprint
			jsonData, err := CollectFingerprint()
			if err != nil {
				fmt.Printf("[Registration] ERROR collecting fingerprint: %v\n", err)
				return fmt.Errorf("failed to collect fingerprint: %w", err)
			}
			if err := json.Unmarshal(jsonData, &fpData); err != nil {
				fmt.Printf("[Registration] ERROR parsing fingerprint: %v\n", err)
				return fmt.Errorf("failed to parse fingerprint: %w", err)
			}
		}
	} else {
		// Collect full fingerprint data for first time
		fmt.Printf("[Registration] No stored fingerprint data, collecting new...\n")
		jsonData, err := CollectFingerprint()
		if err != nil {
			fmt.Printf("[Registration] ERROR collecting fingerprint: %v\n", err)
			return fmt.Errorf("failed to collect fingerprint: %w", err)
		}
		fmt.Printf("[Registration] Collected %d bytes of fingerprint data\n", len(jsonData))

		// Parse the fingerprint data
		if err := json.Unmarshal(jsonData, &fpData); err != nil {
			fmt.Printf("[Registration] ERROR parsing fingerprint: %v\n", err)
			return fmt.Errorf("failed to parse fingerprint: %w", err)
		}
		fmt.Printf("[Registration] Parsed fingerprint data successfully\n")

		// Store the full fingerprint data for future use
		localStorage.Call("setItem", "blowtorch_fingerprint_data", string(jsonData))
		fmt.Printf("[Registration] Stored fingerprint data in localStorage\n")
	}

	// Always detect fresh IP addresses
	fmt.Printf("[Registration] Detecting current IP addresses via WebRTC...\n")
	freshIPData, err := CollectFingerprint()
	if err == nil {
		var freshFP FingerprintData
		if err := json.Unmarshal(freshIPData, &freshFP); err == nil {
			fpData.IPAddresses = freshFP.IPAddresses
			fmt.Printf("[Registration] Updated with %d current IP addresses\n", len(fpData.IPAddresses))
		}
	}

	// Ensure we're using the stored hash (not a freshly generated one)
	fpData.Hash = fingerprintHash

	// Create registration message
	type RegistrationMessage struct {
		Type        string          `json:"type"`
		Fingerprint FingerprintData `json:"fingerprint"`
	}

	regMsg := RegistrationMessage{
		Type:        "register",
		Fingerprint: fpData,
	}

	regJSON, err := json.Marshal(regMsg)
	if err != nil {
		fmt.Printf("[Registration] ERROR marshaling registration: %v\n", err)
		return fmt.Errorf("failed to marshal registration message: %w", err)
	}
	fmt.Printf("[Registration] Registration message size: %d bytes\n", len(regJSON))

	// Send registration message
	fmt.Printf("[Registration] Sending registration message...\n")
	if err := conn.Send(string(regJSON)); err != nil {
		fmt.Printf("[Registration] ERROR sending: %v\n", err)
		return fmt.Errorf("failed to send registration message: %w", err)
	}

	fmt.Printf("[Registration] ✓ Successfully sent registration with fingerprint: %s\n", fpData.Hash[:16]+"...")
	fmt.Printf("[Registration] Client details - Platform: %s, UserAgent: %s\n", fpData.Platform, fpData.UserAgent)

	return nil
}

// GetOrCreateFingerprintJS gets the fingerprint from localStorage or generates a new one
// Returns: Promise<string> - the fingerprint hash
func GetOrCreateFingerprintJS(this js.Value, args []js.Value) interface{} {
	handler := js.FuncOf(func(this js.Value, promiseArgs []js.Value) interface{} {
		resolve := promiseArgs[0]
		reject := promiseArgs[1]

		go func() {
			defer func() {
				if r := recover(); r != nil {
					reject.Invoke(fmt.Sprintf("Panic in GetOrCreateFingerprintJS: %v", r))
				}
			}()

			localStorage := js.Global().Get("localStorage")
			if localStorage.IsUndefined() {
				reject.Invoke("localStorage is not available")
				return
			}

			// Try to get existing fingerprint
			storedFingerprint := localStorage.Call("getItem", "blowtorch_fingerprint")
			if !storedFingerprint.IsNull() && !storedFingerprint.IsUndefined() {
				fingerprintStr := storedFingerprint.String()
				if fingerprintStr != "" {
					fmt.Printf("[Fingerprint] Using stored fingerprint: %s\n", fingerprintStr[:16]+"...")
					resolve.Invoke(fingerprintStr)
					return
				}
			}

			// Generate new fingerprint
			fmt.Println("[Fingerprint] No stored fingerprint found, generating new one...")
			jsonData, err := CollectFingerprint()
			if err != nil {
				reject.Invoke(fmt.Sprintf("Failed to generate fingerprint: %v", err))
				return
			}

			// Parse JSON to get hash
			var fpData FingerprintData
			if err := json.Unmarshal(jsonData, &fpData); err != nil {
				reject.Invoke(fmt.Sprintf("Failed to parse fingerprint: %v", err))
				return
			}

			// Store in localStorage
			localStorage.Call("setItem", "blowtorch_fingerprint", fpData.Hash)
			fmt.Printf("[Fingerprint] Generated and stored new fingerprint: %s\n", fpData.Hash[:16]+"...")

			resolve.Invoke(fpData.Hash)
		}()

		return nil
	})

	promiseConstructor := js.Global().Get("Promise")
	return promiseConstructor.New(handler)
}
