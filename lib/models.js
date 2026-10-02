/**
 * 模型目录（2026-10-02 P0 实测 + round2 结论，见 DESIGN.md §2.3）。
 *
 * 上架四个模型；deepseek-flash（容量饱和）、deepseek-v4-pro / v4.1-flash /
 * u1-fast / u1.5-lite 不使用（不进目录）。目录可被 Config.models 覆盖。
 * contextWindow 为保守配置（P0 未探底），用户可覆盖。
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
