// +build js,wasm

package main

import (
	"fmt"
	"sync"
	"syscall/js"
)

var (
	connections   = make(map[int]*WebSocketConnection)
	nextConnID    = 1
	connectionsMu sync.Mutex
)

func main() {
	fmt.Println("BLOWTORCH Relay Client WASM Module Loaded")
	fmt.Println("=========================================")

	// Register WebSocket creation function
	js.Global().Set("createWASMWebSocket", js.FuncOf(createWASMWebSocketJS))
	js.Global().Set("wasmWebSocketSend", js.FuncOf(wasmWebSocketSendJS))
	js.Global().Set("wasmWebSocketClose", js.FuncOf(wasmWebSocketCloseJS))

	fmt.Println("✓ WASM WebSocket functions registered")
	fmt.Println("  - createWASMWebSocket")
	fmt.Println("  - wasmWebSocketSend")
	fmt.Println("  - wasmWebSocketClose")

	// Keep the program running
	select {}
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

			// Store connection and generate ID
			connectionsMu.Lock()
			connID := nextConnID
			nextConnID++
			connections[connID] = conn
			connectionsMu.Unlock()

			fmt.Printf("[WASM] WebSocket connection %d established\n", connID)

			// Set up callbacks to call JavaScript handlers
			conn.onMessage = js.FuncOf(func(this js.Value, args []js.Value) interface{} {
				if len(args) > 0 {
					data := args[0].String()
					// Call JavaScript message handler
					handlers := js.Global().Get("wasmWebSocketMessageHandlers")
					if !handlers.IsUndefined() {
						handler := handlers.Get(fmt.Sprintf("%d", connID))
						if !handler.IsUndefined() {
							handler.Invoke(data)
						}
					}
				}
				return nil
			})

			conn.onClose = js.FuncOf(func(this js.Value, args []js.Value) interface{} {
				// Call JavaScript close handler
				handlers := js.Global().Get("wasmWebSocketCloseHandlers")
				if !handlers.IsUndefined() {
					handler := handlers.Get(fmt.Sprintf("%d", connID))
					if !handler.IsUndefined() {
						handler.Invoke()
					}
				}

				// Clean up connection
				connectionsMu.Lock()
				delete(connections, connID)
				connectionsMu.Unlock()

				return nil
			})

			conn.onError = js.FuncOf(func(this js.Value, args []js.Value) interface{} {
				if len(args) > 0 {
					errorMsg := args[0].String()
					// Call JavaScript error handler
					handlers := js.Global().Get("wasmWebSocketErrorHandlers")
					if !handlers.IsUndefined() {
						handler := handlers.Get(fmt.Sprintf("%d", connID))
						if !handler.IsUndefined() {
							handler.Invoke(errorMsg)
						}
					}
				}
				return nil
			})

			conn.onOpen = js.FuncOf(func(this js.Value, args []js.Value) interface{} {
				fmt.Printf("[WASM] Connection %d opened\n", connID)
				return nil
			})

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

// wasmWebSocketSendJS sends data over a WebSocket connection
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
