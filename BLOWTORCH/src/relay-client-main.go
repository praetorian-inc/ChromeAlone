// +build js,wasm

package main

import (
	"fmt"
	"sync"
	"syscall/js"
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

	fmt.Println("✓ WASM functions registered")
	fmt.Println("  - createWASMWebSocket (WebSocket + integrated relay proxy)")
	fmt.Println("  - wasmWebSocketSend")
	fmt.Println("  - wasmWebSocketSendAsync")
	fmt.Println("  - wasmWebSocketClose")

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
// Arguments: (url, frontDomain, targetHost, relayToken, insecureSkipVerify)
// Returns: Promise<connectionId>
func createWASMWebSocketJS(this js.Value, args []js.Value) interface{} {
	if len(args) < 5 {
		return jsPromiseReject("insufficient arguments")
	}

	url := args[0].String()
	frontDomain := args[1].String()
	targetHost := args[2].String()
	relayToken := args[3].String()
	insecureSkipVerify := args[4].Bool()

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

			// Trigger onOpen callback
			conn.callOnOpen()

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
