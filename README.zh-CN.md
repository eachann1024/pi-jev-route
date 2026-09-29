# Pi Jev Route

![Pi Jev Route — The right model. The same main session.](https://raw.githubusercontent.com/eachann1024/pi-jev-route/main/web/assets/route-hero.png)

为 Pi 的子代理任务自动选择合适模型；主会话模型与思考强度保持不变。

```sh
pi install npm:pi-subagents@0.69.0
pi install npm:@each1024/pi-jev-route
```

已经安装 `pi-subagents`？保留即可，本扩展使用它的原生启动流程。要求 Node **22.18+**、Pi **0.85.1+**。安装后执行 `/reload`；路由默认开启。

## 开始使用

首次在本机交互式 Pi 会话中使用时，扩展会在浏览器打开英文欢迎页。点击 **Open settings** 查看可用模型和路由选项。之后可执行 `/pi-jev-route welcome` 手动重新打开欢迎页。

`/pi-jev-route` 打开本机设置与审计页面。首次欢迎流程也会启动回环服务以显示欢迎页；仅安装 npm 包不会自动打开浏览器。服务闲置后关闭，不会创建公网监听或隧道。

![Route with intent. Your models. Your scope.](https://raw.githubusercontent.com/eachann1024/pi-jev-route/main/web/assets/route-routing.png)

## 路由方式

- 主会话负责澄清需求、调研风险、委派有边界的工作、关键决策和总结。
- 符合条件的结构化原生 Pi 子代理调用由 Jev 从 `enabledModels` 选型；子代理启动、并行、工具、权限、预算和结果仍由原扩展负责。
- 独立工作可并行。普通任务通常优先轻量模型；样式任务在允许时使用当前主模型与 low。主会话模型和思考强度保持不变。

扩展覆盖模型发起的单个原生 Pi 子代理结构化调用；不全局拦截工作流脚本、`/run`、定时任务、其他扩展的直接委派或外部 CLI/job。嵌套路由不作保证。[覆盖范围与审计细节](https://github.com/eachann1024/pi-jev-route/blob/main/docs/reference.zh-CN.md#覆盖范围与审计)。

![Stay in control. Local settings. Clear decisions.](https://raw.githubusercontent.com/eachann1024/pi-jev-route/main/web/assets/route-control.png)

## 本机页面

设置页列出配置模型，并提供路由、回退和审计选项；修改会保存到本机。页面不加载外部脚本、字体或资源。远程或无界面会话不会自动打开本机浏览器。

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

测试使用模拟分类和隔离的临时存储，不消耗模型额度。[完整技术参考](https://github.com/eachann1024/pi-jev-route/blob/main/docs/reference.zh-CN.md) · [English reference](https://github.com/eachann1024/pi-jev-route/blob/main/docs/reference.md)

MIT 许可证。
