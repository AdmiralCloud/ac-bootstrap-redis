/**
 * Takes the object that has .log and .config available and adds .redis functions to it.
 */
const _ = require('lodash') 
const Redis = require('ioredis')

module.exports = async (acapi, options = {}) => {
  const bootstrapping = _.get(options, 'bootstrapping', true)
  const logConnector = []

  try {
    // Initialize multiple Redis instances for different purposes
    acapi.redis = {}
    const databases = _.get(acapi.config, 'redis.databases', [])
    
    // Validate that databases are configured
    if (!_.size(databases)) {
      throw new Error('noDatabasesConfiguredForRedis')
    }

    // Wait for all Redis connections in parallel
    await Promise.all(databases.map(async database => {
      if (_.get(database, 'ignoreBootstrap')) return
      
      const name = _.get(database, 'name')
      if (!name) throw new Error('missingNameForRedisDatabase')
      
      const logName = _.padEnd(name, 18)
      const server = _.find(acapi.config.redis.servers, { server: _.get(database, 'server') })
      if (!server) throw new Error(`serverConfigurationMissingForRedis: ${database.server}`)

      let redisBaseOptions = buildRedisOptions({ acapi, server, database })

      // Create the Redis instance
      acapi.redis[name] = new Redis(redisBaseOptions)

      // Global error handler for runtime
      acapi.redis[name].on('error', (err) => {
        acapi.log.error('REDIS | %s | Error %s', logName, _.get(err, 'message'))
      })

      // Wait for Ready event
      await connectToRedis({ 
        acapi, 
        name, 
        logName, 
        redisOptions: redisBaseOptions, 
        database, 
        moduleOptions: options, 
        logConnector 
      })
    }))

    return logConnector
  } 
  catch (error) {
    if (bootstrapping) throw error
    
    acapi.log.error('Bootstrap.initRedis:failed with %j', error)
    process.exit(0)
  }
}

/**
 * Builds Redis connection options from configuration
 * @param {Object} params - Function parameters
 * @param {Object} params.acapi - The API object
 * @param {Object} params.server - Server configuration
 * @param {Object} params.database - Database configuration
 * @returns {Object} Redis options
 */
function buildRedisOptions({ acapi, server, database }) {
  let redisBaseOptions = {
    host: _.get(server, 'host'),
    port: _.get(server, 'port'),
    db: _.get(database, 'db'),
    retryStrategy: (times) => {
      const retryArray = [1, 2, 2, 5, 5, 5, 10, 10, 10, 10, 15]
      const delay = times < retryArray.length ? retryArray[times] : retryArray.at(-1) // Fixed: use -1 instead of length
      return delay * 1000
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

  return redisBaseOptions
}

/**
 * Connects to Redis and waits for the ready event
 * @param {Object} params - Function parameters
 * @param {Object} params.acapi - The API object
 * @param {String} params.name - Redis instance name
 * @param {String} params.logName - Formatted name for logs
 * @param {Object} params.redisOptions - Redis connection options
 * @param {Object} params.database - Database configuration
 * @param {Object} params.moduleOptions - Module options
 * @param {Array} params.logConnector - Log collector array
 * @returns {Promise} Connection promise
 */
async function connectToRedis({ acapi, name, logName, redisOptions, database, moduleOptions, logConnector }) {
  return new Promise((resolve, reject) => {
    // Register error handler only for initialization phase
    const errorHandler = (err) => {
      acapi.log.error('REDIS | %s | Error %s', logName, _.get(err, 'message'))
      reject(err)
    }
    
    acapi.redis[name].on('error', errorHandler)

    acapi.redis[name].once('ready', async() => {
      // Remove the temporary error handler
      acapi.redis[name].removeListener('error', errorHandler)
      
      // Collect connection information
      logConnector.push({ field: 'Name', value: name })
      logConnector.push({ field: 'Host/Port', value: `${redisOptions.host} ${redisOptions.port}` })
      logConnector.push({ field: 'DB', value: database.db.toString() })

      // Capture TLS information
      const stream = acapi.redis[name].stream
      if (stream && stream instanceof require('tls').TLSSocket) {
        const cipher = stream.getCipher().name
        const value = (stream.encrypted ? '\x1b[32mEncrypted\x1b[0m' : 'NOT ENCRYPTED') + ' | ' + cipher
        logConnector.push({ field: 'TLS', value })
      }

      logConnector.push({ field: 'Connection', value: '\x1b[32mSuccessful\x1b[0m' })

      // Register runtime event handlers
      setupRuntimeEventHandlers({ acapi, name, logName })

      // Flush Redis in test mode
      if (acapi.config.environment === 'test' && _.get(moduleOptions, 'flushInTestmode')) {
        await acapi.redis[name].flushdb()
        logConnector.push({ field: 'Flushed', value: '\x1b[32mSuccessful\x1b[0m' })
      }
      
      resolve()
    })
  })
}

/**
 * Sets up event handlers for runtime events
 * @param {Object} params - Function parameters
 * @param {Object} params.acapi - The API object
 * @param {String} params.name - Redis instance name
 * @param {String} params.logName - Formatted name for logs
 */
function setupRuntimeEventHandlers({ acapi, name, logName }) {
  acapi.redis[name].on('connect', () => {
    acapi.log.debug('REDIS | %s | Connected', logName)
  })

  acapi.redis[name].on('reconnecting', (ms) => {
    acapi.log.debug('REDIS | %s | Reconnecting in %sms', logName, ms)
  })

  acapi.redis[name].on('close', () => {
    acapi.log.debug('REDIS | %s | Connection closed', logName)
  })
}