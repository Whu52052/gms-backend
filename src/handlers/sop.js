/**
 * SOP 文档管理
 */
'use strict';

const fs = require('fs');
const path = require('path');

const UPLOAD_DIR = path.join(__dirname, '..', '..', 'uploads', 'sop');

module.exports = function createSOPHandlers(deps) {
  const { pool, sendJSON } = deps;

  // Ensure upload directory exists
  try { fs.mkdirSync(UPLOAD_DIR, { recursive: true }); } catch(e) {}

  async function handleList(req, res, authUser) {
    try {
      const [rows] = await pool.execute(
        'SELECT id, title, category, url, kind, content, mime, uploaded_by, uploaded_at FROM sop_documents ORDER BY category, title'
      );
      sendJSON(res, rows);
    } catch(e) {
      sendJSON(res, { error: e.message }, 500);
    }
  }

  async function handleCreate(req, res, authUser, body) {
    const { title, url, category, kind, content, mime } = body || {};
    const k = kind || 'url'; // url | text | file
    const cat = category || '默认';

    if (!title) {
      return sendJSON(res, { error: '标题不能为空' }, 400);
    }
    if (k === 'url' && !url) {
      return sendJSON(res, { error: '链接不能为空' }, 400);
    }
    if (k === 'text' && !content) {
      return sendJSON(res, { error: '内容不能为空' }, 400);
    }

    try {
      const now = new Date().toISOString();
      let savedContent = content;
      let savedUrl = url;
      let savedMime = mime;

      // If kind is 'file', save base64 content to disk
      if (k === 'file' && content) {
        const matches = content.match(/^data:([^;]+);base64,(.+)$/);
        if (matches) {
          savedMime = matches[1];
          const ext = mimeToExt(matches[1]) || '.bin';
          if (!['.pdf', '.png', '.jpg', '.gif', '.webp', '.txt', '.md'].includes(ext)) {
            return sendJSON(res, { error: '不支持的文件类型' }, 400);
          }
          const fileName = `sop_${Date.now()}_${Math.random().toString(36).slice(2,8)}${ext}`;
          const filePath = path.join(UPLOAD_DIR, fileName);
          fs.writeFileSync(filePath, Buffer.from(matches[2], 'base64'));
          savedContent = fileName;
          savedUrl = null;
        } else {
          // Already a file path or non-base64 — just keep as-is
          savedContent = content;
        }
      }

      const [r] = await pool.execute(
        'INSERT INTO sop_documents (title, category, url, kind, content, mime, uploaded_by, uploaded_at) VALUES (?,?,?,?,?,?,?,?)',
        [title, cat, savedUrl || null, k, savedContent || null, savedMime || null, authUser.userId || authUser.id || null, now]
      );
      sendJSON(res, { success: true, id: r.insertId });
    } catch(e) {
      sendJSON(res, { error: e.message }, 500);
    }
  }

  async function handleDelete(req, res, authUser, body) {
    const { id } = body || {};
    if (!id) return sendJSON(res, { error: '缺少id' }, 400);
    try {
      // Get file info before deleting
      const [rows] = await pool.execute('SELECT kind, content FROM sop_documents WHERE id = ?', [id]);
      if (rows.length && rows[0].kind === 'file' && rows[0].content) {
        const filePath = path.join(UPLOAD_DIR, rows[0].content);
        try { fs.unlinkSync(filePath); } catch(e) {}
      }
      await pool.execute('DELETE FROM sop_documents WHERE id = ?', [id]);
      sendJSON(res, { success: true });
    } catch(e) {
      sendJSON(res, { error: e.message }, 500);
    }
  }

  // Serve uploaded files
  async function handleServeFile(req, res, authUser, fileName) {
    if (!fileName || fileName.includes('..') || fileName.includes('/')) {
      res.writeHead(400); res.end('Bad request');
      return;
    }
    const filePath = path.join(UPLOAD_DIR, fileName);
    try {
      if (!fs.existsSync(filePath)) {
        res.writeHead(404); res.end('Not found');
        return;
      }
      const mime = mimeFromExt(path.extname(fileName)) || 'application/octet-stream';
      res.writeHead(200, {
        'Content-Type': mime,
        'Content-Disposition': `attachment; filename="${path.basename(fileName)}"`,
        'Cache-Control': 'max-age=86400',
      });
      fs.createReadStream(filePath).pipe(res);
    } catch(e) {
      res.writeHead(500); res.end('Server error');
    }
  }

  return { handleList, handleCreate, handleDelete, handleServeFile };
};

function mimeToExt(mime) {
  const map = {
    'application/pdf': '.pdf',
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/svg+xml': '.svg',
    'text/plain': '.txt',
    'text/html': '.html',
    'text/markdown': '.md',
  };
  return map[mime] || '.bin';
}

function mimeFromExt(ext) {
  const map = {
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.txt': 'text/plain',
    '.html': 'text/html',
    '.md': 'text/markdown',
  };
  return map[ext] || 'application/octet-stream';
}