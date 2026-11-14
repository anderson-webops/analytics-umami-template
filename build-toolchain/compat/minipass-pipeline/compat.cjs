const { EventEmitter } = require('node:events')
const modern = require('./dist/commonjs/index.js')

class LegacyPipeline extends modern.Pipeline {
  constructor(options, ...streams) {
    if (options instanceof EventEmitter && (
      typeof options.pipe === 'function'
      || (typeof options.write === 'function' && typeof options.end === 'function')
    )) {
      streams.unshift(options)
      options = {}
    }
    super(options, ...streams)
  }
}

module.exports = Object.assign(LegacyPipeline, modern)
