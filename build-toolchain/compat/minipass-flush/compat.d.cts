import type * as modern from './dist/commonjs/index.js'
import type { Minipass } from 'minipass'

declare class LegacyFlush<Read, Write = Read, Events extends Minipass.Events<Read> = Minipass.Events<Read>> extends modern.Flush<Read, Write, Events> {
  constructor(options?: modern.MinipassFlushOptions<Read> | modern.FlushFunction)
}

declare namespace LegacyFlush {
  const Flush: typeof modern.Flush
  const isPromiseLike: typeof modern.isPromiseLike
}

export = LegacyFlush
