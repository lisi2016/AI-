'use strict';
/**
 * 自由文本合规（契约六.6）：长度上限 + 敏感词拦截
 *
 * 从 records.js 抽出，供以下场景共用（避免多处重复实现校验口径）：
 *   · 课时记录（授课摘要 / 缺勤姓名 / 拒绝原因 / 备注）
 *   · 班级课程清单（课程名称 / 授课老师 / 上课地点）
 *   · 课时会话（实际授课人 / 地点 / 摘要 / 备注 / 缺勤姓名）
 *
 * 命中敏感词 / 超长 / 必填为空 → 统一抛 40001，并写操作日志
 * （text.sensitive.blocked 或 text.invalid.blocked）。
 */
const audit = require('./audit');
const textfilter = require('./textfilter');
const view = require('./view');
const { paramError } = require('./errors');

/**
 * 校验教师/班干部填写的自由文本：长度上限 + 敏感词拦截
 * - 命中敏感词 → 40001，msg 形如「内容包含敏感词：代签（授课摘要），请修改后重新提交」
 * - 超长 / 必填为空 → 40001，并给出明确提示
 * - 被拦截时写操作日志（audit），便于事后追溯
 *
 * @param field summary / absent_names / reason / note / review_note（或自定义字段名）
 * @param value 原始入参
 * @param ctx 审计上下文
 * @param opts {max, required, label, words}
 * @returns {{text:string, length:number, max:number, hits:string[]}}
 */
function checkFreeText(field, value, ctx, opts) {
  const r = textfilter.validate(field, value, opts);
  if (r.ok) return r;
  audit.log(ctx, r.reason === 'sensitive' ? 'text.sensitive.blocked' : 'text.invalid.blocked', {
    targetType: 'free_text',
    targetId: r.field,
    after: {
      field: r.field, label: r.label, reason: r.reason,
      length: r.length, max: r.max, hits: r.hits,
    },
    detail: '自由文本被拦截：' + r.msg,
  });
  throw paramError(r.msg, {
    field: r.field, label: r.label, reason: r.reason,
    length: r.length, max: r.max, hits: r.hits,
  });
}

/** 取 /config 上的长度上限，非法/缺失时回退 textfilter 内置默认 */
function limitOf(configKey, field) {
  const def = textfilter.FIELDS[field];
  return view.configLimit(configKey, def ? def.defaultMax : 500);
}

module.exports = { checkFreeText, limitOf };
