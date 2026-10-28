// ============================================================
// token 用量累计
//
// 注意一个重要取舍：这个计数由「主循环每轮自动调用」，
// 而不是让模型主动调工具——因为模型根本不知道真实 token 数，
// 那是 resp.usage 里的数据，只有我们的代码能拿到。
// ============================================================

// 模块级变量：这个文件被 import 一次，变量就一直活着，
// 所以每次 logCost 改的都是同一个计数器。
// 缺点：它是全局状态，测试数据会污染正式计数（踩过：单测让"4 轮"显示成"6 轮"）
//      真实项目里会封装成类或显式传对象
let totalTokens = 0
let totalCalls = 0

// 累加一次请求的 token 用量。
// 注意口径：tokens 是「这一轮请求」的总量，不是单次工具调用的量；
// 同一轮的多个工具调用会共享同一个数值
export function logCost(tokens: number) {
  totalTokens += tokens
  // 调用次数 +1（这里记的是"请求轮数"，不是"工具次数"）
  totalCalls += 1
  return { ok: true, totalTokens, totalCalls }
}

// 取总账，主循环结束时打印一次
export function getCost() {
  return { totalTokens, totalCalls }
}
