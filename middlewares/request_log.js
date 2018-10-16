const logger = require('../common/logger')

module.exports = async (ctx, next) => {
  const t = new Date()
  logger.info('\n\nStarted', t.toISOString(), ctx.method, ctx.url, ctx.ip)

  ctx.res.on('finish', function () {
    const duration = ((new Date()) - t)

    logger.info('Completed', ctx.res.statusCode, ('(' + duration + 'ms)'))
  })

  await next()
}
