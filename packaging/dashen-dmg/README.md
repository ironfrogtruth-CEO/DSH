# 大神完整 Universal DMG

本目录构建一份同时支持 `arm64` 与 `x86_64` 的大神安装包。安装包内置 Node.js、DSH、Web UI、预设、Skill、插件和便携 Host 启动器；目标机器首次启动只需配置 API。

## 安全边界

构建只复制白名单程序目录。以下内容不得进入 Payload：

- `.credentials.yaml`、`.env`、`private/`
- `sessions/`、`attachments/`、`logs/`、`output/`
- 浏览器 Profile、截图、缓存、备份和本地模型权重

## 构建

```bash
bash scripts/build-dmg.sh
```

输出默认写入 `/Users/marcus/Desktop/大神安装包`。
