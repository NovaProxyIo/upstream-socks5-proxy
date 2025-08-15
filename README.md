Description
===========

Node.js implementation of an upstream socks5 proxy server with support of authentication and upstream proxy chaining.
This project inherits a legacy code (yet heavily modified to fit our needs) from the repository `mscdex/socksv5` and the interface has been inspired from the `apify/proxy-chain` repository.
All project contributions are welcome, and they'll be swiftly reviewed. This project has been developed for our own personal usage in our product [NovaProxy](https://novaproxy.io/).

Requirements
============

* [node.js](http://nodejs.org/) -- v18 or newer


Install
=======

    npm install upstream-socks5-proxy


Examples
========

* Server with username/password authentication and allowing all (authenticated) connections:

```javascript
const SocksServer = require('upstream-socks5-proxy');

const server = new SocksServer.UpstreamSocks({
    // Port where the server will listen.
    port: 1080,

    // Host where the proxy server will listen.
    host: '0.0.0.0',

    // Enables verbose logging
    verbose: true,

    // Enables authentication
    requireAuthentication: true,

    prepareRequestFunction: ({
        username,
        password,
        hostname,
        port,
        connectionId
    }) => {
        return {
            // Auth validation is done here
            requestAuthentication: (username && password) && (username !== 'admin' || password !== 'admin'),

            upstreamProxy: {
                host: 'residential.novaproxy.io',
                port: 9595,
                auth: {
                    username: 'username',
                    password: 'password'
                }
            },
        };
    },
});

server.listen(() => {
    console.log(`Proxy server is listening on port ${server.port}`);
});

// Emitted when HTTP connection is closed
server.on('connectionClosed', ({
    connectionId,
    stats
}) => {
    console.log(`Connection ${connectionId} closed`);
    console.dir(stats);
});

// Emitted when HTTP request fails
server.on('requestFailed', ({
    request,
    error
}) => {
    console.log(`Request ${request.url} failed`);
    console.error(error);
});

// Handle server errors
server.on('error', (error) => {
    console.error('Server error:', error);
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\nShutting down server...');
    server.close();
    process.exit(0);
});
```

* Server with no authentication and redirecting all connections to localhost:

```javascript
const SocksServer = require('upstream-socks5-proxy');

const server = new SocksServer.UpstreamSocks({
    // Port where the server will listen.
    port: 1080,

    // Host where the proxy server will listen.
    host: '0.0.0.0',

    // Enables verbose logging
    verbose: true,

    // Enables authentication
    requireAuthentication: false,
    ...
})
```
-----------------

The UpstreamSocks class provides a high-level interface for creating SOCKS5 proxy servers that can authenticate clients and route traffic through upstream SOCKS5 proxies.

**Constructor Options:**

* **port** - _number_ - Port where the server will listen (defaults to 1080).
* **host** - _string_ - Host where the proxy server will listen (defaults to '0.0.0.0').
* **verbose** - _boolean_ - Enables verbose logging (defaults to true).
* **requireAuthentication** - _boolean_ - Enables authentication (defaults to true).
* **prepareRequestFunction** - _function_ - Function called for each connection request to determine authentication and upstream proxy configuration.

**prepareRequestFunction Parameters:**

* **username** - _string_ - Client username (if authentication is enabled).
* **password** - _string_ - Client password (if authentication is enabled).
* **hostname** - _string_ - Destination hostname requested by the client.
* **port** - _number_ - Destination port requested by the client.
* **connectionId** - _string_ - Unique identifier for the connection.

**prepareRequestFunction Return Object:**

* **requestAuthentication** - _boolean_ - If true, the connection will be denied.
* **upstreamProxy** - _object_ - Configuration for the upstream SOCKS5 proxy:
  * **host** - _string_ - Upstream proxy hostname.
  * **port** - _number_ - Upstream proxy port.
  * **auth** - _object_ - Optional authentication for upstream proxy:
    * **username** - _string_ - Username for upstream proxy.
    * **password** - _string_ - Password for upstream proxy.

**Methods:**

* **listen(callback)** - Starts the server and calls the callback when ready.
* **close()** - Closes the server.

**Events:**

* **connectionClosed** - Emitted when a connection is closed, provides connectionId and stats.
* **error** - Emitted when server errors occur.
