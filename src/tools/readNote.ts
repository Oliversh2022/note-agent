// readFile = 把整个文件读成字符串
import { readFile } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
// 读取一篇笔记的完整正文。
// 为什么要"先 search 再 read"：搜索只返回片段，
// 模型要写完整内容时必须能拿到全文
export async function readNote(path: string) {
  const notesDir = resolve('notes')
  const target = resolve(path)
// 两个条件都要：必须在 notes 目录之下，且必须是 .md
  if (!target.startsWith(notesDir + sep) || !target.endsWith('.md')) {
    return { ok: false, reason: `只允许读取 notes/ 目录下的 .md 文件，收到：${path}` }
  }

  try {
    // 'utf8' 必须给，否则拿到的是字节（Buffer），中文会乱
    const content = await readFile(target, 'utf8')
    // length 让模型先知道文件多大，决定要不要整篇引用 / 怎么总结
    return { ok: true, path, length: content.length, content }
  } catch {
    // 文件不存在会抛异常。工具内部必须自己兜住，
    // 不能让异常冒到主循环把整个 agent 崩掉。
    // 这里不写 catch (e)，是因为不关心具体错误内容
    return { ok: false, reason: `读取失败，文件可能不存在：${path}` }
  }
}