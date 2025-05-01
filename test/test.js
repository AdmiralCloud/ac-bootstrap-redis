/**
 * Simplified test for Redis bootstrap functionality
 */
const { expect } = require('chai')
const EventEmitter = require('events')
const _ = require('lodash')
const path = require('path')

// Mock for the ioredis module
class MockRedis extends EventEmitter {
  constructor(options) {
    super()
    this.options = options
    this.stream = {}
  }

  flushdb() {
    return Promise.resolve()
  }
}

// Replace this with the path to your redis bootstrap module
const redisBootstrapPath = path.resolve(__dirname, '../index')

describe('Redis Bootstrap', () => {
  let redisBootstrap
  let acapiMock
  let connectionsCreated = 0
  let originalIoRedis

  before(() => {
    // Store the original module
    originalIoRedis = require.cache[require.resolve('ioredis')]

    // Mock ioredis module
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
    // Restore original module or remove mock
    if (originalIoRedis) {
      require.cache[require.resolve('ioredis')] = originalIoRedis
    } 
    else {
      delete require.cache[require.resolve('ioredis')]
    }
  })

  beforeEach(() => {
    // Reset counter
    connectionsCreated = 0
    
    // Clear require cache for our module to reload with mocked dependencies
    if (require.cache[redisBootstrapPath]) {
      delete require.cache[redisBootstrapPath]
    }
    
    // Now load the module with mocked dependencies
    redisBootstrap = require(redisBootstrapPath)

    // Mock for the acapi object
    acapiMock = {
      log: {
        debug: (msg, ...args) => {},
        error: (msg, ...args) => {},
        info: (msg, ...args) => {}
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
    // Execute the bootstrap function
    const options = { flushInTestmode: true }
    const bootstrapPromise = redisBootstrap(acapiMock, options)
    
    // Emit ready events for all Redis instances
    setTimeout(() => {
      _.forEach(acapiMock.redis, instance => {
        instance.emit('ready')
      })
    }, 10)
    
    // Wait for bootstrap to complete
    await bootstrapPromise
    
    // Assertions
    expect(connectionsCreated).to.equal(2)
    expect(acapiMock.redis).to.have.property('main')
    expect(acapiMock.redis).to.have.property('cache')
  })

  it('should handle connection errors properly', async () => {
    // Execute the bootstrap function
    const bootstrapPromise = redisBootstrap(acapiMock, {})
    
    // Create an error
    const error = new Error('Connection refused')
    
    // Emit error on the first Redis instance
    setTimeout(() => {
      const firstInstanceName = _.keys(acapiMock.redis)[0]
      acapiMock.redis[firstInstanceName].emit('error', error)
    }, 10)
    
    // The bootstrap should reject with the error
    try {
      await bootstrapPromise
      // If we get here, the test failed
      expect.fail('Should have thrown an error')
    } 
    catch (err) {
      expect(err.message).to.equal('Connection refused')
    }
  })

  it('should skip databases with ignoreBootstrap flag', async () => {
    // Modify config to include a database to ignore
    acapiMock.config.redis.databases.push({ 
      name: 'ignore', 
      server: 'local', 
      db: 2, 
      ignoreBootstrap: true 
    })
    
    // Execute the bootstrap function
    const bootstrapPromise = redisBootstrap(acapiMock, {})
    
    // Emit ready events for all Redis instances
    setTimeout(() => {
      _.forEach(acapiMock.redis, instance => {
        instance.emit('ready')
      })
    }, 10)
    
    // Wait for bootstrap to complete
    await bootstrapPromise
    
    // Should only create 2 connections, not the ignored one
    expect(connectionsCreated).to.equal(2)
    expect(acapiMock.redis).to.not.have.property('ignore')
  })

  it('should throw error when no databases are configured', async () => {
    // Empty the databases configuration
    acapiMock.config.redis.databases = []
    
    try {
      await redisBootstrap(acapiMock, {})
      expect.fail('Should have thrown an error')
    } 
    catch (err) {
      expect(err.message).to.equal('noDatabasesConfiguredForRedis')
    }
  })
})