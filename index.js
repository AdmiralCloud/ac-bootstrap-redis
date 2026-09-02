/**
 * Takes the object that has .log and .config available and adds .redis functions to it.
 * @param {Object} acapi - API object with .log and .config
 * @param {Object} options - Module options
 * @param {boolean} [options.bootstrapping=true] - Whether to throw errors during bootstrapping
 * @param {boolean} [options.flushInTestmode=false] - Whether to flush databases in test mode
 * @returns {Promise<{logConnector: Array, disconnect: Function}>}
 */
const tls = require('tls')
const Redis = require('ioredis')

module.exports = async (acapi, options = {}) => {
  const bootstrapping = options?.bootstrapping ?? true
  const logConnector = []
  const instanceNames = []

  try {
    acapi.redis = {}
    const databases = acapi.config?.redis?.databases ?? []

    if (!databases.length) {
      throw new Error('noDatabasesConfiguredForRedis')
    }

    await Promise.all(databases.map(async database => {
      if (database?.ignoreBootstrap) { return }

      const name = database?.name
      if (!name) { throw new Error('missingNameForRedisDatabase') }

      const logName = name.padEnd(18)
      const server = acapi.config.redis.servers.find(s => s.server === database?.server)
      if (!server) { throw new Error(`serverConfigurationMissingForRedis: ${database.server}`) }

      const redisBaseOptions = buildRedisOptions({ acapi, server, database })

      acapi.redis[name] = new Redis(redisBaseOptions)
      instanceNames.push(name)

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

    const disconnect = async () => {
      await Promise.all(instanceNames.map(name => {
        if (acapi.redis[name]) {
          return acapi.redis[name].quit()
        }
      }))
    }

    return { logConnector, disconnect }
  }
  catch (error) {
    if (bootstrapping) { throw error }

    acapi.log.error('Bootstrap.initRedis:failed with %j', error)
    process.exit(1)
  }
}

/**
 * Builds Redis connection options from configuration
 * @param {Object} params
 * @param {Object} params.acapi - The API object
 * @param {Object} params.server - Server configuration
 * @param {Object} params.database - Database configuration
 * @returns {Object} Redis options
 */
function buildRedisOptions({ acapi, server, database }) {
  const redisBaseOptions = {
    host: server.host,
    port: server.port,
    db: database.db,
    retryStrategy: (times) => {
      const retryArray = [1, 2, 2, 5, 5, 5, 10, 10, 10, 10, 15]
      const delay = times < retryArray.length ? retryArray[times] : retryArray.at(-1)
      return delay * 1000
    }
  }

  if (server.tls) { redisBaseOptions.tls = server.tls }

  const availableOptions = ['retryStrategy', 'timeout', 'connectTimeout', 'enableAutoPipelining']
  for (const option of availableOptions) {
    const val = acapi.config?.redis?.[option]
    if (val !== undefined) { redisBaseOptions[option] = val }
  }

  if (acapi.config.localRedis) {
    for (const [key, val] of Object.entries(acapi.config.localRedis)) {
      redisBaseOptions[key] = val
    }
  }

  return redisBaseOptions
}

/**
 * Connects to Redis and waits for the ready event
 * @param {Object} params
 * @param {Object} params.acapi - The API object
 * @param {String} params.name - Redis instance name
 * @param {String} params.logName - Formatted name for logs
 * @param {Object} params.redisOptions - Redis connection options
 * @param {Object} params.database - Database configuration
 * @param {Object} params.moduleOptions - Module options
 * @param {Array} params.logConnector - Log collector array
 * @returns {Promise<void>}
 */
function connectToRedis({ acapi, name, logName, redisOptions, database, moduleOptions, logConnector }) {
  return new Promise((resolve, reject) => {
    const timeoutMs = redisOptions.connectTimeout || 10000

    const errorHandler = (err) => {
      clearTimeout(timeoutId)
      acapi.redis[name].removeListener('error', errorHandler)
      acapi.log.error('REDIS | %s | Error %s', logName, err?.message)
      reject(err)
    }

     
    let timeoutId = setTimeout(() => {
      acapi.redis[name].removeListener('error', errorHandler)
      reject(new Error(`redisConnectionTimeout: ${name}`))
    }, timeoutMs)

    acapi.redis[name].on('error', errorHandler)

    acapi.redis[name].once('ready', async () => {
      clearTimeout(timeoutId)
      acapi.redis[name].removeListener('error', errorHandler)

      logConnector.push({ field: 'Name', value: name })
      logConnector.push({ field: 'Host/Port', value: `${redisOptions.host} ${redisOptions.port}` })
      logConnector.push({ field: 'DB', value: database.db.toString() })

      const stream = acapi.redis[name].stream
      if (stream && stream instanceof tls.TLSSocket) {
        const cipher = stream.getCipher()?.name ?? 'unknown'
        const value = (stream.encrypted ? '\x1b[32mEncrypted\x1b[0m' : 'NOT ENCRYPTED') + ' | ' + cipher
        logConnector.push({ field: 'TLS', value })
      }

      logConnector.push({ field: 'Connection', value: '\x1b[32mSuccessful\x1b[0m' })

      setupRuntimeEventHandlers({ acapi, name, logName })

      if (acapi.config.environment === 'test' && moduleOptions?.flushInTestmode) {
        try {
          await acapi.redis[name].flushdb()
          logConnector.push({ field: 'Flushed', value: '\x1b[32mSuccessful\x1b[0m' })
        }
        catch (flushErr) {
          return reject(flushErr)
        }
      }

      resolve()
    })
  })
}

/**
 * Sets up event handlers for runtime events (called after successful connection)
 * @param {Object} params
 * @param {Object} params.acapi - The API object
 * @param {String} params.name - Redis instance name
 * @param {String} params.logName - Formatted name for logs
 */
function setupRuntimeEventHandlers({ acapi, name, logName }) {
  acapi.redis[name].on('error', (err) => {
    acapi.log.error('REDIS | %s | Error %s', logName, err?.message)
  })

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
