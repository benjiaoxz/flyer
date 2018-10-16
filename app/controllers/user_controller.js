const Models = require('../models/index'),
      User = Models.User
const mongoose = require('mongoose')
const Config = require('../../config')
const axios = require('axios')
const jsonwebtoken = require('jsonwebtoken')

/**
 * 用户端控制器
 * 
 * @method login 登录
 * @method wxLogin 微信登录
 * 
 * @return 返回说明
 *  - @code {Number} 返回状态码
 *      - 0 成功
 *      - 1001 已存在
 *      - 1002 密码错误
 *      - 1010 参数错误
 *      - 1018 数据库错误
 *      - 1019 axios请求错误
 *  - @message {String} 返回说明信息
 *  - @data {JSON.Object} 返回数据
 */
class UserControllers {
    /**
     * 登录
     * 
     * @type {Object} ctx.request.body  请求传递参数
     * @type {String} account  账号
     * @type {String} password  密码
     * 
     * @return 返回说明
     *  - 账号和密码必填，否则返回code=1010
     *  - 查询账号，存在则返回用户信息，数据库辅助的键值不返回，且密码也不返回
     *  - 查询账号不存在，则创建新账号，返回新账号信息，初创账号信息只有账号和创建时间
     *  - 已有账号返回code=1001，新建账号返回code=0
     */
    async login(ctx, next) {
        const data = ctx.request.body,
              account = data.account,
              password = data.password

        //check params null
        if (!account) {
            return ctx.body = {
                code: 1010,
                message: 'account can`t null'
            }
        }

        if (!password) {
            return ctx.body = {
                code: 1010,
                message: 'password can`t null'
            }
        }

        //密码加密：hmac
        const crypto = require('crypto')
        const secret = 'abcdefg'
        const hashPassword = crypto.createHmac('sha256', secret)
                                    .update(password)
                                    .digest('hex')

        await findOnePromise(account)
                .then(updateOnePromise)
                .then(res => {
                    ctx.body = res
                })
                .catch(res => {
                    if(res) {
                        ctx.body = res
                    }
                })

        //promise find one
        function findOnePromise(account) {
            return new Promise((resolve, reject) => {
                User.findOne({ account }, async (err, res) => {
                    if (err) {
                        reject({
                            code: 1018,
                            message: 'db is error'
                        })
                    }
                    
                    if (res) {
                        //check password
                        if (hashPassword == res.password) {
                            resolve(mongoose.Types.ObjectId(res._id))
                        } else {
                            reject({
                                code: 1002,
                                message: 'Incorrect password.'
                            })
                        }
                    } else {
                        //create new account
                        await createPromise({
                            account,
                            password: hashPassword
                        })
                            .then(res => {
                                ctx.body = res
                            })
                            .catch(res => {
                                ctx.body = res
                            })

                        reject()
                    }
                })
            })
        }

        //promise update one
        function updateOnePromise(_id) {
            return new Promise((resolve, reject) => {
                User.updateOne({ _id }, { updated_at: Date.now() }, async (err, res) => {
                    if (err) {
                        reject({
                            code: 1018,
                            message: 'db is error'
                        })
                    }

                    //find account info by ID
                    await User.findById(_id, (err, res) => {
                        if (err) {
                            reject({
                                code: 1018,
                                message: 'db is error'
                            })
                        }

                        const userInfo = JSON.parse(JSON.stringify(res))
                        //delete password
                        delete userInfo.password

                        //save userInfo to session
                        ctx.session.userInfo = userInfo

                        resolve({
                            code: 1001,
                            message: 'account is havented.',
                            data: {
                                userInfo
                            }
                        })
                    })
                })
            })
        }

        //promise create
        function createPromise(many) {
            return new Promise((resolve, reject) => {
                User.create(many, async (err, res) => {
                    if (err) {
                        reject({
                            code: 1018,
                            message: 'db is error',
                            data: err
                        })
                    }

                    const userInfo = JSON.parse(JSON.stringify(res))

                    //delete password
                    delete userInfo.password

                    //save userInfo to session
                    ctx.session.userInfo = userInfo

                    resolve({
                        code: 0,
                        message: 'add user success.',
                        data: {
                            userInfo
                        }
                    })
                })
            })
        }
    }

