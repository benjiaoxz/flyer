const mongoose = require('mongoose')
const dbConfig = require('../../config').db

const db = mongoose.createConnection(dbConfig.uri, dbConfig.options)

//models
require('./user')

exports.User = db.model('User')