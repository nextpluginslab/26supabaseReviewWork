# 测试案例与验收数据

本文件承载具体产品案例；[SPEC.md](SPEC.md) 定义通用平台能力。案例中的 App、测试步骤、题目内容、选项、月费和报酬都属于测试数据，不能变成平台硬编码或产品范围限制。

案例来源：[PROJECT.md](../PROJECT.md) 的描述，以及用户最新澄清：Speakit 只是测试案例，不写入 spec。

## 1. Speakit 手机 App 案例

### 1.1 发布配置

| 项目 | 测试值 |
| --- | --- |
| App | Speakit |
| 下载链接 | 实际测试时由发布者填写可用链接；文档中的 example.com 不是实际下载地址 |
| 体验说明 | 在手机上安装/打开 App，完成体验后返回任务页；电脑阅读者可通过下载链接/二维码转到手机 |
| 测试步骤 | 打开一段视频，使用 0.5 倍速、逐句暂停功能跟读三句话；卡住时说明具体位置 |
| 证据要求 | 截图或录屏，展示相关控件、操作结果或卡住的页面 |
| 月费问题示例 | 每月 $4.99 |
| 每条接受后的报酬 | $2.00 |
| 总报酬预算 | $20.00 |
| DDL | 发布后 3 天；另设已截止场景验证补充 |
| 支付 | Stripe Sandbox，USD，Connect 测试账户转账 |

每月 $4.99 是付费意愿调查内容，不是测试者报酬，也不触发订阅购买；$2 和 $20 分别用于单条报酬与总预算。

### 1.2 本案例使用的两道题

1. 下次跟读你会选哪个？Speakit / YouTube / 不确定。每个答案都填写原因。
2. 如果每月 $4.99，你愿意付费吗？愿意 / 不愿意 / 不确定。每个答案都填写原因。

英文案例文案：

- Which would you choose for your next shadowing session? — Speakit / YouTube / Not sure.
- Would you pay $4.99 per month? — Yes / No / Not sure.

“操作说明/卡点”是补充体验过程的文本，不在此案例中新增第三道选择题。

## 2. 反馈样本

### 2.1 无法完成步骤，选择其他产品且不愿付费

```json
{
  "case_submission_key": "case_a",
  "operation_notes": "I found the video but could not find the 0.5x speed control. The screenshot shows where I got stuck.",
  "answers": [
    {
      "question_key": "next_session_choice",
      "selected_option_key": "youtube",
      "reason": "I already know where playback speed is in YouTube."
    },
    {
      "question_key": "monthly_willingness",
      "selected_option_key": "no",
      "reason": "I would want to complete the shadowing flow before paying $4.99 per month."
    }
  ],
  "evidence_fixture": "A screenshot showing the video page and the place where the tester got stuck"
}
```

预期：允许正式提交，生成唯一提交编号，立即待发布者确认；不因选择 YouTube/no 或未完成步骤自动拒绝。此处 evidence_fixture 是待制作的测试素材说明，不是声称已有可用文件。

### 2.2 单条 AI 摘要期望

AI 可指出：“反馈反映了播放速度入口不清楚；截图显示视频区域，但无法确认测试者尝试了 0.5 倍速；建议询问测试者在哪里寻找该控件。”

必须能追溯到该版本的说明、回答和截图；建议不自动变成正式补充要求。AI 不决定接受、不付款、不编造录像中的操作。模型失败时发布者仍能查看原件和处理。

## 3. 汇总与补充的确定性预期

准备 3 条正式提交：

| 提交 | 处理状态 | 产品选择 | 付费意愿 |
| --- | --- | --- | --- |
| case_a | 待发布者确认 | YouTube | No |
| case_b | 已接受 | Speakit | Yes |
| case_c | 不接受 | Not sure | Not sure |

默认统计全部 3 条：产品选择各 1 份，付费意愿各 1 份，total_submissions = 3；不能剔除不接受或负面样本。

发布者请求 case_a 补充，测试者在同一编号下补充截图、修改选择为 Speakit/Yes 并解释原因：

- 历史 YouTube/No 与原始原因保留。
- 新修订正式提交后，case_a 回到待发布者确认。
- 产品选择计数：Speakit 2、YouTube 0、Not sure 1。
- 付费意愿计数：Yes 2、No 0、Not sure 1。
- 总份数仍为 3，case_a 不产生第二份报酬，AI 摘要更新。
- 只保存补充草稿时，以上正式统计仍保持修改前结果。

## 4. 本案例验收

| ID | 操作 | 预期 |
| --- | --- | --- |
| CASE-01 | 发布后查看任务页与结果页 | 使用相同任务配置，Speakit、下载指引、0.5x 步骤、题目及实际月费一致 |
| CASE-02 | 手机阅读/体验/返回，或桌面阅读后上传手机录屏 | 任务→手机指引→上传→本案例两题→提交的流程可用 |
| CASE-03 | 只填选择但原因空白 | 指出对应原因必填；不能正式提交 |
| CASE-04 | 提交 case_a | 正常收下卡点/负面反馈，不自动拒收或拒付 |
| CASE-05 | AI 没有输出或服务失败 | 原始内容可读，发布者可请求补充、接受或不接受 |
| CASE-06 | DDL 后对 case_a 请求并提交补充 | 使用原任务页和原编号，保留历史，更新摘要和答案，不重复计数 |
| CASE-07 | 按第 3 节修改答案并刷新总体 | 三条样本，计数与明确预期完全一致，可定位原提交 |
| CASE-08 | 在 $20 预算下并发接受第 10、11 条 $2 反馈 | 已付+已接受未付不超过 $20；预算不足者保持原状态 |
| CASE-09 | 已接受付款失败后重试，或重复 webhook | 接受状态和待付预算保留，一份报酬不重复支付 |
| CASE-10 | 报酬改为 0 的独立任务 | 接受后无需付款，不占预算、不除零、不触发 Stripe 转账 |

## 5. 通用性回归

创建另一款产品的任务，替换产品名称、链接、说明、题目文案、选项和调查价格。任务页、AI 输入、结果详情、统计不得泄露或自动回填本案例的品牌名、YouTube 选项、跟读步骤或 0.5x 要求。

用户已确认问卷数量、内容和选项可配置，首版单选且原因必填；本案例恰有两题，不限制其他任务的题数。此文件尚未对应已运行的应用测试；截图/录屏测试素材、真实下载地址和 Stripe 测试账户在实施验证时准备。
