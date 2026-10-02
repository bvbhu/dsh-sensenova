/**
 * 模型目录（2026-10-02 P0 实测 + round2 结论，见 DESIGN.md §2.3）。
 *
 * 运行期目录 = API 发现（GET /v1/models，见 discoverModels）：模型列表、
 * 上下文、输出预算、输入模态（含图像）全部由 API 返回值决定，不需要人工指定；
 * 仅「启用哪些模型」由用户勾选（enabledModels）。API 不可用时降级 DEFAULT_MODELS。
 *
 * @module lib/models.js
 */

/** @typedef {import('@deepseek-ai/dsh-llm').LlmModelInfo} LlmModelInfo */

export const DEFAULT_MODELS = [
  {
    id: 'deepseek-v4-flash',
    name: 'DeepSeek V4 Flash',
    description: '主力模型：能力最优，通用池',
    contextWindow: 1000000,
    maxTokens: 384000,
    inputModalities: ['text'],
  },
  {
    id: 'sensenova-6.8-flash-lite',
    name: 'SenseNova 6.8 Flash Lite',
    description: '视觉 + 高吞吐，专属池（独立计额）',
    contextWindow: 262144,
    maxTokens: 16384,
    inputModalities: ['text', 'image'],
  },
  {
    id: 'kimi-k3',
    name: 'Kimi K3',
    description: '视觉，通用池',
    contextWindow: 262144,
    maxTokens: 16384,
    inputModalities: ['text', 'image'],
  },
  {
    id: 'glm-5.2',
    name: 'GLM 5.2',
    description: '纯文本，通用池',
    contextWindow: 1000000,
    maxTokens: 384000,
    inputModalities: ['text'],
  },
]

/** 目录里声明为视觉输入的模型 id 集合（占位/降级判断用）。 */
export function visionModelIds(models = DEFAULT_MODELS) {
  return new Set(models.filter((m) => (m.inputModalities ?? []).includes('image')).map((m) => m.id))
}

/** 未在静态目录里的模型 id 的保守默认上下文/输出预算（仅 API 字段缺失时兜底）。 */
export const FALLBACK_CONTEXT_WINDOW = 128000
export const FALLBACK_MAX_TOKENS = 16384

/**
 * 从 /v1/models 拉取模型目录。模型的全部能力参数（上下文、输出上限、输入模态、
 * 描述）直接采用 API 返回值，不做人工指定。
 *
 * 仅显示可作为 LLM 使用的模型：output_modalities 不含 text 的（非文本输出
 * 模型，如纯 embedding/图像生成模型）过滤不显示。
 *
 * @param {object} args
 * @param {string} args.baseUrl 推理端点（含 /v1）
 * @param {string} args.key 任一可用账号 key
 * @param {typeof fetch} [args.fetchImpl] 测试注入
 * @returns {Promise<Array<{id:string,name:string,description?:string,contextWindow:number,maxTokens:number,inputModalities:string[]}>>}
 * @throws 响应无 data 或全部被过滤时抛错（调用方降级静态目录）
 */
export async function discoverModels({ baseUrl, key, fetchImpl = fetch }) {
  const url = `${baseUrl.replace(/\/+$/, '')}/models`
  const response = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
  })
  if (!response.ok) {
    throw new Error(`/v1/models 拉取失败 HTTP ${response.status}`)
  }
  const data = await response.json()
  const rows = Array.isArray(data.data) ? data.data : []
  if (rows.length === 0) throw new Error('/v1/models 响应没有 data 数组')
  const normalizeMods = (raw) => {
    if (!Array.isArray(raw)) return ['text']
    const mods = raw.filter((m) => m === 'text' || m === 'image')
    return mods.length > 0 ? mods : ['text']
  }
  return rows
    .filter((row) => row && typeof row.id === 'string' && row.id !== '')
    .filter((row) => {
      // 非 LLM（不输出文本）不显示：output_modalities 缺省视为 text 输出；明确不含 text 则剔除
      const out = row.output_modalities
      return !Array.isArray(out) || out.includes('text')
    })
    .map((row) => ({
      id: row.id,
      name: row.name ?? row.id,
      ...(typeof row.description === 'string' && row.description !== '' ? { description: row.description } : {}),
      contextWindow: Number(row.context_length) > 0 ? Number(row.context_length) : FALLBACK_CONTEXT_WINDOW,
      maxTokens: Number(row.max_output_length) > 0 ? Number(row.max_output_length) : FALLBACK_MAX_TOKENS,
      inputModalities: normalizeMods(row.input_modalities),
    }))
}
