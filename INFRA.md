# Infrastructure（基础设施清单）

> 这份文档记录"不在代码里"的部署事实——DNS、Pages 自定义域、Stripe 端点、Alipay 商户、KV 命名空间。每次在 Cloudflare / Stripe / 支付宝 后台改东西，**同时改这个文件**。

最后更新：2026-05-13

---

## Cloudflare Worker

| 项 | 值 |
|---|---|
| Worker 名 | `weread-sync-service` |
| 配置文件 | `wrangler.toml` |
| 自定义域（API） | `wereadsync.xiaomiao.win`（custom_domain in wrangler.toml） |
| 入口文件 | `cloudflare/worker.js` |
| KV namespace | `STRIPE_STATE`（id `d8d2ef35deaf4b529ef3fde00e5ae73c`） |
| 前端 SPA 托管 | 飞书插件中心打包 ZIP 上传（无独立公网 URL） |

### Secrets

- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `STRIPE_PUBLISHABLE_KEY`（注：这条理应是 `[vars]` 的 plain，但当前作为 secret 存放）
- `ALIPAY_APP_ID`
- `ALIPAY_APP_PRIVATE_KEY`
- `ALIPAY_PUBLIC_KEY`

### Vars (in wrangler.toml `[vars]`)

- `WEREAD_MAX_SYNC_BOOKS = "2000"`
- `WEREAD_MAX_SYNC_RECORDS = "200"`
- `WEREAD_STRICT_REAL_DATA = "true"`
- `STRIPE_PRODUCT_NAME = "微信读书同步多维表格"`
- `REQUIRE_ACTIVE_SUBSCRIPTION = "false"`
- `ALIPAY_AMOUNT = "99.00"`
- `ALIPAY_SUBJECT = "微信读书同步多维表格"`
- `SOCKS5_PROXY_URL = "socks5://165.154.200.47:1080"`（用于固定出口 IP 访问微信读书）

---

## 飞书插件中心配置

- 飞书插件中心上传打包后的 dist（zip），里面的 BASE_URL 指向 `https://wereadsync.xiaomiao.win/`
- 没有独立公网 URL（不像 email 是 worker [assets] 同域出，weread 是飞书自托管 dist）

---

## Stripe

| 项 | 值 |
|---|---|
| 模式 | live |
| 产品 | "微信读书同步多维表格"（CNY 99/年） |
| Webhook URL | `https://wereadsync.xiaomiao.win/api/stripe/webhook` |
| 订阅事件 | `checkout.session.completed`, `customer.subscription.*` |

> ⚠️ Stripe 后台还有一条 `we_1T9jYH...` 的 endpoint，URL 字段被错填成 `weread-sync-service.kelan656691.workers.dev/api/stripe/webhookhttps://...`（host 重复），404 一直发不出去。**应当修正为 `https://wereadsync.xiaomiao.win/api/stripe/webhook`，或与 `we_1TCCv9...`（同样指 wereadsync.xiaomiao.win 的旧 email endpoint）合并**。

---

## 支付宝当面付

| 项 | 值 |
|---|---|
| 商户 | 共用"波波 API"主体（1Password 条目 `Alipay merchant keys (波波 API)`） |
| 年费 | 99 元 |
| notify URL | `https://wereadsync.xiaomiao.win/api/alipay/notify` |
| outTradeNo 前缀 | `WR` |
| KV 订单 key | `pay:trade:<outTradeNo>`（TTL 24h） |

---

## CI/CD

| 项 | 值 |
|---|---|
| GitHub Actions | `.github/workflows/deploy.yml` |
| 触发 | push to `main`（除非只改 `dist/**` / `public/**` / `**.md`） |
| 步骤 | `wrangler deploy --config wrangler.toml` |
| Secret | repo secret `CLOUDFLARE_API_TOKEN` |

---

## 改动记录

- 2026-05-13: main 收纳 `chore/add-deploy-ci` 分支两个 commit（CI 自动部署 + 绑定 `wereadsync.xiaomiao.win` 自定义域）；新建本文档。
- 2026-05-11: `wereadsync.xiaomiao.win` 域名从 email worker 归还给 weread worker（之前 email 插件临时借用了这个域名）；新 deployment id `1f27a49d`（CI 触发的）。
- 历史: weread 是本仓库系列里第一个接 Alipay 当面付的插件，后续 email / db 都从这里 copy-paste 了相同的 RSA2 签名与 precreate / query / notify 路径。
