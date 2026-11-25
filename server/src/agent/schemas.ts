import { z } from 'zod';

// 工具参数 schema：zod 用于运行时校验，JSON Schema 用于喂给 LLM（两者字段保持一致）
export const generateImageParams = z.object({
  prompt: z.string().min(1, 'prompt 不能为空'),
  n: z.number().int().min(1).max(10).default(1),
  size: z.enum(['1024x1024', '1536x1024', '1024x1536', 'auto']).default('1024x1024'),
  quality: z.enum(['low', 'medium', 'high', 'auto']).default('high'),
  model: z.string().default('gpt-image-1'),
  output_format: z.enum(['png', 'jpeg', 'webp']).default('png'),
  output_compression: z.number().int().min(0).max(100).default(100),
  background: z.enum(['auto', 'opaque', 'transparent']).default('auto'),
  moderation: z.enum(['auto', 'low']).default('auto'),
});

export const editImageParams = z.object({
  prompt: z.string().min(1, 'prompt 不能为空'),
  n: z.number().int().min(1).max(10).default(1),
  size: z.enum(['1024x1024', '1536x1024', '1024x1536', 'auto']).default('auto'),
  quality: z.enum(['low', 'medium', 'high', 'auto']).default('high'),
  model: z.string().default('gpt-image-1'),
  output_format: z.enum(['png', 'jpeg', 'webp']).default('png'),
  use_last_image: z.boolean().default(true),
  /** 指定会话内某张图：按生成序号（1=最早）或图片 id；优先于 use_last_image / 上传图 */
  image_index: z.number().int().min(1).optional(),
  image_id: z.string().optional(),
});

// OpenAI function calling 用的 JSON Schema
export const toolDefinitions = [
  {
    type: 'function' as const,
    function: {
      name: 'generate_image',
      description: '根据用户描述的画面生成全新图片。当用户要求画图/生成图/出图时调用。',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: '图片内容的详细描述' },
          n: { type: 'integer', minimum: 1, maximum: 10, description: '生成数量' },
          size: { type: 'string', enum: ['1024x1024', '1536x1024', '1024x1536', 'auto'] },
          quality: { type: 'string', enum: ['low', 'medium', 'high', 'auto'] },
          model: { type: 'string', description: '图像模型，如 gpt-image-1' },
          output_format: { type: 'string', enum: ['png', 'jpeg', 'webp'] },
          output_compression: { type: 'integer', minimum: 0, maximum: 100 },
          background: { type: 'string', enum: ['auto', 'opaque', 'transparent'] },
          moderation: { type: 'string', enum: ['auto', 'low'] },
        },
        required: ['prompt'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'edit_image',
      description: '编辑用户上传的图片或最近生成的图片。当用户要求修改/重绘/换风格时调用；用户上传图片时优先使用上传图。',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: '修改要求' },
          n: { type: 'integer', minimum: 1, maximum: 10 },
          size: { type: 'string', enum: ['1024x1024', '1536x1024', '1024x1536', 'auto'] },
          quality: { type: 'string', enum: ['low', 'medium', 'high', 'auto'] },
          model: { type: 'string' },
          output_format: { type: 'string', enum: ['png', 'jpeg', 'webp'] },
          use_last_image: { type: 'boolean', description: 'true=用最近生成的图，false=用用户上传的图' },
          image_index: { type: 'integer', minimum: 1, description: '按会话内生成序号编辑指定图，1=最早生成的第一张；优先于 use_last_image' },
          image_id: { type: 'string', description: '按图片 id 编辑指定图；优先于 image_index' },
        },
        required: ['prompt'],
        additionalProperties: false,
      },
    },
  },
];
