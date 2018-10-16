const Router = require('koa-router')
const User = require('../app/controllers/user_controller')
const config = require('../config'),
      baseApi = config.baseApi

const router = new Router()
const api = 'user'

router.prefix(`/${baseApi}/${api}`)

router
    .get('/', async (ctx, next) => {
        await ctx.render('index')
        next()
    })
    .post('/', User.showUser)
    .post('/login', User.login)
    .get('/list', User.getMany)
    .post('/list', User.listUser)
    .get('/new', User.addUser)
    .post('/new', User.newUser)
    .get('/edit', (ctx, next) => {
        ctx.body = 'user edit'
    })
    .post('/edit', User.editUser)
    .get('/wxLogin', User.wxLogin)
    .get('/setSession/:id', User.setSession)
    .get('/findSession', User.findSession)

module.exports = router