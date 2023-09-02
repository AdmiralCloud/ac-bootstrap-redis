/**
 * Takes the object that has .log and .config available and add .redis functions to it.
 * 
 */
const _ = require('lodash') 
const Redis = require('ioredis')

module.exports = (acapi, options, cb) => {
  const bootstrapping = _.get(options, 'bootstrapping', true)

  const init = async(acapi, options) => {
    acapi.aclog.headline({ headline: 'redis' })

    // init multiple instances for different purposes
    acapi.redis = {}
    for (const database of _.get(acapi.config, 'redis.databases')) {
      if (_.get(database, 'ignoreBootstrap')) continue
      const name = _.get(database, 'name')
      const logName = _.padEnd(name, 18) 
      const server = _.find(acapi.config.redis.servers, { server: _.get(database, 'server') })
      if (!server) throw new Error('serverConfigurationMissingForRedis')

      let redisBaseOptions = {
        host: _.get(server, 'host'),
        port:  _.get(server, 'port'),
        db: _.get(database, 'db'),
        retryStrategy: (times) => {
          const retryArray = [1,2,2,5,5,5,10,10,10,10,15]
          const delay = times < retryArray.length ? retryArray[times] : retryArray.at(retryArray.length)
          return delay*1000
        }
      }
      if (_.get(server, 'tls')) redisBaseOptions.tls = _.get(server, 'tls')

      const availableOptions = ['retryStrategy', 'timeout', 'connectTimeout', 'enableAutoPipelining']
      _.forEach(availableOptions, option => {
        if (_.get(acapi.config, `redis.${option}`)) _.set(redisBaseOptions, option, _.get(acapi.config, `redis.${option}`))
      })

      if (acapi.config.localRedis) {
        _.forOwn(acapi.config.localRedis, (val, key) => {
          _.set(redisBaseOptions, key, val)
        })
      }

      acapi.redis[name] = new Redis(redisBaseOptions)

      acapi.redis[name].on('error', (err) => {
        acapi.log.error('REDIS | %s | Error %s', logName, _.get(err, 'message'))
      })

      await new Promise((resolve, reject) => {
        acapi.redis[name].on('error', (err) => {
          acapi.log.error('REDIS | %s | Error %s', logName, _.get(err, 'message'))
          reject(err) // only called if ready event is not fired (aka only during intialization)
        })

        acapi.redis[name].once('ready', async() => {
          acapi.aclog.listing({ field: 'Name', value: name })
          acapi.aclog.listing({ field: 'Host/Port', value: `${redisBaseOptions.host} ${redisBaseOptions.port}` })
          acapi.aclog.listing({ field: 'DB', value: database.db.toString() })


          const stream = acapi.redis[name].stream;
          if (stream && stream instanceof require('tls').TLSSocket) {
            // This means the connection is using TLS.
            const cipher = stream.getCipher().name
            const value = (stream.encrypted ? '\x1b[32mEncrypted\x1b[0m' : 'NOT ENCRYPTED') + ' | ' + cipher
            acapi.aclog.listing({ field: 'TLS', value })
          }

          acapi.aclog.listing({ field: 'Connection', value: '\x1b[32mSuccessful\x1b[0m' })
          acapi.aclog.hrLine()

          acapi.redis[name].on('connect', () => {
            acapi.log.debug('REDIS | %s | Connected', logName)
          })

          acapi.redis[name].on('reconnecting', (ms) => {
            acapi.log.debug('REDIS | %s | Reconnecting in %sms', logName, ms)
          })

          acapi.redis[name].once('close', () => {
            acapi.log.debug('REDIS | %s | Connection closed', logName)
          })

            // flush redis in testmode
          if (acapi.config.environment === 'test' && _.get(options, 'flushInTestmode')) {
            await acapi.redis[name].flushdb()
            acapi.aclog.listing({ field: 'Flushed', value: '\x1b[32mSuccessful\x1b[0m' })
          }
          resolve()
        })
      })
    }
  }

  if (cb) {
    console.log("ac-bootstrap-redis -> Warning: The callback method is considered legacy. Please use the async/await approach.");
    init(acapi, options)
        .then(() => cb(null))
        .catch(err => {
          if (bootstrapping) return cb(err)
          if (err) acapi.log.error('Bootstrap.initRedis:failed with %j', err)
          process.exit(0)
        })
  } 
  else {
    return init(acapi, options);
  }
}


