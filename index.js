const Koa = require('koa')
const BodyParse = require('koa-body')
const serve = require('koa-static')
const routing = require('./routes')
const logger = require('./common/logger')
const request_log = require('./middlewares/request_log')
const path = require('path')
const render = require('koa-ejs')
const { port } = require('./config')
const session = require('koa-session')
const SessionStore = require('./middlewares/sessionStore')

const app = new Koa()

app.use(BodyParse())
app.use(serve(path.join(__dirname, 'public')))
render(app, {
    root: path.join(__dirname, 'resource'),
    layout: false,
    viewExt: 'html',
    cache: false,
    debug: false
})

//session
app.keys = ['some secret hurr']
app.use(session({
    key: 'koa:sess',
    maxAge: 86400000,
    autoCommit: true,
    overwrite: true,
    httpOnly: true,
    signed: true,
    rolling: false,
    renew: false,
    store: new SessionStore({
        expires: 86400,
        name: 'Session'
    })
}, app))

//request log
app.use(request_log)

//router
routing(app)

app.listen(port, () => {
    logger.info('listening on port ' + port)
})

app.on('error', function (err) {
    logger.error(err)
})