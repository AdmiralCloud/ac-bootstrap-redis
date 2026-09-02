/**
 * Tests for Redis bootstrap functionality
 */
const { expect } = require('chai')
const EventEmitter = require('events')
const path = require('path')

class MockRedis extends EventEmitter {
  constructor(options) {
    super()
    this.options = options
    this.stream = {}
    this._shouldFlushFail = false
  }

  flushdb() {
    if (this._shouldFlushFail) {
      return Promise.reject(new Error('flushFailed'))
    }
    return Promise.resolve()
  }

  quit() {
    return Promise.resolve()
  }
}

const redisBootstrapPath = path.resolve(__dirname, '../index')

describe('Redis Bootstrap', () => {
  let redisBootstrap
  let acapiMock
  let connectionsCreated = 0
  let originalIoRedis

  before(() => {
    originalIoRedis = require.cache[require.resolve('ioredis')]

    require.cache[require.resolve('ioredis')] = {
      id: require.resolve('ioredis'),
      filename: require.resolve('ioredis'),
      loaded: true,
      exports: function(options) {
        connectionsCreated++
        return new MockRedis(options)
      }
    }
  })

  after(() => {
    if (originalIoRedis) {
      require.cache[require.resolve('ioredis')] = originalIoRedis
    }
    else {
      delete require.cache[require.resolve('ioredis')]
    }
  })

  beforeEach(() => {
    connectionsCreated = 0

    if (require.cache[redisBootstrapPath]) {
      delete require.cache[redisBootstrapPath]
    }

    redisBootstrap = require(redisBootstrapPath)

    acapiMock = {
      log: {
        debug: () => {},
        error: () => {},
        info: () => {}
      },
      config: {
        redis: {
          databases: [
            { name: 'main', server: 'local', db: 0 },
            { name: 'cache', server: 'local', db: 1 }
          ],
          servers: [
            { server: 'local', host: 'localhost', port: 6379 }
          ]
        },
        environment: 'test'
      },
      redis: {}
    }
  })

  it('should initialize Redis instances for all configured databases', async () => {
    const bootstrapPromise = redisBootstrap(acapiMock, { flushInTestmode: true })

    setTimeout(() => {
      Object.values(acapiMock.redis).forEach(instance => instance.emit('ready'))
    }, 10)

    const { logConnector } = await bootstrapPromise

    expect(connectionsCreated).to.equal(2)
    expect(acapiMock.redis).to.have.property('main')
    expect(acapiMock.redis).to.have.property('cache')
    expect(logConnector.some(e => e.field === 'Flushed')).to.be.true
  })

  it('should handle connection errors properly', async () => {
    const bootstrapPromise = redisBootstrap(acapiMock, {})
    const error = new Error('Connection refused')

    setTimeout(() => {
      const firstInstanceName = Object.keys(acapiMock.redis)[0]
      acapiMock.redis[firstInstanceName].emit('error', error)
    }, 10)

    try {
      await bootstrapPromise
      expect.fail('Should have thrown an error')
    }
    catch (err) {
      expect(err.message).to.equal('Connection refused')
    }
  })

  it('should skip databases with ignoreBootstrap flag', async () => {
    acapiMock.config.redis.databases.push({
      name: 'ignore',
      server: 'local',
      db: 2,
      ignoreBootstrap: true
    })

    const bootstrapPromise = redisBootstrap(acapiMock, {})

    setTimeout(() => {
      Object.values(acapiMock.redis).forEach(instance => instance.emit('ready'))
    }, 10)

    await bootstrapPromise

    expect(connectionsCreated).to.equal(2)
    expect(acapiMock.redis).to.not.have.property('ignore')
  })

  it('should throw error when no databases are configured', async () => {
    acapiMock.config.redis.databases = []

    try {
      await redisBootstrap(acapiMock, {})
      expect.fail('Should have thrown an error')
    }
    catch (err) {
      expect(err.message).to.equal('noDatabasesConfiguredForRedis')
    }
  })

  it('should have exactly one error handler during init and one runtime handler after ready', async () => {
    const bootstrapPromise = redisBootstrap(acapiMock, {})

    // Wait for instances to be created
    await new Promise(resolve => setTimeout(resolve, 5))

    const firstName = Object.keys(acapiMock.redis)[0]

    // During init: exactly one error handler (the initialization handler)
    expect(acapiMock.redis[firstName].listenerCount('error')).to.equal(1)

    // Emit ready for all instances
    Object.values(acapiMock.redis).forEach(instance => instance.emit('ready'))
    await bootstrapPromise

    // After ready: exactly one error handler (the runtime handler from setupRuntimeEventHandlers)
    expect(acapiMock.redis[firstName].listenerCount('error')).to.equal(1)
  })

  it('should propagate flushdb errors', async () => {
    const bootstrapPromise = redisBootstrap(acapiMock, { flushInTestmode: true })

    setTimeout(() => {
      Object.values(acapiMock.redis).forEach(instance => {
        instance._shouldFlushFail = true
        instance.emit('ready')
      })
    }, 10)

    try {
      await bootstrapPromise
      expect.fail('Should have thrown a flushdb error')
    }
    catch (err) {
      expect(err.message).to.equal('flushFailed')
    }
  })

  it('should reject on connection timeout', async () => {
    acapiMock.config.redis.connectTimeout = 50 // 50ms for fast test

    // Do not emit 'ready' — let the timeout fire
    try {
      await redisBootstrap(acapiMock, {})
      expect.fail('Should have timed out')
    }
    catch (err) {
      expect(err.message).to.include('redisConnectionTimeout')
    }
  }).timeout(1000)

  it('should provide a disconnect function that closes all connections', async () => {
    let quitCount = 0
    const originalQuit = MockRedis.prototype.quit
    MockRedis.prototype.quit = function() {
      quitCount++
      return Promise.resolve()
    }

    const bootstrapPromise = redisBootstrap(acapiMock, {})

    setTimeout(() => {
      Object.values(acapiMock.redis).forEach(instance => instance.emit('ready'))
    }, 10)

    const { disconnect } = await bootstrapPromise
    await disconnect()

    MockRedis.prototype.quit = originalQuit

    expect(quitCount).to.equal(2)
  })
})
