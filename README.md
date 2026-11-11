# WorkBuddy 号池

独立的 DeepSeek Harness 插件。把本机 WorkBuddy 网关（`workbuddy2api-panel`，默认 `127.0.0.1:7863`）的号池管理搬进设置页：账号健康与积分、国内/国际渠道归属、账号操作、任务中心、模型列表、网关配置与日志，以及渠道验证。网关不可达时显示上一次成功读取的快照。

## 功能

- **账号**：每 15 秒读取 `/panel/api/overview`，显示积分、状态（正常 / 冷却中 / 已熔断 / 已禁用）、在途请求、成功失败数、冷却截止时间；支持复活、禁用、签到、刷新余额、移除，并标注账号属于国内站还是国际站。
- **添加账号**：国内站走网关的设备码登录（`/panel/api/login/start|poll`）；国际站调用网关目录下的 `workbuddy-login` 工具（`url intl` / `poll intl`），凭据写入 `auths/workbuddy-intl-<uid>.json`，重启网关后新账号进池。
- **任务**：单账号任务列表、全部接受、全部自动完成、领取奖励；任务中心扫描全部账号并执行待办队列（并发 1–4）；开学季状态与一键完成。
- **渠道验证**：向网关发一条最小对话请求，确认账号当前能否真的走通上游渠道。国内站走 `copilot.tencent.com/v2/chat/completions`，国际站走 `www.codebuddy.ai/console/chat/completions`（国际站的 `/v2/chat/completions` 只接受官方客户端渠道，会返回 400 `11-128` 渠道校验）。验证默认临时禁用其它「正常」账号以隔离流量，结束后自动复活；冷却 / 熔断 / 禁用中的账号不会被改动。注意：网关的「复活」是无条件恢复，会同时清掉被隔离账号的失败计数与软退避累积——账号本身仍在，只是统计从头开始。结论分三种：**通过**（确认由目标账号承载）、**未确认**（请求成功但由别的账号承载，或隔离不完整——此时只说明网关能出网，不能替目标账号下结论）、**失败**（请求本身出错）。
- **模型 / 配置 / 日志**：展示网关模型列表；编辑并保存网关 `config.json`（部分字段需重启网关）；查看网关环形日志。
- **命令**：`/workbuddy-pool [help|models|verify [模型]|checkin|travel|activity|keepalive|balance]`。

## 安装

先看当前 DSH 在用哪个 profile（`$env:DSH_PROFILE`，未设置时默认为 `desktop`），用它替换下面的 `<profile>`。

```powershell
dsh plugin --profile <profile> add "<插件包的绝对路径>\dsh-workbuddy-pool-<版本>.tgz"
```

安装后 DSH 才加载插件，但这时它还不知道网关密钥，路由会返回「网关鉴权失败」。**首选做法是写一个用户级配置文件**，插件每次请求都会重读它，改完立即生效，不需要重启 DSH：

```powershell
'{"gatewayConfig":"<网关 config.json 的绝对路径>"}' |
  Set-Content -Encoding utf8 "$env:USERPROFILE\.dsh\workbuddy-pool.json"
```

`gatewayConfig` 指向网关的 `config.json`（例如 `<网关目录>\config.json`），插件从里面读 `api_key`，并按 `auth_dir` 定位 `auths` 目录与 `workbuddy-login` 工具。也可以直接写 `{"apiKey":"..."}` 覆盖密钥。文件位置跟随 `DSH_HOME`：默认 `~/.dsh/workbuddy-pool.json`。

改完回到设置页刷新即可。也可用环境变量（需重启 DSH 才生效，优先级高于配置文件）：

- `WORKBUDDY_POOL_CONFIG`：网关 `config.json` 路径。
- `WORKBUDDY_POOL_API_KEY`：网关密钥，优先于配置文件里的 `api_key`。
- `WORKBUDDY_POOL_BASE_URL`：网关地址，默认 `http://127.0.0.1:7863`（只接受本机地址）。
- `WORKBUDDY_POOL_GATEWAY_DIR`：网关目录，用于定位 `auths/` 与登录工具。
- `WORKBUDDY_POOL_LOGIN_BIN`：`workbuddy-login` 可执行文件的完整路径。
- 网关未开启鉴权时，密钥相关的两项都可以省略。

也接受原 `xuedinerAPI` 插件的变量名（`XUEDINER_GATEWAY_URL`、`XUEDINER_API_KEY`、`XUEDINER_GATEWAY_DIR`、`XUEDINER_LOGIN_BIN`）作为回退。

确定后打开 **设置 → WorkBuddy 号池**。

## 运行范围

插件只做界面与转发：账号选择、会话粘性、冷却与熔断、上游流量全部由本机网关处理，插件不直接访问腾讯接口（渠道验证也是让网关代发一条请求）。安装插件后仍需运行本机网关才能读取实时数据。

## 从源码打包

在本目录运行 `npm pack --pack-destination ..`。包内包含 DSH 插件入口、设置页和 Cordis 注册文件，可直接安装。
