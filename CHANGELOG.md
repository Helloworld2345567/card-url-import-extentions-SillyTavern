# Changelog

## 1.0.2

- 清理 Discord 图片链接中空查询项 `&=`，同时移除 `format=webp` 和 `quality=lossless` 等预览转换参数。
- 新增带空查询项的 Discord URL 回归测试。

## 1.0.1

- 发布独立 GitHub 仓库，支持从 SillyTavern 扩展管理页安装、检查更新和管理。
- 添加独立运行的测试、安装说明和更新说明。
- 保留 Discord 原始附件转换、签名保留、PNG 角色数据校验及标准导入流程。

## 1.0.0

- 本地初版：通过 HTTPS PNG 直链下载并导入角色卡。
- 支持 Discord media/CDN 附件、Catbox 和 GitHub Raw。
- 提供下载取消、超时、大小限制和明确的失败提示。