    /**
     * 微信登录
     * 
     * @param {Object} ctx  上下文
     * @param {Function} next 向下传递
     * 
     * @type {Object} ctx.query 请求传递参数
     * @type {Object} miniprogramConfig 小程序相关的配置
     * 
     * @return codeError 小程序登录凭证不能为空或者错误
     * @return token 返回token
     */
    async wxLogin(ctx, next) {
        const query = ctx.query,
              code = query.code,
              miniprogramConfig = Config.miniprogram

        if (!code) {
            return ctx.body = {
                code: 1010,
                message: '小程序登录凭证不能为空'
            }
        } else {
            /**
             * 登录凭证校验
             * 
             * @param {String} appid 小程序的appId
             * @param {String} secret 小程序的appSecret
             * @param {String} js_code 登录时获取的 code
             * @param {String} grant_type 授权类型，此处只需填写 authorization_code
             * 
             * @return 返回JSON包 status == 200时返回
             *  - @param {String} openid 用户唯一标识
             *  - @param {String} session_key 会话密钥
             *  - @param {String} unionid 用户在开放平台的唯一标识符，在满足 UnionID 下发条件的情况下会返回
             *  - @param {String} errcode 错误码
             *      > -1 系统繁忙，此时请开发者稍候再试
             *      > 0 请求成功
             *      > 40029 code 无效
             *      > 45011 频率限制，每个用户每分钟100次
             *  - @param {String} errMsg 错误信息
             * 
             * @method ctx.session.wxLogin 保存会话秘钥和openid
             * @method jsonwebtoken.sign 创建token并返回
             */
            await axios.get('https://api.weixin.qq.com/sns/jscode2session', {
                params: {
                    appid: miniprogramConfig.appid,
                    secret: miniprogramConfig.secret,
                    js_code: code,
                    grant_type: 'authorization_code'
                }
            })
            .then(res => {
                return new Promise(async (resolve, reject) => {
                    if (res.status == 200 && !res.errcode) {
                        const session_key = res.data.session_key,
                              openid = res.data.openid

                        /**
                         * 保存session
                         * 
                         * 校验凭证获得会话密钥和openid
                         */
                        ctx.session.wxLogin = {
                            session_key,
                            openid
                        }

                        /**
                         * 创建token
                         */
                        await jsonwebtoken.sign({
                            session_key,
                            openid
                        }, Config.jwt.secretOrPrivateKey, Config.jwt.options, async (err, token) => {
                            if (err) {
                                return reject(err)
                            }

                            //check userInfo session
                            let userInfo = null
                            
                            if (ctx.session.userInfo) {
                                userInfo = ctx.session.userInfo
                            }

                            ctx.body = {
                                code: 0,
                                message: '返回token',
                                data: {
                                    token,
                                    userInfo
                                }
                            }

                            await resolve()
                        })
                    } else {
                        await reject(res.data)
                    }
                })
            })
            .catch(err => {
                ctx.body = {
                    code: 1019,
                    message: 'axios error',
                    data: err
                }
            })
        }
    }

    /**
     * get one user
     */
    async getOne(ctx, next) {
        const params = ctx.params
        let user = null

        user = await User.findOne({ name: params.name }, async (err, adventure) => {
            if (err) {
                return console.error(err)
            }

            await adventure
        })

        await ctx.render('getUser', {
            user
        }, { layout: false })
    }

    /**
     * show user
     */
    async showUser(ctx, next) {
        const one = ctx.request.body
        let adventure = null

        adventure = await User.findOne({ name: one.name }, async (err, adventure) => {
            if (err) {
                return console.error(err)
            }

            await adventure
        })

        ctx.body = adventure
    }

    /**
     * get many user
     */
    async getMany(ctx, next) {
        let list = null

        list = await User.find({}, async (err, users) => {
            if (err) {
                return console.error(err)
            }

            await users
        })
        
        ctx.state.list = list

        await ctx.render('getUserList')
    }

    /**
     * list users
     */
    async listUser(ctx, next) {
        let list = null

        list = await User.find({}, async (err, users) => {
            if (err) {
                return console.error(err)
            }

            await users
        })

        ctx.body = list
    }

    async addUser(ctx, next) {
        await ctx.render('addUser')
    }

    /**
     * new user
     */
    async newUser(ctx, next) {
        const data = ctx.request.body,
              name = data.name,
              pass = data.pass

        //check params
        if(!name) {
            return ctx.body = {
                code: 1001,
                message: 'name can`t null'
            }
        }
        
        if (!pass) {
            return ctx.body = {
                code: 1001,
                message: 'pass can`t null'
            }
        }

        //find
        await User.findOne({ name }, async (err, res) => {
            if(err) {
                return new Error(err)
            }

            if(res) {
                ctx.body = JSON.stringify({
                    code: 1002,
                    message: 'name is havented.'
                })
            } else {
                //密码加密：hmac
                const crypto = require('crypto')
                const secret = 'abcdefg'
                const hashPass = crypto.createHmac('sha256', secret)
                                        .update(pass)
                                        .digest('hex')
                const many = {
                    name,
                    pass: hashPass
                }

                //empty
                const docs = await User.insertMany(many, async (err, docs) => {
                    if (err) {
                        return console.error(err)
                    }

                    await docs
                })

                ctx.body = JSON.stringify(docs || {
                    code: 0,
                    message: 'add user success.'
                })
            }
        })
    }

    /**
     * edit user
     */
    async editUser(ctx, next) {
        const data = ctx.request.body

        const raw = await User.replaceOne({ name: data.oldname }, { name: data.newname }, async (err, raw) => {
            if (err) {
                return console.error(err)
            }

            await raw
        })

        ctx.body = raw
    }

    /**
     * set session
     */
    async setSession(ctx, next) {
        const query = ctx.query

        ctx.session = {
            key: query.key
        }

        ctx.body = query.key
    }

    /**
     * find session
     */
    async findSession(ctx, next) {
        const query = ctx.query

        ctx.body = ctx.session[query.key]
    }
}

module.exports = new UserControllers()