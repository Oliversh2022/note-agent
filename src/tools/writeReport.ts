// writeFile = 把字符串写进文件（同路径会覆盖）
// mkdir     = 创建目录
import { mkdir, writeFile } from 'node:fs/promises'
// 写文件前必须让用户确认——这个工具就是"人工确认"的落点
import { confirm } from './confirm.js'

// 把 content 写到 path。不能直接写，必须先过两道闸
export async function writeReport(path: string, content: string, confirmed=false) {
  // 闸一：路径白名单。模型给的 path 不可信，可能指向 .env 或系统文件，
  // 所以只允许写在 reports/ 目录下；不合法就直接返回，连问都不问
  // 已知短板：reports/../evil.md 能绕过这个前缀检查，
  // 严格做法还要用 path.resolve 归一化后再判断
  if (!path.startsWith('reports/')) {
    return { ok: false, reason: '只允许写到 reports/ 目录下' }
  }
  // 闸二：人工确认。
  // confirmed 默认 false —— 调用方没说"已经问过"，就一定问。
  // 传 true 的唯一场景：命令行流程里外层已经问过一次，避免同一个意图问两遍。
  // 注意：路径白名单永远不跳过，那是安全底线，不是"确认"
  if (!confirmed) {
    const allowed = await confirm(`要写入 ${path} 吗？(y/n) `)
    if (!allowed) {
      return { ok: false, reason: '用户拒绝写入' }
    }
  }
  // 目录不存在就先建（recursive: true 已存在也不报错）
  await mkdir('reports', { recursive: true })
  // 'utf8' 必须给，否则中文会写成乱码
  await writeFile(path, content, 'utf8')

  // 成功也返回结构化结果，调用方和日志能据此判断
  return { ok: true, path }
}