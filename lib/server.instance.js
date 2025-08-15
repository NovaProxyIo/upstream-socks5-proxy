const { Server: SocksServer } = require('./server');
const { SocksClient } = require("socks");
const { Transform } = require('stream');
const { EventEmitter } = require('events');

class UpstreamSocks extends EventEmitter {
    constructor(options = {}) {
        super();
        
        this.port = options.port || 1080;
        this.host = options.host || '0.0.0.0';
        this.verbose = options.verbose || false;
        this.prepareRequestFunction = options.prepareRequestFunction || null;
        this.requireAuthentication = options.requireAuthentication || false;
        
        this.server = null;
        this.connections = new Map();
    }

    async listen(callback) {
        return new Promise((resolve) => {
            this.server = new SocksServer();
            
            this.server.on('connection', (info, accept, deny, username, password, consumeBandwidth, connectionId) => {
                const { dstAddr, dstPort } = info;
                
                if (this.verbose) {
                    console.log(`[${connectionId}] New connection request to ${dstAddr}:${dstPort}`);
                    console.log(`[${connectionId}] Username: ${username || 'undefined'}, Password: ${password ? '***' : 'undefined'}`);
                }

                try {
                    const requestInfo = {
                        username: username || '',
                        password: password || '',
                        hostname: dstAddr,
                        port: dstPort,
                        connectionId: connectionId
                    };

                    if (this.verbose) {
                        console.log(`[${connectionId}] Calling prepareRequestFunction with:`, {
                            ...requestInfo,
                            password: requestInfo.password ? '***' : 'undefined'
                        });
                    }

                    const result = this.prepareRequestFunction(requestInfo);

                    if (this.verbose) {
                        console.log(`[${connectionId}] prepareRequestFunction result:`, {
                            ...result,
                            upstreamProxy: result?.upstreamProxy ? 'present' : 'missing'
                        });
                    }

                    this.handleAuthenticatedConnection(result, info, accept, deny, consumeBandwidth, connectionId);
                } catch (err) {
                    console.error(`[${connectionId}] Error in prepareRequestFunction:`, err);
                    deny();
                }
            });

            this.server.listen(this.port, this.host, () => {
                if (this.verbose) {
                    console.log(`Proxy server is listening on ${this.host}:${this.port}`);
                }
                if (callback) callback();
                resolve(this);
            });

            this.setupEventListeners();
        });
    }

    handleAuthenticatedConnection(result, info, accept, deny, consumeBandwidth, connectionId) {
        const { dstAddr, dstPort } = info;

        if (result.requestAuthentication) {
            if (this.verbose) {
                console.log(`[${connectionId}] Authentication required for ${dstAddr}:${dstPort}`);
            }
            deny();
            return;
        }

        this.handleSocksUpstreamProxy(result.upstreamProxy, info, accept, deny, consumeBandwidth, connectionId);
    }

    handleSocksUpstreamProxy(upstreamProxy, info, accept, deny, consumeBandwidth, connectionId) {
        const { dstAddr, dstPort } = info;
        
        const connectionOptions = {
            proxy: {
                ipaddress: upstreamProxy.host,
                port: upstreamProxy.port,
                type: 5,
            },
            command: "connect",
            destination: { host: dstAddr, port: dstPort },
        };

        if (upstreamProxy.auth) {
            connectionOptions.proxy.userId = upstreamProxy.auth.username;
            connectionOptions.proxy.password = upstreamProxy.auth.password;
        }

        SocksClient.createConnection(connectionOptions)
            .then(({ socket }) => {
                const outbound = accept(true);
                
                // Track the connection immediately after accepting it
                this.trackConnection(connectionId, { 
                    hostname: dstAddr, 
                    port: dstPort,
                    upstreamProxy: upstreamProxy
                });
                
                if (this.verbose) {
                    console.log(`[${connectionId}] SOCKS upstream proxy connection established to ${dstAddr}:${dstPort}`);
                }
                
                try {
                    this.setupStreamPiping(outbound, socket, consumeBandwidth, connectionId);
                } catch (err) {
                    console.error(`[${connectionId}] Failed to setup stream piping:`, err.message);
                    // Clean up the connection and close the socket
                    this.connections.delete(connectionId);
                    socket.end();
                    outbound.end();
                }
            })
            .catch((err) => {
                console.error(`[${connectionId}] SOCKS upstream proxy connection error:`, err.message);
                deny();
            });
    }
    
