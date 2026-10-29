// ============================================================
// note-agent 主程序
// 整体流程：用户提问 → 模型决定要不要调工具 → 本地执行工具
//          → 结果回灌进对话历史 → 再问模型 → 循环直到它给出答案
// ============================================================

// ---------- 一、导入：工具函数 + 共享客户端 ----------

// 工具①：按关键词搜笔记，返回 [{ file, snippet }]
import { searchNotes } from './tools/searchNotes.js'
// 工具②：读一篇笔记的完整正文，返回 { ok, path, length, content }
import { readNote } from './tools/readNote.js'
// 工具③：写报告文件（内部含"路径白名单 + y/n 人工确认"两道闸）
import { writeReport } from './tools/writeReport.js'
// 工具④：每次工具调用写一行 JSONL 日志
import { logToolCall } from './tools/logs.js'
// 工具⑤（辅助）：累计 token 用量，getCost 取总账
import { getCost, logCost } from './tools/logCost.js'
// 共享的 API 客户端：apiKey / baseURL 都在那里读和建，全项目只有一份
import { client } from './llm/client.js'
// 从终端读一行用户输入。promises 版本才有能 await 的 question()
import { createInterface } from 'node:readline/promises'
// 结构化输出：模型吐 JSON → zod 校验 → 不合格重试；reportToMarkdown 把结果渲染成 Markdown
import { askStructured, reportToMarkdown } from './llm/structured.js'
// 复用已有的确认函数，别再新开一个 readline
import { confirm } from './tools/confirm.js'
// 类型 1：对话消息。四种角色 system / user / assistant / tool
// import type 表示"只导入类型"，编译后会被擦掉，运行时不存在
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions'
// 类型 2：工具描述的结构，用来约束下面 tools 数组
import type { ChatCompletionTool } from 'openai/resources/chat/completions'

// ------------------------------------------------------------
// 二、工具清单（给模型看的"说明书"）
// 关键认知：这里只声明"有什么工具、参数是什么"，不执行任何逻辑。
// 真正执行在下面循环里，按 call.function.name 分派。
// description 写得越清楚，模型越知道什么时候该用它。
// ------------------------------------------------------------
const tools: ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'search_notes',
      description: '在本地 Markdown 笔记库里按关键词搜索，返回命中的文件名和片段',
      // parameters 用 JSON Schema 描述参数形状
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '要搜索的关键词' },
        },
        // required 里的参数模型必须给，漏了会被服务端拒绝
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_report',
      description: '把整理好的内容写成一份报告文件，只能写到 reports/ 目录下',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '报告路径，例如 reports/week.md' },
          content: { type: 'string', description: '报告的完整 Markdown 内容' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_note',
      // 这句"先搜再读"很重要：模型靠它建立"两步走"的认知
      description:
        '读取 notes/ 目录下某个 Markdown 笔记的完整正文。先用 search_notes 找到文件名，再用这个读全文',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '笔记的相对路径，例如 notes/学习.md' },
        },
        required: ['path'],
      },
    },
  },
]

