// 从 Node 自带的文件模块里取出两个函数：
// readdir = 读目录内容（等于 Python 的 os.listdir）
// readFile = 读文件内容（等于 Python 的 open().read()）

import { readdir, readFile } from 'node:fs/promises'

// async = 这个函数里有 await，所以调用它会先拿到"承诺"，要用 await 才能拿结果
// query: string = 参数是字符串，这是 TS 的类型标注，只做编译期检查
// Promise<{...}[]> = 这个函数最终会返回一组对象，每个对象有 file 和 snippet
export async function searchNotes(query: string): Promise<{ file: string; snippet: string }[]> {
  
  if (query.trim() === '') {
  return []
}// 如果关键词为空，直接返回空数组
  const files = await readdir('notes')// 读 notes 目录，得到文件名数组（相对路径，相对于你运行时所在的目录）

  // 只要 .md 结尾的（等于 Python 的 [n for n in files if n.endswith('.md')]）
  const markdownFiles = files.filter((name) => name.endsWith('.md'))

  // 准备一个空数组装结果。TS 要求先声明它是什么类型，所以写了 `: {...}[]`
  const results: { file: string; snippet: string }[] = []

  // 逐个文件处理（等于 Python 的 for name in markdownFiles:）
  for (const name of markdownFiles) {
    // 把整个文件读成字符串；'utf8' 必须写，不写会得到字节而不是文字，中文会乱
    // 反引号里的 ${name} 等于 Python 的 f"notes/{name}"
    const text = await readFile(`notes/${name}`, 'utf8')

    // 找关键词第一次出现的下标；找不到返回 -1（等于 Python 的 text.find(query)）
    const index = text.indexOf(query)

    // 只要找到了才处理（-1 表示没找到）
    if (index !== -1) {
      // 往前取 20 个字符，但不能小于 0（关键词在文件开头时会越界）
      const start = Math.max(0, index - 20)
      // 关键词后面再取 20 个，但不能超过文件总长度
      const end = Math.min(text.length, index + query.length + 20)
      // 截出这一段（等于 Python 的 text[start:end]），连同文件名存进结果数组
      results.push({ file: name, snippet: text.slice(start, end) })
    }
  }

  // 交回结果数组
  return results
}