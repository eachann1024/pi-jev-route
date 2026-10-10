# Pi Jev Route

[English](README.md) · 中文

https://github.com/user-attachments/assets/5866076c-b518-460c-872f-2bbc78fb098f

![Pi Jev Route — eligible subagent task → Jev selection → enabled model](https://raw.githubusercontent.com/eachann1024/pi-jev-route/main/web/assets/route-hero.png)

为 Pi 的子代理任务自动选择合适模型；主会话模型与思考强度保持不变。

```sh
pi install npm:pi-subagents@0.69.0
pi install npm:@each1024/pi-jev-route
```

已经安装 `pi-subagents`？保留即可，本扩展使用它的原生启动流程。要求 Node **22.18+**、Pi **0.85.1+**。安装后执行 `/reload`；路由默认开启。

## 开始使用

首次在本机交互式 Pi 会话中使用时，扩展会在浏览器自动打开欢迎页。点击 **Open settings** 进入设置控制台，可配置模型范围、回退策略与任务监督。之后随时可执行 `/pi-jev-route-setting welcome` 重新打开欢迎页。

`/pi-jev-route-setting` 命令用于打开本地设置与审计控制台：

- **模型与路由**：勾选允许子代理调用的模型列表、配置未命中或超时时的回退策略、设置选型置信度门槛与补充提示词。
- **任务监督**：监控长时间运行的任务，检查工具长时间运行、连续失败或任务缺少进展的情况，并按设置发送进度提醒、纠正建议或尝试恢复任务。
- **历史记录**：查看每一次子代理派发选型的决策原因、耗时以及任务监督的时间线记录。

首次欢迎流程会启动本地回环（loopback）HTTP 服务；仅安装 npm 包不会自动打开浏览器。服务在闲置一段时间后会自动关闭，绝不创建公网监听或网络隧道。

## 路由方式

- 主会话负责澄清需求、调研风险、委派有边界的工作、关键决策和总结。
- 符合条件的结构化原生 Pi 子代理调用由 Jev 从 `enabledModels` 选型；子代理启动、并行、工具、权限、预算和结果仍由原扩展负责。
- 独立工作可并行。普通任务通常优先轻量模型；样式任务在允许时使用当前主模型与 low。主会话模型和思考强度保持不变。

扩展覆盖模型发起的单个原生 Pi 子代理结构化调用；不全局拦截工作流脚本、`/run`、定时任务、其他扩展的直接委派或外部 CLI/job。嵌套路由不作保证。[覆盖范围与审计细节](https://github.com/eachann1024/pi-jev-route/blob/main/docs/reference.zh-CN.md#覆盖范围与审计)。

## 本机页面

![Model controls and routing audit — feature overview](https://raw.githubusercontent.com/eachann1024/pi-jev-route/main/web/assets/route-control.png)

**模型范围与路由审计。** 选择允许使用的模型和回退策略，查看选型及回退记录。上图为功能示意，不是界面截图；审计不代表任务完成。

设置页列出配置模型，并提供路由、回退和审计选项；页面顶部可切换 English / 简体中文，修改会自动保存，右上角显示“已保存”；离开页面不再确认。恢复默认会保留界面语言并自动保存；刷新审计日志会保留尚未写入的编辑。若设置发生冲突，需要明确重新读取设置。页面不加载外部脚本、字体或资源。远程或无界面会话不会自动打开本机浏览器。

## 隐私与凭证

凭证复用 `TYPESAFE_API_KEY` 或 `~/.config/typesafe/api_key`。分类会发送子任务、代理名称、候选模型说明和路由规则，不发送主会话、系统提示词、工具结果或思考；可能产生单独费用。完整说明见[技术参考](https://github.com/eachann1024/pi-jev-route/blob/main/docs/reference.zh-CN.md#隐私凭证与失败处理)。

本机 SQLite 设置与日志仅所有者可读写；日志保存任务 hash，不保存任务原文或凭证。不要在模型说明中填写凭证。

## 失败与审计

每次符合条件的派发最多请求一次，默认五秒超时且不重试；缺凭证、超时、无效响应、敏感或过长输入、低置信度时使用允许的回退模型，否则阻止派发。凭证检测并非完整秘密扫描。

异步任务只记为已接受，不代表完成；审计记录和运行 ID 不独立证明执行或正确性。详见[覆盖与审计](https://github.com/eachann1024/pi-jev-route/blob/main/docs/reference.zh-CN.md#覆盖范围与审计)。

## 开发

```sh
npm ci --ignore-scripts
npm run check
npm test
```

测试使用模拟分类和隔离的临时存储，不消耗模型额度。[完整技术参考](docs/reference.zh-CN.md)

MIT 许可证。
