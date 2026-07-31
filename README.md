# MusicMC runtime service

[English](README.md) | [简体中文](README.zh-CN.md)

This repository was created by the MusicMC deployment script. It stores the live song catalog, GitHub Actions processing workflow, upload Worker source, and published resource-bundle Releases for one server deployment.

Do not place the server upload-signing private key, GitHub token, Cloudflare token, NetEase Cookie, or Minecraft server files in this repository. Credentials belong only in GitHub Actions Secrets, Cloudflare Worker Secrets, and the Minecraft server's local plugin directory.

Player downloads go directly to GitHub Releases or the configured public object-storage endpoint. They do not pass through the Minecraft server or its FRP tunnel.
