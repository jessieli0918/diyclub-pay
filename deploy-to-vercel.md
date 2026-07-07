# DIYCLUB PayPal Payment Page - 部署指南

## 项目信息
- 品牌: DIYCLUB
- 域名: diyclub.fyi
- 功能: PayPal 定金+尾款收款页面

## 文件结构
```
paybypaypal/
├── package.json
├── server.js
├── .env (沙箱模式)
├── .env.example
└── public/
    ├── index.html
    ├── style.css
    └── app.js
```

## 部署步骤

### 1. 创建 GitHub 仓库
1. 访问 https://github.com/new
2. 仓库名: `paybypaypal`
3. 选择 Public
4. 点击 Create repository

### 2. 上传文件
在仓库页面点击 "uploading an existing file"，上传所有文件。

### 3. Vercel 部署
1. 回到 Vercel 控制台
2. 点击 "Import Git Repository"
3. 选择 `jessieli0918/paybypaypal`
4. 点击 Deploy

### 4. 绑定域名
部署完成后，在 Vercel 项目设置中添加自定义域名 `diyclub.fyi`。

## 环境切换
当前为沙箱模式(sandbox)，测试通过后：
1. 在 PayPal 开发者后台获取 Live 模式的 Client ID 和 Secret
2. 修改 `.env` 文件:
   - `PAYPAL_MODE=live`
   - `PAYPAL_CLIENT_ID=你的Live Client ID`
   - `PAYPAL_CLIENT_SECRET=你的Live Secret`
3. 重新部署
