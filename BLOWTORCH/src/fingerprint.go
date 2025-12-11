//go:build js && wasm
// +build js,wasm

package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sync"
	"syscall/js"
	"time"
)

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

var (
	fingerprintData FingerprintData
	ipAddresses     []string
	ipMutex         sync.Mutex
)

// GenerateFingerprint collects browser fingerprint data and returns it as a Promise.
// This function can be called directly from other WASM programs or exposed to JavaScript.
func GenerateFingerprint(this js.Value, args []js.Value) interface{} {
	promise := js.Global().Get("Promise").New(js.FuncOf(func(this js.Value, args []js.Value) interface{} {
		resolve := args[0]
		reject := args[1]

		go func() {
			defer func() {
				if r := recover(); r != nil {
					reject.Invoke(fmt.Sprintf("Panic in GenerateFingerprint: %v", r))
				}
			}()

			jsonData, err := CollectFingerprint()
			if err != nil {
				reject.Invoke(fmt.Sprintf("Failed to collect fingerprint: %v", err))
				return
			}

			resolve.Invoke(string(jsonData))
		}()

		return nil
	}))

	return promise
}

// CollectFingerprint collects browser fingerprint data synchronously and returns JSON.
// Use this function when calling from other Go WASM programs.
func CollectFingerprint() ([]byte, error) {
	// Reset IP addresses for this collection
	ipMutex.Lock()
	ipAddresses = []string{}
	ipMutex.Unlock()

	// Collect synchronous fingerprint data
	collectFingerprint()

	// Start WebRTC IP detection asynchronously
	detectIPAddresses()

	// Wait for IPs with timeout
	time.Sleep(2 * time.Second)

	// Update fingerprint with collected IPs
	ipMutex.Lock()
	fingerprintData.IPAddresses = ipAddresses
	ipMutex.Unlock()

	// Generate final hash
	fingerprintData.Hash = generateHash()

	jsonData, err := json.Marshal(fingerprintData)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal JSON: %w", err)
	}

	return jsonData, nil
}

// GetFingerprintData returns the most recently collected fingerprint data.
// Call CollectFingerprint() first to populate this data.
func GetFingerprintData() FingerprintData {
	return fingerprintData
}

func collectFingerprint() {
	navigator := js.Global().Get("navigator")
	window := js.Global().Get("window")
	screen := window.Get("screen")

	// Basic navigator properties
	fingerprintData.UserAgent = safeGetString(navigator, "userAgent")
	fingerprintData.Language = safeGetString(navigator, "language")
	fingerprintData.Languages = safeGetStringArray(navigator, "languages")
	fingerprintData.Platform = safeGetString(navigator, "platform")
	fingerprintData.HardwareConcurrency = safeGetInt(navigator, "hardwareConcurrency")
	fingerprintData.DeviceMemory = safeGetFloat(navigator, "deviceMemory")
	fingerprintData.DoNotTrack = safeGetString(navigator, "doNotTrack")
	fingerprintData.CpuClass = safeGetString(navigator, "cpuClass")

	// Screen properties
	fingerprintData.ScreenWidth = safeGetInt(screen, "width")
	fingerprintData.ScreenHeight = safeGetInt(screen, "height")
	fingerprintData.ScreenDepth = safeGetInt(screen, "pixelDepth")
	fingerprintData.ColorDepth = safeGetInt(screen, "colorDepth")
	fingerprintData.PixelRatio = safeGetFloat(window, "devicePixelRatio")

	// Timezone
	date := js.Global().Get("Date").New()
	fingerprintData.TimezoneOffset = safeGetInt(date, "getTimezoneOffset")
	fingerprintData.Timezone = getTimezone()

	// Storage capabilities
	fingerprintData.SessionStorage = hasStorage("sessionStorage")
	fingerprintData.LocalStorage = hasStorage("localStorage")
	fingerprintData.IndexedDB = !navigator.Get("indexedDB").IsUndefined()
	fingerprintData.OpenDatabase = !window.Get("openDatabase").IsUndefined()

	// Plugins
	fingerprintData.Plugins = getPlugins()

	// Canvas fingerprint
	fingerprintData.Canvas = getCanvasFingerprint()

	// WebGL fingerprint
	webglData := getWebGLFingerprint()
	fingerprintData.WebGL = webglData["hash"]
	fingerprintData.WebGLVendor = webglData["vendor"]
	fingerprintData.WebGLRenderer = webglData["renderer"]

	// Audio context fingerprint
	fingerprintData.AudioContext = getAudioFingerprint()

	// Font detection
	fingerprintData.Fonts = getAvailableFonts()
}

