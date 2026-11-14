const modern = require('./dist/commonjs/index.js')

class LegacyFlush extends modern.Flush {
  constructor(options = {}) {
    super(typeof options === 'function' ? { flush: options } : options)
  }
}

module.exports = Object.assign(LegacyFlush, modern)
