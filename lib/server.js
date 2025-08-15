// Required Node.js core modules
const net = require('net');
const dns = require('dns');
const util = require('util');
const { EventEmitter } = require('events');

// Local module imports
const Parser = require('./server.parser');
const { ipbytes } = require('./utils');
const { ATYP, REP } = require('./constants');

/**
 * Generates a random connection ID for tracking socket connections
 * @returns {string} Random alphanumeric connection ID
 */
function generateConnectionId() {
  return Math.random().toString(36).substring(2, 15) + 
         Math.random().toString(36).substring(2, 15);
}

// Bandwidth tracking storage
const connectionBandwidth = new Map();

// Pre-defined response buffers
const BUF_AUTH_NO_ACCEPT = new Buffer([0x05, 0xFF]);
const BUF_REP_INTR_SUCCESS = new Buffer([
  0x05,
  REP.SUCCESS,
  0x00,
  0x01,
  0x00, 0x00, 0x00, 0x00,
  0x00, 0x00
]);
const BUF_REP_DISALLOW = new Buffer([0x05, REP.DISALLOW]);
const BUF_REP_CMDUNSUPP = new Buffer([0x05, REP.CMDUNSUPP]);

/**
 * SOCKS5 Server implementation
 * @param {Object} options - Server configuration options
 * @param {Function} listener - Connection event listener
 * @returns {Server} Server instance
 */
function Server(options, listener) {
  if (!(this instanceof Server)) {
    return new Server(options, listener);
  }

  const self = this;

  // Handle optional arguments
  if (typeof options === 'function') {
    self.on('connection', options);
    options = undefined;
  } else if (typeof listener === 'function') {
    self.on('connection', listener);
  }

  EventEmitter.call(this);

  // Create TCP server
  this._srv = new net.Server(function(socket) {
    if (self._connections >= self.maxConnections) {
      socket.destroy();
      return;
    }
    
    ++self._connections;
    
    socket.once('close', function(had_err) {
      --self._connections;
      // Emit connectionClosed event when any socket is closed
      if (socket.connectionId) {
        const stats = connectionBandwidth.get(socket.connectionId);
        self.emit('connectionClosed', socket.connectionId, stats);
        // Clean up bandwidth tracking
        connectionBandwidth.delete(socket.connectionId);
      }
    });
    
    self._onConnection(socket);
  })
  .on('error', function(err) {
    self.emit('error', err);
  })
  .on('listening', function() {
    self.emit('listening');
  })
  .on('close', function() {
    self.emit('close');
  });

  // Initialize authentication methods
  this._auths = [];
  if (options && Array.isArray(options.auths)) {
    for (let i = 0, len = options.auths.length; i < len; ++i) {
      this.useAuth(options.auths[i]);
    }
  }
  
  this._debug = (options && typeof options.debug === 'function') 
    ? options.debug 
    : undefined;

  this._connections = 0;
  this.maxConnections = Infinity;
}

// Inherit from EventEmitter
util.inherits(Server, EventEmitter);

/**
 * Handle new client connections
 * @param {net.Socket} socket - Client socket connection
 */
Server.prototype._onConnection = function(socket) {
  const self = this;
  const parser = new Parser(socket);
      
  // Generate a unique connection ID for this socket
  socket.connectionId = generateConnectionId();
  
  // Initialize bandwidth tracking for this connection
  connectionBandwidth.set(socket.connectionId, {
    srcTxBytes: 0,
    srcRxBytes: 0,
    trgTxBytes: 0,
    trgRxBytes: 0,
  });
  
  parser
    .on('methods', function(methods) {
      const auths = self._auths;
      
      for (let a = 0, alen = auths.length; a < alen; ++a) {
        for (let m = 0, mlen = methods.length; m < mlen; ++m) {
          if (methods[m] === auths[a].METHOD) {
            auths[a].server(socket, function(result) {
              if (result === true) {
                parser.authed = true;
                parser.start();
              } else {
                if (util.isError(result) && self._debug) {
                  self._debug('Error: ' + result.message);
                }
                socket.end();
              }
            });
            
            socket.write(new Buffer([0x05, auths[a].METHOD]));
            socket.resume();
            return;
          }
        }
      }
      
      socket.end(BUF_AUTH_NO_ACCEPT);
    })
    .on('request', function(reqInfo) {
      if (reqInfo.cmd !== 'connect') {
        return socket.end(BUF_REP_CMDUNSUPP);
      }

      // Store source connection information
      reqInfo.srcAddr = socket.remoteAddress;
      reqInfo.srcPort = socket.remotePort;
      reqInfo.socket = socket;

      let handled = false;

      /**
       * Consume bandwidth for a specific direction
       * @param {string} direction - 'client' or 'server'
       * @param {number} bytes - Number of bytes
       */
      function consumeBandwidth(direction, bytes) {
        const bandwidth = connectionBandwidth.get(socket.connectionId);
        if (!bandwidth) return;

        bytes = Number(bytes) || 0;
        if (bytes <= 0) return;

        bandwidth[direction] += bytes;
      }

      /**
       * Accept the connection request
       * @param {boolean} intercept - Whether to intercept the connection
       * @returns {net.Socket} Socket if intercepted, undefined otherwise
       */
      function accept(intercept) {
        if (handled) {
          return;
        }
        
        handled = true;
        
        if (socket.writable) {
          if (intercept) {
            socket.write(BUF_REP_INTR_SUCCESS);
            socket.removeListener('error', onErrorNoop);
            
            process.nextTick(function() {
              socket.resume();
            });
            
            return socket;
          } else {
            proxySocket(socket, reqInfo);
          }
        }
      }

      /**
       * Deny the connection request
       */
      function deny() {
        if (handled) {
          return;
        }
        
        handled = true;
        
        if (socket.writable) {
          socket.end(BUF_REP_DISALLOW);
        }
      }

      if (self._events.connection) {
        // Add username and password to the event parameters
        self.emit('connection', reqInfo, accept, deny, socket.username, socket.password, consumeBandwidth, socket.connectionId);
        return;
      }

      proxySocket(socket, reqInfo);
    });

  /**
   * Handle socket close event
   */
  function onClose() {
    if (socket.dstSock && socket.dstSock.writable) {
      socket.dstSock.end();
    }
    socket.dstSock = undefined;
  }

  socket
    .on('error', onErrorNoop)
    .on('end', onClose)
    .on('close', onClose);
};

