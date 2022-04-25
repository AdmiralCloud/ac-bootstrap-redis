/**
 * Takes the object that has .log and .config available and add .redis functions to it.
 * 
 */

const async = require('async')
const _ = require('lodash') 
const Redis = require('ioredis')

module.exports = (acapi, options, cb) => {
  const bootstrapping = _.get(options, 'bootstrapping', true)

  acapi.aclog.headline({ headline: 'redis' })

  // init multiple instances for different purposes
  acapi.redis = {}
  let lastInvoked = 0
  async.eachSeries(_.get(acapi.config, 'redis.databases'), (database, itDone) => {
    if (_.get(database, 'ignoreBootstrap')) return itDone()
    let name = _.get(database, 'name')
    let server = _.find(acapi.config.redis.servers, { server: _.get(database, 'server') })
    if (!server) return itDone({ message: 'serverConfigurationMissingForRedis' })

    let redisBaseOptions = {
      host: _.get(server, 'host'),
      port:  _.get(server, 'port'),
      db: _.get(database, 'db')
    }
    if (_.get(acapi.config, 'redis.retryStrategy')) _.set(redisBaseOptions, 'retryStrategy', _.get(acapi.config, 'redis.retryStrategy'))
    if (_.get(acapi.config, 'redis.timeout')) _.set(redisBaseOptions, 'connectTimeout', _.get(acapi.config, 'redis.timeout'))
    if (_.get(acapi.config, 'redis.connectTimeout')) _.set(redisBaseOptions, 'connectTimeout', _.get(acapi.config, 'redis.connectTimeout'))

    if (acapi.config.localRedis) {
      _.forOwn(acapi.config.localRedis, (val, key) => {
        _.set(redisBaseOptions, key, val)
      })
    }

    acapi.redis[name] = new Redis(redisBaseOptions)

    acapi.redis[name].on('error', (err) => {
      if (lastInvoked === 0 || lastInvoked < new Date().getTime()) {
        acapi.log.error('REDIS | Problem | %s | %s', name, _.get(err, 'message'))
        lastInvoked = new Date().getTime() + _.get(acapi.config, 'redis.errorInterval', 5000) // 5000 = interval in ms
      }
    })

    acapi.redis[name]._readyCheck((err) => {
      if (err) {
        acapi.log.error('Bootstrap.initRedis:ready failed for %s with %s', name, err)
        if (bootstrapping) return itDone(err)
      }

      acapi.aclog.listing({ field: 'Name', value: name })
      acapi.aclog.listing({ field: 'Host/Port', value: `${redisBaseOptions.host} ${redisBaseOptions.port}` })
      acapi.aclog.listing({ field: 'DB', value: database.db.toString() })
      acapi.aclog.listing({ field: 'Connection', value: '\x1b[32mSuccessful\x1b[0m' })

      acapi.redis[name].on('ready', () => {
        acapi.log.info('REDIS | Ready | %s', name)
      })

      if (acapi.config.environment !== 'test') return itDone()

      // better debugging in testmode
      acapi.redis[name].on('connect', () => {
        acapi.log.debug('REDIS | Connected | %s', name)
      })

      acapi.redis[name].on('reconnecting', (ms) => {
        acapi.log.debug('REDIS | Reconnecting | %s | %s', name, ms)
      })

      acapi.redis[name].once('close', () => {
        acapi.log.debug('REDIS | Connection closed | %s', name)
      })

      // flush redis in testmode
      if (!_.get(options, 'flushInTestmode')) return itDone()
      acapi.redis[name].flushdb((err) => {
        acapi.aclog.listing({ field: 'Flushed', value: '\x1b[32mSuccessful\x1b[0m' })
        return itDone(err)
      })
    })
  }, (err) => {
    if (bootstrapping) return cb(err)
    if (err) acapi.log.error('Bootstrap.initRedis:failed with %j', err)
    process.exit(0)
  })

}