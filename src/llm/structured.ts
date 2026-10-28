// ============================================================
// 结构化输出：让模型吐 JSON，并且保证"形状"是对的
//
// 完整链路：
//   模型文本（可能带 ```json 围栏、可能带解释）
//     → extractJson()  把 JSON 段"刮"出来
//     → JSON.parse()   可能抛异常，必须 try 兜住
//     → ReportSchema.safeParse()  校验形状，不抛异常
//     → 不合格：把「坏输出 + 错误原因」塞回 messages，重试
//
// 重要边界：zod 只验形状，不验真假。
// 字段齐、类型对、非空，就算通过——内容全是编的也照样通过。
// ============================================================

// zod：运行时校验库。TS 的类型只在编译期存在，zod 能在运行时真的检查数据
import { z } from 'zod'
import type OpenAI from 'openai'
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions'

// ---------- 1. 定义"我期望的 JSON 长什么样" ----------
// z.object = 一个对象；z.string().min(1) = 非空字符串；
// z.array(...).min(1) = 至少一个元素的数组
export const ReportSchema = z.object({
  title: z.string().min(1),
  summary: z.string().min(1),
  items: z
    .array(
      z.object({
        topic: z.string().min(1),
        detail: z.string().min(1),
      }),
    )
    .min(1),
})

// ---------- 2. 从 schema 反推出 TS 类型 ----------
// 定义写一遍，类型自动得到，不用手写两遍维护
export type Report = z.infer<typeof ReportSchema>

// ---------- 3. 从模型返回的文本里把 JSON "刮"出来 ----------
// 模型很爱这样回："好的，结果如下：```json {...} ``` 希望有帮助"
// 直接 JSON.parse 整段必炸，所以要先剥壳
export function extractJson(text: string): string {
  // 情况 A：有 ```json ... ``` 围栏，取围栏里的内容
  // 正则解释：(?:json)? 可有可无的 json 标记；\s* 忽略后面的空白；
  //          ([\s\S]*?) 非贪婪地取任意字符（含换行）
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenced) return fenced[1].trim()

  // 情况 B：没有围栏，就取第一个 { 到最后一个 } 之间的内容
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start !== -1 && end > start) return text.slice(start, end + 1)

  // 情况 C：什么都没有，原样返回（后面 JSON.parse 会失败，交给上层处理）
  return text.trim()
}

// ---------- 4. 解析 + 校验，永不抛异常 ----------
// 返回 { ok: true, data } 或 { ok: false, error }，调用方用 if 判断即可
export function parseReport(text: string): { ok: true; data: Report } | { ok: false; error: string } {
  try {
    const json = extractJson(text)
    // safeParse 不抛异常，返回 { success, data | error }；parse 会抛，所以这里不用它
    const parsed = ReportSchema.safeParse(JSON.parse(json))

    if (parsed.success) {
      return { ok: true, data: parsed.data }
    }

    // 把每条校验错误拼成人话，等下要喂回给模型让它自己改。
    // path 是出错位置（如 ['items', 0, 'topic']），join('.') 变成 items.0.topic
    const detail = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(根)'}: ${i.message}`)
      .join('; ')
    return { ok: false, error: detail }
  } catch {
    // JSON.parse 失败会抛异常，在这里被接住。
    // 不写 catch (e) 是因为不关心具体错误内容
    return { ok: false, error: '返回内容不是合法 JSON' }
  }
}

// ---------- 5. 带重试的结构化请求 ----------
// 首次 + 重试 2 次 = 最多问 3 遍
export async function askStructured(
  client: OpenAI,
  systemPrompt: string,
  userPrompt: string,
) {
  const MAX_ATTEMPTS = 3

  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ]

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const resp = await client.chat.completions.create({
      model: 'deepseek-flash',
      messages,
      // json_object 模式：要求模型只输出 JSON。
      // 前提：提示词里必须出现 "JSON" 这个词，否则有的服务商会报 400
      response_format: { type: 'json_object' },
    })

    // content 的类型是 string | null，用 ?? '' 兜成空串
    const text = resp.choices[0].message.content ?? ''
    const parsed = parseReport(text)

    if (parsed.ok) {
      // attempts 记下来：> 1 说明重试过，日志里的 retried 字段靠它
      return { ok: true as const, data: parsed.data, attempts: attempt }
    }

    console.log(`  第 ${attempt} 次不合格：${parsed.error}`)

    // 关键：重试不是原样再问一遍。
    // 必须把"上次输出了什么"和"错在哪"都塞回历史，
    // 模型才有依据针对性地改；否则同样的输入只会得到同样的错误
    messages.push({ role: 'assistant', content: text })
    messages.push({
      role: 'user',
      content: `你的输出不符合要求，错误：${parsed.error}。请只输出符合要求的 JSON，不要任何解释文字。`,
    })
  }

  return { ok: false as const, error: '重试 2 次后仍然不合法', attempts: MAX_ATTEMPTS }
}
