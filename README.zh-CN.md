# MusicMC 实际运行服务

[English](README.md) | [简体中文](README.zh-CN.md)

本仓库由 MusicMC 部署脚本创建，用于保存一套服务器部署的在线歌曲目录、GitHub Actions 处理流程、上传 Worker 源码和已经发布的资源包 Releases。

不要把服务器上传签名私钥、GitHub 令牌、Cloudflare 令牌、网易云 Cookie 或 Minecraft 服务器文件放进本仓库。凭据只能保存于 GitHub Actions Secrets、Cloudflare Worker Secrets 和 Minecraft 服务器本地插件目录。

玩家会直接从 GitHub Releases 或所配置的对象存储公网地址下载资源包，不经过 Minecraft 服务器及其 FRP 隧道。
