Rainbow 服务 运行说明（常驻运行）
=====================================

【当前状态】(2026-08-19)
- 服务进程 : node dist/index.js（由 npm start 拉起），已脱离终端，父进程为 launchd(1)
- 监听端口 : 23330 (0.0.0.0)
- Web 界面 : http://127.0.0.1:23330/   登录账号 admin / admin
- 日志文件 : rainbow/data/server.log
- 音源     : huibq / qdy / sixyin 均已启用且 ready

【启动服务】
    cd /Users/giraffe/Documents/Qoder/2026-08-18/chat-1/rainbow/server
    nohup npm start > ../data/server.log 2>&1 &

启动后等 1~2 秒，检查就绪：
    curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:23330/api/v1/auth/status
返回 200 即表示服务已就绪。

【查看日志】
    tail -f /Users/giraffe/Documents/Qoder/2026-08-18/chat-1/rainbow/data/server.log

【停止服务】
    lsof -nP -ti :23330 | xargs kill
（杀掉监听 23330 的 node 进程后，外层 npm 进程会自动退出；如有残留可再执行一次）

【开机自启（可选方案概述）】
macOS 可用 launchd：编写一个 LaunchAgent plist（RunAtLoad + KeepAlive 指向
nohup npm start 命令）放到 ~/Library/LaunchAgents/ 并执行 launchctl load，
即可实现登录后自动拉起、崩溃自动重启。需要完整配置时可直接让助手生成。

【故障速查】
- 页面报「搜索失败: 网络错误，无法连接服务: Failed to fetch」
  = 服务进程没在运行（如 E2E 验证收尾时被停掉），按上面【启动服务】重新拉起，
    然后刷新页面即可，无需改动任何代码。
