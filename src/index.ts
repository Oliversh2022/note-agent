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
  // messages 是"完整对话历史"，也是模型唯一的记忆载体。
  // 模型每一轮都只读这个数组，它本身不记得上一轮发生了什么。
  const messages: ChatCompletionMessageParam[] = [
    {
      // role: 'system' 是"规矩"，优先级高于 user，模型每轮都会读到。
      // 控制 agent 行为最有效的旋钮就是这里。
      role: 'system',
      content:
        '你是本地笔记助手。规则：最多调用 3 次 search_notes 收集信息；' +
        '收集够了就必须调用 write_report 把内容写成报告，不要在搜索上空转。' +
        '报告要基于搜到的真实内容，不要编造。',
    },
    // 用户的实际需求。路径写清楚，模型就不用瞎猜该写哪儿
    {
      role: 'user',
      content: '把笔记里关于学习的完整内容读出来，整理成一份详细的周报，写到 reports/week.md',
    },
  ]

  // round：已经请求了几轮，硬上限 8，防止模型无限调工具烧钱
  let round = 0
  // finished：是否正常拿到最终答案。用来区分"正常结束"和"超轮中止"
  let finished = false
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
              reason: `搜索次数已达上限（${MAX_SEARCH} 次），请直接整理已有信息并调用 write_report`,
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
    finished = true
    // 必须在 break 之前置标记：break 一跳出去就再也回不到下面了
    break
  }

  // 没正常结束 = 转满 8 轮还在要工具，属于失控，必须记原因
  if (!finished) {
    console.log(`超过 8 轮仍未结束，中止（搜索 ${searchCount} 次）`)
  }

  // 打印本次会话总账
  const cost = getCost()
  console.log(`本次会话：${cost.totalCalls} 轮请求，共 ${cost.totalTokens} tokens`)
} catch (e) {
  // 统一兜底：请求失败、JSON.parse 出错、日志写入失败都会落到这里。
  // catch 的 e 类型是 unknown，要先判断是不是 Error 才能取 message
  console.error('请求失败：', e instanceof Error ? e.message : e)
}
