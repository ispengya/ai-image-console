import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import type { GeneratedImage, ConversationSummary, ChatMessage } from '../types.js';

// Node 22 内置 sqlite（实验性），避免原生模块编译
const { DatabaseSync } = await import('node:sqlite');
const db = new DatabaseSync(path.join(config.outputDir, 'history.sqlite'));
db.exec(`
  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    title TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS images (
    id TEXT PRIMARY KEY,
    prompt TEXT NOT NULL,
    size TEXT,
    quality TEXT,
    model TEXT,
    format TEXT,
    kind TEXT,
    file TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    image_ids TEXT NOT NULL DEFAULT '[]',
    meta TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);
`);

// 老库迁移：给既有 images 表补会话字段
const imageCols = db.prepare('PRAGMA table_info(images)').all() as Array<{ name: string }>;
if (!imageCols.some((c) => c.name === 'conversation_id')) {
  db.exec('ALTER TABLE images ADD COLUMN conversation_id TEXT');
}
if (!imageCols.some((c) => c.name === 'parent_id')) {
  db.exec('ALTER TABLE images ADD COLUMN parent_id TEXT');
}

/** 会话 ID 只允许安全字符，防止路径穿越 */
export function isValidConversationId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(id);
}

function rowToMessage(row: any): ChatMessage {
  let imageIds: string[] = [];
  let meta: Record<string, unknown> = {};
  try { imageIds = JSON.parse(row.image_ids || '[]'); } catch { /* 老数据忽略 */ }
  try { meta = JSON.parse(row.meta || '{}'); } catch { /* 老数据忽略 */ }
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role,
    content: row.content,
    imageIds: Array.isArray(imageIds) ? imageIds : [],
    skill: typeof meta.skill === 'string' ? meta.skill : undefined,
    attachmentName: typeof meta.attachmentName === 'string' ? meta.attachmentName : undefined,
    attachmentImageId: typeof meta.attachmentImageId === 'string' ? meta.attachmentImageId : undefined,
    createdAt: row.created_at,
  };
}

function rowToImage(row: any): GeneratedImage {
  return {
    id: row.id,
    url: `/api/images/${row.id}`,
    prompt: row.prompt,
    size: row.size,
    quality: row.quality,
    model: row.model,
    format: row.format,
    kind: row.kind,
    conversationId: row.conversation_id ?? undefined,
    parentId: row.parent_id ?? undefined,
    createdAt: row.created_at,
  };
}

/** 图片相对 outputs 目录的路径（含会话子目录） */
function relativeFile(conversationId: string, filename: string, subdir = ''): string {
  return subdir ? `${conversationId}/${subdir}/${filename}` : `${conversationId}/${filename}`;
}

