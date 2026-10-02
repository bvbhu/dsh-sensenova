/**
 * LlmAdapter 实现（契约见 dsh-llm types/index.d.ts）。
 *
 * stream 流程（DESIGN.md §4）：
 *   模态判断 → 图片物化（images.js）→ 载荷组装（wire.js）→
 *   调度取号流式（scheduler.js → client.js）
 *
 * reasoning 预算（P0 实测）：reasoning tokens 计入 completion 预算
 * （19–86+/次），max_tokens 过小会 length 截断且 content 为空——
 * 未显式给 maxTokens 时用模型的保守默认（16k）。
 *
 * @module lib/adapter.js
 */

import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { materializeImages } from './images.js'
import { buildRequestBody } from './wire.js'

export class SenseNovaAdapter extends LlmAdapter {
  /**
   * @param {object} args
   * @param {() => object} args.options 已解析配置（热更新活引用）
   * @param {import('./scheduler.js').Scheduler} args.scheduler
   * @param {() => object | undefined} args.resolveAttachments ctx.get('attachments')
   * @param {object} [args.logger]
   */
  constructor({ options, scheduler, resolveAttachments, logger }) {
    super()
    this.options = options
    this.scheduler = scheduler
    this.resolveAttachments = resolveAttachments
    this.logger = logger ?? console
  }

  providerInfo(provider) {
    return { id: provider, name: 'SenseNova Token Plans' }
  }

  providerRetryPolicy(provider) {
    const policy = this.options().retryPolicy
    return policy
  }

  async listModels(provider) {
    return this.options().models.map((model) => ({ provider, ...model }))
  }

  async resolveModel(provider, model) {
    const found = this.options().models.find((entry) => entry.id === model)
    if (found) {
      return {
        provider,
        id: found.id,
        name: found.name ?? found.id,
        ...(found.description ? { description: found.description } : {}),
        context: { contextWindow: found.contextWindow },
        maxTokens: found.maxTokens,
        inputModalities: [...(found.inputModalities ?? ['text'])],
      }
    }
    // 目录外的模型 id：按纯文本保守声明（dsh-llm 语义：advisory catalog，
    // 未列出不代表拒绝；上游 404/403 由 client 透传）
    return {
      provider,
      id: model,
      name: model,
      context: { contextWindow: this.options().defaultContextWindow },
      maxTokens: this.options().maxTokens,
      inputModalities: ['text'],
    }
  }

  async *stream(options) {
    const opts = this.options()
    const model = opts.models.find((entry) => entry.id === options.model)
    const vision = (model?.inputModalities ?? []).includes('image')

    const attachments = this.resolveAttachments?.()
    const { imageText, imageUrls } = await materializeImages(options.messages, {
      attachments,
      vision,
      logger: this.logger,
    })

    const body = buildRequestBody(options, { imageText, imageUrls })
    if (typeof options.maxTokens !== 'number') body.max_tokens = model?.maxTokens ?? opts.maxTokens

    yield* this.scheduler.stream(body, {
      sessionId: options.sessionId,
      signal: options.signal,
      purpose: options.purpose,
    })
  }
}
