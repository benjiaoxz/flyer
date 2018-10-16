const mongoose = require('mongoose')

const Schema = mongoose.Schema

/**
 * @param account 账号
 * @param password 密码
 * @param wx_nick_name 微信昵称
 * @param wx_avatar_url 微信头像
 * @param status 状态
 * @param created_at 创建时间
 * @param updated_at 更新时间
 */
const UserSchema = new Schema({
    account: { type: String },
    password: { type: String },
    wx_nick_name: { type: String },
    wx_avatar_url: { type: String },
    status: { type: Number, default: 1 },
    created_at: { type: Date, default: Date.now },
    updated_at: { type: Date, default: Date.now },
}, {
    versionKey: false
})

mongoose.model('User', UserSchema)