// ------------------------------------------------------------
// 三、主循环
// 整个 try 包住，是为了让请求失败（401/网络断/解析错）只打一句人话，
// 而不是甩一屏红色堆栈
// ------------------------------------------------------------
try {
  // 问用户要做什么。三方配合：createInterface 打开输入流 → question 等一行 → close 立刻关上。
  // close 不能省：后面 writeReport 的 y/n 确认会自己开一个 readline，
  // 两个同时开着会抢同一个 stdin，表现就是程序卡住不动
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  // 有命令行参数就用参数，没有才交互问 —— 自动化调用和手动调试两种用法
  const fromArgv = process.argv[2]
  const asked = fromArgv ?? (await rl.question('你的问题（直接回车用默认）：')).trim()

  // 已经拿到一行输入，立刻关掉，再让 confirm 需要时自己打开
  rl.close()

  // 空输入退回默认问题，方便反复跑
  const DEFAULT_QUESTION =
    '把笔记里关于学习的完整内容读出来，整理成一份详细的周报，写到 reports/week.md'
  // || 在这里的意思是：asked 为空字符串时，取右边的默认值
  const userQuestion = asked || DEFAULT_QUESTION

  // messages 是"完整对话历史"，也是模型唯一的记忆载体。
  // 模型每一轮都只读这个数组，它本身不记得上一轮发生了什么。
  const messages: ChatCompletionMessageParam[] = [
    {
      // role: 'system' 是"规矩"，优先级高于 user，模型每轮都会读到。
      // 这里只要求检索和阅读，不让模型自己落盘；写文件出口留在主流程末尾
      role: 'system',
      content:
          '你是本地笔记助手。规则：先用 search_notes 找到相关笔记，再用 read_note 读全文，' +
          '最多调用 3 次 search_notes，不要在搜索上空转。' +
          '不要自己写文件——写报告由后续步骤统一完成。' +
          '资料够了就把掌握的内容完整列出来，细节不要省。',
    },
    // 用户的实际需求。路径写清楚，模型就不用瞎猜该写哪儿
    {
      role: 'user',
      content: userQuestion,
    },
  ]

  // round：已经请求了几轮，硬上限 8，防止模型无限调工具烧钱
  let round = 0
  // finished：是否正常拿到最终答案。用来区分"正常结束"和"超轮中止"
  let finished = false
  // 循环里的最终回答要带出来给后面的结构化用。
  // 为什么必须声明在 while 外面：msg 是 while 块里的 const，出了大括号就没了（块作用域）。
  // ?? '' 是因为 content 的类型是 string | null，直接赋给 string 会报 TS2322
  let finalAnswer = ''
  // searchCount：已经搜了几次，配合 MAX_SEARCH 做"软刹车"
  let searchCount = 0
  const MAX_SEARCH = 3

  while (round < 8) {
    round++
    console.log(`--- 第 ${round} 轮 ---`)

    // 发请求：带上完整历史 + 工具清单。
    // 模型会返回两种结果之一：
    //   a) 纯文字回答（没有 tool_calls）→ 说明它说完了
    //   b) 工具调用请求（有 tool_calls）→ 说明它想先动手查
    const resp = await client.chat.completions.create({
      model: 'deepseek-flash',
      messages,
      tools,
    })
    // 累计 token。usage 可能为空，?? 0 兜底，避免 NaN 污染总数
    logCost(resp.usage?.total_tokens ?? 0)

    // 取本轮回复。必须先原样 push 进历史：
    // 下一轮模型要靠这条 assistant 消息里的 tool_calls 才能对上下面的 tool 结果
    const msg = resp.choices[0].message
    messages.push(msg)

    // 有 tool_calls = 模型要动手。一次可能要好几个工具（比如同时搜三个词）
    if (msg.tool_calls && msg.tool_calls.length > 0) {
      for (const call of msg.tool_calls) {
        // 只处理 function 类型；其他类型跳过
        if (call.type !== 'function') continue

        // arguments 是 JSON 字符串（不是对象！），必须 parse 才能取字段
        const args = JSON.parse(call.function.arguments)
        // 记开始时间，用来算这次工具调用耗时
        const started = Date.now()

        // toolResult 用 unknown：三种工具返回的形状不一样，先当"未知"装着，
        // 需要取属性时要用有具体类型的局部变量（见 read_note 分支）
        let toolResult: unknown

        // ---------- 按工具名分派：这就是 agent 的"路由表" ----------
        // 以后加新工具，就往这里加一个 else if
        if (call.function.name === 'search_notes') {
          if (searchCount >= MAX_SEARCH) {
            // 软刹车：不直接 break，而是把"到上限了"作为结果告诉模型，
            // 让它自己转向写报告。用结果引导，而不是硬拔电源
            toolResult = {
              ok: false,
              reason: `搜索次数已达上限（${MAX_SEARCH} 次），请直接整理已读到的内容，不要再搜`,
            }
          } else {
            searchCount++
            const results = await searchNotes(args.query)
            console.log(`  搜「${args.query}」→ 命中 ${results.length} 条`)
            toolResult = results
          }
        } else if (call.function.name === 'write_report') {
          // 写文件的两道闸在 writeReport 内部：路径白名单 → y/n 确认
          toolResult = await writeReport(args.path, args.content)
          console.log(`  写报告 ${args.path} →`, toolResult)
        } else if (call.function.name === 'read_note') {
          // 先存到有类型的局部变量：因为 toolResult 是 unknown，
          // 直接写 toolResult.ok 会报 TS18046。取完属性再赋给它
          const note = await readNote(args.path)
          console.log(`  读「${args.path}」→`, note.ok ? '成功' : note.reason)
          toolResult = note
        } else {
          // 未知工具不能静默忽略：告诉模型"没这个工具"，它才知道自己搞错了
          toolResult = { ok: false, reason: `未知工具：${call.function.name}` }
        }

        const elapsed = Date.now() - started

        // 每次工具调用写一行 JSONL 日志。
        // retried 暂时写死 false，等接入结构化重试后再改成真实值
        await logToolCall({
          time: new Date().toISOString(),
          tool: call.function.name,
          args,
          result: toolResult,
          ms: elapsed,
          tokens: resp.usage?.total_tokens,
          retried: false,
        })

        // 把结果回灌进历史。这条 tool 消息靠 tool_call_id 挂到上面那条
        // assistant 消息下面；漏一条，下一轮请求会因"请求数≠结果数"被拒（400）。
        // content 必须是字符串，所以要把结果序列化
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify(toolResult),
        })
      }

      // 这一轮只是"举手要工具"，还没给答案 → 回顶部再问一轮
      continue
    }

    // 走到这里说明模型没有要工具，它给的是最终答案
    console.log('最终回答：', msg.content)
    // 存一份到循环外面，结构化那步要用这段当素材
    finalAnswer = msg.content ?? ''
    finished = true
    // 必须在 break 之前置标记：break 一跳出去就再也回不到下面了
    break
  }

  // 没正常结束 = 转满 8 轮还在要工具，属于失控，必须记原因
  if (!finished) {
    console.log(`超过 8 轮仍未结束，中止（搜索 ${searchCount} 次）`)
  }
  // 看完回答再问要不要出周报：这是唯一的确认点，落盘时不再重复问
  const wantReport = await confirm('要整理成周报文件吗？(y/n) ')
  // ---------- 四、把最终回答整理成结构化周报 ----------
  // 走到这里说明工具调用已经结束，素材在 finalAnswer 里。
  // askStructured 负责：让模型吐 JSON → zod 校验 → 不合格把错误塞回去重试，最多 3 次
  if (wantReport) {
    const structured = await askStructured(
      client,
      // 系统提示里必须出现 JSON；其中 schema 说明告诉模型要填哪些字段
      '你是周报整理助手。只输出 JSON，不要任何解释文字。' +
        'JSON 格式：{"title": string, "summary": string, "items": [{"topic": string, "detail": string}]}',
      // 把循环最终回答作为结构化素材；\n 是换行，让提示词和素材分开
      `请根据下面的内容整理成周报：\n${finalAnswer}`,
    )
    if (!structured.ok) {
      // 三次都不合格：打印原因，不落盘（宁可没有周报，也不写一份错的）
      console.log('结构化失败：', structured.error)
    } else {
      // if 收窄类型后，这里才能安全访问 structured.data
      // 渲染成 Markdown 文本
      const md = reportToMarkdown(structured.data)

      // 阶段三的落盘也要写 JSONL：要求是「每次写文件都有一行日志」，
      // 不能因为这次是代码调的、不是模型调的，就不记。
      // confirmed=true 表示上面已经问过用户；路径白名单仍然会在 writeReport 内执行
      const writeStarted = Date.now()
      const written = await writeReport('reports/week.md', md, true)
      await logToolCall({
        time: new Date().toISOString(),
        tool: 'write_report',
        args: { path: 'reports/week.md' },
        result: written,
        ms: Date.now() - writeStarted,
        tokens: 0, // 这一步没请求模型，token 记 0，别假装有
        retried: structured.attempts > 1, // 结构化重试过就记 true，这才是真实的重试痕迹
      })
      console.log('落盘结果：', written)
    }
  } else {
    // 用户只想看回答时，不发送结构化请求，也不创建或覆盖报告
    console.log('（未生成周报文件，只保留上面的回答）')
  }
  // 打印本次会话总账
  const cost = getCost()
  console.log(`本次会话：${cost.totalCalls} 轮请求，共 ${cost.totalTokens} tokens`)
} catch (e) {
  // 统一兜底：请求失败、JSON.parse 出错、日志写入失败都会落到这里。
  // catch 的 e 类型是 unknown，要先判断是不是 Error 才能取 message
  console.error('请求失败：', e instanceof Error ? e.message : e)
}