func safeGetString(obj js.Value, prop string) string {
	defer func() { recover() }()
	val := obj.Get(prop)
	if val.IsUndefined() || val.IsNull() {
		return ""
	}
	return val.String()
}

func safeGetInt(obj js.Value, prop string) int {
	defer func() { recover() }()
	val := obj.Get(prop)
	if val.IsUndefined() || val.IsNull() {
		return 0
	}
	if val.Type() == js.TypeFunction {
		result := val.Invoke()
		if !result.IsUndefined() && !result.IsNull() {
			return result.Int()
		}
		return 0
	}
	return val.Int()
}

func safeGetFloat(obj js.Value, prop string) float64 {
	defer func() { recover() }()
	val := obj.Get(prop)
	if val.IsUndefined() || val.IsNull() {
		return 0
	}
	return val.Float()
}

func safeGetStringArray(obj js.Value, prop string) []string {
	defer func() { recover() }()
	val := obj.Get(prop)
	if val.IsUndefined() || val.IsNull() {
		return []string{}
	}

	length := val.Length()
	result := make([]string, length)
	for i := 0; i < length; i++ {
		result[i] = val.Index(i).String()
	}
	return result
}

func hasStorage(storageType string) bool {
	defer func() { recover() }()
	window := js.Global().Get("window")
	storage := window.Get(storageType)
	if storage.IsUndefined() || storage.IsNull() {
		return false
	}

	// Try to use it
	testKey := "__test__"
	storage.Call("setItem", testKey, "test")
	storage.Call("removeItem", testKey)
	return true
}

func getTimezone() string {
	defer func() { recover() }()
	intl := js.Global().Get("Intl")
	if intl.IsUndefined() {
		return ""
	}
	dateTimeFormat := intl.Get("DateTimeFormat")
	if dateTimeFormat.IsUndefined() {
		return ""
	}

	result := dateTimeFormat.New().Call("resolvedOptions")
	if result.IsUndefined() {
		return ""
	}

	tz := result.Get("timeZone")
	if tz.IsUndefined() {
		return ""
	}
	return tz.String()
}

func getPlugins() []string {
	defer func() { recover() }()

	navigator := js.Global().Get("navigator")
	plugins := navigator.Get("plugins")

	if plugins.IsUndefined() || plugins.IsNull() {
		return []string{}
	}

	length := plugins.Length()
	result := make([]string, 0, length)

	for i := 0; i < length; i++ {
		plugin := plugins.Index(i)
		if !plugin.IsUndefined() && !plugin.IsNull() {
			name := plugin.Get("name")
			if !name.IsUndefined() && !name.IsNull() {
				result = append(result, name.String())
			}
		}
	}

	return result
}

func getCanvasFingerprint() string {
	defer func() {
		if r := recover(); r != nil {
			// Gracefully handle canvas failures
		}
	}()

	document := js.Global().Get("document")
	canvas := document.Call("createElement", "canvas")
	if canvas.IsUndefined() {
		return ""
	}

	canvas.Set("width", 200)
	canvas.Set("height", 50)

	ctx := canvas.Call("getContext", "2d")
	if ctx.IsUndefined() || ctx.IsNull() {
		return ""
	}

	// Draw text with various properties
	ctx.Set("textBaseline", "top")
	ctx.Set("font", "14px 'Arial'")
	ctx.Set("textBaseline", "alphabetic")
	ctx.Set("fillStyle", "#f60")
	ctx.Call("fillRect", 125, 1, 62, 20)
	ctx.Set("fillStyle", "#069")
	ctx.Call("fillText", "Browser Fingerprint 🖐️", 2, 15)
	ctx.Set("fillStyle", "rgba(102, 204, 0, 0.7)")
	ctx.Set("font", "18px Arial")
	ctx.Call("fillText", "Canvas FP", 4, 17)

	dataURL := canvas.Call("toDataURL")
	if dataURL.IsUndefined() {
		return ""
	}

	return dataURL.String()
}

