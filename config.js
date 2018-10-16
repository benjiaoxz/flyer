const path = require('path')
const fs = require('fs')

let config = null

if(process.env.NODE_ENV == 'production') {
    config = {
        port: 3000,
        clientPort: 5000,
        baseApi: 'api',
        log_dir: path.join(__dirname, 'logs'),
        db: {
            uri: 'mongodb://benjiaoxz:abc123456@47.52.91.219:27017/demo1',
            options: {
                useNewUrlParser: true,
                autoIndex: false, // Don't build indexes
                reconnectTries: Number.MAX_VALUE, // Never stop trying to reconnect
                reconnectInterval: 500, // Reconnect every 500ms
                poolSize: 100, // Maintain up to 10 socket connections
                // If not connected, return errors immediately rather than waiting for reconnect
                bufferMaxEntries: 0,
                connectTimeoutMS: 10000, // Give up initial connection after 10 seconds
                socketTimeoutMS: 45000, // Close sockets after 45 seconds of inactivity
                family: 4 // Use IPv4, skip trying IPv6
            }
        },
        jwt: {
            payload: {

            },
            secretOrPrivateKey: {
                key: fs.readFileSync('doc/private.key', { encoding: 'utf-8' }),
                passphrase: '445088977w'
            },
            options: {
                algorithm: 'RS256',
                expiresIn: '1h',
                issuer: 'benjiaoxz'
            }
        },
        miniprogram: {
            appid: 'wxf24dabbb0332efd2',
            secret: '149721a7df5d52e8c983e571e8b6e616'
        }
    }
} else if (process.env.NODE_ENV == 'development') {
    config = {
        port: 3000,
        clientPort: 5000,
        baseApi: 'api',
        log_dir: path.join(__dirname, 'logs'),
        db: {
            uri: 'mongodb://localhost:27017/demo1',
            options: {
                useNewUrlParser: true,
                autoIndex: false, // Don't build indexes
                reconnectTries: Number.MAX_VALUE, // Never stop trying to reconnect
                reconnectInterval: 500, // Reconnect every 500ms
                poolSize: 100, // Maintain up to 10 socket connections
                // If not connected, return errors immediately rather than waiting for reconnect
                bufferMaxEntries: 0,
                connectTimeoutMS: 10000, // Give up initial connection after 10 seconds
                socketTimeoutMS: 45000, // Close sockets after 45 seconds of inactivity
                family: 4 // Use IPv4, skip trying IPv6
            }
        },
        jwt: {
            payload: {

            },
            secretOrPrivateKey: {
                key: fs.readFileSync('doc/private.key', { encoding: 'utf-8' }),
                passphrase: '445088977w'
            },
            options: {
                algorithm: 'RS256',
                expiresIn: '1h',
                issuer: 'benjiaoxz'
            }
        },
        miniprogram: {
            appid: 'wxf24dabbb0332efd2',
            secret: '149721a7df5d52e8c983e571e8b6e616'
        }
    }
}

module.exports = config