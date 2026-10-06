@echo off
chcp 65001 >nul
title MergeHub · 合并审批中心（开发模式）
cd /d "%~dp0"
echo.
echo  正在启动 MergeHub 开发模式...
echo  Rust 代码有改动时会自动重新编译，窗口稍后弹出
echo  关闭本窗口或按 Ctrl+C 即可退出应用
echo.
call npm run tauri dev
echo.
echo  MergeHub 已退出（错误码 %errorlevel%）
pause
