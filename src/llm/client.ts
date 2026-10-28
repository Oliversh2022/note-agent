// ============================================================
// 共享的 API 客户端
// 全项目只有这一个实例：别的模块 import { client } 用，
// 避免"每个文件都 new 一个"和"key 被读很多次"。
// ============================================================

// 读取项目根目录下的 .env，把里面的键值塞进 process.env。
// 注意：它按"当前工作目录"找 .env，所以必须在本项目目录下启动程序
import 'dotenv/config'
// OpenAI 官方 SDK。DeepSeek 兼容这套接口，只改 baseURL 即可
import OpenAI from 'openai'

// 从环境变量取 key。process.env.X 读不到时是 undefined
const key = process.env.DEEPSEEK_API_KEY

// 没有 key 就立刻退出，不带着空 key 往下跑——
// 否则你会收到一堆看不出根因的 401，浪费半小时
if (!key) {
  console.error('缺少 DEEPSEEK_API_KEY，请检查 .env')
  // 1 表示"失败退出"，0 是正常退出
  process.exit(1)
}

// 这里的 key 已经过了上面的 if，TS 认定它一定是 string（这叫类型收窄）
export const client = new OpenAI({
  // apiKey：身份，会变成请求头里的 Authorization
  apiKey: key,
  // baseURL：往哪个地址发。DeepSeek 用这个域名，不要带 /v1
  baseURL: 'https://api.deepseek.com',
})
