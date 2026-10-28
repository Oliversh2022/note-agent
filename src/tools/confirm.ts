// createInterface 把标准输入/输出包装成一个"问答通道"
import { createInterface } from 'node:readline/promises'

// 在终端抛出问题并等用户输入，返回 true 表示同意（输入 y）
export async function confirm(question: string): Promise<boolean> {
  // input: 从哪里读（键盘），output: 往哪里写（屏幕）
  const rl = createInterface({ input: process.stdin, output: process.stdout })

  try {
    // question() 打印问题并"卡住"等用户回车，返回用户敲的那串字符
    // 等于 Python 的 input()
    const answer = await rl.question(question)

    // trim() 去首尾空格，toLowerCase() 转小写
    // 所以 'y'、'Y'、'  y  ' 都算同意；其他输入（包括空回车）一律算拒绝
    // === 是严格相等，JS 里不要用 ==（== 会偷偷转类型，'0' == 0 居然是 true）
    return answer.trim().toLowerCase() === 'y'
  } finally {
    // 无论成功还是抛异常，都必须关闭通道，否则进程会一直挂着不退出
    rl.close()
  }
}