export const storage = {
  /** 会话 upsert：首次写入标题（首条 prompt 截取），此后仅更新 updated_at */
  ensureConversation(id: string, title?: string): void {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         updated_at = excluded.updated_at,
         title = CASE WHEN conversations.title IS NULL OR conversations.title = '' THEN excluded.title ELSE conversations.title END`
    ).run(id, (title || '').replace(/\s+/g, ' ').trim().slice(0, 60), now, now);
  },

  /** 落库一条对话消息（用户文本 / 助手文本 + 本轮图片 ID） */
  saveMessage(opts: {
    conversationId: string;
    role: 'user' | 'assistant';
    content: string;
    imageIds?: string[];
    skill?: string;
    attachmentName?: string;
    attachmentImageId?: string;
  }): ChatMessage {
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const meta = {
      ...(opts.skill ? { skill: opts.skill } : {}),
      ...(opts.attachmentName ? { attachmentName: opts.attachmentName } : {}),
      ...(opts.attachmentImageId ? { attachmentImageId: opts.attachmentImageId } : {}),
    };
    db.prepare(
      `INSERT INTO messages (id, conversation_id, role, content, image_ids, meta, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(id, opts.conversationId, opts.role, opts.content,
      JSON.stringify(opts.imageIds ?? []), JSON.stringify(meta), createdAt);
    this.touchConversation(opts.conversationId);
    return rowToMessage({
      id, conversation_id: opts.conversationId, role: opts.role, content: opts.content,
      image_ids: JSON.stringify(opts.imageIds ?? []), meta: JSON.stringify(meta), created_at: createdAt,
    });
  },

  /** 会话消息历史（时间正序），用于切回会话原样恢复对话 */
  listMessages(conversationId: string, limit = 200): ChatMessage[] {
    const rows: any[] = db.prepare(
      'SELECT * FROM (SELECT *, rowid AS _seq FROM messages WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?) ORDER BY created_at ASC, _seq ASC'
    ).all(conversationId, limit);
    return rows.map(rowToMessage);
  },

  /** 会话列表（含图片数与缩略图） */
  listConversations(): ConversationSummary[] {
    const rows: any[] = db.prepare('SELECT * FROM conversations ORDER BY updated_at DESC').all();
    return rows.map((row) => {
      const count: any = db.prepare(
        "SELECT COUNT(*) AS n FROM images WHERE conversation_id = ? AND kind IN ('generate','edit')"
      ).get(row.id);
      const latest: any = db.prepare(
        "SELECT id FROM images WHERE conversation_id = ? AND kind IN ('generate','edit') ORDER BY created_at DESC LIMIT 1"
      ).get(row.id);
      return {
        id: row.id,
        title: row.title || '未命名对话',
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        imageCount: count?.n || 0,
        thumbUrl: latest ? `/api/images/${latest.id}` : null,
      };
    });
  },

  /** 保存 base64 图片到会话目录并写入历史 */
  saveImage(opts: {
    base64: string;
    format: string;
    prompt: string;
    size: string;
    quality: string;
    model: string;
    kind: 'generate' | 'edit' | 'source';
    conversationId: string;
    parentId?: string | null;
  }): GeneratedImage {
    const id = crypto.randomUUID();
    const ext = opts.format === 'jpeg' ? 'jpg' : opts.format;
    const filename = `${id}.${ext}`;
    const file = relativeFile(opts.conversationId, filename, opts.kind === 'source' ? 'sources' : '');
    const filepath = path.join(config.outputDir, file);
    fs.mkdirSync(path.dirname(filepath), { recursive: true });
    fs.writeFileSync(filepath, Buffer.from(opts.base64, 'base64'));

    const createdAt = new Date().toISOString();
    db.prepare(
      `INSERT INTO images (id, prompt, size, quality, model, format, kind, file, conversation_id, parent_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id, opts.prompt, opts.size, opts.quality, opts.model, opts.format, opts.kind,
      file, opts.conversationId, opts.parentId ?? null, createdAt
    );
    this.touchConversation(opts.conversationId);
    const result = rowToImage({ id, prompt: opts.prompt, size: opts.size, quality: opts.quality,
      model: opts.model, format: opts.format, kind: opts.kind, file,
      conversation_id: opts.conversationId, parent_id: opts.parentId ?? null, created_at: createdAt });
    if (opts.kind !== 'source') {
      // 新落盘的生成/编辑图必然是本会话最后一张，序号 = 当前会话产物总数
      const row: any = db.prepare(
        "SELECT COUNT(*) AS n FROM images WHERE conversation_id = ? AND kind IN ('generate','edit')"
      ).get(opts.conversationId);
      result.index = row?.n ?? 0;
    }
    return result;
  },

  /** 落盘用户上传的原图，返回可用于 edit 的来源记录 */
  saveSourceImage(opts: { base64: string; name: string; mimeType: string; conversationId: string }): GeneratedImage {
    const ext = (opts.mimeType.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'png';
    return this.saveImage({
      base64: opts.base64, format: ext, prompt: `上传原图：${opts.name}`,
      size: '', quality: '', model: '', kind: 'source', conversationId: opts.conversationId,
    });
  },

  touchConversation(id: string): void {
    db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), id);
  },

  /** 按 id 找到图片文件路径 */
  getImagePath(id: string): { filepath: string; mime: string } | null {
    const row: any = db.prepare('SELECT file, format FROM images WHERE id = ?').get(id);
    if (!row) return null;
    const filepath = path.join(config.outputDir, row.file);
    // 防穿越：解析后必须仍在 outputDir 内
    if (!filepath.startsWith(config.outputDir + path.sep)) return null;
    return { filepath, mime: `image/${row.format === 'jpg' ? 'jpeg' : row.format}` };
  },

  /** 历史列表（新在前）；传 conversationId 则只返回该会话的生成/编辑产物 */
  listImages(limit = 50, conversationId?: string, includeSources = false): GeneratedImage[] {
    const kindFilter = includeSources ? '' : "AND kind IN ('generate','edit')";
    let rows: any[];
    if (conversationId) {
      rows = db.prepare(
        `SELECT * FROM images WHERE conversation_id = ? ${kindFilter} ORDER BY created_at DESC LIMIT ?`
      ).all(conversationId, limit);
    } else {
      rows = db.prepare(
        `SELECT * FROM images WHERE 1=1 ${kindFilter} ORDER BY created_at DESC LIMIT ?`
      ).all(limit);
    }
    const images = rows.map(rowToImage);
    // 附会话内生成序号：新在前，序号从尾部倒数；source 图不编号
    if (conversationId) {
      const row: any = db.prepare(
        "SELECT COUNT(*) AS n FROM images WHERE conversation_id = ? AND kind IN ('generate','edit')"
      ).get(conversationId);
      const total = row?.n ?? 0;
      let seen = 0;
      for (const img of images) {
        if (img.kind === 'source') continue;
        img.index = total - seen;
        seen++;
      }
    }
    return images;
  },

  /** 按 id 读取图片（base64 + mime），供多模态把已落盘的历史图片重新喂给模型 */
  getImageData(id: string): { base64: string; mime: string } | null {
    const found = this.getImagePath(id);
    if (!found || !fs.existsSync(found.filepath)) return null;
    return { base64: fs.readFileSync(found.filepath).toString('base64'), mime: found.mime };
  },

  /** 会话内最近一张上传原图（kind='source'） */
  getLastSource(conversationId: string): GeneratedImage | null {
    const row: any = db.prepare(
      "SELECT * FROM images WHERE conversation_id = ? AND kind = 'source' ORDER BY created_at DESC LIMIT 1"
    ).get(conversationId);
    return row ? rowToImage(row) : null;
  },

  /** 会话内最近一张可用作编辑来源的图 */
  getLastGenerated(conversationId: string): GeneratedImage | null {
    const row: any = db.prepare(
      "SELECT * FROM images WHERE conversation_id = ? AND kind IN ('generate','edit') ORDER BY created_at DESC LIMIT 1"
    ).get(conversationId);
    return row ? rowToImage(row) : null;
  },

  /** 删除会话：清数据库记录 + 删整个会话目录 */
  deleteConversation(id: string): boolean {
    const result = db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
    db.prepare('DELETE FROM images WHERE conversation_id = ?').run(id);
    db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(id);
    const dir = path.join(config.outputDir, id);
    if (dir.startsWith(config.outputDir + path.sep)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    return result.changes > 0;
  },
};
