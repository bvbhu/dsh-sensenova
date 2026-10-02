/**
 * 图片块物化：dsh 的 image 块 → data URL（视觉模型）或占位文本（纯文本模型）。
 *
 * dsh 的 image 块持有 durable attachment 引用（block.attachment），不直接
 * 带字节。三条路径（照 dsh-zcode2api messages.js 的 materializeImages）：
 *   - offloaded 块已是文本形态 → offloadedImageText 占位；
 *   - 宿主文件直读后端 → attachments.imageHostPath 拿现成路径（这里读为
 *     base64，因为 Token Plan 端点要 data URL，不能给本地路径）；
 *   - 否则 attachments.readImage 读字节。
 * data URL 内联意味着大图会放大请求体（P0 实测平台接受 ~1KB 小图；
 * 大图预算管理交给宿主的 image-offload 机制，本插件不重复设限）。
 *
 * @module lib/images.js
 */

import { readFile } from 'node:fs/promises'
import { offloadedImageText } from '@deepseek-ai/dsh-llm'

const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

/**
 * 物化消息里的全部图片块。
 * @returns {{ imageText: Map<object,string>, imageUrls: string[] }}
 *   imageText 给 wire.js 的拍平用（占位）；imageUrls 按出现顺序供视觉模型内联。
 */
export async function materializeImages(messages, { attachments, vision, logger }) {
  const imageText = new Map()
  const imageUrls = []
  if (attachments === undefined) return { imageText, imageUrls }
  let index = 0
  for (const message of messages ?? []) {
    for (const block of message?.content ?? []) {
      if (block === null || typeof block !== 'object' || block.type !== 'image') continue
      index += 1
      if (block.offloaded === true) {
        imageText.set(block, offloadedImageText(block.attachment))
        continue
      }
      if (!vision) {
        imageText.set(block, `[图片 #${index}（当前模型不支持图像输入）]`)
        continue
      }
      try {
        let mediaType = block.attachment?.mediaType
        let bytes
        const hostPath = attachments.imageHostPath?.(block.attachment)
        if (typeof hostPath === 'string') {
          bytes = await readFile(hostPath)
          mediaType = mediaType ?? MIME_BY_EXT[hostPath.slice(hostPath.lastIndexOf('.')).toLowerCase()]
        } else {
          const stored = await attachments.readImage(block.attachment)
          bytes = Buffer.from(stored.data)
          mediaType = mediaType ?? stored.ref?.mediaType
        }
        if (!bytes?.length) throw new Error('图片字节为空')
        const url = `data:${mediaType ?? 'image/png'};base64,${bytes.toString('base64')}`
        imageUrls.push(url)
        imageText.set(block, `[图片 #${index}]`)
      } catch (error) {
        logger?.warn?.(`dsh-sensenova: 读取图片附件失败（${error?.message ?? error}）`)
        imageText.set(block, `[图片 #${index}（读取失败）]`)
      }
    }
  }
  return { imageText, imageUrls }
}
