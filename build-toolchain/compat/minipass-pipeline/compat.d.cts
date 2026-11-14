import type * as modern from './dist/commonjs/index.js'
import type { Minipass } from 'minipass'
import type Stream from 'node:stream'

declare class LegacyPipeline<Read> extends modern.Pipeline<Read> {
  constructor(options?: modern.MinipassPipelineOptions<Read>, ...streams: (Minipass | Stream)[])
  constructor(...streams: (Minipass | Stream)[])
}

declare namespace LegacyPipeline {
  const Pipeline: typeof modern.Pipeline
}

export = LegacyPipeline
