// +build js,wasm

package main

import (
	"context"
	"net"
)

// DirectSocketDialer is a custom dialer that uses Direct Sockets API
type DirectSocketDialer struct{}

// Dial implements the Dial method for the custom dialer
func (d *DirectSocketDialer) Dial(network, address string) (net.Conn, error) {
	return NewDirectSocket(network, address)
}

// DialContext implements context-aware dialing
func (d *DirectSocketDialer) DialContext(ctx context.Context, network, address string) (net.Conn, error) {
	// For simplicity, ignoring context for now
	// In a production implementation, you'd want to handle context cancellation
	return NewDirectSocket(network, address)
}

// DirectSocketDialContext is a helper function for creating HTTP clients
func DirectSocketDialContext(ctx context.Context, network, addr string) (net.Conn, error) {
	return NewDirectSocket(network, addr)
}
