module.exports = {
    "apps": [{
        name: "script",
        script: "./index.js",
        watch: true,
        env: {
            NODE_ENV: "development",
        },
        env_production: {
            NODE_ENV: "production",
        },
        log: './logs/combined.outerr.log'
    }]
}