// 从 Node 自带的文件模块取出两个函数：
// appendFile = 往文件末尾追加内容（不会覆盖已有内容）
// mkdir      = 创建目录
import { appendFile, mkdir } from 'node:fs/promises'

// 记录一次工具调用：把 entry 写成一整行 JSON，追加到 logs/agent.jsonl
// entry 的字段由调用方决定（时间、工具名、入参、返回、耗时、token、是否重试）
// Record<string, unknown> = 键是字符串、值是任意类型的对象
export async function logToolCall(entry: Record<string, unknown>) {
  // 目录不存在就创建；recursive: true 表示已存在也不报错、可建多级目录
  await mkdir('logs', { recursive: true })

  // JSON.stringify(entry) 把对象转成 JSON 字符串
  // 末尾的 '\n' 是关键：一行一条记录，这就是 JSONL（JSON Lines）格式
  // 内容里的换行会被 stringify 转义成 \n，所以一条记录永远只占物理上一行
  await appendFile('logs/agent.jsonl', JSON.stringify(entry) + '\n')
}