    setupStreamPiping(outbound, socket, consumeBandwidth, connectionId) {
        try {
            // Create transform streams for bandwidth tracking
            const clientToProxyCapture = new Transform({
                transform(chunk, encoding, callback) {
                    consumeBandwidth('srcRxBytes', chunk.length);
                    callback(null, chunk);
                }
            });
            
            const proxyToServerCapture = new Transform({
                transform(chunk, encoding, callback) {
                    consumeBandwidth('trgTxBytes', chunk.length);
                    callback(null, chunk);
                }
            });
            
            const serverToProxyCapture = new Transform({
                transform(chunk, encoding, callback) {
                    consumeBandwidth('trgRxBytes', chunk.length);
                    callback(null, chunk);
                }
            });
            
            const proxyToClientCapture = new Transform({
                transform(chunk, encoding, callback) {
                    consumeBandwidth('srcTxBytes', chunk.length);
                    callback(null, chunk);
                }
            });
            
            // Connect the streams
            outbound
                .pipe(clientToProxyCapture)
                .pipe(proxyToServerCapture)
                .pipe(socket);
                
            socket
                .pipe(serverToProxyCapture)
                .pipe(proxyToClientCapture)
                .pipe(outbound);

            // Handle errors
            socket.on("error", (err) => {
                if (this.verbose) {
                    console.error(`[${connectionId}] Socket error: ${err.message}`);
                }
                outbound.end();
            });
            
            outbound.on("error", (err) => {
                if (this.verbose) {
                    console.error(`[${connectionId}] Outbound error: ${err.message}`);
                }
                socket.end();
            });
        } catch (err) {
            if (this.verbose) {
                console.error(`[${connectionId}] Error setting up stream piping: ${err.message}`);
            }
            // Clean up the connection if there's an error during setup
            this.connections.delete(connectionId);
            throw err;
        }
    }

    trackConnection(connectionId, info) {
        if (this.verbose) {
            console.log(`[${connectionId}] Tracking connection to ${info.hostname}:${info.port}`);
        }
        
        this.connections.set(connectionId, {
            ...info,
            startTime: Date.now(),
            stats: {
                srcRxBytes: 0,
                srcTxBytes: 0,
                trgRxBytes: 0,
                trgTxBytes: 0
            }
        });
        
        if (this.verbose) {
            console.log(`[${connectionId}] Connection tracked. Total connections: ${this.connections.size}`);
        }
    }

    setupEventListeners() {
        this.server.on("error", (err) => {
            console.error(`Proxy server error: ${err.message}`);
            this.emit('error', err);
        });
        
        this.server.on("connectionClosed", (connectionId, stats) => {
            if (this.verbose) {
                console.log(`[${connectionId}] Connection closed event received with stats:`, stats);
            }
            
            const connection = this.connections.get(connectionId);
            if (connection) {
                const finalStats = {
                    ...connection.stats,
                    ...stats,
                    duration: Date.now() - connection.startTime
                };
                
                if (this.verbose) {
                    console.log(`[${connectionId}] Connection closed to ${connection.hostname}:${connection.port}`);
                    console.log(`[${connectionId}] Final stats:`, finalStats);
                }
                
                this.emit('connectionClosed', { connectionId, stats: finalStats });
                this.connections.delete(connectionId);
                
                if (this.verbose) {
                    console.log(`[${connectionId}] Connection removed. Total connections: ${this.connections.size}`);
                }
            } else {
                if (this.verbose) {
                    console.log(`[${connectionId}] Connection not found in tracking map. Available connections:`, Array.from(this.connections.keys()));
                } else {
                    console.log('Connection not found', connectionId);
                }
            }
        });

        if (this.requireAuthentication) {
            const UserPassword = require('./auth/UserPassword');
            this.server.useAuth(UserPassword(async (username, password, connectionId, cb) => {
                cb(true);
            }));
        } else {
            const None = require('./auth/None');
            this.server.useAuth(None());
        }
    }

    close() {
        if (this.server) {
            this.server.close();
        }
    }
}

// Export the main class
module.exports = {
    Server: UpstreamSocks
};