func getWebGLFingerprint() map[string]string {
	result := map[string]string{
		"hash":     "",
		"vendor":   "",
		"renderer": "",
	}

	defer func() {
		if r := recover(); r != nil {
			// Gracefully handle WebGL failures
		}
	}()

	document := js.Global().Get("document")
	canvas := document.Call("createElement", "canvas")
	if canvas.IsUndefined() {
		return result
	}

	// Try WebGL2 first, fall back to WebGL
	var gl js.Value
	gl = canvas.Call("getContext", "webgl2")
	if gl.IsNull() || gl.IsUndefined() {
		gl = canvas.Call("getContext", "webgl")
	}
	if gl.IsNull() || gl.IsUndefined() {
		gl = canvas.Call("getContext", "experimental-webgl")
	}

	if gl.IsNull() || gl.IsUndefined() {
		return result
	}

	// Get debug info extension
	debugInfo := gl.Call("getExtension", "WEBGL_debug_renderer_info")
	if !debugInfo.IsNull() && !debugInfo.IsUndefined() {
		vendorParam := debugInfo.Get("UNMASKED_VENDOR_WEBGL")
		rendererParam := debugInfo.Get("UNMASKED_RENDERER_WEBGL")

		if !vendorParam.IsUndefined() {
			vendor := gl.Call("getParameter", vendorParam)
			if !vendor.IsUndefined() && !vendor.IsNull() {
				result["vendor"] = vendor.String()
			}
		}

		if !rendererParam.IsUndefined() {
			renderer := gl.Call("getParameter", rendererParam)
			if !renderer.IsUndefined() && !renderer.IsNull() {
				result["renderer"] = renderer.String()
			}
		}
	}

	// Collect various WebGL parameters
	params := []int{
		gl.Get("VERSION").Int(),
		gl.Get("SHADING_LANGUAGE_VERSION").Int(),
		gl.Get("VENDOR").Int(),
		gl.Get("RENDERER").Int(),
	}

	webglData := ""
	for _, param := range params {
		val := gl.Call("getParameter", param)
		if !val.IsUndefined() && !val.IsNull() {
			webglData += val.String() + "|"
		}
	}

	result["hash"] = hashString(webglData)
	return result
}

func getAudioFingerprint() string {
	defer func() {
		if r := recover(); r != nil {
			// Gracefully handle AudioContext failures
		}
	}()

	window := js.Global().Get("window")
	audioContextClass := window.Get("AudioContext")
	if audioContextClass.IsUndefined() {
		audioContextClass = window.Get("webkitAudioContext")
	}

	if audioContextClass.IsUndefined() {
		return ""
	}

	audioCtx := audioContextClass.New()
	if audioCtx.IsUndefined() {
		return ""
	}

	// Get audio context properties
	sampleRate := audioCtx.Get("sampleRate")
	state := audioCtx.Get("state")

	audioData := fmt.Sprintf("%v|%v", sampleRate, state)

	// Close the context
	audioCtx.Call("close")

	return hashString(audioData)
}

func getAvailableFonts() []string {
	defer func() {
		if r := recover(); r != nil {
			// Gracefully handle font detection failures
		}
	}()

	fontsToCheck := []string{
		"Arial", "Verdana", "Courier New", "Times New Roman", "Comic Sans MS",
		"Impact", "Georgia", "Trebuchet MS", "Arial Black", "Palatino",
		"Garamond", "Bookman", "Courier", "Helvetica", "Monaco",
	}

	document := js.Global().Get("document")
	baseFonts := []string{"monospace", "sans-serif", "serif"}
	testString := "mmmmmmmmmmlli"
	testSize := "72px"

	// Create spans for base fonts
	baseWidths := make(map[string]float64)

	for _, baseFont := range baseFonts {
		span := document.Call("createElement", "span")
		span.Set("textContent", testString)
		style := span.Get("style")
		style.Set("fontSize", testSize)
		style.Set("fontFamily", baseFont)

		body := document.Get("body")
		body.Call("appendChild", span)

		width := span.Get("offsetWidth").Float()
		baseWidths[baseFont] = width

		body.Call("removeChild", span)
	}

	// Test each font
	availableFonts := []string{}

	for _, font := range fontsToCheck {
		detected := false

		for _, baseFont := range baseFonts {
			span := document.Call("createElement", "span")
			span.Set("textContent", testString)
			style := span.Get("style")
			style.Set("fontSize", testSize)
			style.Set("fontFamily", fmt.Sprintf("'%s', %s", font, baseFont))

			body := document.Get("body")
			body.Call("appendChild", span)

			width := span.Get("offsetWidth").Float()

			body.Call("removeChild", span)

			if width != baseWidths[baseFont] {
				detected = true
				break
			}
		}

		if detected {
			availableFonts = append(availableFonts, font)
		}
	}

	return availableFonts
}