/**
 * Register an authentication method
 * @param {Object} auth - Authentication handler
 * @returns {Server} this for chaining
 */
Server.prototype.useAuth = function(auth) {
  if (typeof auth !== 'object' ||
      typeof auth.server !== 'function' ||
      auth.server.length !== 2) {
    throw new Error('Invalid authentication handler');
  } else if (this._auths.length >= 255) {
    throw new Error('Too many authentication handlers (limited to 255).');
  }

  this._auths.push(auth);

  return this;
};

// Server interface methods that proxy to the underlying TCP server

Server.prototype.listen = function() {
  this._srv.listen.apply(this._srv, arguments);
  return this;
};

Server.prototype.address = function() {
  return this._srv.address();
};

Server.prototype.getConnections = function(cb) {
  this._srv.getConnections(cb);
};

Server.prototype.close = function(cb) {
  this._srv.close(cb);
  return this;
};

Server.prototype.ref = function() {
  this._srv.ref();
};

Server.prototype.unref = function() {
  this._srv.unref();
};

/**
 * Get bandwidth statistics for a connection
 * @param {string} connectionId - The connection ID
 * @returns {Object|null} Bandwidth statistics or null if not found
 */
Server.prototype.getBandwidthStats = function(connectionId) {
  return connectionBandwidth.get(connectionId) || null;
};

// Exports
exports.Server = Server;
exports.createServer = function(opts, listener) {
  return new Server(opts, listener);
};

/**
 * No-op error handler
 */
function onErrorNoop(err) {}

/**
 * Establish connection to destination server and setup proxy
 * @param {net.Socket} socket - Client socket
 * @param {Object} req - Connection request info
 */
function proxySocket(socket, req) {
  dns.lookup(req.dstAddr, function(err, dstIP) {
    if (err) {
      handleProxyError(socket, err);
      return;
    }

    /**
     * Handle destination connection errors
     */
    function onError(err) {
      if (!connected) {
        handleProxyError(socket, err);
      }
    }

    const dstSock = new net.Socket();
    let connected = false;

    dstSock.setKeepAlive(false);
    
    dstSock
      .on('error', onError)
      .on('connect', function() {
        connected = true;
        
        if (socket.writable) {
          const localbytes = ipbytes(dstSock.localAddress);
          const len = localbytes.length;
          const bufrep = new Buffer(6 + len);
          let p = 4;
          
          bufrep[0] = 0x05;
          bufrep[1] = REP.SUCCESS;
          bufrep[2] = 0x00;
          bufrep[3] = (len === 4 ? ATYP.IPv4 : ATYP.IPv6);
          
          for (let i = 0; i < len; ++i, ++p) {
            bufrep[p] = localbytes[i];
          }
          
          bufrep.writeUInt16BE(dstSock.localPort, p, true);

          socket.write(bufrep);

          socket.pipe(dstSock).pipe(socket);
          socket.resume();
        } else if (dstSock.writable) {
          dstSock.end();
        }
      })
      .connect(req.dstPort, dstIP);
      
    socket.dstSock = dstSock;
  });
}

/**
 * Handle errors during proxy connection setup
 * @param {net.Socket} socket - Client socket
 * @param {Error} err - Error object
 */
function handleProxyError(socket, err) {
  if (socket.writable) {
    const errbuf = new Buffer([0x05, REP.GENFAIL]);
    
    if (err.code) {
      switch (err.code) {
        case 'ENOENT':
        case 'ENOTFOUND':
        case 'ETIMEDOUT':
        case 'EHOSTUNREACH':
          errbuf[1] = REP.HOSTUNREACH;
          break;
        case 'ENETUNREACH':
          errbuf[1] = REP.NETUNREACH;
          break;
        case 'ECONNREFUSED':
          errbuf[1] = REP.CONNREFUSED;
          break;
      }
    }
    
    socket.end(errbuf);
  }
}