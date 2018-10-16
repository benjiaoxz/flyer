const mongoose = require('mongoose'),
    configDB = require('../config').db

const db = mongoose.createConnection(configDB.uri, configDB.options)

const SessionSchema = {
    _id: String,
    data: Object,
    updatedAt: {
        default: Date.now,
        expires: 86400, // 1 day
        type: Date
    }
}

class SessionStore {
    constructor({
        expires = 86400,
        name = 'Session'
    } = {}) {
        const updatedAt = Object.assign({}, SessionSchema.updatedAt, { expires })

        this.session = db.model(name, new mongoose.Schema(Object.assign({}, SessionSchema, { updatedAt }), { versionKey: false }))
    }

    /**
     * get session object by key
     */
    async get(key, maxAge, { rolling }) {
        const { data } = this.session.findById(key, async(err, res) => {
            if(err) {
                return new Error('db error.')
            }

            console.log(res)
        })

        return data
    }

    /**
     * set session object for key, with a maxAge (in ms)
     */
    async set(key, sess, maxAge, { rolling, changed }) {
        if(changed || rolling) {
            const record = {
                _id: key,
                data: sess,
                updatedAt: Date.now()
            }

            await this.session.findByIdAndUpdate(key, record, { upsert: true, safe: true })
        }

        return sess
    }

    /**
     * destroy session for key
     */
    async destroy(key) {
        return this.session.remove({ _id: key})
    }
}

module.exports = SessionStore