func detectIPAddresses() {
	defer func() {
		if r := recover(); r != nil {
			// Gracefully handle WebRTC failures
		}
	}()

	window := js.Global().Get("window")
	rtcPeerConnectionClass := window.Get("RTCPeerConnection")
	if rtcPeerConnectionClass.IsUndefined() {
		rtcPeerConnectionClass = window.Get("webkitRTCPeerConnection")
	}
	if rtcPeerConnectionClass.IsUndefined() {
		rtcPeerConnectionClass = window.Get("mozRTCPeerConnection")
	}

	if rtcPeerConnectionClass.IsUndefined() {
		return
	}

	// Create RTCPeerConnection config
	config := js.Global().Get("Object").New()
	iceServers := js.Global().Get("Array").New()
	stunServer := js.Global().Get("Object").New()
	stunServer.Set("urls", "stun:stun.l.google.com:19302")
	iceServers.Call("push", stunServer)
	config.Set("iceServers", iceServers)

	// Create peer connection
	pc := rtcPeerConnectionClass.New(config)

	// Create data channel
	pc.Call("createDataChannel", "")

	// Set up ICE candidate handler
	iceCandidateCallback := js.FuncOf(func(this js.Value, args []js.Value) interface{} {
		if len(args) == 0 {
			return nil
		}

		ice := args[0]
		if ice.IsUndefined() || ice.IsNull() {
			return nil
		}

		candidate := ice.Get("candidate")
		if candidate.IsUndefined() || candidate.IsNull() {
			return nil
		}

		candidateStr := candidate.Get("candidate")
		if candidateStr.IsUndefined() || candidateStr.IsNull() {
			return nil
		}

		candidateText := candidateStr.String()
		if candidateText == "" {
			return nil
		}

		// Parse IP from candidate string
		// Format: "candidate:... typ ... <IP> <port> ..."
		// We'll extract IPs using simple string parsing
		parts := js.Global().Get("String").New(candidateText).Call("split", " ")
		if parts.Length() > 4 {
			ip := parts.Index(4).String()

			// Check if it looks like an IP address (IPv4 or IPv6)
			if isValidIP(ip) {
				ipMutex.Lock()
				// Check for duplicates
				isDuplicate := false
				for _, existingIP := range ipAddresses {
					if existingIP == ip {
						isDuplicate = true
						break
					}
				}
				if !isDuplicate {
					ipAddresses = append(ipAddresses, ip)
				}
				ipMutex.Unlock()
			}
		}

		return nil
	})

	pc.Set("onicecandidate", iceCandidateCallback)

	// Create offer
	offerPromise := pc.Call("createOffer")

	successCallback := js.FuncOf(func(this js.Value, args []js.Value) interface{} {
		if len(args) > 0 {
			offer := args[0]
			pc.Call("setLocalDescription", offer)
		}
		return nil
	})

	errorCallback := js.FuncOf(func(this js.Value, args []js.Value) interface{} {
		// Silently handle errors
		return nil
	})

	offerPromise.Call("then", successCallback).Call("catch", errorCallback)
}

func isValidIP(ip string) bool {
	if ip == "" {
		return false
	}

	// Check for IPv4 pattern
	hasDigit := false
	hasDot := false
	for i := 0; i < len(ip); i++ {
		c := ip[i]
		if c >= '0' && c <= '9' {
			hasDigit = true
		} else if c == '.' {
			hasDot = true
		} else if c == ':' {
			// IPv6 - just check it has colons and hex chars
			hasColon := false
			hasHex := false
			for j := 0; j < len(ip); j++ {
				ch := ip[j]
				if ch == ':' {
					hasColon = true
				} else if (ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f') || (ch >= 'A' && ch <= 'F') {
					hasHex = true
				}
			}
			return hasColon && hasHex
		}
	}

	return hasDigit && hasDot
}

func hashString(data string) string {
	hash := sha256.Sum256([]byte(data))
	return hex.EncodeToString(hash[:])
}

func generateHash() string {
	// Create a concatenated string of all fingerprint data
	// Note: IPAddresses are intentionally excluded from the hash to ensure
	// the fingerprint remains consistent across different network connections
	data := fmt.Sprintf("%s|%s|%v|%s|%d|%f|%d|%d|%d|%d|%f|%s|%d|%v|%v|%v|%v|%s|%s|%v|%s|%s|%s|%s|%s|%v",
		fingerprintData.UserAgent,
		fingerprintData.Language,
		fingerprintData.Languages,
		fingerprintData.Platform,
		fingerprintData.HardwareConcurrency,
		fingerprintData.DeviceMemory,
		fingerprintData.ScreenWidth,
		fingerprintData.ScreenHeight,
		fingerprintData.ScreenDepth,
		fingerprintData.ColorDepth,
		fingerprintData.PixelRatio,
		fingerprintData.Timezone,
		fingerprintData.TimezoneOffset,
		fingerprintData.SessionStorage,
		fingerprintData.LocalStorage,
		fingerprintData.IndexedDB,
		fingerprintData.OpenDatabase,
		fingerprintData.CpuClass,
		fingerprintData.DoNotTrack,
		fingerprintData.Plugins,
		fingerprintData.Canvas,
		fingerprintData.WebGL,
		fingerprintData.WebGLVendor,
		fingerprintData.WebGLRenderer,
		fingerprintData.AudioContext,
		fingerprintData.Fonts,
	)

	return hashString(data)
}
