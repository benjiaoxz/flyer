const RoutesLoader = require('../utils/routesLoader')

module.exports = app => {
    RoutesLoader(`${__dirname}`).then(routes => {
        routes.forEach(route => {
            app.use(route.routes()).use(
                route.allowedMethods({
                    throw: true
                })
            )
        })
    }).catch(err => {
        console.log(err)
    })
}